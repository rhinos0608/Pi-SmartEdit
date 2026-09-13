/**
 * Hashline fallback-support leaf — symbol anchor parsing, fallback metrics,
 * edit location description, match application, and oldText reconstruction.
 *
 * Verbatim extraction from `src/hashline/hashline-edit.ts` (MS5 split).
 * No logic, threshold, or message changes — moves only.
 */

import type { EditAnchor, FileSnapshot } from "../core/types";
import {
  formatAnchor,
  type HashlineEditOp,
} from "./hashline-anchor";

/**
 * Get a human-readable description of an edit's location.
 */
export function describeEditLocation(edit: HashlineEditOp): string {
  switch (edit.op) {
    case "replace_range":
      return `lines ${edit.pos.line}-${edit.end.line} (anchors ${formatAnchor(edit.pos)}-${formatAnchor(edit.end)})`;
    case "append_at":
      return `after line ${edit.pos.line} (anchor ${formatAnchor(edit.pos)})`;
    case "prepend_at":
      return `before line ${edit.pos.line} (anchor ${formatAnchor(edit.pos)})`;
    case "append_file":
      return `end of file`;
    case "prepend_file":
      return `start of file`;
  }
}

// ─── Symbol Anchor Parsing ────────────────────────────────────────────────────

/**
 * Parse a symbol anchor from hashline input into EditAnchor format.
 * Used by the scoped fallback path to resolve AST scopes.
 */
export function parseSymbolAnchor(
  symbol?: { name: string; kind?: string; line?: number },
): EditAnchor | undefined {
  if (!symbol) return undefined;
  return {
    symbolName: symbol.name,
    symbolKind: symbol.kind,
    symbolLine: symbol.line,
  };
}

// ─── Fallback Metrics ────────────────────────────────────────────────────────

/**
 * Track which resolution tier was used for each hashline edit.
 * Used for development visibility and A/B comparison.
 */
export type FallbackTier =
  | "hashline-direct"       // Fast path: hashes matched immediately
  | "hashline-rebased"      // Anchors rebased within ±5 window
  | "scoped-fallback"       // Hash stale, symbol resolved → scoped 4-tier match
  | "full-fuzzy-fallback"   // All hashline paths failed → full 4-tier pipeline
  | "hash-mismatch-reject"; // Genuine mismatch, all paths failed → error thrown

export interface HashlineMetrics {
  hashlineDirect: number;
  hashlineRebased: number;
  scopedFallback: number;
  fullFuzzyFallback: number;
  hashMismatchRejects: number;
}

/** Module-level metrics accumulator. Reset between batches or sessions. */
export const hashlineMetrics: HashlineMetrics = {
  hashlineDirect: 0,
  hashlineRebased: 0,
  scopedFallback: 0,
  fullFuzzyFallback: 0,
  hashMismatchRejects: 0,
};

/**
 * Record a tier usage and return the updated count.
 * Development visibility only — does not affect edit behavior.
 */
export function recordFallbackTier(tier: FallbackTier): void {
  switch (tier) {
    case "hashline-direct":        hashlineMetrics.hashlineDirect++; break;
    case "hashline-rebased":       hashlineMetrics.hashlineRebased++; break;
    case "scoped-fallback":        hashlineMetrics.scopedFallback++; break;
    case "full-fuzzy-fallback":     hashlineMetrics.fullFuzzyFallback++; break;
    case "hash-mismatch-reject":   hashlineMetrics.hashMismatchRejects++; break;
  }
}

/**
 * Get a copy of current metrics for reporting.
 */
export function getHashlineMetrics(): HashlineMetrics {
  return { ...hashlineMetrics };
}

/**
 * Reset metrics to zero. Call between benchmark runs.
 */
export function resetHashlineMetrics(): void {
  hashlineMetrics.hashlineDirect = 0;
  hashlineMetrics.hashlineRebased = 0;
  hashlineMetrics.scopedFallback = 0;
  hashlineMetrics.fullFuzzyFallback = 0;
  hashlineMetrics.hashMismatchRejects = 0;
}

// ─── Fallback Helpers ────────────────────────────────────────────────────────

/**
 * Apply a match result to content, replacing matchedText with newLines.
 * Returns the modified content.
 */
export function applyMatchInPlace(
  content: string,
  match: { index: number; matchLength: number; matchedText: string },
  newLines: string[],
): string {
  const before = content.slice(0, match.index);
  const after = content.slice(match.index + match.matchLength);
  return before + newLines.join("\n") + after;
}

/**
 * Count lines up to (but not including) a byte offset.
 * Used to report firstChangedLine for fuzzy fallback results.
 */
export function countLinesUpToIndex(content: string, byteIndex: number): number {
  const prefix = content.slice(0, byteIndex);
  return (prefix.match(/\n/g) ?? []).length + 1;
}

// ─── Reconstruct oldText from cache ─────────────────────────────────────────

/**
 * Reconstruct the oldText that should have been matched, using the hashline
 * anchor data stored in the read cache.
 *
 * This is used by the fallback path when hashline validation fails but we
 * still need to run the 4-tier fuzzy matcher.
 *
 * @param snapshot   The FileSnapshot from the read cache.
 * @param posAnchor  Start anchor string (e.g., "42ab")
 * @param endAnchor  End anchor string (e.g., "45cd")
 * @returns The reconstructed oldText or null if anchors not found in cache.
 */
export function reconstructOldText(
  snapshot: FileSnapshot,
  posAnchor: string,
  endAnchor: string,
): string | null {
  if (!snapshot.hashline?.anchors) {
    return null;
  }

  const anchors = snapshot.hashline.anchors;

  // Find the range of lines between pos and end anchors
  const posEntry = anchors.get(posAnchor);
  const endEntry = anchors.get(endAnchor);

  if (!posEntry || !endEntry) {
    return null;
  }

  const startLine = posEntry.line;
  const endLine = endEntry.line;

  // Collect the text for all lines in the range
  const lines: string[] = [];
  for (let ln = startLine; ln <= endLine; ln++) {
    for (const [key, val] of anchors) {
      if (val.line === ln) {
        lines.push(val.text);
        break;
      }
    }
  }

  // Validate completeness: every line in range must have an anchor entry
  if (lines.length !== endLine - startLine + 1) return null;

  return lines.join("\n");
}

/**
 * Reconstruct the oldText from a FileSnapshot using line numbers directly.
 */
export function reconstructOldTextByLine(
  snapshot: FileSnapshot,
  startLine: number,
  endLine: number,
): string | null {
  if (!snapshot.hashline?.anchors) {
    return null;
  }

  const lines: string[] = [];
  for (let ln = startLine; ln <= endLine; ln++) {
    for (const [, val] of snapshot.hashline.anchors) {
      if (val.line === ln) {
        lines.push(val.text);
        break;
      }
    }
  }

  return lines.length === endLine - startLine + 1 ? lines.join("\n") : null;
}
