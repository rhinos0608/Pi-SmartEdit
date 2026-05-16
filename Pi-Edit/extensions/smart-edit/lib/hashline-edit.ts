/**
 * Hashline-anchored edit application layer.
 *
 * Mirrors oh-my-pi's hashline.ts (can1357/oh-my-pi).
 *
 * Core concept: instead of asking the LLM to reproduce text (oldText),
 * edits reference LINE+ID anchors (e.g., "42ab") that are pre-computed
 * on read. Hashes serve as freshness checks — if the file changed since
 */

import {
  computeLineHashSync,
  HASHLINE_BIGRAM_RE_SRC,
  HASHLINE_CONTENT_SEPARATOR,
} from "./hashline";

import type { EditAnchor, FileSnapshot } from "./types";

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

/**
 * A hash mismatch between the expected anchor and the actual file line.
 */
export interface HashMismatch {
  /** 1-based line number that has the mismatch */
  line: number;
  /** The hash the edit expected (from the anchor) */
  expected: string;
  /** The hash found in the file */
  actual: string;
  /** The text of the line in the file */
  text: string;
  /** The corrected anchor for this line (computed from the actual content) */
  correctedAnchor: string;
}

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

/**
 * Result of validating hashline anchors against file content.
 */
export interface ValidationResult {
  valid: boolean;
  mismatches: HashMismatch[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** The ±N line window for anchor rebasing */
export const ANCHOR_REBASE_WINDOW = 5;

// ─── Anchor Parsing ───────────────────────────────────────────────────────────

/** Pre-compiled anchor parsing regex */
const ANCHOR_RE = new RegExp(`^\\s*[>+\\-*]*\\s*(\\d+)(${HASHLINE_BIGRAM_RE_SRC})`);

/**
 * Regex for Pi-SmartRead's line-number-only anchor format: "42|".
 * Matches one or more digits followed by a pipe separator.
 */
const LINE_ONLY_ANCHOR_RE = /^\s*(\d+)\|\s*$/;

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
function getAnchorStrings(edit: HashlineEditOp): [string] | [string, string] {
  if (edit.op === "replace_range") {
    return [formatAnchor(edit.pos), formatAnchor(edit.end)];
  } else if (edit.op === "append_at" || edit.op === "prepend_at") {
    return [formatAnchor(edit.pos)];
  }
  return ["file"];
}

// Helper to rebase a single edit
function rebaseEdit(edit: HashlineEditOp, fileLines: string[]): {
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

// ─── Content Normalization ───────────────────────────────────────────────────

/**
 * Normalize the content from a hashline edit input.
 *
 * Accepts clean string[] payloads, single multiline strings, or content that
 * was pasted back from read/search output with hashline prefixes.
 */
const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HASHLINE_CONTENT_SEPARATOR_RE_SRC = regexEscape(HASHLINE_CONTENT_SEPARATOR);
const HASHLINE_PREFIX_RE = new RegExp(
  `^\\s*(?:>>>|>>)?\\s*(?:[+*]\\s*)?(?:\\d+${HASHLINE_BIGRAM_RE_SRC}|\\d+)${HASHLINE_CONTENT_SEPARATOR_RE_SRC}`,
);
const HASHLINE_PLUS_PREFIX_RE = new RegExp(
  `^\\s*(?:>>>|>>)?\\s*\\+\\s*(?:\\d+${HASHLINE_BIGRAM_RE_SRC}|\\d+)${HASHLINE_CONTENT_SEPARATOR_RE_SRC}`,
);
const DIFF_PLUS_RE = /^[+](?![+])/;
const READ_TRUNCATION_NOTICE_RE = /^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bUse :L?\d+/;

interface LinePrefixStats {
  nonEmpty: number;
  hashPrefixCount: number;
  diffPlusHashPrefixCount: number;
  diffPlusCount: number;
}

function collectLinePrefixStats(lines: string[]): LinePrefixStats {
  const stats: LinePrefixStats = {
    nonEmpty: 0,
    hashPrefixCount: 0,
    diffPlusHashPrefixCount: 0,
    diffPlusCount: 0,
  };

  for (const line of lines) {
    if (line.length === 0 || READ_TRUNCATION_NOTICE_RE.test(line)) continue;
    stats.nonEmpty++;
    if (HASHLINE_PREFIX_RE.test(line)) stats.hashPrefixCount++;
    if (HASHLINE_PLUS_PREFIX_RE.test(line)) stats.diffPlusHashPrefixCount++;
    if (DIFF_PLUS_RE.test(line)) stats.diffPlusCount++;
  }

  return stats;
}

function stripLeadingHashlinePrefixes(line: string): string {
  let result = line;
  let previous: string;
  do {
    previous = result;
    result = result.replace(HASHLINE_PREFIX_RE, "");
  } while (result !== previous);
  return result;
}

export function stripNewLinePrefixes(lines: string[]): string[] {
  const stats = collectLinePrefixStats(lines);
  if (stats.nonEmpty === 0) return lines;

  const stripHash = stats.hashPrefixCount > 0 && stats.hashPrefixCount === stats.nonEmpty;
  const stripPlus =
    !stripHash &&
    stats.diffPlusHashPrefixCount === 0 &&
    stats.diffPlusCount > 0 &&
    stats.diffPlusCount >= stats.nonEmpty * 0.5;

  if (!stripHash && !stripPlus && stats.diffPlusHashPrefixCount === 0) return lines;

  return lines
    .filter(line => !READ_TRUNCATION_NOTICE_RE.test(line))
    .map(line => {
      if (stripHash) return stripLeadingHashlinePrefixes(line);
      if (stripPlus) return line.replace(DIFF_PLUS_RE, "");
      if (stats.diffPlusHashPrefixCount > 0 && HASHLINE_PLUS_PREFIX_RE.test(line)) {
        return line.replace(HASHLINE_PREFIX_RE, "");
      }
      return line;
    });
}

export function hashlineParseText(
  content: string[] | string | null | undefined,
): string[] {
  if (content == null) return [];
  const lines = typeof content === "string"
    ? content.replace(/\r/g, "").replace(/\n$/, "").split("\n")
    : content;
  return stripNewLinePrefixes(lines);
}

// ─── Edit Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve raw hashline edit input (from the LLM/tool call) into internal
 * HashlineEditOp structures.
 *
 * @param rawEdits Array of raw hashline edits from the tool input.
 * @param allowInsertOps If true, parse "after" and "before" markers in the
 *                       anchor range to generate append_at/prepend_at ops.
 */
export function resolveHashlineEdits(
  rawEdits: Array<{
    anchor?: {
      symbol?: { name: string; kind?: string; line?: number };
      range: { pos: string; end: string };
    };
    content?: string[] | string | null;
  }>,
  allowInsertOps = false,
): HashlineEditOp[] {
  return rawEdits.map(raw => {
    const lines = hashlineParseText(raw.content);

    if (allowInsertOps && typeof raw.anchor?.range?.pos === "string") {
      const posStr = raw.anchor.range.pos;
      if (posStr.endsWith(":after")) {
        const base = posStr.slice(0, -5);
        const baseAnchor = parseTag(base);
        return { op: "append_at" as const, pos: baseAnchor, lines };
      }
      if (posStr.endsWith(":before")) {
        const base = posStr.slice(0, -6);
        const baseAnchor = parseTag(base);
        return { op: "prepend_at" as const, pos: baseAnchor, lines };
      }
      if (posStr === "EOF" || posStr === "end") {
        return { op: "append_file" as const, lines };
      }
      if (posStr === "start" || posStr === "BOF") {
        return { op: "prepend_file" as const, lines };
      }
    }

    if (!raw.anchor?.range) {
      throw new Error("hashline edit requires an anchor with range field");
    }

    const pos = parseTag(raw.anchor.range.pos);
    const end = parseTag(raw.anchor.range.end);

    if (pos.line > end.line) {
      throw new Error(
        `Invalid range: start line ${pos.line} must be <= end line ${end.line}. ` +
        `pos="${raw.anchor.range.pos}", end="${raw.anchor.range.end}".`
      );
    }

    return { op: "replace_range" as const, pos, end, lines };
  });
}

// ─── Hash Validation ──────────────────────────────────────────────────────────

/**
 * Validate all hashline anchors against the current file content.
 * Returns validation result with list of mismatches.
 *
 * For replace_range ops: validates ALL lines in the range (pos, interior, end).
 * For append_at/prepend_at: validates the anchor line.
 * For append_file/prepend_file: no anchors to validate.
 */
export function validateHashlineEdits(
  edits: HashlineEditOp[],
  fileLines: string[],
): ValidationResult {
  const mismatches: HashMismatch[] = [];

  for (let editIdx = 0; editIdx < edits.length; editIdx++) {
    const edit = edits[editIdx];
    const editMismatches = validateEditAnchors(edit, fileLines);
    mismatches.push(...editMismatches);
  }

  return {
    valid: mismatches.length === 0,
    mismatches,
  };
}

/** Validate anchors for a single edit operation */
function validateEditAnchors(
  edit: HashlineEditOp,
  fileLines: string[],
): HashMismatch[] {
  const mismatches: HashMismatch[] = [];

  switch (edit.op) {
    case "replace_range": {
      // Validate every line in the range (pos, interior, end)
      for (let ln = edit.pos.line; ln <= edit.end.line; ln++) {
        const lineIdx = ln - 1;

        if (lineIdx < 0 || lineIdx >= fileLines.length) {
          mismatches.push({
            line: ln,
            expected: ln === edit.pos.line ? edit.pos.hash : edit.end.hash,
            actual: "<out of bounds>",
            text: "<missing>",
            correctedAnchor: "<missing>",
          });
          continue;
        }

        const actualHash = computeLineHashSync(ln, fileLines[lineIdx]);

        // For single-line replace, both pos and end are the same
        // For multi-line, interior lines: use the hash of the actual content
        let expectedHash: string;
        if (edit.pos.line === edit.end.line) {
          // Single-line edit: both anchors refer to the same line
          expectedHash = edit.pos.hash; // Could be pos or end — same hash
        } else if (ln === edit.pos.line) {
          expectedHash = edit.pos.hash;
        } else if (ln === edit.end.line) {
          expectedHash = edit.end.hash;
        } else {
          // Interior line: use the actual content hash
          expectedHash = actualHash;
        }

        // Line-number-only anchors (hash === "|") skip hash validation.
        // These come from Pi-SmartRead's line-prefixed output.
        if (expectedHash !== "|" && actualHash !== expectedHash) {
          // Check if this is a genuine mismatch or expected (interior line)
          // For interior lines, if expected == actual that's fine
          // For boundary lines, mismatch is a genuine error
          mismatches.push({
            line: ln,
            expected: expectedHash,
            actual: actualHash,
            text: fileLines[lineIdx],
            correctedAnchor: `${ln}${actualHash}`,
          });
        }
      }
      break;
    }

    case "append_at":
    case "prepend_at": {
      const ln = edit.pos.line;
      const lineIdx = ln - 1;

      if (lineIdx < 0 || lineIdx >= fileLines.length) {
        mismatches.push({
          line: ln,
          expected: edit.pos.hash,
          actual: "<out of bounds>",
          text: "<missing>",
          correctedAnchor: "<missing>",
        });
      } else {
        const actualHash = computeLineHashSync(ln, fileLines[lineIdx]);
        // Line-number-only anchors (hash === "|") skip hash validation.
        // These come from Pi-SmartRead's line-prefixed output.
        if (edit.pos.hash !== "|" && actualHash !== edit.pos.hash) {
          mismatches.push({
            line: ln,
            expected: edit.pos.hash,
            actual: actualHash,
            text: fileLines[lineIdx],
            correctedAnchor: `${ln}${actualHash}`,
          });
        }
      }
      break;
    }

    case "append_file":
    case "prepend_file":
      // No anchors to validate for file-level operations
      break;
  }

  return mismatches;
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
    lines: fileLines.join("\n"),
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

// ─── Error Formatting ─────────────────────────────────────────────────────────

/**
 * Formatted error thrown when hashline anchors don't match the file content.
 * Contains both a user-facing message (for the model) and a CLI-facing message.
 */
export class HashlineMismatchError extends Error {
  /** Mismatched anchor details */
  readonly mismatches: HashMismatch[];

  /** Whether rebasing was attempted and ambiguous */
  readonly ambiguous: boolean;

  /** CLI message (with file context) */
  readonly cliMessage: string;

  /** Model message (LLM-friendly, with corrected anchors) */
  readonly modelMessage: string;

  constructor(
    mismatches: HashMismatch[],
    fileLines: string[],
    ambiguous = false,
  ) {
    super();
    this.mismatches = mismatches;
    this.ambiguous = ambiguous;
    this.name = "HashlineMismatchError";

    // Build CLI message
    this.cliMessage = buildCliMessage(mismatches, fileLines, ambiguous);

    // Build model message (LLM-friendly)
    this.modelMessage = buildModelMessage(mismatches, fileLines, ambiguous);

    this.message = this.modelMessage; // Error.message shows the model-friendly version
  }
}

function buildCliMessage(
  mismatches: HashMismatch[],
  fileLines: string[],
  ambiguous: boolean,
): string {
  if (ambiguous) {
    const anchor = mismatches[0]?.expected ?? "";
    return (
      `Edit rejected: ambiguous anchor "${anchor}" — hash found at multiple positions.\n` +
      `Re-read the file for current content before editing.`
    );
  }

  const lines: string[] = [
    `Edit rejected: ${mismatches.length} line(s) have changed since the last read (marked *).`,
    `The edit was NOT applied. Re-read the file and try again.`,
    ``,
    `Current file context:`,
  ];

  for (const mm of mismatches) {
    lines.push(...formatMismatchContext(mm, fileLines, 1));
    lines.push("");
  }

  return lines.slice(0, -1).join("\n");
}

function buildModelMessage(
  mismatches: HashMismatch[],
  fileLines: string[],
  ambiguous: boolean,
): string {
  if (ambiguous) {
    const anchor = mismatches[0]?.expected ?? "";
    return (
      `Edit rejected: ambiguous anchor "${anchor}" — hash found at multiple nearby lines. ` +
      `Re-read the file to get the correct anchors, then retry.`
    );
  }

  const count = mismatches.length;
  const verb = count === 1 ? "has" : "have";
  const noun = count === 1 ? "line" : "lines";

  let msg = `Edit rejected: ${count} ${noun} ${verb} changed since the last read (marked with *). ` +
    `The edit was NOT applied.\n\n` +
    `Current file context:\n`;

  for (const mm of mismatches) {
    msg += `${formatMismatchContext(mm, fileLines, 1).join("\n")}\n\n`;
  }

  msg +=
    `Corrected anchors:\n`;

  for (const mm of mismatches) {
    msg += `  ${mm.correctedAnchor}  (was ${mm.line}${mm.expected}, now ${mm.line}${mm.actual})\n`;
  }

  msg += `\nUse the corrected anchors above and retry without re-reading.`;

  return msg;
}

function formatMismatchContext(
  mm: HashMismatch,
  fileLines: string[],
  contextLines: number,
): string[] {
  if (mm.correctedAnchor === "<missing>" || mm.text === "<missing>") {
    return [
      `  *<missing>|  <missing>`,
      `    ↳ hash mismatch: expected ${mm.expected}, got ${mm.actual}`,
    ];
  }

  const startLine = Math.max(1, mm.line - contextLines);
  const endLine = Math.min(fileLines.length, mm.line + contextLines);
  const context: string[] = [];

  for (let line = startLine; line <= endLine; line++) {
    const text = fileLines[line - 1] ?? "";
    const prefix = line === mm.line ? "*" : " ";
    const anchor = line === mm.line ? mm.correctedAnchor : `${line}${computeLineHashSync(line, text)}`;
    context.push(`  ${prefix}${anchor}|  ${text}`);
  }

  context.push(`    ↳ hash mismatch: expected ${mm.expected}, got ${mm.actual}`);
  return context;
}

/**
 * Get a human-readable description of an edit's location.
 */
export function describeEditLocation(edit: HashlineEditOp): string {
  switch (edit.op) {
    case "replace_range":
      return `lines ${edit.pos.line}-${edit.end.line} (anchors ${formatAnchor(edit.pos)}-${formatAnchor(edit.end)})`;
    case "append_at":
      return `after line ${edit.pos.line} (anchor ${formatAnchor(edit.pos)})`;
    case "prepend_at":
      return `before line ${edit.pos.line} (anchor ${formatAnchor(edit.pos)})`;
    case "append_file":
      return `end of file`;
    case "prepend_file":
      return `start of file`;
  }
}

// ─── Symbol Anchor Parsing ────────────────────────────────────────────────────

/**
 * Parse a symbol anchor from hashline input into EditAnchor format.
 * Used by the scoped fallback path to resolve AST scopes.
 */
export function parseSymbolAnchor(
  symbol?: { name: string; kind?: string; line?: number },
): EditAnchor | undefined {
  if (!symbol) return undefined;
  return {
    symbolName: symbol.name,
    symbolKind: symbol.kind,
    symbolLine: symbol.line,
  };
}

/**
 * Raw hashline edit input from the LLM/tool call.
 * This is the external-facing type; internally we convert to HashlineEditOp.
 */
export interface HashlineEditInput {
  anchor?: {
    /** Optional AST symbol scoping hint.
     *  If provided, stale hashline anchors fall back to scoped fuzzy matching
     *  within the symbol's byte range instead of the full 4-tier pipeline. */
    symbol?: {
      /** Name of the enclosing symbol (function, class, etc.) */
      name: string;
      /** Kind of symbol (e.g., 'function', 'method', 'class'). */
      kind?: string;
      /** 1-based line number hint for where the symbol's name appears. */
      line?: number;
    };
    /** Hashline-anchored range */
    range: {
      /** Start anchor: LINE+HASH of the first line to edit (inclusive). */
      pos: string;
      /** End anchor: LINE+HASH of the last line to edit (inclusive). */
      end: string;
    };
  };
  /** Replacement lines (string[] — one per logical line) or null/undefined to delete. */
  content?: string[] | string | null;
}

// ─── Fallback Metrics ────────────────────────────────────────────────────────

/**
 * Track which resolution tier was used for each hashline edit.
 * Used for development visibility and A/B comparison.
 */
export type FallbackTier =
  | "hashline-direct"       // Fast path: hashes matched immediately
  | "hashline-rebased"      // Anchors rebased within ±5 window
  | "scoped-fallback"       // Hash stale, symbol resolved → scoped 4-tier match
  | "full-fuzzy-fallback"   // All hashline paths failed → full 4-tier pipeline
  | "hash-mismatch-reject"; // Genuine mismatch, all paths failed → error thrown

export interface HashlineMetrics {
  hashlineDirect: number;
  hashlineRebased: number;
  scopedFallback: number;
  fullFuzzyFallback: number;
  hashMismatchRejects: number;
}

/** Module-level metrics accumulator. Reset between batches or sessions. */
export const hashlineMetrics: HashlineMetrics = {
  hashlineDirect: 0,
  hashlineRebased: 0,
  scopedFallback: 0,
  fullFuzzyFallback: 0,
  hashMismatchRejects: 0,
};

/**
 * Record a tier usage and return the updated count.
 * Development visibility only — does not affect edit behavior.
 */
export function recordFallbackTier(tier: FallbackTier): void {
  switch (tier) {
    case "hashline-direct":        hashlineMetrics.hashlineDirect++; break;
    case "hashline-rebased":       hashlineMetrics.hashlineRebased++; break;
    case "scoped-fallback":        hashlineMetrics.scopedFallback++; break;
    case "full-fuzzy-fallback":     hashlineMetrics.fullFuzzyFallback++; break;
    case "hash-mismatch-reject":   hashlineMetrics.hashMismatchRejects++; break;
  }
}

/**
 * Get a copy of current metrics for reporting.
 */
export function getHashlineMetrics(): HashlineMetrics {
  return { ...hashlineMetrics };
}

/**
 * Reset metrics to zero. Call between benchmark runs.
 */
export function resetHashlineMetrics(): void {
  hashlineMetrics.hashlineDirect = 0;
  hashlineMetrics.hashlineRebased = 0;
  hashlineMetrics.scopedFallback = 0;
  hashlineMetrics.fullFuzzyFallback = 0;
  hashlineMetrics.hashMismatchRejects = 0;
}

// ─── applyHashlinePath — Main Routing Function ─────────────────────────────

/**
 * Result of applyHashlinePath.
 * Contains the resulting content AND which fallback tier was used.
 */
export interface ApplyHashlinePathResult {
  /** The resulting file content */
  newContent: string;
  /** Which resolution tier succeeded */
  tier: Exclude<FallbackTier, "hash-mismatch-reject">;
  /** Warning messages (rebased anchors, fallthrough notes) */
  warnings: string[];
  /** 1-based line number of the first changed line */
  firstChangedLine: number | undefined;
  /** The resolved HashlineEditOp(s) that were applied (for caller bookkeeping) */
  appliedOps: HashlineEditOp[];
}

/**
 * Main routing function for hashline-anchored edits.
 *
 * Tries in order:
 *  1. Hashline direct apply (fast path, ~90% of edits)
 *  2. Hashline rebase (file shifted, ±5 window)
 *  3. Scoped fallback (hash stale, symbol provided → AST-scoped 4-tier)
 *  4. Full fuzzy fallback (all hashline paths failed → full 4-tier safety net)
 *
 * @param input     Parsed hashline input (from LLM/tool call)
 * @param fileContent Current file content (LF-normalized)
 * @param snapshot   FileSnapshot from read cache (for oldText reconstruction)
 * @param resolveScopeFn  Function to resolve EditAnchor → SearchScope via AST.
 *                       Signature: (anchor: EditAnchor, content: string, path: string)
 *                       → Promise<SearchScope | null>
 * @param findTextFn   The 4-tier findText function from edit-diff.ts.
 * @param detectIndentFn The detectIndentation function from edit-diff.ts.
 * @returns ApplyHashlinePathResult with newContent, tier, warnings, firstChangedLine.
 * @throws HashlineMismatchError if hashes genuinely don't match and no fallback resolves.
 */
export async function applyHashlinePath(
  input: HashlineEditInput,
  fileContent: string,
  snapshot: FileSnapshot | null,
  resolveScopeFn: (
    anchor: EditAnchor,
    content: string,
    path: string,
  ) => Promise<{ startIndex: number; endIndex: number; description: string } | null>,
  findTextFn: (
    content: string,
    oldText: string,
    indentStyle: { char: "\t" | " "; width: number },
    startOffset?: number,
    scope?: { startIndex: number; endIndex: number; description: string },
  ) => {
    found: boolean;
    index: number;
    matchLength: number;
    tier: string;
    usedFuzzyMatch: boolean;
    matchedText: string;
    matchNote?: string;
  },
  detectIndentFn: (content: string) => { char: "\t" | " "; width: number },
): Promise<ApplyHashlinePathResult> {
  const warnings: string[] = [];

  // ── Step 1: Resolve hashline edits ──────────────────────────────────────────
  const resolvedEdits = resolveHashlineEdits([{ ...input, content: input.content ?? null }], true);
  if (resolvedEdits.length === 0) {
    return {
      newContent: fileContent,
      tier: "hashline-direct",
      warnings: [],
      firstChangedLine: undefined,
      appliedOps: [],
    };
  }
  // ── Normalize anchor line numbers for offset reads ────────────────
  // Anchors are built with absolute line numbers (via buildHashlineAnchors(lines, readOffset))
  // so no adjustment needed — the parsed anchor line numbers already match the file.
  // ── Step 2: Validate all hashes ─────────────────────────────────────────────
  const fileLines = fileContent.split("\n");
  const validation = validateHashlineEdits(resolvedEdits, fileLines);

  if (validation.valid) {
    // ── FAST PATH: All hashes match ──────────────────────────────────────────
    const result = applyHashlineEdits(fileContent, resolvedEdits);
    recordFallbackTier("hashline-direct");
    return {
      newContent: result.lines,
      tier: "hashline-direct",
      warnings: result.warnings ?? [],
      firstChangedLine: result.firstChangedLine,
      appliedOps: resolvedEdits,
    };
  }

  // ── Step 3: Try rebasing mismatched anchors ────────────────────────────────
  const rebaseResult = tryRebaseAll(resolvedEdits, fileLines);

  if (rebaseResult.allResolved) {
    // Rebased successfully — apply with warning
    const result = applyHashlineEdits(fileContent, rebaseResult.rebasedEdits);
    recordFallbackTier("hashline-rebased");
    return {
      newContent: result.lines,
      tier: "hashline-rebased",
      warnings: [...rebaseResult.warnings],
      firstChangedLine: result.firstChangedLine,
      appliedOps: rebaseResult.rebasedEdits,
    };
  }

  // ── Step 4: Try scoped fallback (AST symbol + 4-tier within scope) ─────────
  if (input.anchor?.symbol && resolveScopeFn) {
    const symbolAnchor = parseSymbolAnchor(input.anchor.symbol);
    if (symbolAnchor) {
      const scope = await resolveScopeFn(symbolAnchor, fileContent, "");

      if (scope) {
        // Reconstruct oldText from cache
        const posStr = input.anchor.range.pos;
        const endStr = input.anchor.range.end;
        const oldText = snapshot
          ? reconstructOldText(snapshot, posStr, endStr)
          : null;

        if (oldText !== null) {
          // Run 4-tier matching within symbol scope
          const indentStyle = detectIndentFn(fileContent);
          const match = findTextFn(
            fileContent,
            oldText,
            indentStyle,
            0,
            scope,
          );

          if (match.found) {
            // Apply the match
            const newLines = hashlineParseText(input.content ?? []) ?? [];
            const newContent = applyMatchInPlace(fileContent, match, newLines);
            const firstChangedLine = countLinesUpToIndex(fileContent, match.index);

            recordFallbackTier("scoped-fallback");
            warnings.push(
              `Hashline anchors stale; resolved via AST scoping to "${scope.description}". ` +
              `Matched via ${match.tier} tier${match.matchNote ? ` (${match.matchNote})` : ""}.`
            );

            return {
              newContent,
              tier: "scoped-fallback",
              warnings,
              firstChangedLine,
              appliedOps: resolvedEdits,
            };
          }
        }
      }
    }
  }

  // ── Step 5: Full fuzzy fallback (full 4-tier pipeline) ───────────────────────
  const posStr = input.anchor?.range?.pos ?? "";
  const endStr = input.anchor?.range?.end ?? "";
  const oldText = snapshot ? reconstructOldText(snapshot, posStr, endStr) : null;

  if (oldText === null) {
    // Cannot reconstruct oldText — throw mismatch error with corrected anchors
    recordFallbackTier("hash-mismatch-reject");
    throw new HashlineMismatchError(validation.mismatches, fileLines, false);
  }

  // Run full 4-tier pipeline (no scope restriction)
  const indentStyle = detectIndentFn(fileContent);
  const match = findTextFn(fileContent, oldText, indentStyle);

  if (!match.found) {
    // Even full fuzzy failed — throw mismatch error
    recordFallbackTier("hash-mismatch-reject");
    throw new HashlineMismatchError(validation.mismatches, fileLines, false);
  }

  // Apply the match
  const newLines = hashlineParseText(input.content ?? []) ?? [];
  const newContent = applyMatchInPlace(fileContent, match, newLines);
  const firstChangedLine = countLinesUpToIndex(fileContent, match.index);

  recordFallbackTier("full-fuzzy-fallback");
  warnings.push(
    `Edit fell through to full fuzzy matching (hashline anchors stale and ` +
    `AST scoping unavailable). Matched via ${match.tier} tier${match.matchNote ? ` (${match.matchNote})` : ""}.`
  );

  return {
    newContent,
    tier: "full-fuzzy-fallback",
    warnings,
    firstChangedLine,
    appliedOps: resolvedEdits,
  };
}

// ─── Fallback Helpers ────────────────────────────────────────────────────────

/**
 * Apply a match result to content, replacing matchedText with newLines.
 * Returns the modified content.
 */
function applyMatchInPlace(
  content: string,
  match: { index: number; matchLength: number; matchedText: string },
  newLines: string[],
): string {
  const before = content.slice(0, match.index);
  const after = content.slice(match.index + match.matchLength);
  return before + newLines.join("\n") + after;
}

/**
 * Count lines up to (but not including) a byte offset.
 * Used to report firstChangedLine for fuzzy fallback results.
 */
function countLinesUpToIndex(content: string, byteIndex: number): number {
  const prefix = content.slice(0, byteIndex);
  return (prefix.match(/\n/g) ?? []).length + 1;
}

// ─── Reconstruct oldText from cache ─────────────────────────────────────────

/**
 * Reconstruct the oldText that should have been matched, using the hashline
 * anchor data stored in the read cache.
 *
 * This is used by the fallback path when hashline validation fails but we
 * still need to run the 4-tier fuzzy matcher.
 *
 * @param snapshot   The FileSnapshot from the read cache.
 * @param posAnchor  Start anchor string (e.g., "42ab")
 * @param endAnchor  End anchor string (e.g., "45cd")
 * @returns The reconstructed oldText or null if anchors not found in cache.
 */
export function reconstructOldText(
  snapshot: FileSnapshot,
  posAnchor: string,
  endAnchor: string,
): string | null {
  if (!snapshot.hashline?.anchors) {
    return null;
  }

  const anchors = snapshot.hashline.anchors;

  // Find the range of lines between pos and end anchors
  const posEntry = anchors.get(posAnchor);
  const endEntry = anchors.get(endAnchor);

  if (!posEntry || !endEntry) {
    return null;
  }

  const startLine = posEntry.line;
  const endLine = endEntry.line;

  // Collect the text for all lines in the range
  const lines: string[] = [];
  for (let ln = startLine; ln <= endLine; ln++) {
    for (const [key, val] of anchors) {
      if (val.line === ln) {
        lines.push(val.text);
        break;
      }
    }
  }

  return lines.join("\n");
}

/**
 * Reconstruct the oldText from a FileSnapshot using line numbers directly.
 */
export function reconstructOldTextByLine(
  snapshot: FileSnapshot,
  startLine: number,
  endLine: number,
): string | null {
  if (!snapshot.hashline?.anchors) {
    return null;
  }

  const lines: string[] = [];
  for (let ln = startLine; ln <= endLine; ln++) {
    for (const [, val] of snapshot.hashline.anchors) {
      if (val.line === ln) {
        lines.push(val.text);
        break;
      }
    }
  }

  return lines.length === endLine - startLine + 1 ? lines.join("\n") : null;
}

// ─── Format detection ─────────────────────────────────────────────────────────

/**
 * Detect whether a raw edit object uses the hashline format or legacy format.
 */
export type EditFormat = "hashline" | "legacy";

export function detectEditFormat(edit: Record<string, unknown>): EditFormat {
  if (
    edit.anchor &&
    typeof edit.anchor === "object" &&
    "range" in (edit.anchor as Record<string, unknown>)
  ) {
    return "hashline";
  }
  if (typeof edit.oldText === "string") {
    return "legacy";
  }
  throw new Error(
    `Unknown edit format. Expected either:\n` +
    `  hashline: { anchor: { range: { pos: "42ab", end: "45cd" } }, content: [...] }\n` +
    `  legacy:   { oldText: "...", newText: "..." }`
  );
}
