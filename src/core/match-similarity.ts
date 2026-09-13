/**
 * Similarity subsystem for the smart-edit match engine (Tier 5).
 *
 * Extracted verbatim from src/core/edit-match.ts (MS3): similarity
 * thresholds, dominance check, trySimilarityMatch chain,
 * computeSimilarityScore, countSimilarityOccurrences chain, closest-match
 * diagnostics, and the Levenshtein core. Tier order, thresholds, the 100ms
 * timeout guard, and dominance semantics unchanged. One-way dependency:
 * edit-match.ts consumes this module; this module must NOT import
 * edit-match.ts or edit-diff.ts.
 *
 * Export notes: trySimilarityMatch and levenshteinRatio are exported for
 * edit-match.ts internal use (tier dispatch and textSimilarityRatio);
 * all other export statuses are unchanged from the original.
 */

import type { ClosestMatchDiagnostic, MatchResult } from "./types";
import { MatchTier } from "./types";

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
export const DOMINANT_FUZZY_DELTA = 0.08;


/**
 * Check if a best similarity score is dominant over the next-best match.
 * Dominance means: best >= DOMINANT_FUZZY_MIN_CONFIDENCE AND
 * (best - secondBest) >= DOMINANT_FUZZY_DELTA.
 * This allows auto-accepting a clear winner when the next-best is far behind,
 * reducing spurious "multiple matches" failures for near-identical text.
 */
export function isDominantFuzzyMatch(bestScore: number, secondBestScore: number): boolean {
  return bestScore >= DOMINANT_FUZZY_MIN_CONFIDENCE &&
    (bestScore - secondBestScore) >= DOMINANT_FUZZY_DELTA;
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
interface SimilaritySearchSetup {
  searchEnd: number;
  contentLines: string[];
  oldLines: string[];
  minWindowSize: number;
  maxWindowSize: number;
}

function setupSimilaritySearch(
  originalContent: string,
  oldText: string,
  startOffset: number,
  endOffset?: number,
): SimilaritySearchSetup | null {
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

  // Try different window sizes (allowing for some line count variance)
  const minWindowSize = Math.max(1, oldLines.length - 2);
  const maxWindowSize = Math.min(oldLines.length + 2, contentLines.length);
  return { searchEnd, contentLines, oldLines, minWindowSize, maxWindowSize };
}

function scanSimilarityWindows(
  contentLines: string[],
  oldLines: string[],
  minWindowSize: number,
  maxWindowSize: number,
): { bestScore: number; bestStartLine: number; bestWindowSize: number } {
  // Search for the best matching window in the content
  let bestScore = 0;
  let bestStartLine = 0;
  let bestWindowSize = oldLines.length;

  // Wall-clock timeout: abort if search takes too long
  const startTime = Date.now();
  const TIMEOUT_MS = 100;

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
  return { bestScore, bestStartLine, bestWindowSize };
}

interface SimilarityBestWindow {
  bestStartLine: number;
  bestWindowSize: number;
  bestScore: number;
}

interface SimilarityResultBounds {
  similarityThreshold: number;
  startOffset: number;
  searchEnd: number;
}

function buildSimilarityResult(
  contentLines: string[],
  best: SimilarityBestWindow,
  bounds: SimilarityResultBounds,
): MatchResult | null {
  const { bestStartLine, bestWindowSize, bestScore } = best;
  const { similarityThreshold, startOffset, searchEnd } = bounds;
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

export function trySimilarityMatch(
  originalContent: string,
  oldText: string,
  startOffset: number = 0,
  endOffset?: number,
  similarityThreshold: number = SIMILARITY_MATCH_THRESHOLD,
): MatchResult | null {
  const setup = setupSimilaritySearch(originalContent, oldText, startOffset, endOffset);
  if (!setup) return null;
  const { searchEnd, contentLines, oldLines, minWindowSize, maxWindowSize } = setup;
  const { bestScore, bestStartLine, bestWindowSize } = scanSimilarityWindows(
    contentLines,
    oldLines,
    minWindowSize,
    maxWindowSize,
  );
  return buildSimilarityResult(
    contentLines,
    { bestStartLine, bestWindowSize, bestScore },
    { similarityThreshold, startOffset, searchEnd },
  );
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

/**
 * Count how many windows in content meet the similarity threshold
 * for oldText. Uses the same sliding-window approach as trySimilarityMatch
 * so the count is authoritative for ambiguity detection.
 *
 * Returns an object with the count plus the best and second-best similarity
 * scores found. The scores enable fuzzy-dominant auto-accept logic.
 */
interface SimilarityScanBounds {
  threshold: number;
  minWindowSize: number;
  maxWindowSize: number;
}

function scanSimilarityOccurrenceWindows(
  contentLines: string[],
  oldLines: string[],
  bounds: SimilarityScanBounds,
): { count: number; bestScore: number; secondBestScore: number } {
  const { threshold, minWindowSize, maxWindowSize } = bounds;
  const countedRanges: Array<{ start: number; end: number }> = [];
  let count = 0;
  let bestScore = 0;
  let secondBestScore = 0;
  const startTime = Date.now();
  const TIMEOUT_MS = 100;

  for (let windowSize = minWindowSize; windowSize <= maxWindowSize; windowSize++) {
    if (Date.now() - startTime > TIMEOUT_MS) break;
    for (let startLine = 0; startLine <= contentLines.length - windowSize; startLine++) {
      if (Date.now() - startTime > TIMEOUT_MS) break;
      const windowLines = contentLines.slice(startLine, startLine + windowSize);
      const score = computeSimilarityScore(oldLines, windowLines);
      // Track best/second-best scores for dominant-fuzzy auto-accept
      // Must run for ALL scores (including ≥threshold) so early-exit returns
      // valid bestScore/secondBestScore, not stale sub-threshold values.
      if (score > bestScore) {
        secondBestScore = bestScore;
        bestScore = score;
      } else if (score > secondBestScore) {
        secondBestScore = score;
      }
      if (score >= threshold) {
        const endLine = startLine + windowSize;
        const overlaps = countedRanges.some(
          (r) => startLine < r.end && endLine > r.start,
        );
        if (!overlaps) {
          // No early-exit here: bestScore/secondBestScore must reflect ALL
          // windows so the fuzzy-dominant check downstream sees later
          // near-equal candidates. Count capping would hide ambiguity.
          countedRanges.push({ start: startLine, end: endLine });
          count++;
        }
      }
    }
  }

  return { count, bestScore, secondBestScore };
}

export function countSimilarityOccurrences(
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

  return scanSimilarityOccurrenceWindows(contentLines, oldLines, { threshold, minWindowSize, maxWindowSize });
}

// ─── Closest-match diagnostics ──────────────────────────────────────

/**
 * Find the closest match to oldText in content using line-window comparison.
 * Returns the best candidate with similarity score, line range, and a hint.
 */
function closestFirstPass(
  contentLines: string[],
  oldLines: string[],
): { bestScore: number; bestStart: number; bestWindowSize: number } {
  // First pass: fixed window size equal to oldLines.length (clamped to content).
  // Cache the loop bound so mutations to bestWindowSize inside the loop
  // (from a narrower window winning earlier) don't change the iteration count.
  let bestScore = 0;
  let bestStart = 0;
  let bestWindowSize = Math.min(oldLines.length, contentLines.length);
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
  return { bestScore, bestStart, bestWindowSize };
}

interface ClosestBestState {
  bestScore: number;
  bestStart: number;
  bestWindowSize: number;
}

function closestSecondPass(
  contentLines: string[],
  oldLines: string[],
  incoming: ClosestBestState,
): ClosestBestState {
  let { bestScore, bestStart, bestWindowSize } = incoming;
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
  return { bestScore, bestStart, bestWindowSize };
}

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
  const firstPass = closestFirstPass(contentLines, oldLines);
  const secondPass = closestSecondPass(contentLines, oldLines, firstPass);
  const bestScore = secondPass.bestScore;
  const bestStart = secondPass.bestStart;
  const bestWindowSize = secondPass.bestWindowSize;

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

const MAX_LEVENSHTEIN_CHARS = 500;

export function levenshteinRatio(a: string, b: string): number {
  // Cap inputs: DP is O(n*m), so uncapped long dissimilar lines blow past
  // TIMEOUT_MS inside a single comparison (timeout is only checked between
  // windows). Scoring within the cap is unchanged.
  if (a.length > MAX_LEVENSHTEIN_CHARS) a = a.slice(0, MAX_LEVENSHTEIN_CHARS);
  if (b.length > MAX_LEVENSHTEIN_CHARS) b = b.slice(0, MAX_LEVENSHTEIN_CHARS);
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
