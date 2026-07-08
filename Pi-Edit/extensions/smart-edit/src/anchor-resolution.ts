import type { EditItem, SearchScope } from "./core/types";
import type { ParseResult } from "./core/ast-resolver";

/**
 * The shape of the AST resolver object used by anchor resolution.
 * Matches the return type of createAstResolver() in ast-resolver.ts.
 */
interface AstResolverLike {
  parseFile(content: string, filePath: string): Promise<ParseResult | null>;
  findSymbolNode(tree: { rootNode?: unknown; walk?: () => unknown }, anchor: { symbolName?: string; symbolKind?: string; symbolLine?: number }): unknown;
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
 * Resolve an edit's anchor/lineRange to a SearchScope for narrowing.
 * Called per-edit before matching.
 */
export async function resolveAnchorToScope(
  edit: EditItem,
  content: string,
  filePath: string,
  astResolver: AstResolverLike | null,
): Promise<SearchScope | null> {
  // Priority 1: AST anchor by symbol name (from target.name)
  if (edit.target?.name && astResolver) {
    let parseResult: ParseResult | null = null;
    try {
      parseResult = await astResolver.parseFile(content, filePath);
      if (parseResult) {
        const anchor = {
          symbolName: edit.target.name,
          symbolKind: edit.target.kind,
          symbolLine: edit.target.line,
        };
        const targetNode = astResolver.findSymbolNode(
          parseResult.tree,
          anchor,
        );
        if (targetNode) {
          const node = targetNode as { startIndex: number; endIndex: number; type: string };
          const scope: SearchScope = {
            startIndex: node.startIndex,
            endIndex: node.endIndex,
            description: `${node.type} "${edit.target.name}"`,
            source: "anchor",
          };
          return scope;
        }
      }
    } catch {
      // AST resolution failed
    } finally {
      if (parseResult) {
        astResolver?.disposeParseResult(parseResult);
      }
    }
  }

  return null;
}
