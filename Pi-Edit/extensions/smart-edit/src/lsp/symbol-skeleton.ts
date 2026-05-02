/**
 * Symbol Skeleton — Utilities for extracting concise snippets from source code.
 * Used by LSP-RAG to provide context without returning full files.
 */

import type { DocumentSymbol, Location } from "./semantic-nav";

/**
 * Finds the innermost DocumentSymbol that completely encloses a given Location.
 * Useful for finding which function or class contains a definition or reference.
 */
export function findEnclosingDocumentSymbol(
  symbols: DocumentSymbol[],
  location: Location,
): DocumentSymbol | null {
  const { range } = location;
  let best: DocumentSymbol | null = null;

  for (const symbol of symbols) {
    if (contains(symbol.range, range)) {
      // Found a container, check if children provide a tighter fit
      best = symbol;
      if (symbol.children) {
        const childBest = findEnclosingDocumentSymbol(symbol.children, location);
        if (childBest) {
          best = childBest;
        }
      }
      break;
    }
  }

  return best;
}

/**
 * Extracts a concise excerpt for a symbol.
 * Rules:
 * - Small symbols (< 30 lines): full body.
 * - Large symbols: signature + first few lines + child skeleton if applicable.
 * - References: a few lines around the call site.
 */
export function extractSymbolExcerpt(
  content: string,
  symbol: DocumentSymbol | null,
  location: Location,
  options: { maxLines: number; preferSkeleton: boolean },
): { text: string; excerptKind: "hover" | "signature" | "skeleton" | "body" | "reference"; truncated: boolean } {
  const { range } = location;
  const lines = content.split("\n");

  // If no symbol provided, or it's a reference (not a definition), just show context around location
  if (!symbol || !options.preferSkeleton) {
    const startLine = Math.max(0, range.start.line - 2);
    const endLine = Math.min(lines.length - 1, range.end.line + 2);
    const excerptLines = lines.slice(startLine, endLine + 1);
    
    return {
      text: excerptLines.join("\n"),
      excerptKind: "reference",
      truncated: false,
    };
  }

  const sStart = symbol.range.start.line;
  const sEnd = symbol.range.end.line;
  const lineCount = sEnd - sStart + 1;

  // Small symbol: return full body
  if (lineCount <= 30 && !options.preferSkeleton) {
    return {
      text: lines.slice(sStart, sEnd + 1).join("\n"),
      excerptKind: "body",
      truncated: false,
    };
  }

  // Large symbol or skeleton requested: extract signature/skeleton
  // For signature, we take the selectionRange (where the name is) up to some lines
  const sigEnd = Math.min(sEnd, symbol.selectionRange.end.line + 2);
  let text = lines.slice(sStart, sigEnd + 1).join("\n");
  
  if (symbol.children && symbol.children.length > 0) {
    text += "\n  // ...\n";
    for (const child of symbol.children) {
      const childLine = lines[child.selectionRange.start.line]?.trim() || child.name;
      text += `  ${childLine}\n`;
    }
    if (sEnd > sigEnd) text += "  // ...";
  } else if (sEnd > sigEnd) {
    text += "\n  // ... (truncated)";
  }

  return {
    text,
    excerptKind: lineCount <= 30 ? "body" : "skeleton",
    truncated: sEnd > sigEnd,
  };
}

/** Check if range A contains range B */
function contains(a: any, b: any): boolean {
  if (a.start.line > b.start.line) return false;
  if (a.start.line === b.start.line && a.start.character > b.start.character) return false;
  if (a.end.line < b.end.line) return false;
  if (a.end.line === b.end.line && a.end.character < b.end.character) return false;
  return true;
}
