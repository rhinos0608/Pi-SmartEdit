# Smart Edit — Feature Implementation Plan (Archive)

> **Original Status**: ✅ All three features implemented (May 2026)
> **Document purpose**: Historical record of the planning phase. The features described below have all shipped, along with additional features from subsequent sprints.

The original plan scoped three features. All were completed, followed by a second wave of features based on Codex pattern analysis (see [codex-borrowed-patterns.md](./codex-borrowed-patterns.md)).

## What was built

### Wave 1 (Original Plan)

1. **AST-Aware Targeting (Tree-sitter)** — P0, High complexity
   - Tree-sitter WASM parsing via `web-tree-sitter`
   - Lazy grammar loading
   - Symbol lookup (name, kind, line hint)
   - Anchor-based disambiguation
   - Incremental re-parse with LRU parse cache

2. **Semantic Conflict Detection** — P0, Medium complexity
   - Same-symbol, contains, contained-by, sibling-overlap conflict detection
   - Per-file baseline capture
   - Configurable on-conflict behavior (warn/error)

   > **Historical note:** The cross-call semantic conflict detector was later removed as dead code (see `src/index.ts`). Only intra-request byte-overlap protection remains.

3. **Line-Range Targeting** — P1, Low complexity
   - Read-range coverage validation
   - Edit range scoping for hashline, symbolic, and legacy edits

### Wave 2 (Codex-inspired, see codex-borrowed-patterns.md)

4. **Codex apply_patch grammar parser** — `src/formats/codex-patch.ts`
5. **Multi-level `@@` hunk disambiguation** — built into codex-patch parser
6. **Streaming patch preview** — `src/formats/streaming-patch-parser.ts`
7. **Context marker tags** — `src/formats/context-markers.ts`
8. **Edit history / undo** — `src/undo/edit-history.ts`
9. **Approval gating** — `src/safety/approval-gating.ts`
10. **Multi-file atomic patches** — `src/formats/atomic-patch.ts`
11. **Forgiving JSON parser** — `src/formats/forgiving-parser.ts`
12. **Verification pipeline** — concurrency detection, traceability, history context, repair loop
13. **Scoped diagnostics + auto-validation** — filter diagnostics to changed targets
14. **SmartRead bridge** — breakage and co-change event recording

---

## Architecture Decision Records (Historical)

### ADR-001: Tree-sitter via WASM (web-tree-sitter)

**Status**: Accepted (May 2026)

**Context**: We need to parse source code into an AST for disambiguation and conflict detection. Tree-sitter is the de-facto standard for incremental parsing in editors (used by Zed, Neovim, Helix). It produces concrete syntax trees (CST) that preserve byte positions for every token.

**Options considered**:
1. **`tree-sitter` (native Node)** — Fast, requires native compilation (node-gyp). Adds a native dependency that may fail to install on some Pi environments.
2. **`web-tree-sitter` (WASM)** — Pure WASM, no native compilation. ~10x slower than native but still sub-ms for typical source files. Works everywhere Node runs.
3. **Language Server Protocol** — Connect to an LSP server for semantic info. Adds an external process dependency. Overkill for our needs.
4. **Regex-based heuristics** — Fast but unreliable for nested structures. Already partially what we do (line-by-line indentation detection).

**Decision**: Use `web-tree-sitter` (WASM). It's zero-native-dep, works in any Node 18+ environment, and parsing a 10K-line file takes <5ms.

**Consequences**:
- +Zero native build complexity
- +Works in sandboxed/restricted environments
- +Sub-ms parse time for files under 10K lines
- -Slightly slower than native for very large files
- -WASM binary adds ~1.2MB to extension package

### ADR-002: Lazy Grammar Loading

**Status**: Accepted

**Context**: Tree-sitter requires language-specific grammars. We can't bundle all languages.

**Decision**: Lazy-load grammars on-demand. When an edit targets a `.ts` file, load `tree-sitter-typescript` if not already cached. Grammar WASM files are ~200-500KB each and are cached in memory after first load. Unsupported file extensions gracefully fall back to text-only matching (current behavior).

**Consequences**:
- +No upfront cost for unused languages
- +Graceful degradation for unsupported languages
- -First edit per language has ~50ms grammar load penalty
- -Need to manage grammar lifecycle (cache eviction, version mismatches)

### ADR-003: Edit Operation Model

**Status**: Accepted

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

## Research Sources (Archive)

### Primary References

| Source | Key Insight |
|---|---|
| **Zed Blog: Syntax-Aware Editing** (Max Brunsfeld, tree-sitter creator) | Tree-sitter produces concrete syntax trees preserving byte positions. Queries enable pattern matching against AST structure. Incremental parsing enables efficient re-parse after edits. |
| **Serena MCP Toolkit** (oraios/serena) | Symbolic editing via LSP: `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`, `safe_delete`. Uses language server protocol for semantic understanding. |
| **Kiro Blog: Refactoring Made Right** | Semantic rename via VSCode's `prepareRename` + `executeDocumentRenameProvider`. Language servers handle cross-file refactoring. Key insight: "refactoring demands precision over plausibility." |
| **Fabian Hertwig: Code Surgery** | Comprehensive survey of Codex, Aider, OpenHands, RooCode, Cursor edit strategies. Key insight: "This handoff between the LLM's representation and the file system state is a frequent source of complications." |
| **node-tree-sitter** | Node.js bindings. v0.25. API: `Parser`, `Language`, `Tree`, `Node`, `Query`. Key methods: `parser.parse(input)`, `tree.rootNode`, `node.childForFieldName()`, `query.matches()`. |
| **web-tree-sitter v0.26.8** | WASM-based tree-sitter bindings. Works in any JS runtime. API mirrors native bindings. |

### Edit Tool Comparisons

| Tool | Matching Strategy | Disambiguation | Conflict Detection |
|---|---|---|---|
| **Pi smart-edit (current)** | 6-tier: exact → indentation → unicode → similarity → dotdotdots → relative indent + symbolic edits | `replaceAll`, `anchor`, `lineRange`, `target` | AST-level conflict detection |
| **Claude text_editor** | `str_replace` (exact) + `insert` (line-based) | Line numbers via `view_range` | Read-before-write guard |
| **Aider** | 4-layer: exact → whitespace-insensitive → indentation-preserving → difflib fuzzy | Search/Replace blocks | Per-block failure reporting |
| **Codex CLI** | 3-layer: exact → trimmed-line-endings → trimmed-whitespace | `@@` context anchors | Context-line mismatch error |
| **RooCode** | Middle-out fuzzy (Levenshtein distance) | Start line hint in SEARCH block | User approval step |
| **Serena** | LSP-based symbolic lookup | Symbol name + kind | Language server cross-reference |
