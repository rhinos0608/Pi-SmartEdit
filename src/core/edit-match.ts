/**
 * Match engine for the smart-edit Pi extension.
 *
 * Extracted verbatim from src/core/edit-diff.ts (Seam 2): all matching
 * tiers (exact → indentation → unicode → comment-prefix → similarity →
 * stripped-indent), fuzzy normalization with source mapping, indent/comment
 * adaptation, similarity scoring, ambiguity counters, and closest-match
 * diagnostics. Tier order, thresholds, and coordinates are unchanged.
 *
 * This module must NOT import edit-diff.ts (one-way dependency:
 * edit-diff.ts consumes this module for applyEdits).
 */

import type {
  MatchResult,
  IndentationStyle,
  SearchScope,
} from "./types";
import { MatchTier } from "./types";

// ─── Similarity subsystem (Tier 5) ─────────────────────────────────
// Moved verbatim to src/core/match-similarity.ts (MS3). Imported here for
// tier dispatch (findTextWithTelemetry) and textSimilarityRatio; re-exported
// so existing importers (tests, edit-diff.ts facade) keep working.
import { levenshteinRatio, trySimilarityMatch } from "./match-similarity.js";
export {
  countSimilarityOccurrences,
  DOMINANT_FUZZY_DELTA,
  findClosestMatch,
  isDominantFuzzyMatch,
} from "./match-similarity.js";
// ─── Locate/diagnostic subsystem ───────────────────────────────────
// Moved verbatim to src/core/match-locate.ts (MS4, cycle-free helpers
// only). Re-exported here so existing importers (tests, edit-diff.ts
// facade) keep working. ClosestMatchDiagnostic lives in ./types.
export { countOccurrences, formatClosestMatchHint } from "./match-locate.js";
export type { ClosestMatchDiagnostic } from "./types";
// ─── Pipeline telemetry (P2) ────────────────────────────────────

/**
 * Telemetry record for one matching tier.
 * Captures timing, success, and match count for observability.
 */
export interface TierTelemetry {
  /** Which tier was attempted */
  tier: MatchTier;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether this tier found a match */
  success: boolean;
  /** Number of matches found (0 if not applicable) */
  matchCount: number;
  /** Human-readable note about this tier's behavior */
  note?: string;
}

// ─── Unicode normalization (fuzzy matching tier 3) ─────────────────

/**
 * Normalize text for fuzzy matching (Tier 3: Unicode).
 * Applies NFKC + smart quote/dash/space normalization + trailing whitespace strip.
 *
 * Operates LINE-BY-LINE so line count is preserved — this is critical
 * for source mapping back to original content positions.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    // Smart single quotes → '
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    // Smart double quotes → "
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Dashes/hyphens → -
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    // Special spaces → regular space
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/**
 * Normalize only Unicode characters (Tier 3) without trailing whitespace
 * stripping. Used for mapping back to original positions since
 * normalizeForFuzzyMatch strips trailing whitespace.
 */
function normalizeUnicodeOnly(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

// ─── Indentation subsystem (Tier 2) ───────────────────────────────
// Moved verbatim to src/core/match-indent.ts (MS1). Re-exported here so
// existing importers (tests, edit-diff.ts facade) keep working.
import { normalizeIndentation } from "./match-indent.js";
export {
  adaptNewTextIndentation,
  detectIndentation,
  normalizeIndentation,
} from "./match-indent.js";

// ─── Quote style preservation ──────────────────────────────────────

/**
 * File extensions for programming languages where smart-quote conversion
 * should be skipped to avoid corrupting code strings (imports, require
 * paths, JSON properties, JSX attributes, etc.).
 */
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".hpp",
  ".cs", ".swift", ".kt", ".scala",
  ".php", ".pl", ".pm",
]);

/**
 * If the matched region in the file uses smart (curly) quotes, convert
 * ASCII quotes to matching smart quotes throughout the newText.
 *
 * NOTE: For code file extensions (.ts, .js, .py, etc.), this function
 * returns newText unchanged to avoid corrupting import paths, require
 * calls, JSON object keys, JSX string attributes, and other code strings
 * where smart quotes are never expected.
 *
 * For non-code files (markdown, documentation, prose), replacements are
 * applied to the entire newText string, not restricted to the region
 * bounds. The region is checked to decide *whether* to convert, not
 * *where*.
 *
 * Uses Unicode-aware word boundaries (\p{L}) to reduce chances of
 * corrupting regex patterns, JSON fragments, or other code strings.
 */
export function preserveQuoteStyle(
  newText: string,
  originalContent: string,
  matchStart: number,
  matchLength: number,
  filePath?: string,
): string {
  // Skip for code files — smart quotes in source code almost never appear
  // because the editor normalizes them away. The only files where they
  // appear are markdown, documentation, and copy-pasted prose.
  if (filePath) {
    const base = filePath.split("/").pop() ?? filePath;
    const dot = base.lastIndexOf(".");
    if (dot > 0) {
      const ext = base.toLowerCase().slice(dot);
      if (CODE_EXTENSIONS.has(ext)) return newText;
    }
  }

  const region = originalContent.slice(matchStart, matchStart + matchLength);
  const hasSmartSingle = /\u2018|\u2019/.test(region);
  const hasSmartDouble = /\u201C|\u201D/.test(region);

  if (!hasSmartSingle && !hasSmartDouble) return newText;

  // Gated by region check above; replacements apply globally to newText
  // Use Unicode-aware word boundaries to avoid corrupting code
  if (hasSmartSingle) {
    newText = newText
      .replace(/(?<![\p{L}\p{N}_])'(?=[\p{L}])/gu, "\u2018")   // opening
      .replace(/(?<=[\p{L}])'(?![\p{L}\p{N}_])/gu, "\u2019");  // closing
  }

  if (hasSmartDouble) {
    newText = newText
      .replace(/(?<![\p{L}\p{N}_])"(?=[\p{L}])/gu, "\u201C")
      .replace(/(?<=[\p{L}])"(?![\p{L}\p{N}_])/gu, "\u201D");
  }

  return newText;
}

// ─── Source mapping: normalized → original ─────────────────────────

/**
 * Map a character offset in normalized (fuzzy) content back to the
 * corresponding position in the original content.
 *
 * Strategy: Since normalizeForFuzzyMatch operates line-by-line,
 * we find which line the offset falls on in normalized content,
 * then find the same line index in original content, and compute
 * the offset within that line.
 */
function mapNormalizedToOriginal(
  originalContent: string,
  normalizedContent: string,
  normalizedOffset: number,
): number {
  const normLines = normalizedContent.split("\n");
  const origLines = originalContent.split("\n");

  let remaining = normalizedOffset;
  for (let i = 0; i < normLines.length && i < origLines.length; i++) {
    const normLine = normLines[i];
    if (remaining <= normLine.length) {
      // This is the line. Now find the character in original.
      // Walk both normalized and original lines character-by-character
      // to find the corresponding position.
      return mapCharInLine(origLines[i], normLine, remaining) +
        getLineStartOffset(origLines, i);
    }
    remaining -= normLine.length + 1; // +1 for the newline
  }

  // Fallback: return end of original content
  return originalContent.length;
}

/** Get the byte offset of line[i]'s start in the lines array */
function getLineStartOffset(lines: string[], targetIndex: number): number {
  let offset = 0;
  for (let i = 0; i < targetIndex && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }
  return offset;
}

/**
 * Map a character position in a normalized line back to the corresponding
 * position in the original line. Handles normalization differences.
 */
function mapCharInLine(
  origLine: string,
  normLine: string,
  normOffset: number,
): number {
  // Simple approach: walk character by character
  // Track original position as we consume normalized characters
  let origPos = 0;
  let normPos = 0;

  while (normPos < normOffset && normPos < normLine.length && origPos < origLine.length) {
    const origRemaining = origLine.slice(origPos);
    const normRemaining = normLine.slice(normPos);

    // Check for quote normalization
    // Smart single quote → '
    if (/^[\u2018\u2019\u201A\u201B]/.test(origRemaining) && normRemaining.startsWith("'")) {
      origPos += 1; // skip one smart quote char (basic BMP)
      normPos += 1;
      continue;
    }
    // Smart double quote → "
    if (/^[\u201C\u201D\u201E\u201F]/.test(origRemaining) && normRemaining.startsWith('"')) {
      origPos += 1;
      normPos += 1;
      continue;
    }
    // Dash → -
    if (/^[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/.test(origRemaining) && normRemaining.startsWith("-")) {
      origPos += 1;
      normPos += 1;
      continue;
    }
    // Special space → regular space
    if (/^[\u00A0\u2002-\u200A\u202F\u205F\u3000]/.test(origRemaining) && normRemaining.startsWith(" ")) {
      origPos += 1;
      normPos += 1;
      continue;
    }

    // NFKC might combine multiple orig chars into one norm char
    // or split one orig char into multiple norm chars.
    // Guard: if the normalized form has a non-trivial length change,
    // refuse to continue — position tracking becomes unreliable.
    const origChar = origRemaining[0];
    const normChar = normRemaining[0];
    const normSingle = normalizeUnicodeOnly(origChar);

    if (normSingle.length === 0 || normSingle.length > 1) {
      // Multi-codepoint composition/decomposition — bail out.
      // This guard prevents position drift from NFKC ligatures
      // (e.g., ﬃ→ffi, ﬁ→fi, ﬂ→fl) or combining character sequences.
      // The > 1 threshold catches ALL multi-char decompositions —
      // a single orig char that maps to 2+ norm chars would otherwise
      // consume 1 normPos while consuming 1 origPos, leaving the
      // remaining norm chars unaccounted for.
      return origPos; // Best-effort: stop at current position
    }

    if (normSingle.length > 0 && normChar === normSingle[0]) {
      origPos += 1;
      normPos += 1;
    } else {
      // Characters differ under NFKC — drift detected, return current position
      return origPos;
    }
  }

  return origPos;
}

// ─── Comment-prefix subsystem (Tier 4) ─────────────────────────────
// Moved verbatim to src/core/match-comment.ts (MS2). Re-exported here so
// existing importers (tests, edit-diff.ts facade) keep working.
import { detectCommentStyle, mapStrippedToOriginal, stripCommentPrefixes } from "./match-comment.js";
export { detectCommentStyle, stripCommentPrefixes } from "./match-comment.js";
export type { CommentStyleResult } from "./match-comment.js";

// ─── Dotdotdots preprocessing (ellipsis elision) ───────────────────

/**
 * When oldText contains lines that are just `...`, materialize those gaps
 * by locating each non-dot segment in the file content and spanning the
 * actual file text between them. Returns {materializedOld, materializedNew}
 * suitable for passing to findText as a concrete oldText/newText pair,
 * or null if no `...` lines exist or if segments cannot be uniquely located.
 */
export function materializeDotdotdots(
  oldText: string,
  newText: string,
  content: string,
): { materializedOld: string; materializedNew: string } | null {
  const DOT_LINE = /^[ \t]*\.\.\.[ \t]*$/m;
  if (!DOT_LINE.test(oldText)) return null;

  const oldParts = oldText.split(/^[ \t]*\.\.\.[ \t]*$/m);
  const newParts = newText.split(/^[ \t]*\.\.\.[ \t]*$/m);
  if (oldParts.length !== newParts.length) return null; // unpaired dots

  // Locate each non-empty old segment sequentially in content
  let searchPos = 0;
  const segs: Array<{ start: number; end: number; newPart: string } | null> = [];

  for (let i = 0; i < oldParts.length; i++) {
    const oldPart = oldParts[i];
    const newPart = newParts[i];
    if (!oldPart.trim()) { segs.push(null); continue; }
    const idx = content.indexOf(oldPart, searchPos);
    if (idx === -1) return null;
    // Ambiguity check: must not appear again
    if (content.indexOf(oldPart, idx + 1) !== -1) return null;
    segs.push({ start: idx, end: idx + oldPart.length, newPart });
    searchPos = idx + oldPart.length;
  }

  const validSegs = segs.filter((s): s is NonNullable<typeof s> => s !== null);
  if (validSegs.length === 0) return null;

  const overallStart = validSegs[0].start;
  const overallEnd = validSegs[validSegs.length - 1].end;
  const materializedOld = content.slice(overallStart, overallEnd);

  // Build materializedNew by replacing old segments in the materialized span
  let materializedNew = materializedOld;
  // Apply in reverse order so offsets remain valid
  for (let i = validSegs.length - 1; i >= 0; i--) {
    const seg = validSegs[i];
    const relStart = seg.start - overallStart;
    const relEnd = seg.end - overallStart;
    materializedNew =
      materializedNew.slice(0, relStart) +
      seg.newPart +
      materializedNew.slice(relEnd);
  }

  return { materializedOld, materializedNew };
}

// ─── Matching pipeline ──────────────────────────────────────────────

/**
 * Four-tier matching pipeline.
 *
 * Tier 1: Exact match — indexOf on original content.
 * Tier 2: Indentation-normalized — detect file style, normalize oldText, match.
 * Tier 3: Unicode-normalized — NFKC + quote/dash/space normalization, map back.
 * Tier 4: Similarity-scored — Levenshtein on line arrays (deferred).
 *
 * When found, returns position in ORIGINAL content, not normalized.
 */
/**
 * Find text with per-tier telemetry timing.
 * Wraps the standard findText function with timing instrumentation.
 * Returns match result + telemetry array.
 */
interface TierAttemptOptions {
  successNote?: string;
  failNote?: string;
}

interface TierSearchContext {
  telemetry: TierTelemetry[];
  searchStart: number;
  searchEnd: number;
  searchScope?: SearchScope;
}

function isTierResultInScope(tierResult: MatchResult, ctx: TierSearchContext): boolean {
  if (!ctx.searchScope) return true;
  return tierResult.index >= ctx.searchStart && tierResult.index < ctx.searchEnd;
}

function attemptMatchTier(
  tier: MatchTier,
  run: () => MatchResult | null,
  ctx: TierSearchContext,
  options?: TierAttemptOptions,
): MatchResult | null {
  const tierStart = performance.now();
  const tierResult = run();
  const durationMs = performance.now() - tierStart;
  if (tierResult && isTierResultInScope(tierResult, ctx)) {
    const entry: TierTelemetry = { tier, durationMs, success: true, matchCount: 1 };
    if (options?.successNote !== undefined) entry.note = options.successNote;
    ctx.telemetry.push(entry);
    return tierResult;
  }
  const entry: TierTelemetry = { tier, durationMs, success: false, matchCount: 0 };
  if (options?.failNote !== undefined) entry.note = options.failNote;
  ctx.telemetry.push(entry);
  return null;
}

function tryExactMatch(
  originalContent: string,
  oldText: string,
  searchContent: string,
  ctx: TierSearchContext,
): MatchResult | null {
  let exactIndex = -1;
  if (ctx.searchScope) {
    const scopedIndex = originalContent.indexOf(oldText, ctx.searchStart);
    if (scopedIndex !== -1 && scopedIndex < ctx.searchEnd) exactIndex = scopedIndex;
  } else {
    // No searchScope: search from searchStart position in originalContent.
    exactIndex = searchContent.indexOf(oldText, ctx.searchStart);
  }
  if (exactIndex === -1) return null;
  return {
    found: true,
    index: exactIndex,
    matchLength: oldText.length,
    tier: MatchTier.EXACT,
    usedFuzzyMatch: false,
    matchedText: oldText,
    numericFuzz: 0,
  };
}

function buildNoMatchResult(): MatchResult {
  return {
    found: false,
    index: -1,
    matchLength: 0,
    tier: MatchTier.EXACT,
    usedFuzzyMatch: false,
    matchedText: "",
    numericFuzz: -1,
  };
}

export function findTextWithTelemetry(
  originalContent: string,
  oldText: string,
  indentationStyle: IndentationStyle,
  startOffset: number = 0,
  searchScope?: SearchScope,
  allowFuzzy: boolean = true,
): { result: MatchResult; telemetry: TierTelemetry[] } {
  const telemetry: TierTelemetry[] = [];

  // Determine the search range
  const searchStart = searchScope?.startIndex ?? startOffset;
  const searchEnd = searchScope?.endIndex ?? originalContent.length;
  const searchContent = searchScope
    ? originalContent.slice(searchStart, searchEnd)
    : originalContent;

  const ctx: TierSearchContext = { telemetry, searchStart, searchEnd, searchScope };

  // Tier 1: Exact match
  const exactResult = attemptMatchTier(
    MatchTier.EXACT,
    () => tryExactMatch(originalContent, oldText, searchContent, ctx),
    ctx,
  );
  if (exactResult) return { result: exactResult, telemetry };

  // Tier 2: Indentation-normalized match
  const indentResult = attemptMatchTier(
    MatchTier.INDENTATION,
    () => tryIndentationMatch(originalContent, oldText, indentationStyle, searchStart, searchEnd),
    ctx,
    { successNote: `File uses ${indentationStyle.char === "\t" ? "tabs" : `${indentationStyle.width}-space`}` },
  );
  if (indentResult) return { result: indentResult, telemetry };

  // Tier 3: Unicode-normalized match (maps back to original)
  const unicodeResult = attemptMatchTier(
    MatchTier.UNICODE,
    () => tryUnicodeMatch(originalContent, oldText, searchStart, searchEnd),
    ctx,
  );
  if (unicodeResult) return { result: unicodeResult, telemetry };

  // Tier 4: Comment-prefix match (handles // vs uncommented inconsistencies)
  const commentPrefixResult = attemptMatchTier(
    MatchTier.COMMENT_PREFIX,
    () => tryCommentPrefixMatch(originalContent, oldText, searchStart, searchEnd),
    ctx,
  );
  if (commentPrefixResult) return { result: commentPrefixResult, telemetry };

  // Tier 5: Similarity-scored match (safety net for near-matches)
  const similarityResult = attemptMatchTier(
    MatchTier.SIMILARITY,
    () => (allowFuzzy ? trySimilarityMatch(originalContent, oldText, searchStart, searchEnd) : null),
    ctx,
    allowFuzzy ? undefined : { failNote: "Disabled by configuration" },
  );
  if (similarityResult) return { result: similarityResult, telemetry };

  // Tier 5: Stripped-indent match (handles indent-level shifts)
  const relIndentResult = attemptMatchTier(
    MatchTier.RELATIVE_INDENT,
    () => tryStrippedIndentMatch(originalContent, oldText, searchStart, searchEnd),
    ctx,
  );
  if (relIndentResult) return { result: relIndentResult, telemetry };

  // No match found across all tiers
  return { result: buildNoMatchResult(), telemetry };
}

/**
 * Core 4-tier matching pipeline: exact → indentation → unicode → similarity.
 * Thin wrapper over findTextWithTelemetry for callers that don't need
 * per-match tier/telemetry details.
 */
export function findText(
  originalContent: string,
  oldText: string,
  indentationStyle: IndentationStyle,
  startOffset: number = 0,
  searchScope?: SearchScope,
  allowFuzzy: boolean = true,
): MatchResult {
  return findTextWithTelemetry(
    originalContent,
    oldText,
    indentationStyle,
    startOffset,
    searchScope,
    allowFuzzy,
  ).result;
}

/**
 * Tier 2: Try matching by normalizing indentation.
 */
function tryIndentationMatch(
  originalContent: string,
  oldText: string,
  fileStyle: IndentationStyle,
  startOffset: number = 0,
  endOffset?: number,
): MatchResult | null {
  // Normalize oldText's indentation to match file style
  const normalizedOldText = normalizeIndentation(oldText, fileStyle);
  const index = originalContent.indexOf(normalizedOldText, startOffset);

  if (index === -1) return null;
  // Respect end bound: match must fit entirely within [startOffset, endOffset)
  if (endOffset !== undefined && index + normalizedOldText.length > endOffset) return null;

  return {
    found: true,
    index,
    matchLength: normalizedOldText.length,
    tier: MatchTier.INDENTATION,
    usedFuzzyMatch: true,
    matchedText: normalizedOldText,
    numericFuzz: 1,
    matchNote: `Matched via indentation normalization (file uses ${
      fileStyle.char === "\t" ? "tabs" : `${fileStyle.width}-space`
    }, oldText used different indentation).`,
  };
}

/**
 * Tier 3: Try matching via Unicode normalization, mapping back to original position.
 */
function tryUnicodeMatch(
  originalContent: string,
  oldText: string,
  startOffset: number = 0,
  endOffset?: number,
): MatchResult | null {
  // Slice only the scoped window to avoid allocating most of the file for late scopes
  const baseOffset = startOffset || 0;
  const searchContent = endOffset !== undefined
    ? originalContent.slice(baseOffset, endOffset)
    : originalContent.slice(baseOffset);

  const fuzzyContent = normalizeForFuzzyMatch(searchContent);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);

  // Search from the start of the windowed content
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) return null;

  // Map back to positions within the windowed searchContent
  const windowIndex = mapNormalizedToOriginal(
    searchContent,
    fuzzyContent,
    fuzzyIndex,
  );

  // Map the end of the fuzzy match so the replacement span correctly covers
  // multi-line blocks and any trailing whitespace stripped by normalization.
  const fuzzyEndIndex = fuzzyIndex + fuzzyOldText.length;
  const windowEndIndex = mapNormalizedToOriginal(
    searchContent,
    fuzzyContent,
    fuzzyEndIndex,
  );

  // Shift window-relative offsets back to originalContent positions by adding baseOffset
  const originalIndex = windowIndex + baseOffset;
  const originalEndIndex = windowEndIndex + baseOffset;
  const matchLength = originalEndIndex - originalIndex;

  // Guard: zero-length matches indicate normalization drift — no usable
  // match, so let the caller fall through to the remaining tiers.
  if (matchLength <= 0) return null;

  // searchContent slices from 0, so originalIndex is already relative to originalContent
  const matchedText = originalContent.slice(originalIndex, originalIndex + matchLength);

  // Bounds check: match must be within [startOffset, endOffset)
  if (endOffset !== undefined && originalIndex + matchLength > endOffset) return null;
  if (originalIndex < startOffset) return null;

  return {
    found: true,
    index: originalIndex,
    matchLength,
    tier: MatchTier.UNICODE,
    usedFuzzyMatch: true,
    matchedText,
    numericFuzz: 2,
    matchNote: `Matched via Unicode normalization (file has smart quotes/dashes/spaces, oldText used ASCII equivalents).`,
  };
}

/**
 * Tier 4: Comment-prefix match.
 * Strips comment prefixes (//, #, --) from both oldText and content,
 * then searches for a match. Handles cases where models inconsistently
 * include or exclude comment prefixes.
 */
function tryCommentPrefixMatch(
  originalContent: string,
  oldText: string,
  startOffset: number = 0,
  endOffset?: number,
): MatchResult | null {
  // Empty or whitespace-only oldText cannot be matched meaningfully
  if (!oldText.trim()) return null;

  // Detect comment style from original content
  const style = detectCommentStyle(originalContent);
  if (!style) return null;

  const { prefix } = style;

  // Slice the search window
  const searchEnd = endOffset ?? originalContent.length;
  const searchContent = originalContent.slice(startOffset, searchEnd);

  // Strip comment prefixes from both
  const strippedContent = stripCommentPrefixes(searchContent, prefix);
  const strippedOld = stripCommentPrefixes(oldText, prefix);

  // Search for stripped oldText in stripped content
  const strippedIdx = strippedContent.indexOf(strippedOld);
  if (strippedIdx === -1) return null;

  // Map stripped index back to original content
  const origIdx = mapStrippedToOriginal(searchContent, strippedContent, strippedIdx);
  const strippedEndIdx = strippedIdx + strippedOld.length;
  const origEndIdx = mapStrippedToOriginal(searchContent, strippedContent, strippedEndIdx);
  const matchLength = origEndIdx - origIdx;

  if (matchLength <= 0) return null;

  // Bounds check: match must be within [startOffset, searchEnd)
  if (startOffset + origIdx + matchLength > searchEnd) return null;

  const matchedText = searchContent.slice(origIdx, origEndIdx);

  return {
    found: true,
    index: startOffset + origIdx,
    matchLength,
    tier: MatchTier.COMMENT_PREFIX,
  usedFuzzyMatch: true,
  matchedText,
  numericFuzz: 2.5,
  matchNote: `Matched after stripping ${prefix} comment prefixes.`,
  };
}

// ─── Tier 5: Stripped-indent match ────────────────────────────────────

/**
 * Tier 5: Strip-leading-whitespace match.
 * Strips all leading whitespace from each line of both oldText and the
 * search window, then does an exact indexOf. Handles blocks that have been
 * moved to a deeper or shallower scope (indent shift).
 */
function tryStrippedIndentMatch(
  originalContent: string,
  oldText: string,
  startOffset: number = 0,
  endOffset?: number,
): MatchResult | null {
  if (!oldText.trim()) return null;

  const searchEnd = endOffset ?? originalContent.length;
  const searchContent = originalContent.slice(startOffset, searchEnd);

  const stripIndent = (t: string) =>
    t.split('\n').map(l => l.trimStart()).join('\n');

  const strippedContent = stripIndent(searchContent);
  const strippedOld = stripIndent(oldText);

  const strippedIdx = strippedContent.indexOf(strippedOld);
  if (strippedIdx === -1) return null;

  // Map strippedIdx → original offset within searchContent
  const origIdx = mapStrippedIndexToOriginal(searchContent, strippedContent, strippedIdx);
  const strippedEndIdx = strippedIdx + strippedOld.length;
  const origEndIdx = mapStrippedIndexToOriginal(searchContent, strippedContent, strippedEndIdx);
  const matchLength = origEndIdx - origIdx;
  if (matchLength <= 0) return null;

  // Bounds check
  if (endOffset !== undefined && startOffset + origIdx + matchLength > endOffset) return null;

  return {
    found: true,
    index: startOffset + origIdx,
    matchLength,
    tier: MatchTier.RELATIVE_INDENT,
    usedFuzzyMatch: true,
    matchedText: searchContent.slice(origIdx, origEndIdx),
    numericFuzz: 5,
    matchNote: 'Matched via stripped indentation (Tier 5 — block has shifted indent level).',
  };
}

/**
 * Map a character offset in stripped content back to the corresponding
 * offset in the original (indented) content. Line counts are preserved;
 * only leading whitespace differs.
 */
function mapStrippedIndexToOriginal(
  original: string,
  stripped: string,
  strippedOffset: number,
): number {
  const origLines = original.split('\n');
  const strippedLines = stripped.split('\n');

  let remaining = strippedOffset;
  let origOffset = 0;

  for (let i = 0; i < strippedLines.length && i < origLines.length; i++) {
    const sl = strippedLines[i];
    if (remaining <= sl.length) {
      // Position is within this line — add back the leading whitespace
      const leadingWs = origLines[i].length - origLines[i].trimStart().length;
      return origOffset + leadingWs + remaining;
    }
    remaining -= sl.length + 1; // +1 for \n
    origOffset += origLines[i].length + 1;
  }

  return original.length;
}

// NOTE (MS4): findAllMatches stays here — it dispatches through findText,
// so moving it to match-locate.ts would create an edit-match↔match-locate
// import cycle. match-locate.ts holds only cycle-free locate/diagnostic
// helpers (countOccurrences, formatClosestMatchHint).
// ─── Find all matches (for replaceAll) ──────────────────────────────

/**
 * Find all non-overlapping occurrences of oldText, allowing multi-tier
 * matching. The first match determines the minimum tier, but subsequent
 * matches can use higher (more lenient) tiers if lower tiers fail.
 */
export function findAllMatches(
  originalContent: string,
  oldText: string,
  indentationStyle: IndentationStyle,
  minTier: MatchTier,
  searchScope?: SearchScope,
  allowFuzzy: boolean = true,
): MatchResult[] {
  const results: MatchResult[] = [];
  const rangeStart = searchScope?.startIndex ?? 0;
  const rangeEnd = searchScope?.endIndex ?? originalContent.length;
  let searchStart = rangeStart;

  while (searchStart < rangeEnd) {
    // Don't pass searchScope to findText here — we iterate manually via searchStart.
    // Passing searchScope would hardcode startIndex, preventing iteration past the first match.
    const match = findText(
      originalContent,
      oldText,
      indentationStyle,
      searchStart,
      undefined,
      allowFuzzy,
    );

    if (!match.found) break;

    // Check that the match falls within the range (relevant when searchScope is set)
    if (match.index >= rangeEnd) break;

    // Also reject matches that start inside the scope but extend beyond it.
    // This is relevant for Tier 3/4 (fuzzy/similarity) matches where the
    // matched text could be longer than the scope's remaining content.
    if (match.index + match.matchLength > rangeEnd) break;

    // Accept matches at or above (at least as strict as) the minimum tier
    if (tierPriority(match.tier) < tierPriority(minTier)) {
      // Lower priority than min — advance past the rejected match span
      if (match.matchLength <= 0) {
        if (match.index >= rangeEnd - 1) break;
        searchStart = match.index + 1;
      } else {
        searchStart = match.index + match.matchLength;
      }
      continue;
    }

    results.push(match);

    // Move past this match to avoid overlapping; a zero-length match
    // (empty oldText) makes no progress, so advance one code unit.
    if (match.matchLength <= 0) {
      if (match.index >= rangeEnd - 1) break;
      searchStart = match.index + 1;
    } else {
      searchStart = match.index + match.matchLength;
    }
  }

  return results;
}

function tierPriority(tier: MatchTier): number {
 switch (tier) {
  case MatchTier.EXACT: return 4;
  case MatchTier.INDENTATION: return 3;
  case MatchTier.UNICODE: return 2;
  case MatchTier.COMMENT_PREFIX: return 1;
  case MatchTier.SIMILARITY: return 0;
  // DOTDOTDOTS is informational only — findTextWithTelemetry never returns it
  case MatchTier.RELATIVE_INDENT: return -1;
  default: return -1;
 }
}

// textSimilarityRatio stays here: it needs the local
// normalizeForFuzzyMatch, so moving it to match-locate.ts would create
// an edit-match↔match-locate import cycle (see note at findAllMatches).

export function textSimilarityRatio(a: string, b: string): number {
  return levenshteinRatio(normalizeForFuzzyMatch(a), normalizeForFuzzyMatch(b));
}

