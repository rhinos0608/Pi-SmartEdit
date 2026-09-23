# Smart Edit — Improved Edit Tool for Pi Coding Agent

Smart Edit replaces Pi's built-in `edit` tool with safer matching, richer diagnostics, and stronger edit protection.

## What it does

- **6-tier matching**: exact → indentation → Unicode → similarity → dotdotdots ellipsis → relative indent
- **Symbolic edits**: replaceBody, insertBefore, insertAfter via AST symbol targeting
- **AST-scoped edits**: target a symbol with `target` for disambiguation
- **Line-range scoping**: constrain matching with `lineRange`
- **Hashline edits**: freshness-checked anchored edits for zero-text workflows (opt-in via `SMART_EDIT_USE_HASHLINE_EDITING=1`)
- **Multi-format input**: JSON edits, search/replace blocks, unified diffs, OpenAI patch, Codex apply_patch, and Atomic Patch envelope format
- **Forgiving JSON parser**: auto-repairs malformed JSON from LLM output
- **Streaming patch parser**: progressive parse with progress callbacks for large patches
- **Risk warnings**: advisory path/symbol/line-range checks, configurable via `SMART_EDIT_APPROVAL_LEVEL` (never blocks or prompts)
- **Stale-file guard**: blocks edits when the file changed since read
- **Range coverage guard**: blocks edits outside the lines you actually read
- **Failure-atomic transactions**: multi-file, raw, and topology edits share one transaction with rollback for handled failures
- **Outside-workspace targets**: SmartEdit canonicalizes target paths but does not confine mutations to the workspace — cwd is session/evidence identity, not filesystem confinement. An out-of-workspace path with valid evidence CAN authorize; the real filesystem perimeter is the Pi runtime/container
- **Atomic writes**: temp-file write + rename, with mode preservation (undo-safe)
- **Edit history / undo**: captures pre-edit state to `.smart-edit-undo/` for rollback
- **Context markers**: XML-style tags around injected semantic context for attribution/filtering
- **Auto-validation**: retry-aware structural check + validation feedback on failed edits
- **Fake-logic detection**: AST-based detection of stub bodies, constant conditions, and empty catch blocks (configurable via `SMART_EDIT_FAKE_LOGIC_ENABLED`)
- **ESLint advisory diagnostics**: post-edit linting for TypeScript/JavaScript, never blocks the edit (configurable via `SMART_EDIT_LINT_ENABLED`)
- **Incremental syntax validation**: tree-sitter incremental re-parse with LRU parse cache for fast post-edit checks
- **Edit repair loop**: auto-retries failed edits with validation feedback (Aider-style, enabled by default via `SMART_EDIT_REPAIR_ENABLED`)
- **Closest-match diagnostics**: shows the best near-match when an edit fails
- **Post-edit diagnostics**: LSP + compiler fallback, scoped to changed targets
- **Verification pipeline**: concurrency detection, traceability analysis, git history context, repair loop
- **Refactor preview**: LSP-powered rename, organize imports, formatting, and code actions with unified diff preview and evidence-gated atomic apply
- **SmartRead bridge**: RPC consumer for rename/format/code-action/organize-imports via Pi-SmartRead; lazy 250 ms capability probe, sticky remote-vs-standalone mode per session, per-call `timeoutMs` (15 s transport / 10 s provider service budget for refactor RPCs; 4 s service + 5 s transport for post-edit diagnostics, protocol v0.6.0 envelope); also records breakage and co-change events

## Refactor Preview

LSP-powered refactoring with preview-then-apply. The `refactor` field on the edit tool input is mutually exclusive with `edits` and `raw`. Preview generates a unified diff without touching disk; apply verifies freshness and evidence authorization, then commits via a failure-atomic transaction.

### Rename preview

```json
{
  "refactor": {
    "kind": "rename-preview",
    "path": "src/auth.ts",
    "line": 42,
    "character": 5,
    "newName": "authenticate"
  }
}
```

Positions are 1-based. Returns `previewId`, staged file count, and unified diff. Rename routes through SmartRead's language intelligence RPC to the LSP `textDocument/rename` flow.

### Organize imports preview

```json
{
  "refactor": {
    "kind": "organize-imports-preview",
    "path": "src/auth.ts"
  }
}
```

### Formatting preview

```json
{
  "refactor": {
    "kind": "formatting-preview",
    "path": "src/auth.ts",
    "tabSize": 2,
    "insertSpaces": true
  }
}
```

### Code action preview

```json
{
  "refactor": {
    "kind": "code-action-preview",
    "path": "src/auth.ts",
    "line": 42,
    "character": 5,
    "only": ["quickfix"]
  }
}
```

Automatically selects the preferred action or the first action with an edit. Optional `endLine`/`endCharacter` and `diagnostics` narrow the range/context.

### Apply preview

```json
{
  "refactor": {
    "kind": "apply-refactor-preview",
    "previewId": "uuid-from-preview"
  }
}
```

Previews expire after 5 minutes, max 16 cached (oldest evicted first). `previewId` is SmartEdit-owned (UUID); there is no cross-repo lease. The cache is generalized across all four refactor kinds via kind discriminants — no rename-only naming, no sentinel values. Apply verifies:

- **Session identity binding** — preview bound to originating session; cross-session use rejected
- **File freshness** — content unchanged since preview (re-read and compared)
- **SHA-256 matching** — each touched file requires prior strong read authority with matching hash
- **Range coverage validation** — touched ranges must fall within previously read coverage
- **Atomic multi-file write** — all staged files written via `EditTransaction` with rollback on failure

### Security model

All LSP output is treated as untrusted. Every `WorkspaceEdit` is validated at the provider boundary: file URIs must resolve to canonical realpaths (symlinks resolved via `realpathSync`), UTF-16 ranges are validated pre-stage (in-bounds, non-overlapping, bounded counts) before any content is staged. Path validation is provider/runtime hygiene, not workspace containment — an out-of-workspace path with valid evidence CAN authorize (see outside-workspace policy below). Each touched file requires prior strong read authority with matching SHA-256 — no evidence, no write. Apply uses a failure-atomic `EditTransaction` so partial writes roll back.

## SmartRead Integration

SmartEdit delegates language intelligence to Pi-SmartRead over the `languageIntelligence` RPC channel (`@rhinos0608/pi-workspace-protocol`).

- **Operations**: `renamePreview`, `organizeImports`, `formatting`, `codeAction` — each with a dedicated `request*` function in `src/lsp/lsp-smartread-client.ts` (per-call `timeoutMs`, default 15 s transport vs 10 s provider service budget).
- **Lazy capability probe**: first refactor call probes SmartRead with a 250 ms timeout to detect availability; result is cached per session.
- **Sticky mode selection**: the probe outcome pins the session to `remote` (RPC) or `standalone` mode; no flapping between calls.
- **Timeout alignment**: client budget 15 s vs provider budget 10 s, so provider timeouts surface as structured errors before the client races.
- **Evidence bridge**: post-edit breakage and co-change events are still recorded to SmartRead via `src/smartread-bridge.ts`.

## Diagnostics

Smart Edit uses a multi-tier diagnostics pipeline:

1. **Incremental syntax validation** — tree-sitter re-parse using LRU-cached previous tree (fast, no LSP needed)
2. **LSP diagnostics** when a server is available
3. **Compiler fallback** when LSP has nothing useful (`tsc`, `pyright`, `cargo check`, `go vet`, `rubocop`)
4. **Language-specific output parsing** to turn CLI results into editor diagnostics
5. **Scoped diagnostics**: filters diagnostics to only the symbols/lines actually changed
6. **Post-edit evidence pipeline**: concurrency verification, test traceability, git history context
7. **Repair loop** (enabled by default): auto-retries failed edits with validation feedback on each attempt

## Supported LSP servers

The extension can start these servers when they are available on `PATH`:

- TypeScript / JavaScript: `typescript-language-server`, `typescriptlangserver`
- Python: `pyright`, `pylsp`, `pyls`, `jedi-language-server`
- Rust: `rust-analyzer`
- Go: `gopls`
- Java: `java` + `JDT_LS_JAR`, or `jdtls`
- Ruby: `solargraph`
- JSON: `vscode-json-language-server`
- HTML: `vscode-html-language-server`
- CSS: `vscode-css-language-server`
- Markdown: `marksman`

## Supported file types

### AST features

| Language | Extensions |
|---|---|
| TypeScript / TSX | `.ts`, `.tsx`, `.mts`, `.cts` |
| JavaScript / JSX | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `.py` |
| Rust | `.rs` |
| Go | `.go` |
| Java | `.java` |
| C / C++ | `.c`, `.cpp`, `.h`, `.hpp` |
| Ruby | `.rb` |
| CSS | `.css` |

Other formats like JSON, YAML, and HTML still work with text matching, but AST features degrade gracefully.

## Installation

Install dependencies from repository root:

```bash
npm install
```

Pi loads the extension automatically when it starts.

## Usage

Smart Edit provides two tools. `edit` transforms or generates content; `transfer` moves, copies, or reuses text/code that already exists in an observed source. When existing content should be preserved and relocated/reused — especially during refactors or when implementing from a reference — prefer `transfer`: it preserves source content directly instead of regenerating it.

By default, Smart Edit stays on the `oldText`/`newText` fuzzy-matching path and keeps the current AST/LSP helpers in play. Hashline is opt-in; see Configuration.

### Atomic patch (multi-file)

Atomic patch envelopes group operations on multiple files into a single transaction.
Operations are validated before application; the entire envelope rolls back on failure.

Supported operations:
- **AddFile** — create a new file with contents
- **DeleteFile** — remove a file
- **UpdateFile** — apply search/replace hunks (optionally with a move to a new path)
- **RenameFile** — rename a file

```text
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

The format is auto-detected; pass the text as the `raw` parameter.

### Basic edit

```json
{
  "path": "src/foo.ts",
  "edits": [
    {
      "oldText": "const oldName = 1;",
      "newText": "const newName = 1;"
    }
  ]
}
```

This is the default path. Edit metadata such as `replaceAll`, `target`, and `hashline` stays on each edit object and is validated directly; paths remain plain filesystem paths.

### Multi-file edit

Omit top-level `path` and provide `path` on every edit. Multi-file, raw, and topology edits share a single failure-atomic transaction: handled failures roll back the whole request. Atomic Patch is one input format for this same transaction — it is not the only atomic mode.

```json
{
  "edits": [
    {
      "path": "src/foo.ts",
      "oldText": "const oldName = 1;",
      "newText": "const newName = 1;"
    },
    {
      "path": "src/bar.ts",
      "oldText": "oldName",
      "newText": "newName",
      "replaceAll": true
    }
  ]
}
```

### Scoped edit

```json
{
  "path": "src/foo.ts",
  "edits": [
    {
      "oldText": "return result;",
      "newText": "return processedResult;",
      "target": {
        "name": "processRequest"
      },
      "lineRange": {
        "startLine": 44,
        "endLine": 52
      }
    }
  ]
}
```

The `target` and `lineRange` helpers still work on the default text path.

### Experimental hashline edit

```json
{
  "path": "src/foo.ts",
  "edits": [
    {
      "hashline": {
        "range": {
          "pos": "42ab",
          "end": "45cd"
        },
        "content": [
          "const updated = true;"
        ]
      }
    }
  ]
}
```

Hashline is opt-in; see Configuration.

### Replace all matches

```json
{
  "path": "src/foo.ts",
  "edits": [
    {
      "oldText": "userName",
      "newText": "displayName",
      "replaceAll": true
    }
  ]
}
```

### Transfer (copy/move)

Move, copy, or reuse text/code already available in an observed source. `copy` leaves the source intact; `move` deletes it after transfer. `from`/`range` are pre-edit source anchors from the last read of `from`; `to`/`after` is the pre-edit destination anchor to insert immediately after. All transfers in one call resolve against the same pre-transaction state and commit atomically.

Same-file copy:

```json
{
  "transfers": [
    {
      "op": "copy",
      "from": "src/foo.ts",
      "range": { "pos": "10ab", "end": "12cd" },
      "to": "src/foo.ts",
      "after": "40ef"
    }
  ]
}
```

Cross-file move:

```json
{
  "transfers": [
    {
      "op": "move",
      "from": "src/parser.ts",
      "range": { "pos": "10ab", "end": "12cd" },
      "to": "src/shared.ts",
      "after": "5gh"
    }
  ]
}
```

New-file destination: omit `after` when `to` does not exist yet — the transferred content is appended to the newly created file.

```json
{
  "transfers": [
    {
      "op": "copy",
      "from": "src/parser.ts",
      "range": { "pos": "10ab", "end": "12cd" },
      "to": "src/generated.ts"
    }
  ]
}
```

`after: "start"` prepends to the destination file; omit `after` only for a new-file destination. A supplied `after` on a new-file destination is rejected, as are non-public sentinels (`end`, `EOF`, `BOF`, `before`) and `:after`/`:before` suffix tricks — supply a destination anchor or `start`.

#### Transfer authority (runtime semantics)

- Source (`copy` and `move`): strong read authority covering the resolved source span plus a valid full-file SHA for freshness — enforced even though `copy` leaves the source untouched.
- Existing destination: prior strong read authority plus freshness validation required.
- New destination (exception): no prior read needed — no preimage exists to observe. Still participates safely in the same atomic transaction.
- Missing authority, freshness, or coverage fails at runtime with a corrective re-read message. No setup needed; read, then retry.

Transfer rejections (pre-write `conflict`): same-file `move` landing inside or touching the source span; source lines already following the destination anchor (the insert layer would otherwise silently drop them — pick a different anchor); duplicate destination content; overlapping `move` source spans in one call. Transferred content cannot be edited in the same call — use a follow-up `edit` to modify it. Stale or ambiguous anchors fail closed with a re-read message.

## Architecture

```text
./
├── src/
│   ├── index.ts               # Tool registration, stale guard, atomic writes, mutation queue
│   ├── core/                  # Matching, AST, hashline, read cache, and shared types
│   ├── formats/               # JSON/search-replace/diff/OpenAI/Codex patch parsers
│   ├── lsp/                   # LSP lifecycle, diagnostics, ESLint runner, semantic context, symbol navigation
│   ├── safety/                # Risk-warning and context-guard checks
│   ├── undo/                  # Atomic writes and per-edit undo capture
│   ├── verification/          # Validation, evidence, fake-logic detection, diagnostics, repair loop
│   ├── edit-mode.ts           # Runtime config (hashline toggle, env vars)
│   ├── edit-contract.ts       # Edit request validation including refactor variants
│   ├── lsp/positional-planner.ts  # WorkspaceEdit → staged content via exact UTF-16 range edits (pre-stage validated)
│   ├── lsp/refactor-preview-cache.ts # Generalized preview store: kind discriminants, SmartEdit-owned previewId, no sentinels, no cross-repo lease
│   ├── lsp/lsp-smartread-client.ts # Per-call-timeout RPC consumer for SmartRead language intelligence
│   ├── symbolic-edits.ts      # Symbolic edit engine (replaceBody, insertBefore, insertAfter)
│   └── smartread-bridge.ts    # Breakage/co-change recording to Pi-SmartRead
├── test/                      # 45+ automated test suites plus manual scripts
├── benchmark/                 # Hashline and matching benchmarks
└── docs/                      # Feature specs and design notes
```

### Flow

1. Read file and populate the snapshot cache
2. Detect input format (JSON, search/replace, unified diff, OpenAI/Codex patch)
3. Repair malformed JSON if needed (forgiving parser)
4. Resolve symbolic edits (replaceBody, insertBefore, insertAfter) via AST
5. Resolve anchors / line ranges / hashline anchors for scoping
6. Run risk-warning checks (path/symbol/line-range, advisory — never blocks)
7. Match with the 6-tier fallback pipeline
8. Capture pre-edit undo state (persisted after commit, best-effort)
9. Apply the edit atomically (temp file + rename)
10. Run incremental syntax validation via tree-sitter re-parse (LRU-cached)
11. Run post-edit pipeline: LSP diagnostics → compiler fallback → scoped diagnostics → verification evidence → optional repair loop
12. Record breakage/co-change events to SmartRead bridge
13. Surface warnings, diagnostics, and evidence in the tool response
14. Refactor operations route through RPC to SmartRead → positional planner → preview cache → evidence-gated apply

## Testing

```bash
npm run lint                # ESLint strict mode, zero warnings
npm test                    # Run all test suites (30+)
npm run test:v              # Run verification-specific tests only
```

Run a focused test:

```bash
npx tsx --test test/<file>  # e.g., test/symbolic-edits.test.ts
```

## Configuration

| Env Variable | Values | Default | Effect |
|---|---|---|---|
| `SMART_EDIT_USE_HASHLINE_EDITING` | `1`/`true`/`yes`/`on` | off | Enable hashline edit mode |
| `SMART_EDIT_HASHLINE_EXPERIMENTAL` | same | off | Alias for hashline toggle |
| `SMART_EDIT_APPROVAL_LEVEL` | `never_prompt` / `prompt_on_dangerous` / `prompt_always` | `prompt_on_dangerous` | Risk-warning verbosity (advisory, never blocks) |
| `SMART_EDIT_REPAIR_ENABLED` | `1`/`true`/`yes`/`on` | **on** | Enable edit repair loop (Aider-style retry) |
| `SMART_EDIT_REPAIR_ENABLED=0`/`false` | disable | — | Disable the repair loop (defaults to on) |
| `SMART_EDIT_REPAIR_MAX_RETRIES` | integer | `3` | Config max retries; production caps the repair loop at **one** attempt |
| `SMART_EDIT_FAKE_LOGIC_ENABLED` | `1`/`true`/`yes`/`on` | **on** | Detect stub bodies, constant conditions, empty catches |
| `SMART_EDIT_LINT_ENABLED` | `1`/`true`/`yes`/`on` | **on** | Run ESLint as advisory post-edit diagnostics |
| `SMART_EDIT_VERIFICATION_COMMANDS` | JSON array | `[]` | Concurrency/verification commands as `[{"name":"...","command":"...","args":["..."]}]` |

## Notes

- Java LSP uses `JDT_LS_JAR` at runtime.
- Read-range validation only trusts lines you actually read.
- Fuzzy matches are safe: replacements are always applied to the original file text.
- Undo data is stored in `.smart-edit-undo/` per project; persistence happens **after commit** and is **best-effort** (never blocks the edit).
- Verification pipeline is advisory: warnings are matchNotes, never hard errors by default.
- **Outside-workspace policy**: SmartEdit canonicalizes targets but does not confine mutations to the workspace. cwd names the session/evidence identity, not a filesystem boundary: an out-of-workspace path with valid evidence CAN authorize. The real filesystem perimeter is the Pi runtime/container.
- **Failure-atomicity guarantee**: Multi-file, raw, and topology edits share one failure-atomic transaction. Handled write/verify failures roll back all prior changes in the transaction and report exact rollback outcome. This does **not** cover power-loss, OS crash, or instantaneous cross-file filesystem atomicity — only handled process failures with explicit rollback. Crash recovery (`src/mutation/recovery-journal.ts`, kill-tested) is a separate milestone; `test/recovery-journal.test.ts` is not yet in the `npm test` chain — owner follow-up.
- **Evidence Policy B**: The agent-visible schema omits `evidenceRef`. The latest strong prior authority for a canonical path is reused; prior line-range authority is never widened by omission. Full-file auto-inspection occurs only when no strong prior authority exists.
- **Default verifier**: no production blocking verifier is configured. The extension has no safe staged-workspace command contract, so it does not run arbitrary configured commands as a blocking gate. Verification lanes are advisory only.
- Repair loop is on by default (opt out with `SMART_EDIT_REPAIR_ENABLED=0` or `false`): repair failures produce notes but never block the pipeline.
- Fake-logic detection uses tree-sitter AST analysis with regex fallback; never blocks the edit pipeline on error.
- ESLint advisory diagnostics run via `npx eslint` only when an ESLint config is found in the file's ancestor tree; lint findings never affect pass/fail.
- Incremental syntax validation uses tree-sitter computeEdit + re-parse; falls back to full parse when the edit delta is too large.
