import { chmod, link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { TransactionUndoRecord, UndoOperation } from "./undo/edit-history.js";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { atomicCreate, atomicWrite } from "./undo/atomic-write.js";

export interface TransactionOutcome {
  attempted: string[];
  ok: string[];
  restored: string[];
  failed: string[];
}

export interface Snapshot { path: string; exists: boolean; content?: Buffer; mode?: number; }
interface Mutation { path: string; before: Snapshot; operation?: UndoOperation; oldPath?: string; newPath?: string; }
const locks = new Map<string, Promise<void>>();

/** Directory for filesystem-backed cross-process lock files. */
const LOCK_DIR = join(tmpdir(), "pi-smartedit-locks");
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 25;

function lockFilePath(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return join(LOCK_DIR, `${hash}.lock`);
}

/**
 * Acquire an exclusive filesystem lock for a resolved path. Uses O_EXCL
 * creation of a per-path lock file in a per-user temp dir, polling until
 * acquired or timed out. The returned release deletes the lock file.
 */
async function acquireFileLock(key: string): Promise<() => void> {
  await mkdir(LOCK_DIR, { recursive: true });
  const lockPath = lockFilePath(key);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx");
      let released = false;
      return () => {
        if (released) return;
        released = true;
        void handle?.close().catch(() => {});
        void rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new Error(`timed out acquiring filesystem lock for ${key} (${lockPath})`);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

/**
 * Acquire in-process and filesystem locks for the sorted resolved paths and
 * return a release that reverses them. Locks guard snapshots and mutations so
 * cooperating transactions serialize on a shared filesystem view, both within
 * this process (promise chain) and across processes (per-path lock file).
 */
async function acquire(paths: string[]): Promise<() => void> {
  const keys = [...new Set(paths.map(path => resolve(path)))].sort();
  const releases: Array<() => void> = [];
  try {
    for (const key of keys) {
      const prior = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>(r => { release = r; });
      locks.set(key, next);
      await prior;
      releases.push(() => { release(); if (locks.get(key) === next) locks.delete(key); });
      releases.push(await acquireFileLock(key));
    }
    return () => { releases.reverse().forEach(r => { r(); }); };
  } catch (err) {
    releases.reverse().forEach(r => { r(); });
    throw err;
  }
}

async function snapshot(path: string): Promise<Snapshot> {
  try {
    const s = await stat(path);
    // Raw Buffer: byte-exact snapshots so rollback restores exact bytes.
    return { path, exists: true, content: await readFile(path), mode: s.mode & 0o7777 };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { path, exists: false };
  }
}

export class EditTransaction {
  /**
   * Transaction lifecycle and concurrency guarantees.
   *
   * `begin` acquires in-process (promise-chain) locks plus per-resolved-path
   * filesystem lock files, then snapshots every path into raw Buffers. All
   * mutations run under those locks; commit/rollback release them.
   *
   * Guarantee: cooperating EditTransaction instances on the same machine
   * serialize on shared paths — within a process via the lock map and across
   * processes via O_EXCL lock files in the per-user temp dir
   * (`os.tmpdir()/pi-smartedit-locks`).
   *
   * Limits: the filesystem lock is advisory (only cooperating callers honor
   * it); it is not a POSIX flock and does not coordinate with non-EditTransaction
   * writers. Cleanup is best-effort — a hard process kill can leave a stale
   * lock file, which blocks acquisition until its 30s timeout; no stale-lock
   * ownership recovery is attempted. Lock acquisition is polling-based.
   */
  readonly paths: string[];
  readonly outcome: TransactionOutcome = { attempted: [], ok: [], restored: [], failed: [] };
  private release?: () => void;
  private initialized = false;
  private snapshots = new Map<string, Snapshot>();
  private mutations: Mutation[] = [];
  /** Paths created during this transaction (absent at begin); first write/`create`
   * uses atomicCreate, later writes reuse atomicWrite. */
  private created = new Set<string>();
  private done = false;
  readonly transactionId = randomUUID();

  private constructor(paths: string[]) { this.paths = [...new Set(paths.map(path => resolve(path)))].sort(); }

  static async begin(paths: string[]): Promise<EditTransaction> {
    const tx = new EditTransaction(paths);
    // Locks precede snapshots: snapshot and every later mutation observe one
    // serialized filesystem view. Release on any begin failure.
    const release = await acquire(tx.paths);
    tx.release = release;
    try {
      for (const path of tx.paths) tx.snapshots.set(path, await snapshot(path));
      tx.initialized = true;
      return tx;
    } catch (err) {
      release();
      tx.release = undefined;
      throw err;
    }
  }

  private ensureLock(): void {
    if (!this.initialized) throw new Error("transaction is not initialized");
  }

  getSnapshot(path: string): Snapshot | undefined {
    const value = this.snapshots.get(resolve(path));
    return value ? { ...value } : undefined;
  }

  async getUndoRecords(): Promise<TransactionUndoRecord[]> {
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const records: TransactionUndoRecord[] = [];
    const seen = new Set<string>();
    const renamedOld = new Set(this.mutations.filter((m) => m.operation === "rename").map((m) => m.oldPath));
    for (const mutation of this.mutations) {
      if (renamedOld.has(mutation.path) && mutation.operation !== "rename") continue;
      if (mutation.operation === "rename" && mutation.path !== mutation.newPath) continue;
      if (seen.has(mutation.path)) continue;
      seen.add(mutation.path);
        const operation = mutation.operation ?? (mutation.before.exists ? "text" : "add");
      // Rename leaves source absent; its after-state lives at destination.
      const afterPath = operation === "rename" ? mutation.newPath ?? mutation.path : mutation.path;
      const current = await snapshot(afterPath);
      const renameBefore = operation === "rename" && mutation.oldPath
        ? this.snapshots.get(mutation.oldPath)
        : undefined;
      const before = renameBefore ?? mutation.before;
      const beforeBuf = before.content ?? Buffer.alloc(0);
      const currentBuf = current.content ?? Buffer.alloc(0);
      records.push({ path: mutation.path, originalContent: beforeBuf.toString("base64"), timestamp: new Date().toISOString(), editCount: 1, snapshotHash: sha(beforeBuf).slice(0, 16), changedSymbols: [], version: 2, beforeSha: sha(beforeBuf), afterSha: current.exists ? sha(currentBuf) : undefined, beforeMode: before.mode, afterMode: current.mode, existed: before.exists, afterExists: current.exists, operation, transactionId: this.transactionId, oldPath: mutation.oldPath, newPath: mutation.newPath });
    }
    return records;
  }

  private before(path: string): Snapshot {
    const p = resolve(path);
    const before = this.snapshots.get(p);
    if (!before) throw new Error(`unplanned transaction path: ${p}`);
    return before;
  }

  private mark(path: string) { if (!this.outcome.attempted.includes(path)) this.outcome.attempted.push(path); }

  async write(path: string, content: string): Promise<void> {
    this.ensureLock();
    const p = resolve(path); const before = this.before(p);
    this.mark(p);
    // A path that existed at begin is overwritten atomically preserving mode.
    // A path absent at begin is created once with atomicCreate; later writes to
    // that same path (now present on disk) must switch to atomicWrite rather
    // than fail atomicCreate with an EEXIST create conflict.
    if (before.exists || this.created.has(p)) await atomicWrite(p, content, { modeSource: p });
    else { await atomicCreate(p, content); this.created.add(p); }
    this.mutations.push({ path: p, before, operation: before.exists ? "text" : "add" }); this.outcome.ok.push(p);
  }

  async create(path: string, content: string, mode?: number): Promise<void> {
    this.ensureLock();
    const p = resolve(path); const before = this.before(p);
    this.mark(p);
    if (this.created.has(p)) await atomicWrite(p, content, mode === undefined ? { modeSource: p } : { mode, modeSource: p });
    else { await atomicCreate(p, content, mode === undefined ? undefined : { mode }); this.created.add(p); }
    this.mutations.push({ path: p, before, operation: "add" }); this.outcome.ok.push(p);
  }

  async remove(path: string): Promise<void> {
    this.ensureLock();
    const p = resolve(path); const before = this.before(p);
    this.mark(p); if (!before.exists) throw new Error(`delete conflict: ${p}`);
    await rm(p); this.mutations.push({ path: p, before, operation: "delete" }); this.outcome.ok.push(p);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.ensureLock();
    const oldP = resolve(oldPath), newP = resolve(newPath);
    const beforeOld = this.before(oldP);
    const beforeNew = this.before(newP);
    this.mark(oldP); this.mark(newP);
    if (!beforeOld.exists || beforeNew.exists) throw new Error("rename conflict");
    // rename(2) replaces an existing destination. Link first gives rename
    // no-clobber semantics for regular files, then unlink source.
    await link(oldP, newP);
    this.mutations.push({ path: oldP, before: beforeOld, operation: "rename", oldPath: oldP, newPath: newP }, { path: newP, before: beforeNew, operation: "rename", oldPath: oldP, newPath: newP });
    await rm(oldP);
    this.outcome.ok.push(oldP, newP);
  }

  async rollback(): Promise<TransactionOutcome> {
    if (this.done) return this.outcome;
    for (const mutation of [...this.mutations].reverse()) {
      const { path, before } = mutation;
      try {
        const current = await snapshot(path);
        if (before.exists) {
          // Byte-exact drift check: restore only when the bytes or mode changed
          // (Buffer.equals avoids UTF-8 round-trip corruption).
          const same = current.exists
            && current.content?.equals(before.content ?? Buffer.alloc(0))
            && current.mode === before.mode;
          if (!same) {
            // Pass raw Buffer so rollback preserves bytes exactly.
            await atomicWrite(path, before.content ?? Buffer.alloc(0), { mode: before.mode });
            if (before.mode !== undefined) await chmod(path, before.mode);
          }
        } else if (current.exists) await rm(path);
        if (!this.outcome.restored.includes(path)) this.outcome.restored.push(path);
      } catch { if (!this.outcome.failed.includes(path)) this.outcome.failed.push(path); }
    }
    // After rollback the restored/failed paths are no longer successfully written
    // by this transaction; drop them from outcome.ok so callers see the truth.
    this.outcome.ok = this.outcome.ok.filter(
      (p) => !this.outcome.restored.includes(p) && !this.outcome.failed.includes(p),
    );
    this.done = true; this.release?.(); this.release = undefined;
    return this.outcome;
  }

  async commit(): Promise<TransactionOutcome> {
    if (!this.done) {
      this.done = true;
      this.release?.();
      this.release = undefined;
    }
    return this.outcome;
  }
}

export async function withEditTransaction<T>(paths: string[], fn: (tx: EditTransaction) => Promise<T>): Promise<T> {
  const tx = await EditTransaction.begin(paths);
  try { const result = await fn(tx); await tx.commit(); return result; }
  catch (error) { await tx.rollback(); throw error; }
}
