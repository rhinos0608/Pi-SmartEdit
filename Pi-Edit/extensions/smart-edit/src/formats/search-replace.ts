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
 * 
 * @throws If a block is truncated (missing REPLACE marker) or SEARCH section is empty
 */
export function parseSearchReplace(input: string, knownPaths?: string[]): SearchReplaceBlock[] {
  // Normalize CRLF to LF
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

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
    
    // Find separator
    const afterSearchStart = searchIdx + '<<<<<<< SEARCH'.length;
    const sepIdx = normalized.indexOf('=======', afterSearchStart);
    if (sepIdx === -1) {
      throw new Error(`Unclosed SEARCH block at position ${searchIdx}: missing ======= separator`);
    }
    
    // Find REPLACE marker
    const replaceIdx = normalized.indexOf('>>>>>>> REPLACE', sepIdx + '======='.length);
    if (replaceIdx === -1) {
      throw new Error(`Unclosed SEARCH block at position ${searchIdx}: missing >>>>>>> REPLACE marker`);
    }
    
    // Extract old and new text
    const oldTextRaw = normalized.slice(afterSearchStart, sepIdx);
    const newTextRaw = normalized.slice(sepIdx + '======='.length, replaceIdx);
    
    const oldText = normalizeContent(oldTextRaw);
    const newText = normalizeContent(newTextRaw);
    
    // Check for empty oldText
    if (oldText.trim().length === 0) {
      throw new Error(`SEARCH block at position ${searchIdx} has no oldText`);
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
  const curr = new Array(lb + 1);
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

function normalizeContent(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  return lines.join('\n');
}