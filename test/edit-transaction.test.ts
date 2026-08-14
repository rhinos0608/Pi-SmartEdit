import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
