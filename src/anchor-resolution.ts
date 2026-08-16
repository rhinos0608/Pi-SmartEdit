import type { EditItem, EditAnchor, SearchScope, LineRange } from "./core/types";
import type { ParseResult } from "./core/ast-resolver";
import { lineRangeToByteRange, validateLineRange } from "./core/edit-diff.js";

/**
 * The shape of the AST resolver object used by anchor resolution.
 * Matches the return type of createAstResolver() in ast-resolver.ts.
 */
export interface AstResolverLike {
  parseFile(content: string, filePath: string): Promise<ParseResult | null>;
  findSymbolNode(tree: { rootNode?: unknown; walk?: () => unknown }, anchor: { symbolName?: string; symbolNamePath?: string; symbolKind?: string; symbolLine?: number }): unknown;
  disposeParseResult(result: ParseResult): void;
}

/**
 * Find approximate line numbers for a text snippet in file content.
 * Returns the first line (1-based) where oldText appears, or null.
 */
export function findTextLineRange(
  content: string,
  oldText: string,
): { startLine: number; endLine: number } | null {
  if (!oldText) return null;
  const lines = content.split('\n');
  const searchText = oldText.split('\n')[0]; // First line of oldText
  if (!searchText) return null;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(searchText)) {
      const startLine = i + 1; // 1-based
      const endLine = Math.min(startLine + oldText.split('\n').length - 1, lines.length);
      return { startLine, endLine };
    }
  }
  return null;
}

/**
 * Extract the target line number from a hashline anchor string.
 * Handles special anchors, numeric anchors, and :after/:before suffixes.
 * Used by the range coverage guard to validate hashline-only edits.
 */
export function getHashlineAnchorLine(anchorStr: string, totalLines: number): number | null {
  const trimmed = anchorStr.trim();

  // Special anchors
  if (trimmed === "EOF" || trimmed === "end") return totalLines;
  if (trimmed === "start" || trimmed === "BOF") return 1;

  // Strip :after / :before suffix
  const base = trimmed.replace(/:after$|:before$/, "");

  // Extract leading number from LINE+HASH format
  const lineMatch = base.match(/^(\d+)/);
  if (lineMatch) {
    const ln = parseInt(lineMatch[1], 10);
    return ln >= 1 && ln <= totalLines ? ln : null;
  }

  return null;
}

/**
 * Compute the containing line range for a set of edits from their oldText.
 * Returns [startLine, endLine] (1-based) or null if oldText can't be located.
 *
 * Used by the range coverage guard to validate that edit targets fall within
 * lines that were actually read this session.
 */
export function computeEditContainingRange(
  content: string,
  edits: EditItem[],
): [number, number] | null {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  const contentLines = content.split("\n");

  for (const edit of edits) {
    if (!edit.oldText) continue;
    const searchLine = edit.oldText.split("\n")[0];
    if (!searchLine) continue;

    for (let i = 0; i < contentLines.length; i++) {
      if (contentLines[i].includes(searchLine)) {
        const startLine = i + 1; // 1-based
        const endLine = Math.min(
          startLine + edit.oldText.split("\n").length - 1,
          contentLines.length,
        );
        if (startLine < minStart) minStart = startLine;
        if (endLine > maxEnd) maxEnd = endLine;
        break; // only first match per edit
      }
    }
  }

  if (minStart === Infinity || maxEnd === -Infinity) return null;
  return [minStart, maxEnd];
}

/**
 * Derive an AST anchor from an edit's `target` (name/namePath/kind/line).
 * Returns null when the edit carries no AST identifier.
 * `namePath` is resolved by matching its final component against the AST name.
 */
export function anchorFromEdit(edit: EditItem): EditAnchor | null {
  const t = edit.target;
  if (!t) return null;
  const namePathParts = t.namePath?.split(/[/.#]/).filter(Boolean) ?? [];
  const name = t.name ?? namePathParts[namePathParts.length - 1];
  if (!name && t.line == null) return null;
  return {
    symbolName: name,
    symbolNamePath: namePathParts.length > 0 ? namePathParts.join(".") : undefined,
    symbolKind: t.kind,
    symbolLine: t.line,
  };
}

/**
 * Optional diagnostics surfaced from anchor resolution so callers (e.g. the
 * edit planner) can distinguish a parser/AST failure from a genuine
 * symbol-not-found result.
 */
export interface AnchorResolutionDiagnostics {
  /** Set when the AST parser failed or the tree reports syntax errors. */
  parseError?: string;
}

/**
 * Resolve an edit's anchor/lineRange to a SearchScope for narrowing.
 * Called per-edit before matching.
 *
 * Returns null when the edit has no AST identifier, when no AST resolver is
 * available, or when the AST target cannot be resolved. Callers that require
 * an explicit scope must treat a null result for a target-bearing edit as a
 * resolution failure (never fall back to whole-file matching).
 *
 * When provided, `diagnostics` is populated with a `parseError` describing
 * parser/AST failures, so callers can distinguish those from a symbol that
 * simply could not be found. Unresolved (null) and finally-disposal behavior
 * are preserved.
 */
export async function resolveAnchorToScope(
  edit: EditItem,
  content: string,
  filePath: string,
  astResolver: AstResolverLike | null,
  diagnostics?: AnchorResolutionDiagnostics,
): Promise<SearchScope | null> {
  const anchor = anchorFromEdit(edit);
  if (!anchor) return null;
  if (!astResolver) return null;
  let parseResult: ParseResult | null = null;
  try {
    parseResult = await astResolver.parseFile(content, filePath);
    if (parseResult) {
      if (parseResult.diagnostic && diagnostics) {
        diagnostics.parseError = parseResult.diagnostic;
      }
      const targetNode = astResolver.findSymbolNode(
        parseResult.tree,
        anchor,
      );
      if (targetNode) {
        const node = targetNode as { startIndex: number; endIndex: number; type: string };
        return {
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          description: `${node.type} "${anchor.symbolName ?? anchor.symbolLine}"`,
          source: "anchor",
        };
      }
    } else if (diagnostics) {
      diagnostics.parseError =
        "AST parser could not parse the file (unsupported language, missing grammar, or parse error).";
    }
  } catch (err) {
    // AST resolution failed — surface a diagnostic when requested.
    if (diagnostics) {
      diagnostics.parseError =
        err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (parseResult) {
      astResolver?.disposeParseResult(parseResult);
    }
  }
  return null;
}

/**
 * Convert a 1-based inclusive line range to a byte-range SearchScope.
 * Returns null when the range is out of bounds for the content.
 */
export function lineRangeToScope(content: string, range: LineRange): SearchScope | null {
  const totalLines = content.split("\n").length;
  const err = validateLineRange(range, totalLines);
  if (err) return null;
  const { startIndex, endIndex } = lineRangeToByteRange(content, range);
  return {
    startIndex,
    endIndex,
    description: `lines ${range.startLine}-${range.endLine}`,
    source: "lineRange",
  };
}

/**
 * Intersect two byte-range scopes. Returns null when they do not overlap.
 */
export function intersectScopes(a: SearchScope, b: SearchScope): SearchScope | null {
  const startIndex = Math.max(a.startIndex, b.startIndex);
  const endIndex = Math.min(a.endIndex, b.endIndex);
  if (startIndex >= endIndex) return null;
  return {
    startIndex,
    endIndex,
    description: `${a.description} ∩ ${b.description}`,
    source: "intersection",
  };
}
