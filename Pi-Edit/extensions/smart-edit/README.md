# Smart Edit — Improved Edit Tool for Pi Coding Agent

Smart Edit replaces Pi's built-in `edit` tool with safer matching, richer diagnostics, and stronger edit protection.

## What it does

- **6-tier matching**: exact → indentation → Unicode → similarity → dotdotdots ellipsis → relative indent
- **Symbolic edits**: replaceBody, insertBefore, insertAfter via AST symbol targeting
- **AST-scoped edits**: target a symbol with `anchor` for disambiguation
- **Line-range scoping**: constrain matching with `lineRange`
- **Hashline edits**: freshness-checked anchored edits for zero-text workflows (opt-in via `SMART_EDIT_USE_HASHLINE_EDITING=1`)
- **Multi-format input**: JSON edits, search/replace blocks, unified diffs, OpenAI patch, Codex apply_patch, and Atomic Patch envelope format
- **Forgiving JSON parser**: auto-repairs malformed JSON from LLM output
- **Streaming patch parser**: progressive parse with progress callbacks for large patches
- **Approval gating**: path/symbol/line-range safety checks, configurable via `SMART_EDIT_APPROVAL_LEVEL`
- **Stale-file guard**: blocks edits when the file changed since read
- **Range coverage guard**: blocks edits outside the lines you actually read
- **Conflict detection**: warns or blocks on overlapping AST-level changes across edit calls
- **Atomic writes**: temp-file write + rename, with mode preservation (undo-safe)
- **Edit history / undo**: captures pre-edit state to `.smart-edit-undo/` for rollback
- **Context markers**: XML-style tags around injected semantic context for attribution/filtering
- **Auto-validation**: retry-aware structural check + validation feedback on failed edits
- **Incremental syntax validation**: tree-sitter incremental re-parse with LRU parse cache for fast post-edit checks
- **Edit repair loop**: auto-retries failed edits with validation feedback (Aider-style, opt-in via config)
- **Closest-match diagnostics**: shows the best near-match when an edit fails
- **Post-edit diagnostics**: LSP + compiler fallback, scoped to changed targets
- **Verification pipeline**: concurrency detection, traceability analysis, git history context, repair loop
- **SmartRead bridge**: records breakage and co-change events to Pi-SmartRead

## Diagnostics

Smart Edit uses a multi-tier diagnostics pipeline:

1. **Incremental syntax validation** — tree-sitter re-parse using LRU-cached previous tree (fast, no LSP needed)
2. **LSP diagnostics** when a server is available
3. **Compiler fallback** when LSP has nothing useful (`tsc`, `pyright`, `cargo check`, `go vet`, `rubocop`)
4. **Language-specific output parsing** to turn CLI results into editor diagnostics
5. **Scoped diagnostics**: filters diagnostics to only the symbols/lines actually changed
6. **Post-edit evidence pipeline**: concurrency verification, test traceability, git history context
7. **Repair loop** (opt-in): auto-retries failed edits with validation feedback on each attempt

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

The extension lives in `.pi/extensions/smart-edit/`.

```bash
cd .pi/extensions/smart-edit
npm install
```

Pi loads the extension automatically when it starts.

## Usage

Use the same interface as the built-in `edit` tool.

By default, Smart Edit stays on the `oldText`/`newText` fuzzy-matching path and keeps the current AST/LSP helpers in play. To try the hashline path, set `SMART_EDIT_USE_HASHLINE_EDITING=1` before starting Pi.

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

This is the default path.

### Scoped edit

```json
{
  "path": "src/foo.ts",
  "edits": [
    {
      "oldText": "return result;",
      "newText": "return processedResult;",
      "anchor": {
        "symbolName": "processRequest"
      },
      "lineRange": {
        "startLine": 44,
        "endLine": 52
      }
    }
  ]
}
```

The `anchor` and `lineRange` helpers still work on the default text path.

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

Only use this after enabling `SMART_EDIT_USE_HASHLINE_EDITING=1`.

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

## Architecture

```text
.pi/extensions/smart-edit/
├── index.ts                   # Tool registration, stale guard, atomic writes, mutation queue,
│                              #   atomic patch envelope integration
├── lib/
│   ├── types.ts               # Shared types, FileSnapshot, fastHash, MatchTier
│   ├── edit-diff.ts           # 6-tier matching pipeline and diff generation
│   ├── hashline.ts            # Line hashing for hashline anchors (xxhash-wasm)
│   ├── hashline-edit.ts       # Hashline edit application and validation
│   ├── read-cache.ts          # Snapshot cache and read-range coverage guard
│   ├── ast-resolver.ts        # Tree-sitter parsing, symbol resolution, incremental re-parse
│   │                          #   with LRU parse cache (10 entries)
│   ├── conflict-detector.ts   # AST-level conflict detection between edit calls
│   ├── grammar-loader.ts      # Lazy-loads tree-sitter WASM grammars
│   └── path-utils.ts          # Path resolution (resolveToCwd)
├── src/
│   ├── edit-mode.ts           # Runtime config (hashline toggle, env vars)
│   ├── symbolic-edits.ts      # Symbolic edit engine (replaceBody, insertBefore, insertAfter)
│   ├── smartread-bridge.ts    # Breakage/co-change recording to Pi-SmartRead
│   ├── safety/
│   │   └── approval-gating.ts # Path/symbol/line-range safety checks
│   ├── undo/
│   │   ├── atomic-write.ts    # Temp-file write + rename with mode preservation
│   │   └── edit-history.ts    # Per-edit undo capture (base64 JSON in .smart-edit-undo/)
│   ├── formats/
│   │   ├── index.ts           # Format detection and dispatch
│   │   ├── format-detector.ts # Auto-detect input format from raw text
│   │   ├── search-replace.ts  # Search/replace block parser
│   │   ├── unified-diff.ts    # Unified diff parser
│   │   ├── openai-patch.ts    # OpenAI patch format parser
│   │   ├── codex-patch.ts     # Codex apply_patch grammar parser
│   │   ├── atomic-patch.ts    # Multi-file atomic patch envelope parser
│   │   ├── streaming-patch-parser.ts # Progressive parse with progress callbacks
│   │   ├── forgiving-parser.ts # JSON repair for malformed LLM output
│   │   └── context-markers.ts # XML-style markers for injected semantic context
│   ├── lsp/
│   │   ├── index.ts           # LSP module public API
│   │   ├── lsp-connection.ts  # JSON-RPC over stdio
│   │   ├── lsp-manager.ts     # Lazy server startup and runtime config
│   │   ├── diagnostics.ts     # Post-edit LSP diagnostic checks
│   │   ├── diagnostic-dispatcher.ts # Compiler fallback + output parsing
│   │   ├── semantic-context.ts # Semantic context resolution (definitions, refs)
│   │   ├── semantic-nav.ts    # LSP-based semantic navigation
│   │   ├── context-renderer.ts # Render semantic context as markdown
│   │   ├── symbol-skeleton.ts # Extract symbol outlines from AST
│   │   ├── target-range.ts    # Resolve symbol targets to byte ranges
│   │   ├── document-sync.ts   # DidOpen/DidChange/DidClose synchronization
│   │   └── language-id.ts     # Extension → LSP language ID mapping
│   ├── verification/
│   │   ├── types.ts           # Shared verification types (config, evidence, repair)
│   │   ├── config.ts          # Default verification configuration + deep merge
│   │   ├── auto-validate.ts   # Retry-aware structural + incremental syntax validation
│   │   ├── post-edit-evidence.ts # Orchestrates full evidence pipeline (including Phase E repair)
│   │   ├── change-targets.ts  # Identify what symbols were changed
│   │   ├── concurrency-detector.ts # Detect async/thread/lock patterns
│   │   ├── concurrency-tools.ts    # Run ecosystem verification tools
│   │   ├── traceability.ts    # Test coverage linkage analysis
│   │   ├── history-context.ts # Git blame + commit history context
│   │   ├── scoped-diagnostics.ts   # Filter diagnostics to changed targets only
│   │   ├── command-runner.ts  # Subprocess execution with timeout
│   │   ├── background-runner.ts    # Background task scheduling
│   │   └── repair-loop.ts     # Aider-style lint-fix retry system
└── test/                      # 30+ test suites (25 test files)
```

### Flow

1. Read file and populate the snapshot cache
2. Detect input format (JSON, search/replace, unified diff, OpenAI/Codex patch)
3. Repair malformed JSON if needed (forgiving parser)
4. Resolve symbolic edits (replaceBody, insertBefore, insertAfter) via AST
5. Resolve anchors / line ranges / hashline anchors for scoping
6. Run approval gating checks (path/symbol/line-range safety)
7. Match with the 6-tier fallback pipeline
8. Detect semantic conflicts against prior edits
9. Capture pre-edit undo state (fire-and-forget)
10. Apply the edit atomically (temp file + rename)
11. Run incremental syntax validation via tree-sitter re-parse (LRU-cached)
12. Run post-edit pipeline: LSP diagnostics → compiler fallback → scoped diagnostics → verification evidence → optional repair loop
13. Record breakage/co-change events to SmartRead bridge
14. Surface warnings, diagnostics, and evidence in the tool response

## Testing

```bash
cd .pi/extensions/smart-edit
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
| `SMART_EDIT_APPROVAL_LEVEL` | `never_prompt` / `prompt_on_dangerous` / `prompt_always` | `never_prompt` | Safety check verbosity |
| `SMART_EDIT_REPAIR_ENABLED` | `1`/`true`/`yes`/`on` | off | Enable edit repair loop (Aider-style retry) |
| `SMART_EDIT_REPAIR_MAX_RETRIES` | integer | `3` | Max retry attempts in the repair loop |

## Notes

- Java LSP uses `JDT_LS_JAR` at runtime.
- Read-range validation only trusts lines you actually read.
- Fuzzy matches are safe: replacements are always applied to the original file text.
- Undo data is stored in `.smart-edit-undo/` per project (fire-and-forget, never blocks).
- Verification pipeline is advisory: warnings are matchNotes, never hard errors by default.
- Repair loop is opt-in and non-critical: repair failures produce notes but never block the pipeline.
- Incremental syntax validation uses tree-sitter computeEdit + re-parse; falls back to full parse when the edit delta is too large.
