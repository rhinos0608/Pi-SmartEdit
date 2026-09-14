/**
 * Parser for Aider-style search/replace blocks.
 * 
 * Format:
 * [optional-filename]
 * <<<<<<< SEARCH
 * oldText
 * =======
 * newText
 * >>>>>>> REPLACE
 */

import { ParseError } from "../core/errors";

export interface SearchReplaceBlock {
  /** Optional filename hint (first non-marker line of the block) */
  path?: string;
  /** Content between SEARCH and === */
  oldText: string;
  /** Content between === and REPLACE */
  newText: string;
}

/**
 * Parse a search/replace formatted string into blocks.
 * 
 * Handles:
 * - Single and multiple blocks
 * - Optional filename on first line
 * - Nested markers (only top-level triggers split)
 * - CRLF line endings normalized to LF
 * - BOM stripping at the start of input
 * 
 * @throws If a block is truncated (missing REPLACE marker) or SEARCH section is empty
 */
export function parseSearchReplace(input: string, knownPaths?: string[]): SearchReplaceBlock[] {
  const normalized = normalizeSearchReplaceInput(input);

  const result: SearchReplaceBlock[] = [];
  let searchPos = 0;

  while (searchPos < normalized.length) {
    const searchIdx = normalized.indexOf('<<<<<<< SEARCH', searchPos);
    if (searchIdx === -1) break;

    const afterSearchStart = searchIdx + '<<<<<<< SEARCH'.length;
    const hint = extractFilenameHint(normalized, searchPos, searchIdx);
    const sepIdx = findStandaloneSeparator(normalized, afterSearchStart, searchIdx);
    const block = extractOneBlock(normalized, searchIdx, sepIdx, afterSearchStart);
    const path = hint === undefined ? undefined : resolveKnownPath(hint, knownPaths);

    result.push({ path, oldText: block.oldText, newText: block.newText });
    searchPos = block.endPos;
  }

  return result;
}

/** Normalize CRLF/CR to LF and strip leading BOM. */
function normalizeSearchReplaceInput(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
}

/**
 * Find the standalone ======= separator line following a SEARCH marker.
 * Only a separator on its own line splits top-level blocks; nested markers
 * inside SEARCH content are skipped. Throws on missing separator.
 */
function findStandaloneSeparator(normalized: string, afterSearchStart: number, searchIdx: number): number {
  let candidateIdx = normalized.indexOf('\n=======', afterSearchStart);
  while (candidateIdx !== -1) {
    const afterSepIdx = candidateIdx + '\n======='.length;
    const nextChar = afterSepIdx < normalized.length ? normalized[afterSepIdx] : '';

    const trailing = normalized.slice(afterSepIdx).match(/^[^\n]*/)?.[0] ?? '';
    if (nextChar === '\n' || nextChar === '\r' || /^[ \t\r]*$/.test(trailing)) {
      return candidateIdx + 1; // Skip the leading newline
    }

    // Not a proper separator — look for the next one
    candidateIdx = normalized.indexOf('\n=======', candidateIdx + 1);

    // Keep scanning; separator must be a standalone marker line.
  }

  // Fallback: check if the first ======= in the block is on its own line
  const firstSepCandidate = normalized.indexOf('=======', afterSearchStart);
  if (firstSepCandidate !== -1) {
    const beforeFirst = firstSepCandidate > 0 ? normalized[firstSepCandidate - 1] : '\n';
    const afterFirstIdx = firstSepCandidate + '======='.length;
    const afterFirst = afterFirstIdx < normalized.length ? normalized[afterFirstIdx] : '';
    const trailing = normalized.slice(afterFirstIdx).match(/^[^\n]*/)?.[0] ?? '';
    if ((beforeFirst === '\n' || beforeFirst === '\r') && (afterFirst === '\n' || afterFirst === '\r' || /^[ \t\r]*$/.test(trailing))) {
      return firstSepCandidate;
    }
  }

  throw new ParseError(`Unclosed SEARCH block at position ${searchIdx}: missing ======= separator`, 'SEARCH_REPLACE_PARSE', searchIdx);
}

/** Extract one block's old/new text and end position. Throws on missing REPLACE or empty SEARCH. */
function extractOneBlock(normalized: string, searchIdx: number, sepIdx: number, afterSearchStart: number): { oldText: string; newText: string; endPos: number } {
  const replaceIdx = normalized.indexOf('>>>>>>> REPLACE', sepIdx + '======='.length);
  if (replaceIdx === -1) {
    throw new ParseError(`Unclosed SEARCH block at position ${searchIdx}: missing >>>>>>> REPLACE marker`, 'SEARCH_REPLACE_PARSE', searchIdx);
  }

  const oldTextRaw = normalized.slice(afterSearchStart, sepIdx);
  const newTextRaw = normalized.slice(sepIdx + '======='.length, replaceIdx);

  const oldText = normalizeContent(oldTextRaw);
  const newText = normalizeContent(newTextRaw);

  if (oldText.trim().length === 0) {
    throw new ParseError(`SEARCH block at position ${searchIdx} has no oldText`, 'SEARCH_REPLACE_PARSE', searchIdx);
  }

  return { oldText, newText, endPos: replaceIdx + '>>>>>>> REPLACE'.length };
}

/**
 * Extract the filename hint from the line before a SEARCH marker.
 * Returns undefined when no plausible filename is present.
 */
function extractFilenameHint(normalized: string, searchPos: number, searchIdx: number): string | undefined {
  const beforeSearch = normalized.slice(searchPos, searchIdx).trimEnd();
  const beforeLines = beforeSearch.split('\n');
  const lastBeforeLine = beforeLines.length > 0 ? beforeLines[beforeLines.length - 1].trim() : '';

  if (lastBeforeLine.length === 0 ||
      lastBeforeLine.includes('<<<<<<') ||
      lastBeforeLine.includes('>>>>>>') ||
      lastBeforeLine.includes('=======')) {
    return undefined;
  }
  const stripped = stripFilename(lastBeforeLine);
  if (!stripped || (!stripped.includes('.') && !stripped.includes('/'))) {
    return undefined;
  }
  return stripped;
}

/** Resolve a filename hint against known paths (or return it unchanged). */
function resolveKnownPath(stripped: string, knownPaths?: string[]): string {
  if (!knownPaths) return stripped;
  return matchKnownPath(stripped, knownPaths);
}

/**
 * Normalize marker content: strip leading/trailing blank lines.
 */
function normalizeContent(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  return lines.join('\n');
}

/**
 * Strip common artifacts from a potential filename line.
 * Mirrors aider's strip_filename() function.
 */
function stripFilename(line: string): string {
  let s = line.trim();
  // Remove leading # markdown header markers
  s = s.replace(/^#+\s*/, '');
  // Remove surrounding backticks and asterisks
  s = s.replace(/^[`*]+/, '').replace(/[`*]+$/, '');
  // Remove trailing colon
  s = s.replace(/:$/, '');
  return s.trim();
}

/**
 * Find the best matching known path for a candidate filename.
 * Returns the matched path or the candidate itself if no good match found.
 */
function matchKnownPath(candidate: string, knownPaths: string[]): string {
  if (knownPaths.length === 0) return candidate;

  // 1. Exact match.
  if (knownPaths.includes(candidate)) return candidate;

  // 2. Basename match.
  const candidateBase = candidate.split('/').pop() ?? candidate;
  for (const kp of knownPaths) {
    const kpBase = kp.split('/').pop() ?? kp;
    if (kpBase === candidateBase) return kp;
  }

  // 3. Fuzzy: path with lowest normalized edit distance (cutoff 0.8).
  const fuzzy = matchFuzzyPath(candidate, knownPaths);
  if (fuzzy !== undefined) return fuzzy;

  // 4. Any known path ending with the candidate (partial path).
  for (const kp of knownPaths) {
    if (kp.endsWith('/' + candidate)) return kp;
  }

  return candidate;
}

/** 3. Fuzzy: path with lowest normalized edit distance (cutoff 0.8). */
function matchFuzzyPath(candidate: string, knownPaths: string[]): string | undefined {
  let bestPath = candidate;
  let bestScore = 0;
  for (const kp of knownPaths) {
    const score = filenameSimilarity(candidate, kp);
    if (score > bestScore) { bestScore = score; bestPath = kp; }
  }
  if (bestScore >= 0.8) return bestPath;
  return undefined;
}

/** Normalized Levenshtein similarity (0–1) for filename matching */
function filenameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const maxLen = Math.max(la, lb);
  const prev = Array.from({ length: lb + 1 }, (_, j) => j);
  const curr = new Array<number>(lb + 1);
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    for (let k = 0; k <= lb; k++) prev[k] = curr[k];
  }
  return 1 - prev[lb] / maxLen;
}