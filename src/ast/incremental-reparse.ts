/**
 * Incremental Re-parse — tree-sitter edit-delta + incremental re-parse leaf.
 *
 * Extracted verbatim from ast-resolver.ts (MS2 split). No cache-semantics change.
 * - EditDelta / computeEdit: minimal byte-delta between old/new content.
 * - incrementalReParse: apply edit to old tree, re-parse with old tree as hint.
 * - reuseParseResult: high-level re-parse after edit (incremental first, full fallback).
 *
 * Note: full-parse fallback resolves parseFile via dynamic import of
 * ./ast-resolver.js to keep the module graph acyclic (facade imports this leaf).
 */
import type Parser from "web-tree-sitter";
import type { ParseResult } from "./parse-cache.js";

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

  // Dynamic import keeps the module graph acyclic (facade imports this leaf).
  const { parseFile } = await import("./ast-resolver.js");

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
