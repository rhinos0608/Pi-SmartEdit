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

/** Byte-exact SHA-256 over raw file bytes. Matches save-side hashing in
 *  src/mutation/edit-transaction.ts (sha over Buffer, no UTF-8 round-trip). */
const shaBuffer = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

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
interface MatchedUndoEntry {
  entry: UndoEntry;
  filename: string;
}

interface CurrentFileState {
  exists: boolean;
  buffer?: Buffer;
  content: string;
  mode?: number;
}

async function listUndoFiles(undoDir: string): Promise<string[] | null> {
  try {
    return await fsReaddir(undoDir);
  } catch {
    // Directory doesn't exist — no undo data
    return null;
  }
}

async function loadMatchingUndoEntries(
  undoDir: string,
  files: readonly string[],
  filePath: string,
): Promise<MatchedUndoEntry[]> {
  const matching: MatchedUndoEntry[] = [];
  const resolvedFilePath = pathResolve(filePath);
  for (const filename of files) {
    if (!filename.endsWith(".json")) continue;
    try {
      const raw = await fsReadFile(join(undoDir, filename), "utf-8");
      const entry = JSON.parse(raw) as UndoEntry;
      if (pathResolve(entry.path) === resolvedFilePath) {
        matching.push({ entry, filename });
      }
    } catch {
      // Skip unparseable files
    }
  }
  return matching;
}

function selectLatestUndoEntry(matching: MatchedUndoEntry[]): MatchedUndoEntry {
  // Sort by timestamp descending — most recent first
  matching.sort(
    (a, b) =>
      new Date(b.entry.timestamp).getTime() -
      new Date(a.entry.timestamp).getTime(),
  );
  return matching[0]!;
}

async function readCurrentFileState(targetPath: string): Promise<CurrentFileState | null> {
  let mode: number | undefined;
  try {
    mode = (await fsStat(targetPath)).mode & 0o7777;
  } catch {
    return { exists: false, content: "" };
  }
  try {
    const buffer = await fsReadFile(targetPath);
    return { exists: true, buffer, content: buffer.toString("utf-8"), mode };
  } catch {
    return null;
  }
}

function validateSingleUndoGuard(entry: UndoEntry, current: CurrentFileState): boolean {
  // Legacy entries intentionally retain old pre-edit hash behavior.
  if (entry.version === 2) {
    if ((entry.afterExists ?? true) !== current.exists) return false;
    if (current.exists && current.buffer && createHash("sha256").update(current.buffer).digest("hex") !== entry.afterSha) return false;
    if (current.exists && entry.afterMode !== undefined && current.mode !== undefined && current.mode !== entry.afterMode) return false;
    return true;
  }
  return current.exists && fastHash(current.content) === entry.snapshotHash;
}

async function applySingleUndoOp(
  entry: UndoEntry,
  filePath: string,
  targetPath: string,
  storedOriginalContent: Buffer,
  options?: AtomicWriteOptions,
): Promise<boolean> {
  const isVersioned = entry.version === 2;
  const operation = entry.operation ?? "text";
  if (isVersioned && operation === "add") {
    await fsRm(targetPath);
  } else if (isVersioned && operation === "rename") {
    const oldPath = pathResolve(entry.oldPath ?? filePath);
    if (await fsStat(oldPath).then(() => true).catch(() => false)) return false;
    // Hard-link first so content survives the source removal below.
    await fsLink(targetPath, oldPath);
    await fsRm(targetPath);
    if (entry.beforeMode !== undefined) await fsChmod(oldPath, entry.beforeMode);
  } else if (isVersioned && operation === "delete") {
    await atomicCreate(targetPath, storedOriginalContent, entry.beforeMode === undefined ? undefined : { mode: entry.beforeMode });
  } else {
    await atomicWrite(targetPath, storedOriginalContent, { ...options, mode: entry.beforeMode ?? options?.mode });
    if (entry.beforeMode !== undefined) await fsChmod(targetPath, entry.beforeMode);
  }
  return true;
}

async function cleanupUndoFile(undoDir: string, filename: string): Promise<void> {
  try {
    await fsUnlink(join(undoDir, filename));
  } catch {
    // Cleanup failure is non-fatal
  }
}

export async function restoreUndoState(
  cwd: string,
  filePath: string,
  options?: AtomicWriteOptions,
): Promise<boolean> {
  try {
    const undoDir = getUndoDir(cwd);
    const files = await listUndoFiles(undoDir);
    if (files === null) return false;
    const matching = await loadMatchingUndoEntries(undoDir, files, filePath);
    if (matching.length === 0) return false;
    const { entry, filename } = selectLatestUndoEntry(matching);
    if (entry.version === 2 && entry.transactionId) {
      return await restoreTransactionUndoState(cwd, entry.transactionId);
    }
    // Decode original content, retaining raw bytes: the file may not be
    // valid UTF-8, and a string round-trip would corrupt it. The same buffer
    // feeds the atomic restore below byte-exact.
    const storedOriginalContent = Buffer.from(entry.originalContent, "base64");
    const targetPath = pathResolve(entry.newPath ?? filePath);
    const current = await readCurrentFileState(targetPath);
    if (current === null) return false;
    if (!validateSingleUndoGuard(entry, current)) return false;
    if (!await applySingleUndoOp(entry, filePath, targetPath, storedOriginalContent, options)) return false;
    await cleanupUndoFile(undoDir, filename);
    return true;
  } catch {
    return false;
  }
}

interface TransactionRecordFile {
  entry: TransactionUndoRecord;
  filename: string;
}

interface RollbackFileState {
  exists: boolean;
  content?: Buffer;
  mode?: number;
}

async function loadTransactionRecords(undoDir: string, transactionId: string): Promise<TransactionRecordFile[]> {
  const files: string[] = await fsReaddir(undoDir).catch(() => []);
  const records: TransactionRecordFile[] = [];
  for (const filename of files) {
    if (!filename.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(await fsReadFile(join(undoDir, filename), "utf8")) as TransactionUndoRecord;
      if (entry.version === 2 && entry.transactionId === transactionId) records.push({ entry, filename });
    } catch { /* ignore corrupt entries */ }
  }
  return records;
}

function checkTransactionCompleteness(records: TransactionRecordFile[]): boolean {
  // Incomplete transaction guard: when a count was persisted, restore must
  // observe exactly that many records. Legacy count-less records skip the
  // check and remain restorable.
  const recordCounts = records.map(({ entry }) => entry.recordCount);
  const expectedCount = recordCounts.find((count): count is number => typeof count === "number");
  if (expectedCount === undefined) return true;
  return !recordCounts.some((count) => count !== expectedCount) && records.length === expectedCount;
}

function transactionTarget(entry: TransactionUndoRecord): string {
  return pathResolve(entry.operation === "rename" ? (entry.newPath ?? entry.path) : entry.path);
}

function collectTransactionPaths(records: TransactionRecordFile[]): Set<string> {
  const paths = new Set<string>();
  for (const { entry } of records) {
    paths.add(transactionTarget(entry));
    if (entry.operation === "rename") paths.add(pathResolve(entry.oldPath ?? entry.path));
  }
  return paths;
}

async function preflightTransactionRecords(records: TransactionRecordFile[]): Promise<boolean> {
  for (const { entry } of records) {
    const targetPath = transactionTarget(entry);
    let st: { mode: number } | undefined;
    try {
      st = await fsStat(targetPath);
    } catch { st = undefined; }
    const present = st !== undefined;
    if ((entry.afterExists ?? true) !== present) return false;
    // Raw bytes: a UTF-8 string round-trip would corrupt non-UTF8 files and
    // mismatch the byte hashes stored save-side.
    if (present && shaBuffer(await fsReadFile(targetPath)) !== entry.afterSha) return false;
    if (present && entry.afterMode !== undefined && (st!.mode & 0o7777) !== entry.afterMode) return false;
    if (entry.operation === "rename" && await fsStat(pathResolve(entry.oldPath ?? entry.path)).then(() => true).catch(() => false)) return false;
  }
  return true;
}

async function captureRollbackSnapshot(paths: Set<string>): Promise<Map<string, RollbackFileState>> {
  const beforeUndo = new Map<string, RollbackFileState>();
  for (const path of paths) {
    try {
      const st = await fsStat(path);
      beforeUndo.set(path, { exists: true, content: await fsReadFile(path), mode: st.mode & 0o7777 });
    } catch { beforeUndo.set(path, { exists: false }); }
  }
  return beforeUndo;
}

async function restoreRollbackSnapshot(path: string, state: RollbackFileState): Promise<void> {
  if (state.exists) {
    await atomicWrite(path, state.content ?? Buffer.alloc(0), { mode: state.mode });
    if (state.mode !== undefined) await fsChmod(path, state.mode);
  } else if (await fsStat(path).then(() => true).catch(() => false)) {
    await fsRm(path);
  }
}

async function rollbackToSnapshot(beforeUndo: Map<string, RollbackFileState>): Promise<void> {
  try {
    for (const [path, state] of beforeUndo) await restoreRollbackSnapshot(path, state);
  } catch { /* best effort */ }
}

async function applyOneTransactionOp(entry: TransactionUndoRecord, targetPath: string): Promise<void> {
  if (entry.operation === "add") {
    await fsRm(targetPath);
  } else if (entry.operation === "rename") {
    const oldPath = pathResolve(entry.oldPath ?? entry.path);
    // Hard-link first so content survives the source removal below.
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

async function applyTransactionOps(records: TransactionRecordFile[]): Promise<void> {
  for (const { entry } of records) {
    await applyOneTransactionOp(entry, transactionTarget(entry));
  }
}

async function cleanupTransactionFiles(undoDir: string, records: TransactionRecordFile[]): Promise<void> {
  for (const { filename } of records) {
    try { await fsUnlink(join(undoDir, filename)); } catch { /* advisory cleanup */ }
  }
}

/** Restore every record in transaction atomically from undo's perspective. */
export async function restoreTransactionUndoState(cwd: string, transactionId: string): Promise<boolean> {
  const undoDir = getUndoDir(cwd);
  const records = await loadTransactionRecords(undoDir, transactionId);
  if (records.length === 0) return false;
  if (!checkTransactionCompleteness(records)) return false;
  if (!await preflightTransactionRecords(records)) return false;
  const paths = collectTransactionPaths(records);
  const beforeUndo = await captureRollbackSnapshot(paths);
  try {
    await applyTransactionOps(records);
  } catch {
    await rollbackToSnapshot(beforeUndo);
    return false;
  }
  await cleanupTransactionFiles(undoDir, records);
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
