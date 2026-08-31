/**
 * AST Resolver — integrates web-tree-sitter for scope-aware editing.
 *
 * Provides:
 * - File parsing into a concrete syntax tree (CST)
 * - Symbol resolution via anchor matching (name + kind + line hints)
 * - Enclosing-symbol discovery for conflict detection
 * - Incremental re-parsing with LRU parse cache
 * - Graceful degradation when tree-sitter is unavailable
 *
 * Architecture:
 * - Parses fresh per call by default (sub-ms for typical files)
 * - Supports incremental re-parse via computeEdit() + incrementalReParse()
 * - Uses LRU cache (10 entries) for repeated parses of the same content
 * - Uses node.walk() for symbol discovery (not queries — more cross-language robust)
 * - Reports ERROR nodes via ParseResult.hasErrors flag
 * - Callers are responsible for tree.delete() cleanup
 */

import type Parser from "web-tree-sitter";
import { loadGrammar } from "./grammar-loader";
import type { EditAnchor, SymbolRef, SearchScope } from "./types";

// ─── Re-exported interfaces ─────────────────────────────────────────

export { type default as Parser } from "web-tree-sitter";
export type { EditAnchor, SymbolRef, SearchScope } from "./types";

/** Result of parsing a file with tree-sitter */
export interface ParseResult {
  /** The parser instance — caller must call parser.delete() when done */
  parser: Parser;

  /** The syntax tree — caller must call tree.delete() when done */
  tree: Parser.Tree;

  /** The language grammar used */
  language: string;

  /** Whether the tree has ERROR or MISSING nodes indicating syntax errors */
  hasErrors: boolean;

  /** The content that was parsed */
  content: string;

  /** Optional diagnostic describing why AST resolution may be unreliable. */
  diagnostic?: string;
}

// ─── Parse Cache (LRU, 10 entries) ─────────────────────────────────

interface CachedParse {
  result: ParseResult;
  contentHash: string;
}

const parseCache = new Map<string, CachedParse>();
const MAX_CACHE_SIZE = 10;

/**
 * Get a cached parse result if the content hash matches.
 * @param filePath - Path used as cache key
 * @param contentHash - SHA-256 hash of the content
 * @returns The cached ParseResult, or null if not found or hash mismatch
 */
export function getCachedParse(filePath: string, contentHash: string): ParseResult | null {
  const cached = parseCache.get(filePath);
  if (!cached) return null;
  if (cached.contentHash !== contentHash) return null;
  // Bump to end (LRU promotion)
  parseCache.delete(filePath);
  parseCache.set(filePath, cached);
  return cached.result;
}

/**
 * Store a parse result in the cache.
 * Evicts the oldest entry when the cache exceeds MAX_CACHE_SIZE.
 * @param filePath - Path used as cache key
 * @param contentHash - SHA-256 hash of the content
 * @param result - The parse result to cache
 */
export function setCachedParse(filePath: string, contentHash: string, result: ParseResult): void {
  // Evict oldest if at capacity
  if (parseCache.size >= MAX_CACHE_SIZE && !parseCache.has(filePath)) {
    const firstKey = parseCache.keys().next().value;
    if (firstKey !== undefined) {
      const evicted = parseCache.get(firstKey);
      if (evicted) {
        evicted.result.tree.delete();
        evicted.result.parser.delete();
      }
      parseCache.delete(firstKey);
    }
  }
  parseCache.set(filePath, { result, contentHash });
}

/**
 * Clear the entire parse cache.
 * Disposes all cached trees and parsers to free WASM memory.
 */
export function clearParseCache(): void {
  for (const cached of parseCache.values()) {
    cached.result.tree.delete();
    cached.result.parser.delete();
  }
  parseCache.clear();
}

// ─── Incremental Parsing ─────────────────────────────────────────────

/**
 * Edit delta for tree-sitter's incremental parsing.
 * All positions are byte offsets.
 */
export interface EditDelta {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: { row: number; column: number };
  oldEndPosition: { row: number; column: number };
  newEndPosition: { row: number; column: number };
}

/**
 * Compute the minimal edit between oldContent and newContent.
 * Uses longest common subsequence (LCS) to find the changed range.
 *
 * @param oldContent - The original content
 * @param newContent - The modified content
 * @returns EditDelta suitable for tree.edit(), or null if entire file changed (fallback to full parse)
 */
export function computeEdit(oldContent: string, newContent: string): EditDelta | null {
  // Fast path: identical content
  if (oldContent === newContent) return null;

  // Fast path: one is empty
  if (oldContent.length === 0 && newContent.length === 0) return null;

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const m = oldLines.length;
  const n = newLines.length;

  // Find first unchanged line from the start
  let firstChangeLine = 0;
  while (firstChangeLine < m && firstChangeLine < n && oldLines[firstChangeLine] === newLines[firstChangeLine]) {
    firstChangeLine++;
  }

  // Find last matching line from the end using proper suffix matching
  // The last matching lines in old and new should be at the same RELATIVE position from end
  let lastOldMatch = m - 1;
  let lastNewMatch = n - 1;

  while (lastOldMatch >= firstChangeLine && lastNewMatch >= firstChangeLine) {
    if (oldLines[lastOldMatch] === newLines[lastNewMatch]) {
      lastOldMatch--;
      lastNewMatch--;
    } else {
      break;
    }
  }

  // lastOldMatch is now one LESS than the last matching line
  // So the last matching line is lastOldMatch + 1
  const lastMatchLine = lastOldMatch + 1;

  // If no matching region found (all lines changed), return null for full parse
  if (firstChangeLine >= m) {
    return null; // Entire file changed
  }
  if (lastMatchLine <= firstChangeLine) {
    return null; // No overlap between prefix and suffix
  }

  // Calculate byte offsets
  const oldBytes = oldContent.length;

  // Convert line positions to byte offsets
  function lineToByteOffset(lines: string[], lineIndex: number): number {
    let offset = 0;
    for (let i = 0; i < lineIndex && i < lines.length; i++) {
      offset += Buffer.byteLength(lines[i], "utf8") + 1;
    }
    return offset;
  }

  const startByte = lineToByteOffset(oldLines, firstChangeLine);
  const oldEndByte = lastMatchLine < m ? lineToByteOffset(oldLines, lastMatchLine) : oldBytes;
  const newEndByte = lineToByteOffset(newLines, lastNewMatch + 1);

  // If the edit spans entire old content with no prefix preserved, return null
  // This handles "entire file change" case
  if (startByte === 0 && oldEndByte === oldBytes) {
    return null;
  }

  // Build position objects
  const startPosition = { row: firstChangeLine, column: 0 };

  // Old end position: count newlines up to oldEndByte
  let oldEndRow = 0;
  let oldEndCol = 0;
  for (let i = 0; i < oldEndByte; i++) {
    if (oldContent[i] === "\n") {
      oldEndRow++;
      oldEndCol = 0;
    } else {
      oldEndCol++;
    }
  }

  // New end position: count newlines up to newEndByte
  let newEndRow = 0;
  let newEndCol = 0;
  for (let i = 0; i < newEndByte; i++) {
    if (newContent[i] === "\n") {
      newEndRow++;
      newEndCol = 0;
    } else {
      newEndCol++;
    }
  }

  return {
    startIndex: startByte,
    oldEndIndex: oldEndByte,
    newEndIndex: newEndByte,
    startPosition,
    oldEndPosition: { row: oldEndRow, column: oldEndCol },
    newEndPosition: { row: newEndRow, column: newEndCol },
  };
}

/**
 * Perform incremental re-parse of content that has been edited.
 *
 * @param oldTree - The previous syntax tree (will be modified in-place)
 * @param oldContent - The content that was used to generate oldTree
 * @param newContent - The new content to parse
 * @param parser - Parser instance configured with the language
 * @returns The new tree (incremental), or null if incremental parse not possible
 */
export function incrementalReParse(
  oldTree: Parser.Tree,
  oldContent: string,
  newContent: string,
  parser: Parser,
): Parser.Tree | null {
  const edit = computeEdit(oldContent, newContent);
  if (!edit) return null;

  try {
    // Apply the edit to the old tree
    oldTree.edit(edit);

    // Parse the new content using the old tree as a hint
    const newTree = parser.parse(newContent, oldTree);
    return newTree;
  } catch {
    // Incremental parse failed — caller should fall back to full parse
    return null;
  }
}

/**
 * Reuse a parse result with new content, trying incremental parse first.
 *
 * This is the high-level function for re-parsing after an edit:
 * - If content unchanged → return old result directly
 * - If incremental parse succeeded → return new tree (caller must dispose old tree)
 * - If incremental parse not possible → do full parse
 * - Properly disposes the OLD tree after new parse
 *
 * @param oldResult - The previous parse result
 * @param newContent - The new content to parse
 * @returns A new ParseResult with the updated tree
 */
export async function reuseParseResult(
  oldResult: ParseResult,
  newContent: string,
): Promise<ParseResult> {
  // Fast path: content unchanged
  if (oldResult.content === newContent) {
    return oldResult;
  }

  // Try incremental parse
  const newTree = incrementalReParse(
    oldResult.tree,
    oldResult.content,
    newContent,
    oldResult.parser,
  );

  if (newTree) {
    // Incremental succeeded — dispose old tree, keep parser
    oldResult.tree.delete();

    return {
      parser: oldResult.parser, // same parser instance
      tree: newTree,
      language: oldResult.language,
      hasErrors: newTree.rootNode.hasError,
      content: newContent,
    };
  }

  // Incremental failed — do full parse
  oldResult.tree.delete();
  // Note: oldResult.parser will be disposed when we create a new one

  const ext = oldResult.language || ".ts";
  const newResult = await parseFile(newContent, `file${ext}`);

  if (newResult) {
    // Full parse succeeded — dispose old parser
    oldResult.parser.delete();
    return newResult;
  }

  // Full parse also failed — recreate with same path logic
  const parseResult = await parseFile(newContent, `file${ext}`);
  if (parseResult) {
    oldResult.parser.delete();
    return parseResult;
  }

  // All re-parse strategies failed — cannot recover
  throw new Error("reuseParseResult: all re-parse strategies failed -- cannot recover parse tree");
}

// ─── Node type classification ───────────────────────────────────────

/**
 * Node types that represent structural code symbols.
 * Includes names from multiple languages for cross-grammar support.
 */
const SYMBOL_NODE_TYPES = new Set([
  // ── JavaScript / TypeScript / TSX ──
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "class_declaration",
  "class_expression",
  "variable_declarator",
  "lexical_declaration",
  "export_statement",

  // ── Python ──
  "function_definition",
  "class_definition",
  "decorated_definition",

  // ── Rust ──
  "function_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "impl_item",
  "mod_item",

  // ── Go ──
  "method_declaration",
  "type_declaration",

  // ── Java ──
  "interface_declaration",
  "constructor_declaration",

  // ── Ruby ──
  "method",
  "class",
  "module",
  "singleton_method",

  // ── C / C++ ──
  "class_specifier",
  "struct_specifier",
  "enum_specifier",

  // ── C# ──
  "namespace_declaration",
  "struct_declaration",
  "enum_declaration",
  "record_declaration",

  // ── PHP ──
  "trait_declaration",
  "namespace_definition",
]);

/**
 * Node types that can be children containing the "name" of a symbol.
 * Used for extracting identifiers from symbol container nodes.
 * Organized by language for auditable coverage. A single "identifier"
 * entry covers most languages since tree-sitter's grammar convention
 * uses the "identifier" type universally for name-bearing nodes.
 */
const NAME_LIKE_TYPES = new Set([
  // Universal (all languages use "identifier" for most names)
  "identifier",

  // Type-specific identifiers
  "property_identifier",
  "type_identifier",
  "shorthand_property_identifier",
  "field_identifier",

  // Ruby-specific name-bearing nodes
  "constant",

  // Bash: function names are `word` nodes (e.g. `function foo() {}` → child `word` "foo")
  // Safe — no other supported grammar uses `word` as child of a symbol node
  "word",

  // PHP (and others): class/method/namespace names are `name` nodes
  "name",
]);

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Parse a file into a concrete syntax tree.
 * Results are cached by (filePath, contentHash) for fast retrieval
 * when the same content is parsed multiple times.
 *
 * @param content - The file content (LF-normalized, BOM-stripped)
 * @param filePath - Path to the file (used to detect language via extension)
 * @returns ParseResult, or null if the language is not supported or grammar unavailable
 */
export async function parseFile(
  content: string,
  filePath: string,
): Promise<ParseResult | null> {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (!ext || ext === filePath) return null; // no extension

  const language = await loadGrammar(ext);
  if (!language) return null;

  let parser: Parser | undefined;
  try {
    const Parser = await import("web-tree-sitter");
    parser = new Parser.default();
    parser.setLanguage(language);

    const tree = parser.parse(content);

    const result: ParseResult = {
      parser,
      tree,
      language: ext,
      hasErrors: tree.rootNode.hasError,
      content,
      diagnostic: tree.rootNode.hasError
        ? "The file contains syntax errors; AST anchor resolution may be unreliable."
        : undefined,
    };

    return result;
  } catch (err) {
    // Parse failure — return null (graceful fallback to text-only)
    parser?.delete();
    return null;
  }
}

/**
 * Find the AST node matching an edit anchor.
 *
 * Walks the entire syntax tree looking for named symbols that match
 * the anchor's name, kind, and line hint constraints.
 *
 * Supports two resolution modes:
 * - Name-based: finds symbols matching `symbolName` (with optional kind/line disambiguation)
 * - Line-only: when `symbolName` is absent but `symbolLine` is set, finds the
 *   innermost symbol whose range contains that line (filtered by `symbolKind` if set)
 *
 * @param tree - The parsed syntax tree
 * @param anchor - The edit anchor specifying which symbol to find
 * @returns The matching node, or null if no match or anchor has no identifiers
 */
export function findSymbolNode(
  tree: Parser.Tree,
  anchor: EditAnchor,
): Parser.SyntaxNode | null {
  if (!tree) return null;
  if (!tree.rootNode) return null;

  // Must have at least one identifier: name or line
  if (!anchor.symbolName && anchor.symbolLine == null) return null;

  const root = tree.rootNode;

  // Skip if tree has errors — anchor resolution is unreliable
  if (root.hasError) return null;

  let candidates: Array<{
    node: Parser.SyntaxNode;
    nameLine: number;
    containmentScore: number;
    namePath?: string;
  }> = [];

  // Walk all nodes looking for symbol containers
  walkTree(root, (node) => {
    if (!isSymbolNode(node)) return;

    // Kind filter
    if (anchor.symbolKind && node.type !== anchor.symbolKind) return;

    if (anchor.symbolName) {
      // Name-based resolution: match by name
      const nameNode = findNameChild(node);
      if (!nameNode) return;

      const name = nameNode.text;
      if (name !== anchor.symbolName) return;

      candidates.push({
        node,
        nameLine: nameNode.startPosition.row + 1,
        containmentScore: 0,
        namePath: symbolNamePath(node),
      });
    } else if (anchor.symbolLine != null) {
      // Line-only resolution: find symbols whose range contains the target line
      const startLine = node.startPosition.row + 1; // 1-based
      const endLine = node.endPosition.row + 1;
      if (anchor.symbolLine >= startLine && anchor.symbolLine <= endLine) {
        // Score by containment tightness — smaller range = more specific match
        const span = endLine - startLine;
        candidates.push({
          node,
          nameLine: startLine,
          containmentScore: span,
        });
      }
    }
  });

  if (anchor.symbolNamePath) {
    // Match the qualified path either exactly or by trailing ancestor component
    // sequence (e.g. anchor "Foo.bar" matches candidate "Outer.Foo.bar"). Final
    // name matching above is unchanged.
    candidates = candidates.filter((candidate) => {
      if (!candidate.namePath) return false;
      return (
        candidate.namePath === anchor.symbolNamePath ||
        candidate.namePath.endsWith(`.${anchor.symbolNamePath}`)
      );
    });
  }
  if (candidates.length === 0) return null;

  if (anchor.symbolName) {
    if (candidates.length > 1 && anchor.symbolLine == null) return null;
    // Name-based: prefer closest to symbolLine hint when disambiguating.
    if (anchor.symbolLine != null && candidates.length > 1) {
      const targetLine = anchor.symbolLine;
      candidates.sort(
        (a, b) =>
          Math.abs(a.nameLine - targetLine) -
          Math.abs(b.nameLine - targetLine),
      );
      if (
        Math.abs(candidates[0].nameLine - targetLine) ===
        Math.abs(candidates[1].nameLine - targetLine)
      ) return null;
    }
  } else {
    // Line-only: prefer the tightest containment (innermost symbol)
    candidates.sort((a, b) => a.containmentScore - b.containmentScore);
  }

  return candidates[0].node;
}

/**
 * Find all symbols that enclose a given byte range.
 * Used by the conflict detector to track which symbols were edited.
 *
 * @param tree - The parsed syntax tree
 * @param startByte - Start of the range (inclusive)
 * @param endByte - End of the range (exclusive)
 * @returns Array of SymbolRefs, from innermost to outermost
 */
export function findEnclosingSymbols(
  tree: Parser.Tree,
  startByte: number,
  endByte: number,
): SymbolRef[] {
  const root = tree.rootNode;
  const symbols: SymbolRef[] = [];

  // Use cursor-based descent for better performance on deep trees
  const cursor = root.walk();

  try {
    const visit = (): boolean => {
      const node = cursor.currentNode;

      // Check if this node contains the byte range
      if (node.startIndex <= startByte && node.endIndex >= endByte) {
        if (isSymbolNode(node)) {
          const nameNode = findNameChild(node);
          symbols.push({
            name: nameNode ? nameNode.text : `<anonymous ${node.type}>`,
            kind: node.type,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            startByte: node.startIndex,
            endByte: node.endIndex,
          });
        }

        // Descend into children
        if (cursor.gotoFirstChild()) {
          do {
            if (!visit()) break;
          } while (cursor.gotoNextSibling());
          cursor.gotoParent();
        }
      }

      return true; // continue
    };

    // Don't start at root (it's the program node), go to first child
    if (cursor.gotoFirstChild()) {
      do {
        visit();
      } while (cursor.gotoNextSibling());
    }

    return symbols.reverse();
  } finally {
    cursor.delete();
  }
}

/**
 * Clean up a ParseResult by calling tree.delete().
 * Must be called when done using a ParseResult to free WASM memory.
 */
export function disposeParseResult(result: ParseResult): void {
  result.tree.delete();
  result.parser.delete();
}

/**
 * Validate that the file content has no syntax errors.
 *
 * @param content - The file content (LF-normalized, BOM-stripped)
 * @param filePath - Path to the file (used to detect language via extension)
 * @param oldTree - Optional previous parse tree for incremental validation
 * @param oldContent - Optional previous content matching the oldTree
 * @returns { valid: true } or { valid: false, error: string }
 */
export async function validateSyntax(
  content: string,
  filePath: string,
  oldTree?: Parser.Tree | null,
  oldContent?: string,
): Promise<{ valid: true } | { valid: false; error: string }> {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (!ext || ext === filePath) return { valid: true }; // no extension

  const language = await loadGrammar(ext);
  if (!language) {
    // No parser available for this language — cannot validate
    return { valid: true };
  }

  let parser: Parser | undefined;
  let tree: Parser.Tree | null = null;

  try {
    const ParserModule = await import("web-tree-sitter");
    parser = new ParserModule.default();
    parser.setLanguage(language);

    // Try incremental parse if old tree is provided
    if (oldTree && oldContent) {
      const incrementalTree = incrementalReParse(oldTree, oldContent, content, parser);
      if (incrementalTree) {
        tree = incrementalTree;
      } else {
        // Incremental failed, do full parse
        tree = parser.parse(content);
      }
    } else {
      // No old tree — do full parse
      tree = parser.parse(content);
    }

    if (tree.rootNode.hasError) {
      return {
        valid: false,
        error: "Syntax error detected after edit — the file may not compile or behave correctly",
      };
    }
    return { valid: true };
  } catch (err) {
    // Parse failure — cannot validate
    return { valid: true };
  } finally {
    // Clean up if we created our own parser/tree
    if (tree && tree !== oldTree) {
      tree.delete();
    }
    if (parser) {
      parser.delete();
    }
  }
}

/**
 * Create an AST resolver object wrapping the module's standalone functions.
 * The returned object conforms to the interface expected by index.ts and
 * the conflict detector.
 */
export function createAstResolver() {
  return {
    parseFile,
    findEnclosingSymbols,
    findSymbolNode,
    disposeParseResult,
  };
}

// ─── Private helpers ────────────────────────────────────────────────

/**
 * Check if a node is a structural symbol (function, class, method, etc.)
 */
function isSymbolNode(node: Parser.SyntaxNode): boolean {
  return node.isNamed && SYMBOL_NODE_TYPES.has(node.type);
}

function symbolNamePath(node: Parser.SyntaxNode): string | undefined {
  const names: string[] = [];
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (isSymbolNode(current)) {
      const name = findNameChild(current)?.text;
      // Deduplicate same-name ancestor wrappers (e.g. an arrow function nested
      // inside a method of the same name) so the path collapses to one component.
      if (name && (names.length === 0 || names[names.length - 1] !== name)) {
        names.push(name);
      }
    }
    current = current.parent;
  }
  return names.length > 0 ? names.reverse().join(".") : undefined;
}

/**
 * Find the name/identifier child of a symbol node.
 * Tries childForFieldName("name") first, falls back to
 * finding the first identifier-like child.
 */
function findNameChild(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  // Try the "name" field (works for JS/TS/Python function_declaration, class_declaration, etc.)
  const nameField = node.childForFieldName?.("name");
  if (nameField && NAME_LIKE_TYPES.has(nameField.type)) {
    return nameField;
  }

  // Fallback: find first identifier-like child
  let found: Parser.SyntaxNode | null = null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.isNamed && NAME_LIKE_TYPES.has(child.type)) {
      if (!found || child.startIndex < found.startIndex) {
        found = child;
      }
    }
  }

  return found;
}

/**
 * Walk a tree depth-first, calling the visitor for each named node.
 *
 * Uses an explicit stack instead of recursion to avoid stack overflow
 * on deeply nested ASTs (templated TypeScript, nested generics, etc.).
 * Each frame holds a (node, childIndex) pair; we iterate children from
 * the back so they are visited in document order (pre-order).
 */
function walkTree(
  root: Parser.SyntaxNode,
  visitor: (node: Parser.SyntaxNode) => void,
): void {
  interface StackFrame {
    node: Parser.SyntaxNode;
    childIndex: number;
  }

  const stack: StackFrame[] = [{ node: root, childIndex: 0 }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const node = frame.node;

    // Enter phase — visit the node on first encounter
    if (frame.childIndex === 0 && node.isNamed) {
      visitor(node);
    }

    if (frame.childIndex < node.childCount) {
      // Descend into the next child
      const child = node.child(frame.childIndex);
      frame.childIndex++;
      if (child) {
        stack.push({ node: child, childIndex: 0 });
      }
    } else {
      // All children visited — pop
      stack.pop();
    }
  }
}
