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

import { statSync } from "fs";
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
  hashline?: Awaited<ReturnType<typeof import("./hashline").buildHashlineAnchors>>,
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
  hashline?: Awaited<ReturnType<typeof import("./hashline").buildHashlineAnchors>>,
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
