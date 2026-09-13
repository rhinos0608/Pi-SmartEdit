/**
 * Transfer resolution: frozen anchor-resolution semantics for copy/move.
 *
 * Pure extraction from `src/transfer-edit.ts` (`resolveSourceRange`) plus
 * the destination-anchor rebasing previously inlined in `src/patch.ts`
 * (touching-span and duplicate-destination checks). No behavior change.
 */
import { parseTag, tryRebaseAnchor } from "../hashline/hashline-edit.js";
import { normalizeToLF, stripBom } from "../core/edit-diff.js";

export interface ResolvedSourceRange {
  startLine: number;
  endLine: number;
  lines: string[];
}

/** Resolve pos/end anchors against the logical source text: BOM-stripped,
 *  LF-normalized. Raw snapshot bytes (BOM/CRLF) are a freshness concern, not
 *  an addressing concern — anchors always address logical lines, so a
 *  first-line copy/move never carries the file BOM and CRLF never shifts
 *  line numbers. Tolerates anchor drift the same way hashline edits do. */
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

  const { text: withoutBom } = stripBom(sourceContent);
  const fileLines = normalizeToLF(withoutBom).split("\n");
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

/**
 * Rebase a destination `after` anchor against logical destination lines.
 *
 * Returns the 1-based line the anchor resolves to, `"start"` for the
 * prepend sentinel, or `null` when there is nothing to resolve
 * (`after` omitted) or the anchor is unparsable/stale. `null` preserves
 * the historical `patch.ts` behavior of skipping the touching-span and
 * duplicate-destination checks when the anchor cannot be rebased, rather
 * than failing the transfer on destination resolution alone.
 */
export function resolveDestination(
  after: string | undefined,
  destLogicalLines: readonly string[],
): number | "start" | null {
  if (after === undefined) return null;
  if (after === "start") return "start";
  try {
    const anchor = parseTag(after);
    const rebased = tryRebaseAnchor(anchor, [...destLogicalLines]);
    if (rebased === "exact") return anchor.line;
    if (typeof rebased === "number") return rebased;
    return null;
  } catch {
    return null;
  }
}

export interface ResolvedTransferSource {
  startLine: number;
  endLine: number;
  sourceLines: string[];
}

/**
 * Resolve a transfer's source span and destination insert point together.
 *
 * Source errors are returned as `{ok:false}` (callers map them to the
 * historical failed/stage outcome); an unresolvable destination yields
 * `afterLine: null` so callers skip the span gates exactly as before.
 */
export function resolveTransfer(args: {
  sourceContent: string;
  destLogicalLines: readonly string[] | null;
  pos: string;
  end: string;
  after: string | undefined;
}): { ok: true; value: ResolvedTransferSource & { afterLine: number | "start" | null } } | { ok: false; error: string } {
  const resolved = resolveSourceRange(args.sourceContent, args.pos, args.end);
  if (!resolved.ok) return resolved;
  const afterLine = args.destLogicalLines === null
    ? null
    : resolveDestination(args.after, args.destLogicalLines);
  return {
    ok: true,
    value: {
      startLine: resolved.value.startLine,
      endLine: resolved.value.endLine,
      sourceLines: resolved.value.lines,
      afterLine,
    },
  };
}
