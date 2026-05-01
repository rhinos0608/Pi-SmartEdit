/**
 * Target Range — Resolves various locator formats into a concrete byte and line range.
 *
 * Supports:
 * - Hashline anchors (pos/end hashes from a read snapshot)
 * - AST anchors (symbol name + line hint)
 * - LSP document symbols (fetched via textDocument/documentSymbol)
 * - Explicit line ranges
 * - Full-file fallback
 */

import { FileSnapshot, LineRange } from "../../lib/types";
import { lineRangeToByteRange } from "../../lib/edit-diff";
import { parseTag, tryRebaseAnchor } from "../../lib/hashline-edit";
import { DocumentSymbol } from "./semantic-nav";

export interface ResolvedTarget {
  lineRange: { startLine: number; endLine: number };
  byteRange: { startIndex: number; endIndex: number };
  symbolName?: string;
  source: "hashline" | "anchor" | "documentSymbol" | "lineRange" | "file";
}

export interface TargetRangeOptions {
  path: string;
  content: string;
  lineRange?: { startLine: number; endLine?: number };
  anchor?: { symbolName?: string; symbolKind?: string; symbolLine?: number };
  symbol?: { name: string; kind?: string; line?: number };
  hashline?: { pos: string; end?: string };
  snapshot: FileSnapshot | null;
  astResolver?: { findSymbolNode(name: string, kind?: string, line?: number): any | null };
  documentSymbols?: DocumentSymbol[];
}

/**
 * Resolves a locator into a concrete range.
 * Implements the precedence order: Hashline > AST anchor > DocumentSymbol > LineRange > File.
 */
export async function resolveTargetRange(
  options: TargetRangeOptions,
): Promise<ResolvedTarget> {
  const { content, snapshot } = options;
  const lines = content.split("\n");

  // 1. Hashline Range
  if (options.hashline && snapshot?.hashline?.anchors) {
    try {
      const posTag = parseTag(options.hashline.pos);
      const endTag = options.hashline.end ? parseTag(options.hashline.end) : posTag;

      // Check current content first (rebase window 5)
      const rebasedPos = tryRebaseAnchor(posTag, lines);
      const rebasedEnd = tryRebaseAnchor(endTag, lines);

      if (rebasedPos !== null && rebasedEnd !== null) {
        const startLine = rebasedPos === "exact" ? posTag.line : rebasedPos;
        const endLine = rebasedEnd === "exact" ? endTag.line : rebasedEnd;
        
        const byteRange = lineRangeToByteRange(content, { startLine, endLine: Math.max(startLine, endLine) });
        return {
          lineRange: { startLine, endLine: Math.max(startLine, endLine) },
          byteRange,
          source: "hashline",
        };
      }
    } catch {
      // Fall through if hashline parsing fails
    }
  }

  // 2. AST Anchor
  if (options.anchor?.symbolName && options.astResolver) {
    // Note: This requires the caller to have parsed the tree already and passed a mock/wrapper
    // or we resolve it here. The spec says "via astResolver.findSymbolNode".
    // Since astResolver depends on a Tree, we assume the caller provides a resolved node or 
    // we handle the tree management in semantic-context.ts.
    // For target-range.ts, we expect a function that returns node offsets.
    const node = options.astResolver.findSymbolNode(
      options.anchor.symbolName,
      options.anchor.symbolKind,
      options.anchor.symbolLine
    );
    if (node) {
      const startLine = countLines(content.slice(0, node.startIndex)) + 1;
      const endLine = countLines(content.slice(0, node.endIndex)) + 1;
      return {
        lineRange: { startLine, endLine },
        byteRange: { startIndex: node.startIndex, endIndex: node.endIndex },
        symbolName: options.anchor.symbolName,
        source: "anchor",
      };
    }
  }

  // 3. Document Symbol (LSP)
  if (options.symbol?.name && options.documentSymbols) {
    const symbol = findSymbolInList(options.documentSymbols, options.symbol.name, options.symbol.line);
    if (symbol) {
      const { range } = symbol;
      const byteRange = lineRangeToByteRange(content, { 
        startLine: range.start.line + 1, 
        endLine: range.end.line + 1 
      });
      return {
        lineRange: { startLine: range.start.line + 1, endLine: range.end.line + 1 },
        byteRange,
        symbolName: symbol.name,
        source: "documentSymbol",
      };
    }
  }

  // 4. Line Range
  if (options.lineRange) {
    const startLine = options.lineRange.startLine;
    const endLine = options.lineRange.endLine || startLine;
    const byteRange = lineRangeToByteRange(content, { startLine, endLine });
    return {
      lineRange: { startLine, endLine },
      byteRange,
      source: "lineRange",
    };
  }

  // 5. Whole File
  const totalLines = lines.length;
  return {
    lineRange: { startLine: 1, endLine: totalLines },
    byteRange: { startIndex: 0, endIndex: content.length },
    source: "file",
  };
}

function countLines(text: string): number {
  return (text.match(/\n/g) || []).length;
}

function findSymbolInList(symbols: DocumentSymbol[], name: string, line?: number): DocumentSymbol | null {
  for (const s of symbols) {
    if (s.name === name) {
      if (line === undefined || (s.range.start.line + 1 <= line && s.range.end.line + 1 >= line)) {
        return s;
      }
    }
    if (s.children) {
      const child = findSymbolInList(s.children, name, line);
      if (child) return child;
    }
  }
  return null;
}
