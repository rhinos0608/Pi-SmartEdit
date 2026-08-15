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
import { resolve as pathResolve, dirname, join } from "path";
import { randomBytes, createHash } from "crypto";
import { chmod as fsChmod, link as fsLink, stat as fsStat, rm as fsRm } from "fs/promises";

import { fastHash } from "../core/types";

import { atomicWrite, atomicCreate } from "./atomic-write";
import type { AtomicWriteOptions } from "./atomic-write";

// ─── Constants ──────────────────────────────────────────────────────

const UNDO_DIR = ".smart-edit-undo";

// ─── Types ──────────────────────────────────────────────────────────

export type UndoOperation = "text" | "add" | "delete" | "rename";

/** Versioned transaction record. Content remains base64 for on-disk compatibility. */
export interface TransactionUndoRecord {
  path: string;
  originalContent: string;
  timestamp: string;
  editCount: number;
  snapshotHash: string;
  changedSymbols: string[];
  version: 2;
  beforeSha: string;
  afterSha?: string;
  beforeMode?: number;
  afterMode?: number;
  existed: boolean;
  afterExists: boolean;
  operation: UndoOperation;
  transactionId: string;
  oldPath?: string;
  newPath?: string;
  /** Total records in this transaction; persisted so incomplete transactions
   *  are detectable on restore. Absent on legacy records (still restorable). */
  recordCount?: number;
}

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
  /** Version 2 transaction fields. Optional to preserve legacy entries exactly. */
  version?: 2;
  beforeSha?: string;
  afterSha?: string;
  beforeMode?: number;
  afterMode?: number;
  existed?: boolean;
  afterExists?: boolean;
  operation?: UndoOperation;
  transactionId?: string;
  oldPath?: string;
  newPath?: string;
  recordCount?: number;
}

/**
 * Decoded view of an UndoEntry, with original content decoded to text.
 */
export interface DecodedUndoEntry extends Omit<UndoEntry, "originalContent"> {
  /** Decoded pre-edit content */
  originalContent: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Persist successful transaction records. Save failures are advisory and never throw. */
export async function saveTransactionUndoRecords(cwd: string, records: readonly TransactionUndoRecord[]): Promise<void> {
  try {
    const undoDir = getUndoDir(cwd);
    await fsMkdir(undoDir, { recursive: true });
    for (const entry of records) {
      const stamp = formatTimestamp(new Date(entry.timestamp));
      const filename = buildEntryFilename(entry.afterSha ?? entry.beforeSha, `${stamp}-${randomBytes(4).toString("hex")}`);
      await fsWriteFile(join(undoDir, filename), JSON.stringify({ ...entry, recordCount: records.length }, null, 2), "utf8");
    }
  } catch (err) {
    console.warn("[smart-edit] Failed to save transaction undo state:", err instanceof Error ? err.message : "unknown error");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function getUndoDir(cwd: string): string {
  return pathResolve(cwd, UNDO_DIR);
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
    const filename = buildEntryFilename(contentHash, formatTimestamp(now) + "-" + randomBytes(4).toString("hex"));

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
  } catch (err) {
    // Fire-and-forget: never block the edit hot path, but log the error
    console.warn("[smart-edit] Failed to save undo state:", err);
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
      const resolvedEntryPath = pathResolve(entry.path);
      const resolvedFilePath = pathResolve(filePath);
      if (resolvedEntryPath === resolvedFilePath) {
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
    if (entry.version === 2 && entry.transactionId) {
      return await restoreTransactionUndoState(cwd, entry.transactionId);
    }

    // Decode original content, retaining raw bytes: the file may not be
    // valid UTF-8, and a string round-trip would corrupt it. The same buffer
    // feeds the atomic restore below byte-exact.
    const storedOriginalContent = Buffer.from(entry.originalContent, "base64");

    const isVersioned = entry.version === 2;
    const operation = entry.operation ?? "text";
    const targetPath = pathResolve(entry.newPath ?? filePath);
    const currentExists = await fsStat(targetPath).then(() => true).catch(() => false);
    let currentFileContent = "";
    let currentFileBuffer: Buffer | undefined;
    if (currentExists) {
      try {
        currentFileBuffer = await fsReadFile(targetPath);
        currentFileContent = currentFileBuffer.toString("utf-8");
      } catch {
        return false;
      }
    }
    // Legacy entries intentionally retain old pre-edit hash behavior.
    if (isVersioned) {
      if ((entry.afterExists ?? true) !== currentExists) return false;
      if (currentExists && currentFileBuffer && createHash("sha256").update(currentFileBuffer).digest("hex") !== entry.afterSha) return false;
    } else if (!currentExists || fastHash(currentFileContent) !== entry.snapshotHash) {
      return false;
    }
    if (isVersioned && operation === "add") {
      await fsRm(targetPath);
    } else if (isVersioned && operation === "rename") {
      const oldPath = pathResolve(entry.oldPath ?? filePath);
      if (await fsStat(oldPath).then(() => true).catch(() => false)) return false;
      await fsLink(targetPath, oldPath);
      await fsRm(targetPath);
      if (entry.beforeMode !== undefined) await fsChmod(oldPath, entry.beforeMode);
    } else if (isVersioned && operation === "delete") {
      await atomicCreate(targetPath, storedOriginalContent, entry.beforeMode === undefined ? undefined : { mode: entry.beforeMode });
    } else {
      await atomicWrite(targetPath, storedOriginalContent, { ...options, mode: entry.beforeMode ?? options?.mode });
      if (entry.beforeMode !== undefined) await fsChmod(targetPath, entry.beforeMode);
    }

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

/** Restore every record in transaction atomically from undo's perspective. */
export async function restoreTransactionUndoState(cwd: string, transactionId: string): Promise<boolean> {
  const undoDir = getUndoDir(cwd);
  const files: string[] = await fsReaddir(undoDir).catch(() => []);
  const records: Array<{ entry: TransactionUndoRecord; filename: string }> = [];
  for (const filename of files) {
    if (!filename.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(await fsReadFile(join(undoDir, filename), "utf8")) as TransactionUndoRecord;
      if (entry.version === 2 && entry.transactionId === transactionId) records.push({ entry, filename });
    } catch { /* ignore corrupt entries */ }
  }
  if (records.length === 0) return false;

  // Incomplete transaction guard: when a count was persisted, restore must
  // observe exactly that many records. Legacy count-less records skip the
  // check and remain restorable.
  const recordCounts = records.map(({ entry }) => entry.recordCount);
  const expectedCount = recordCounts.find((count): count is number => typeof count === "number");
  if (expectedCount !== undefined) {
    if (recordCounts.some((count) => count !== expectedCount) || records.length !== expectedCount) return false;
  }

  const exists = async (path: string) => fsStat(path).then(() => true).catch(() => false);
  const content = async (path: string) => fsReadFile(path, "utf8");
  const target = (entry: TransactionUndoRecord) => pathResolve(entry.operation === "rename" ? (entry.newPath ?? entry.path) : entry.path);
  const paths = new Set<string>();
  for (const { entry } of records) {
    paths.add(target(entry));
    if (entry.operation === "rename") paths.add(pathResolve(entry.oldPath ?? entry.path));
  }
  for (const { entry } of records) {
    const targetPath = target(entry);
    const present = await exists(targetPath);
    if ((entry.afterExists ?? true) !== present) return false;
    if (present && sha256(await content(targetPath)) !== entry.afterSha) return false;
    if (entry.operation === "rename" && await exists(pathResolve(entry.oldPath ?? entry.path))) return false;
  }

  const beforeUndo = new Map<string, { exists: boolean; content?: string; mode?: number }>();
  for (const path of paths) {
    try {
      const st = await fsStat(path);
      beforeUndo.set(path, { exists: true, content: await content(path), mode: st.mode & 0o7777 });
    } catch { beforeUndo.set(path, { exists: false }); }
  }
  const restoreSnapshot = async (path: string, state: { exists: boolean; content?: string; mode?: number }) => {
    if (state.exists) {
      await atomicWrite(path, state.content ?? "", { mode: state.mode });
      if (state.mode !== undefined) await fsChmod(path, state.mode);
    } else if (await exists(path)) await fsRm(path);
  };
  try {
    for (const { entry } of records) {
      const targetPath = target(entry);
      if (entry.operation === "add") await fsRm(targetPath);
      else if (entry.operation === "rename") {
        const oldPath = pathResolve(entry.oldPath ?? entry.path);
        await fsLink(targetPath, oldPath);
        await fsRm(targetPath);
        if (entry.beforeMode !== undefined) await fsChmod(oldPath, entry.beforeMode);
      } else if (entry.operation === "delete") {
        await atomicCreate(targetPath, Buffer.from(entry.originalContent, "base64"), entry.beforeMode === undefined ? undefined : { mode: entry.beforeMode });
      } else {
        await atomicWrite(targetPath, Buffer.from(entry.originalContent, "base64"), { mode: entry.beforeMode });
        if (entry.beforeMode !== undefined) await fsChmod(targetPath, entry.beforeMode);
      }
    }
  } catch {
    try { for (const [path, state] of beforeUndo) await restoreSnapshot(path, state); } catch { /* best effort */ }
    return false;
  }
  for (const { filename } of records) {
    try { await fsUnlink(join(undoDir, filename)); } catch { /* advisory cleanup */ }
  }
  return true;
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
        version: entry.version,
        beforeSha: entry.beforeSha,
        afterSha: entry.afterSha,
        beforeMode: entry.beforeMode,
        afterMode: entry.afterMode,
        existed: entry.existed,
        afterExists: entry.afterExists,
        operation: entry.operation,
        transactionId: entry.transactionId,
        oldPath: entry.oldPath,
        newPath: entry.newPath,
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
