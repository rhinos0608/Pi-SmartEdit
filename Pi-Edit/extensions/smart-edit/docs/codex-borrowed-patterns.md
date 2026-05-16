# Codex Patterns Borrowable by SmartEdit

> Analysis based on reading `github.com/openai/codex` source (May 2026) and
> the SmartEdit extension at `.pi/extensions/smart-edit/`.

---

## Architecture Comparison

| Layer | SmartEdit | Codex |
|---|---|---|
| **Input format** | JSON schema + multi-format detection (search/replace, unified diff, OpenAI patch, hashline) | Lark grammar freeform tool (`apply_patch`) |
| **Matching** | 4-tier fuzzy pipeline (exact → indent → unicode → similarity) | Context-line matching with `@@` disambiguation + `seek_sequence` fuzzy |
| **Scoping** | tree-sitter AST anchor + lineRange | Multi-level `@@` chaining (`@@ class`, `@@ \t def`) |
| **Safety** | Stale-file guard, range coverage guard, atomic write | Exec policy rules, sandbox permissions, approval flow |
| **Validation** | LSP diagnostics + compiler fallback + AST syntax check | Sandbox FS + exec policy + diff tracker |
| **Read path** | Snapshot cache from `read`/`write` tool results | Fragment injection into message array (`ContextualUserFragment`) |
| **Streaming** | None | 500ms-buffered streaming patch preview |
| **Multi-file** | Single-file edit tool with mutation queue | Multi-file patches in one `apply_patch` call |
| **Undo** | Not implemented | `SharedTurnDiffTracker` records all changes |
| **Multi-env** | Local only | Environment ID routing (local, container, remote) |

---

## Pattern #1: Grammar-Based Freeform Tool (HIGH IMPACT / LOW EFFORT)

### What Codex Does
Codex defines `apply_patch` as a **Lark grammar** freeform tool. The model outputs raw text matching the grammar, not JSON. The parser (`parser.rs`, 954 lines) validates the grammar, extracts hunks, and produces structured `Hunk` enums:

```rust
pub enum Hunk {
    AddFile { path: PathBuf, contents: String },
    DeleteFile { path: PathBuf },
    UpdateFile { path: PathBuf, move_path: Option<PathBuf>, chunks: Vec<UpdateFileChunk> },
}
```

### What SmartEdit Should Borrow
SmartEdit already supports OpenAI patch format via `src/formats/openai-patch.ts`, but the parser is **regex-based and fragile**. It doesn't validate the envelope, doesn't handle error recovery well, and doesn't support all Codex features (multi-level `@@`, `*** Move to:`, file creation/deletion in one patch).

**Concrete improvement:** Add a **proper grammar parser** for the Codex apply_patch format that:
1. Validates the full `*** Begin Patch` / `*** End Patch` envelope
2. Supports `*** Add File:`, `*** Delete File:`, `*** Update File:`, `*** Move to:`
3. Parses multi-level `@@` chaining (`@@ class BaseClass`, `@@ \t def method():`)
4. Produces structured hunks with context-line metadata
5. Has error recovery for common model mistakes (Codex has a "lenient mode" for gpt-4.1)

**Implementation:** ~200-300 lines in `src/formats/codex-patch.ts` with a recursive-descent parser.

**Benefit:** Models that are trained on Codex's apply_patch format (GPT-5, GPT-4.1, etc.) can use their native output format directly, reducing JSON serialization errors and improving edit precision.

---

## Pattern #2: Multi-Level `@@` Hunk Disambiguation (HIGH IMPACT / LOW EFFORT)

### What Codex Does
Codex disambiguates hunks by chaining `@@` statements:

```
@@ class BaseClass
@@   def method():
  [3 lines of pre-context]
- [old_code]
+ [new_code]
  [3 lines of post-context]
```

The parser walks the `@@` chain to narrow scope, then uses context lines for precise positioning.

### What SmartEdit Should Borrow
SmartEdit has `anchor` and `lineRange` for scoping, but these require the model to understand tree-sitter symbol kinds and line numbers. Codex's `@@` chaining is more natural — the model just writes code it can see.

**Concrete improvement:** Enhance `src/formats/openai-patch.ts` to:
1. Parse multi-level `@@` chains (currently only handles single `@@`)
2. Generate `anchor` hints from `@@` chains for the matching pipeline
3. Use `@@` context lines as fuzzy-search anchors when the primary match fails

**Implementation:** ~100-150 lines modifying `extractSections()` and `extractAnchorLine()` in `openai-patch.ts`.

**Benefit:** Fewer ambiguous matches; model can disambiguate naturally by naming surrounding context.

---

## Pattern #3: Streaming Patch Preview (MEDIUM IMPACT / MEDIUM EFFORT)

### What Codex Does
Codex implements a `StreamingPatchParser` that processes partial patch text as the model streams it. Every 500ms, completed hunks are emitted as `PatchApplyUpdatedEvent` to update the TUI's diff view in real-time.

```rust
struct ApplyPatchArgumentDiffConsumer {
    parser: StreamingPatchParser,
    last_sent_at: Option<Instant>,
    pending: Option<PatchApplyUpdatedEvent>,
}
```

### What SmartEdit Should Borrow
SmartEdit's `edit` tool receives a complete edits array and processes it synchronously. For large patches (many files, many hunks), there's no progress feedback.

**Concrete improvement:** If Pi's tool infrastructure supports `onUpdate` callbacks during execution:
1. Create a `StreamingPatchParser` that processes hunk-by-hunk
2. Emit partial diffs as each hunk is applied
3. Buffer updates at 500ms intervals to avoid flooding

**Implementation:** Depends on Pi's streaming tool support. ~200-250 lines if supported.

**Benefit:** Real-time feedback during large edits; reduced user anxiety about "is this still working?"

---

## Pattern #4: `ContextualUserFragment` Pattern for Read Path (MEDIUM IMPACT / MEDIUM EFFORT)

### What Codex Does
Codex injects all context as **fragments** with XML-like markers:

```rust
pub trait ContextualUserFragment {
    const ROLE: &'static str;          // "user"
    const START_MARKER: &'static str;  // "<environment>"
    const END_MARKER: &'static str;    // "</environment>"
    fn body(&self) -> String;
    fn render(&self) -> String;        // MARKER + body + MARKER
}
```

Markers serve dual purpose: delimit injected context for filtering, and preserve attribution so the model knows where information came from. `is_contextual_user_fragment()` can identify and remove injected text during compaction.

### What SmartEdit Should Borrow
SmartEdit's `semantic_context` tool returns markdown. The `read` cache records snapshots. There's no marker-based context injection.

**Concrete improvement:**
1. Wrap `semantic_context` output in `<semantic_context path="...">` / `</semantic_context>` markers
2. Add markers to read cache entries when the file context is injected
3. Provide a marker-aware filter for context compaction

**Implementation:** ~100-150 lines across `semantic-context.ts` and a new `context-markers.ts`.

**Benefit:** Cleaner context attribution; enables downstream filtering and smarter compaction.

---

## Pattern #5: Edit History / Undo (MEDIUM IMPACT / MEDIUM EFFORT)

### What Codex Does
Codex's `SharedTurnDiffTracker` records every file change as structured data during a turn. The handler emits diffs that can be rendered in the TUI and used for undo operations.

### What SmartEdit Should Borrow
SmartEdit generates diffs but doesn't persist them for undo. Each `atomicWrite` replaces the file; there's no rollback.

**Concrete improvement:**
1. Before `atomicWrite`, save the original file content to a `.smart-edit-undo/` directory
2. Record diff metadata (timestamp, edit count, symbols changed)
3. Provide an `undo_edit` tool (or integrate with Pi's undo)
4. Auto-clean old undo data on session end

**Implementation:** ~200-300 lines, mostly in `index.ts` execute() before atomicWrite.

**Benefit:** Safety net for mistaken edits; aligns with Codex's "record everything" philosophy.

---

## Pattern #6: Approval Gating (LOW-MEDIUM IMPACT / MEDIUM EFFORT)

### What Codex Does
Codex has a comprehensive approval system:
- `AskForApproval::Never` — always run
- `AskForApproval::OnFailure` — ask on errors
- `AskForApproval::OnRequest` — ask when model requests it
- `AskForApproval::UnlessTrusted` — skip for trusted commands
- `AskForApproval::Granular` — per-rule/per-sandbox config
- Exec policy rules (allow/prompt/forbid) in `.codex/rules/`

### What SmartEdit Should Borrow
SmartEdit has **no approval gating**. All edits go through automatically if they pass stale-file and range coverage guards.

**Concrete improvement (lightweight):**
1. Add a `VERIFICATION_REQUIRED_PATHS` config (glob patterns) for files that need approval
2. Add a `DANGEROUS_PATTERNS` list (editing `__init__`, `main`, entry points, config files)
3. Emit a warning note for dangerous edits rather than blocking
4. Support a "review mode" where diffs are shown before applying

**Implementation:** ~150-200 lines. Mostly configuration + pre-edit check in execute().

**Benefit:** Prevents accidental edits to critical infrastructure; aligns with Codex's safety-first approach.

---

## Pattern #7: Multi-File Patches in One Call (MEDIUM IMPACT / HIGH EFFORT)

### What Codex Does
A single `apply_patch` call can modify multiple files:

```
*** Begin Patch
*** Add File: src/new.ts
+export function hello() {}
*** Update File: src/main.ts
@@ import
+import { hello } from "./new";
*** End Patch
```

### What SmartEdit Should Borrow
SmartEdit's `edit` tool operates on **one file per call**. Multi-file changes require multiple tool calls, which introduces ordering dependencies and stale-file risks between calls.

**Concrete improvement:**
1. Add a `multi_edit` tool that accepts an array of file edits
2. Each entry has `{ path, edits }` 
3. Process all files in a single atomic transaction (or report which succeeded/failed)
4. Generate a unified multi-file diff summary

**Implementation:** ~400-500 lines. New tool registration + batch processing logic.

**Benefit:** Atomic multi-file edits; reduced tool-call overhead; better model throughput.

---

## Priority Ranking

| # | Pattern | Impact | Effort | Lines | Priority |
|---|---|---|---|---|---|
| 1 | Grammar-based freeform tool | 🔴 High | 🟢 Low | ~250 | **P0 — Do first** |
| 2 | Multi-level `@@` disambiguation | 🔴 High | 🟢 Low | ~150 | **P0 — Do first** |
| 3 | Streaming patch preview | 🟡 Medium | 🟡 Medium | ~250 | P1 |
| 4 | ContextualUserFragment markers | 🟡 Medium | 🟡 Medium | ~150 | P1 |
| 5 | Edit history / undo | 🟡 Medium | 🟡 Medium | ~300 | P2 |
| 6 | Approval gating | 🟢 Low-Med | 🟡 Medium | ~200 | P2 |
| 7 | Multi-file patches | 🟡 Medium | 🔴 High | ~500 | P3 |

### Recommended Implementation Order

1. **P0 (this sprint):** Patterns #1 and #2 — they directly improve edit precision for models trained on Codex's format. Low effort, high payoff.
2. **P1 (next sprint):** Patterns #3 and #4 — streaming preview and context markers improve UX and observability.
3. **P2 (later):** Patterns #5 and #6 — undo and approval add safety layers.
4. **P3 (future):** Pattern #7 — multi-file patches require significant architectural changes but would be transformative.

---

## What NOT to Borrow (and Why)

| Codex Feature | Why Skip |
|---|---|
| **Full exec policy engine** (37k lines) | Overengineered for SmartEdit's scope. Lightweight path-based approval (Pattern #6) is sufficient. |
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
