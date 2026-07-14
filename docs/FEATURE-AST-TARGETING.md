# Feature: AST-Aware Targeting via Tree-sitter

## Problem Statement

When two functions have identical opening lines, `oldText` substring matching cannot distinguish between them. For example:

```typescript
function handleRequest(req: Request) {
  // 50 lines of handler A
}

function handleRequest(req: Request) {
  // 50 lines of handler B (different overload/namespace)
}
```

`findText("function handleRequest(req: Request) {")` returns the first occurrence, and the ambiguous-match error fires. The LLM is forced to include large context blocks to disambiguate, wasting tokens and still risking mismatches on near-identical code.

## Solution

Integrate Tree-sitter (via `web-tree-sitter`) to parse source files into a concrete syntax tree. When an `oldText` match is ambiguous (multiple matches), use the AST to disambiguate by:

1. **Anchoring**: Let the LLM specify which *named* AST node the edit targets (e.g., "the `handleRequest` function on line 120").
2. **Scope narrowing**: Find all candidate text matches, then filter to those within the specified AST node's byte range.
3. **Node-aware diagnostics**: In ambiguous-match errors, report *which symbols* contain the matches (e.g., "Found matches in `handleRequest` (line 10) and `handleRequest` (line 85)").

## API Design

### Extended EditItem Schema

```typescript
interface EditAnchor {
  /** Name of the enclosing AST node that contains the edit target.
   *  Example: "handleRequest", "MyClass", "processOrder"
   *  Used to narrow which match of an ambiguous oldText is intended.
   */
  symbolName?: string;

  /** Kind of AST node to match against.
   *  If provided, only nodes of this kind are considered.
   *  Example: "function_declaration", "class_definition", "method_definition"
   */
  symbolKind?: string;

  /** 1-based line number hint for the start of the symbol.
   *  Used as an additional disambiguator when symbolName alone is ambiguous.
   *  Not exact — the parser verifies the symbol actually starts near this line.
   */
  symbolLine?: number;
}

interface EditItem {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  description?: string;

  /** AST-based disambiguation hint. If provided, oldText must match
   *  within the byte range of the described AST node. */
  anchor?: EditAnchor;
}
```

### Example Usage

```json
{
  "path": "src/handlers.ts",
  "edits": [
    {
      "oldText": "function handleRequest(req: Request) {\n  return",
      "newText": "function handleRequest(req: Request) {\n  const result = await process(req);\n  return",
      "anchor": {
        "symbolName": "handleRequest",
        "symbolLine": 85
      }
    }
  ]
}
```

## Implementation Architecture

### New Module: `lib/ast-resolver.ts`

```
┌──────────────────────────────────────────────────────┐
│                    ast-resolver.ts                    │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ASTResolver                                         │
│  ├── grammarCache: Map<string, Language>              │
│  ├── parser: Parser                                  │
│  ├── parseFile(content, filePath) → ParseResult       │
│  ├── findSymbolNode(tree, anchor) → Node | null      │
│  ├── getNodeByteRange(node) → {start, end}           │
│  ├── getNodeLineRange(node) → {startLine, endLine}   │
│  ├── findEnclosingSymbolAtLine(tree, line) → Node     │
│  └── getSymbolName(node) → string                    │
│                                                      │
│  GrammarLoader                                       │
│  ├── loadGrammar(ext: string) → Language | null       │
│  ├── getSupportedExtensions() → string[]             │
│  └── preloadGrammars(extensions: string[]) → void    │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Key Design Decisions

#### 1. Lazy Grammar Loading

Grammars are loaded on first use and cached. Supported file extensions and their grammar mappings:

```typescript
const GRAMMAR_MAP: Record<string, string> = {
  '.ts': 'tree-sitter-typescript',
  '.tsx': 'tree-sitter-typescript',
  '.js': 'tree-sitter-javascript',
  '.jsx': 'tree-sitter-javascript',
  '.py': 'tree-sitter-python',
  '.rs': 'tree-sitter-rust',
  '.go': 'tree-sitter-go',
  '.java': 'tree-sitter-java',
  '.c': 'tree-sitter-c',
  '.cpp': 'tree-sitter-cpp',
  '.h': 'tree-sitter-c',
  '.hpp': 'tree-sitter-cpp',
  '.rb': 'tree-sitter-ruby',
  '.json': 'tree-sitter-json',
  '.yaml': 'tree-sitter-yaml',
  '.yml': 'tree-sitter-yaml',
  '.html': 'tree-sitter-html',
  '.css': 'tree-sitter-css',
};
```

Unsupported extensions gracefully skip AST resolution and fall back to current text-only behavior.

#### 2. Symbol Lookup Strategy

When `anchor.symbolName` is provided:

```
1. Parse file → CST
2. Walk tree for named nodes matching symbolName
   - If symbolKind provided, filter to matching node types
   - If symbolLine provided, prefer the node starting closest to that line
   - If multiple matches remain, pick the first (and emit a matchNote)
3. Get byte range of resolved node → [nodeStartByte, nodeEndByte]
4. Restrict oldText search to content within [nodeStartByte, nodeEndByte]
5. If oldText STILL matches multiple times within the node:
   - Report as ambiguous with improved diagnostics
```

#### 3. Tree-sitter Query Pattern for Symbol Discovery

Rather than naive tree walking, use Tree-sitter queries for efficiency:

```typescript
// TypeScript example: find function declarations matching a name
const query = `
  (function_declaration name: (identifier) @name) @node
  (method_definition name: (property_identifier) @name) @node
  (class_declaration name: (type_identifier) @name) @node
  (variable_declarator name: (identifier) @name value: (arrow_function)) @node
  (variable_declarator name: (identifier) @name value: (function_expression)) @node
`;
```

This is language-specific. For a v1, we can use simpler `node.walk()` with name comparison for robustness across grammars.

#### 4. Incremental Parsing Support

Tree-sitter supports incremental re-parsing via `tree.edit(editInfo)`. For Phase 1, we parse fresh each time (sub-ms for typical files). Phase 2+ can add incremental re-parsing by keeping the `Tree` object around and invalidating on file change.

### Integration Point in edit-diff.ts

The disambiguation logic is inserted between Phase 1 (find matches) and Phase 2 (overlap check) in `applyEdits()`:

```typescript
// Current flow:
// 1. For each edit, findText() to get MatchResult
// 2. Check overlaps
// 3. Apply replacements in reverse

// New flow:
// 1. Parse file (if any edit has an anchor, or file has ambiguity)
// 2. For each edit:
//    a. findText() to get all possible MatchResults
//    b. If anchor provided, resolve to AST node → filter matches within node range
//    c. If no anchor but multiple matches, use AST to produce better diagnostics
// 3. Check overlaps (enhanced with AST node boundaries)
// 4. Apply replacements in reverse
```

## Enhanced Ambiguity Diagnostics

When `findText()` finds multiple matches and no `anchor` is provided, the current `getAmbiguousError()` just says "'X' appears N times". With AST awareness:

```typescript
function getAmbiguousError(
  path: string,
  oldText: string,
  matches: Array<{index: number; line: number; enclosingSymbol?: string; symbolKind?: string}>,
): string {
  const matchDescriptions = matches.map((m, i) => {
    let desc = `Match ${i + 1} at line ${m.line}`;
    if (m.enclosingSymbol) {
      desc += ` inside ${m.symbolKind || 'symbol'} "${m.enclosingSymbol}"`;
    }
    return desc;
  });

  return [
    `edits[].oldText is ambiguous in ${path} — ${matches.length} matches found:`,
    ...matchDescriptions,
    '',
    'Use the "anchor" field to specify which symbol contains your edit target.',
    'Example: { "oldText": "...", "newText": "...", "anchor": { "symbolName": "MyFunction" } }',
  ].join('\n');
}
```

## Performance Considerations

| File Size | Parse Time (WASM) | Parse Time (Native) | Walk Time | Memory |
|-----------|-------------------|---------------------|-----------|--------|
| 1K lines  | ~1ms              | ~0.1ms              | ~0.05ms   | ~500KB |
| 10K lines | ~8ms              | ~0.8ms              | ~0.3ms    | ~5MB   |
| 50K lines | ~40ms             | ~4ms                | ~1ms      | ~25MB  |

For files >50K lines, we skip AST parsing and fall back to text-only matching. The extension already reads file content; parsing adds minimal overhead.

## Testing Strategy

### Unit Tests

1. **Ambiguity resolution**: File with two functions having identical signatures → anchor resolves to correct one
2. **Symbol kind filtering**: `symbolKind: "class_declaration"` filters out method with same name
3. **Line hint**: `symbolLine: 85` selects the function at line 85 over one at line 10
4. **Graceful fallback**: Unsupported file extension → skip AST, behavior identical to current
5. **Parse failure**: Malformed file → catch parse error, fall back to text matching
6. **Cross-language**: `.ts`, `.py`, `.rs` files all produce correct symbol scopes

### Integration Tests

1. **End-to-end ambiguous edit**: Provide anchor, verify correct function body is modified
2. **Anchor + replaceAll**: Anchor constrains replaceAll to symbol scope only
3. **Anchor mismatch**: Anchor symbol doesn't exist → helpful error with available symbols
4. **Concurrent edits**: Two edits with different anchors to same file both apply correctly

## Dependencies

```json
{
  "dependencies": {
    "diff": "^7.0.0",
    "web-tree-sitter": "^0.26.8"
  },
  "optionalDependencies": {
    "tree-sitter-typescript": "^0.23.2",
    "tree-sitter-python": "^0.23.4",
    "tree-sitter-rust": "^0.24.0",
    "tree-sitter-go": "^0.23.4",
    "tree-sitter-java": "^0.23.5",
    "tree-sitter-json": "^0.24.8",
    "tree-sitter-c": "^0.23.4",
    "tree-sitter-cpp": "^0.23.4",
    "tree-sitter-ruby": "^0.23.1",
    "tree-sitter-html": "^0.23.2",
    "tree-sitter-css": "^0.23.2",
    "tree-sitter-yaml": "^0.7.1"
  }
}
```

Grammars are optional — the extension works without them, just without AST features.

## File Structure

```
smart-edit/
├── index.ts                    # Updated: wire anchor into edit pipeline
├── lib/
│   ├── edit-diff.ts            # Updated: ast-aware disambiguation in applyEdits
│   ├── types.ts                # Updated: EditAnchor, extended EditItem
│   ├── read-cache.ts           # Unchanged
│   ├── path-utils.ts           # Unchanged
│   ├── ast-resolver.ts         # NEW: Tree-sitter parse + symbol lookup
│   └── grammar-loader.ts       # NEW: Lazy grammar loading + caching
├── grammars/                   # NEW: Pre-built .wasm grammar files
│   └── (loaded at runtime)
├── test/
│   ├── edit-diff.test.ts       # Updated: AST disambiguation tests
│   ├── ast-resolver.test.ts    # NEW: Parse and symbol lookup tests
│   └── grammar-loader.test.ts  # NEW: Grammar loading tests
├── docs/
│   ├── IMPLEMENTATION-PLAN.md
│   ├── FEATURE-AST-TARGETING.md
│   ├── FEATURE-CONFLICT-DETECTION.md
│   └── FEATURE-LINE-RANGE.md
└── package.json
```

## References

- **Zed Blog**: Tree-sitter produces concrete syntax trees preserving byte positions. Queries enable pattern matching against AST structure. Incremental parsing enables efficient re-parse after edits.
- **Serena MCP**: Symbolic editing via `replace_symbol_body`, `insert_after_symbol` — validates that LSP-based symbol operations are the right abstraction level.
- **node-tree-sitter**: Node.js API: `Parser.parse()`, `Tree.rootNode`, `Node.childForFieldName()`, `Query`.
- **web-tree-sitter**: WASM variant with identical API surface, zero native deps.