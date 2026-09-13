/**
 * Line-range helpers for the smart-edit Pi extension.
 *
 * Extracted verbatim from src/core/edit-diff.ts (MS2): line-range to
 * byte-offset conversion plus range validation. Pure helpers with no
 * dependencies — no logic change.
 */

// ─── Line-range helpers ─────────────────────────────────────────

/**
 * Convert a line range (1-based) to byte offsets in the content.
 * Operates on LF-normalized content after BOM strip.
 * If endLine is omitted, defaults to startLine (single line).
 */
export function lineRangeToByteRange(
  content: string,
  range: { startLine: number; endLine?: number },
): { startIndex: number; endIndex: number; totalLines: number } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const startLine = Math.max(1, Math.min(range.startLine, totalLines));
  const endLine = range.endLine
    ? Math.max(startLine, Math.min(range.endLine, totalLines))
    : startLine;

  let startIndex = 0;
  for (let i = 0; i < startLine - 1 && i < lines.length; i++) {
    startIndex += lines[i].length + 1;
  }

  let endIndex = startIndex;
  const hasTrailingNewline = content.endsWith('\n');
  for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
    endIndex += lines[i].length;
    // Add 1 for the newline separator, unless this is the last line
    // without a trailing newline
    if (i < lines.length - 1 || hasTrailingNewline) {
      endIndex += 1;
    }
  }

  return { startIndex, endIndex, totalLines };
}

/**
 * Validate a line range against the file length.
 * Returns null if valid, error message if invalid.
 */
export function validateLineRange(
  range: { startLine: number; endLine?: number },
  totalLines: number,
): string | null {
  if (range.startLine < 1) return "startLine must be >= 1";
  if (range.startLine > totalLines)
    return `startLine ${range.startLine} exceeds file length (${totalLines} lines)`;
  if (range.endLine && range.endLine > totalLines)
    return `endLine ${range.endLine} exceeds file length (${totalLines} lines)`;
  if (range.endLine && range.endLine < range.startLine)
    return "endLine must be >= startLine";
  return null;
}
