/**
 * Snapshot-proven hashline recovery.
 *
 * A short LINE+ID hash is a freshness hint, not enough evidence to relocate a
 * mutation. Recovery therefore uses the retained read snapshot as the source
 * of truth and only accepts a uniform line shift that preserves observed
 * neighbouring context. This mirrors the fail-closed recovery shape used by
 * current oh-my-pi without importing its snapshot-tag DSL.
 */
import { SmartEditError } from "../core/errors";
import type { FileSnapshot } from "../core/types";
import {
  ANCHOR_REBASE_WINDOW,
  formatAnchor,
  type Anchor,
  type HashlineEditOp,
} from "./hashline-anchor";

export interface HashlineRecoveryResult {
  recovered: boolean;
  edit?: HashlineEditOp;
  warning?: string;
  reason?: string;
}

export interface HashlineProvenanceResult {
  valid: boolean;
  missing: string[];
}

export class HashlineAnchorProvenanceError extends SmartEditError {
  readonly anchors: string[];

  constructor(anchors: string[]) {
    const joined = anchors.map((anchor) => `"${anchor}"`).join(", ");
    super(
      `Edit rejected: ${joined} ${anchors.length === 1 ? "was" : "were"} not present in the latest hashline read snapshot. ` +
      `LINE+ID anchors must be copied as complete tokens from one read row; do not combine a line number with a hash suffix from another row. ` +
      `Re-read the target lines and retry with the fresh anchors.`,
      "HASHLINE_ANCHOR_PROVENANCE",
    );
    this.name = "HashlineAnchorProvenanceError";
    this.anchors = [...anchors];
  }
}

function authoredAnchors(edit: HashlineEditOp): Anchor[] {
  switch (edit.op) {
    case "replace_range":
      return edit.pos.line === edit.end.line ? [edit.pos] : [edit.pos, edit.end];
    case "append_at":
    case "prepend_at":
      return [edit.pos];
    case "append_file":
    case "prepend_file":
      return [];
  }
}

function snapshotLines(snapshot: FileSnapshot): Map<number, string> | null {
  const anchors = snapshot.hashline?.anchors;
  if (!anchors) return null;
  const byLine = new Map<number, string>();
  for (const entry of anchors.values()) {
    const existing = byLine.get(entry.line);
    if (existing !== undefined && existing !== entry.text) return null;
    byLine.set(entry.line, entry.text);
  }
  return byLine;
}

/** Verify that every model-authored LINE+ID token was actually emitted by the
 * retained read snapshot. This catches token-splicing mistakes before either
 * direct application or recovery can reinterpret them. */
export function checkHashlineSnapshotProvenance(
  edits: readonly HashlineEditOp[],
  snapshot: FileSnapshot | null,
): HashlineProvenanceResult {
  if (!snapshot?.hashline?.anchors) return { valid: true, missing: [] };
  const missing = new Set<string>();
  for (const edit of edits) {
    for (const anchor of authoredAnchors(edit)) {
      const token = formatAnchor(anchor);
      const entry = snapshot.hashline.anchors.get(token);
      if (!entry || entry.line !== anchor.line) missing.add(token);
    }
  }
  return { valid: missing.size === 0, missing: [...missing] };
}

function targetLines(edit: HashlineEditOp): { start: number; end: number } | null {
  switch (edit.op) {
    case "replace_range":
      return { start: edit.pos.line, end: edit.end.line };
    case "append_at":
    case "prepend_at":
      return { start: edit.pos.line, end: edit.pos.line };
    case "append_file":
    case "prepend_file":
      return null;
  }
}

function matchesAtOffset(
  source: Map<number, string>,
  current: readonly string[],
  start: number,
  end: number,
  offset: number,
): boolean {
  for (let line = start; line <= end; line++) {
    const oldText = source.get(line);
    const mapped = line + offset;
    if (oldText === undefined || mapped < 1 || mapped > current.length) return false;
    if (current[mapped - 1] !== oldText) return false;
  }
  return true;
}

/**
 * Require context outside the edited span. Matching only the target row would
 * recreate the old "unique short hash within ·1" bug. At least one observed
 * adjacent row must move by the same offset; when both sides were observed,
 * both must agree.
 */
function contextMatches(
  source: Map<number, string>,
  current: readonly string[],
  start: number,
  end: number,
  offset: number,
): boolean {
  const neighbors = [start - 1, end + 1].filter((line) => source.has(line));
  if (neighbors.length === 0) return false;
  for (const line of neighbors) {
    const mapped = line + offset;
    if (mapped < 1 || mapped > current.length) return false;
    if (current[mapped - 1] !== source.get(line)) return false;
  }
  return true;
}

function applyOffset(edit: HashlineEditOp, offset: number): HashlineEditOp {
  switch (edit.op) {
    case "replace_range":
      return {
        ...edit,
        pos: { ...edit.pos, line: edit.pos.line + offset },
        end: { ...edit.end, line: edit.end.line + offset },
      };
    case "append_at":
    case "prepend_at":
      return { ...edit, pos: { ...edit.pos, line: edit.pos.line + offset } };
    case "append_file":
    case "prepend_file":
      return edit;
  }
}

/**
 * Recover one stale hashline operation from the retained read snapshot.
 *
 * Proof requirements:
 *  - authored boundary tokens existed verbatim in that snapshot;
 *  - every selected snapshot line is still byte-identical at one candidate
 *    offset within the small recovery window;
 *  - all selected lines share one uniform offset;
 *  - at least one observed neighbouring line, and both when available, moves
 *    by the same offset;
 *  - exactly one offset satisfies all of the above.
 */
export function tryRecoverHashlineEdit(
  edit: HashlineEditOp,
  currentLines: readonly string[],
  snapshot: FileSnapshot | null,
  window = ANCHOR_REBASE_WINDOW,
): HashlineRecoveryResult {
  if (!snapshot?.hashline?.anchors) {
    return { recovered: false, reason: "no retained hashline read snapshot" };
  }

  const provenance = checkHashlineSnapshotProvenance([edit], snapshot);
  if (!provenance.valid) {
    return {
      recovered: false,
      reason: `anchor token not present in retained snapshot: ${provenance.missing.join(", ")}`,
    };
  }

  const span = targetLines(edit);
  if (!span) return { recovered: false, reason: "file-level operation does not require recovery" };
  if (span.start < 1 || span.end < span.start || span.end - span.start > 100_000) {
    return { recovered: false, reason: "invalid or excessive recovery span" };
  }

  const source = snapshotLines(snapshot);
  if (!source) return { recovered: false, reason: "retained snapshot is inconsistent" };

  const candidates: number[] = [];
  for (let offset = -window; offset <= window; offset++) {
    if (offset === 0) continue;
    if (!matchesAtOffset(source, currentLines, span.start, span.end, offset)) continue;
    if (!contextMatches(source, currentLines, span.start, span.end, offset)) continue;
    candidates.push(offset);
  }

  if (candidates.length !== 1) {
    return {
      recovered: false,
      reason: candidates.length === 0
        ? "no snapshot-proven uniform shift with neighbouring context"
        : "multiple snapshot-proven shifts remain ambiguous",
    };
  }

  const offset = candidates[0];
  const recovered = applyOffset(edit, offset);
  return {
    recovered: true,
    edit: recovered,
    warning: `Snapshot-proven hashline recovery shifted ${formatAnchor(authoredAnchors(edit)[0])} by ${offset > 0 ? "+" : ""}${offset} line(s).`,
  };
}

export function tryRecoverHashlineEdits(
  edits: readonly HashlineEditOp[],
  currentLines: readonly string[],
  snapshot: FileSnapshot | null,
): {
  allResolved: boolean;
  recoveredEdits: HashlineEditOp[];
  warnings: string[];
  failedEdits: number[];
  reasons: string[];
} {
  const recoveredEdits: HashlineEditOp[] = [];
  const warnings: string[] = [];
  const failedEdits: number[] = [];
  const reasons: string[] = [];

  for (let index = 0; index < edits.length; index++) {
    const result = tryRecoverHashlineEdit(edits[index], currentLines, snapshot);
    if (!result.recovered || !result.edit) {
      failedEdits.push(index);
      reasons.push(result.reason ?? "recovery proof failed");
      continue;
    }
    recoveredEdits.push(result.edit);
    if (result.warning) warnings.push(result.warning);
  }

  return {
    allResolved: failedEdits.length === 0,
    recoveredEdits,
    warnings,
    failedEdits,
    reasons,
  };
}
