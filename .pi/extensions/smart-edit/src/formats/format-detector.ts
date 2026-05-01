/**
 * Auto-detection for multi-format input parsing.
 * Identifies which format the input string uses.
 */

export type InputFormat = 'search_replace' | 'unified_diff' | 'openai_patch' | 'raw_edits';

/**
 * Detect the input format from the raw input string.
 * 
 * Detection rules:
 * - `<<<<<<< SEARCH` → search_replace
 * - `*** Begin Patch` or `***Begin Patch` (with or without space) → openai_patch
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

  if (firstLine.startsWith('*** Begin Patch') || firstLine.startsWith('***Begin Patch')) {
    return 'openai_patch';
  }

  if (firstLine.startsWith('--- ') && trimmed.includes('@@ ')) {
    return 'unified_diff';
  }

  return 'raw_edits';
}