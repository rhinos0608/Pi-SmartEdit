# Pre-Edit Semantic Retrieval (LSP-RAG) — Technical Specification

> **Status**: Proposal
> **Version**: 0.1
> **Date**: 2026-05-02
> **Primary code paths**: `src/lsp/*`, `lib/ast-resolver.ts`, `index.ts`, `lib/read-cache.ts`
> **Related docs**: [hashline-spec.md](./hashline-spec.md), [FEATURE-AST-TARGETING.md](./FEATURE-AST-TARGETING.md)

---

## 1. Problem Statement

Smart Edit already validates edits after mutation with LSP diagnostics, but the model still plans edits from text snippets, file reads, and similarity-based repository context. That leaves a blind spot before the edit: when the model sees a custom parameter, imported factory, interface, or injected dependency, it must infer where the important definition lives.

LSP-RAG moves semantic lookup into the pre-edit workflow. It uses language servers to resolve definitions, type definitions, implementations, document symbols, hover text, and references for symbols in the target edit range. The result is a compact dependency view that the model can read before editing.

The goal is not to load more files. The goal is to load the right symbols, in compact form, with compiler-level navigation rather than vector similarity.

## 2. Research Summary

Primary source: **LSPRAG: LSP-Guided RAG for Language-Agnostic Real-Time Unit Test Generation** (`arXiv:2510.22210v2`, ICSE 2026). The paper frames the same retrieval problem: code RAG based on embeddings often misses use-definition relationships, while language servers can answer them directly. LspRag extracts key tokens from a focal method, queries LSP definition/reference providers, and assembles concise context for the LLM. Its reported line coverage improvements over the best baseline are up to **174.55% for Go, 213.31% for Java, and 31.57% for Python**.

Useful design patterns from LspRag and the public implementation:

- Extract tokens from a bounded focal range rather than from the full file.
- Prefer semantic tokens when the server supports them.
- Fall back to AST and lexical token extraction when LSP token support is incomplete.
- Resolve definitions first, then group results by URI and enclosing symbol.
- Use `documentSymbol` to return symbol skeletons instead of raw full files.
- Skip definitions already inside the focal method to avoid echoing context the model already saw.
- Treat language server quality as a dependency. Retrieval quality degrades with weak or missing LSP support.

Relevant LSP 3.17 methods:

| Method | Use in Smart Edit |
|--------|-------------------|
| `textDocument/definition` | Resolve exact declaration/implementation location for a symbol use. |
| `textDocument/typeDefinition` | Resolve interfaces, parameter types, return types, and aliases. |
| `textDocument/implementation` | Resolve concrete classes/functions behind interfaces where available. |
| `textDocument/references` | Find examples and call sites when needed, bounded by token budget. |
| `textDocument/documentSymbol` | Build compact file/symbol skeletons and find enclosing symbol ranges. |
| `textDocument/hover` | Capture type signatures and short docs without reading whole bodies. |
| `textDocument/semanticTokens/*` | Identify meaningful symbols in a target range without regex guessing. Requires the server's returned semantic-token legend for decoding. |

## 3. Goals

1. Provide a pre-edit semantic context bundle for a target file/range/symbol.
2. Resolve dependencies through LSP before the model writes `oldText` or hashline edits.
3. Keep context compact: signatures, hovers, imports, and selected bodies only.
4. Reuse existing LSP infrastructure and degrade cleanly when no server exists.
5. Make retrieval deterministic, auditable, and bounded by latency/token budgets.
6. Preserve all current edit safety guarantees: stale-file guard, hashline validation, mutation queue, AST syntax validation, conflict detection, and post-edit LSP diagnostics.

## 4. Non-Goals

- Do not add vector embeddings or an external index in the first version.
- Do not auto-edit or self-repair without an explicit model edit call.
- Do not read entire dependency files unless explicitly requested by the model.
- Do not make LSP availability mandatory for edits.
- Do not rewire `src/pipeline.ts`; it is marked orphaned and bypasses current safety layers.

## 5. User Experience

### 5.1 MVP: explicit semantic context tool

Register a new tool, tentatively named `semantic_context`, that the model can call before editing.

Example call:

```json
{
  "path": "src/orders/service.ts",
  "lineRange": { "startLine": 42, "endLine": 78 },
  "maxTokens": 3000,
  "includeReferences": "examples",
  "includeImplementations": true
}
```

Example response:

```markdown
Semantic context for `src/orders/service.ts:42-78`

Target symbol: `createOrder(input: CreateOrderInput)`
Language server: typescript-language-server

Definitions:
- `CreateOrderInput` → `src/orders/types.ts:12-24`
  ```ts
  export interface CreateOrderInput { ... }
  ```
- `orderRepository` → `src/orders/repository.ts:31-45`
  ```ts
  export function createOrderRepository(db: Database): OrderRepository
  ```

Type definitions:
- `Database` → `src/db/index.ts:8-18`

Relevant references:
- `createOrder(...)` used in `src/orders/service.test.ts:18-53`
```

The edit tool prompt guidelines should then recommend:

> Before editing code that touches custom types, imported functions, factories, or framework APIs, call `semantic_context` for the target range.

### 5.2 Later: read-time suggestions or automatic augmentation

Smart Edit currently observes read results to populate caches. It does not yet prove that `tool_result` handlers can safely mutate read output. If the Pi extension API supports result transformation, a later phase can add a short footer to reads:

```text
Semantic context available: call semantic_context path="..." lineRange={...}
```

Automatic context injection should stay opt-in or budget-gated. Silent augmentation risks surprising token growth.

## 6. Retrieval Inputs

`semantic_context` accepts one target locator and optional budget knobs.

```typescript
interface SemanticContextInput {
  path: string;
  lineRange?: LineRange;
  anchor?: EditAnchor;
  symbol?: {
    name: string;
    kind?: string;
    line?: number;
  };
  hashline?: {
    pos: string;
    end?: string;
  };
  maxTokens?: number;           // default 3000
  maxDepth?: number;            // default 1
  includeReferences?: false | "examples" | "all";
  includeImplementations?: boolean;
  includeTypeDefinitions?: boolean;
  includeHover?: boolean;
}
```

Locator precedence:

1. `hashline` range, if present and the file has hashline snapshot data.
2. `anchor`, resolved by `lib/ast-resolver.ts`.
3. `symbol`, resolved by `documentSymbol` then AST fallback.
4. `lineRange`.
5. Full-file skeleton only, if no bounded target is provided.

## 7. Retrieval Pipeline

```text
semantic_context request
  │
  ├─ 1. Validate path and stale/read state
  │     - Must use the current on-disk file.
  │     - Should record/refresh read-cache metadata after reading.
  │
  ├─ 2. Determine language ID
  │     - Reuse and expand detectLanguageFromExtension.
  │
  ├─ 3. Open/sync document with LSP
  │     - textDocument/didOpen current content.
  │     - Reuse one LSPManager per session.
  │
  ├─ 4. Resolve target range
  │     - AST anchor, documentSymbol, hashline, or lineRange.
  │
  ├─ 5. Extract key tokens
  │     - semanticTokens/range if supported.
  │     - Tree-sitter identifiers and imports as fallback.
  │     - Filter builtins, keywords, locals, and duplicates.
  │
  ├─ 6. Expand semantic graph
  │     - definition, typeDefinition, implementation, hover.
  │     - optional references for examples.
  │     - dedupe by URI + range.
  │
  ├─ 7. Summarize each location
  │     - enclosing document symbol range.
  │     - signature/detail/imports by default.
  │     - full body only for small symbols or requested examples.
  │
  └─ 8. Rank and render
        - parameters and return-path symbols first.
        - in-workspace definitions before external libraries.
        - types/interfaces before call examples.
        - enforce maxTokens and include truncation notes.
```

## 8. Key Token Selection

The first version should keep heuristics simple and auditable.

Include:

- Function and method calls in the target range.
- Custom parameter and return types.
- Imported identifiers used in the range.
- Identifiers in branch conditions and thrown errors.
- Constructor/factory calls.
- Property accesses where the base is a non-local dependency.

Exclude:

- Keywords, punctuation, literals, and comments.
- Built-in/global primitives (`string`, `number`, `Promise`, `Array`, etc.) unless hover/type resolution points inside the workspace.
- Definitions inside the same focal range.
- Duplicate symbols with the same definition URI/range.
- `node_modules` and generated files by default.

When semantic tokens are unavailable, use Tree-sitter to collect identifier nodes inside the range and classify them with local import/function-scope heuristics.

## 9. Context Compression

Each resolved location gets a `ContextItem`.

```typescript
interface ContextItem {
  symbolName: string;
  relationship: "definition" | "typeDefinition" | "implementation" | "reference" | "hover";
  uri: string;
  range: LSPRange;
  score: number;
  excerptKind: "hover" | "signature" | "skeleton" | "body" | "reference";
  text: string;
  truncated: boolean;
}
```

Rendering rules:

1. Use hover text when it contains a type signature or docs under 20 lines.
2. Use `documentSymbol` detail/name/range to extract a signature or skeleton.
3. Include imports/package declarations only when needed to understand type ownership.
4. Include full bodies only for small functions/classes or explicit reference examples.
5. Prefer one strong definition over many weak references.
6. Always show source path and line range.

## 10. Integration with Existing Smart Edit Architecture

Current useful pieces:

- `src/lsp/lsp-connection.ts`: JSON-RPC over stdio with request/notification support.
- `src/lsp/lsp-manager.ts`: lazy server startup and session shutdown.
- `src/lsp/semantic-nav.ts`: definition/reference/hover wrappers.
- `src/lsp/diagnostics.ts`: didOpen, diagnostic collection, didClose pattern.
- `lib/ast-resolver.ts`: Tree-sitter parsing, anchor resolution, enclosing symbol lookup.
- `lib/read-cache.ts`: stale/read tracking and hashline snapshot storage.
- `index.ts`: tool registration, session lifecycle, edit prompt guidelines.

Required additions:

- Extend LSP client capabilities for `documentSymbol`, `semanticTokens`, `typeDefinition`, `implementation`, and `declaration`.
- Store server initialize capabilities, especially `semanticTokensProvider.legend`.
- Normalize both `Location` and `LocationLink` response shapes while preserving `originSelectionRange`.
- Fix LSP manager fallback startup so a failed primary TypeScript server does not prevent trying backup configs.
- Add a serialized document sync helper so retrieval and diagnostics do not race or duplicate `didOpen`/`didClose` logic.
- Add semantic token decoding with safe fallbacks.
- Register a new retrieval tool without touching the edit mutation path.

## 11. Safety and Failure Behavior

LSP-RAG must never make edits less safe.

- If LSP is unavailable, return a clear degraded result with AST/import fallback context.
- If a request times out, keep partial context and report which provider failed.
- If the target file was not read this session, reject for MVP and ask the model to read it first.
- Dependency files resolved by LSP may be read by the retrieval tool, but every returned snippet must be recorded as a session read range before the tool returns.
- Never include hidden file contents in an edit authorization path. Retrieval can show context, but edit still requires the normal stale/range guards.
- Do not include secrets from `.env`, key files, lockfiles, or binary/generated files.
- Bound traversal by depth, item count, and max tokens.

## 12. Observability

`semantic_context` should return metadata in `details`:

```typescript
interface SemanticContextDetails {
  source: "lsp" | "ast" | "none";
  languageId: string | null;
  targetRange?: LineRange;
  tokenCount: number;
  resolvedDefinitions: number;
  resolvedTypeDefinitions: number;
  resolvedImplementations: number;
  resolvedReferences: number;
  elapsedMs: number;
  warnings: string[];
}
```

This makes the feature testable and lets future prompt tuning compare retrieval quality with edit success.

## 13. Open Questions

1. Can Pi extension `tool_result` handlers mutate read output, or should automatic injection remain a separate tool forever?
2. Should retrieval be allowed to read files that the model has not explicitly read, if it returns those snippets to the model first?
3. What token budget should be default for small models versus large models?
4. Should TypeScript use `typescript-language-server` only, or support direct `tsserver` as a fallback?
5. Should external library definitions be represented by hover text only unless explicitly requested?

## 14. Acceptance Criteria

- Calling `semantic_context` on a TypeScript range with a custom interface returns that interface definition or type skeleton.
- Calling it on a function that uses an imported factory returns the factory signature and source location.
- Missing LSP returns a useful AST/import fallback, not an error stack.
- Retrieval output stays under `maxTokens` and reports truncation.
- Existing `edit` behavior and tests remain unchanged.
- Post-edit diagnostics continue to run after edits.
