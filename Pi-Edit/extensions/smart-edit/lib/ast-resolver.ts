/**
 * AST Resolver — integrates web-tree-sitter for scope-aware editing.
 *
 * Provides:
 * - File parsing into a concrete syntax tree (CST)
 * - Symbol resolution via anchor matching (name + kind + line hints)
 * - Enclosing-symbol discovery for conflict detection
 * - Graceful degradation when tree-sitter is unavailable
 *
 * Architecture:
 * - Parses fresh per call (sub-ms for typical files) — no cached Tree objects
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
]);

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Parse a file into a concrete syntax tree.
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

    return {
      parser,
      tree,
      language: ext,
      hasErrors: tree.rootNode.hasError,
      content,
    };
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
 * @param tree - The parsed syntax tree
 * @param anchor - The edit anchor specifying which symbol to find
 * @returns The matching node, or null if no match or anchor has no symbolName
 */
export function findSymbolNode(
  tree: Parser.Tree,
  anchor: EditAnchor,
): Parser.SyntaxNode | null {
  if (!anchor.symbolName) return null;

  const root = tree.rootNode;

  // Skip if tree has errors — anchor resolution is unreliable
  if (root.hasError) return null;

  const candidates: Array<{ node: Parser.SyntaxNode; nameLine: number }> = [];

  // Walk all nodes looking for symbol containers with matching names
  walkTree(root, (node) => {
    if (!isSymbolNode(node)) return;

    // Get the name of this node
    const nameNode = findNameChild(node);
    if (!nameNode) return;

    const name = nameNode.text;
    if (name !== anchor.symbolName) return;

    // Kind filter
    if (anchor.symbolKind && node.type !== anchor.symbolKind) return;

    candidates.push({
      node,
      nameLine: nameNode.startPosition.row + 1, // 1-based
    });
  });

  if (candidates.length === 0) return null;

  // If symbolLine provided, prefer the node whose name is closest to that line
  if (anchor.symbolLine != null && candidates.length > 1) {
    const targetLine = anchor.symbolLine;
    candidates.sort(
      (a, b) =>
        Math.abs(a.nameLine - targetLine) -
        Math.abs(b.nameLine - targetLine),
    );
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
 * @returns { valid: true } or { valid: false, error: string }
 */
export async function validateSyntax(
  content: string,
  filePath: string,
): Promise<{ valid: true } | { valid: false; error: string }> {
  const parseResult = await parseFile(content, filePath);
  if (!parseResult) {
    // No parser available for this language — cannot validate
    return { valid: true };
  }

  try {
    if (parseResult.hasErrors) {
      return {
        valid: false,
        error: "Syntax error detected after edit — the file may not compile or behave correctly",
      };
    }
    return { valid: true };
  } finally {
    disposeParseResult(parseResult);
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
