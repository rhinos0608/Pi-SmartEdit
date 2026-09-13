/**
 * Hashline anchor leaf — parsing, formatting, and rebasing of LINE+ID anchors.
 *
 * Verbatim extraction from `src/hashline/hashline-edit.ts` (MS1 split).
 * No logic, hash, or window changes — moves only.
 */

import {
  computeLineHashSync,
  HASHLINE_BIGRAM_RE_SRC,
} from "./hashline";

/**
 * A parsed LINE+ID anchor (e.g., "42ab" → line=42, hash="ab").
 * The line number is 1-based.
 */
export interface Anchor {
  line: number;
  hash: string;
}

/**
 * Resolved operations for hashline-anchored edits.
 *
 * replace_range: replace lines [pos.line .. end.line] with new lines
 * append_at: insert new lines after the anchor line
 * prepend_at: insert new lines before the anchor line
 * append_file: append lines to end of file
 * prepend_file: prepend lines to start of file
 */
export type HashlineEditOp =
  | { op: "replace_range"; pos: Anchor; end: Anchor; lines: string[] }
  | { op: "append_at"; pos: Anchor; lines: string[] }
  | { op: "prepend_at"; pos: Anchor; lines: string[] }
  | { op: "append_file"; lines: string[] }
  | { op: "prepend_file"; lines: string[] };

// ─── Constants ───────────────────────────────────────────────────────────────

/** The ±N line window for anchor rebasing */
export const ANCHOR_REBASE_WINDOW = 5;

// ─── Anchor Parsing ───────────────────────────────────────────────────────────

/** Pre-compiled anchor parsing regex */
export const ANCHOR_RE = new RegExp(`^\\s*[>+\\-*]*\\s*(\\d+)(${HASHLINE_BIGRAM_RE_SRC})`);

/**
 * Regex for Pi-SmartRead's line-number-only anchor format: "42|".
 * Matches one or more digits followed by a pipe separator.
 */
export const LINE_ONLY_ANCHOR_RE = /^\s*(\d+)\|\s*$/;

/**
 * Parse a LINE+ID anchor string (e.g., "42ab" or "  42nd|foo") into its
 * line number and hash components.
 *
 * Also supports Pi-SmartRead's line-number-only format "42|" — when the
 * hash is "|" (pipe), the anchor is treated as a pure line reference
 * without hash validation. The rebase logic skips hash comparison for
 * these anchors.
 *
 * @param ref The anchor string to parse. Leading/trailing whitespace and
 *            common prefix markers (>, +, -, *) are stripped before parsing.
 * @returns The parsed anchor with 1-based line number and hash.
 *          Hash is "|" for line-number-only anchors.
 * @throws Error if the string does not match the LINE+ID pattern.
 */
export function parseTag(ref: string): Anchor {
  const trimmed = ref.trim();

  // Check Pi-SmartRead line-number-only format first: "42|"
  const lineOnlyMatch = trimmed.match(LINE_ONLY_ANCHOR_RE);
  if (lineOnlyMatch) {
    return {
      line: parseInt(lineOnlyMatch[1], 10),
      hash: "|",
    };
  }
  const match = trimmed.match(ANCHOR_RE);

  if (!match) {
    // Provide a helpful error message
    const examples: string[] = [];
    for (let i = 1; i <= 9; i++) {
      examples.push(`${i}st`, `${i}nd`, `${i}rd`, `${i}th`);
    }
    const hint = `Expected format: LINE+HASH (e.g., "42ab", "1st", "3rd"). ` +
      `HASH must be one of: ${HASHLINE_BIGRAM_RE_SRC.replace(/\(\?:/g, "").slice(0, 80)}...`;

    throw new Error(
      `Invalid anchor: "${trimmed}". ${hint}`
    );
  }

  return {
    line: parseInt(match[1], 10),
    hash: match[2],
  };
}

/**
 * Format an anchor back to a LINE+ID string (e.g., "42ab").
 */
export function formatAnchor(anchor: Anchor): string {
  return `${anchor.line}${anchor.hash}`;
}

// ─── Rebase Logic ────────────────────────────────────────────────────────────

/**
 * Check whether a hash anchor matches at the exact line position, or
 * attempt to find it within the rebase window.
 *
 * @param anchor The anchor to rebase.
 * @param fileLines Array of file lines (0-indexed).
 * @param window Search window size (default ANCHOR_REBASE_WINDOW = 5).
 * @returns "exact" if the anchor matches at its requested position.
 *          A line number if the hash was found at a different position within
 *          the window (rebase success).
 *          null if the hash was not found (genuine mismatch).
 *          null if the hash was found at multiple positions within the window
 *          (ambiguous — could be a collision or structural line).
 */
export function tryRebaseAnchor(
  anchor: Anchor,
  fileLines: string[],
  window = ANCHOR_REBASE_WINDOW,
): "exact" | number | null {
  const lineIdx = anchor.line - 1;

  // Bounds check
  if (lineIdx < 0 || lineIdx >= fileLines.length) {
    return null;
  }

  // Line-number-only anchors (hash === "|") skip hash validation.
  // These come from Pi-SmartRead's line-prefixed output format.
  // Accept the anchor at the requested line position without hash check.
  if (anchor.hash === "|") {
    return "exact";
  }

  // Check exact position first
  const exactHash = computeLineHashSync(anchor.line, fileLines[lineIdx]);
  if (exactHash === anchor.hash) {
    return "exact";
  }

  // Search ±window for the hash (excluding the exact position)
  const lo = Math.max(0, anchor.line - 1 - window);
  const hi = Math.min(fileLines.length - 1, anchor.line - 1 + window);

  let found: number | null = null;

  for (let i = lo; i <= hi; i++) {
    if (i === lineIdx) continue; // Skip exact position (already checked)
    if (computeLineHashSync(i + 1, fileLines[i]) !== anchor.hash) continue;
    if (found !== null) return null; // ambiguous — multiple matches
    found = i;
  }

  return found !== null ? found + 1 : null; // Convert back to 1-based
}

/**
 * Attempt to rebase all mismatched anchors within an edit.
 * Returns updated anchors if all mismatches were resolved.
 */
export function tryRebaseAll(
  edits: HashlineEditOp[],
  fileLines: string[],
): {
  allResolved: boolean;
  rebasedEdits: HashlineEditOp[];
  warnings: string[];
  failedEdits: number[];
} {
  const rebasedEdits: HashlineEditOp[] = [];
  const warnings: string[] = [];
  const failedEdits: number[] = [];

  for (let editIdx = 0; editIdx < edits.length; editIdx++) {
    const edit = edits[editIdx];
    const editRebased = rebaseEdit(edit, fileLines);

    if (editRebased.rebased) {
      const rebasedEdit = editRebased.edit;
      if (!rebasedEdit) {
        failedEdits.push(editIdx);
        continue;
      }
      rebasedEdits.push(rebasedEdit);
      const [posAnchor, endAnchor] = getAnchorStrings(edit);
      const rebasedLine = rebasedEdit.op === 'replace_range' ? rebasedEdit.pos.line : -1;
      const endMoved = editRebased.endMoved;
      const originalEndLine = edit.op === 'replace_range' ? edit.end.line : -1;
      warnings.push(
        `Anchor ${posAnchor}${endMoved ? `-${editRebased.endAnchor}` : ""} ` +
        `was rebased to line ${rebasedLine}${endMoved ? ` (was ${originalEndLine})` : ""}.`
      );
    } else if (editRebased.notFound) {
      failedEdits.push(editIdx);
    } else {
      rebasedEdits.push(edit);
    }
  }

  return {
    allResolved: failedEdits.length === 0,
    rebasedEdits,
    warnings,
    failedEdits,
  };
}

// Helper to get anchor strings from an edit
export function getAnchorStrings(edit: HashlineEditOp): [string] | [string, string] {
  if (edit.op === "replace_range") {
    return [formatAnchor(edit.pos), formatAnchor(edit.end)];
  } else if (edit.op === "append_at" || edit.op === "prepend_at") {
    return [formatAnchor(edit.pos)];
  }
  return ["file"];
}

// Helper to rebase a single edit
export function rebaseEdit(edit: HashlineEditOp, fileLines: string[]): {
  rebased: boolean;
  notFound?: boolean;
  rebaseFailed?: boolean;
  edit?: HashlineEditOp;
  endMoved?: boolean;
  endAnchor?: string;
} {
  switch (edit.op) {
    case "replace_range": {
      const newPos = tryRebaseAnchor(edit.pos, fileLines);
      if (newPos === null) {
        return { rebased: false, notFound: true };
      }
      if (newPos === "exact") {
        // Check end anchor too
        const newEnd = tryRebaseAnchor(edit.end, fileLines);
        if (newEnd === null) {
          return { rebased: false, notFound: true };
        }
        if (newEnd === "exact" || (typeof newEnd === "number" && newEnd === edit.end.line)) {
          return { rebased: false }; // No change needed
        }
        // End anchor moved — need to adjust the range
        const newEndLine = typeof newEnd === "number" ? newEnd : edit.end.line;
        return {
          rebased: true,
          edit: { ...edit, end: { line: newEndLine, hash: edit.end.hash } },
          endMoved: true,
          endAnchor: formatAnchor(edit.end),
        };
      }
      // pos rebased
      if (typeof newPos !== "number") return { rebased: false };
      const newEnd = tryRebaseAnchor(edit.end, fileLines);
      return {
        rebased: true,
        edit: {
          op: "replace_range",
          pos: { line: newPos, hash: edit.pos.hash },
          end: { line: typeof newEnd === "number" ? newEnd : edit.end.line, hash: edit.end.hash },
          lines: edit.lines,
        },
      };
    }
    case "append_at":
    case "prepend_at": {
      const rebased = tryRebaseAnchor(edit.pos, fileLines);
      if (rebased === null) return { rebased: false, notFound: true };
      if (rebased === "exact") return { rebased: false };
      if (typeof rebased !== "number") return { rebased: false };
      return {
        rebased: true,
        edit: { op: edit.op, pos: { line: rebased, hash: edit.pos.hash }, lines: edit.lines },
      };
    }
    default:
      return { rebased: false };
  }
}
