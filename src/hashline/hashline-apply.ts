/**
 * Hashline apply leaf — bottom-up edit application with noop detection.
 *
 * Verbatim extraction from `src/hashline/hashline-edit.ts` (MS4 split).
 * No logic, ordering, or noop-change — moves only.
 */

import {
  type HashlineEditOp,
} from "./hashline-anchor";

/**
 * Result of applying hashline edits.
 */
export interface ApplyResult {
  /** The resulting file content */
  lines: string;
  /** 1-based line number of the first changed line */
  firstChangedLine: number | undefined;
  /** Warnings about rebased anchors or fallthrough behavior */
  warnings?: string[];
  /** Edits that had no effect (old == new) */
  noopEdits?: Array<{ editIndex: number; loc: string; current: string }>;
}

// ─── Apply Logic ──────────────────────────────────────────────────────────────

/**
 * Apply hashline edits to file content.
 *
 * Preconditions: all hashes must be validated (call validateHashlineEdits first).
 *
 * Edits are sorted bottom-up (highest line first) so that earlier edits don't
 * invalidate the line numbers of later edits.
 *
 * @param text Original file content (with any line endings).
 * @param edits Resolved hashline edit operations.
 * @returns The modified content and first-changed line number.
 */
export function applyHashlineEdits(
  text: string,
  edits: HashlineEditOp[],
): ApplyResult {
  const fileLines = text.split(/\r?\n/);

  // Detect line ending style from original text
  const lineEnding = /\r\n/.test(text) ? "\r\n" : "\n";

  // Sort bottom-up: highest line first
  const sortedEdits = [...edits].sort((a, b) => {
    const aLine = getEditEndLine(a, fileLines.length);
    const bLine = getEditEndLine(b, fileLines.length);
    return bLine - aLine; // descending — apply from bottom to top
  });

  let firstChanged: number | undefined;
  const warnings: string[] = [];
  const noopEdits: ApplyResult["noopEdits"] = [];

  for (let i = 0; i < sortedEdits.length; i++) {
    const edit = sortedEdits[i];
    const result = applySingleEdit(fileLines, edit, i);

    if (result.noop) {
      noopEdits.push({
        editIndex: i,
        loc: formatEditLoc(edit, fileLines.length),
        current: result.current ?? "<empty>",
      });
    } else {
      if (firstChanged === undefined || (result.firstChangedLine ?? Infinity) < firstChanged) {
        firstChanged = result.firstChangedLine;
      }
    }
  }

  return {
    lines: fileLines.join(lineEnding),
    firstChangedLine: firstChanged,
    warnings: warnings.length > 0 ? warnings : undefined,
    noopEdits: noopEdits.length > 0 ? noopEdits : undefined,
  };
}

/** Get the effective end line of an edit for sorting purposes */
function getEditEndLine(edit: HashlineEditOp, fileLen: number): number {
  switch (edit.op) {
    case "replace_range": return edit.end.line;
    case "append_at": return edit.pos.line;
    case "prepend_at": return edit.pos.line;
    case "append_file": return fileLen + 1;
    case "prepend_file": return 0;
  }
}

/** Format an edit's location for noop reporting */
function formatEditLoc(edit: HashlineEditOp, fileLen: number): string {
  switch (edit.op) {
    case "replace_range": return `lines ${edit.pos.line}-${edit.end.line}`;
    case "append_at": return `after line ${edit.pos.line}`;
    case "prepend_at": return `before line ${edit.pos.line}`;
    case "append_file": return `end of file`;
    case "prepend_file": return `start of file`;
  }
}

function linesEqual(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

/** Apply a single edit and return changed line info */
function applySingleEdit(
  fileLines: string[],
  edit: HashlineEditOp,
  editIndex: number,
): {
  noop: boolean;
  firstChangedLine?: number;
  current?: string;
} {
  switch (edit.op) {
    case "replace_range": {
      const startIdx = edit.pos.line - 1;
      const endIdx = edit.end.line - 1;

      if (startIdx < 0 || startIdx >= fileLines.length || endIdx < 0 || endIdx >= fileLines.length) {
        throw new Error(
          `Range out of bounds: lines ${edit.pos.line}-${edit.end.line} ` +
          `are outside file range (1-${fileLines.length}).`
        );
      }

      // Check for noop: old content equals new content
      const oldContent = fileLines.slice(startIdx, endIdx + 1).join("\n");
      const newContent = edit.lines.join("\n");
      if (oldContent === newContent) {
        return { noop: true, firstChangedLine: startIdx + 1, current: oldContent };
      }

      // Splice in the new lines
      fileLines.splice(startIdx, endIdx - startIdx + 1, ...edit.lines);
      return { noop: false, firstChangedLine: startIdx + 1 };
    }

    case "append_at": {
      const afterIdx = edit.pos.line - 1;
      if (afterIdx < 0 || afterIdx >= fileLines.length) {
        throw new Error(`Line ${edit.pos.line} is out of bounds.`);
      }

      if (edit.lines.length === 0) {
        return { noop: true, firstChangedLine: edit.pos.line + 1, current: "(empty)" };
      }

      const existingAfter = fileLines.slice(afterIdx + 1, afterIdx + 1 + edit.lines.length);
      if (linesEqual(existingAfter, edit.lines)) {
        return { noop: true, firstChangedLine: edit.pos.line + 1, current: edit.lines.join("\n") };
      }

      fileLines.splice(afterIdx + 1, 0, ...edit.lines);
      return { noop: false, firstChangedLine: edit.pos.line + 1 };
    }

    case "prepend_at": {
      const beforeIdx = edit.pos.line - 1;
      if (beforeIdx < 0 || beforeIdx >= fileLines.length) {
        throw new Error(`Line ${edit.pos.line} is out of bounds.`);
      }

      if (edit.lines.length === 0) {
        return { noop: true, firstChangedLine: edit.pos.line, current: "(empty)" };
      }

      const existingBefore = fileLines.slice(beforeIdx - edit.lines.length, beforeIdx);
      if (beforeIdx >= edit.lines.length && linesEqual(existingBefore, edit.lines)) {
        return { noop: true, firstChangedLine: edit.pos.line - edit.lines.length, current: edit.lines.join("\n") };
      }

      fileLines.splice(beforeIdx, 0, ...edit.lines);
      return { noop: false, firstChangedLine: edit.pos.line };
    }

    case "append_file": {
      if (edit.lines.length === 0) {
        return { noop: true, current: "(empty)" };
      }
      const existingTail = fileLines.slice(fileLines.length - edit.lines.length);
      if (linesEqual(existingTail, edit.lines)) {
        return { noop: true, current: edit.lines.join("\n") };
      }
      // A genuinely empty file splits to a single "" line; pushing onto it
      // would leave a spurious leading blank line ahead of the appended
      // content, so replace rather than append in that one case.
      if (fileLines.length === 1 && fileLines[0] === "") {
        fileLines.splice(0, 1, ...edit.lines);
        return { noop: false, firstChangedLine: 1 };
      }
      fileLines.push(...edit.lines);
      return { noop: false, firstChangedLine: fileLines.length - edit.lines.length + 1 };
    }

    case "prepend_file": {
      if (edit.lines.length === 0) {
        return { noop: true, current: "(empty)" };
      }
      const existingHead = fileLines.slice(0, edit.lines.length);
      if (linesEqual(existingHead, edit.lines)) {
        return { noop: true, current: edit.lines.join("\n") };
      }
      fileLines.unshift(...edit.lines);
      return { noop: false, firstChangedLine: 1 };
    }
  }
}
