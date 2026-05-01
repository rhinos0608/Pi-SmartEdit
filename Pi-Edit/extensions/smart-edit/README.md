# Smart Edit — Improved Edit Tool for Pi Coding Agent

A Pi extension that overrides the built-in `edit` tool with safer, smarter file editing.

## What's improved

| Feature | Description |
|---------|-------------|
| **4-tier matching pipeline** | Exact → indentation → Unicode → similarity-scored (Levenshtein ≥85%). Each tier is a safety net, not a parallel alternative. |
| **No file corruption on fuzzy match** | Unicode/indentation normalization is used only as a coordinate finder — replacements are always applied to original content. |
| **`replaceAll` support** | `edits[i].replaceAll: true` replaces every non-overlapping occurrence. |
| **AST anchor targeting** | `edits[i].anchor` scopes matching to a named symbol (function, class, method) using tree-sitter. Eliminates ambiguity on repeated text in different scopes. |
| **Line-range scoping** | `edits[i].lineRange` restricts matching to a specific line range. Falls back to whole-file search if not found. |
| **AST conflict detection** | Tracks which AST-level symbols were edited across sequential calls. Two modes: `warn` (collects warnings in output) or `error` (blocks the edit). |
| **LSP diagnostic feedback** | After edit, opens the file in an LSP server and surfaces errors/warnings in output. Supports TypeScript/JavaScript. |
| **Multi-format input** | Accepts search/replace blocks, unified diffs, and OpenAI patch formats in the `edits` field. Auto-detected. |
| **Stale-file guard** | Blocks edits when the file was modified since the last `read`. Cache populated from `read`, `read_multiple_files`, `intent_read`, and `write`. |
| **Closest-match diagnostics** | When a match fails, returns the best near-match with line range, similarity %, actual vs expected text, and a hint about what differed. |
| **Fuzzy-match transparency** | Success responses include a note when indentation or Unicode normalization was used — teaching the model to produce exact matches. |
| **Atomic writes** | Writes to temp file first, preserves mode bits, renames atomically. Fallback to direct write on cross-device filesystems. |
| **Trailing newline handling** | Deleting code (empty `newText`) automatically consumes the trailing newline to prevent orphan blank lines. |
| **Mutation queue** | Per-file serialization prevents concurrent edit races. Survives individual failures without deadlocking. |
| **`description` field** | Optional per-edit label echoed in error messages for model self-reference. |

## Supported languages

### Tree-sitter AST resolution

Anchors and conflict detection use tree-sitter grammars from `@vscode/tree-sitter-wasm`. Supported languages:

| Language | File extensions |
|----------|----------------|
| TypeScript / TSX | `.ts`, `.tsx`, `.mts`, `.cts` |
| JavaScript / JSX | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `.py` |
| Rust | `.rs` |
| Go | `.go` |
| Java | `.java` |
| C / C++ | `.c`, `.cpp`, `.h`, `.hpp` |
| Ruby | `.rb` |
| CSS | `.css` |

Other extensions (`.json`, `.yaml`, `.yml`, `.html`) gracefully degrade — text-based matching works, AST features are unavailable.

### LSP diagnostics

Post-edit diagnostic checking uses `typescript-language-server` (or `typescriptlangserver` as fallback). Supports:

| Language ID | Extensions |
|-------------|------------|
| `typescript` | `.ts`, `.mts`, `.cts` |
| `typescriptreact` | `.tsx` |
| `javascript` | `.js`, `.mjs`, `.cjs` |
| `javascriptreact` | `.jsx` |

## Installation

The extension is already in `.pi/extensions/smart-edit/` for project-local use.

```bash
# Install dependencies (run once)
cd .pi/extensions/smart-edit && npm install
```

The extension auto-loads when Pi starts. No manual registration required.

## Usage

Same interface as the built-in `edit` tool, with four optional fields per edit:

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

### With all optional fields

```json
{
  "path": "src/foo.ts",
  "edits": [
    {
      "oldText": "return result;",
      "newText": "return processedResult;",
      "replaceAll": false,
      "anchor": {
        "symbolName": "processRequest",
        "symbolKind": "function_declaration",
        "symbolLine": 42
      },
      "lineRange": { "startLine": 44, "endLine": 52 },
      "description": "rename return value in processRequest"
    }
  ]
}
```

### Typical patterns

**Target a specific function when oldText appears in multiple functions:**
```json
{ "edits": [{ "oldText": "return result;", "newText": "return processedResult;", "anchor": { "symbolName": "processRequest" } }] }
```

**Target a line range without AST (file has no grammar support):**
```json
{ "edits": [{ "oldText": "const x = 1;", "newText": "const x = 2;", "lineRange": { "startLine": 10, "endLine": 15 } }] }
```

**Replace all occurrences of a variable name:**
```json
{ "edits": [{ "oldText": "userName", "newText": "displayName", "replaceAll": true }] }
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `oldText` | `string` (required) | Exact text to find in the file. Must be unique unless `replaceAll`, `anchor`, or `lineRange` is used. |
| `newText` | `string` (required) | Replacement text to write in place of `oldText`. |
| `replaceAll` | `boolean` | Replace every non-overlapping occurrence of `oldText`. Default: `false`. |
| `anchor` | `object` | AST-based disambiguation. Scope matching to a named symbol. See [AST targeting docs](./docs/FEATURE-AST-TARGETING.md). |
| `lineRange` | `object` | Restrict matching to a line range. See [line range docs](./docs/FEATURE-LINE-RANGE.md). |
| `description` | `string` | Label echoed in error messages for model self-reference. |

#### Anchor fields

| Field | Type | Description |
|-------|------|-------------|
| `symbolName` | `string` | Name of the enclosing symbol (e.g., `"handleRequest"`, `"MyClass"`). |
| `symbolKind` | `string` | Kind of symbol to filter by (e.g., `"function_declaration"`, `"class_declaration"`). If omitted, all symbol kinds with the matching name are considered. |
| `symbolLine` | `number` | 1-based line number hint for where the symbol's name appears. Used to disambiguate symbols with the same name. |

#### Line range fields

| Field | Type | Description |
|-------|------|-------------|
| `startLine` | `number` | 1-based start line (inclusive). |
| `endLine` | `number` | 1-based end line (inclusive). Defaults to `startLine` if omitted. |

### Multi-format input

When `edits` is a string (not an array), the tool auto-detects and parses these formats:

- **Search/replace blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
- **Unified diffs** — standard `---` / `+++` / `@@` header format
- **OpenAI patches** — `*** Begin Patch` / `*** End Patch` format

### Conflict detection modes

| Mode | Behavior |
|------|----------|
| `warn` (default) | Collects conflict warnings in edit output. Edit proceeds. |
| `error` | Blocks the edit with an error message. Model must re-read the file. |
| `auto-reread` | **Planned, not yet implemented.** Falls back to `warn` behavior. |

Conflict detection tracks which AST-level scopes were edited across sequential calls, detecting semantic conflicts that byte-range overlap misses (e.g., renaming a function in one call while editing its body in another).

## Testing

Tests live at the repository root and use Node's native test runner via `tsx`:

```bash
# Run all tests
npm test

# Run individual test files
npx tsx --test ../../../test/edit-diff.test.ts
npx tsx --test ../../../test/read-cache.test.ts
npx tsx --test ../../../test/ast-resolver.test.ts
npx tsx --test ../../../test/ast-integration.test.ts
npx tsx --test ../../../test/conflict-detector.test.ts
npx tsx --test ../../../test/integration.test.ts
npx tsx --test ../../../test/lsp.test.ts
npx tsx --test ../../../test/formats.test.ts
npx tsx --test ../../../test/error-handling.test.ts
```

## Architecture

```
.pi/extensions/smart-edit/
├── index.ts                 # Extension entry point — tool registration, stale guard,
│                            #   atomic writes, mutation queue, LSP/conflict hooks
├── lib/
│   ├── types.ts             # Shared types, FileSnapshot, fastHash, MatchTier, etc.
│   ├── edit-diff.ts         # 4-tier matching pipeline (exact → indent → unicode → similarity),
│                            #   diff generation, indentation detection, Levenshtein similarity
│   ├── read-cache.ts        # Stale-file snapshot cache with APFS VFS retry logic
│   ├── path-utils.ts        # Path resolution (resolveToCwd)
│   ├── ast-resolver.ts      # Tree-sitter AST parsing, symbol resolution, anchor matching
│   ├── conflict-detector.ts # AST-level conflict detection between sequential edit calls
│   └── grammar-loader.ts    # Lazy-loads tree-sitter WASM grammars from @vscode/tree-sitter-wasm
├── src/
│   ├── formats/
│   │   ├── format-detector.ts     # Detects input format (search-replace, unified-diff, openai-patch)
│   │   ├── search-replace.ts      # Search/replace block parser
│   │   ├── unified-diff.ts        # Unified diff parser
│   │   └── openai-patch.ts        # OpenAI patch format parser
│   └── lsp/
│       ├── lsp-connection.ts      # LSP JSON-RPC over stdio (EventEmitter-style notifications)
│       ├── lsp-manager.ts         # LSP server lifecycle management (lazy startup, two binaries)
│       ├── diagnostics.ts         # Post-edit LSP diagnostic checking
│       └── semantic-nav.ts        # Semantic navigation helpers (go-to-def, references)
├── docs/
│   ├── FEATURE-AST-TARGETING.md   # AST anchor syntax and usage
│   ├── FEATURE-CONFLICT-DETECTION.md  # Cross-edit conflict detection behavior
│   ├── FEATURE-LINE-RANGE.md      # Line-range scoping
│   └── IMPLEMENTATION-PLAN.md     # Original implementation plan
├── package.json
└── README.md
```

### Key design decisions

- **4-tier matching pipeline**: exact → indentation-normalized → Unicode-normalized → similarity-scored. Each tier is a safety net for the previous one, not a parallel alternative. Replacements are always applied to original content, never in normalized space.
- **Normalization as coordinate finder**: All fuzzy matching happens in normalized space, but replacements are always applied to original content at mapped positions. This prevents file corruption.
- **AST anchor resolution**: Edits can be scoped to named symbols (functions, classes, methods) using tree-sitter, enabling unambiguous matching even for repeated text.
- **Conflict detection**: Tracks which AST-level symbols were edited across sequential calls, detecting semantic conflicts that byte-range overlap misses.
- **LSP integration**: Post-edit diagnostic checking surfaces TypeScript/JS errors and warnings. Uses `typescript-language-server` with `typescriptlangserver` as fallback. Servers start lazily and are reused across edits.
- **Mutation queue**: Per-file serialization prevents concurrent edit races. Survives individual failures without deadlocking (failed edits don't block subsequent edits to the same file).
- **Stale-file guard**: Cache populated automatically from `read`, `read_multiple_files`, `intent_read`, and `write`. Partial reads (offset/limit, truncated output) fall back to mtime-only verification.
