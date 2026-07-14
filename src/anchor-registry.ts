/**
 * Anchor registry and delta computation for the Pi-SmartEdit ↔ Pi-SmartRead
 * hygiene bridge.
 *
 * Tracks anchor state (hash, position, content, file) and computes deltas
 * between pre-edit snapshot anchors and post-edit content. The delta tells
 * the caller which anchors shifted (same content, new position), which were
 * deleted (content gone), and which changed (content mutated in place).
 *
 * Integration with Pi-SmartEdit:
 *   - computeAnchorDelta is called after each successful edit to produce a
 *     concise model-visible summary of structural changes.
 *   - formatAnchorDeltaForModel collapses high-churn deltas into a single
 *     "recommend re-read" signal instead of enumerating every line.
 *
 * Integration with Pi-SmartRead:
 *   - Anchor deltas feed into context freshness checks. A shifted anchor
 *     means the model's cached knowledge of where a symbol lives is stale.
 *   - The anchor-registry is consumed by the hygiene bridge alongside
 *     smartread-bridge.ts (which handles breakage/co-change recording).
 */

import type { FileSnapshot } from "./core/types";
import { buildHashlineAnchors, computeLineHashSync } from "./core/hashline";

/**
 * Anchor state for a single line — hash, absolute position, content text,
 * and the source file path.
 */
export interface AnchorState {
  hash: string;
  line: number;
  content: string;
  file: string;
}

/**
 * Delta describing how anchors changed between a pre-edit snapshot and
 * post-edit content.
 *
 * Every old anchor in the snapshot falls into exactly one category:
 *   - **shifted** — same content exists at a different line (position
 *     changed, content unchanged).
 *   - **deleted** — content no longer present anywhere in the file.
 *   - **changed** — content at the original position was replaced with
 *     different content (old content is gone; new content occupies the slot).
 *
 * The delta is computed per old anchor key (LINE+HASH).  When the old
 * signature (hash + text) appears at a different line number in the new
 * content, it is **shifted** — the caller should update its position
 * reference.  When it does not appear anywhere and the line position no
 * longer exists, the anchor is **deleted**.  When it does not appear
 * anywhere but the line position still exists with different content, the
 * anchor is **changed**.
 */
export interface AnchorDelta {
  shifted: Array<{
    hash: string;
    oldLine: number;
    newLine: number;
    contentChanged: false;
  }>;
  deleted: Array<{
    hash: string;
    status: "deleted";
  }>;
  changed: Array<{
    hash: string;
    newHash: string;
    oldLine: number;
    newLine: number;
    contentChanged: true;
  }>;
}

/**
 * Default threshold above which formatAnchorDeltaForModel returns a
 * "significant structural change" summary instead of enumerating every
 * shifted/deleted/changed line.
 */
export const ANCHOR_CHURN_THRESHOLD = 20;

/**
 * Extract the bigram hash suffix from a LINE+HASH anchor key.
 *
 * Anchor keys follow the pattern `${line}${hash}` where `hash` is a
 * single-token BPE bigram (e.g. "ab", "st", "th").  Structural lines use
 * ordinal-suffix bigrams ("st", "nd", "rd", "th").  Every entry in the
 * bigram table is exactly two lowercase letters.
 *
 * @param key Anchor key, e.g. "42ab" or "1st".
 * @returns The two-letter bigram hash, or `""` if the key is malformed.
 */
function extractHash(key: string): string {
  const m = key.match(/^(\d+)([a-z]{2})$/);
  return m ? m[2] : "";
}

/**
 * Compare pre-edit snapshot anchors against post-edit content.
 *
 * Uses `buildHashlineAnchors` from the hashline module to compute new
 * anchors, then diffs against `snapshot.hashline.anchors` to classify
 * each old line as shifted, deleted, or changed.
 *
 * Classification logic (per old anchor entry):
 *  1. Compute the old content signature: `"${hash}:${text}"`.
 *  2. Look up the signature in the new content index (built from new anchors).
 *  3. If found:
 *       a. Same line number → unchanged (omitted from delta).
 *       b. Different line number → **shifted** (content moved).
 *  4. If not found:
 *       a. Line position still exists in new content → **changed**
 *          (content at that position was replaced).
 *       b. Line position no longer exists → **deleted** (file got shorter).
 *
 * @param snapshot   Pre-edit FileSnapshot with hashline anchor data.
 * @param newContent Post-edit file content (LF-normalized).  The full
 *                   file content after the edit was applied.
 * @returns AnchorDelta describing what happened to each anchored line.
 */
export async function computeAnchorDelta(
  snapshot: FileSnapshot,
  newContent: string,
): Promise<AnchorDelta> {
  const newLines = newContent.split("\n");
  const newAnchorResult = await buildHashlineAnchors(newLines);
  const newAnchors = newAnchorResult.anchors;

  const oldAnchors = snapshot.hashline?.anchors;
  if (!oldAnchors || oldAnchors.size === 0) {
    return { shifted: [], deleted: [], changed: [] };
  }

  // ── Build old line → { hash, text } map ──────────────────────────────
  const oldByLine = new Map<number, { hash: string; text: string }>();
  for (const [key, val] of oldAnchors) {
    oldByLine.set(val.line, { hash: extractHash(key), text: val.text });
  }

  // ── Build new-content signature index ─────────────────────────────────
  // Signature = "hash:text" — the hash is a bigram that fingerprints the
  // line's content.  By appending the raw text we eliminate collisions
  // between lines that happen to share the same 1-of-672 bigram.
  const newSigToLine = new Map<string, number>();
  for (const [key, val] of newAnchors) {
    const h = extractHash(key);
    const sig = `${h}:${val.text}`;
    // Keep the FIRST occurrence when content appears multiple times.
    if (!newSigToLine.has(sig)) {
      newSigToLine.set(sig, val.line);
    }
  }

  // ── Classify every old anchor ─────────────────────────────────────────
  const shifted: AnchorDelta["shifted"] = [];
  const deleted: AnchorDelta["deleted"] = [];
  const changed: AnchorDelta["changed"] = [];

  for (const [lineNum, oldEntry] of oldByLine) {
    const oldSig = `${oldEntry.hash}:${oldEntry.text}`;
    const newLineFromSig = newSigToLine.get(oldSig);

    if (newLineFromSig !== undefined) {
      // The old content signature exists somewhere in the new file.
      if (newLineFromSig === lineNum) {
        // Same content at the same line — no change to report.
        continue;
      }
      // Same content at a different line — the anchor shifted.
      shifted.push({
        hash: oldEntry.hash,
        oldLine: lineNum,
        newLine: newLineFromSig,
        contentChanged: false,
      });
      continue;
    }

    // Old content signature is gone from the new file.
    if (lineNum <= newLines.length) {
      // The line position still exists — the content was replaced.
      const newHash = computeLineHashSync(lineNum, newLines[lineNum - 1]);
      changed.push({
        hash: oldEntry.hash,
        newHash,
        oldLine: lineNum,
        newLine: lineNum,
        contentChanged: true,
      });
    } else {
      // The line position no longer exists — the anchor is deleted.
      deleted.push({ hash: oldEntry.hash, status: "deleted" });
    }
  }

  return { shifted, deleted, changed };
}

/**
 * Format an AnchorDelta into a concise model-visible summary.
 *
 * Returns `null` when the delta is empty (no changes to report).
 *
 * When the total number of changed anchors exceeds `churnThreshold` the
 * summary collapses to a single "significant structural change" signal
 * that tells the model to re-read the file instead of enumerating every
 * shifted/deleted/changed line individually.
 *
 * @param delta          The computed anchor delta.
 * @param churnThreshold Max entries before collapsing to structural
 *                       summary.  Default: ANCHOR_CHURN_THRESHOLD (20).
 * @returns A human-readable summary string, or `null` if nothing changed.
 */
export function formatAnchorDeltaForModel(
  delta: AnchorDelta,
  churnThreshold: number = ANCHOR_CHURN_THRESHOLD,
): string | null {
  const totalChanges =
    delta.shifted.length + delta.deleted.length + delta.changed.length;

  if (totalChanges === 0) {
    return null;
  }

  // Above threshold: structural-change summary instead of enumeration.
  if (totalChanges > churnThreshold) {
    return `significant structural change, recommend re-read`;
  }

  // Below threshold: concise enumeration grouped by category.
  const parts: string[] = [];

  if (delta.shifted.length > 0) {
    const count = delta.shifted.length;
    const samples = delta.shifted
      .slice(0, 5)
      .map(s => `L${s.oldLine}→L${s.newLine}`)
      .join(", ");
    parts.push(
      `${count} shifted (${samples}${count > 5 ? ", ..." : ""})`,
    );
  }

  if (delta.deleted.length > 0) {
    parts.push(`${delta.deleted.length} deleted`);
  }

  if (delta.changed.length > 0) {
    const count = delta.changed.length;
    const samples = delta.changed
      .slice(0, 5)
      .map(c => `L${c.oldLine}`)
      .join(", ");
    parts.push(
      `${count} changed (${samples}${count > 5 ? ", ..." : ""})`,
    );
  }

  return parts.join("; ");
}
