# Pi-SmartEdit Phase 3 — AST-Enhanced Editing & LSP Lens Integration Plan

> **Date:** 2026-04-28
> **Status:** Planning / Design
> **Based on:** Research report in `docs/research/2026-04-28-ast-lsp-editing-research.md`
> **Target:** Expand Pi-SmartEdit from smart text editing to AST-aware, LSP-enhanced editing

---

## 1. Vision & Goals

### 1.1 Current State (Phase 2)
Pi-SmartEdit already provides a robust smart text-editing layer:
- ✅ Stale-file detection via read-cache
- ✅ Fuzzy matching with multiple fallback strategies
- ✅ Indentation normalization and preservation
- ✅ Overlap detection (static + byte-level)
- ✅ ReplaceAll support
- ✅ Atomic writes with temp-file fallback
- ✅ Write-then-edit caching
- ✅ AST resolver scaffolding (web-tree-sitter dep exists)
- ✅ Conflict detector with symbol tracking
- ✅ Rich error formatting with actionable hints
- ✅ 27 passing unit tests across 5 suites

### 1.2 Vision for Phase 3

Transform Pi-SmartEdit from a **smart text editor** into a **semantic code editor** that understands code structure, validates correctness, and provides IDE-level intelligence.

```
Phase 2: Smart Text Editor       Phase 3: Semantic Code Editor
┌──────────────────────────┐     ┌──────────────────────────────────┐
│ ✓ Exact match            │     │ ✓ All Phase 2 features           │
│ ✓ Fuzzy match            │     │ ✓ AST-validated edits            │
│ ✓ Indentation normalize  │     │ ✓ Structural search & replace    │
│ ✓ Overlap detection      │     │ ✓ Post-edit syntax validation    │
│ ✓ ReplaceAll             │     │ ✓ LSP diagnostics feedback       │
│ ✓ Atomic writes          │     │ ✓ Reference-aware editing        │
│ ✓ Stale-file guard       │     │ ✓ Multi-format input parsing     │
│ ✓ Error formatting       │     │ ✓ Scope-anchored edits           │
│                          │     │ ✓ Completion-assisted writing    │
└──────────────────────────┘     └──────────────────────────────────┘
```

### 1.3 Key Outcomes

1. **Higher edit success rate** — AST validation catches errors before write
2. **Multi-format compatibility** — Accept patches from any AI agent format
3. **IDE-level intelligence** — LSP diagnostics after every edit
4. **Structural refactoring** — ast-grep powered search & replace across codebase
5. **Graceful degradation** — Everything works without AST/LSP too

---

## 2. Architecture Overview

### 2.1 Module Map

```
src/lib/                          src/formats/          src/lsp/
├── edit-diff.ts    (existing)    ├── search-replace.ts ├── lsp-client.ts
├── read-cache.ts   (existing)    ├── unified-diff.ts   ├── diagnostics.ts
├── conflict-detector (existing)  └── openai-patch.ts   └── semantic-nav.ts
├── ast-resolver.ts (existing)
├── types.ts        (existing)
└── utils.ts        (existing)

src/
├── index.ts        (existing — entry point)
└── pipeline.ts     (NEW — multi-strategy edit pipeline)
```

### 2.2 Data Flow

```
LLM → edit(path, edits[]) ───────────────────────────────────────┐
                                                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Edit Pipeline (pipeline.ts)                                      │
│                                                                   │
│  1. FORMAT DETECTION — what format is the input?                  │
│     ├─ Search/Replace blocks  → parseSearchReplace()              │
│     ├─ Unified diff           → parseUnifiedDiff()                │
│     ├─ OpenAI patch           → parseOpenAIPatch()                │
│     └─ Raw text edits         → (current edit-diff path)          │
│                                                                   │
│  2. SCOPE RESOLUTION — where does the edit apply?                 │
│     ├─ AST anchor (symbol name) → resolveAnchorToScope()          │
│     ├─ Line range hint          → lineRangeToByteRange()          │
│     └─ No scope                 → full file search                │
│                                                                   │
│  3. EDIT APPLICATION — apply with best strategy                   │
│     ├─ AST-aware: Use ast-grep for structural patterns            │
│     ├─ Text-based: Use current edit-diff pipeline                 │
│     └─ LSP-assisted: Get diagnostics after edit                   │
│                                                                   │
│  4. POST-EDIT VALIDATION                                         │
│     ├─ AST syntax check (tree-sitter)                             │
│     ├─ LSP diagnostics check (if available)                       │
│     └─ Conflict checking (existing)                               │
│                                                                   │
│  5. FEEDBACK — structured result                                  │
│     ├─ Success: diff, match notes                                 │
│     ├─ Error: what failed, where, how to fix                      │
│     └─ Warning: LSP diagnostics detected                          │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Component Specifications

### 3.1 Multi-Format Input Parser (`src/formats/`)

#### 3.1.1 Search/Replace Block Format

**Input format** (Aider/Cline/RooCode style):
```
filename.ts
<<<<<<< SEARCH
const oldValue = "old";
=======
const newValue = "new";
>>>>>>> REPLACE
```

**Parser:**
```
parseSearchReplaceBlocks(input: string):
  ParsedEdit[]  // returns { path, oldText, newText }[]
```

**Edge cases handled:**
- Multiple blocks in one message
- Missing filename line (infer from file context)
- Nested SEARCH/REPLACE markers inside code
- Truncated blocks (error feedback)

#### 3.1.2 Unified Diff Format

**Input format:**
```
--- file.ts
+++ file.ts
@@ -10,7 +10,7 @@
 const oldValue = "old";
+const newValue = "new";
```

**Parser:**
```
parseUnifiedDiff(input: string):
  ParsedEdit[]  // unified diffs to { path, oldText, newText }
```

**Strategy:** Use `diff` library (already a dependency) to parse hunks, then convert to search/replace for the existing pipeline.

#### 3.1.3 OpenAI Patch Format

**Input format** (Codex CLI style):
```
*** Begin Patch
*** Update File: file.ts
@@ async function fetchUserData(userId) {
-  const response = await fetch(`/api/users/${userId}`);
+  const response = await fetch(`/api/users/${userId}`, { headers });
 }
*** End Patch
```

**Parser:**
```
parseOpenAIPatch(input: string):
  ParsedEdit[]
```

**Key detail:** The `@@` line is a context anchor, not a line number. Use it for fuzzy location.

#### 3.1.4 Format Auto-Detection

```typescript
function detectInputFormat(input: string): 'search_replace' | 'unified_diff' | 'openai_patch' | 'raw_edits' {
  if (input.includes('<<<<<<< SEARCH')) return 'search_replace';
  if (input.startsWith('*** Begin Patch')) return 'openai_patch';
  if (input.startsWith('--- ') && input.includes('@@ ')) return 'unified_diff';
  return 'raw_edits';
}
```

### 3.2 AST-Enhanced Editing (`src/ast/`)

#### 3.2.1 Structural Search & Replace (ast-grep)

**Integration with `@ast-grep/napi`:**

```typescript
import { SgRoot, SgNode } from '@ast-grep/napi';

// Structural search
const astGrep = new SgRoot(sourceCode, 'typescript');
const matches = astGrep.root().findAll({
  pattern: 'const $VAR = $VALUE',
});

// Structural replace
astGrep.root().replaceAll({
  pattern: 'const $VAR = $VALUE',
  replace: 'let $VAR = $VALUE',
});
```

**Use cases for Pi:**
- **Safe variable re-declaration** — `let` → `const`, `var` → `let`
- **API migration** — `oldApi()` → `newApi()`
- **Accessor conversion** — `.then()` → `await`
- **Import rewriting** — `import X from 'old'` → `import X from 'new'`

**Why ast-grep over tree-sitter directly:**
- Higher-level API (patterns vs queries)
- Built-in replacement logic
- Multi-core parallelism for batch operations
- Better error messages

#### 3.2.2 Post-Edit Syntax Validation (tree-sitter)

**Purpose:** After an edit is applied in memory but before writing to disk, validate that the resulting code is syntactically valid.

```typescript
async function validateSyntax(
  content: string,
  language: string,
): Promise<SyntaxValidationResult> {
  const parser = await getParser(language);
  if (!parser) return { valid: true, warnings: ['No parser available'] };

  const tree = parser.parse(content);
  if (tree.rootNode.hasError()) {
    // Find the error node for actionable feedback
    const errorNode = findFirstError(tree.rootNode);
    return {
      valid: false,
      error: {
        message: 'Syntax error detected after edit',
        position: errorNode.startPosition,
        context: extractContext(content, errorNode),
      },
    };
  }

  return { valid: true };
}
```

**Graceful degradation:** If no parser available for the language, skip validation.

#### 3.2.3 Scope-Aware Edit Anchoring

**Purpose:** When the LLM provides a symbol name as anchor (e.g., `function fetchUserData`), resolve it to byte offsets using tree-sitter, then narrow the search scope.

```typescript
interface AnchorScope {
  startByte: number;
  endByte: number;
  kind: string;      // 'function', 'class', 'method'
  name: string;
}

async function resolveSymbolScope(
  content: string,
  symbolName: string,
  language: string,
): Promise<AnchorScope | null> {
  const parser = await getParser(language);
  if (!parser) return null;

  const tree = parser.parse(content);
  const query = languageQuery[language]; // tree-sitter query per language

  // Find all matches for function/class declarations
  // Return the one whose name matches symbolName
}
```

### 3.3 LSP Lens Integration (`src/lsp/`)

#### 3.3.1 LSP Client Manager

**Design:**
- **Lazy initialization** — Language servers are started on-demand when first needed for a file type
- **Connection pooling** — One server instance per language, shared across all edits
- **Stdio communication** — JSON-RPC over stdin/stdout (no network)
- **Timeout handling** — 5s timeout for all LSP operations
- **Graceful degradation** — If LSP server fails, fall back to non-LSP editing

```typescript
class LSPManager {
  private servers = new Map<string, LanguageServerConnection>();
  private serverBinaries: Record<string, { command: string; args: string[] }> = {
    typescript: { command: 'typescript-language-server', args: ['--stdio'] },
    // More language servers registered on-demand
  };

  async getServer(language: string): Promise<LanguageServerConnection | null> {
    if (this.servers.has(language)) return this.servers.get(language)!;

    const config = this.serverBinaries[language];
    if (!config) return null; // No server available

    const server = await this.startServer(config.command, config.args);
    this.servers.set(language, server);
    return server;
  }

  private async startServer(command: string, args: string[]) {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const connection = new LanguageServerConnection(proc);

    // Initialize session
    await connection.request('initialize', {
      processId: process.pid,
      capabilities: {
        textDocument: {
          diagnostic: { dynamicRegistration: true },
          definition: { dynamicRegistration: true },
          references: { dynamicRegistration: true },
        },
      },
    });
    await connection.notify('initialized', {});

    return connection;
  }

  async shutdown(): Promise<void> {
    for (const [lang, server] of this.servers) {
      await server.shutdown();
      server.exit();
    }
    this.servers.clear();
  }
}
```

#### 3.3.2 Post-Edit Diagnostics Hook

**Purpose:** After every successful edit, check for LSP diagnostics and report them back.

```typescript
async function checkPostEditDiagnostics(
  filePath: string,
  content: string,
  language: string,
): Promise<DiagnosticResult> {
  const server = await lspManager.getServer(language);
  if (!server) return { diagnostics: [], source: 'none' };

  const uri = `file://${resolve(filePath)}`;

  // Open document
  await server.notify('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: language,
      version: 1,
      text: content,
    },
  });

  // Wait for diagnostics response
  const diagnostics = await waitForDiagnostics(server, 2000);

  return {
    diagnostics: diagnostics.map(d => ({
      message: d.message,
      severity: d.severity, // 1=error, 2=warning, 3=info, 4=hint
      range: d.range,
      source: d.source,
    })),
    source: 'lsp',
  };
}
```

**Integrates with edit feedback:**
```typescript
const result = await applyEdits(...);
const diagnostics = await checkPostEditDiagnostics(path, result.newContent, language);

if (diagnostics.diagnostics.length > 0) {
  const errors = diagnostics.diagnostics.filter(d => d.severity === 1);
  if (errors.length > 0) {
    // Include in match notes as warnings
    result.matchNotes.push(
      `⚠ LSP detected ${errors.length} error(s) after edit: ` +
      errors.map(e => e.message).join('; ')
    );
  }
}
```

#### 3.3.3 Semantic Navigation Tools

**Go to Definition** — Resolve a symbol at cursor to its definition location.

```typescript
async function goToDefinition(
  filePath: string,
  line: number,
  character: number,
): Promise<Location | null> {
  const server = await lspManager.getServer(detectLanguage(filePath));
  if (!server) return null;

  const response = await server.request('textDocument/definition', {
    textDocument: { uri: `file://${resolve(filePath)}` },
    position: { line, character },
  });

  return response; // { uri, range: { start, end } }
}
```

**Find References** — Find all references to a symbol.

```typescript
async function findReferences(
  filePath: string,
  line: number,
  character: number,
): Promise<Location[]> {
  const server = await lspManager.getServer(detectLanguage(filePath));
  if (!server) return [];

  const response = await server.request('textDocument/references', {
    textDocument: { uri: `file://${resolve(filePath)}` },
    position: { line, character },
    context: { includeDeclaration: true },
  });

  return response;
}
```

#### 3.3.4 Completion-Enhanced Writing

**LSP completions for new code generation:**
When Pi writes new code, query LSP for completions to ensure:
- Import paths are correct
- Method signatures match
- No undefined variables

```typescript
async function getCompletions(
  filePath: string,
  content: string,
  position: { line: number; character: number },
): Promise<CompletionItem[]> {
  const server = await lspManager.getServer(detectLanguage(filePath));
  if (!server) return [];

  const response = await server.request('textDocument/completion', {
    textDocument: { uri: `file://${resolve(filePath)}` },
    position,
    context: { triggerKind: 1 }, // Invoked
  });

  return response;
}
```

### 3.4 Conflict Detector Enhancements

The existing `conflict-detector.ts` already tracks edit history. Enhance it with:

1. **LSP-aware conflict detection** — Before editing, use LSP to check if the symbol was modified elsewhere
2. **Scope overlap** — Use tree-sitter to determine if two edits touch the same function
3. **Edit chain tracking** — Record sequence of edits to same file for undo support

---

## 4. Integration Plan

### 4.1 Dependencies

**New dependencies to add to `package.json`:**

```json
{
  "dependencies": {
    "@ast-grep/napi": "^0.42.1",
    "magic-string": "^0.30.21",
    "fast-glob": "^3.3.3"
  },
  "optionalDependencies": {
    "typescript-language-server": "^5.1.0",
    "@vtsls/language-server": "^0.2.0"
  },
  "devDependencies": {
    "@types/diff": "^7.0.0"
  }
}
```

**No new runtime dependencies for LSP:**
The LSP client communicates via Node.js `child_process` stdio — no npm package needed.

### 4.2 Implementation Phases

#### Phase 3.1: Multi-Format Input Parser (Week 1)
- Implement format detection in `pipeline.ts`
- Implement `src/formats/search-replace.ts` — Aider/Cline/RooCode format
- Implement `src/formats/unified-diff.ts` — standard diff format
- Implement `src/formats/openai-patch.ts` — Codex CLI format
- Unit tests for each format parser
- Integration test: feed all three formats, verify correct parsing

#### Phase 3.2: AST-Enhanced Editing (Week 2)
- Implement `src/ast/ast-grep.ts` — structural search & replace
- Implement `src/ast/validator.ts` — post-edit syntax validation via tree-sitter
- Implement `src/ast/scope.ts` — scope-aware edit anchoring
- Enhance `edit-diff.ts` to accept AST scope hints
- Unit tests for each AST component
- Integration test: edit with AST validation, verify syntax errors caught

#### Phase 3.3: LSP Lens Integration (Week 3)
- Implement `src/lsp/lsp-client.ts` — LSP server lifecycle management
- Implement `src/lsp/diagnostics.ts` — post-edit diagnostic checking
- Implement `src/lsp/semantic-nav.ts` — go-to-def, find-refs
- Wire diagnostics feedback into edit results
- Unit tests with mock LSP server
- Integration test: real TypeScript LSP server, verify diagnostics

#### Phase 3.4: Pipeline Integration & Polish (Week 4)
- Wire all components into `pipeline.ts`
- Implement graceful degradation cascade
- Performance benchmarking
- Documentation update
- Full test suite run and edge case testing

### 4.3 Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| @ast-grep/napi native bindings fail | AST features unavailable | Graceful degradation to text-only |
| LSP server not found in PATH | LSP features unavailable | Graceful degradation, info log |
| tree-sitter grammar not installed | Syntax validation skipped | Graceful degradation per language |
| Large file parsing slows edits | Latency spikes | Timeout + content-length guard |
| LSP server memory usage | Agent resource pressure | One server per session, shutdown on session_end |
| Conflicting edit formats | Wrong parsing | Format auto-detection with explicit override |

---

## 5. Key Design Decisions

### 5.1 Format Conversion Strategy

**Decision:** Convert all input formats to the existing `EditItem[]` (oldText + newText) format at the pipeline boundary.

**Rationale:**
- Existing `applyEdits()` in `edit-diff.ts` handles matching, replacement, indentation
- Avoids duplicating edit logic across format backends
- Each format parser is a thin translation layer
- Existing fuzzy matching and overlap detection apply universally

### 5.2 Lazy LSP Initialization

**Decision:** Start LSP servers lazily on first edit to a file of that language, and shut down on session end.

**Rationale:**
- No startup overhead for projects without a given language
- Graceful degradation when LSP isn't installed
- Resource cleanup prevents memory leaks in long sessions
- Matches existing lazy-init pattern of `astResolver` and `conflictDetector`

### 5.3 AST Validation as Advisory, Not Blocking

**Decision:** AST validation and LSP diagnostics are advisory — they generate warnings but don't block the edit.

**Rationale:**
- LLM may intentionally generate code that's incomplete mid-stream
- Blocking on warnings would create friction
- The agent should decide whether warnings matter
- Error feedback is more useful as information than as a gate

### 5.4 Source Maps for Debugging

**Decision:** Use `magic-string` for all multi-edit operations that need position tracking.

**Rationale:**
- When multiple edits in the same file shift lines, source maps track original positions
- Critical for LSP integration — LSP positions are relative to original file
- Lightweight enough for hot-path editing

---

## 6. Testing Strategy

### 6.1 Unit Tests

| Component | Tests | Key Cases |
|-----------|-------|-----------|
| `formats/search-replace.ts` | 8+ | Valid block, nested markers, missing filename, truncated block |
| `formats/unified-diff.ts` | 6+ | Single hunk, multi-hunk, no-op hunk, malformed format |
| `formats/openai-patch.ts` | 6+ | Single update, multi-file, add file, delete file |
| `ast/validator.ts` | 8+ | Valid code, invalid code, unsupported language, parse error |
| `ast/scope.ts` | 6+ | Function scope, class scope, nested scope, no match |
| `ast/ast-grep.ts` | 8+ | Simple pattern, multi-pattern, replace-all, no match |
| `lsp/lsp-client.ts` | 6+ | Server start, init, request, notification, shutdown, timeout |
| `lsp/diagnostics.ts` | 6+ | No diagnostics, errors, warnings, no LSP server |
| `pipeline.ts` | 10+ | All formats, AST validation, LSP diag, fallback chain |

**Total new tests:** ~64+

### 6.2 Integration Tests

- **Format round-trip:** Feed each format → parse → apply → verify output
- **AST validation cascade:** Edit code → break syntax → verify warning
- **LSP diagnostics cascade:** Edit code → cause type error → verify warning
- **Full pipeline:** Multi-format + AST + LSP together

### 6.3 Test Fixtures

```
test/fixtures/
├── formats/
│   ├── search-replace-block.txt        # Valid SEARCH/REPLACE
│   ├── search-replace-multiple.txt     # Multiple blocks
│   ├── unified-diff.txt                # Standard diff
│   ├── openai-patch.txt                # OpenAI patch format
│   └── invalid-formats.txt             # Malformed inputs
├── ast/
│   ├── valid-function.ts               # Syntactically valid
│   ├── invalid-syntax.ts               # Syntax error
│   ├── scope-test.ts                   # Multiple scopes
│   └── unknown-language.xyz            # No parser available
└── lsp/
    ├── type-error.ts                   # Has type error
    └── clean-code.ts                   # No diagnostics
```

---

## 7. Success Metrics

| Metric | Current (Phase 2) | Target (Phase 3) |
|--------|-------------------|-------------------|
| Edit success rate | ~85-90% (estimated) | >95% |
| Supported input formats | 1 (raw edits) | 4 (raw + 3 standard formats) |
| Languages with AST validation | 0 | 5+ (JS, TS, Python, Rust, Go) |
| Post-edit error detection | None | LSP diagnostics |
| Structural refactoring | None | ast-grep powered |
| Test count | 27 | 91+ |

---

## 8. Timeline & Milestones

```
Week 1: Multi-Format Input
├─ Mon-Tue: Format detection + search/replace parser
├─ Wed-Thu: Unified diff + OpenAI patch parsers
└─ Fri: Tests + integration into pipeline

Week 2: AST-Enhanced Editing  
├─ Mon-Tue: @ast-grep/napi integration
├─ Wed-Thu: Post-edit syntax validation
└─ Fri: Scope anchoring + tests

Week 3: LSP Lens Integration
├─ Mon-Tue: LSP client manager
├─ Wed-Thu: Diagnostics hook + semantic nav
└─ Fri: Integration tests + edge cases

Week 4: Pipeline & Polish
├─ Mon-Tue: Wire everything into pipeline.ts
├─ Wed: Performance tuning + grace degradation
├─ Thu: Documentation update
└─ Fri: Full test suite + release prep
```

---

## 9. Open Questions

1. **ast-grep grammar setup** — Should Pi-SmartEdit bundle tree-sitter grammars for common languages, or rely on the user having them installed?
   - *Current thinking:* Lazy-download grammars on first use (like tree-sitter's `loadLanguage`)

2. **LSP server discovery** — How should Pi-SmartEdit find LSP servers? Config file, PATH scanning, or explicit registration?
   - *Current thinking:* PATH scanning first, with optional config file override

3. **Concurrent LSP requests** — Should LSP operations queue per server or run in parallel?
   - *Current thinking:* Per-server queue to respect single-threaded language servers

4. **Edit undo support** — Should Phase 3 add undo/rollback capability?
   - *Current thinking:* Out of scope for Phase 3, add to Phase 4

---

## 10. References

### Internal
- [Research Report](docs/research/2026-04-28-ast-lsp-editing-research.md) — Comprehensive research findings
- Current source: `.pi/extensions/smart-edit/`

### External
- [ast-grep Documentation](https://ast-grep.github.io/) — Pattern syntax and API
- [Tree-sitter Using Parsers](https://tree-sitter.github.io/tree-sitter/using-parsers/) — Parser API
- [LSP Specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) — Protocol details
- [Code Surgery Blog Post](https://fabianhertwig.com/blog/coding-assistants-file-edits/) — AI editing patterns
- [OpenAI Codex Patch Format](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) — Patch format reference
