/**
 * Transfer resolution for copy/move.
 *
 * Transfer runs behind workspace evidence + transaction freshness checks, so
 * anchors are exact references to the observed preimage. Unlike hashline edit
 * recovery, transfer has no independent retained read snapshot to prove a
 * relocation; stale source/destination anchors therefore fail closed.
 */
import { parseTag } from "../hashline/hashline-edit.js";
import { computeLineHashSync } from "../hashline/hashline.js";
import { normalizeToLF, stripBom } from "../core/edit-diff.js";

function resolveExactAnchor(
  anchor: ReturnType<typeof parseTag>,
  fileLines: readonly string[],
): number | null {
  if (anchor.line < 1 || anchor.line > fileLines.length) return null;
  const text = fileLines[anchor.line - 1];
  if (text === undefined) return null;
  return computeLineHashSync(anchor.line, text) === anchor.hash ? anchor.line : null;
}

export interface ResolvedSourceRange {
  startLine: number;
  endLine: number;
  lines: string[];
}

/** Resolve pos/end anchors exactly against logical source text: BOM-stripped,
 *  LF-normalized. Raw snapshot bytes (BOM/CRLF) are a freshness concern, not
 *  an addressing concern — anchors always address logical lines, so a
 *  first-line copy/move never carries the file BOM and CRLF never shifts
 *  line numbers. */
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
  // Transfer already runs behind transaction/evidence freshness checks. A
  // source anchor that no longer matches its observed line is therefore stale,
  // not a license to search nearby by a two-letter hash.
  const startLine = resolveExactAnchor(posAnchor, fileLines);
  const endLine = resolveExactAnchor(endAnchor, fileLines);
  if (startLine === null || endLine === null) {
    return { ok: false, error: "transfer anchor is stale; re-read the source file and retry with fresh anchors" };
  }

  return {
    ok: true,
    value: { startLine, endLine, lines: fileLines.slice(startLine - 1, endLine) },
  };
}

/**
 * Resolve a destination `after` anchor exactly against logical destination
 * lines. Returns the 1-based line, `"start"` for the prepend sentinel, or
 * `null` when omitted, malformed, or stale. Higher-level transfer planning
 * turns a stale required destination into a pre-write conflict/failure.
 */
export function resolveDestination(
  after: string | undefined,
  destLogicalLines: readonly string[],
): number | "start" | null {
  if (after === undefined) return null;
  if (after === "start") return "start";
  try {
    const anchor = parseTag(after);
    return resolveExactAnchor(anchor, destLogicalLines);
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
