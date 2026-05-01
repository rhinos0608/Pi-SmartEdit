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

export interface UnifiedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each line with prefix: ' ' unchanged, '-' removed, '+' added */
  lines: string[];
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
    const hunks: UnifiedDiffHunk[] = patch.hunks.map(hunk => {
      // Use direct hunk properties instead of parsing header string
      const oldStart = hunk.oldStart;
      const oldLines = hunk.oldLines;
      const newStart = hunk.newStart;
      const newLines = hunk.newLines;

      return {
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: hunk.lines,
      };
    });

    return {
      oldFile: patch.oldFileName || '',
      newFile: patch.newFileName || '',
      hunks,
    };
  });
}

export interface EditItemOutput {
  path: string;
  oldText: string;
  newText: string;
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
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
    }

    // Process each hunk
    for (const hunk of patch.hunks) {
      const oldLines: string[] = [];
      const newLines: string[] = [];

      for (const line of hunk.lines) {
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
      const hasRemovals = hunk.lines.some(l => l.startsWith('-'));
      const hasAdditions = hunk.lines.some(l => l.startsWith('+'));
      
      if (!hasRemovals && !hasAdditions) {
        continue; // No-op hunk, skip
      }

      results.push({ path, oldText, newText });
    }
  }

  return results;
}