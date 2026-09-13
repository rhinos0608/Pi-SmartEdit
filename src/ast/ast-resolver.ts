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
import type { EditAnchor, SymbolRef, SearchScope } from "../core/types";
import type { ParseResult } from "./parse-cache.js";

export {
  getCachedParse,
  setCachedParse,
  clearParseCache,
  type ParseResult,
} from "./parse-cache.js";

import {
  computeEdit,
  incrementalReParse,
  reuseParseResult,
  type EditDelta,
} from "./incremental-reparse.js";

export { computeEdit, incrementalReParse, reuseParseResult, type EditDelta };

// ─── Re-exported interfaces ─────────────────────────────────────────

export { type default as Parser } from "web-tree-sitter";
export type { EditAnchor, SymbolRef, SearchScope } from "../core/types";

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
