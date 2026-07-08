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

// ─── Cache capacity limits ─────────────────────────────────────────────

/** Maximum number of file snapshots in the cache (LRU eviction). */
const SNAPSHOT_CACHE_MAX = 200;

/** Maximum number of unique files in sessionReads (LRU eviction). */
const SESSION_READS_MAX = 500;

/**
 * Evict oldest entries from snapshotCache when it exceeds max size.
 * Uses readAt timestamp to determine LRU ordering.
 */
function evictStaleSnapshots(): void {
  if (snapshotCache.size <= SNAPSHOT_CACHE_MAX) return;

  // Sort entries by readAt timestamp (oldest first)
  const entries = [...snapshotCache.entries()].sort((a, b) => a[1].readAt - b[1].readAt);

  // Remove oldest entries until we're under the limit
  const toRemove = entries.slice(0, snapshotCache.size - SNAPSHOT_CACHE_MAX);
  for (const [key] of toRemove) {
    snapshotCache.delete(key);
  }
}

/**
 * Evict entries with oldest timestamps from sessionReads when it exceeds max size.
 * For each file, finds the oldest read timestamp and removes that file entry.
 */
function evictStaleSessionReads(): void {
  if (sessionReads.size <= SESSION_READS_MAX) return;

  // Find entries with oldest minimum timestamp
  const entries: Array<{ key: string; oldestTimestamp: number }> = [];
  for (const [key, reads] of sessionReads) {
    let oldestTimestamp = Infinity;
    for (const read of reads) {
      if (read.timestamp < oldestTimestamp) {
        oldestTimestamp = read.timestamp;
      }
    }
    entries.push({ key, oldestTimestamp });
  }

  // Sort by oldest timestamp (oldest first)
  entries.sort((a, b) => a.oldestTimestamp - b.oldestTimestamp);

  // Remove oldest entries until we're under the limit
  const toRemove = entries.slice(0, sessionReads.size - SESSION_READS_MAX);
  for (const { key } of toRemove) {
    sessionReads.delete(key);
  }
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
  /** Which tool performed the read ("read", "read_files", "intent_read"). */
  source: string;
}

/** Track ALL reads across the session for range coverage checks. */
const sessionReads = new Map<string, ReadRange[]>();

const MAX_READS_PER_FILE = 100;

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

  // Cap per-file reads to prevent unbounded array growth
  if (reads.length > MAX_READS_PER_FILE) {
    reads.splice(0, reads.length - MAX_READS_PER_FILE);
  }

  sessionReads.set(normalized, reads);

  // Evict oldest entries if cache exceeds max size
  evictStaleSessionReads();
}

/**
 * Get all session reads for a file, or empty array if never read.
 */
export function getSessionReads(path: string, cwd: string): ReadRange[] {
  const normalized = normalizePath(path, cwd);
  return sessionReads.get(normalized) ?? [];
}

/**
 * Get all file paths that have been read this session.
 * Returns absolute paths stored in the sessionReads map.
 */
export function getAllSessionPaths(): string[] {
  return [...sessionReads.keys()];
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
 * @param readOffset - The 1-based file line offset from which this snapshot was
 *   read. For full-file reads, this is 1. For offset/limit reads, this is the
 *   `offset` parameter value. Used to translate relative display line numbers
 *   to absolute file line numbers during hashline validation.
 */
export function recordRead(
  path: string,
  cwd: string,
  content: string,
  partial?: boolean,
  hashline?: Awaited<ReturnType<typeof buildHashlineAnchors>>,
  readOffset?: number,
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
    readOffset: readOffset ?? 1,
  };

  if (hashline) {
    snapshot.hashline = hashline;
  }

  snapshotCache.set(normalized, snapshot);

  // Evict oldest entries if cache exceeds max size
  evictStaleSnapshots();
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
            // Atomically replace snapshot with settled metadata and proceed.
            snapshotCache.set(normalized, { ...snapshot, mtimeMs: retryStat.mtimeMs, size: retryStat.size });
            return null;
          }
        }

        // All retries failed — the file truly changed.
        return staleError(path, snapshot.mtimeMs, stat.mtimeMs);
      }

      // mtime changed but content is the same — update snapshot mtime and size
      snapshot.mtimeMs = stat.mtimeMs;
      snapshot.size = stat.size;
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
 *
 * @param readOffset - The 1-based file line offset for this snapshot.
 *   For full-file reads (e.g., after an edit), this is 1.
 */
export function recordReadWithStat(
  path: string,
  cwd: string,
  content: string,
  mtimeMs: number,
  size: number,
  hashline?: Awaited<ReturnType<typeof buildHashlineAnchors>>,
  readOffset?: number,
): void {
  const normalized = normalizePath(path, cwd);
  const snapshot: FileSnapshot = {
    path: normalized,
    mtimeMs,
    size,
    contentHash: fastHash(content),
    readAt: Date.now(),
    partial: false,
    readOffset: readOffset ?? 1,
  };

  if (hashline) {
    snapshot.hashline = hashline;
  }

  snapshotCache.set(normalized, snapshot);

  // Evict oldest entries if cache exceeds max size
  evictStaleSnapshots();
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

  // ── Snapshot fallback ────────────────────────────────────────────
  // If session reads don't cover the edit range but the snapshot exists
  // (file was definitely read), auto-populate a full-file session read
  // and retry. This handles edge cases where the tool_result handler
  // didn't properly record a session read, or where an offset read's
  // range was recorded with a truncated line count.
  //
  // This is safe because checkStale already verified the file hasn't
  // changed since the snapshot was recorded — if it had, the edit
  // would have been rejected before reaching this check.
  const snapshot = snapshotCache.get(normalized);
  // Skip fallback for partial snapshots (offset/limit reads):
  // formattedLines.length is the partial content length, not the full file.
  if (snapshot?.hashline?.formattedLines?.length && !snapshot.partial) {
    const totalFileLines = snapshot.hashline.formattedLines.length;
    if (editStartLine >= 1 && editEndLine <= totalFileLines) {
      // Populate a full-file session read from snapshot data
      const readsArr = sessionReads.get(normalized) ?? [];
      readsArr.push({
        offset: 1,
        limit: -1,
        totalLines: totalFileLines,
        timestamp: Date.now(),
        source: 'snapshot_fallback',
      });
      sessionReads.set(normalized, readsArr);

      // Retry the merge with the new read included
      const retryIntervals: Array<[number, number]> = readsArr
        .map((r) => {
          const start = r.offset;
          const end = r.limit === -1 ? r.totalLines : r.offset + r.limit - 1;
          return [start, end] as [number, number];
        })
        .filter(([s, e]) => s > 0 && e >= s)
        .sort((a, b) => a[0] - b[0]);

      const retryMerged: Array<[number, number]> = [];
      for (const [s, e] of retryIntervals) {
        if (retryMerged.length > 0 && s <= retryMerged[retryMerged.length - 1][1] + 1) {
          retryMerged[retryMerged.length - 1][1] = Math.max(retryMerged[retryMerged.length - 1][1], e);
        } else {
          retryMerged.push([s, e]);
        }
      }

      for (const [s, e] of retryMerged) {
        if (editStartLine >= s && editEndLine <= e) {
          return { covered: true };
        }
      }
    }
  }

  // Not covered — build actionable error
  const readRanges = reads
    .map((read) => {
      const end = read.limit === -1 ? read.totalLines : read.offset + read.limit - 1;
      return `lines ${read.offset}-${end}`;
    })
    .join(", ");

  // Suggest a sensible re-read range
  const reReadOffset = Math.max(1, editStartLine - 10);
  const reReadLimit = Math.min(100, editEndLine - reReadOffset + 20);

  return {
    covered: false,
    reason:
      `🔴 Edit outside read range\n\n` +
      `You read \`${path}\` in these ranges: ${readRanges}.\n` +
      `but your edit targets lines ${editStartLine}-${editEndLine}.\n\n` +
      `To proceed:\n` +
      `  1. Read the file section: \`read path="${path}" offset=${reReadOffset} limit=${reReadLimit}\`\n` +
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
