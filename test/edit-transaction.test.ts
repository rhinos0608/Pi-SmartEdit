import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EditTransaction } from "../src/edit-transaction.js";
import { atomicCreate } from "../src/undo/atomic-write.js";

const LOCK_DIR = join(tmpdir(), "pi-smartedit-locks");
function lockFileFor(path: string): string {
  return join(LOCK_DIR, `${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 32)}.lock`);
}
const tempDirs = new Set<string>();

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

after(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitFor(fn: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Spawns and waits for a trivial child process to exit, then returns its
 *  now-dead PID — a reliable, portable way to get a PID guaranteed not to
 *  name a live process for the (short) remainder of the test. */
async function getDeadPid(): Promise<number> {
  return new Promise((resolvePid, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    child.on("exit", () => {
      if (child.pid === undefined) { reject(new Error("child had no pid")); return; }
      resolvePid(child.pid);
    });
    child.on("error", reject);
  });
}

test("two-update failure restores first file", async () => {
  const dir = await makeTempDir("smart-edit-tx-");
  const first = join(dir, "first.txt");
  const second = join(dir, "missing", "second.txt");
  await writeFile(first, "one");
  const tx = await EditTransaction.begin([first, second]);
  await tx.write(first, "changed");
  await assert.rejects(() => tx.write(second, "",), /EISDIR|ENOTDIR|directory/);
  const outcome = await tx.rollback();
  assert.equal(await readFile(first, "utf8"), "one");
  assert.deepEqual(outcome.restored, [first]);
});

test("rollback restores deleted and renamed files", async () => {
  const dir = await makeTempDir("smart-edit-tx-");
  const deleted = join(dir, "deleted.txt");
  const source = join(dir, "source.txt");
  const destination = join(dir, "destination.txt");
  await Promise.all([writeFile(deleted, "delete me"), writeFile(source, "move me")]);
  const tx = await EditTransaction.begin([deleted, source, destination]);
  await tx.remove(deleted);
  await tx.rename(source, destination);
  await tx.rollback();
  assert.equal(await readFile(deleted, "utf8"), "delete me");
  assert.equal(await readFile(source, "utf8"), "move me");
  await assert.rejects(() => readFile(destination), /ENOENT/);
});

test("rollback restores the original mode", async () => {
  const dir = await makeTempDir("smart-edit-tx-");
  const file = join(dir, "mode.txt");
  await writeFile(file, "before");
  await chmod(file, 0o755);
  const tx = await EditTransaction.begin([file]);
  await tx.write(file, "after");
  await chmod(file, 0o644);
  await tx.rollback();
  assert.equal((await stat(file)).mode & 0o777, 0o755);
  assert.equal(await readFile(file, "utf8"), "before");
});

test("atomicCreate never overwrites a concurrent creator", async () => {
  const dir = await makeTempDir("smart-edit-tx-");
  const file = join(dir, "created.txt");
  const results = await Promise.allSettled([atomicCreate(file, "first"), atomicCreate(file, "second")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(await readFile(file, "utf8"), /^(first|second)$/);
});

test("overlapping transactions serialize snapshots and writes", async () => {
  const dir = await makeTempDir("smart-edit-tx-");
  const file = join(dir, "shared.txt");
  await writeFile(file, "before");
  const first = await EditTransaction.begin([file]);
  const secondPending = EditTransaction.begin([file]);
  await first.write(file, "first");
  await first.commit();
  const second = await secondPending;
  await second.write(file, "second");
  await second.commit();
  assert.equal(await readFile(file, "utf8"), "second");
});

test("repeated writes to a path absent at begin switch to atomicWrite after first create", async () => {
  const dir = await makeTempDir("smart-edit-tx-repeat-");
  const file = join(dir, "brand-new.txt");
  const tx = await EditTransaction.begin([file]);
  await tx.write(file, "first");
  await tx.write(file, "second");
  await tx.write(file, "third");
  await tx.commit();
  assert.equal(await readFile(file, "utf8"), "third");
});

test("commit and rollback remove filesystem lock files (cleanup)", async () => {
  const dir = await makeTempDir("smart-edit-tx-cleanup-");
  const file = join(dir, "f.txt");
  await writeFile(file, "a");
  const lockFile = lockFileFor(file);
  await mkdir(LOCK_DIR, { recursive: true });

  const tx = await EditTransaction.begin([file]);
  assert.equal(existsSync(lockFile), true, "filesystem lock must be held during the transaction");
  await tx.write(file, "b");
  await tx.commit();
  await waitFor(() => !existsSync(lockFile), "commit must release the lock file");

  const tx2 = await EditTransaction.begin([file]);
  assert.equal(existsSync(lockFile), true);
  await tx2.write(file, "c");
  await tx2.rollback();
  await waitFor(() => !existsSync(lockFile), "rollback must release the lock file");
  assert.equal(await readFile(file, "utf8"), "b");
});

test("getUndoRecords returns byte-exact base64 original and before/after hashes", async () => {
  const dir = await makeTempDir("smart-edit-tx-undo-");
  const file = join(dir, "f.txt");
  await writeFile(file, "alpha");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const tx = await EditTransaction.begin([file]);
  await tx.write(file, "beta");
  const records = await tx.getUndoRecords();
  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(Buffer.from(rec.originalContent, "base64").toString("utf8"), "alpha");
  assert.equal(rec.existed, true);
  assert.equal(rec.afterExists, true);
  assert.equal(rec.beforeSha, sha("alpha"));
  assert.equal(rec.afterSha, sha("beta"));
  assert.equal(rec.operation, "text");
  await tx.commit();
});

test("writing to a path whose parent directory is gone fails with ENOENT", async () => {
  const dir = await makeTempDir("smart-edit-tx-enoent-");
  const sub = join(dir, "sub");
  await mkdir(sub, { recursive: true });
  const file = join(sub, "f.txt");
  await writeFile(file, "a");
  const tx = await EditTransaction.begin([file]);
  await import("node:fs/promises").then(({ rm }) => rm(sub, { recursive: true, force: true }));
  await assert.rejects(() => tx.write(file, "b"), /ENOENT/);
  await tx.rollback();
});

// ─── Bug 1: commit-before-undo race ────────────────────────────────────

test("Bug 1 regression: capturing undo records before commit() protects afterSha from a post-commit interloper write", async () => {
  const dir = await makeTempDir("smart-edit-tx-race-");
  const file = join(dir, "f.txt");
  await writeFile(file, "alpha");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  const tx = await EditTransaction.begin([file]);
  await tx.write(file, "beta");

  // Correct discipline (mirrors src/patch.ts's fixed commit/getUndoRecords
  // ordering): capture undo records — which snapshot post-write disk
  // content for afterSha — BEFORE commit() releases the lock.
  const records = await tx.getUndoRecords();
  await tx.commit();

  // A second, uncoordinated writer mutates the file the instant the lock is
  // released. Because afterSha was already captured while the lock was
  // still held, this interloper write must be invisible to the already
  // computed undo record.
  await writeFile(file, "interloper-content");

  assert.equal(records.length, 1);
  assert.equal(records[0].afterSha, sha("beta"), "afterSha must reflect SmartEdit's own committed content");
  assert.notEqual(records[0].afterSha, sha("interloper-content"), "afterSha must not observe the post-release interloper write");
});

// ─── Bug 2: stale-lock recovery and awaited release ────────────────────

test("Bug 2 regression: a lock file with a dead owner PID is reclaimed promptly instead of waiting the full timeout", async () => {
  const dir = await makeTempDir("smart-edit-tx-stale-");
  const file = join(dir, "f.txt");
  await writeFile(file, "a");
  const lockFile = lockFileFor(file);
  await mkdir(LOCK_DIR, { recursive: true });

  const deadPid = await getDeadPid();
  await writeFile(lockFile, JSON.stringify({ pid: deadPid, acquiredAt: Date.now() }));

  const start = Date.now();
  const tx = await EditTransaction.begin([file]);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `stale lock owned by a dead PID should be reclaimed quickly, took ${elapsed}ms`);

  await tx.write(file, "b");
  await tx.commit();
  assert.equal(await readFile(file, "utf8"), "b");
});

test("Bug 2 regression: an old, unparseable lock file (legacy/corrupt content) is reclaimed via the age fallback", async () => {
  const dir = await makeTempDir("smart-edit-tx-stale-legacy-");
  const file = join(dir, "f.txt");
  await writeFile(file, "a");
  const lockFile = lockFileFor(file);
  await mkdir(LOCK_DIR, { recursive: true });

  // No parseable {pid, acquiredAt} JSON — simulates a legacy or corrupt lock
  // file. Its mtime is old enough to trip the age-based fallback.
  await writeFile(lockFile, "not json");
  const oldTime = new Date(Date.now() - 60_000);
  await import("node:fs/promises").then(({ utimes }) => utimes(lockFile, oldTime, oldTime));

  const start = Date.now();
  const tx = await EditTransaction.begin([file]);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `old unparseable lock file should be reclaimed quickly, took ${elapsed}ms`);
  await tx.rollback();
});

test("Bug 2 regression: a lock held by a live process is never reclaimed, even if old", async () => {
  const dir = await makeTempDir("smart-edit-tx-live-");
  const file = join(dir, "f.txt");
  await writeFile(file, "a");
  const lockFile = lockFileFor(file);
  await mkdir(LOCK_DIR, { recursive: true });

  // Our own test process is unquestionably alive; an old acquiredAt must not
  // matter — a live owner's lock is never force-reclaimed.
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 60_000 }));

  let resolved = false;
  const pending = EditTransaction.begin([file]).then((tx) => { resolved = true; return tx; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(resolved, false, "a lock owned by a live process must not be reclaimed");

  // Release the fake lock manually (simulating the "real" owner finishing)
  // so the still-polling begin() can proceed normally, then clean up.
  await rm(lockFile, { force: true });
  const tx = await pending;
  await tx.rollback();
});

test("Bug 2 regression: commit() and rollback() await lock-file cleanup before resolving (no fire-and-forget)", async () => {
  const dir = await makeTempDir("smart-edit-tx-await-release-");
  const file = join(dir, "f.txt");
  await writeFile(file, "a");
  const lockFile = lockFileFor(file);
  await mkdir(LOCK_DIR, { recursive: true });

  const tx = await EditTransaction.begin([file]);
  assert.equal(existsSync(lockFile), true);
  await tx.write(file, "b");
  await tx.commit();
  // No polling: release must already be complete by the time commit()
  // resolves, since it is now awaited internally rather than fire-and-forget.
  assert.equal(existsSync(lockFile), false, "lock file must be gone immediately after commit() resolves");

  const tx2 = await EditTransaction.begin([file]);
  await tx2.write(file, "c");
  await tx2.rollback();
  assert.equal(existsSync(lockFile), false, "lock file must be gone immediately after rollback() resolves");
});
