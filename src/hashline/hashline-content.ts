/**
 * Hashline content-normalization + resolution leaf — regexes, prefix stripping,
 * text parsing, and raw-edit resolution.
 *
 * Verbatim extraction from `src/hashline/hashline-edit.ts` (MS2 split).
 * No logic, regex, or behavior changes — moves only.
 */

import {
  HASHLINE_BIGRAM_RE_SRC,
  HASHLINE_CONTENT_SEPARATOR,
} from "./hashline";

import {
  parseTag,
  type HashlineEditOp,
} from "./hashline-anchor";

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
  // Safety counter to prevent infinite loops on malformed input
  for (let i = 0; i < 10; i++) {
    const prev = result;
    result = result.replace(HASHLINE_PREFIX_RE, "");
    if (result === prev) break;
  }
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
