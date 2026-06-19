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

import { ParseError } from "../../lib/errors";

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
  // Normalize CRLF to LF and strip BOM
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');

  const result: SearchReplaceBlock[] = [];
  let searchPos = 0;
  
  while (searchPos < normalized.length) {
    // Find next SEARCH marker
    const searchIdx = normalized.indexOf('<<<<<<< SEARCH', searchPos);
    if (searchIdx === -1) break;
    
    // Extract potential filename (anything between previous content and SEARCH)
    const beforeSearch = normalized.slice(searchPos, searchIdx).trimEnd();
    const beforeLines = beforeSearch.split('\n');
    const lastBeforeLine = beforeLines.length > 0 ? beforeLines[beforeLines.length - 1].trim() : '';
    
    // Find separator — search for ======= that is on its own line (not inside SEARCH content)
    // The ======= must be preceded by newline to distinguish from ===== in SEARCH content
    const afterSearchStart = searchIdx + '<<<<<<< SEARCH'.length;
    let sepIdx = -1;
    
    // Find the next ======= that follows a newline (separator on its own line)
    let candidateIdx = normalized.indexOf('\n=======', afterSearchStart);
    while (candidateIdx !== -1) {
      // Check if it's followed by newline (proper separator line)
      const afterSepIdx = candidateIdx + '\n======='.length;
      const nextChar = afterSepIdx < normalized.length ? normalized[afterSepIdx] : '';
      
      const trailing = normalized.slice(afterSepIdx).match(/^[^\n]*/)?.[0] ?? '';
      if (nextChar === '\n' || nextChar === '\r' || /^[ \t\r]*$/.test(trailing)) {
        sepIdx = candidateIdx + 1; // Skip the leading newline
        break;
      }
      
      // Not a proper separator — look for the next one
      candidateIdx = normalized.indexOf('\n=======', candidateIdx + 1);
      
      // Keep scanning; separator must be a standalone marker line.
    }
    
    // Fallback: check if the first ======= in the block is on its own line
    if (sepIdx === -1) {
      const firstSepCandidate = normalized.indexOf('=======', afterSearchStart);
      if (firstSepCandidate !== -1) {
        // Check if it's preceded by newline (start of line)
        const beforeFirst = firstSepCandidate > 0 ? normalized[firstSepCandidate - 1] : '\n';
        const afterFirstIdx = firstSepCandidate + '======='.length;
        const afterFirst = afterFirstIdx < normalized.length ? normalized[afterFirstIdx] : '';
        const trailing = normalized.slice(afterFirstIdx).match(/^[^\n]*/)?.[0] ?? '';
        if ((beforeFirst === '\n' || beforeFirst === '\r') && (afterFirst === '\n' || afterFirst === '\r' || /^[ \t\r]*$/.test(trailing))) {
          sepIdx = firstSepCandidate;
        }
      }
    }
    
    if (sepIdx === -1) {
      throw new ParseError(`Unclosed SEARCH block at position ${searchIdx}: missing ======= separator`, 'SEARCH_REPLACE_PARSE', searchIdx);
    }
    
    // Find REPLACE marker
    const replaceIdx = normalized.indexOf('>>>>>>> REPLACE', sepIdx + '======='.length);
    if (replaceIdx === -1) {
      throw new ParseError(`Unclosed SEARCH block at position ${searchIdx}: missing >>>>>>> REPLACE marker`, 'SEARCH_REPLACE_PARSE', searchIdx);
    }
    
    // Extract old and new text
    const oldTextRaw = normalized.slice(afterSearchStart, sepIdx);
    const newTextRaw = normalized.slice(sepIdx + '======='.length, replaceIdx);
    
    const oldText = normalizeContent(oldTextRaw);
    const newText = normalizeContent(newTextRaw);
    
    // Check for empty oldText
    if (oldText.trim().length === 0) {
      throw new ParseError(`SEARCH block at position ${searchIdx} has no oldText`, 'SEARCH_REPLACE_PARSE', searchIdx);
    }
    
    // Determine path from line before SEARCH marker
    let path: string | undefined;
    if (lastBeforeLine.length > 0 && 
        !lastBeforeLine.includes('<<<<<<') && 
        !lastBeforeLine.includes('>>>>>>') &&
        !lastBeforeLine.includes('=======')) {
      const stripped = stripFilename(lastBeforeLine);
      if (stripped && (stripped.includes('.') || stripped.includes('/'))) {
        path = knownPaths ? matchKnownPath(stripped, knownPaths) : stripped;
      }
    }
    
    result.push({ path, oldText, newText });
    searchPos = replaceIdx + '>>>>>>> REPLACE'.length;
  }

  return result;
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

  // 1. Exact match
  if (knownPaths.includes(candidate)) return candidate;

  // 2. Basename match
  const candidateBase = candidate.split('/').pop() ?? candidate;
  for (const kp of knownPaths) {
    const kpBase = kp.split('/').pop() ?? kp;
    if (kpBase === candidateBase) return kp;
  }

  // 3. Fuzzy: find path with lowest normalized edit distance (cutoff 0.8)
  let bestPath = candidate;
  let bestScore = 0;
  for (const kp of knownPaths) {
    const score = filenameSimilarity(candidate, kp);
    if (score > bestScore) { bestScore = score; bestPath = kp; }
  }
  if (bestScore >= 0.8) return bestPath;

  // 4. Any known path that ends with the candidate (partial path)
  for (const kp of knownPaths) {
    if (kp.endsWith('/' + candidate)) return kp;
  }

  return candidate;
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