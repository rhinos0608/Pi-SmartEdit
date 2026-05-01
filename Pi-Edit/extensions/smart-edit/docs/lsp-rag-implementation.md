# Pre-Edit Semantic Retrieval (LSP-RAG) — Implementation Plan

> **Status**: Planning
> **Spec Reference**: [lsp-rag-spec.md](./lsp-rag-spec.md)
> **Date**: 2026-05-02
> **Estimated effort**: 4 phases
> **Primary risk**: LSP document synchronization and token-budget control

---

## Phase Overview

| Phase | Scope | Risk | Dependency |
|-------|-------|------|------------|
| 1 | LSP navigation foundation and server reliability | Medium | Existing `src/lsp/*` |
| 2 | Semantic context retrieval library | Medium | Phase 1, AST resolver |
| 3 | `semantic_context` tool integration | Low/Medium | Phase 2, read cache |
| 4 | Tests, prompt tuning, docs | Low | Phase 3 |

The MVP should add an explicit retrieval tool first. Automatic read augmentation should wait until the Pi extension API confirms safe result transformation.

---

## Phase 1: LSP Navigation Foundation

### Goal

Make the existing LSP layer capable of resolving all semantic relationships needed for pre-edit retrieval.

### 1.1 Modify `src/lsp/lsp-connection.ts`

Expand initialize capabilities and retain initialize results needed by retrieval.

Current capabilities include diagnostics, definition, references, and hover. Add:

```typescript
capabilities: {
  textDocument: {
    diagnostic: { dynamicRegistration: true },
    declaration: { dynamicRegistration: true, linkSupport: true },
    definition: { dynamicRegistration: true, linkSupport: true },
    typeDefinition: { dynamicRegistration: true, linkSupport: true },
    implementation: { dynamicRegistration: true, linkSupport: true },
    references: { dynamicRegistration: true },
    hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
    documentSymbol: {
      dynamicRegistration: true,
      hierarchicalDocumentSymbolSupport: true,
    },
    semanticTokens: {
      dynamicRegistration: true,
      requests: { range: true, full: true },
      tokenTypes: [],
      tokenModifiers: [],
      formats: ["relative"],
    },
  },
}
```

Notes:

- LSP allows clients to advertise token type arrays. Start with empty arrays only if TypeScript server accepts them in tests. If not, use the standard token lists from the LSP spec.
- Store the initialize result on `LSPConnection`, including `serverCapabilities.semanticTokensProvider.legend`. Semantic token decoding must use the server-returned legend, not client-advertised placeholder arrays.
- Keep request timeout unchanged for now. Semantic retrieval will apply its own per-provider budget.
- Accept an optional `AbortSignal` in new high-level retrieval helpers. `LSPConnection.request` can keep its timeout, but callers should stop issuing additional requests after abort.

### 1.2 Modify `src/lsp/lsp-manager.ts`

Fix server fallback before building retrieval on top of LSP.

Current `getServer` has a known limitation: if the first matching TypeScript server binary exists but fails during `initialize`, the backup config is not attempted. LSP-RAG depends on server availability, so this should be part of Phase 1.

Implementation notes:

- Iterate over all matching `SERVER_CONFIGS` for the requested language ID.
- Only cache a connection after `initialize()` succeeds.
- If startup fails, shut down/kill that connection and try the next config.
- Cache a short-lived negative result per language ID only after all configs fail, if needed for performance.

### 1.3 Modify `src/lsp/semantic-nav.ts`

Add response normalization and new request wrappers.

```typescript
export interface LocationLink {
  targetUri: string;
  targetRange: LSPRange;
  targetSelectionRange: LSPRange;
  originSelectionRange?: LSPRange;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: DocumentSymbol[];
}

export interface SemanticToken {
  line: number;
  character: number;
  length: number;
  tokenType?: string;
  tokenModifiers: string[];
  text: string;
}

export interface ResolvedLocation {
  location: Location;
  originRange?: LSPRange;
}

export function normalizeLocations(response: unknown): ResolvedLocation[];
export async function goToDeclaration(...): Promise<ResolvedLocation[]>;
export async function goToTypeDefinition(...): Promise<ResolvedLocation[]>;
export async function goToImplementation(...): Promise<ResolvedLocation[]>;
export async function getDocumentSymbols(...): Promise<DocumentSymbol[]>;
export async function getSemanticTokensForRange(...): Promise<SemanticToken[]>;
```

Implementation details:

- Keep existing `goToDefinition` return type for compatibility, but add `goToDefinitions` returning `ResolvedLocation[]`.
- Convert `LocationLink.targetUri/targetRange` into the internal `Location` shape.
- Preserve `LocationLink.originSelectionRange` as `originRange` so resolved definitions can be correlated with the source key token.
- Return empty arrays on unsupported providers.
- Do not swallow all errors silently in new helpers. Return warnings to the caller where possible.

### 1.4 Add `src/lsp/document-sync.ts`

Avoid duplicating `didOpen`/`didClose` between diagnostics and retrieval.

```typescript
export async function withOpenDocument<T>(
  server: LSPConnection,
  input: {
    uri: string;
    languageId: string;
    content: string;
    version?: number;
  },
  fn: () => Promise<T>,
): Promise<T>;
```

Behavior:

1. Serialize sync operations per document URI to avoid retrieval/diagnostics races.
2. Track a monotonic document version per URI instead of hardcoding `version: 1` in new code.
3. Send `textDocument/didOpen` if the helper owns a new open document.
4. Execute the callback.
5. Send `textDocument/didClose` in `finally` when this helper opened the document.
6. Ignore `didClose` errors only after logging a warning for details output.

If a later refactor shares open documents across diagnostics and retrieval, use reference counting plus `didChange` rather than overlapping `didOpen` calls for the same URI.

Migration:

- Leave `checkPostEditDiagnostics` unchanged in the first commit if safer.
- Once retrieval passes tests, optionally refactor diagnostics to use `withOpenDocument`.

### 1.5 Add tests

Create or extend `/Users/rhinesharar/Pi-SmartEdit/test/lsp.test.ts`.

Test cases:

- `normalizeLocations` handles `null`, single `Location`, `Location[]`, and `LocationLink[]`.
- New wrappers return empty arrays when no server is available.
- `getDocumentSymbols` handles `DocumentSymbol[]` and `SymbolInformation[]` if mock server supports them.
- `withOpenDocument` closes the document when callback throws.

---

## Phase 2: Semantic Context Retrieval Library

### Goal

Build a reusable library that turns a target range into a compact semantic context bundle.

### 2.1 New file: `src/lsp/semantic-context.ts`

Primary exports:

```typescript
export interface SemanticContextInput {
  path: string;
  lineRange?: LineRange;
  anchor?: EditAnchor;
  symbol?: { name: string; kind?: string; line?: number };
  hashline?: { pos: string; end?: string };
  maxTokens?: number;
  maxDepth?: number;
  includeReferences?: false | "examples" | "all";
  includeImplementations?: boolean;
  includeTypeDefinitions?: boolean;
  includeHover?: boolean;
}

export interface SemanticContextResult {
  markdown: string;
  items: ContextItem[];
  details: SemanticContextDetails;
}

export async function buildSemanticContext(
  input: SemanticContextInput,
  deps: SemanticContextDeps,
): Promise<SemanticContextResult>;
```

`SemanticContextDeps` should inject existing services for testability:

```typescript
export interface SemanticContextDeps {
  cwd: string;
  lspManager: LSPManager | null;
  astResolver: ReturnType<typeof createAstResolver> | null;
  readFile(path: string): Promise<string>;
  getSnapshot(path: string, cwd: string): FileSnapshot | null;
  recordRead(path: string, cwd: string, content: string, partial?: boolean): void;
}
```

### 2.2 Target range resolution

Implement in the same file or `src/lsp/target-range.ts`.

Order:

1. Hashline range from cached snapshot. Parse anchors with `hashline-edit.ts` helpers and use the current snapshot to convert `pos`/`end` strings into a line range; attempt the same bounded rebase behavior used by hashline edits when anchors drift.
2. AST anchor via `astResolver.findSymbolNode`.
3. LSP `documentSymbol` by name/line.
4. Explicit `lineRange`.
5. Whole-file skeleton fallback.

Return:

```typescript
interface ResolvedTarget {
  lineRange: LineRange;
  byteRange: { startIndex: number; endIndex: number };
  symbolName?: string;
  source: "hashline" | "anchor" | "documentSymbol" | "lineRange" | "file";
}
```

Reuse `lineRangeToByteRange` from `lib/edit-diff.ts` where possible.

### 2.3 Key token extraction

Implement `extractKeyTokens`.

```typescript
interface KeyToken {
  name: string;
  line: number;       // 0-based LSP position
  character: number;  // 0-based LSP position
  length: number;
  kind: "call" | "type" | "parameter" | "import" | "condition" | "identifier";
  score: number;
}
```

Preferred path:

1. Request `semanticTokens/range`.
2. Read `semanticTokensProvider.legend` captured from the server's initialize response.
3. Decode relative token positions with that legend.
4. Attach text by slicing the source line.
5. Filter and score tokens.

If the server has no semantic-token provider or no usable legend, skip directly to the Tree-sitter fallback.

Fallback path:

1. Parse with Tree-sitter.
2. Walk named identifier-like nodes inside the target byte range.
3. Use nearby syntax/import declarations for rough classification.
4. Filter locals and duplicates.

Simple first-version scoring:

| Signal | Score |
|--------|-------|
| Parameter or return type | +50 |
| Imported identifier | +40 |
| Function/method call | +35 |
| Branch condition identifier | +25 |
| Constructor/factory naming (`create*`, `*Factory`, `new`) | +20 |
| Local variable only | -20 |
| Builtin/primitive | exclude |

### 2.4 Semantic graph expansion

For each key token, call providers in bounded order:

1. `definition`
2. `typeDefinition` when enabled
3. `implementation` when enabled and token appears interface-like/type-like
4. `hover` when enabled
5. `references` only when `includeReferences` is not false

Constraints:

- Max 20 key tokens in MVP.
- Max 3 locations per provider per token.
- Max depth 1 by default.
- Dedupe by `uri:startLine:startCharacter:endLine:endCharacter`.
- Ignore definitions inside the target range.
- Prefer in-workspace paths. For external paths, use hover only unless explicitly enabled later.

### 2.5 Symbol summarization

Add `src/lsp/symbol-skeleton.ts`.

Exports:

```typescript
export function findEnclosingDocumentSymbol(
  symbols: DocumentSymbol[],
  location: Location,
): DocumentSymbol | null;

export function extractSymbolExcerpt(
  content: string,
  symbol: DocumentSymbol | null,
  location: Location,
  options: { maxLines: number; preferSkeleton: boolean },
): { text: string; excerptKind: ContextItem["excerptKind"]; truncated: boolean };
```

Rules:

- If symbol is a TypeScript interface/type/class/function under 30 lines, include full body.
- If symbol is larger, include signature plus child symbol skeleton.
- For references, include 3-7 lines around the call site.
- For hover-only external definitions, include hover markdown and path if available.

### 2.6 Rendering and token budget

Add `src/lsp/context-renderer.ts`.

Start with a conservative token approximation:

```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

Render order:

1. Header with target and source.
2. Definitions.
3. Type definitions.
4. Implementations.
5. References/examples.
6. Warnings/truncation.

Stop before exceeding `maxTokens`; include omitted counts.

---

## Phase 3: Tool Integration

### Goal

Expose semantic retrieval to the model without disturbing the current edit path.

### 3.1 Modify `index.ts` imports and session state

Use existing globals:

- `astResolver`
- `lspManager`

Move the private `detectLanguageFromExtension` helper out of `index.ts` into a shared module, such as `src/lsp/language-id.ts`, so both `edit` diagnostics and `semantic_context` use the same mapping.

Import the new builder lazily inside the tool execute method to avoid startup cost.

### 3.2 Register `semantic_context`

Add a second tool registration near the `edit` registration.

Schema sketch:

```typescript
const semanticContextSchema = Type.Object({
  path: Type.String({ description: "Path to inspect semantically" }),
  lineRange: Type.Optional(Type.Object({
    startLine: Type.Number(),
    endLine: Type.Optional(Type.Number()),
  })),
  anchor: Type.Optional(/* same as edit anchor schema */),
  symbol: Type.Optional(Type.Object({
    name: Type.String(),
    kind: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
  })),
  maxTokens: Type.Optional(Type.Number({ default: 3000 })),
  maxDepth: Type.Optional(Type.Number({ default: 1 })),
  includeReferences: Type.Optional(Type.Union([
    Type.Literal(false),
    Type.Literal("examples"),
    Type.Literal("all"),
  ])),
  includeImplementations: Type.Optional(Type.Boolean()),
  includeTypeDefinitions: Type.Optional(Type.Boolean()),
  includeHover: Type.Optional(Type.Boolean()),
});
```

Execution behavior:

1. Resolve `absolutePath`.
2. Read current file content.
3. Optionally require prior read for MVP:
   - Check `getSnapshot(path, cwd)`.
   - If missing, return an actionable message: read file first.
4. Call `buildSemanticContext`.
5. Return markdown content and `details`.

### 3.3 Update edit prompt guidelines

Add one guideline to the edit tool:

```text
Before editing code that depends on custom types, imported factories, interfaces, or unfamiliar symbols, call semantic_context for the target range instead of reading whole dependency files.
```

Do not make this mandatory. Some edits are trivial.

### 3.4 Read-cache interaction

`semantic_context` reads dependency files to summarize definitions. These reads are shown to the model in the tool output, so they must be reflected in `read-cache` and session read ranges.

Recommended rule:

- Target file: require a prior read for MVP, then refresh the full snapshot when `semantic_context` reads it.
- Dependency files: do not call `checkStale` before reading, because retrieval is read-only and the model has not seen those files yet.
- Dependency files: after rendering snippets, call `recordRead` and `recordReadSession` for the exact returned line ranges.
- Do not authorize edits to unreturned parts of dependency files.

This requires adding a helper to record returned dependency line ranges, or extending `recordReadSession` calls in the tool execute method. The edit tool's existing range coverage guard then continues to protect unseen parts of dependency files.

---

## Phase 4: Tests, Validation, and Prompt Tuning

### 4.1 Unit tests

Add tests under `/Users/rhinesharar/Pi-SmartEdit/test/`.

Suggested files:

- `test/lsp-semantic-nav.test.ts`
- `test/semantic-context.test.ts`
- `test/semantic-context-renderer.test.ts`

Coverage:

- Location/LocationLink normalization.
- Document symbol flattening and enclosing-symbol lookup.
- Token extraction fallback from Tree-sitter.
- Dedupe and ranking.
- Token budget truncation.
- LSP unavailable fallback.
- Dependency file read-range recording.

### 4.2 Integration fixture

Create a small TypeScript fixture:

```text
test/fixtures/lsp-rag/
  src/service.ts
  src/types.ts
  src/repository.ts
  src/service.test.ts
  tsconfig.json
```

Fixture behavior:

- `service.ts` uses `CreateOrderInput`, `OrderRepository`, and `createOrderRepository`.
- `semantic_context` on `createOrder` should return:
  - `CreateOrderInput` interface.
  - repository factory signature.
  - one reference from `service.test.ts` when examples are enabled.

Run integration only when `typescript-language-server` is available. Otherwise assert graceful fallback.

### 4.3 Verification commands

Narrow checks:

```bash
npx tsx --test /Users/rhinesharar/Pi-SmartEdit/test/lsp.test.ts
npx tsx --test /Users/rhinesharar/Pi-SmartEdit/test/semantic-context.test.ts
```

Broad check:

```bash
npm test
```

Also run:

```bash
git diff --check
```

### 4.4 Metrics

Add lightweight metrics to `details` and tests:

- Retrieval elapsed time.
- Number of key tokens extracted.
- Number of definitions resolved.
- Number of snippets emitted.
- Estimated tokens emitted.
- Provider warnings.

Target MVP performance:

- Under 1.5s for a TypeScript function with 10-20 key tokens after LSP warmup.
- Under 3,000 rendered tokens by default.
- Zero change to edit latency unless the model calls `semantic_context`.

---

## File-by-File Change Plan

### New files

| File | Purpose |
|------|---------|
| `src/lsp/document-sync.ts` | Shared serialized document lifecycle helper. |
| `src/lsp/language-id.ts` | Shared file-extension to LSP language ID mapping. |
| `src/lsp/semantic-context.ts` | Main retrieval orchestration. |
| `src/lsp/target-range.ts` | Resolve hashline/anchor/symbol/line-range target. Optional if kept in `semantic-context.ts`. |
| `src/lsp/symbol-skeleton.ts` | Document symbol traversal and snippet extraction. |
| `src/lsp/context-renderer.ts` | Markdown rendering and token budget enforcement. |
| `test/semantic-context.test.ts` | Unit tests for retrieval behavior. |
| `test/fixtures/lsp-rag/*` | TypeScript semantic retrieval fixture. |

### Modified files

| File | Change |
|------|--------|
| `src/lsp/lsp-connection.ts` | Advertise more LSP capabilities. |
| `src/lsp/semantic-nav.ts` | Add normalized multi-location navigation wrappers and document/semantic token requests. |
| `src/lsp/lsp-manager.ts` | Improve fallback server retry when first binary starts but fails. |
| `index.ts` | Register `semantic_context`; update edit prompt guideline; use shared language ID helper. |
| `lib/types.ts` | Add shared semantic context types only if they are needed outside `src/lsp`. Prefer local types first. |
| `/Users/rhinesharar/Pi-SmartEdit/test/lsp.test.ts` | Extend mock server and wrapper tests. |

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| LSP servers require real file open/sync state | Empty/incorrect definitions | Use serialized `withOpenDocument`; test with mock and real TypeScript server. |
| Semantic token legends differ by server | Bad token classification | Store server initialize capabilities; decode with returned legend; fallback to text/AST heuristics. |
| Retrieval returns too much code | Token bloat | Hard `maxTokens`, skeleton-first rendering, omitted counts. |
| External library definitions dominate | Noise and secrets risk | Default to workspace-only definitions; hover-only for external paths. |
| Pi cannot mutate read output | No automatic pre-edit injection | MVP explicit tool; add prompt guideline. |
| First configured LSP binary fails and fallback is skipped | False `source:none` | Fix `LSPManager.getServer` retry logic in Phase 1 before retrieval depends on it. |
| Partial dependency snippets accidentally authorize broad edits | Safety regression | Record only returned line ranges for dependency files. |

---

## Implementation Order

1. Fix `LSPManager.getServer` fallback retry.
2. Capture initialize capabilities and add navigation normalization/new LSP wrappers.
3. Add serialized document sync helper.
4. Build renderer and symbol skeleton helpers with pure unit tests.
5. Implement AST-only `buildSemanticContext` fallback.
6. Add LSP-backed definitions/type definitions.
7. Add optional references and implementations.
8. Register `semantic_context` tool.
9. Add prompt guideline.
10. Add fixture integration tests.
11. Run full test suite and diff review.

This order keeps each commit useful even if LSP behavior varies across machines.

---

## Deferred Enhancements

- Automatic read-result semantic hints if ExtensionAPI supports mutation.
- `workspace/symbol` search for symbols not present in the target range.
- TypeScript direct `tsserver` fallback.
- Persistent per-session semantic cache keyed by file hash + language server version.
- Graph ranking across multi-hop symbol dependencies.
- Post-edit self-repair loop using diagnostics as a separate, explicit feature.
