/**
 * Parser for OpenAI Patch format (used by Codex CLI).
 * 
 * Format:
 * *** Begin Patch
 * *** Update File: <filepath>
 * @@ anchor line
 * -removed line
 * +added line
 * *** End Patch
 */

export interface OpenAIPatch {
  path: string;
  contextAnchor: string;  // The @@ anchor line
  removedLines: string[]; // Lines prefixed with '-'
  addedLines: string[];   // Lines prefixed with '+'
}

/**
 * Parse OpenAI patch format into structured blocks.
 * 
 * Handles:
 * - Single and multi-section patches
 * - Missing *** End Patch marker (try to parse anyway)
 * - Add-only sections (no removed lines)
 * - Remove-only sections (no added lines)
 * 
 * OldText = contextAnchor + "\n" + removedLines.join("\n")
 * NewText = contextAnchor + "\n" + addedLines.join("\n")
 */
export function parseOpenAIPatch(input: string): OpenAIPatch[] {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const results: OpenAIPatch[] = [];

  // Find all patch sections (between *** Begin Patch and *** End Patch)
  let searchStart = 0;
  
  while (true) {
    const beginIdx = normalized.indexOf('*** Begin Patch', searchStart);
    if (beginIdx === -1) break;

    // Find the end of this patch (or end of file)
    const endIdx = normalized.indexOf('*** End Patch', beginIdx);
    const patchEnd = endIdx !== -1 ? endIdx : normalized.length;
    
    const patchContent = normalized.slice(beginIdx, patchEnd);
    
    // Parse this patch
    const parsed = parseSinglePatch(patchContent);
    results.push(...parsed);

    // Move to next patch
    searchStart = patchEnd + '*** End Patch'.length;
  }

  return results;
}

/**
 * Parse a single OpenAI patch (all sections).
 */
function parseSinglePatch(patch: string): OpenAIPatch[] {
  // Find the file path
  const pathMatch = patch.match(/\*\*\* Update File:\s*(.+?)(?:\n|$)/);
  const path = pathMatch ? pathMatch[1].trim() : '';

  // Find all @@ sections within the patch
  const sections = extractSections(patch);

  if (sections.length === 0) {
    return [];
  }

  return sections.map(section => ({
    path,
    contextAnchor: section.anchor,
    removedLines: section.removed,
    addedLines: section.added,
  }));
}

interface Section {
  anchor: string;    // The @@ line that starts this section
  removed: string[];
  added: string[];
}

/**
 * Extract sections from a patch based on @@ anchor lines.
 */
function extractSections(patch: string): Section[] {
  const sections: Section[] = [];

  // Find all @@ lines and their positions
  const anchorPositions: { idx: number; line: string }[] = [];
  const lines = patch.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      // Found an anchor line — extract the context line
      const anchor = extractAnchorLine(line);
      if (anchor) {
        anchorPositions.push({ idx: i, line: anchor });
      }
    }
  }

  // If no @@ markers found, look for context lines without markers
  if (anchorPositions.length === 0) {
    // Try to find context lines (lines that don't start with + or -)
    // and treat them as anchors
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length > 0 && !line.startsWith('+') && !line.startsWith('-') &&
          !line.startsWith('***') && !line.startsWith('<<<<') && !line.startsWith('>>>>')) {
        anchorPositions.push({ idx: i, line: lines[i] });
        break;
      }
    }
  }

  // Extract content between anchors
  for (let s = 0; s < anchorPositions.length; s++) {
    const startIdx = anchorPositions[s].idx;
    const anchor = anchorPositions[s].line;
    const endIdx = s < anchorPositions.length - 1 
      ? anchorPositions[s + 1].idx 
      : lines.length;

    const sectionLines = lines.slice(startIdx + 1, endIdx);
    
    const removed: string[] = [];
    const added: string[] = [];

    for (const line of sectionLines) {
      if (line.startsWith('-')) {
        removed.push(line.slice(1));
      } else if (line.startsWith('+')) {
        added.push(line.slice(1));
      }
      // Ignore context lines (no prefix) and other markers
    }

    sections.push({
      anchor,
      removed,
      added,
    });
  }

  return sections;
}

/**
 * Extract the context anchor line from a @@ line.
 * The anchor is typically the line after @@ that provides context.
 */
function extractAnchorLine(markerLine: string): string {
  // Handle @@ functionName(...) @@ format (standard LSP-like)
  const match = markerLine.match(/@@\s*(.+?)\s*@@/);
  if (match) {
    return match[1];
  }
  
  // Handle @@ functionName(...) format (no trailing @@ — Codex CLI style)
  // Strip leading @@ and whitespace
  const stripped = markerLine.replace(/^@@\s*/, '');
  if (stripped.length > 0 && stripped !== markerLine) {
    return stripped;
  }
  
  // Fallback: use the marker line itself as context
  return markerLine;
}

/**
 * Convert an OpenAIPatch to EditItem-compatible format.
 */
export function openAIPatchToEditItem(patch: OpenAIPatch): { path: string; oldText: string; newText: string } {
  const removedSection = patch.removedLines.join('\n');
  const addedSection = patch.addedLines.join('\n');

  const oldText = patch.removedLines.length > 0
    ? patch.contextAnchor + '\n' + removedSection
    : patch.contextAnchor;

  const newText = patch.addedLines.length > 0
    ? patch.contextAnchor + '\n' + addedSection
    : patch.contextAnchor;

  return {
    path: patch.path,
    oldText,
    newText,
  };
}