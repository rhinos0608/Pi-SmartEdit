/**
 * File read-cache for stale-file detection.
 *
 * Maintains in-memory snapshots of files when they're read by the model.
 * On edit, checks whether the file has been modified since the last read.
 *
 * Uses mtime + size + content hash to avoid both false positives
 * (mtime change without content change) and false negatives
 * (content change that doesn't change mtime on APFS).
 */

import { statSync } from "fs";
import { resolve } from "path";
import type { FileSnapshot } from "../core/types";
import { fastHash } from "../core/types";
import type { buildHashlineAnchors } from "../hashline/hashline";

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
 * Get all file paths that have been read this session.
 * Returns absolute paths stored in the sessionReads map.
 */
export function getAllSessionPaths(): string[] {
  return [...sessionReads.keys()];
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
