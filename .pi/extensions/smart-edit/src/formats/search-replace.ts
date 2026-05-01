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
export function parseSearchReplace(input: string): SearchReplaceBlock[] {
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
      path = lastBeforeLine;
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
  let lines = text.split('\n');
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  return lines.join('\n');
}