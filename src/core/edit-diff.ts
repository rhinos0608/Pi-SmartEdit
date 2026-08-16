/**
 * Improved edit-diff module for the smart-edit Pi extension.
 *
 * Key fix: Never apply replacements in normalized space.
 * Normalization is used only as a coordinate finder — matches are
 * mapped back to original content positions and applied there.
 *
 * Also includes: indentation detection/normalization, closest-match
 * diagnostics, replaceAll support, trailing-newline edge case handling.
 */

import * as Diff from "diff";
import type {
  EditItem,
  MatchResult,
  MatchSpan,
  IndentationStyle,
  ClosestMatchDiagnostic,
  SearchScope,
} from "./types";
import { MatchTier } from "./types";

import { access, readFile } from "fs/promises";
import { constants } from "fs";
import { resolveToCwd } from "./path-utils";
import { MatchError } from "./errors";

// ─── Configuration constants ────────────────────────────────────────

/**
 * Similarity threshold for Tier 4 (similarity-scored) matching.
 * A match is accepted if the weighted line+char similarity score
 * meets or exceeds this value (0.0 – 1.0).
 *
 * The diagnostic helper findClosestMatch uses a lower reporting
 * threshold (0.3) to surface near-misses as hints even when they
 * are too far from the search text to be a viable match.
 *
 * The ambiguity checker countSimilarityOccurrences uses the same
 * SIMILARITY_MATCH_THRESHOLD so its count matches trySimilarityMatch.
 */
const SIMILARITY_MATCH_THRESHOLD = 0.85;
const SIMILARITY_REPORT_THRESHOLD = 0.3; // for findClosestMatch hints only

/**
 * Fuzzy-dominant auto-accept thresholds.
 * When one similarity match is >= DOMINANT_FUZZY_MIN_CONFIDENCE (97%)
 * AND the next-best match is >= DOMINANT_FUZZY_DELTA (8%) behind,
 * auto-accept the dominant match to reduce spurious ambiguity errors.
 */
const DOMINANT_FUZZY_MIN_CONFIDENCE = 0.97;
const DOMINANT_FUZZY_DELTA = 0.08;


/**
 * Check if a best similarity score is dominant over the next-best match.
 * Dominance means: best >= DOMINANT_FUZZY_MIN_CONFIDENCE AND
 * (best - secondBest) >= DOMINANT_FUZZY_DELTA.
 * This allows auto-accepting a clear winner when the next-best is far behind,
 * reducing spurious "multiple matches" failures for near-identical text.
 */
function isDominantFuzzyMatch(bestScore: number, secondBestScore: number): boolean {
  return bestScore >= DOMINANT_FUZZY_MIN_CONFIDENCE &&
    (bestScore - secondBestScore) >= DOMINANT_FUZZY_DELTA;
}
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

// ─── Line ending utilities ───────────────────────────────────────

export function detectLineEnding(content: string): string {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: string): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Strip UTF-8 BOM if present */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
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

// ─── Indentation utilities (Tier 2) ────────────────────────────────

/**
 * Detect the file's predominant indentation style.
 * Counts lines starting with tabs vs spaces. If spaces win, infers width
 * from the most common indent depth delta among non-zero indented lines.
 */
export function detectIndentation(content: string): IndentationStyle {
  const lines = content.split("\n");
  let tabCount = 0;
  let spaceCount = 0;
  const indentDepths: number[] = [];

  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith("\t")) {
      tabCount++;
      continue;
    }
    const leadingSpaces = line.match(/^ +/);
    if (leadingSpaces) {
      spaceCount++;
      indentDepths.push(leadingSpaces[0].length);
    }
  }

  if (tabCount > spaceCount) {
    // Tab-indented files: assume 4-space visual width per tab.
    // Most coding conventions use 4-space tabs; this enables correct
    // conversion of model's space-indented oldText (e.g., 4 spaces → 1 tab).
    return { char: "\t", width: 4 };
  }

  // Infer width from indent depth deltas
  const width = inferIndentWidth(indentDepths);
  return { char: " ", width };
}

function inferIndentWidth(depths: number[]): number {
  if (depths.length === 0) return 2; // default
  // Sort unique depths
  const unique = [...new Set(depths)].sort((a, b) => a - b);

  // If all depths are multiples of a common number, use that
  if (unique.length === 0) return 2;

  // Common heuristic: the smallest non-zero depth is the indent width
  const nonZero = unique.filter((d) => d > 0);
  if (nonZero.length === 0) return 2;

  // Check if most non-zero depths are multiples of 2 or 4
  const multiplesOf2 = nonZero.filter((d) => d % 2 === 0).length;
  const multiplesOf4 = nonZero.filter((d) => d % 4 === 0).length;

  if (multiplesOf4 > nonZero.length * 0.6 && nonZero[0] >= 4) return 4;
  if (multiplesOf2 > nonZero.length * 0.6 && nonZero[0] >= 2) return 2;

  return nonZero[0];
}

/**
 * Normalize leading whitespace of text to match the detected indentation style.
 * For spaces → tabs: replace N spaces with 1 tab
 * For tabs → spaces: replace 1 tab with N spaces
 * Handles mixed leading whitespace by counting equivalent indent levels.
 */
export function normalizeIndentation(
  text: string,
  fileStyle: IndentationStyle,
): string {
  const lines = text.split("\n");
  return lines
    .map((line) => {
      if (line.length === 0) return line;

      const leadingWs = line.match(/^[\t ]*/);
      if (!leadingWs || leadingWs[0].length === 0) return line;

      const ws = leadingWs[0];
      const rest = line.slice(ws.length);

      // Calculate indent level
      let level: number;
      if (ws.includes("\t") && ws.includes(" ")) {
        // Mixed — count character-by-character
        level = 0;
        for (const ch of ws) {
          level += ch === "\t" ? 1 : 1 / fileStyle.width;
        }
        level = Math.round(level);
      } else if (ws.startsWith("\t")) {
        level = ws.length;
      } else {
        level = Math.round(ws.length / fileStyle.width);
      }

      // Emit with file's style
      if (fileStyle.char === "\t") {
        return "\t".repeat(level) + rest;
      } else {
        return " ".repeat(level * fileStyle.width) + rest;
      }
    })
    .join("\n");
}

/**
 * Adjust newText's indentation to match the file's style.
 * Only adjusts the first line's leading whitespace relative to oldText's
 * first-line indent level difference.
 */
export function adaptNewTextIndentation(
  newText: string,
  oldText: string,
  fileStyle: IndentationStyle,
  oldTextOriginal: string, // the actual matched oldText from file
): string {
  if (!newText || !oldText) return newText;

  const newLines = newText.split("\n");
  if (newLines.length === 0) return newText;

  // Get indent level of oldText's first line in the file (original)
  const oldFirstLine = oldTextOriginal.split("\n")[0] || "";
  const oldFileIndentWs = oldFirstLine.match(/^[\t ]*/);
  const oldFileIndent = oldFileIndentWs ? oldFileIndentWs[0] : "";

  // Get indent level of oldText's first line (what model sent)
  const oldModelFirstLine = oldText.split("\n")[0] || "";
  const oldModelIndentWs = oldModelFirstLine.match(/^[\t ]*/);
  const oldModelIndent = oldModelIndentWs ? oldModelIndentWs[0] : "";

  // Get indent level of newText's first line
  const newFirstLineIndentWs = newLines[0].match(/^[\t ]*/);
  const newFirstLineIndent = newFirstLineIndentWs ? newFirstLineIndentWs[0] : "";

  // Calculate the indent delta: how much did model change the indent?
  // If oldModel has 2-space and new has 4-space, delta is +1 level
  const oldModelLevel = countIndentLevel(oldModelIndent, fileStyle);
  const newModelLevel = countIndentLevel(newFirstLineIndent, fileStyle);
  const oldFileLevel = countIndentLevel(oldFileIndent, fileStyle);

  // When the model sends oldText with stripped (zero) indentation but the
  // file match has non-zero indentation, we can't compute a meaningful
  // delta — the model's 0 baseline doesn't reflect the file's nesting.
  // Fall back to treating the model's newText as absolute in file style.
  const strippedIndent = oldModelIndent.length === 0 && oldFileIndent.length > 0;
  const delta = strippedIndent ? 0 : (newModelLevel - oldModelLevel);
  const newFileLevel = Math.max(0, oldFileLevel + delta);

  // Step 1: Normalize ALL lines of newText to the file's indentation style.
  // This converts e.g. 2-space to 4-space (or spaces to tabs) across all lines.
  const normalizedNewText = normalizeIndentation(newText, fileStyle);
  const normalizedLines = normalizedNewText.split("\n");

  // Step 2: Set the first line's indent to the file-relative level.
  // normalizeIndentation normalizes to absolute file style; newFileLevel
  // applies the model's intentional indent change on top of the file's
  // actual baseline (oldFileLevel), avoiding a double-applied delta that
  // would occur if we added delta on top of the already-normalized level.
  if (normalizedLines.length > 0) {
    const remainder = normalizedLines[0].slice(
      (normalizedLines[0].match(/^[\t ]*/) || [""])[0].length,
    );
    normalizedLines[0] = makeIndent(newFileLevel, fileStyle) + remainder;
  }

  return normalizedLines.join("\n");
}

function countIndentLevel(indent: string, style: IndentationStyle): number {
  if (!indent) return 0;
  if (style.char === "\t" && indent.startsWith("\t")) return indent.length;
  if (style.char === " ") return Math.round(indent.length / style.width);
  // Mixed — count each char
  let level = 0;
  for (const ch of indent) {
    level += ch === "\t" ? 1 : 1 / style.width;
  }
  return Math.round(level);
}

function makeIndent(level: number, style: IndentationStyle): string {
  if (level <= 0) return "";
  return style.char === "\t" ? "\t".repeat(level) : " ".repeat(level * style.width);
}

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
    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
    if (CODE_EXTENSIONS.has(ext)) return newText;
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

// ─── Comment-prefix utilities (Tier 4) ─────────────────────────────

/**
 * Result from detecting a comment style in a file.
 */
export interface CommentStyleResult {
  /** The comment prefix ('//', '#', or '--') */
  prefix: string;
  /** Number of lines in the sample that used this prefix */
  count: number;
}

/**
 * Detect the comment style used in a file by examining the first N non-empty lines.
 * Returns null if no consistent comment style is found.
 *
 * @param content - The file content to analyze
 * @returns {prefix: string, count: number} or null
 */
export function detectCommentStyle(content: string): CommentStyleResult | null {
  const lines = content.split("\n");
  const nonEmptyLines: string[] = [];

  // Collect first 20 non-empty lines
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      nonEmptyLines.push(trimmed);
      if (nonEmptyLines.length >= 20) break;
    }
  }

  if (nonEmptyLines.length === 0) return null;

  // Count occurrences of each comment style
  let doubleSlashCount = 0;
  let hashCount = 0;
  let doubleDashCount = 0;

  for (const line of nonEmptyLines) {
    if (line.startsWith("//")) {
      doubleSlashCount++;
    } else if (line.startsWith("#")) {
      hashCount++;
    } else if (line.startsWith("--")) {
      doubleDashCount++;
    }
  }

  // Determine consistent style (at least 60% of lines must match)
  const threshold = Math.ceil(nonEmptyLines.length * 0.6);

  if (doubleSlashCount >= threshold) {
    return { prefix: "//", count: doubleSlashCount };
  }
  if (hashCount >= threshold) {
    return { prefix: "#", count: hashCount };
  }
  if (doubleDashCount >= threshold) {
    return { prefix: "--", count: doubleDashCount };
  }

  return null;
}

/**
 * Strip comment prefixes from text, preserving line structure.
 *
 * @param text - The text to process
 * @param prefix - The comment prefix to strip ('//', '#', or '--')
 * @returns The text with comment prefixes removed from each line
 */
export function stripCommentPrefixes(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => {
      const leadingWs = line.match(/^[\t ]*/);
      const ws = leadingWs ? leadingWs[0] : "";
      const rest = line.slice(ws.length);
      if (rest.startsWith(prefix)) {
        return ws + rest.slice(prefix.length);
      }
      return line;
    })
    .join("\n");
}

/**
 * Map a character offset in stripped (comment-prefix-removed) content back to
 * the corresponding offset in the original content.
 *
 * @param original - Original content with comment prefixes
 * @param stripped - Content with comment prefixes removed
 * @param strippedOffset - Character offset in stripped content
 * @returns Character offset in original content
 */
function mapStrippedToOriginal(
  original: string,
  stripped: string,
  strippedOffset: number,
): number {
  const origLines = original.split("\n");
  const strippedLines = stripped.split("\n");

  let remaining = strippedOffset;
  let origOffset = 0;

  for (let i = 0; i < strippedLines.length && i < origLines.length; i++) {
    const sl = strippedLines[i];
    if (remaining <= sl.length) {
      // Position is within this line — add back the comment prefix if it existed
      const origLine = origLines[i];
      const leadingWs = origLine.match(/^[\t ]*/);
      const ws = leadingWs ? leadingWs[0] : "";
      const afterWs = origLine.slice(ws.length);

      // Check if this line had a comment prefix
      if (afterWs.startsWith("//") && strippedLines[i].startsWith(ws)) {
        return origOffset + ws.length + 2 + remaining; // +2 for "//"
      }
      if (afterWs.startsWith("#") && strippedLines[i].startsWith(ws)) {
        return origOffset + ws.length + 1 + remaining; // +1 for "#"
      }
      if (afterWs.startsWith("--") && strippedLines[i].startsWith(ws)) {
        return origOffset + ws.length + 2 + remaining; // +2 for "--"
      }

      // No comment prefix on this line, position maps directly
      return origOffset + remaining;
    }
    remaining -= sl.length + 1; // +1 for \n
    origOffset += origLines[i].length + 1;
  }

  return original.length;
}

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

  // Tier 1: Exact match
  let tierStart = performance.now();
  let exactIndex = -1;
  if (searchScope) {
    const scopedIndex = originalContent.indexOf(oldText, searchStart);
    if (scopedIndex !== -1 && scopedIndex < searchEnd) exactIndex = scopedIndex;
  } else {
    // No searchScope: search from searchStart position in originalContent.
    exactIndex = searchContent.indexOf(oldText, searchStart);
  }
  const exactDuration = performance.now() - tierStart;
  if (exactIndex !== -1) {
    telemetry.push({ tier: MatchTier.EXACT, durationMs: exactDuration, success: true, matchCount: 1 });
    return {
      result: {
        found: true,
        index: exactIndex,
        matchLength: oldText.length,
        tier: MatchTier.EXACT,
        usedFuzzyMatch: false,
        matchedText: oldText,
        numericFuzz: 0,
      },
      telemetry,
    };
  }
  telemetry.push({ tier: MatchTier.EXACT, durationMs: exactDuration, success: false, matchCount: 0 });

  // Tier 2: Indentation-normalized match
  tierStart = performance.now();
  const indentResult = tryIndentationMatch(originalContent, oldText, indentationStyle, searchStart, searchEnd);
  const indentDuration = performance.now() - tierStart;
  if (indentResult && (!searchScope || (indentResult.index >= searchStart && indentResult.index < searchEnd))) {
    telemetry.push({
      tier: MatchTier.INDENTATION,
      durationMs: indentDuration,
      success: true,
      matchCount: 1,
      note: `File uses ${indentationStyle.char === "\t" ? "tabs" : `${indentationStyle.width}-space`}`,
    });
    return { result: indentResult, telemetry };
  }
  telemetry.push({ tier: MatchTier.INDENTATION, durationMs: indentDuration, success: false, matchCount: 0 });

  // Tier 3: Unicode-normalized match (maps back to original)
  tierStart = performance.now();
  const unicodeResult = tryUnicodeMatch(originalContent, oldText, searchStart, searchEnd);
  const unicodeDuration = performance.now() - tierStart;
  if (unicodeResult && (!searchScope || (unicodeResult.index >= searchStart && unicodeResult.index < searchEnd))) {
    telemetry.push({ tier: MatchTier.UNICODE, durationMs: unicodeDuration, success: true, matchCount: 1 });
    return { result: unicodeResult, telemetry };
  }
  telemetry.push({ tier: MatchTier.UNICODE, durationMs: unicodeDuration, success: false, matchCount: 0 });

  // Tier 4: Comment-prefix match (handles // vs uncommented inconsistencies)
  tierStart = performance.now();
  const commentPrefixResult = tryCommentPrefixMatch(originalContent, oldText, searchStart, searchEnd);
  const commentPrefixDuration = performance.now() - tierStart;
  if (commentPrefixResult && (!searchScope || (commentPrefixResult.index >= searchStart && commentPrefixResult.index < searchEnd))) {
    telemetry.push({ tier: MatchTier.COMMENT_PREFIX, durationMs: commentPrefixDuration, success: true, matchCount: 1 });
    return { result: commentPrefixResult, telemetry };
  }
  telemetry.push({ tier: MatchTier.COMMENT_PREFIX, durationMs: commentPrefixDuration, success: false, matchCount: 0 });

  // Tier 5: Similarity-scored match (safety net for near-matches)
  tierStart = performance.now();
  const similarityResult = allowFuzzy
    ? trySimilarityMatch(originalContent, oldText, searchStart, searchEnd)
    : null;
  const similarityDuration = performance.now() - tierStart;
  if (similarityResult && (!searchScope || (similarityResult.index >= searchStart && similarityResult.index < searchEnd))) {
    telemetry.push({ tier: MatchTier.SIMILARITY, durationMs: similarityDuration, success: true, matchCount: 1 });
    return { result: similarityResult, telemetry };
  }
  telemetry.push({
    tier: MatchTier.SIMILARITY,
    durationMs: similarityDuration,
    success: false,
    matchCount: 0,
    note: allowFuzzy ? undefined : "Disabled by configuration",
  });

  // Tier 5: Stripped-indent match (handles indent-level shifts)
  tierStart = performance.now();
  const relIndentResult = tryStrippedIndentMatch(originalContent, oldText, searchStart, searchEnd);
  const relIndentDuration = performance.now() - tierStart;
  if (relIndentResult && (!searchScope || (relIndentResult.index >= searchStart && relIndentResult.index < searchEnd))) {
    telemetry.push({ tier: MatchTier.RELATIVE_INDENT, durationMs: relIndentDuration, success: true, matchCount: 1 });
    return { result: relIndentResult, telemetry };
  }
  telemetry.push({ tier: MatchTier.RELATIVE_INDENT, durationMs: relIndentDuration, success: false, matchCount: 0 });

  // No match found across all tiers
  return {
    result: {
      found: false,
      index: -1,
      matchLength: 0,
      tier: MatchTier.EXACT,
      usedFuzzyMatch: false,
      matchedText: "",
      numericFuzz: -1,
    },
    telemetry,
  };
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

  // Guard: zero-length matches indicate normalization drift — refuse
  if (matchLength <= 0) {
    throw new Error(
      `Normalization produced a zero-length match in edits. ` +
      `This usually means the oldText contains characters that cannot be ` +
      `reliably matched after Unicode normalization. Try using exact text from the file.`
    );
  }

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

/**
 * Tier 5: Similarity-based match — the safety net for near-matches.
 *
 * When Tiers 1–4 fail, this uses a sliding window similarity search to find
 * the closest matching block. If the similarity exceeds the threshold
 * (default 0.85), it returns as a valid match.
 *
 * This is the equivalent of Aider's difflib tier — it rescues edits where
 * the text is "close enough" to the original.
 */
function trySimilarityMatch(
  originalContent: string,
  oldText: string,
  startOffset: number = 0,
  endOffset?: number,
  similarityThreshold: number = SIMILARITY_MATCH_THRESHOLD,
): MatchResult | null {
  // Empty or whitespace-only oldText cannot be matched meaningfully
  if (!oldText.trim()) return null;

  // Constrain search to [startOffset, endOffset) when endOffset is set
  const searchEnd = endOffset ?? originalContent.length;
  const contentFromOffset = originalContent.slice(startOffset, searchEnd);
  const contentLines = contentFromOffset.split("\n");
  const oldLines = oldText.split("\n");

  if (contentLines.length === 0 || oldLines.length === 0) return null;

  // ── Performance guard ────────────────────────────────────────────
  // Bail out on large files or large search blocks to avoid O(n×m×k)
  // sliding-window × levenshtein × line overhead.
  // Thresholds: 3000 lines for content, 200 lines for search block.
  if (contentLines.length > 3000 || oldLines.length > 200) return null;

  // Search for the best matching window in the content
  let bestScore = 0;
  let bestStartLine = 0;
  let bestWindowSize = oldLines.length;

  // Wall-clock timeout: abort if search takes too long
  const startTime = Date.now();
  const TIMEOUT_MS = 100;

  // Try different window sizes (allowing for some line count variance)
  const minWindowSize = Math.max(1, oldLines.length - 2);
  const maxWindowSize = Math.min(oldLines.length + 2, contentLines.length);

  for (let windowSize = minWindowSize; windowSize <= maxWindowSize; windowSize++) {
    // Check timeout before each window size iteration
    if (Date.now() - startTime > TIMEOUT_MS) break;

    for (let startLine = 0; startLine <= contentLines.length - windowSize; startLine++) {
      // Check timeout per inner loop iteration
      if (Date.now() - startTime > TIMEOUT_MS) break;

      const windowLines = contentLines.slice(startLine, startLine + windowSize);
      const score = computeSimilarityScore(oldLines, windowLines);

      if (score > bestScore) {
        bestScore = score;
        bestStartLine = startLine;
        bestWindowSize = windowSize;

        // Early termination: perfect match found
        if (bestScore >= 1.0) break;
      }
    }
    // Early termination: perfect match found
    if (bestScore >= 1.0) break;
  }

  // If best match doesn't meet threshold, return null
  if (bestScore < similarityThreshold) {
    return null;
  }

  // Map line position back to byte offset in original content
  const matchedLines = contentLines.slice(bestStartLine, bestStartLine + bestWindowSize);
  const matchedText = matchedLines.join("\n");

  // Calculate byte offset from line number
  let matchIndex = startOffset;
  for (let i = 0; i < bestStartLine; i++) {
    matchIndex += contentLines[i].length + 1; // +1 for newline
  }

  // Bounds check: entire match must sit within [startOffset, searchEnd)
  if (matchIndex + matchedText.length > searchEnd) return null;

  return {
    found: true,
    index: matchIndex,
    matchLength: matchedText.length,
    tier: MatchTier.SIMILARITY,
    usedFuzzyMatch: true,
    matchedText,
    numericFuzz: 3,
    matchNote: `Matched via similarity scoring (${(bestScore * 100).toFixed(1)}% similar) — near-match rescue tier.`,
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

/**
 * Compute a similarity score between two line arrays.
 * Uses a combination of line-by-line equality and character-level similarity.
 */
function computeSimilarityScore(linesA: string[], linesB: string[]): number {
  // Trim trailing whitespace from all lines for comparison
  const a = linesA.map((l) => l.trimEnd());
  const b = linesB.map((l) => l.trimEnd());

  // Calculate line-by-line match ratio
  let exactLineMatches = 0;
  const minLines = Math.min(a.length, b.length);
  const maxLines = Math.max(a.length, b.length);

  for (let i = 0; i < minLines; i++) {
    if (a[i] === b[i]) {
      exactLineMatches++;
    }
  }

  // Line ratio: exact matches / max total lines
  const lineRatio = maxLines > 0 ? exactLineMatches / maxLines : 0;

  // Character-level similarity for lines that don't match exactly
  let charSimilaritySum = 0;
  let charComparisonCount = 0;

  for (let i = 0; i < minLines; i++) {
    if (a[i] !== b[i]) {
      // Lines don't match exactly, compute character similarity
      const sim = levenshteinRatio(a[i], b[i]);
      charSimilaritySum += sim;
      charComparisonCount++;
    }
  }

  // Also compare extra lines if one side has more
  for (let i = minLines; i < maxLines; i++) {
    const line = i < a.length ? a[i] : b[i];
    if (line.trim().length > 0) {
      // Non-empty extra line reduces similarity
      charComparisonCount++;
    }
  }

  const charRatio = charComparisonCount > 0 ? charSimilaritySum / charComparisonCount : 1;

  // Weighted combination: line ratio is more important
  return lineRatio * 0.6 + charRatio * 0.4;
}

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
      searchStart = match.index + match.matchLength;
      continue;
    }

    results.push(match);

    // Move past this match to avoid overlapping
    searchStart = match.index + match.matchLength;
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

// ─── Count occurrences ──────────────────────────────────────────────

function countOccurrences(content: string, oldText: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(oldText, pos)) !== -1) {
    count++;
    pos += oldText.length;
  }
  return count;
}

/**
 * Count how many windows in content meet the similarity threshold
 * for oldText. Uses the same sliding-window approach as trySimilarityMatch
 * so the count is authoritative for ambiguity detection.
 *
 * Returns an object with the count plus the best and second-best similarity
 * scores found. The scores enable fuzzy-dominant auto-accept logic.
 */
function countSimilarityOccurrences(
  content: string,
  oldText: string,
  threshold: number = SIMILARITY_MATCH_THRESHOLD,
): { count: number; bestScore: number; secondBestScore: number } {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  if (contentLines.length === 0 || oldLines.length === 0) {
    return { count: 0, bestScore: 0, secondBestScore: 0 };
  }

  // Performance guard (same thresholds as trySimilarityMatch).
  if (contentLines.length > 3000 || oldLines.length > 200) {
    return { count: 1, bestScore: 1, secondBestScore: 0 };
  }

  const minWindowSize = Math.max(1, oldLines.length - 2);
  const maxWindowSize = Math.min(oldLines.length + 2, contentLines.length);

  const countedRanges: Array<{ start: number; end: number }> = [];
  let count = 0;
  let bestScore = 0;
  let secondBestScore = 0;

  for (let windowSize = minWindowSize; windowSize <= maxWindowSize; windowSize++) {
    for (let startLine = 0; startLine <= contentLines.length - windowSize; startLine++) {
      const windowLines = contentLines.slice(startLine, startLine + windowSize);
      const score = computeSimilarityScore(oldLines, windowLines);
      if (score >= threshold) {
        const endLine = startLine + windowSize;
        const overlaps = countedRanges.some(
          (r) => startLine < r.end && endLine > r.start,
        );
        if (!overlaps) {
          countedRanges.push({ start: startLine, end: endLine });
          count++;
          if (count >= 2) return { count, bestScore, secondBestScore };
        }
      }

      // Track best/second-best scores for dominant-fuzzy auto-accept
      // Must run for ALL scores (including ≥threshold) so early-exit returns
      // valid bestScore/secondBestScore, not stale sub-threshold values.
      if (score > bestScore) {
        secondBestScore = bestScore;
        bestScore = score;
      } else if (score > secondBestScore) {
        secondBestScore = score;
      }
    }
  }

  return { count, bestScore, secondBestScore };
}

// ─── Closest-match diagnostics ──────────────────────────────────────

/**
 * Find the closest match to oldText in content using line-window comparison.
 * Returns the best candidate with similarity score, line range, and a hint.
 */
export function findClosestMatch(
  content: string,
  oldText: string,
): ClosestMatchDiagnostic | null {
  if (!content || !oldText) return null;

  const oldLines = oldText.split("\n");
  const contentLines = content.split("\n");

  if (oldLines.length === 0 || contentLines.length === 0) return null;

  // Performance guard: skip similarity-based diagnostic search on
  // large files or large search blocks (same threshold as trySimilarityMatch).
  if (contentLines.length > 3000 || oldLines.length > 200) return null;

  // Slide a window of oldLines.length over content
  let bestScore = 0;
  let bestStart = 0;
  let bestWindowSize = Math.min(oldLines.length, contentLines.length);

  // First pass: fixed window size equal to oldLines.length (clamped to content).
  // Cache the loop bound so mutations to bestWindowSize inside the loop
  // (from a narrower window winning earlier) don't change the iteration count.
  const firstPassBound = contentLines.length - bestWindowSize;
  for (let i = 0; i <= firstPassBound; i++) {
    const window = contentLines.slice(i, i + Math.min(oldLines.length, contentLines.length - i));
    const score = lineSimilarity(oldLines, window);
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
      bestWindowSize = window.length;
    }
  }

  // Second pass: try sliding with different window sizes for partial matches
  for (let w = 1; w <= oldLines.length + 2 && w <= contentLines.length; w++) {
    for (let i = 0; i <= contentLines.length - w; i++) {
      const window = contentLines.slice(i, i + w);
      const score = lineSimilarity(oldLines, window);
      if (score > bestScore) {
        bestScore = score;
        bestStart = i;
        bestWindowSize = w;
      }
    }
  }

  if (bestScore < SIMILARITY_REPORT_THRESHOLD) return null;

  const endLine = bestStart + bestWindowSize;
  const foundText = contentLines.slice(bestStart, endLine).join("\n");
  const hint = generateHint(oldText, foundText, bestScore);

  return {
    lineStart: bestStart + 1, // 1-based
    lineEnd: endLine,
    similarity: bestScore,
    expectedText: oldText.slice(0, 200), // truncate for output
    foundText: foundText.slice(0, 200),
    hint,
  };
}

/**
 * Compare two line arrays for similarity.
 * Uses SequenceMatcher-style ratio.
 */
function lineSimilarity(linesA: string[], linesB: string[]): number {
  const a = linesA.map((l) => l.trimEnd());
  const b = linesB.map((l) => l.trimEnd());

  // Use a simplified ratio: matching lines / max length
  let matches = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) matches++;
  }
  const lineRatio = matches / Math.max(a.length, b.length);

  // Also compute character-level similarity for the first non-empty line
  let charRatio = 0;
  const firstA = a.find((l) => l.trim().length > 0);
  const firstB = b.find((l) => l.trim().length > 0);
  if (firstA && firstB) {
    charRatio = levenshteinRatio(firstA, firstB);
  }

  // Weighted combination
  return lineRatio * 0.4 + charRatio * 0.6;
}

export function textSimilarityRatio(a: string, b: string): number {
  return levenshteinRatio(normalizeForFuzzyMatch(a), normalizeForFuzzyMatch(b));
}

function levenshteinRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // Use two rolling rows (O(n) space) instead of a full 2D matrix (O(n×m)).
  // This is called inside the similarity-matching hot path so space efficiency
  // matters — especially for long lines or large sliding windows.
  let prev: number[] = [];
  let curr: number[] = [];

  // Initialize current row (j=0)
  for (let j = 0; j <= b.length; j++) {
    curr[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    // Swap rows: current becomes previous, allocate a fresh current
    const tmp = prev;
    prev = curr;
    curr = tmp;
    if (curr.length < b.length + 1) {
      curr = new Array<number>(b.length + 1);
    }
    curr[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
  }

  const distance = curr[b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

/**
 * Generate a human-readable hint about what differed between expected and found.
 */
function generateHint(expected: string, found: string, _similarity: number): string {
  const expLines = expected.split("\n");
  const foundLines = found.split("\n");

  // Check indentation
  for (let i = 0; i < Math.min(expLines.length, foundLines.length); i++) {
    const expIndent = expLines[i].match(/^[\t ]*/)?.[0] || "";
    const foundIndent = foundLines[i].match(/^[\t ]*/)?.[0] || "";

    if (expIndent !== foundIndent) {
      const expHasTab = expIndent.includes("\t");
      const foundHasTab = foundIndent.includes("\t");
      if (expHasTab !== foundHasTab) {
        return `Indentation type differs: expected ${expHasTab ? "tabs" : "spaces"}, found ${foundHasTab ? "tabs" : "spaces"}.`;
      }
      return `Indentation width differs: expected ${expIndent.length} ${expHasTab ? "tabs" : "spaces"}, found ${foundIndent.length}.`;
    }
  }

  // Check for spacing differences around special characters
  if (expected.replace(/\s+/g, " ") === found.replace(/\s+/g, " ")) {
    return "Whitespace differs (spacing around operators, parentheses, or braces).";
  }

  // Check for extra/missing lines
  if (expLines.length !== foundLines.length) {
    return `Line count differs: expected ${expLines.length} lines, found ${foundLines.length} lines. Content may have changed — consider re-reading the file.`;
  }

  return "Content differs — consider re-reading the file for the exact text.";
}

// ─── Line diff helper ──────────────────────────────────────────────

function findFirstDifferentLine(
  oldText: string,
  foundText: string,
): { oldLine: string; newLine: string } | null {
  const oldLines = oldText.split("\n");
  const foundLines = foundText.split("\n");
  const maxLen = Math.max(oldLines.length, foundLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : "(empty)";
    const newLine = i < foundLines.length ? foundLines[i] : "(empty)";
    if (oldLine !== newLine) return { oldLine, newLine };
  }
  return null;
}

function formatClosestMatchHint(
  diagnostic: ClosestMatchDiagnostic,
  allowFuzzy: boolean,
): string {
  const simPct = Math.round(diagnostic.similarity * 100);
  let msg = `\nClosest match (${simPct}% similar) at lines ${diagnostic.lineStart}\u2013${diagnostic.lineEnd}:`;
  const diff = findFirstDifferentLine(diagnostic.expectedText, diagnostic.foundText);
  if (diff) {
    const truncate = (s: string, maxLen = 80): string =>
      s.length > maxLen ? s.slice(0, maxLen) + "\u2026" : s;
    msg += `\n  - ${truncate(diff.oldLine)}`;
    msg += `\n  + ${truncate(diff.newLine)}`;
  }
  msg += `\n  Hint: ${diagnostic.hint}`;
  if (!allowFuzzy) {
    msg += `\n\nFuzzy matching is disabled. Enable Smart Edit fuzzy match settings to accept similarity-based matches.`;
  }
  return msg;
}

// ─── Error message helpers ──────────────────────────────────────────

function getNotFoundError(
  path: string,
  editIndex: number,
  totalEdits: number,
  diagnostic?: ClosestMatchDiagnostic | null,
  description?: string,
  allowFuzzy?: boolean,
): MatchError {
  let msg: string;
  const desc = description ? ` (${description})` : "";

  if (totalEdits === 1) {
    msg = `Could not find the text${desc} in ${path}.`;
  } else {
    msg = `Could not find edits[${editIndex}]${desc} in ${path}.`;
  }

  // Idempotency hint: if the replacement is already in the file, say so
  // (newText is passed via the options object below, so we check it there)

  if (diagnostic) {
    const fuzzyHint = formatClosestMatchHint(diagnostic, allowFuzzy ?? false);
    msg += fuzzyHint;
  }

  return new MatchError(msg, 'NOT_FOUND', editIndex);
}

function getAmbiguousError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
  lineIndices?: number[],
  description?: string,
): MatchError {
  const desc = description ? ` (${description})` : "";
  let lineInfo = "";
  if (lineIndices && lineIndices.length > 0) {
    const preview = lineIndices.slice(0, 5);
    const suffix = lineIndices.length > 5 ? `, and ${lineIndices.length - 5} more` : "";
    lineInfo = ` Found ${occurrences} occurrences at lines: ${preview.join(", ")}${suffix}.`;
  } else {
    lineInfo = ` Found ${occurrences} occurrences.`;
  }
  const msg =
    totalEdits === 1
      ? `Could not find unique text${desc} in ${path}.${lineInfo}` +
        ` Please provide more surrounding context to make it unique, ` +
        `or use replaceAll: true if you intend to replace all occurrences.`
      : `Could not find unique text for edits[${editIndex}]${desc} in ${path}.${lineInfo}` +
        ` Each oldText must be unique. Please provide more surrounding context to make it unique, ` +
        `or use replaceAll: true if you intend to replace all occurrences.`;
  return new MatchError(msg, 'AMBIGUOUS', editIndex);
}

function getEmptyOldTextError(
  path: string,
  editIndex: number,
  totalEdits: number,
): Error {
  if (totalEdits === 1) {
    return new Error(`oldText must not be empty in ${path}.`);
  }
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. ` +
      `This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new Error(
    `No changes made to ${path}. The replacements produced identical content.`,
  );
}

// ─── ApplyEditsOptions ───────────────────────────────────────────

/** Optional configuration for applyEdits */
export interface ApplyEditsOptions {
  /**
   * Pre-computed search scopes for narrowing text matching.
   * Each entry corresponds to the edit at the same index.
   * Undefined means no scope restriction for that edit.
   */
  searchScopes?: (SearchScope | undefined)[];

  /** Enable similarity-based fuzzy matching. Defaults to true. */
  allowFuzzy?: boolean;

  /** Called with resolved match spans before applying, e.g., for conflict detection */
  onBeforeApply?: (spans: MatchSpan[], content: string) => void | Promise<void>;

  /**
   * Path to the file being edited. Passed to onResolveAnchor so it can
   * perform language-aware resolution (e.g., AST parsing by extension).
   */
  filePath?: string;

  /**
   * Called per-edit to resolve anchor/lineRange to a SearchScope.
   * Allows the caller (e.g., index.ts) to use AST symbol resolution,
   * tree-sitter queries, or any other strategy.
   *
   * Returns the resolved SearchScope, or null to fall back to full-file search.
   */
  onResolveAnchor?: (
    edit: EditItem,
    content: string,
    filePath: string,
  ) => Promise<SearchScope | null> | SearchScope | null;

}

// ─── Line-range helpers ─────────────────────────────────────────

/**
 * Convert a line range (1-based) to byte offsets in the content.
 * Operates on LF-normalized content after BOM strip.
 * If endLine is omitted, defaults to startLine (single line).
 */
export function lineRangeToByteRange(
  content: string,
  range: { startLine: number; endLine?: number },
): { startIndex: number; endIndex: number; totalLines: number } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const startLine = Math.max(1, Math.min(range.startLine, totalLines));
  const endLine = range.endLine
    ? Math.max(startLine, Math.min(range.endLine, totalLines))
    : startLine;

  let startIndex = 0;
  for (let i = 0; i < startLine - 1 && i < lines.length; i++) {
    startIndex += lines[i].length + 1;
  }

  let endIndex = startIndex;
  const hasTrailingNewline = content.endsWith('\n');
  for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
    endIndex += lines[i].length;
    // Add 1 for the newline separator, unless this is the last line
    // without a trailing newline
    if (i < lines.length - 1 || hasTrailingNewline) {
      endIndex += 1;
    }
  }

  return { startIndex, endIndex, totalLines };
}

/**
 * Validate a line range against the file length.
 * Returns null if valid, error message if invalid.
 */
export function validateLineRange(
  range: { startLine: number; endLine?: number },
  totalLines: number,
): string | null {
  if (range.startLine < 1) return "startLine must be >= 1";
  if (range.startLine > totalLines)
    return `startLine ${range.startLine} exceeds file length (${totalLines} lines)`;
  if (range.endLine && range.endLine > totalLines)
    return `endLine ${range.endLine} exceeds file length (${totalLines} lines)`;
  if (range.endLine && range.endLine < range.startLine)
    return "endLine must be >= startLine";
  return null;
}

// ─── Idempotency helper ────────────────────────────────────────────

/**
 * Check if an edit would be a no-op (oldText already replaced by newText).
 * Returns true if the replacement is already in place at the match position.
 */
function checkIdempotency(
  content: string,
  oldText: string,
  newText: string,
  path: string,
  editIndex: number,
  description?: string,
): boolean {
  const trimmedNew = newText.trim();
  const trimmedOld = oldText.trim();

  if (!trimmedNew || !trimmedOld) return false;

  const idx = content.indexOf(trimmedOld);
  if (idx === -1) return false;

  const end = idx + trimmedOld.length;
  const beforeText = content.slice(Math.max(0, idx - trimmedNew.length), idx);
  const afterText = content.slice(end, end + trimmedNew.length);

  // Check if trimmedNew already exists in any adjacent position
  const isAlreadyReplaced =
    content.slice(idx, end) === trimmedNew ||
    beforeText === trimmedNew ||
    afterText === trimmedNew;

  if (isAlreadyReplaced) {
    return true;
  }

  return false;
}

// ─── Main application function ──────────────────────────────────────

/**
 * Apply edits to LF-normalized content. This is THE core function.
 *
 * Architecture: All matching uses normalization as a coordinate finder.
 * All replacements are applied to the ORIGINAL LF-normalized content at
 * mapped positions. This prevents file corruption when fuzzy matching is
 * used. BOM and line-ending restoration are the caller's responsibility.
 *
 * @param normalizedContent - LF-normalized, BOM-stripped file content
 * @param edits - Edits to apply (may contain replaceAll and description)
 * @param path - File path for error messages
 * @param options - Optional configuration for anchor resolution and conflict detection
 */
export async function applyEdits(
  normalizedContent: string,
  edits: EditItem[],
  path: string,
  options?: ApplyEditsOptions,
): Promise<{
  baseContent: string;
  newContent: string;
  matchNotes: string[];
  replacementCount: number;
  matchSpans: MatchSpan[];
}> {
  // Normalize edit texts to LF. Metadata-only edits are routed before this pipeline.
  const normalizedEdits: Array<EditItem & { oldText: string; newText: string }> = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (typeof edit.oldText !== "string") {
      throw new Error(
        `edits[${i}].oldText is ${typeof edit.oldText}, expected a string. ` +
        `If using hashline format, the hashline anchor data may have been lost ` +
        `during tool parameter processing. Re-read the file and retry with explicit hashline anchors.`
      );
    }
    normalizedEdits.push({
      ...edit,
      oldText: normalizeToLF(edit.oldText),
      newText: typeof edit.newText === "string" ? normalizeToLF(edit.newText) : "",
    });
  }

  // Validate: no empty oldText
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  // Detect file indentation style once
  const indentationStyle = detectIndentation(normalizedContent);
  const allowFuzzy = options?.allowFuzzy ?? true;

  // Resolve search scopes for edits with anchors or lineRanges
  const searchScopes: (SearchScope | undefined)[] = [];
  if (options?.searchScopes || options?.onResolveAnchor) {
    for (let i = 0; i < normalizedEdits.length; i++) {
      if (options?.searchScopes?.[i]) {
        searchScopes.push(options.searchScopes[i]);
      } else if (options?.onResolveAnchor) {
        const scope = await options.onResolveAnchor(
          normalizedEdits[i],
          normalizedContent,
          options.filePath || path,
        );
        searchScopes.push(scope ?? undefined);
      } else {
        searchScopes.push(undefined);
      }
    }
  }

  // Phase 1: Match phase — find all spans in ORIGINAL content
  const matchSpans: MatchSpan[] = [];
  const matchNotes: string[] = [];

  for (let i = 0; i < normalizedEdits.length; i++) {
    let edit = normalizedEdits[i];

    // ── EOF context anchor ──
    // If oldText has trailing blank lines but the file doesn't, trim them.
    // This handles the `*** End of File` pattern from codex patches.
    if (edit.oldText.endsWith('\n\n') || edit.oldText.endsWith(' \n')) {
      const trimmedOld = edit.oldText.trimEnd();
      if (trimmedOld && !normalizedContent.includes(edit.oldText) && normalizedContent.includes(trimmedOld)) {
        // Only apply if the match is at/near EOF
        const potentialIdx = normalizedContent.indexOf(trimmedOld);
        if (potentialIdx !== -1) {
          const afterMatch = normalizedContent.slice(potentialIdx + trimmedOld.length);
          if (!afterMatch.trim()) {
            edit = { ...edit, oldText: trimmedOld };
            matchNotes.push(`edits[${i}]: trailing blank lines in oldText stripped (EOF context anchor).`);
          }
        }
      }
    }

    // ── Trailing newline edge case (Phase 8) ──
    // When deleting code (newText === "") and oldText doesn't end with \n
    // but the file has it after oldText, include the trailing newline in the match.
    // This prevents leaving an orphan blank line.
    if (
        edit.newText.length === 0 &&
        edit.oldText.length > 0 &&
        !edit.oldText.endsWith("\n")
      ) {
        // Check if the file has oldText followed by \n
        const withNewline = edit.oldText + "\n";
        if (normalizedContent.includes(withNewline)) {
          edit = { ...edit, oldText: withNewline };
      }
    }

    // ── Dotdotdots preprocessing ──
    // Materialize `...` elisions before matching
    const DOT_LINE_RE = /^[ \t]*\.\.\.[ \t]*$/m;
    if (DOT_LINE_RE.test(edit.oldText)) {
      const materialized = materializeDotdotdots(
        edit.oldText,
        edit.newText,
        normalizedContent,
      );
      if (materialized) {
        edit = {
          ...edit,
          oldText: materialized.materializedOld,
          newText: materialized.materializedNew,
        };
        matchNotes.push(`edits[${i}]: ... ellipsis materialized (numericFuzz=4, dotdotdots).`);
      }
    }

    const searchScope = searchScopes[i];
    const scopedContent = searchScope
      ? normalizedContent.slice(searchScope.startIndex, searchScope.endIndex)
      : normalizedContent;

    if (edit.replaceAll) {
      // Find all occurrences
      const match = findText(
        normalizedContent,
        edit.oldText,
        indentationStyle,
        0,
        searchScopes[i],
        allowFuzzy,
      );
      if (!match.found) {
        // Idempotency: if the replacement is already in place, treat as no-op
        if (checkIdempotency(scopedContent, edit.oldText, edit.newText, path, i, edit.description)) {
          matchNotes.push(
            `edits[${i}]${edit.description ? ` (${edit.description})` : ''}: ` +
            `replacement text already present in ${path} — edit is a no-op.`,
          );
          continue;
        }
        const diagnostic = findClosestMatch(normalizedContent, edit.oldText);
        throw getNotFoundError(
          path, i, normalizedEdits.length, diagnostic, edit.description, allowFuzzy,
        );
      }

      // Lock to this tier and find all matches
      const allMatches = findAllMatches(
        normalizedContent,
        edit.oldText,
        indentationStyle,
        match.tier,
        searchScopes[i],
        allowFuzzy,
      );

      if (allMatches.length === 0) {
        const diagnostic = findClosestMatch(normalizedContent, edit.oldText);
        throw getNotFoundError(
          path, i, normalizedEdits.length, diagnostic, edit.description, allowFuzzy,
        );
      }

      for (const m of allMatches) {
        let newText = edit.newText;
        // Adapt newText indentation
        if (m.tier !== MatchTier.EXACT) {
          newText = adaptNewTextIndentation(
            newText,
            edit.oldText,
            indentationStyle,
            m.matchedText,
          );
        }
        // Preserve quote style
        newText = preserveQuoteStyle(
          newText,
          normalizedContent,
          m.index,
          m.matchLength,
          path,
        );

        matchSpans.push({
          editIndex: i,
          matchIndex: m.index,
          matchLength: m.matchLength,
          newText,
          tier: m.tier,
          matchNote: m.matchNote,
          replaceAll: true,
          description: edit.description,
        });
      }

      if (match.tier !== MatchTier.EXACT && match.matchNote) {
        matchNotes.push(match.matchNote.replace(
          "Matched via",
          `edits[${i}] matched via`,
        ));
      }
    } else {
      // Single match required
      const match = findText(
        normalizedContent,
        edit.oldText,
        indentationStyle,
        0,
        searchScopes[i],
        allowFuzzy,
      );

      if (!match.found) {
        // Idempotency: if the replacement is already in place, treat as no-op
        if (checkIdempotency(scopedContent, edit.oldText, edit.newText, path, i, edit.description)) {
          matchNotes.push(
            `edits[${i}]${edit.description ? ` (${edit.description})` : ''}: ` +
            `replacement text already present in ${path} — edit is a no-op.`,
          );
          continue;
        }
        const diagnostic = findClosestMatch(normalizedContent, edit.oldText);
        throw getNotFoundError(
          path, i, normalizedEdits.length, diagnostic, edit.description, allowFuzzy,
        );
      }

      // Check for ambiguity across all tiers
      if (match.tier === MatchTier.UNICODE) {
        // Unicode tier: count occurrences in fuzzy-normalized space, scoped to
        // the search scope when one is set (scopedContent already computed above).
        const fuzzyContent = normalizeForFuzzyMatch(scopedContent);
        const fuzzyOldText = normalizeForFuzzyMatch(edit.oldText);
        let fuzzyCount = 0;
        let pos = 0;
        while ((pos = fuzzyContent.indexOf(fuzzyOldText, pos)) !== -1) {
          fuzzyCount++;
          pos += fuzzyOldText.length;
        }
        if (fuzzyCount > 1) {
          throw getAmbiguousError(
            path, i, normalizedEdits.length, fuzzyCount, undefined, edit.description,
          );
        }
      } else if (match.tier === MatchTier.SIMILARITY) {
        // Similarity tier: count how many windows meet the threshold
        // using the same sliding-window approach as trySimilarityMatch.
        // Also track best/second-best scores for dominant-fuzzy auto-accept.
        const { count: similarityCount, bestScore, secondBestScore } = countSimilarityOccurrences(
          scopedContent,
          edit.oldText,
        );
        if (similarityCount > 1) {
          // Fuzzy-dominant auto-accept: if one match is clearly better,
          // accept it instead of throwing an ambiguity error.
          if (isDominantFuzzyMatch(bestScore, secondBestScore)) {
            matchNotes.push(
              `edits[${i}]${edit.description ? ` (${edit.description})` : ''}: ` +
              `fuzzy-dominant auto-accepted (best=${(bestScore * 100).toFixed(1)}%, ` +
              `delta=${((bestScore - secondBestScore) * 100).toFixed(1)}% > ` +
              `${(DOMINANT_FUZZY_DELTA * 100).toFixed(0)}% threshold).`,
            );
          } else {
            throw getAmbiguousError(
              path, i, normalizedEdits.length, similarityCount, undefined, edit.description,
            );
          }
        }
      } else {
        // Exact and indentation tiers: count occurrences using stripped text,
        // scoped to the search scope when one is set (so a scoped edit is not
        // rejected for duplicates outside its scope). scopedContent is already
        // computed above.
        const strippedOld = edit.oldText.replace(/^[\t ]+/gm, '');
        const strippedContent = scopedContent.replace(/^[\t ]+/gm, '');
        const exactCount = countOccurrences(strippedContent, strippedOld);
        if (exactCount > 1) {
          throw getAmbiguousError(
            path, i, normalizedEdits.length, exactCount, undefined, edit.description,
          );
        }
      }

      let newText = edit.newText;

      // Adapt newText to file style
      if (match.tier !== MatchTier.EXACT || match.usedFuzzyMatch) {
        newText = adaptNewTextIndentation(
          newText,
          edit.oldText,
          indentationStyle,
          match.matchedText,
        );
        newText = preserveQuoteStyle(
          newText,
          normalizedContent,
          match.index,
          match.matchLength,
          path,
        );
      }

      matchSpans.push({
        editIndex: i,
        matchIndex: match.index,
        matchLength: match.matchLength,
        newText,
        tier: match.tier,
        matchNote: match.matchNote,
        replaceAll: false,
        description: edit.description,
      });

      if (match.tier !== MatchTier.EXACT && match.matchNote) {
        matchNotes.push(match.matchNote.replace(
          "Matched via",
          `edits[${i}] matched via`,
        ));
      }
    }
  }

  // Phase 2: Check for overlaps
  matchSpans.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchSpans.length; i++) {
    const prev = matchSpans[i - 1];
    const curr = matchSpans[i];
    if (prev.matchIndex + prev.matchLength > curr.matchIndex) {
      const prevDesc = prev.description ? ` (${prev.description})` : "";
      const currDesc = curr.description ? ` (${curr.description})` : "";
      if (prev.replaceAll || curr.replaceAll) {
        throw new Error(
          `edits[${prev.editIndex}]${prevDesc}${prev.replaceAll ? " (replaceAll)" : ""} and ` +
          `edits[${curr.editIndex}]${currDesc}${curr.replaceAll ? " (replaceAll)" : ""} overlap ` +
          `in ${path}. If you need to replace all occurrences except one specific case, ` +
          `split into two calls: first apply the specific edit, then replaceAll for the rest.`,
        );
      }
      throw new Error(
        `edits[${prev.editIndex}]${prevDesc} and edits[${curr.editIndex}]${currDesc} ` +
        `overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  // Phase 2.5: Pre-apply hooks (conflict detection, etc.)
  // Only run hooks after structural validation so invalid batches cannot
  // advance external state like conflict baselines.
  if (options?.onBeforeApply) {
    await options.onBeforeApply(matchSpans, normalizedContent);
  }

  // Phase 3: Apply replacements in reverse order against ORIGINAL content
  const baseContent = normalizedContent;
  let newContent = normalizedContent;

  matchSpans.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = matchSpans.length - 1; i >= 0; i--) {
    const span = matchSpans[i];
    newContent =
      newContent.slice(0, span.matchIndex) +
      span.newText +
      newContent.slice(span.matchIndex + span.matchLength);
  }

  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }

  return { baseContent, newContent, matchNotes, replacementCount: matchSpans.length, matchSpans };
}

// ─── Diff generation ────────────────────────────────────────────────

/**
 * Generate a unified diff string with line numbers and context.
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines: number = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;

      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextPartIsChange =
        i < parts.length - 1 &&
        (parts[i + 1].added || parts[i + 1].removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;

      if (hasLeadingChange && hasTrailingChange) {
        renderContext(raw, output, oldLineNum, newLineNum, lineNumWidth, contextLines);
        oldLineNum += raw.length;
        newLineNum += raw.length;
      } else if (hasLeadingChange) {
        const shown = raw.slice(0, contextLines);
        const skipped = raw.length - shown.length;
        for (const line of shown) {
          const ln = String(oldLineNum++).padStart(lineNumWidth, " ");
          output.push(` ${ln} ${line}`);
          newLineNum++;
        }
        if (skipped > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipped;
          newLineNum += skipped;
        }
      } else if (hasTrailingChange) {
        const skipped = Math.max(0, raw.length - contextLines);
        if (skipped > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipped;
          newLineNum += skipped;
        }
        for (const line of raw.slice(skipped)) {
          const ln = String(oldLineNum++).padStart(lineNumWidth, " ");
          output.push(` ${ln} ${line}`);
          newLineNum++;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

function renderContext(
  lines: string[],
  output: string[],
  oldStart: number,
  newStart: number,
  lineNumWidth: number,
  context: number,
): void {
  if (lines.length <= context * 2) {
    for (const line of lines) {
      const ln = String(oldStart++).padStart(lineNumWidth, " ");
      output.push(` ${ln} ${line}`);
    }
    return;
  }

  const leading = lines.slice(0, context);
  const trailing = lines.slice(lines.length - context);
  const skipped = lines.length - leading.length - trailing.length;

  for (const line of leading) {
    const ln = String(oldStart++).padStart(lineNumWidth, " ");
    output.push(` ${ln} ${line}`);
  }
  output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
  oldStart += skipped;
  for (const line of trailing) {
    const ln = String(oldStart).padStart(lineNumWidth, " ");
    output.push(` ${ln} ${line}`);
    oldStart++;
  }
}

// ─── Preview diff computation ───────────────────────────────────────

/**
 * Compute diff for edits without applying them. Used for TUI preview.
 */
export async function computeEditsDiff(
  path: string,
  edits: EditItem[],
  cwd: string,
): Promise<
  { diff: string; firstChangedLine: number | undefined } | { error: string }
> {
  const absolutePath = resolveToCwd(path, cwd);
  try {
    try {
      await access(absolutePath, constants.R_OK);
    } catch {
      return { error: `File not found: ${path}` };
    }

    const rawContent = await readFile(absolutePath, "utf-8");
    const { text: content } = stripBom(rawContent);
    const normalizedContent = normalizeToLF(content);
    const result = await applyEdits(normalizedContent, edits, path);
    return generateDiffString(result.baseContent, result.newContent);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
