import { readFile as fsReadFile } from "fs/promises";
import { resolve, relative } from "path";
import { buildHashlineAnchors } from "../lib/hashline";
import { recordRead, recordReadSession, getAllSessionPaths } from "../lib/read-cache";
import { normalizeToLF } from "../lib/edit-diff";
import { findTextLineRange } from "./anchor-resolution.js";
import type { EditItem } from "../lib/types";

/**
 * Read a range of lines from a file and return them as a string.
 * Returns the lines with their line numbers for context.
 */
function readLinesWithContext(
  lines: string[],
  startLine: number,
  endLine: number,
  contextLines: number = 5,
): string {
  const totalLines = lines.length;
  // Expand range to include context lines
  const ctxStart = Math.max(1, startLine - contextLines);
  const ctxEnd = Math.min(totalLines, endLine + contextLines);

  const result: string[] = [];
  for (let i = ctxStart - 1; i < ctxEnd; i++) {
    const lineNum = i + 1;
    const marker = (lineNum >= startLine && lineNum <= endLine) ? '>>>' : '   ';
    result.push(`${marker} ${lineNum.toString().padStart(4)}: ${lines[i]}`);
  }
  return result.join('\n');
}

/**
 * After a failed edit, re-read the file from disk and build an enhanced
 * error message that includes the current file content around the edit
 * location. Also updates the read cache with the fresh content.
 */
export async function reReadAfterFailure(
  absolutePath: string,
  path: string,
  cwd: string,
  edits: EditItem[],
  error: Error,
  useHashlineEditing: boolean,
): Promise<Error> {
  let currentContent: string;
  try {
    currentContent = (await fsReadFile(absolutePath)).toString('utf-8');
  } catch {
    // Can't re-read — return original error
    return error;
  }

  // Update the read cache with the fresh content so the user can retry
  const lines = currentContent.split('\n');
  const hashline = useHashlineEditing
    ? await buildHashlineAnchors(lines)
    : undefined;
  recordRead(path, cwd, currentContent, false, hashline);
  // Also update session reads so range coverage doesn't reject the retry
  recordReadSession(path, cwd, 1, -1, lines.length, "reReadAfterFailure");

  // Build context snippets for each edit that failed
  const contextParts: string[] = [];
  for (const edit of edits) {
    if (!edit.oldText) continue;

    // Try to find where this oldText should be
    const lineRange = findTextLineRange(currentContent, edit.oldText);
    if (lineRange) {
      const context = readLinesWithContext(lines, lineRange.startLine, lineRange.endLine);
      contextParts.push(
        `Edit target (lines ${lineRange.startLine}–${lineRange.endLine}):\n${context}`
      );
    }
  }

  // If no line ranges found, show the whole file (up to first 100 lines)
  if (contextParts.length === 0) {
    const previewLines = lines.slice(0, 100);
    contextParts.push(
      `File preview (first ${previewLines.length} lines):\n` +
      previewLines.map((line, i) => `     ${(i + 1).toString().padStart(4)}: ${line}`).join('\n')
    );
  }

  const contextStr = contextParts.join('\n\n---\n\n');
  const enhancedMessage = `${error.message}\n\n📖 Current file content around edit location:\n\n${contextStr}`;

  return new Error(enhancedMessage);
}

/**
 * Check if any recently-read files in this session contain oldText from the failing edits.
 * Returns a hint string to append to the error, or empty string if no candidates found.
 */
export async function buildMultiFileFallbackHint(
  failingPath: string,
  edits: EditItem[],
  cwd: string,
): Promise<string> {
  const allPaths = getAllSessionPaths();
  const candidates: string[] = [];
  const failingResolved = resolve(failingPath);

  // Limit search to first 30 session files to avoid O(n) disk reads on every failure
  const MAX_SEARCH_FILES = 30;
  const searchPaths = allPaths.length > MAX_SEARCH_FILES
    ? allPaths.filter(p => p !== failingPath).slice(0, MAX_SEARCH_FILES)
    : allPaths;

  for (const filePath of searchPaths) {
    const resolved = resolve(filePath);
    if (resolved === failingResolved) continue;

    let content: string;
    try {
      content = await fsReadFile(resolved, 'utf-8');
    } catch {
      // File not accessible — skip
      continue;
    }

    const normalizedContent = normalizeToLF(content);

    for (const edit of edits) {
      if (!edit.oldText?.trim()) continue;

      if (normalizedContent.includes(edit.oldText) ||
          normalizedContent.includes(edit.oldText.trim())) {
        if (!candidates.includes(resolved)) {
          candidates.push(resolved);
        }
      }
    }
  }

  if (candidates.length === 0) return '';

  const relCandidates = candidates.map(c => relative(cwd, c) || c);

  if (relCandidates.length === 1) {
    return `\n\nNote: The search text was found in a different file: ${relCandidates[0]}\n` +
           `Did you mean to edit that file instead?`;
  }
  return `\n\nNote: The search text was found in ${relCandidates.length} other files:` +
         relCandidates.map(f => `\n  - ${f}`).join('') +
         `\nDid you mean to edit one of those files instead?`;
}
