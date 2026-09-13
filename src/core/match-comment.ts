/**
 * Comment-prefix subsystem for the smart-edit match engine (Tier 4).
 *
 * Extracted verbatim from src/core/edit-match.ts (MS2): CommentStyleResult,
 * detectCommentStyle, stripCommentPrefixes plus helper mapStrippedToOriginal
 * (exported for edit-match.ts internal use; no logic/threshold change).
 * Tier order, thresholds, and coordinates unchanged. One-way dependency:
 * edit-match.ts consumes this module; this module must NOT import
 * edit-match.ts or edit-diff.ts.
 */

// ─── Comment-prefix utilities (Tier 4) ─────────────────────────────

/**
 * Result from detecting a comment style in a file.
 */
export interface CommentStyleResult {
  /** The comment prefix ('//', '#', or '--') */
  prefix: string;
  /** Number of lines in the sample that used this prefix */
  count: number;
}

/**
 * Detect the comment style used in a file by examining the first N non-empty lines.
 * Returns null if no consistent comment style is found.
 *
 * @param content - The file content to analyze
 * @returns {prefix: string, count: number} or null
 */
export function detectCommentStyle(content: string): CommentStyleResult | null {
  const lines = content.split("\n");
  const nonEmptyLines: string[] = [];

  // Collect first 20 non-empty lines
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      nonEmptyLines.push(trimmed);
      if (nonEmptyLines.length >= 20) break;
    }
  }

  if (nonEmptyLines.length === 0) return null;

  // Count occurrences of each comment style
  let doubleSlashCount = 0;
  let hashCount = 0;
  let doubleDashCount = 0;

  for (const line of nonEmptyLines) {
    if (line.startsWith("//")) {
      doubleSlashCount++;
    } else if (line.startsWith("#")) {
      hashCount++;
    } else if (line.startsWith("--")) {
      doubleDashCount++;
    }
  }

  // Determine consistent style (at least 60% of lines must match)
  const threshold = Math.ceil(nonEmptyLines.length * 0.6);

  if (doubleSlashCount >= threshold) {
    return { prefix: "//", count: doubleSlashCount };
  }
  if (hashCount >= threshold) {
    return { prefix: "#", count: hashCount };
  }
  if (doubleDashCount >= threshold) {
    return { prefix: "--", count: doubleDashCount };
  }

  return null;
}

/**
 * Strip comment prefixes from text, preserving line structure.
 *
 * @param text - The text to process
 * @param prefix - The comment prefix to strip ('//', '#', or '--')
 * @returns The text with comment prefixes removed from each line
 */
export function stripCommentPrefixes(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => {
      const leadingWs = line.match(/^[\t ]*/);
      const ws = leadingWs ? leadingWs[0] : "";
      const rest = line.slice(ws.length);
      if (rest.startsWith(prefix)) {
        return ws + rest.slice(prefix.length);
      }
      return line;
    })
    .join("\n");
}

/**
 * Map a character offset in stripped (comment-prefix-removed) content back to
 * the corresponding offset in the original content.
 *
 * @param original - Original content with comment prefixes
 * @param stripped - Content with comment prefixes removed
 * @param strippedOffset - Character offset in stripped content
 * @returns Character offset in original content
 */
export function mapStrippedToOriginal(
  original: string,
  stripped: string,
  strippedOffset: number,
): number {
  const origLines = original.split("\n");
  const strippedLines = stripped.split("\n");

  let remaining = strippedOffset;
  let origOffset = 0;

  for (let i = 0; i < strippedLines.length && i < origLines.length; i++) {
    const sl = strippedLines[i];
    if (remaining <= sl.length) {
      // Position is within this line — add back the comment prefix if it existed
      const origLine = origLines[i];
      const leadingWs = origLine.match(/^[\t ]*/);
      const ws = leadingWs ? leadingWs[0] : "";
      const afterWs = origLine.slice(ws.length);

      // Check if this line had a comment prefix
      if (afterWs.startsWith("//") && strippedLines[i].startsWith(ws)) {
        return origOffset + ws.length + 2 + remaining; // +2 for "//"
      }
      if (afterWs.startsWith("#") && strippedLines[i].startsWith(ws)) {
        return origOffset + ws.length + 1 + remaining; // +1 for "#"
      }
      if (afterWs.startsWith("--") && strippedLines[i].startsWith(ws)) {
        return origOffset + ws.length + 2 + remaining; // +2 for "--"
      }

      // No comment prefix on this line, position maps directly
      return origOffset + remaining;
    }
    remaining -= sl.length + 1; // +1 for \n
    origOffset += origLines[i].length + 1;
  }

  return original.length;
}
