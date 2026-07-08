/**
 * Unified diff parser using the `diff` package (parsePatch).
 * 
 * Input format:
 * --- a/file.ts
 * +++ b/file.ts
 * @@ -10,7 +10,7 @@
 *  context line
 * -removed line
 * +added line
 */

import { parsePatch } from 'diff';

import { lineRangeToByteRange } from '../core/edit-diff';
import type { SearchScope } from '../core/types';

export interface UnifiedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each line with prefix: ' ' unchanged, '-' removed, '+' added */
  lines: string[];
  /** Verbatim anchor text from @@ header, e.g. "function greet(name) {" */
  anchor?: string;
}

export interface UnifiedDiff {
  oldFile: string;
  newFile: string;
  hunks: UnifiedDiffHunk[];
}

/**
 * Parse unified diff input into structured format.
 */
export function parseUnifiedDiff(input: string): UnifiedDiff[] {
  const patches = parsePatch(input);
  
  return patches.map(patch => {
    const hunks: UnifiedDiffHunk[] = patch.hunks.map((hunk, idx) => {
      // Use direct hunk properties instead of parsing header string
      const oldStart = hunk.oldStart;
      const oldLines = hunk.oldLines;
      const newStart = hunk.newStart;
      const newLines = hunk.newLines;
      // Extract anchor text from the hunk header (e.g. @@ ... @@ function greet)
      const anchor = extractHunkAnchor(hunk, idx, input);

      return {
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: hunk.lines,
        anchor,
      };
    });

    return {
      oldFile: patch.oldFileName || '',
      newFile: patch.newFileName || '',
      hunks,
    };
  });
}

/**
 * Extract anchor text from a hunk's header line.
 * Looks for text after the final `@@` in the hunk header.
 */
function extractHunkAnchor(
  hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number },
  _hunkIndex: number,
  input: string,
): string | undefined {
  // The diff package may expose the raw header; check for it
  const headerProp = (hunk as Record<string, unknown>).header;
  if (typeof headerProp === 'string') {
    return parseAnchorFromHeader(headerProp);
  }

  // Fallback: search for the hunk header in the raw input
  const headerPattern = `@@ -${hunk.oldStart},?\\d* \\+${hunk.newStart},?\\d* @@`;
  const pattern = new RegExp(`${headerPattern}\\s*(.*?)(?=\\n@@|\\n---|\\n\\+\\+\\+|\\z)`, 'm');

  const matches = input.match(pattern);
  if (matches && matches[1] !== undefined) {
    const anchor = matches[1].trim();
    return anchor || undefined;
  }

  return undefined;
}

/**
 * Parse anchor text from a raw hunk header line.
 * Format: @@ -oldStart,oldLines +newStart,newLines @@ optional anchor text
 */
function parseAnchorFromHeader(header: string): string | undefined {
  const match = header.match(/^@@[^@]*@@\s*(.*)$/);
  if (match && match[1]) {
    const anchor = match[1].trim();
    return anchor || undefined;
  }
  return undefined;
}

/**
 * Search for anchor text in file content using exact substring match.
 * Returns 1-based line number of first match, or null if not found.
 */
export function resolveAnchorToLine(content: string, anchor: string): number | null {
  const idx = content.indexOf(anchor);
  if (idx === -1) return null;
  // Count newlines before idx to get line number
  const prefix = content.slice(0, idx);
  const lineCount = prefix.split('\n').length;
  return lineCount;
}

/**
 * Compute a search window around a hunk's anchor line.
 * Returns SearchScope narrowing the search to anchor ± padding lines,
 * or undefined if the hunk has no anchor (full-file search).
 */
export function computeHunkSearchWindow(
  content: string,
  hunk: UnifiedDiffHunk,
  fuzzyPadding = 20,
): SearchScope | undefined {
  if (!hunk.anchor) return undefined;

  const anchorLine = resolveAnchorToLine(content, hunk.anchor);
  if (anchorLine === null) return undefined;

  const startLine = Math.max(1, anchorLine - fuzzyPadding);
  const endLine = anchorLine + fuzzyPadding;

  const { startIndex, endIndex } = lineRangeToByteRange(content, { startLine, endLine });

  const truncated = hunk.anchor.length > 30 ? hunk.anchor.slice(0, 30) + '...' : hunk.anchor;
  return {
    startIndex,
    endIndex,
    description: `anchor "${truncated}" at line ${anchorLine} ±${fuzzyPadding}`,
    source: 'anchor',
  };
}

export interface EditItemOutput {
  path: string;
  oldText: string;
  newText: string;
}

/**
 * Strip trailing whitespace from hunk lines whose content (after the ' '/'-'/'+' prefix)
 * is pure whitespace. This prevents spurious mismatches when the file uses no trailing
 * spaces on blank lines but the diff has them.
 */
function normalizeHunkLines(lines: string[]): string[] {
  return lines.map(line => {
    if (line.length < 1) return line;
    const prefix = line[0];
    if (prefix !== ' ' && prefix !== '-' && prefix !== '+') return line;
    const content = line.slice(1);
    // If content is pure whitespace, strip it
    if (!content.trim()) return prefix;
    return line;
  });
}

/**
 * Parse unified diff and convert to EditItem-compatible format.
 * 
 * Uses parsePatch from the diff package, then reconstructs oldText/newText
 * from the hunk lines.
 * 
 * - oldText: context lines + removed lines (starting with ' ' or '-'), prefix stripped
 * - newText: context lines + added lines (starting with ' ' or '+'), prefix stripped
 * - Path: newFileName with 'b/' prefix stripped
 * - /dev/null → empty path (handle as new file or deletion)
 */
export function parseUnifiedDiffToEditItems(input: string): EditItemOutput[] {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
  const patches = parsePatch(normalized);

  const results: EditItemOutput[] = [];

  for (const patch of patches) {
    // Determine the path (prefer newFileName, fall back to oldFileName)
    let path = '';

    if (patch.newFileName && patch.newFileName !== '/dev/null') {
      // Strip 'b/' prefix if present
      path = patch.newFileName.replace(/^[ab]\//, '');
    } else if (patch.oldFileName && patch.oldFileName !== '/dev/null') {
      path = patch.oldFileName.replace(/^[ab]\//, '');
    } else if (patch.oldFileName === '/dev/null' && patch.newFileName === '/dev/null') {
      // Both are /dev/null — this is a malformed diff, skip with warning
      continue;
    }

    // Process each hunk
    for (const hunk of patch.hunks) {
      const normalizedLines = normalizeHunkLines(hunk.lines);
      const oldLines: string[] = [];
      const newLines: string[] = [];

      for (const line of normalizedLines) {
        if (line.startsWith('-')) {
          oldLines.push(line.slice(1));
        } else if (line.startsWith('+')) {
          newLines.push(line.slice(1));
        } else if (line.startsWith(' ')) {
          // Context line — appears in both
          oldLines.push(line.slice(1));
          newLines.push(line.slice(1));
        }
        // Lines starting with '\' are no-op headers (ignore)
      }

      const oldText = oldLines.join('\n');
      const newText = newLines.join('\n');

      // Skip no-op hunks (empty oldText and newText with only context)
      // Only skip if there are no actual changes
      const hasRemovals = normalizedLines.some(l => l.startsWith('-'));
      const hasAdditions = normalizedLines.some(l => l.startsWith('+'));
      
      if (!hasRemovals && !hasAdditions) {
        continue; // No-op hunk, skip
      }

      results.push({ path, oldText, newText });
    }
  }

  return results;
}

/**
 * Given a hunk's oldText (context + removals), try to align the context lines
 * with the actual file content. Returns an adjusted oldText if alignment succeeds,
 * or the original oldText if not.
 *
 * This implements aider's make_new_lines_explicit: computes a back-diff between
 * the hunk's before-section and the file, then uses it to update context lines.
 */
export function rebaseHunkContext(oldText: string, newText: string, fileContent: string): { oldText: string; newText: string } {
  // If it already matches, no rebasing needed
  if (fileContent.includes(oldText)) return { oldText, newText };

  // Try stripping trailing whitespace from each context line in oldText
  const adjustedOld = oldText.split('\n').map(l => l.trimEnd()).join('\n');
  if (adjustedOld !== oldText && fileContent.includes(adjustedOld)) {
    const adjustedNew = newText.split('\n').map(l => l.startsWith('+') || l.startsWith('-') ? l : l.trimEnd()).join('\n');
    return { oldText: adjustedOld, newText: adjustedNew };
  }

  // Try diffLines alignment: compute what the file has vs what hunk expects
  const oldLines = oldText.split('\n');
  const fileLines = fileContent.split('\n');

  // Find the closest matching window in the file for our hunk
  let bestStart = -1;
  let bestScore = 0;
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    const window = fileLines.slice(i, i + oldLines.length);
    let matches = 0;
    for (let j = 0; j < oldLines.length; j++) {
      if (oldLines[j].trimEnd() === window[j]?.trimEnd()) matches++;
    }
    const score = matches / oldLines.length;
    if (score > bestScore) { bestScore = score; bestStart = i; }
  }

  // If we found a high-similarity window (>= 0.7), rebase to actual file lines
  if (bestScore >= 0.7 && bestStart !== -1) {
    const rebasedLines = fileLines.slice(bestStart, bestStart + oldLines.length);
    const rebasedOld = rebasedLines.join('\n');
    if (fileContent.includes(rebasedOld)) {
      return { oldText: rebasedOld, newText };
    }
  }

  return { oldText, newText };
}

function buildHunkEditItemFull(lines: string[]): { oldText: string; newText: string } | null {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
    else if (line.startsWith(' ')) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)); }
  }
  if (oldLines.length === 0 && newLines.length === 0) return null;
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

/**
 * Try building an EditItem from the hunk with progressively fewer context lines.
 * Returns the first version whose oldText is found in fileContent, or the
 * full-context version as a fallback (with context rebasing as a last resort).
 */
function buildBestHunkEditItem(
  lines: string[],
  fileContent: string,
): { oldText: string; newText: string } | null {
  // Count leading and trailing context lines
  let leadCtx = 0;
  let trailCtx = 0;

  for (const line of lines) {
    if (line.startsWith(' ')) leadCtx++;
    else break;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(' ')) trailCtx++;
    else break;
  }

  const maxDrop = leadCtx + trailCtx;

  for (let drop = 0; drop <= maxDrop; drop++) {
    for (let dropLead = Math.min(drop, leadCtx); dropLead >= Math.max(0, drop - trailCtx); dropLead--) {
      const dropTrail = drop - dropLead;
    const sliced = dropTrail > 0
      ? lines.slice(dropLead, lines.length - dropTrail)
      : lines.slice(dropLead);

    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of sliced) {
      if (line.startsWith('-')) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1));
      } else if (line.startsWith(' ')) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      }
    }

    if (oldLines.length === 0 && newLines.length === 0) continue;

    const oldText = oldLines.join('\n');
    const newText = newLines.join('\n');

    if (!oldText) continue;

    // If this oldText is found in the file, use it
    if (fileContent.includes(oldText)) {
      return { oldText, newText };
    }
    }
  }

  // No shrinkage succeeded — try context rebasing as a last resort
  const full = buildHunkEditItemFull(lines);
  if (!full) return null;
  return rebaseHunkContext(full.oldText, full.newText, fileContent);
}

/**
 * Parse unified diff and produce EditItems, trying progressively fewer context
 * lines if the full hunk doesn't match the file. Uses aider's apply_partial_hunk
 * strategy: drop context lines from both ends until the changed lines match.
 *
 * Falls back to the standard full-context output if fileContent is not provided
 * or no shrinkage succeeds.
 */
export function parseUnifiedDiffToEditItemsWithShrinkage(
  input: string,
  fileContent: string,
): EditItemOutput[] {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const patches = parsePatch(normalized);
  const results: EditItemOutput[] = [];

  for (const patch of patches) {
    let path = '';
    if (patch.newFileName && patch.newFileName !== '/dev/null') {
      path = patch.newFileName.replace(/^[ab]\//, '');
    } else if (patch.oldFileName && patch.oldFileName !== '/dev/null') {
      path = patch.oldFileName.replace(/^[ab]\//, '');
    }

    for (const hunk of patch.hunks) {
      const normalizedHunkLines = normalizeHunkLines(hunk.lines);

      // Check whether the edit has actual changes
      const hasRemovals = normalizedHunkLines.some(l => l.startsWith('-'));
      const hasAdditions = normalizedHunkLines.some(l => l.startsWith('+'));
      if (!hasRemovals && !hasAdditions) continue;

      const item = buildBestHunkEditItem(normalizedHunkLines, fileContent);
      if (item) results.push({ path, ...item });
    }
  }

  return results;
}