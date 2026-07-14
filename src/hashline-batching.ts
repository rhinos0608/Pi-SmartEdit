/**
 * Sort hashline edits bottom-up so higher lines apply first.
 *
 * This preserves line-number stability across a batch and prevents an
 * earlier stale edit from blocking later valid edits in the same file.
 */
export function sortHashlineEditsForApplication(
  edits: Array<{ editIdx: number; sortLine: number; hashline?: Record<string, unknown> }>,
): Array<{ editIdx: number; sortLine: number; hashline?: Record<string, unknown> }> {
  return [...edits].sort((a, b) => {
    const lineDelta = b.sortLine - a.sortLine;
    if (lineDelta !== 0) return lineDelta;
    return a.editIdx - b.editIdx;
  });
}

/**
 * Format a compact batch summary for partial hashline success.
 *
 * When some hashline edits succeed and others fail stale-anchor validation,
 * a single summary keeps the agent output readable while still surfacing
 * that some edits were skipped.
 */
export function formatHashlineBatchSummary(
  totalEdits: number,
  appliedEdits: number,
  failedEdits: Array<{ editIdx: number; message: string }>,
): string | null {
  if (totalEdits <= 0 || failedEdits.length === 0 || failedEdits.length === totalEdits) {
    return null;
  }

  const skipped = failedEdits
    .map((edit) => `#${edit.editIdx + 1}`)
    .join(", ");
  const editWord = failedEdits.length === 1 ? "edit" : "edits";

  return `Hashline batch: applied ${appliedEdits}/${totalEdits} edit(s); skipped stale ${editWord} ${skipped}.`;
}
