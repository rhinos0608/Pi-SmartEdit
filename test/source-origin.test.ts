import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open as fsOpen, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { realpathSync, statSync } from "node:fs";
import {
  readBoundedOriginFileWithIo,
  type OriginFileHandle,
  type OriginFileIo,
} from "../src/patch/source-origin.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

interface ActualReadFixture {
  path: string;
  documentBytes: Buffer;
  expectedSha256?: string;
  appendBeforeRead?: Buffer;
  readError?: NodeJS.ErrnoException;
  directory?: boolean;
}

async function readWithActualHandle(t: { after(fn: () => void | Promise<void>): void }, fixture: ActualReadFixture) {
  const directory = await mkdtemp(join(tmpdir(), "source-origin-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, fixture.path);
  if (!fixture.directory) await writeFile(path, fixture.documentBytes);
  const canonicalPath = realpathSync(path);
  const counters = { stat: 0, read: 0, close: 0, bytesRead: 0, fdAfterClose: -2 };
  let actualHandle: FileHandle | undefined;
  let appended = false;
  const io: OriginFileIo = {
    realpath: (candidate) => realpathSync(candidate),
    stat: (candidate) => statSync(candidate),
    open: async (candidate, flags): Promise<OriginFileHandle> => {
      const handle = await fsOpen(candidate, flags);
      actualHandle = handle;
      const originalStat = handle.stat.bind(handle);
      const originalRead = handle.read.bind(handle);
      const originalClose = handle.close.bind(handle);
      return {
        get fd() { return handle.fd; },
        stat: async (...args) => {
          counters.stat++;
          return originalStat(...args);
        },
        read: async (...args) => {
          counters.read++;
          if (fixture.appendBeforeRead && !appended) {
            appended = true;
            await writeFile(path, fixture.appendBeforeRead, { flag: "a" });
          }
          if (fixture.readError) throw fixture.readError;
          const result = await originalRead(...args);
          counters.bytesRead += result.bytesRead;
          return result;
        },
        close: async () => {
          try { await originalClose(); } finally {
            counters.close++;
            counters.fdAfterClose = handle.fd;
          }
        },
      };
    },
  };

  const result = await readBoundedOriginFileWithIo({
    canonicalPath,
    sha256: fixture.expectedSha256 ?? digest(fixture.documentBytes),
  }, io);
  assert.equal(counters.close, 1, "actual opened descriptor closed exactly once");
  assert.equal(counters.fdAfterClose, -1, "actual descriptor fd is -1 after close");
  assert.equal(actualHandle?.fd, -1);
  assert.ok(counters.bytesRead <= 4 * 1024 * 1024 + 1, "actual reads stay within cap plus one byte");
  return { result, counters };
}

test("refuses bytes from an opened inode after canonical pathname is atomically replaced", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "source-origin-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "origin.txt");
  const replacement = join(directory, "replacement.txt");
  const h0 = Buffer.from("snapshot H0\n");
  const h1 = Buffer.from("replacement H1\n");
  await writeFile(path, h0);
  await writeFile(replacement, h1);
  const canonicalPath = realpathSync(path);
  let openedHandle: FileHandle | undefined;
  let openedIdentity: { dev: number; ino: number } | undefined;
  let namedIdentity: { dev: number; ino: number } | undefined;
  let readBytes = 0;
  let closeCount = 0;
  let closeFdAfter = -1;
  const io: OriginFileIo = {
    realpath: (candidate) => realpathSync(candidate),
    stat: (candidate) => statSync(candidate),
    open: async (candidate, flags): Promise<OriginFileHandle> => {
      const handle = await fsOpen(candidate, flags);
      openedHandle = handle;
      const originalStat = handle.stat.bind(handle);
      const originalRead = handle.read.bind(handle);
      const originalClose = handle.close.bind(handle);
      const openedStat = await originalStat();
      openedIdentity = { dev: openedStat.dev, ino: openedStat.ino };
      await rename(replacement, path);
      const current = await fsOpen(path, "r");
      try {
        const currentStat = await current.stat();
        namedIdentity = { dev: currentStat.dev, ino: currentStat.ino };
      } finally {
        await current.close();
      }
      return {
        get fd() { return handle.fd; },
        stat: originalStat,
        read: async (...args) => {
          const result = await originalRead(...args);
          readBytes += result.bytesRead;
          return result;
        },
        close: async () => {
          try { await originalClose(); } finally {
            closeCount++;
            closeFdAfter = handle.fd;
          }
        },
      };
    },
  };

  const result = await readBoundedOriginFileWithIo({ canonicalPath, sha256: digest(h0) }, io);
  assert.equal(readBytes, h0.length, `captured bytes came from actual opened H0 descriptor: ${JSON.stringify(result)}`);
  assert.notDeepEqual(openedIdentity, namedIdentity, "opened FD and current pathname have different dev/ino");
  assert.equal(closeCount, 1, "opened actual descriptor was closed exactly once");
  assert.equal(closeFdAfter, -1, "actual opened descriptor fd is -1 after close");
  assert.equal(openedHandle?.fd, -1);
  assert.equal(result.ok, false, "H0 digest must not authorize bytes after pathname names H1");
});

test("actual descriptor reader accepts matching bytes", async (t) => {
  const bytes = Buffer.from("actual success\n");
  const { result, counters } = await readWithActualHandle(t, { path: "success.txt", documentBytes: bytes });
  assert.equal(result.ok, true);
  assert.equal(counters.stat, 1, "opened-handle fstat");
  assert.ok(counters.read >= 1);
  assert.equal(counters.bytesRead, bytes.length);
});

test("actual descriptor reader rejects a hash mismatch", async (t) => {
  const bytes = Buffer.from("hash mismatch\n");
  const { result, counters } = await readWithActualHandle(t, {
    path: "hash.txt", documentBytes: bytes, expectedSha256: digest(Buffer.from("other")),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /generation mismatch/);
  assert.equal(counters.bytesRead, bytes.length);
});

test("actual descriptor reader rejects oversized files from fstat before reading", async (t) => {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61);
  const { result, counters } = await readWithActualHandle(t, { path: "oversize.txt", documentBytes: bytes });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exceeds size cap/);
  assert.equal(counters.stat, 1);
  assert.equal(counters.read, 0);
  assert.equal(counters.bytesRead, 0);
});

test("actual descriptor reader caps a file that grows after fstat", async (t) => {
  const initial = Buffer.from("before growth\n");
  const { result, counters } = await readWithActualHandle(t, {
    path: "growth.txt", documentBytes: initial, appendBeforeRead: Buffer.alloc(4 * 1024 * 1024 + 1, 0x61),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exceeds size cap/);
  assert.equal(counters.stat, 1);
  assert.ok(counters.bytesRead <= 4 * 1024 * 1024 + 1);
});

test("actual descriptor reader rejects invalid UTF-8", async (t) => {
  const { result, counters } = await readWithActualHandle(t, {
    path: "invalid-utf8.bin", documentBytes: Buffer.from([0xc3, 0x28]),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not valid UTF-8/);
  assert.equal(counters.bytesRead, 2);
});

test("closes the actual descriptor after an injected adapter read error", async (t) => {
  const error = Object.assign(new Error("read failed"), { code: "EIO" });
  const { result, counters } = await readWithActualHandle(t, {
    path: "read-error.txt", documentBytes: Buffer.from("read error"), readError: error,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /read failed \(EIO\)/);
  assert.equal(counters.read, 1);
  assert.equal(counters.bytesRead, 0);
});

test("actual descriptor reader rejects an opened directory", async (t) => {
  const { result, counters } = await readWithActualHandle(t, { path: ".", documentBytes: Buffer.alloc(0), directory: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a regular file/);
  assert.equal(counters.read, 0);
});
