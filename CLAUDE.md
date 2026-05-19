# Smart Edit Extension

A Pi coding agent extension that overrides the built-in `edit` tool with safer, smarter file editing.

## Architecture

```text
.pi/extensions/smart-edit/
├── index.ts              # Extension entry point — tool registration, stale guard,
│                        #   atomic writes, mutation queue, LSP/conflict hooks
├── lib/
│   ├── types.ts          # Shared types, FileSnapshot, fastHash, MatchTier
│   ├── edit-diff.ts      # 6-tier matching pipeline, diff generation
│   ├── hashline.ts       # Line hashing for hashline anchors (xxhash-wasm)
│   ├── hashline-edit.ts  # Hashline edit application and validation
│   ├── read-cache.ts     # Stale-file snapshot cache with APFS VFS retry
│   ├── path-utils.ts     # Path resolution (resolveToCwd)
│   ├── ast-resolver.ts   # Tree-sitter AST parsing, symbol resolution
│   ├── conflict-detector.ts  # AST-level conflict detection between edits
│   └── grammar-loader.ts # Lazy-loads tree-sitter WASM grammars
├── src/
│   ├── edit-mode.ts      # Runtime config (hashline toggle, env vars)
│   ├── symbolic-edits.ts # Symbolic edit engine (replaceBody, insertBefore, insertAfter)
│   ├── smartread-bridge.ts # Breakage/co-change recording to Pi-SmartRead
│   ├── safety/
│   │   └── approval-gating.ts # Path/symbol/line-range safety checks
│   ├── undo/
│   │   ├── atomic-write.ts    # Temp-file write + rename with mode preservation
│   │   └── edit-history.ts    # Per-edit undo capture
│   ├── formats/          # Multi-format parsers (search/replace, unified diff,
│   │                     #   OpenAI patch, Codex patch, streaming, forgiving)
│   ├── lsp/              # LSP integration (connection, diagnostics, semantic nav,
│   │                     #   context rendering, symbol skeleton, document sync)
│   └── verification/     # Post-edit evidence pipeline (concurrency, traceability,
│                         #   history context, scoped diagnostics, auto-validation)
└── test/                 # 30+ test suites
```

## Key Layers

1. **Input normalization** (`index.ts:prepareArguments`) — JSON repair, legacy format compat, format detection
2. **Stale-file guard** (`read-cache.ts:checkStale`) — mtime+size+hash verification with APFS retry
3. **6-tier matching** (`edit-diff.ts:findText`) — exact → indent → unicode → similarity → dotdotdots → relative_indent
4. **Symbolic editing** (`symbolic-edits.ts`) — replaceBody, insertBefore, insertAfter via AST symbol resolution
5. **AST scoping** (`ast-resolver.ts`) — tree-sitter symbol resolution for anchor/line-range targeting
6. **Hashline editing** (`hashline.ts`, `hashline-edit.ts`) — zero-text freshness-checked edits (opt-in)
7. **Approval gating** (`approval-gating.ts`) — path/symbol/line-range safety checks
8. **Conflict detection** (`conflict-detector.ts`) — cross-edit semantic conflict tracking
9. **Undo system** (`edit-history.ts`) — pre-edit state capture in `.smart-edit-undo/`
10. **Atomic writes** (`src/undo/atomic-write.ts`) — temp file + rename with mode preservation
11. **Post-edit validation** — AST syntax check + LSP diagnostics + compiler fallback
12. **Verification pipeline** (`src/verification/`) — concurrency detection, traceability, history context
13. **Scoped diagnostics** (`scoped-diagnostics.ts`) — filter diagnostics to changed targets only
14. **Auto-validation** (`auto-validate.ts`) — retry-aware structural check + validation feedback
15. **Context markers** (`context-markers.ts`) — XML-style tags for injected semantic context
16. **Streaming patch** (`streaming-patch-parser.ts`) — progressive parse with progress callbacks
17. **Forgiving parser** (`forgiving-parser.ts`) — auto-repair malformed JSON from LLM output
18. **SmartRead bridge** (`smartread-bridge.ts`) — breakage/co-change event recording

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
- `diff` — unified diff generation and parsing
- `typebox` — JSON schema for tool parameter validation
- `xxhash-wasm` — fast non-cryptographic hashing for hashline anchors
