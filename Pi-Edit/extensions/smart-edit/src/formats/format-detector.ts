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

  if (normalized.includes('<<<<<<< SEARCH')) {
    return 'search_replace';
  }

  // Check for atomic patch envelope first (more specific than codex patch)
  if (firstLine.startsWith('*** Begin Atomic Patch') || firstLine.startsWith('***Begin Atomic Patch')) {
    return 'atomic_patch';
  }

  // Check for atomic patch envelope first (more specific than codex patch)
  if (firstLine.startsWith('*** Begin Atomic Patch') || firstLine.startsWith('***Begin Atomic Patch')) {
    return 'atomic_patch';
  }

  if (firstLine.startsWith('*** Begin Patch') || firstLine.startsWith('***Begin Patch')) {
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