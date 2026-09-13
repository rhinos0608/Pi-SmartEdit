/**
 * Locate/diagnostic subsystem for the smart-edit match engine.
 *
 * Extracted verbatim from src/core/edit-match.ts (MS4): countOccurrences,
 * findFirstDifferentLine, and formatClosestMatchHint. No logic change.
 * One-way dependency: edit-match.ts consumes this module; this module
 * must NOT import edit-match.ts or edit-diff.ts.
 *
 * Scope note (MS4): findAllMatches and textSimilarityRatio stay in
 * edit-match.ts — they dispatch through findText / normalizeForFuzzyMatch,
 * so moving them here would create an edit-match↔match-locate import
 * cycle. ClosestMatchDiagnostic itself lives in ./types (re-exported
 * through the edit-match.ts facade).
 */

import type { ClosestMatchDiagnostic } from "./types";

// ─── Count occurrences ──────────────────────────────────────────────

export function countOccurrences(content: string, oldText: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(oldText, pos)) !== -1) {
    count++;
    pos += oldText.length;
  }
  return count;
}

// ─── Line diff helper ──────────────────────────────────────────────

function findFirstDifferentLine(
  oldText: string,
  foundText: string,
): { oldLine: string; newLine: string } | null {
  const oldLines = oldText.split("\n");
  const foundLines = foundText.split("\n");
  const maxLen = Math.max(oldLines.length, foundLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : "(empty)";
    const newLine = i < foundLines.length ? foundLines[i] : "(empty)";
    if (oldLine !== newLine) return { oldLine, newLine };
  }
  return null;
}

export function formatClosestMatchHint(
  diagnostic: ClosestMatchDiagnostic,
  allowFuzzy: boolean,
): string {
  const simPct = Math.round(diagnostic.similarity * 100);
  let msg = `\nClosest match (${simPct}% similar) at lines ${diagnostic.lineStart}\u2013${diagnostic.lineEnd}:`;
  const diff = findFirstDifferentLine(diagnostic.expectedText, diagnostic.foundText);
  if (diff) {
    const truncate = (s: string, maxLen = 80): string =>
      s.length > maxLen ? s.slice(0, maxLen) + "\u2026" : s;
    msg += `\n  - ${truncate(diff.oldLine)}`;
    msg += `\n  + ${truncate(diff.newLine)}`;
  }
  msg += `\n  Hint: ${diagnostic.hint}`;
  if (!allowFuzzy) {
    msg += `\n\nFuzzy matching is disabled. Enable Smart Edit fuzzy match settings to accept similarity-based matches.`;
  }
  return msg;
}
