/**
 * Hashline validation + mismatch-error leaf — anchor validation and
 * HashlineMismatchError formatting.
 *
 * Verbatim extraction from `src/hashline/hashline-edit.ts` (MS3 split).
 * No logic, threshold, or message changes — moves only.
 */

import {
  computeLineHashSync,
} from "./hashline";

import { SmartEditError } from "../core/errors";
import {
  type HashlineEditOp,
} from "./hashline-anchor";

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
 * Result of validating hashline anchors against file content.
 */
export interface ValidationResult {
  valid: boolean;
  mismatches: HashMismatch[];
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

// ─── Error Formatting ─────────────────────────────────────────────────────────

/**
 * Formatted error thrown when hashline anchors don't match the file content.
 * Contains both a user-facing message (for the model) and a CLI-facing message.
 */
export class HashlineMismatchError extends SmartEditError {
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
    const modelMessage = buildModelMessage(mismatches, fileLines, ambiguous);
    const cliMessage = buildCliMessage(mismatches, fileLines, ambiguous);
    super(modelMessage, 'HASHLINE_MISMATCH');
    this.name = "HashlineMismatchError";
    this.mismatches = mismatches;
    this.ambiguous = ambiguous;
    this.modelMessage = modelMessage;
    this.cliMessage = cliMessage;
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

  msg += `\nRe-read the target lines to refresh the complete LINE+ID tokens, then retry. Do not splice a line number and hash suffix from different read rows.`;

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
