/**
 * Pure helpers for transfer (copy/move) edits: resolving a source anchor
 * range against a pre-transaction snapshot, and building the synthetic
 * hashline EditItems that reuse the existing insert-suffix (`:after`) and
 * delete-suffix (`content: null`) mechanisms in core/hashline-edit.ts.
 */
import { parseTag, tryRebaseAnchor } from "./core/hashline-edit.js";
import type { EditItem, TransferRange } from "./core/types.js";

export interface ResolvedSourceRange {
  startLine: number;
  endLine: number;
  lines: string[];
}

/** Resolve pos/end anchors against LF-normalized, BOM-stripped source
 *  content, tolerating anchor drift the same way hashline edits do. */
export function resolveSourceRange(
  sourceContent: string,
  posStr: string,
  endStr: string,
): { ok: true; value: ResolvedSourceRange } | { ok: false; error: string } {
  let posAnchor: ReturnType<typeof parseTag>;
  let endAnchor: ReturnType<typeof parseTag>;
  try {
    posAnchor = parseTag(posStr);
    endAnchor = parseTag(endStr);
  } catch (err) {
    return {
      ok: false,
      error: `invalid transfer anchor: ${err instanceof Error ? err.message : String(err)}; re-read the source file and retry with fresh anchors`,
    };
  }

  if (posAnchor.line > endAnchor.line) {
    return { ok: false, error: "transfer range.pos must not come after range.end; re-read the source file and retry with fresh anchors" };
  }

  const fileLines = sourceContent.split("\n");
  const startRebase = tryRebaseAnchor(posAnchor, fileLines);
  const endRebase = tryRebaseAnchor(endAnchor, fileLines);
  if (startRebase === null || endRebase === null) {
    return { ok: false, error: "transfer anchor is stale or ambiguous; re-read the source file and retry with fresh anchors" };
  }

  const startLine = startRebase === "exact" ? posAnchor.line : startRebase;
  const endLine = endRebase === "exact" ? endAnchor.line : endRebase;
  if (startLine > endLine) {
    return { ok: false, error: "transfer range inverted after anchor relocation; re-read the source file and retry with fresh anchors" };
  }

  return {
    ok: true,
    value: { startLine, endLine, lines: fileLines.slice(startLine - 1, endLine) },
  };
}

/** Destination-side synthetic hashline edit: insert `sourceLines` immediately
 *  after `afterAnchor`, reusing the existing `:after` insert-suffix branch.
 *  When `afterAnchor` is undefined (destination is a brand-new file), use the
 *  `pos: "EOF"` append_file branch instead, which needs no anchor at all. */
export function buildTransferInsertEdit(afterAnchor: string | undefined, sourceLines: string[], description?: string): EditItem {
  if (afterAnchor === undefined) {
    return {
      hashline: { range: { pos: "EOF", end: "EOF" }, content: sourceLines },
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
