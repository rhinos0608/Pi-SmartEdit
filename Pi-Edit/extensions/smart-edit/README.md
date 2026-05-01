# Smart Edit — Improved Edit Tool for Pi Coding Agent

Smart Edit replaces Pi's built-in `edit` tool with safer matching, richer diagnostics, and stronger edit protection.

## What it does

- **4-tier matching**: exact → indentation → Unicode → similarity
- **AST-scoped edits**: target a symbol with `anchor`
- **Line-range scoping**: constrain matching with `lineRange`
- **Hashline edits**: freshness-checked anchored edits for zero-text workflows
- **Multi-format input**: accepts raw JSON edits, search/replace blocks, unified diffs, and OpenAI patch format
- **Stale-file guard**: blocks edits when the file changed since read
- **Range coverage guard**: blocks edits outside the lines you actually read
- **Conflict detection**: warns or blocks on overlapping AST-level changes
- **Atomic writes**: temp-file write + rename, with mode preservation
- **Mutation queue**: serializes edits per file to avoid races
- **Closest-match diagnostics**: shows the best near-match when an edit fails
- **Post-edit diagnostics**: LSP + compiler fallback across multiple languages

## Diagnostics

Smart Edit now uses a multi-tier diagnostics pipeline:

1. **LSP diagnostics** when a server is available
2. **Compiler fallback** when LSP has nothing useful
3. **Language-specific output parsing** to turn CLI results into editor diagnostics

Supported fallback tools include:

- `tsc`
- `pyright`
- `cargo check`
- `go vet`
- `rubocop`

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
├── index.ts                 # Tool registration, stale guard, atomic writes, mutation queue
├── lib/
│   ├── edit-diff.ts         # 4-tier matching pipeline and diff generation
│   ├── hashline.ts          # Line hashing for hashline anchors
│   ├── hashline-edit.ts     # Hashline edit application and validation
│   ├── read-cache.ts        # Snapshot cache and read-range coverage guard
│   ├── ast-resolver.ts      # Tree-sitter parsing and symbol resolution
│   ├── conflict-detector.ts  # AST-level conflict detection
│   └── types.ts             # Shared types
├── src/
│   ├── formats/             # Search/replace, unified diff, OpenAI patch parsing
│   └── lsp/
│       ├── lsp-connection.ts # JSON-RPC over stdio
│       ├── lsp-manager.ts    # Lazy server startup and runtime Java config
│       ├── diagnostics.ts    # Post-edit LSP checks
│       ├── diagnostic-dispatcher.ts # Compiler fallback diagnostics
│       ├── semantic-context.ts
│       └── language-id.ts
└── test/
```

### Flow

1. Read file and populate the snapshot cache
2. Resolve anchors / line ranges / hashline anchors
3. Match with the 4-tier fallback pipeline
4. Apply the edit atomically
5. Run LSP diagnostics first
6. Fall back to compiler diagnostics if needed
7. Surface warnings and errors in the tool response

## Testing

```bash
cd .pi/extensions/smart-edit
npm test
```

You can also run a focused test:

```bash
npx tsx --test test/diagnostic-dispatcher.test.ts
```

## Notes

- Java LSP uses `JDT_LS_JAR` at runtime.
- Read-range validation only trusts lines you actually read.
- Fuzzy matches are safe: replacements are always applied to the original file text.
