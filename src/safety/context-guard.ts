import {
  detectIndentation,
  findText,
  normalizeIndentation,
  textSimilarityRatio,
} from "../core/edit-diff";
import type { EditItem, SearchScope } from "../core/types";

export const CONTEXT_GUARD_SIMILARITY_THRESHOLD = 0.95;

export interface ContextGuardSimilarityResult {
  allowed: boolean;
  notes: string[];
  reason?: string;
}

export function checkContextGuardSimilarity(
  content: string,
  edits: EditItem[],
  searchScopes: Array<SearchScope | undefined> = [],
  threshold: number = CONTEXT_GUARD_SIMILARITY_THRESHOLD,
): ContextGuardSimilarityResult {
  const indentationStyle = detectIndentation(content);
  const notes: string[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (typeof edit.oldText !== "string" || edit.oldText.length === 0) {
      return {
        allowed: false,
        notes,
        reason: `edit #${i + 1} has no oldText to compare`,
      };
    }

    const match = findText(content, edit.oldText, indentationStyle, 0, searchScopes[i]);
    if (!match.found) {
      return {
        allowed: false,
        notes,
        reason: `edit #${i + 1} oldText did not match current file content`,
      };
    }

    const score = Math.max(
      textSimilarityRatio(edit.oldText, match.matchedText),
      textSimilarityRatio(normalizeIndentation(edit.oldText, indentationStyle), match.matchedText),
    );

    if (score < threshold) {
      return {
        allowed: false,
        notes,
        reason: `edit #${i + 1} matched current content at ${(score * 100).toFixed(1)}%, below ${(threshold * 100).toFixed(0)}% threshold`,
      };
    }

    notes.push(`context guard bypass: edit #${i + 1} matched current content at ${(score * 100).toFixed(1)}% similarity`);
  }

  return { allowed: true, notes };
}
