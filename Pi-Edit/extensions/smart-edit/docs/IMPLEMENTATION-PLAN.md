# Smart Edit — Feature Implementation Plan

## Overview

Three features to add to the `smart-edit` Pi extension:

| # | Feature | Priority | Complexity |
|---|---------|----------|------------|
| 1 | **AST-Aware Targeting (Tree-sitter)** | P0 | High |
| 2 | **Semantic Conflict Detection** | P0 | Medium |
| 3 | **Line-Range Targeting** | P1 | Low |

These features address the core limitation of text-only `oldText` matching: when two functions have identical opening lines, the tool cannot distinguish them; when separate edits touch the same function body over multiple calls, there's no detection; and there's no fallback when `oldText` matching fails beyond fuzzy tiers.

---

## Architecture Decision Records

### ADR-001: Tree-sitter via WASM (web-tree-sitter)

**Status**: Proposed

**Context**: We need to parse source code into an AST for disambiguation and conflict detection. Tree-sitter is the de-facto standard for incremental parsing in editors (used by Zed, Neovim, Helix). It produces concrete syntax trees (CST) that preserve byte positions for every token.

**Options considered**:
1. **`tree-sitter` (native Node)** — Fast, requires native compilation (node-gyp). Adds a native dependency that may fail to install on some Pi environments.
2. **`web-tree-sitter` (WASM)** — Pure WASM, no native compilation. ~10x slower than native but still sub-ms for typical source files. Works everywhere Node runs.
3. **Language Server Protocol** — Connect to an LSP server for semantic info. Adds an external process dependency. Overkill for our needs.
4. **Regex-based heuristics** — Fast but unreliable for nested structures. Already partially what we do (line-by-line indentation detection).

**Decision**: Use `web-tree-sitter` (WASM) for Phase 1. It's zero-native-dep, works in any Node 18+ environment, and parsing a 10K-line file takes <5ms. If performance becomes a concern for very large files (>50K lines), we can add a `tree-sitter` (native) fallback.

**Consequences**:
- +Zero native build complexity
- +Works in sandboxed/restricted environments
- +Sub-ms parse time for files under 10K lines
- -Slightly slower than native for very large files
- -WASM binary adds ~1.2MB to extension package

### ADR-002: Lazy Grammar Loading

**Status**: Proposed

**Context**: Tree-sitter requires language-specific grammars. We can't bundle all languages.

**Decision**: Lazy-load grammars on-demand. When an edit targets a `.ts` file, load `tree-sitter-typescript` if not already cached. Grammar WASM files are ~200-500KB each and are cached in memory after first load. Unsupported file extensions gracefully fall back to text-only matching (current behavior).

**Consequences**:
- +No upfront cost for unused languages
- +Graceful degradation for unsupported languages
- -First edit per language has ~50ms grammar load penalty
- -Need to manage grammar lifecycle (cache eviction, version mismatches)

### ADR-003: Edit Operation Model

**Status**: Proposed

**Context**: Currently, `EditItem` uses `{oldText, newText}` text matching. We're adding AST-level anchoring and line-range targeting as *disambiguation hints*, not as replacements for text matching. This preserves backward compatibility.

**Decision**: Extend `EditItem` with optional fields:
```typescript
interface EditItem {
  oldText: string;        // REQUIRED: always present for verification
  newText: string;        // REQUIRED: replacement text
  replaceAll?: boolean;
  description?: string;
  // NEW Fields:
  anchor?: EditAnchor;    // AST-based disambiguation hint
  lineRange?: LineRange;  // Line-based disambiguation hint
}
```

If `anchor` or `lineRange` is provided, they **narrow the search scope** within which `oldText` must match. If neither is provided, behavior is identical to current (whole-file search).

**Consequences**:
- +100% backward compatible — existing edits work unchanged
- +Progressive enhancement — LLM can provide hints when it knows them
- +Graceful fallback — if AST parse fails, fall back to text-only
- -New parameters increase schema complexity (mitigated by Optionals)

---

## Implementation Phases

### Phase 1: AST-Aware Targeting (Weeks 1-3)

See [docs/FEATURE-AST-TARGETING.md](./FEATURE-AST-TARGETING.md) for full design.

### Phase 2: Semantic Conflict Detection (Weeks 3-5)

See [docs/FEATURE-CONFLICT-DETECTION.md](./FEATURE-CONFLICT-DETECTION.md) for full design.

### Phase 3: Line-Range Targeting (Weeks 5-6)

See [docs/FEATURE-LINE-RANGE.md](./FEATURE-LINE-RANGE.md) for full design.

---

## Research Sources

### Primary References

| Source | Key Insight |
|--------|-------------|
| **Zed Blog: Syntax-Aware Editing** (Max Brunsfeld, tree-sitter creator) | Tree-sitter produces concrete syntax trees preserving byte positions. Queries enable pattern matching against AST structure. Incremental parsing enables efficient re-parse after edits. |
| **Serena MCP Toolkit** (oraios/serena) | Symbolic editing via LSP: `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`, `safe_delete`. Uses language server protocol for semantic understanding. |
| **Kiro Blog: Refactoring Made Right** | Semantic rename via VSCode's `prepareRename` + `executeDocumentRenameProvider`. Language servers handle cross-file refactoring. Key insight: "refactoring demands precision over plausibility." |
| **Fabian Hertwig: Code Surgery** | Comprehensive survey of Codex, Aider, OpenHands, RooCode, Cursor edit strategies. Key insight: "This handoff between the LLM's representation and the file system state is a frequent source of complications." |
| **node-tree-sitter** | Node.js bindings. v0.25. API: `Parser`, `Language`, `Tree`, `Node`, `Query`. Key methods: `parser.parse(input)`, `tree.rootNode`, `node.childForFieldName()`, `query.matches()`. |
| **web-tree-sitter v0.26.8** | WASM-based tree-sitter bindings. Works in any JS runtime. API mirrors native bindings. |

### Edit Tool Comparisons

| Tool | Matching Strategy | Disambiguation | Conflict Detection |
|------|-------------------|----------------|-------------------|
| **Pi smart-edit (current)** | 4-tier: exact → indentation → unicode → similarity | `replaceAll` flag only | Byte-overlap detection within single call |
| **Claude text_editor** | `str_replace` (exact) + `insert` (line-based) | Line numbers via `view_range` | Read-before-write guard |
| **Aider** | 4-layer: exact → whitespace-insensitive → indentation-preserving → difflib fuzzy | Search/Replace blocks | Per-block failure reporting |
| **Codex CLI** | 3-layer: exact → trimmed-line-endings → trimmed-whitespace | `@@` context anchors | Context-line mismatch error |
| **RooCode** | Middle-out fuzzy (Levenshtein distance) | Start line hint in SEARCH block | User approval step |
| **Serena** | LSP-based symbolic lookup | Symbol name + kind | Language server cross-reference |