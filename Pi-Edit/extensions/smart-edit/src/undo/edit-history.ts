/**
 * Edit History / Undo System for SmartEdit.
 *
 * Captures pre-edit content before every atomicWrite and stores it
 * as base64-encoded JSON in `.smart-edit-undo/`. Provides restore
 * and cleanup operations.
 *
 * All save operations are fire-and-forget (never block the edit hot path).
 * Failures are silently swallowed — undo is advisory, not critical path.
 */

import {
  readdir as fsReaddir,
  readFile as fsReadFile,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
  mkdir as fsMkdir,
  rmdir as fsRmdir,
} from "fs/promises";
import { resolve, dirname, join } from "path";
import { createHash } from "crypto";

import { atomicWrite } from "./atomic-write";
import type { AtomicWriteOptions } from "./atomic-write";

// ─── Constants ──────────────────────────────────────────────────────

const UNDO_DIR = ".smart-edit-undo";

// ─── Types ──────────────────────────────────────────────────────────

export interface UndoEntry {
  /** Absolute file path that was edited */
  path: string;

  /** Pre-edit content, base64-encoded to avoid newline issues in JSON */
  originalContent: string;

  /** ISO-8601 timestamp of when the edit was applied */
  timestamp: string;

  /** How many edit items were in the batch */
  editCount: number;

  /** SHA-256 truncated hash (16 hex chars) of the pre-edit content */
  snapshotHash: string;

  /** Top-level symbols that were changed, if AST data was available */
  changedSymbols: string[];
}

/**
 * Decoded view of an UndoEntry, with original content decoded to text.
 */
export interface DecodedUndoEntry extends Omit<UndoEntry, "originalContent"> {
  /** Decoded pre-edit content */
  originalContent: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function fastHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function getUndoDir(cwd: string): string {
  return resolve(cwd, UNDO_DIR);
}

/**
 * Format an ISO-8601 timestamp for use in filenames.
 * Replaces colons with hyphens so the string is filesystem-safe on Windows.
 */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-");
}

function buildEntryFilename(hash: string, timestamp: string): string {
  return `${hash}-${timestamp}.json`;
}

// ─── Core API ───────────────────────────────────────────────────────

/**
 * Save pre-edit state before a write.
 *
 * Fire-and-forget: all errors are silently swallowed. This function
 * never throws to the caller.
 *
 * @param cwd - Project root directory (used to resolve .smart-edit-undo/)
 * @param path - Absolute file path that will be edited
 * @param content - Pre-edit file content (LF-normalized, no BOM)
 * @param editCount - Number of edit items in the batch
 * @param changedSymbols - Changed symbol names from AST resolution, if available
 */
export async function saveUndoState(
  cwd: string,
  path: string,
  content: string,
  editCount: number,
  changedSymbols: string[] = [],
): Promise<void> {
  try {
    const undoDir = getUndoDir(cwd);
    await fsMkdir(undoDir, { recursive: true });

    const now = new Date();
    const contentHash = fastHash(content);
    const timestamp = now.toISOString();
    const filename = buildEntryFilename(contentHash, formatTimestamp(now));

    const entry: UndoEntry = {
      path,
      originalContent: Buffer.from(content, "utf-8").toString("base64"),
      timestamp,
      editCount,
      snapshotHash: contentHash,
      changedSymbols,
    };

    await fsWriteFile(
      join(undoDir, filename),
      JSON.stringify(entry, null, 2),
      "utf-8",
    );
  } catch {
    // Fire-and-forget: never block the edit hot path
  }
}

/**
 * Restore a file to its pre-edit state using the most recent undo entry.
 *
 * This is a standalone operation — it uses atomicWrite internally but
 * is NOT called inside withFileMutationQueue.
 *
 * @param cwd - Project root directory
 * @param filePath - Absolute path of the file to restore
 * @param options - Optional atomic write options (e.g. mode preservation)
 * @returns `true` if the file was restored, `false` if no undo entry exists
 */
export async function restoreUndoState(
  cwd: string,
  filePath: string,
  options?: AtomicWriteOptions,
): Promise<boolean> {
  try {
    const undoDir = getUndoDir(cwd);

    let files: string[];
    try {
      files = await fsReaddir(undoDir);
    } catch {
      // Directory doesn't exist — no undo data
      return false;
    }

    // Find and parse entries matching this file path
    const matching: Array<{ entry: UndoEntry; filename: string }> = [];
    for (const filename of files) {
      if (!filename.endsWith(".json")) continue;
      try {
        const raw = await fsReadFile(join(undoDir, filename), "utf-8");
        const entry = JSON.parse(raw) as UndoEntry;
        if (entry.path === filePath) {
          matching.push({ entry, filename });
        }
      } catch {
        // Skip unparseable files
      }
    }

    if (matching.length === 0) return false;

    // Sort by timestamp descending — most recent first
    matching.sort(
      (a, b) =>
        new Date(b.entry.timestamp).getTime() -
        new Date(a.entry.timestamp).getTime(),
    );

    const { entry, filename } = matching[0];

    // Decode original content
    const originalContent = Buffer.from(
      entry.originalContent,
      "base64",
    ).toString("utf-8");

    // Verify snapshot hash
    const currentHash = fastHash(originalContent);
    if (currentHash !== entry.snapshotHash) {
      // Content hash mismatch — data may be corrupted
      return false;
    }

    // Write original content back via atomicWrite
    await atomicWrite(filePath, originalContent, options);

    // Delete the undo file after successful restore
    try {
      await fsUnlink(join(undoDir, filename));
    } catch {
      // Cleanup failure is non-fatal
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * List all available undo entries.
 *
 * @param cwd - Project root directory
 * @param filePath - Optional filter: only return entries for this file
 * @returns Array of decoded undo entries, sorted by timestamp descending
 */
export async function getUndoHistory(
  cwd: string,
  filePath?: string,
): Promise<DecodedUndoEntry[]> {
  const undoDir = getUndoDir(cwd);

  let files: string[];
  try {
    files = await fsReaddir(undoDir);
  } catch {
    return [];
  }

  const entries: DecodedUndoEntry[] = [];

  for (const filename of files) {
    if (!filename.endsWith(".json")) continue;
    try {
      const raw = await fsReadFile(join(undoDir, filename), "utf-8");
      const entry = JSON.parse(raw) as UndoEntry;

      if (filePath && entry.path !== filePath) continue;

      const decodedContent = Buffer.from(
        entry.originalContent,
        "base64",
      ).toString("utf-8");

      entries.push({
        path: entry.path,
        originalContent: decodedContent,
        timestamp: entry.timestamp,
        editCount: entry.editCount,
        snapshotHash: entry.snapshotHash,
        changedSymbols: entry.changedSymbols,
      });
    } catch {
      // Skip unparseable files
    }
  }

  // Sort by timestamp descending
  entries.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return entries;
}

/**
 * Remove all undo data for the given project.
 *
 * @param cwd - Project root directory
 */
export async function clearUndoHistory(cwd: string): Promise<void> {
  const undoDir = getUndoDir(cwd);

  let files: string[];
  try {
    files = await fsReaddir(undoDir);
  } catch {
    return; // Directory doesn't exist — nothing to clean
  }

  for (const filename of files) {
    try {
      await fsUnlink(join(undoDir, filename));
    } catch {
      // Best-effort cleanup
    }
  }

  // Remove the empty directory
  try {
    await fsRmdir(undoDir);
  } catch {
    // Directory may not be empty if some deletes failed
  }
}
