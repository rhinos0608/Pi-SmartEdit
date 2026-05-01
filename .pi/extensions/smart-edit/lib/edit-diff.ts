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
      origPos += 1;
      normPos += 1;
    }
  }

  return origPos;
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
export function findText(
  originalContent: string,
  oldText: string,
  indentationStyle: IndentationStyle,
  startOffset: number = 0,
  searchScope?: SearchScope,
): MatchResult {
  // Determine the search range
  const searchStart = searchScope?.startIndex ?? startOffset;
  const searchEnd = searchScope?.endIndex ?? originalContent.length;
  const searchContent = searchScope
    ? originalContent.slice(searchStart, searchEnd)
    : originalContent;

  // Tier 1: Exact match
  let exactIndex = -1;
  if (searchScope) {
    // searchContent is a slice, so indexOf returns position relative to that slice
    const localIndex = searchContent.indexOf(oldText);
    if (localIndex !== -1) exactIndex = searchStart + localIndex;
  } else {
    // searchContent is the full content; indexOf with offset returns absolute position
    exactIndex = searchContent.indexOf(oldText, searchStart);
  }
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      tier: MatchTier.EXACT,
      usedFuzzyMatch: false,
      matchedText: oldText,
    };
  }

  // Tier 2: Indentation-normalized match
  const indentResult = tryIndentationMatch(originalContent, oldText, indentationStyle, searchStart);
  if (indentResult && (!searchScope || (indentResult.index >= searchStart && indentResult.index < searchEnd))) return indentResult;

  // Tier 3: Unicode-normalized match (maps back to original)
  const unicodeResult = tryUnicodeMatch(originalContent, oldText, searchStart);
  if (unicodeResult && (!searchScope || (unicodeResult.index >= searchStart && unicodeResult.index < searchEnd))) return unicodeResult;

  // Tier 4: Similarity-scored match (safety net for near-matches)
  const similarityResult = trySimilarityMatch(originalContent, oldText, searchStart);
  if (similarityResult && (!searchScope || (similarityResult.index >= searchStart && similarityResult.index < searchEnd))) return similarityResult;

  // No match found across all tiers
  return {
    found: false,
    index: -1,
    matchLength: 0,
    tier: MatchTier.EXACT,
    usedFuzzyMatch: false,
    matchedText: "",
  };
}

/**
 * Tier 2: Try matching by normalizing indentation.
 */
function tryIndentationMatch(
  originalContent: string,
  oldText: string,
  fileStyle: IndentationStyle,
  startOffset: number = 0,
): MatchResult | null {
  // Normalize oldText's indentation to match file style
  const normalizedOldText = normalizeIndentation(oldText, fileStyle);
  const index = originalContent.indexOf(normalizedOldText, startOffset);

  if (index === -1) return null;

  return {
    found: true,
    index,
    matchLength: normalizedOldText.length,
    tier: MatchTier.INDENTATION,
    usedFuzzyMatch: true,
    matchedText: normalizedOldText,
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
): MatchResult | null {
  const fuzzyContent = normalizeForFuzzyMatch(originalContent);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);

  // Map startOffset from original to fuzzy content position
  // normalizeForFuzzyMatch splits line-by-line and trims trailing whitespace,
  // so we map via segmenting the prefix up to startOffset
  let fuzzyStartOffset = 0;
  if (startOffset > 0) {
    const soFar = originalContent.slice(0, startOffset);
    fuzzyStartOffset = normalizeForFuzzyMatch(soFar).length;
  }

  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText, fuzzyStartOffset);

  if (fuzzyIndex === -1) return null;

  // Map back to original content position
  const originalIndex = mapNormalizedToOriginal(
    originalContent,
    fuzzyContent,
    fuzzyIndex,
  );

  // Map the end of the fuzzy match so the replacement span correctly covers
  // multi-line blocks and any trailing whitespace stripped by normalization.
  const fuzzyEndIndex = fuzzyIndex + fuzzyOldText.length;
  const originalEndIndex = mapNormalizedToOriginal(
    originalContent,
    fuzzyContent,
    fuzzyEndIndex,
  );
  const matchLength = originalEndIndex - originalIndex;

  // Guard: zero-length matches indicate normalization drift — refuse
  if (matchLength <= 0) {
    throw new Error(
      `Normalization produced a zero-length match in edits. ` +
      `This usually means the oldText contains characters that cannot be ` +
      `reliably matched after Unicode normalization. Try using exact text from the file.`
    );
  }

  const matchedText = originalContent.slice(originalIndex, originalIndex + matchLength);

  return {
    found: true,
    index: originalIndex,
    matchLength,
    tier: MatchTier.UNICODE,
    usedFuzzyMatch: true,
    matchedText,
    matchNote: `Matched via Unicode normalization (file has smart quotes/dashes/spaces, oldText used ASCII equivalents).`,
  };
}

/**
 * Tier 4: Similarity-based match — the safety net for near-matches.
 *
 * When Tiers 1–3 fail, this uses a sliding window similarity search to find
 * the closest matching block. If the similarity exceeds the threshold
 * (default 0.65), it returns as a valid match.
 *
 * This is the equivalent of Aider's difflib tier — it rescues edits where
 * the text is "close enough" to the original.
 */
function trySimilarityMatch(
  originalContent: string,
  oldText: string,
  startOffset: number = 0,
  similarityThreshold: number = SIMILARITY_MATCH_THRESHOLD,
): MatchResult | null {
  // Empty or whitespace-only oldText cannot be matched meaningfully
  if (!oldText.trim()) return null;

  const contentFromOffset = originalContent.slice(startOffset);
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

  // Try different window sizes (allowing for some line count variance)
  const minWindowSize = Math.max(1, oldLines.length - 2);
  const maxWindowSize = Math.min(oldLines.length + 2, contentLines.length);

  for (let windowSize = minWindowSize; windowSize <= maxWindowSize; windowSize++) {
    for (let startLine = 0; startLine <= contentLines.length - windowSize; startLine++) {
      const windowLines = contentLines.slice(startLine, startLine + windowSize);
      const score = computeSimilarityScore(oldLines, windowLines);

      if (score > bestScore) {
        bestScore = score;
        bestStartLine = startLine;
        bestWindowSize = windowSize;
      }
    }
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

  return {
    found: true,
    index: matchIndex,
    matchLength: matchedText.length,
    tier: MatchTier.SIMILARITY,
    usedFuzzyMatch: true,
    matchedText,
    matchNote: `Matched via similarity scoring (${(bestScore * 100).toFixed(1)}% similar) — near-match rescue tier.`,
  };
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
): MatchResult[] {
  const results: MatchResult[] = [];
  const rangeStart = searchScope?.startIndex ?? 0;
  const rangeEnd = searchScope?.endIndex ?? originalContent.length;
  let searchStart = rangeStart;

  while (searchStart < rangeEnd) {
    // Don't pass searchScope to findText here — we iterate manually via searchStart.
    // Passing searchScope would hardcode startIndex, preventing iteration past the first match.
    const match = findText(originalContent, oldText, indentationStyle, searchStart);

    if (!match.found) break;

    // Check that the match falls within the range (relevant when searchScope is set)
    if (match.index >= rangeEnd) break;

    // Also reject matches that start inside the scope but extend beyond it.
    // This is relevant for Tier 3/4 (fuzzy/similarity) matches where the
    // matched text could be longer than the scope's remaining content.
    if (match.index + match.matchLength > rangeEnd) break;

    // Accept matches at or above (at least as strict as) the minimum tier
    if (tierPriority(match.tier) < tierPriority(minTier)) {
      // Lower priority than min — skip to next position
      searchStart += 1;
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
    case MatchTier.EXACT: return 3;
    case MatchTier.INDENTATION: return 2;
    case MatchTier.UNICODE: return 1;
    case MatchTier.SIMILARITY: return 0;
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
 */
function countSimilarityOccurrences(
  content: string,
  oldText: string,
  threshold: number = SIMILARITY_MATCH_THRESHOLD,
): number {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  if (contentLines.length === 0 || oldLines.length === 0) return 0;

  // Performance guard (same thresholds as trySimilarityMatch).
  if (contentLines.length > 3000 || oldLines.length > 200) return 1; // treat as unique

  const minWindowSize = Math.max(1, oldLines.length - 2);
  const maxWindowSize = Math.min(oldLines.length + 2, contentLines.length);

  const countedRanges: Array<{ start: number; end: number }> = [];
  let count = 0;

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
          if (count >= 2) return count;
        }
      }
    }
  }

  return count;
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
      curr = new Array(b.length + 1);
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

// ─── Error message helpers ──────────────────────────────────────────

function getNotFoundError(
  path: string,
  editIndex: number,
  totalEdits: number,
  diagnostic?: ClosestMatchDiagnostic | null,
  description?: string,
): Error {
  let msg: string;
  const desc = description ? ` (${description})` : "";

  if (totalEdits === 1) {
    msg = `Could not find the text${desc} in ${path}.`;
  } else {
    msg = `Could not find edits[${editIndex}]${desc} in ${path}.`;
  }

  if (diagnostic) {
    msg += `\nClosest match at lines ${diagnostic.lineStart}–${diagnostic.lineEnd} (similarity: ${Math.round(diagnostic.similarity * 100)}%):`;
    msg += `\n  Expected: "${diagnostic.expectedText}"`;
    msg += `\n  Found:    "${diagnostic.foundText}"`;
    msg += `\n  Hint: ${diagnostic.hint}`;
  }

  return new Error(msg);
}

function getAmbiguousError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
  description?: string,
): Error {
  const desc = description ? ` (${description})` : "";
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text${desc} in ${path}. ` +
      `The text must be unique. Please provide more surrounding context to make it unique, ` +
      `or use replaceAll: true if you intend to replace all occurrences.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}]${desc} in ${path}. ` +
    `Each oldText must be unique. Please provide more surrounding context to make it unique, ` +
    `or use replaceAll: true if you intend to replace all occurrences.`,
  );
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
  // Normalize edit texts to LF
  const normalizedEdits = edits.map((edit) => ({
    ...edit,
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  // Validate: no empty oldText
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  // Detect file indentation style once
  const indentationStyle = detectIndentation(normalizedContent);

  // Resolve search scopes for edits with anchors or lineRanges
  const searchScopes: (SearchScope | undefined)[] = [];
  if (options?.searchScopes || options?.onResolveAnchor) {
    for (let i = 0; i < normalizedEdits.length; i++) {
      if (options?.searchScopes?.[i]) {
        // Pre-computed scope takes priority
        searchScopes.push(options.searchScopes[i]);
      } else if (options?.onResolveAnchor) {
        // Ask the caller to resolve anchor/lineRange to a scope
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
    const edit = normalizedEdits[i];

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
        edit.oldText = withNewline;
      }
    }

    if (edit.replaceAll) {
      // Find all occurrences
      const match = findText(normalizedContent, edit.oldText, indentationStyle, 0, searchScopes[i]);
      if (!match.found) {
        const diagnostic = findClosestMatch(normalizedContent, edit.oldText);
        throw getNotFoundError(
          path, i, normalizedEdits.length, diagnostic, edit.description,
        );
      }

      // Lock to this tier and find all matches
      const allMatches = findAllMatches(
        normalizedContent,
        edit.oldText,
        indentationStyle,
        match.tier,
        searchScopes[i],
      );

      if (allMatches.length === 0) {
        const diagnostic = findClosestMatch(normalizedContent, edit.oldText);
        throw getNotFoundError(
          path, i, normalizedEdits.length, diagnostic, edit.description,
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
      const match = findText(normalizedContent, edit.oldText, indentationStyle, 0, searchScopes[i]);

      if (!match.found) {
        const diagnostic = findClosestMatch(normalizedContent, edit.oldText);
        throw getNotFoundError(
          path, i, normalizedEdits.length, diagnostic, edit.description,
        );
      }

      // Check for ambiguity across all tiers
      if (match.tier === MatchTier.UNICODE) {
        // Unicode tier: count occurrences in fuzzy-normalized space
        const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
        const fuzzyOldText = normalizeForFuzzyMatch(edit.oldText);
        let fuzzyCount = 0;
        let pos = 0;
        while ((pos = fuzzyContent.indexOf(fuzzyOldText, pos)) !== -1) {
          fuzzyCount++;
          pos += fuzzyOldText.length;
        }
        if (fuzzyCount > 1) {
          throw getAmbiguousError(
            path, i, normalizedEdits.length, fuzzyCount, edit.description,
          );
        }
      } else if (match.tier === MatchTier.SIMILARITY) {
        // Similarity tier: count how many windows meet the threshold
        // using the same sliding-window approach as trySimilarityMatch.
        const similarityCount = countSimilarityOccurrences(
          normalizedContent,
          edit.oldText,
        );
        if (similarityCount > 1) {
          throw getAmbiguousError(
            path, i, normalizedEdits.length, similarityCount, edit.description,
          );
        }
      } else {
        // Exact and indentation tiers: count occurrences in original content
        const exactCount = countOccurrences(
          normalizedContent,
          match.tier === MatchTier.EXACT
            ? edit.oldText
            : normalizeIndentation(edit.oldText, indentationStyle),
        );
        if (exactCount > 1) {
          throw getAmbiguousError(
            path, i, normalizedEdits.length, exactCount, edit.description,
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

  // Phase 1.5: Pre-apply hooks (conflict detection, etc.)
  if (options?.onBeforeApply) {
    await options.onBeforeApply(matchSpans, normalizedContent);
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
