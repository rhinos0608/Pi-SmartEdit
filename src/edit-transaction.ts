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
/**
 * Staleness threshold used ONLY as a fallback when a lock file's owner
 * content cannot be parsed (legacy lock, or a read racing the writer's
 * initial `writeFile`). Materially shorter than LOCK_TIMEOUT_MS so an
 * abandoned lock is reclaimed quickly, but long enough that a brand-new
 * lock file (age ~0) is never mistaken for abandoned.
 */
const LOCK_STALE_MS = 5_000;

function lockFilePath(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return join(LOCK_DIR, `${hash}.lock`);
}

interface LockFileInfo { pid: number; acquiredAt: number; }

/** True if `pid` names a live process we can (at least in principle) signal. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but we lack permission to signal it -> alive.
    // Any other error (typically ESRCH): no such process -> dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockFileInfo(lockPath: string): Promise<{ info: LockFileInfo | null; ageMs: number | null }> {
  try {
    const [content, st] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    let info: LockFileInfo | null = null;
    try {
      const parsed: unknown = JSON.parse(content);
      if (
        parsed && typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>).pid === "number" &&
        typeof (parsed as Record<string, unknown>).acquiredAt === "number"
      ) {
        info = parsed as LockFileInfo;
      }
    } catch {
      // Corrupt or partially-written content (e.g. read racing the holder's
      // initial writeFile); fall through with info=null and let the age
      // check decide.
    }
    return { info, ageMs: Date.now() - st.mtimeMs };
  } catch {
    // Lock file vanished between our EEXIST and this read — the holder just
    // released it. Nothing to reclaim; the next open() attempt will succeed.
    return { info: null, ageMs: null };
  }
}

/**
 * A lock file left behind by a crashed process would otherwise block every
 * subsequent transaction for the full LOCK_TIMEOUT_MS on every acquisition
 * attempt, forever (nothing else ever removes it). Detect an abandoned lock
 * — its recorded owner PID is no longer alive — and remove it so acquisition
 * can retry immediately instead of waiting out the deadline. A live owner's
 * lock is never reclaimed, no matter how old; only when owner info cannot be
 * determined at all do we fall back to a conservative age threshold.
 */
async function reclaimIfAbandoned(lockPath: string): Promise<boolean> {
  const { info, ageMs } = await readLockFileInfo(lockPath);
  if (info) {
    if (isProcessAlive(info.pid)) return false;
    await rm(lockPath, { force: true }).catch(() => {});
    return true;
  }
  if (ageMs !== null && ageMs > LOCK_STALE_MS) {
    await rm(lockPath, { force: true }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Acquire an exclusive filesystem lock for a resolved path. Uses O_EXCL
 * creation of a per-path lock file in a per-user temp dir, polling until
 * acquired or timed out. The lock file's content records the acquiring
 * process's PID and acquisition time so a later acquirer can detect and
 * reclaim an abandoned lock (see `reclaimIfAbandoned`) rather than waiting
 * out the full timeout. The returned release is awaited by callers so a
 * crash between "release resolves" and "unlink completes" cannot happen
 * mid-await, and callers get a real guarantee the lock is gone before
 * proceeding.
 */
async function acquireFileLock(key: string): Promise<() => Promise<void>> {
  await mkdir(LOCK_DIR, { recursive: true });
  const lockPath = lockFilePath(key);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx");
      const info: LockFileInfo = { pid: process.pid, acquiredAt: Date.now() };
      await handle.writeFile(JSON.stringify(info));
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle?.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await reclaimIfAbandoned(lockPath)) continue; // retry acquisition immediately
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
async function acquire(paths: string[]): Promise<() => Promise<void>> {
  const keys = [...new Set(paths.map(path => resolve(path)))].sort();
  const releases: Array<() => Promise<void> | void> = [];
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
    return async () => {
      for (const r of releases.reverse()) { await r(); }
    };
  } catch (err) {
    for (const r of releases.reverse()) { await r(); }
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
   * writers. A hard process kill can leave a stale lock file; a later
   * acquirer detects the dead owner PID (or, failing that, the lock file's
   * age) and reclaims it rather than waiting out the full 30s timeout. Lock
   * acquisition is polling-based. Release is awaited end-to-end (handle
   * close + lock file unlink) before commit()/rollback() resolve.
   */
  readonly paths: string[];
  readonly outcome: TransactionOutcome = { attempted: [], ok: [], restored: [], failed: [] };
  private release?: () => Promise<void>;
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
      await release();
      tx.release = undefined;
      throw err;
    }
  }

  private ensureLock(): void {
    if (!this.initialized) throw new Error("transaction is not initialized");
    if (this.done) throw new Error("transaction is already completed (commit or rollback)");
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
    this.done = true; await this.release?.(); this.release = undefined;
    return this.outcome;
  }

  async commit(): Promise<TransactionOutcome> {
    if (!this.done) {
      this.done = true;
      await this.release?.();
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
