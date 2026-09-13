/**
 * Auto-detection for multi-format input parsing.
 * Identifies which format the input string uses.
 *
 * Supported formats (auto-detected from raw text):
 * - search_replace — `<<<<<<< SEARCH` blocks
 * - unified_diff   — `--- a/` / `+++ b/` with `@@` hunks
 * - openai_patch   — `*** Begin Patch` with unified-diff hunks (single-file)
 * - codex_patch    — `*** Begin Patch` with `*** Add File:`, `*** Delete File:`, `*** Move to:`
 * - atomic_patch   — `*** Begin Atomic Patch` envelope (multi-file: AddFile, DeleteFile, UpdateFile, RenameFile)
 * - raw_edits      — fallback (JSON or unrecognized)
 */

export type InputFormat = 'search_replace' | 'unified_diff' | 'openai_patch' | 'codex_patch' | 'atomic_patch' | 'raw_edits';

/**
 * Detect the input format from the raw input string.
 * 
 * Detection rules:
 * - `<<<<<<< SEARCH` → search_replace
 * - `*** Begin Atomic Patch` or `***Begin Atomic Patch` → atomic_patch
 * - `*** Begin Patch` or `***Begin Patch` (with or without space) →
 *   - `codex_patch` if patch contains `*** Add File:`, `*** Delete File:`, or `*** Move to:`
 *   - `openai_patch` otherwise (simple update-only patches)
 * - `--- ` AND `@@ ` → unified_diff
 * - Otherwise → raw_edits (JSON tool calls)
 */
export function detectInputFormat(input: string): InputFormat {
  const trimmed = input.trim();

  // Strip BOM for detection
  const normalized = trimmed.replace(/^\uFEFF/, '');

  // Skip blank lines to find the first meaningful line
  const lines = normalized.split('\n');
  let firstLine = '';
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.length > 0) {
      firstLine = trimmedLine;
      break;
    }
  }

  // SEARCH marker must start a line (optional leading whitespace) and form a
  // complete block with ======= / >>>>>>> REPLACE lines. Substring match
  // anywhere misroutes JSON payloads whose oldText/newText merely mention
  // the marker text (e.g. "see <<<<<<< SEARCH docs").
  const hasSearchStart = lines.some((l) => l.trimStart().startsWith('<<<<<<< SEARCH'));
  if (hasSearchStart) {
    const hasSeparator = lines.some((l) => l.trimStart().startsWith('======='));
    const hasReplace = lines.some((l) => l.trimStart().startsWith('>>>>>>> REPLACE'));
    if (hasSeparator && hasReplace) {
      return 'search_replace';
    }
  }

  // Check for atomic patch envelope first (more specific than codex patch).
  // Scan any line: the lenient parser skips preamble, so detection must too.
  const hasAtomicBegin = lines.some((l) => {
    const t = l.trim();
    return t.startsWith('*** Begin Atomic Patch') || t.startsWith('***Begin Atomic Patch');
  });
  if (hasAtomicBegin) {
    return 'atomic_patch';
  }

  const hasBegin = lines.some((l) => {
    const t = l.trim();
    return t.startsWith('*** Begin Patch') || t.startsWith('***Begin Patch');
  });
  if (hasBegin) {
    // Check if patch contains Codex-specific markers that require the grammar parser
    const hasCodexMarkers =
      trimmed.includes('*** Add File:') ||
      trimmed.includes('*** Delete File:') ||
      trimmed.includes('*** Move to:') ||
      trimmed.includes('***Add File:') ||
      trimmed.includes('***Delete File:') ||
      trimmed.includes('***Move to:');

    if (hasCodexMarkers) {
      return 'codex_patch';
    }
    return 'openai_patch';
  }

  // Unified diff detection: can start with either --- a/ or +++ b/
  if ((firstLine.startsWith('--- ') || firstLine.startsWith('+++ ')) && normalized.includes('@@ ')) {
    return 'unified_diff';
  }

  return 'raw_edits';
}