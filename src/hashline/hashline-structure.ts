/**
 * Language-aware structural guard for snapshot-proven hashline recovery.
 *
 * Textual recovery proves that observed bytes moved coherently. When a full
 * read snapshot and an AST are available, this adds a second proof: the moved
 * span must still live under the same enclosing symbol path. This prevents an
 * identical-looking block in a different function/class from becoming a
 * recovery target.
 */
import type { AstResolverLike } from "../anchor/anchor-resolution.js";
import type { FileSnapshot, SymbolRef } from "../core/types.js";
import { SmartEditError } from "../core/errors.js";
import type { HashlineEditOp } from "./hashline-anchor.js";

export type StructuralRecoveryCheck =
  | { checked: false; ok: true; reason: string }
  | { checked: true; ok: true; fingerprint: string }
  | { checked: true; ok: false; reason: string; sourceFingerprint: string; currentFingerprint: string };

export class HashlineStructuralContextError extends SmartEditError {
  constructor(reason: string) {
    super(
      `Edit rejected: snapshot-proven text moved into a different structural context (${reason}). Re-read the target lines and retry with fresh anchors.`,
      "HASHLINE_STRUCTURAL_CONTEXT",
    );
    this.name = "HashlineStructuralContextError";
  }
}

function targetSpan(edit: HashlineEditOp): { start: number; end: number } | null {
  switch (edit.op) {
    case "replace_range": return { start: edit.pos.line, end: edit.end.line };
    case "append_at":
    case "prepend_at": return { start: edit.pos.line, end: edit.pos.line };
    case "append_file":
    case "prepend_file": return null;
  }
}

function reconstructFullSnapshot(snapshot: FileSnapshot): string | null {
  if (snapshot.partial || !snapshot.hashline?.anchors) return null;
  const byLine = new Map<number, string>();
  let maxLine = 0;
  for (const entry of snapshot.hashline.anchors.values()) {
    const existing = byLine.get(entry.line);
    if (existing !== undefined && existing !== entry.text) return null;
    byLine.set(entry.line, entry.text);
    maxLine = Math.max(maxLine, entry.line);
  }
  if (maxLine === 0 || byLine.size !== maxLine) return null;
  const lines: string[] = [];
  for (let line = 1; line <= maxLine; line++) {
    const text = byLine.get(line);
    if (text === undefined) return null;
    lines.push(text);
  }
  return lines.join("\n");
}

function byteSpanForLines(content: string, startLine: number, endLine: number): { start: number; end: number } | null {
  const lines = content.split("\n");
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return null;
  let offset = 0;
  let start = -1;
  let end = -1;
  for (let line = 1; line <= lines.length; line++) {
    if (line === startLine) start = offset;
    const lineEnd = offset + Buffer.byteLength(lines[line - 1], "utf8");
    if (line === endLine) {
      end = lineEnd;
      break;
    }
    offset = lineEnd + 1;
  }
  return start >= 0 && end >= start ? { start, end } : null;
}

function fingerprint(symbols: readonly SymbolRef[]): string {
  return symbols.map((symbol) => `${symbol.kind}:${symbol.name}`).join(" > ");
}

export async function verifyHashlineStructuralRecovery(args: {
  original: HashlineEditOp;
  recovered: HashlineEditOp;
  currentContent: string;
  snapshot: FileSnapshot;
  filePath: string;
  astResolver: AstResolverLike | null;
}): Promise<StructuralRecoveryCheck> {
  const { original, recovered, currentContent, snapshot, filePath, astResolver } = args;
  if (!astResolver?.findEnclosingSymbols) {
    return { checked: false, ok: true, reason: "enclosing-symbol resolver unavailable" };
  }
  const sourceContent = reconstructFullSnapshot(snapshot);
  if (sourceContent === null) {
    return { checked: false, ok: true, reason: "full structural snapshot unavailable" };
  }
  const sourceLines = targetSpan(original);
  const currentLines = targetSpan(recovered);
  if (!sourceLines || !currentLines) {
    return { checked: false, ok: true, reason: "file-level operation has no enclosing syntax span" };
  }
  const sourceBytes = byteSpanForLines(sourceContent, sourceLines.start, sourceLines.end);
  const currentBytes = byteSpanForLines(currentContent, currentLines.start, currentLines.end);
  if (!sourceBytes || !currentBytes) {
    return { checked: true, ok: false, reason: "recovered line span is outside the parsed file", sourceFingerprint: "", currentFingerprint: "" };
  }

  const sourceParse = await astResolver.parseFile(sourceContent, filePath);
  if (!sourceParse) return { checked: false, ok: true, reason: "source grammar unavailable" };
  let currentParse = null;
  try {
    currentParse = await astResolver.parseFile(currentContent, filePath);
    const sourceSymbols = astResolver.findEnclosingSymbols(sourceParse.tree, sourceBytes.start, sourceBytes.end);
    const sourceFingerprint = fingerprint(sourceSymbols);
    if (sourceFingerprint.length === 0) {
      return { checked: false, ok: true, reason: "source span has no enclosing structural symbol" };
    }
    if (!currentParse || currentParse.hasErrors) {
      return { checked: true, ok: false, reason: "current syntax could not be parsed reliably", sourceFingerprint, currentFingerprint: "" };
    }
    const currentSymbols = astResolver.findEnclosingSymbols(currentParse.tree, currentBytes.start, currentBytes.end);
    const currentFingerprint = fingerprint(currentSymbols);
    if (sourceFingerprint !== currentFingerprint) {
      return {
        checked: true,
        ok: false,
        reason: `expected ${sourceFingerprint}, found ${currentFingerprint || "<top-level>"}`,
        sourceFingerprint,
        currentFingerprint,
      };
    }
    return { checked: true, ok: true, fingerprint: sourceFingerprint };
  } finally {
    if (currentParse) astResolver.disposeParseResult(currentParse);
    astResolver.disposeParseResult(sourceParse);
  }
}
