# Smart Edit Extension

A Pi coding agent extension that overrides the built-in `edit` tool with safer, smarter file editing.

## Architecture

```
.pi/extensions/smart-edit/
├── index.ts              # Extension entry point — tool registration, stale guard,
│                        #   atomic writes, mutation queue, LSP/conflict hooks
├── lib/
│   ├── types.ts          # Shared types, FileSnapshot, fastHash, MatchTier
│   ├── edit-diff.ts      # 4-tier matching pipeline, diff generation
│   ├── read-cache.ts     # Stale-file snapshot cache with APFS VFS retry
│   ├── path-utils.ts     # Path resolution (resolveToCwd)
│   ├── ast-resolver.ts   # Tree-sitter AST parsing, symbol resolution
│   ├── conflict-detector.ts  # AST-level conflict detection between edits
│   ├── grammar-loader.ts # Lazy-loads tree-sitter WASM grammars
│   ├── hashline.ts       # Line hashing for zero-text-reproduction editing
│   └── hashline-edit.ts  # Hashline-anchored edit application layer
├── src/
│   ├── formats/          # Multi-format parsers (search/replace, unified diff, OpenAI patch)
│   └── lsp/              # LSP integration (connection, diagnostics, semantic nav)
└── test/                 # Test suite (repo root)
```

## Key Layers

1. **Input normalization** (`index.ts:prepareArguments`) — JSON repair, legacy format compat, format detection
2. **Stale-file guard** (`read-cache.ts:checkStale`) — mtime+size+hash verification with APFS retry
3. **4-tier matching** (`edit-diff.ts:findText`) — exact → indent → unicode → similarity
4. **AST scoping** (`ast-resolver.ts`) — tree-sitter symbol resolution for anchor/line-range targeting
5. **Conflict detection** (`conflict-detector.ts`) — cross-edit semantic conflict tracking
6. **Atomic writes** (`index.ts:atomicWrite`) — temp file + rename with mode preservation
7. **Post-edit validation** — AST syntax check + LSP diagnostics
8. **Hashline editing** (`hashline.ts`, `hashline-edit.ts`) — anchor-based editing with freshness checks

## Conventions

- TypeScript strict mode with explicit types on public APIs
- No `any` outside of Pi API boundary casts (marked `as unknown`)
- All file operations use async fs/promises except `statSync` in read-cache (hot path)
- Tree-sitter WASM cleanup via `disposeParseResult()` — callers must call after use
- Errors are actionable: include file path, line range, similarity score, and fix hints
- Tests use Node built-in test runner (`node:test`) via `tsx --test`

## Testing

```bash
npm test                    # Run all tests
npx tsx --test test/<file>  # Run individual test file
```

## Dependencies

- `web-tree-sitter` + `@vscode/tree-sitter-wasm` — AST parsing
- `xxhash-wasm` — fast line hashing for hashline anchors
- `diff` — unified diff generation and parsing
- `typebox` — JSON schema for tool parameter validation
