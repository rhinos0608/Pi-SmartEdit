/**
 * Transfer planning: frozen destination planning plus the literal
 * source/delete and destination/insert mutation layer.
 *
 * Pure extraction from `src/transfer-edit.ts` (`planTransfer`,
 * `buildTransferDescription`, `applyTransferLiteral`,
 * `applyTransferDeleteLiteral`, `buildTransferInsertEdit`,
 * `buildTransferDeleteEdit`). No behavior change.
 *
 * `ResolvedTransfer` is deliberately independent of
 * `EditItem`/`HashlineEditMetadata`: it carries only plain data (paths,
 * anchors, resolved lines). Conversion to hashline `EditItem`s happens at
 * the call site (`src/patch.ts`) via the builders below.
 */
import type { EditItem, TransferRange } from "../core/types.js";

/** Internal destination union for a planned transfer. The public contract
 *  only accepts an `after` anchor or `start` (prepend); `before`/`end` and
 *  `:after`/`:before` suffix tricks are rejected at validation. `end`
 *  (append) exists internally for the omitted-positioning new-file case,
 *  where start/end are equivalent on an empty destination. */
export type TransferDest
  = { kind: "after"; anchor: string }
  | { kind: "before"; anchor: string }
  | { kind: "start" }
  | { kind: "end" };

/** A transfer op validated and mapped to an internal destination. */
export interface TransferPlan {
  op: "copy" | "move";
  from: string;
  range: TransferRange;
  to: string;
  dest: TransferDest;
  toIsNewFile: boolean;
}

/** A planned transfer with its source lines resolved from the
 *  pre-transaction snapshot (logical text, BOM/CRLF-free). Plain data
 *  only — no `EditItem` or hashline metadata. */
export interface ResolvedTransfer extends TransferPlan {
  startLine: number;
  endLine: number;
  sourceLines: string[];
}

/** Validate a transfer request and map it to an internal destination.
 *  Throws a transfer-specific Error (message matches /transfer.*after/i for
 *  the new-file case) so resolvers can reject pre-write with a conflict. */
export function planTransfer(input: {
  op: "copy" | "move";
  from: string;
  range: TransferRange;
  to: string;
  after?: string;
  toIsNewFile: boolean;
}): TransferPlan {
  const { op, from, range, to, after, toIsNewFile } = input;
  if (toIsNewFile && after !== undefined) {
    throw new Error(
      `transfer destination "${to}" is a new file and cannot accept \`after\`: omit positioning (start/end are equivalent on an empty destination)`,
    );
  }
  let dest: TransferDest;
  if (after === undefined) {
    dest = { kind: "end" };
  } else if (after === "start") {
    dest = { kind: "start" };
  } else if (after === "end" || after === "EOF" || after === "BOF" || after === "before") {
    throw new Error(`transfer \`after\` sentinel "${after}" is not accepted: supply a destination anchor or \`start\``);
  } else if (after.includes(":")) {
    throw new Error(`transfer \`after\` anchor "${after}" must be a bare anchor: suffix tricks are not accepted`);
  } else {
    dest = { kind: "after", anchor: after };
  }
  return { op, from, range, to, dest, toIsNewFile };
}

/** Bind resolved source lines to a plan, producing the plain-data
 *  `ResolvedTransfer` used by the mutation planner. */
export function bindResolvedTransfer(
  plan: TransferPlan,
  resolved: { startLine: number; endLine: number; sourceLines: string[] },
): ResolvedTransfer {
  return {
    ...plan,
    startLine: resolved.startLine,
    endLine: resolved.endLine,
    sourceLines: resolved.sourceLines,
  };
}

/** Literal transfer mutations as plain data (no `EditItem`): a
 *  destination insert of the resolved source lines plus, for `move`, a
 *  source delete of the original range. */
export interface TransferMutations {
  /** Human-readable provenance description for the synthesized edits. */
  description: string;
  /** Destination insert: `afterAnchor` is `undefined` for the brand-new-file
   *  (EOF append) case, `"start"` for prepend, otherwise the bare anchor. */
  insert: { afterAnchor: string | undefined; lines: string[] };
  /** Source delete for `move` only; `null` for `copy`. */
  erase: { pos: string; end: string } | null;
}

export function planTransferMutations(
  resolved: ResolvedTransfer,
  description: string,
): TransferMutations {
  const afterAnchor = resolved.dest.kind === "after"
    ? resolved.dest.anchor
    : resolved.dest.kind === "start"
      ? "start"
      : undefined;
  return {
    description,
    insert: { afterAnchor, lines: resolved.sourceLines },
    erase: resolved.op === "move" ? { pos: resolved.range.pos, end: resolved.range.end } : null,
  };
}

/** Combine a caller description with transfer provenance for an EditItem.
 *  Absent caller text yields generated provenance alone; present caller
 *  text is preserved verbatim with provenance appended. */
export function buildTransferDescription(request: {
  op: "copy" | "move";
  from: string;
  range: TransferRange;
  description?: string;
}): string {
  const provenance = `${request.op} from ${request.from}:${request.range.pos}-${request.range.end}`;
  const caller = request.description;
  if (typeof caller === "string" && caller.length > 0) return `${caller} (${provenance})`;
  return provenance;
}

/** Literal transfer applier: appends `linesToAppend` to `baseContent`
 *  preserving multiplicity, EOL style, and BOM. Deliberately bypasses the
 *  generic hashline idempotence (`noopEdits`) layer — a literal duplicate
 *  copy/move lands every requested line. Generic `applyHashlineEdits`
 *  suppression semantics are unchanged. */
export function applyTransferLiteral(
  baseContent: string,
  linesToAppend: string[],
): { lines: string; noopEdits?: undefined } {
  const eol = baseContent.includes("\r\n") ? "\r\n" : "\n";
  const bom = baseContent.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom.length > 0 ? baseContent.slice(1) : baseContent;
  const addition = linesToAppend.join(eol);
  if (body.length === 0) return { lines: bom + addition };
  if (body.endsWith(eol)) return { lines: bom + body + addition };
  return { lines: bom + body + eol + addition };
}

/** Literal transfer delete: removes logical lines [startLine, endLine]
 *  (1-based, BOM/CRLF-preserving) from `baseContent`. Never touches a
 *  leading BOM. */
export function applyTransferDeleteLiteral(
  baseContent: string,
  startLine: number,
  endLine: number,
): { lines: string } {
  const eol = baseContent.includes("\r\n") ? "\r\n" : "\n";
  const bom = baseContent.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom.length > 0 ? baseContent.slice(1) : baseContent;
  const trailingEol = body.endsWith(eol) ? eol : "";
  const core = trailingEol.length > 0 ? body.slice(0, -trailingEol.length) : body;
  const lines = core.length === 0 ? [] : core.split(eol);
  lines.splice(startLine - 1, endLine - startLine + 1);
  return { lines: bom + lines.join(eol) + trailingEol };
}

/** Destination-side synthetic hashline edit: insert `sourceLines` at the
 *  planned destination, reusing the existing `:after` insert-suffix branch.
 *  Internal dest union: `undefined` (brand-new file) and `end`/`EOF` use the
 *  `pos: "EOF"` append_file branch; `start` uses the prepend_file branch; a
 *  trailing `:before` passes through to the prepend_at branch; anything else
 *  inserts after the given anchor. */
export function buildTransferInsertEdit(afterAnchor: string | undefined, sourceLines: string[], description?: string): EditItem {
  if (afterAnchor === undefined || afterAnchor === "end" || afterAnchor === "EOF") {
    return {
      hashline: { range: { pos: "EOF", end: "EOF" }, content: sourceLines },
      ...(description !== undefined ? { description } : {}),
    };
  }
  if (afterAnchor === "start") {
    return {
      hashline: { range: { pos: "start", end: "start" }, content: sourceLines },
      ...(description !== undefined ? { description } : {}),
    };
  }
  if (afterAnchor.endsWith(":before")) {
    return {
      hashline: { range: { pos: afterAnchor, end: afterAnchor }, content: sourceLines },
      ...(description !== undefined ? { description } : {}),
    };
  }
  return {
    hashline: { range: { pos: `${afterAnchor}:after`, end: `${afterAnchor}:after` }, content: sourceLines },
    ...(description !== undefined ? { description } : {}),
  };
}

/** Source-side synthetic hashline edit (move only): delete `range`, reusing
 *  the existing `content: null` delete-suffix branch. */
export function buildTransferDeleteEdit(range: TransferRange, description?: string): EditItem {
  return {
    hashline: { range: { pos: range.pos, end: range.end }, content: null },
    ...(description !== undefined ? { description } : {}),
  };
}
