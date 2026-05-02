/**
 * File read-cache for stale-file detection.
 *
 * Maintains in-memory snapshots of files when they're read by the model.
 * On edit, checks whether the file has been modified since the last read.
 *
 * Uses mtime + size + content hash to avoid both false positives
 * (mtime change without content change) and false negatives
 * (content change that doesn't change mtime on APFS).
 *
 * On macOS APFS, there is a known VFS caching behavior where `stat()`
 * immediately after `rename()` can return metadata from the old inode
 * for a brief window. checkStale uses a retry mechanism: on first hash
 * mismatch, it waits ~20ms and re-reads the file. If the retry hash
 * matches the snapshot, the mismatch was transient (stale VFS metadata
 * in recordRead from a recent atomicWrite rename) and is silently
 * corrected. Only a second consecutive mismatch triggers the error.
 */

import { statSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";
import type { FileSnapshot } from "./types";
import { fastHash } from "./types";
import type { buildHashlineAnchors } from "./hashline";

// ─── Retry configuration ───────────────────────────────────────────

/**
 * On APFS/macOS, `stat` after `rename` can briefly return metadata from
 * the replaced inode. checkStale uses exponential backoff retries:
 * 3 attempts with delays of 20ms, 40ms, 80ms to let VFS settle.
 */
const CHECK_STALE_MAX_RETRIES = 3;
const CHECK_STALE_BASE_DELAY_MS = 20;

/**
 * Promise-based sleep for retry delays.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** In-memory cache of file snapshots */
const snapshotCache = new Map<string, FileSnapshot>();

// ─── Session read tracking (for range coverage validation) ────────────

/**
 * Range of a file read during a session.
 * Tracks what portion of a file was actually read/displayed to the model,
 * enabling range coverage validation on edit (P1: pi-lens read-guard pattern).
 */
export interface ReadRange {
  /** 1-based start line (inclusive). Defaults to 1. */
  offset: number;
  /** Number of lines read, or -1 for full file. */
  limit: number;
  /** Total file lines at time of read (0 if unknown). */
  totalLines: number;
  /** Timestamp of the read. */
  timestamp: number;
  /** Which tool performed the read ("read", "read_multiple_files", "intent_read"). */
  source: string;
}

/** Track ALL reads across the session for range coverage checks. */
const sessionReads = new Map<string, ReadRange[]>();

/**
 * Record a file read in the session map.
 * Called from index.ts when any read tool succeeds.
 *
 * This is separate from the snapshot cache (which handles stale detection).
 * sessionReads tracks the range of content the model actually saw,
 * enabling range coverage validation before edits.
 */
export function recordReadSession(
  path: string,
  cwd: string,
  offset: number,
  limit: number,
  totalLines: number,
  source: string,
): void {
  const normalized = normalizePath(path, cwd);
  const reads = sessionReads.get(normalized) ?? [];
  reads.push({ offset, limit, totalLines, timestamp: Date.now(), source });
  sessionReads.set(normalized, reads);
}

/**
 * Get all session reads for a file, or empty array if never read.
 */
export function getSessionReads(path: string, cwd: string): ReadRange[] {
  const normalized = normalizePath(path, cwd);
  return sessionReads.get(normalized) ?? [];
}

/**
 * Get the most recent full-file read, or null.
 */
export function getLastFullRead(path: string, cwd: string): ReadRange | null {
  const reads = getSessionReads(path, cwd);
  // Walk backwards to find the most recent full-file read
  for (let i = reads.length - 1; i >= 0; i--) {
    if (reads[i].limit === -1 && reads[i].totalLines > 0) return reads[i];
  }
  return null;
}

/**
 * Normalize a path for cache key lookup.
 * Resolves relative paths against cwd.
 */
function normalizePath(path: string, cwd: string): string {
  return resolve(cwd, path);
}

/**
 * Record a file snapshot after a successful read.
 *
 * @param partial - If true, the read was partial (truncated output or offset/limit).
 *   Partial snapshots only verify mtime on stale check — they skip content hash
 *   and size comparison since we don't have the full file content.
 * @param hashline - Optional hashline anchor data. If provided, the snapshot
 *   stores LINE+ID anchors for each line, enabling hashline-anchored editing.
 *   Should be the result of buildHashlineAnchors(content.split('\n')).
 */
export function recordRead(
  path: string,
  cwd: string,
  content: string,
  partial?: boolean,
  hashline?: Awaited<ReturnType<typeof buildHashlineAnchors>>,
): void {
  const normalized = normalizePath(path, cwd);
  const stat = statSync(normalized);

  const snapshot: FileSnapshot = {
    path: normalized,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    contentHash: fastHash(content),
    readAt: Date.now(),
    partial: partial ?? false,
  };

  if (hashline) {
    snapshot.hashline = hashline;
  }

  snapshotCache.set(normalized, snapshot);
}

/**
 * Helper: build the stale-file error message for consistent formatting
 * across the first-failure and second-failure code paths.
 */
function staleError(path: string, snapshotMtime: number, statMtime: number): string {
  return (
    `File ${path} has been modified since your last read ` +
    `(mtime changed from ${new Date(snapshotMtime).toISOString()} ` +
    `to ${new Date(statMtime).toISOString()}). ` +
    `Re-read the file before editing.`
  );
}

/**
 * Check whether a file has been modified since its last recorded read.
 * Returns null if the file hasn't changed, or an error message if it has.
 *
 * Partial snapshots (from truncated reads or offset/limit reads) only verify
 * mtime — they skip content hash and size comparison since the saved snapshot
 * doesn't represent the full file.
 *
 * RETRY LOGIC: On APFS/macOS, `stat` after `rename` can briefly return
 * metadata from the replaced inode. If the content hash doesn't match the
 * snapshot but DOES match after a short pause (20ms), the snapshot mtime
 * was stale and is silently corrected. This prevents false-positive
 * "file has been modified" errors on consecutive edits to the same file.
 *
 * KNOWN GAP: Files injected into the session context by Pi itself at
 * startup (e.g., via --context somefile.ts or @mention that doesn't
 * trigger a tool_result event) are not recorded in the snapshot cache.
 * The first edit to such a file will be rejected with "this file has
 * not been read." Users starting fresh sessions should explicitly read
 * files before editing.
 */
export async function checkStale(path: string, cwd: string): Promise<string | null> {
  const normalized = normalizePath(path, cwd);

  // Has the file ever been read?
  const snapshot = snapshotCache.get(normalized);
  if (!snapshot) {
    return (
      `Cannot edit ${path} — this file has not been read in the current session. ` +
      `Read the file first, then retry.`
    );
  }

  try {
    const stat = statSync(normalized);

    // Check mtime
    if (stat.mtimeMs !== snapshot.mtimeMs) {
      if (snapshot.partial) {
        // Partial snapshots can't verify content hash — treat any mtime change
        // as a potential modification
        return staleError(path, snapshot.mtimeMs, stat.mtimeMs);
      }

      // mtime changed — read file and check if content actually changed
      const currentContent = await readFile(normalized, "utf-8");
      const currentHash = fastHash(currentContent);

      if (currentHash !== snapshot.contentHash) {
        // ═══ Retry loop: APFS/VFS can have stale metadata after rename ═══
        // Content hash differs from snapshot. On APFS, this can be a
        // transient VFS inconsistency where `stat` returned metadata from
        // the old inode while `readFile` read current content. Retry
        // with exponential backoff to let the VFS cache settle.
        for (let attempt = 0; attempt < CHECK_STALE_MAX_RETRIES; attempt++) {
          const delayMs = CHECK_STALE_BASE_DELAY_MS * Math.pow(2, attempt);
          await sleep(delayMs);

          const retryStat = statSync(normalized);
          const retryContent = await readFile(normalized, 'utf-8');
          const retryHash = fastHash(retryContent);

          if (retryHash === snapshot.contentHash) {
            // Content matches — the miss was transient VFS inconsistency.
            // Update snapshot with settled metadata and proceed.
            snapshot.mtimeMs = retryStat.mtimeMs;
            snapshot.size = retryStat.size;
            return null;
          }
        }

        // All retries failed — the file truly changed.
        return staleError(path, snapshot.mtimeMs, stat.mtimeMs);
      }

      // mtime changed but content is the same — update snapshot mtime
      snapshot.mtimeMs = stat.mtimeMs;
    }

    // Full snapshots only: verify size hasn't changed
    if (!snapshot.partial && stat.size !== snapshot.size) {
      return (
        `File ${path} has been modified since your last read ` +
        `(size changed from ${snapshot.size} to ${stat.size} bytes). ` +
        `Re-read the file before editing.`
      );
    }
  } catch {
    // File may have been deleted — let the edit tool handle file-not-found
    return null;
  }

  return null; // file is fresh
}

/**
 * Get the cached snapshot for a path, or null if not cached.
 */
export function getSnapshot(path: string, cwd: string): FileSnapshot | null {
  const normalized = normalizePath(path, cwd);
  return snapshotCache.get(normalized) || null;
}

/**
 * Record a snapshot with explicit metadata (bypasses statSync).
 *
 * Used after edits where statSync may return stale APFS inode metadata
 * immediately after atomicWrite's rename(). The caller provides settled
 * mtime/size from async stat with retry, and the guaranteed-correct
 * in-memory content (what was actually written).
 */
export function recordReadWithStat(
  path: string,
  cwd: string,
  content: string,
  mtimeMs: number,
  size: number,
  hashline?: Awaited<ReturnType<typeof buildHashlineAnchors>>,
): void {
  const normalized = normalizePath(path, cwd);
  const snapshot: FileSnapshot = {
    path: normalized,
    mtimeMs,
    size,
    contentHash: fastHash(content),
    readAt: Date.now(),
    partial: false,
  };

  if (hashline) {
    snapshot.hashline = hashline;
  }

  snapshotCache.set(normalized, snapshot);
}

/**
 * Clear all cached snapshots.
 */
export function clearCache(): void {
  snapshotCache.clear();
}

// ─── Range coverage validation (P1: pi-lens read-guard pattern) ──────

/**
 * Check if a byte range is covered by session reads.
 *
 * Merges all read intervals for the file (supporting multiple partial reads)
 * and checks that [editStartLine, editEndLine] falls within at least one.
 *
 * Returns null if covered, or an error message with actionable hints if not.
 */
export function checkRangeCoverage(
  path: string,
  cwd: string,
  editStartLine: number,
  editEndLine: number,
): { covered: true } | { covered: false; reason: string } {
  const normalized = normalizePath(path, cwd);
  const reads = sessionReads.get(normalized);
  if (!reads || reads.length === 0) {
    return {
      covered: false,
      reason: `Cannot validate range coverage for ${path}: no read recorded.`,
    };
  }

  // Merge all read intervals
  const intervals: Array<[number, number]> = reads
    .map((r) => {
      const start = r.offset;
      const end = r.limit === -1 ? r.totalLines : r.offset + r.limit - 1;
      return [start, end] as [number, number];
    })
    .filter(([s, e]) => s > 0 && e >= s)
    .sort((a, b) => a[0] - b[0]);

  if (intervals.length === 0) return { covered: true }; // no valid intervals — allow

  // Merge overlapping/adjacent intervals
  const merged: Array<[number, number]> = [];
  for (const [s, e] of intervals) {
    if (merged.length > 0 && s <= merged[merged.length - 1][1] + 1) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }

  // Check if [editStartLine, editEndLine] falls within any merged interval
  for (const [s, e] of merged) {
    if (editStartLine >= s && editEndLine <= e) {
      return { covered: true };
    }
  }

  // Not covered — build actionable error
  const lastRead = reads[reads.length - 1];
  const lastRange =
    lastRead.limit === -1
      ? `lines 1-${lastRead.totalLines}`
      : `lines ${lastRead.offset}-${lastRead.offset + lastRead.limit - 1}`;

  // Suggest a sensible re-read range
  const reReadOffset = Math.max(1, editStartLine - 10);
  const reReadLimit = Math.min(100, editEndLine - reReadOffset + 20);

  return {
    covered: false,
    reason:
      `🔴 Edit outside read range

` +
      `You read \`${path}\` as ${lastRange} (${lastRead.source}),
` +
      `but your edit targets lines ${editStartLine}-${editEndLine}.

` +
      `To proceed:
` +
      `  1. Read the file section: \`read path="${path}" offset=${reReadOffset} limit=${reReadLimit}\`
` +
      `  2. Or read the full file: \`read path="${path}"\``,
  };
}

/**
 * Unified edit-safety check combining stale detection + range coverage.
 *
 * This is the primary guard function. Call it before applying any edit.
 * Replaces raw calls to checkStale() with a more complete validation.
 *
 * @param path - File path (relative or absolute)
 * @param cwd - Current working directory
 * @param editLines - Optional [startLine, endLine] (1-based) for range coverage check.
 *   If omitted, only stale-file check is performed.
 * @returns { allowed: true } or { allowed: false, reason: string }
 */
export async function checkEditAllowed(
  path: string,
  cwd: string,
  editLines?: [number, number],
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  // Check 1: Stale file detection (also handles zero-read via snapshotCache)
  const staleError = await checkStale(path, cwd);
  if (staleError) {
    return { allowed: false, reason: staleError };
  }

  // Check 2: Range coverage (if edit line range provided)
  if (editLines) {
    const coverage = checkRangeCoverage(path, cwd, editLines[0], editLines[1]);
    if (!coverage.covered) {
      return { allowed: false, reason: coverage.reason };
    }
  }

  return { allowed: true };
}
