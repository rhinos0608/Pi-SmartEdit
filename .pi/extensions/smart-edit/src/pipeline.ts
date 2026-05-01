/**
 * ─── ⚠ ORPHANED — NOT INTEGRATED ⚠ ─────────────────────────────────────────
 *
 * This file was an early attempt at a multi-format pipeline but is never
 * imported by index.ts or any other entry point. It reimplements an edit
 * flow that calls applyEdits directly WITHOUT the stale-file guard, atomic
 * write, or mutation queue that index.ts provides.
 *
 * If wired up as-is, this creates a broken, unsafe edit path.
 *
 * To integrate properly:
 *   - Use the same read -> checkStale -> apply -> atomicWrite -> recordRead
 *     sequence that index.ts uses
 *   - Hook into the per-file mutation queue (withFileMutationQueue)
 *   - Register conflict detection and LSP diagnostics hooks
 *
 * For now, do NOT import this file from any production code path.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { detectInputFormat, type InputFormat } from './formats/format-detector';
import { parseSearchReplace } from './formats/search-replace';
import { parseUnifiedDiffToEditItems } from './formats/unified-diff';
import { parseOpenAIPatch, openAIPatchToEditItem } from './formats/openai-patch';
import { applyEdits, type EditItem } from '../lib/edit-diff';

export interface PipelineInput {
  /** The file path (required for raw edits, optional for format-embedded patches) */
  path?: string;
  /** The edit content — could be raw edits, search/replace blocks, etc. */
  content: string;
  /** Override auto-detected format */
  format?: InputFormat;
}

export interface PipelineResult {
  success: boolean;
  edits: Array<{ path: string; oldText: string; newText: string }>;
  applied: boolean;
  matchNotes: string[];
  error?: string;
}

/**
 * Run the edit pipeline on the given input.
 * 
 * Detects format, routes to appropriate parser, and applies edits.
 */
export async function runEditPipeline(
  input: PipelineInput,
  fileContent: string,
): Promise<PipelineResult> {
  const format = input.format || detectInputFormat(input.content);

  let editItems: Array<{ path?: string; oldText: string; newText: string }> = [];

  switch (format) {
    case 'search_replace': {
      const blocks = parseSearchReplace(input.content);
      editItems = blocks.map(block => ({
        path: block.path,
        oldText: block.oldText,
        newText: block.newText,
      }));
      break;
    }

    case 'unified_diff': {
      const items = parseUnifiedDiffToEditItems(input.content);
      editItems = items;
      break;
    }

    case 'openai_patch': {
      const patches = parseOpenAIPatch(input.content);
      editItems = patches.map(patch => openAIPatchToEditItem(patch));
      break;
    }

    case 'raw_edits': {
      // No formatting needed — caller should use applyEdits directly
      return { success: true, edits: [], applied: false, matchNotes: [] };
    }
  }

  // If a path was explicitly provided, use it for edits without path info
  for (const item of editItems) {
    if (!item.path && input.path) {
      item.path = input.path;
    }
  }

  // Group edits by path
  const byPath = groupBy(editItems, (e) => e.path || input.path || '');

  // Apply each file's edits through existing applyEdits pipeline
  const allResults: string[] = [];

  for (const [filePath, pathEdits] of Object.entries(byPath)) {
    if (!filePath) continue; // Skip edits without path

    const editItemsForApply: EditItem[] = pathEdits.map(e => ({
      oldText: e.oldText,
      newText: e.newText,
    }));

    try {
      const result = await applyEdits(fileContent, editItemsForApply, filePath);
      allResults.push(...result.matchNotes);
    } catch (error) {
      return {
        success: false,
        edits: editItems,
        applied: false,
        matchNotes: allResults,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    success: true,
    edits: editItems,
    applied: true,
    matchNotes: allResults,
  };
}

/**
 * Group an array by a key function.
 */
function groupBy<T, K extends string | number>(
  array: T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  const result: Partial<Record<K, T[]>> = {};

  for (const item of array) {
    const key = keyFn(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key]!.push(item);
  }

  return result as Record<K, T[]>;
}