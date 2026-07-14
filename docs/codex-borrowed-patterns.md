# Codex Patterns Borrowed by SmartEdit — Retrospective

> **Status**: All 7 patterns implemented (May 2026)
> Original analysis based on reading `github.com/openai/codex` source (May 2026)
> and the SmartEdit extension in this repository.

All patterns identified in the original analysis were implemented across two sprints. This document serves as a retrospective: what was borrowed, how it was implemented, and what the actual cost was.

---

## Implementation Summary

| # | Pattern | Priority (original) | Actual LOC | Status |
|---|---------|---------------------|-----------|--------|
| 1 | Grammar-based freeform tool (Codex apply_patch parser) | P0 | ~800 | ✅ `src/formats/codex-patch.ts` |
| 2 | Multi-level `@@` hunk disambiguation | P0 | (included above) | ✅ Built into codex-patch parser |
| 3 | Streaming patch preview | P1 | ~450 | ✅ `src/formats/streaming-patch-parser.ts` |
| 4 | ContextualUserFragment markers | P1 | ~200 | ✅ `src/formats/context-markers.ts` |
| 5 | Edit history / undo | P2 | ~300 | ✅ `src/undo/edit-history.ts` + `atomic-write.ts` |
| 6 | Approval gating | P2 | ~400 | ✅ `src/safety/approval-gating.ts` |
| 7 | Multi-file atomic patches | P3 | ~950 | ✅ `src/formats/atomic-patch.ts` |

---

## Architecture Comparison (current)

| Layer | SmartEdit | Codex |
|---|---|---|
| **Input format** | JSON schema + multi-format detection (search/replace, unified diff, OpenAI patch, Codex patch, Atomic Patch, hashline) + forgiving parser + streaming parser | Lark grammar freeform tool (`apply_patch`) |
| **Matching** | 6-tier fuzzy pipeline (exact → indent → unicode → similarity → dotdotdots → relative indent) + symbolic edits | Context-line matching with `@@` disambiguation + `seek_sequence` fuzzy |
| **Scoping** | tree-sitter AST anchor + lineRange + hashline anchors | Multi-level `@@` chaining (`@@ class`, `@@ \t def`) |
| **Safety** | Stale-file guard, range coverage guard, approval gating (path/symbol/auto-generated detection), atomic write | Exec policy rules, sandbox permissions, approval flow |
| **Validation** | LSP diagnostics + compiler fallback + scoped diagnostics + incremental syntax validation + verification pipeline (concurrency, traceability, history) | Sandbox FS + exec policy + diff tracker |
| **Read path** | Snapshot cache with readOffset, hashline anchors, APFS VFS retry | Fragment injection into message array (`ContextualUserFragment`) |
| **Streaming** | Streaming patch parser with progress callbacks | 500ms-buffered streaming patch preview |
| **Multi-file** | Atomic Patch envelope (AddFile, DeleteFile, UpdateFile, RenameFile) | Multi-file patches in one `apply_patch` call |
| **Undo** | Per-edit undo capture to `.smart-edit-undo/` (fire-and-forget) | `SharedTurnDiffTracker` records all changes |
| **Multi-env** | Local only | Environment ID routing (local, container, remote) |

---

## Pattern #1: Grammar-Based Freeform Tool ✅

### Files
- `src/formats/codex-patch.ts` (~800 lines) — recursive-descent parser
- `src/formats/format-detector.ts` — detection logic for `codex_patch` format

### What was built
A proper recursive-descent parser for the Codex `apply_patch` format that:
1. Validates the full `*** Begin Patch` / `*** End Patch` envelope
2. Supports `*** Add File:`, `*** Delete File:`, `*** Update File:`, `*** Move to:`
3. Parses multi-level `@@` chaining
4. Produces structured `CodexHunk` types with context-line metadata
5. Has lenient mode error recovery for common model mistakes
6. Maps hunks to SmartEdit's `EditItem` format via `codexHunkToEditItem()`

### What Codex Does (reference)
Codex defines `apply_patch` as a **Lark grammar** freeform tool. The model outputs raw text matching the grammar. The parser (`parser.rs`, 954 lines) validates the grammar, extracts hunks, and produces structured `Hunk` enums:

```rust
pub enum Hunk {
    AddFile { path: PathBuf, contents: String },
    DeleteFile { path: PathBuf },
    UpdateFile { path: PathBuf, move_path: Option<PathBuf>, chunks: Vec<UpdateFileChunk> },
}
```

---

## Pattern #2: Multi-Level `@@` Hunk Disambiguation ✅

### What Codex Does (reference)
Codex disambiguates hunks by chaining `@@` statements:
```
@@ class BaseClass
@@   def method():
  [3 lines of pre-context]
- [old_code]
+ [new_code]
  [3 lines of post-context]
```

### Implementation
Built into the codex-patch parser. Each `UpdateFileChunk` has a `scope: string[]` field that captures the multi-level `@@` chain. The scope is used as `anchor` hints when converting to `EditItem`.

---

## Pattern #3: Streaming Patch Preview ✅

### Files
- `src/formats/streaming-patch-parser.ts` (~450 lines) — progressive parse with progress callbacks

### What was built
A `StreamingPatchParser` that processes partial patch text as it's received:
1. Re-parses accumulated text every 500ms using `parseCodexPatch(text, 'lenient')`
2. Emits completed hunks via `onUpdate` callback
3. Calculates live diffs using the `diff` library
4. Integrates with `index.ts execute()` when `onUpdate` is provided and format is `codex_patch`

---

## Pattern #4: ContextualUserFragment Markers ✅

### Files
- `src/formats/context-markers.ts` (~200 lines) — XML-style marker wrapping

### What was built
A lightweight XML-style marker system that:
1. Wraps `semantic_context` output in `<smartedit:context>` / `</smartedit:context>` tags
2. Carries metadata as attributes (`path`, `range`, `source`, `tokens`, `language`)
3. Provides `wrapInMarker()`, `isMarkedFragment()`, `parseMarkerMetadata()`, `stripMarkers()` functions
4. Uses percent-encoding for path attributes to avoid XML parsing issues

### What Codex Does (reference)
Codex injects all context as **fragments** with XML-like markers via the `ContextualUserFragment` trait. Markers serve dual purpose: delimit injected context for filtering, and preserve attribution.

---

## Pattern #5: Edit History / Undo ✅

### Files
- `src/undo/edit-history.ts` (~300 lines) — undo state capture and restore
- `src/undo/atomic-write.ts` (~140 lines) — temp-file write + rename

### What was built
A lightweight, file-based undo system:
1. Captures pre-edit content before every `atomicWrite` call (base64-encoded JSON)
2. Stores undo data in `.smart-edit-undo/` per project
3. Provides `saveUndoState()`, `restoreUndoState()`, `getUndoHistory()`, `clearUndoHistory()`
4. Fire-and-forget — never blocks the edit hot path
5. Atomically writes using temp-file + rename pattern

---

## Pattern #6: Approval Gating ✅

### Files
- `src/safety/approval-gating.ts` (~400 lines) — path/symbol/line-range safety checks
- Plus auto-generated file detection

### What was built
A lightweight approval gating system with:
1. Three levels: `never_prompt`, `prompt_on_dangerous`, `prompt_always`
2. Glob-based dangerous file path patterns
3. Regex-based dangerous symbol patterns (`main()`, `init()`, `process.env`, etc.)
4. Critical line range checks
5. **Auto-generated file detection** — identifies files with markers like `@generated`, `auto-generated`, `Do not edit`
6. Warnings only, never blocks edits
7. Controlled via `SMART_EDIT_APPROVAL_LEVEL` env var

---

## Pattern #7: Multi-File Atomic Patches ✅

### Files
- `src/formats/atomic-patch.ts` (~950 lines) — multi-file atomic patch envelope parser and applicator

### What was built
An atomic patch envelope format that groups operations on multiple files into a single transaction:
1. **AddFile** — create a new file with contents
2. **DeleteFile** — remove a file
3. **UpdateFile** — apply search/replace hunks (optionally with move to new path)
4. **RenameFile** — rename a file
5. Operations validated before application; entire envelope rolls back on failure
6. Supports `force` mode for overwriting existing files

```
*** Begin Atomic Patch
*** Update File: src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
-const oldName = 1;
+const newName = 1;
*** Add File: src/bar.ts
@@ -0,0 +1,1 @@
+const bar = 2;
*** End Atomic Patch
```

---

## What NOT to Borrow (and Why)

This list remains valid — these Codex features were intentionally skipped:

| Codex Feature | Why Skip |
|---|---|
| **Full exec policy engine** (37k lines) | Overengineered for SmartEdit's scope. Lightweight path-based approval is sufficient. |
| **Multi-environment routing** | SmartEdit runs in a single local Pi session. Container/remote support is an orthogonal concern. |
| **Virtual filesystem abstraction** | SmartEdit does direct fs ops. The VFS abstraction would add complexity without clear benefit. |
| **Remote compaction** (`compact_remote_v2.rs`, 16k lines) | Pi handles its own context window management. SmartEdit shouldn't get involved. |
| **Shell tool interception** | SmartEdit doesn't have a shell tool. The `edit` tool is directly registered. |
| **Realtime/voice mode fragments** | Not applicable to SmartEdit's text-only domain. |
| **Subagent notification system** | Pi has its own subagent infrastructure. |
| **Plugin/skill instruction injection** | Pi's extension system handles this. |

---

## Appendix: Codex Files Referenced

| File | Lines | Relevance |
|---|---|---|
| `codex-rs/core/src/context/fragment.rs` | 87 | `ContextualUserFragment` trait |
| `codex-rs/core/src/context/mod.rs` | ~60 | 25+ fragment types |
| `codex-rs/core/src/context/environment_context.rs` | ~100 | Environment injection |
| `codex-rs/apply-patch/src/parser.rs` | 954 | Grammar parser |
| `codex-rs/apply-patch/src/lib.rs` | 1692 | Patch application |
| `codex-rs/apply-patch/src/streaming_parser.rs` | ~200 | Streaming parser |
| `codex-rs/core/src/tools/handlers/apply_patch.rs` | 601 | Handler orchestration |
| `codex-rs/core/src/tools/handlers/apply_patch_spec.rs` | 31 | Freeform tool spec |
| `codex-rs/core/src/exec_policy.rs` | ~37k | Approval/rules engine |
| `codex-rs/core/src/compact.rs` | ~21k | Local compaction |
