/**
 * Auto-detection for multi-format input parsing.
 * Identifies which format the input string uses.
 */

export type InputFormat = 'search_replace' | 'unified_diff' | 'openai_patch' | 'codex_patch' | 'atomic_patch' | 'raw_edits';

/**
 * Detect the input format from the raw input string.
 * 
 * Detection rules:
 * - `<<<<<<< SEARCH` → search_replace
 * - `*** Begin Patch` or `***Begin Patch` (with or without space) →
 *   - `codex_patch` if patch contains `*** Add File:`, `*** Delete File:`, or `*** Move to:`
 *   - `openai_patch` otherwise (simple update-only patches)
 * - `--- ` AND `@@ ` → unified_diff
 * - Otherwise → raw_edits (JSON tool calls)
 */
export function detectInputFormat(input: string): InputFormat {
  const trimmed = input.trim();

  // Search with leading filename: "src/foo.ts\n<<<<<<< SEARCH"
  // Search without filename: "<<<<<<< SEARCH"
  const firstLine = trimmed.split('\n')[0].trim();
  if (trimmed.includes('<<<<<<< SEARCH')) {
    return 'search_replace';
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

  if (firstLine.startsWith('--- ') && trimmed.includes('@@ ')) {
    return 'unified_diff';
  }

  return 'raw_edits';
}