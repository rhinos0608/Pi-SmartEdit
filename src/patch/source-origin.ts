import { constants, realpathSync, statSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";

export const MAX_ORIGIN_DOCUMENT_BYTES = 4 * 1024 * 1024;

export interface SourceOriginDocument {
  canonicalPath: string;
  sha256: string;
}

export type BoundedOriginReadResult =
  | { ok: true; canonicalPath: string; sha256: string; bytes: Buffer; content: string }
  | { ok: false; reason: string };

export type VerifyOriginResult =
  | { ok: true; canonicalPath: string; sha256: string; bytes: Buffer }
  | { ok: false; reason: string };

/**
 * Robust bounded origin reader using an opened file descriptor handle.
 * Enforces canonical binding before and after I/O, fstat regular-file check on handle,
 * bounded read allocation capping at MAX_ORIGIN_DOCUMENT_BYTES + 1, fatal UTF-8 decoding,
 * and exact raw-byte SHA-256 verification. Always closes the handle in finally.
 */
export interface OriginFileHandle {
  fd: number;
  stat(): ReturnType<FileHandle["stat"]>;
  read(buffer: Buffer, offset: number, length: number, position: number): ReturnType<FileHandle["read"]>;
  close(): Promise<void>;
}

export interface OriginFileIo {
  realpath(path: string): string;
  stat(path: string): Stats;
  open(path: string, flags: string | number): Promise<OriginFileHandle>;
}

const nodeOriginFileIo: OriginFileIo = {
  realpath: (path) => realpathSync(path),
  stat: (path) => statSync(path),
  open: async (path, flags) => open(path, flags),
};

export async function readBoundedOriginFile(
  doc: SourceOriginDocument,
): Promise<BoundedOriginReadResult> {
  return readBoundedOriginFileWithIo(doc, nodeOriginFileIo);
}

export async function readBoundedOriginFileWithIo(
  doc: SourceOriginDocument,
  io: OriginFileIo,
): Promise<BoundedOriginReadResult> {
  let realBefore: string;
  try {
    realBefore = io.realpath(doc.canonicalPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "ENOENT";
    return {
      ok: false,
      reason: `rejected: origin document does not exist (${code}): ${doc.canonicalPath}`,
    };
  }

  if (realBefore !== doc.canonicalPath) {
    return {
      ok: false,
      reason: `rejected: origin document path is not canonical (symlink rebind): ${doc.canonicalPath} -> ${realBefore}`,
    };
  }

  let handle: OriginFileHandle;
  try {
    handle = await io.open(doc.canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "OPEN_ERROR";
    return {
      ok: false,
      reason: `rejected: origin document open failed (${code}): ${doc.canonicalPath}`,
    };
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return {
        ok: false,
        reason: `rejected: origin document is not a regular file: ${doc.canonicalPath}`,
      };
    }

    if (stat.size > MAX_ORIGIN_DOCUMENT_BYTES) {
      return {
        ok: false,
        reason: `rejected: origin document exceeds size cap (${stat.size} > ${MAX_ORIGIN_DOCUMENT_BYTES} bytes): ${doc.canonicalPath}`,
      };
    }

    // Bounded read allocation: allocate max + 1 byte (4MB + 1)
    const readBuffer = Buffer.alloc(MAX_ORIGIN_DOCUMENT_BYTES + 1);
    let totalBytesRead = 0;
    while (totalBytesRead <= MAX_ORIGIN_DOCUMENT_BYTES) {
      const { bytesRead } = await handle.read(
        readBuffer,
        totalBytesRead,
        readBuffer.length - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break; // EOF
      totalBytesRead += bytesRead;
    }

    // Growth check: if file grew beyond cap during read, refuse immediately without reading further
    if (totalBytesRead > MAX_ORIGIN_DOCUMENT_BYTES) {
      return {
        ok: false,
        reason: `rejected: origin document exceeds size cap (${totalBytesRead} > ${MAX_ORIGIN_DOCUMENT_BYTES} bytes): ${doc.canonicalPath}`,
      };
    }

    // Canonical binding verification after I/O to ensure path did not rebind
    let realAfter: string;
    try {
      realAfter = io.realpath(doc.canonicalPath);
    } catch {
      return {
        ok: false,
        reason: `rejected: origin document was removed or changed during read: ${doc.canonicalPath}`,
      };
    }

    if (realAfter !== doc.canonicalPath) {
      return {
        ok: false,
        reason: `rejected: origin document path rebound during read: ${doc.canonicalPath} -> ${realAfter}`,
      };
    }

    let namedStat: Stats;
    try {
      namedStat = io.stat(doc.canonicalPath);
    } catch {
      return {
        ok: false,
        reason: `rejected: origin document was removed or changed during read: ${doc.canonicalPath}`,
      };
    }
    if (!namedStat.isFile() || namedStat.dev !== stat.dev || namedStat.ino !== stat.ino) {
      return {
        ok: false,
        reason: `rejected: origin document file binding changed during read: ${doc.canonicalPath}`,
      };
    }

    const exactBytes = readBuffer.subarray(0, totalBytesRead);

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(exactBytes);
    } catch {
      return {
        ok: false,
        reason: `rejected: origin document is not valid UTF-8: ${doc.canonicalPath}`,
      };
    }

    const actualSha = createHash("sha256").update(exactBytes).digest("hex");
    if (actualSha !== doc.sha256) {
      return {
        ok: false,
        reason: `rejected: origin document generation mismatch for ${doc.canonicalPath}: expected ${doc.sha256}, got ${actualSha}`,
      };
    }

    return {
      ok: true,
      canonicalPath: realAfter,
      sha256: actualSha,
      bytes: exactBytes,
      content,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "READ_ERROR";
    return {
      ok: false,
      reason: `rejected: origin document read failed (${code}): ${doc.canonicalPath}`,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Verify canonical realpath, regular file status, bounded size, fatal UTF-8,
 * and exact raw-byte SHA-256 digest of an origin document using the bounded FD reader.
 * Never leaks source content in error messages.
 */
export async function verifySourceOriginDocument(
  doc: SourceOriginDocument,
): Promise<VerifyOriginResult> {
  const res = await readBoundedOriginFile(doc);
  if (!res.ok) return res;
  return {
    ok: true,
    canonicalPath: res.canonicalPath,
    sha256: res.sha256,
    bytes: res.bytes,
  };
}

/**
 * Verify exact bytes read by the planner during staging for an edited origin document.
 * Never leaks source content in error messages.
 */
export function verifyExactOriginBytes(
  doc: SourceOriginDocument,
  bytes: Buffer,
): { ok: true } | { ok: false; reason: string } {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      reason: `rejected: origin document is not valid UTF-8: ${doc.canonicalPath}`,
    };
  }

  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== doc.sha256) {
    return {
      ok: false,
      reason: `rejected: origin document generation mismatch for ${doc.canonicalPath}: expected ${doc.sha256}, got ${actualSha}`,
    };
  }

  return { ok: true };
}
