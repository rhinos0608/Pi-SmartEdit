/**
 * Atomic file write utility.
 *
 * Writes content to a file atomically:
 * 1. Write to a temp file in the same directory
 * 2. Preserve original mode bits
 * 3. Rename temp over original
 *
 * Falls back to direct write on cross-device rename errors.
 */

import { randomBytes } from "crypto";
import {
  stat as fsStat,
  chmod as fsChmod,
  rename as fsRename,
  link as fsLink,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "fs/promises";
import { resolve, dirname, basename } from "path";

export type AtomicWriteContent = string | Uint8Array;

export interface AtomicWriteOptions {
  /** Mode bits to apply to the new file */
  mode?: number;

  /** Path to read mode bits from (alternative to mode) */
  modeSource?: string;
}

/** Create file atomically without replacing a concurrent creator. */
export async function atomicCreate(
  filePath: string,
  content: AtomicWriteContent,
  options?: AtomicWriteOptions,
): Promise<void> {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const tmpPath = resolve(dir, `.${base}.smart_edit_create_${randomBytes(6).toString("hex")}`);
  try {
    await fsWriteFile(tmpPath, content, { encoding: "utf-8", mode: options?.mode ?? 0o600, flag: "wx" });
    if (options?.mode !== undefined) await fsChmod(tmpPath, options.mode);
    try {
      await fsLink(tmpPath, filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw Object.assign(new Error(`create conflict: ${filePath}`), { code: "EEXIST" });
      }
      throw err;
    }
    await fsUnlink(tmpPath).catch(() => {});
  } catch (err) {
    await fsUnlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Write content to a file atomically using temp file + rename.
 *
 * @param filePath - Absolute path of the target file
 * @param content - Content to write
 * @param options - Optional write options (mode preservation)
 */
export async function atomicWrite(
  filePath: string,
  content: AtomicWriteContent,
  options?: AtomicWriteOptions,
): Promise<void> {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const tmpName = `.${base}.smart_edit_tmp_${randomBytes(6).toString("hex")}`;
  const tmpPath = resolve(dir, tmpName);

  let mode: number | undefined = options?.mode;
  let effectiveMode: number | undefined = undefined;

  try {
    // Determine mode to preserve
    if (mode === undefined && options?.modeSource) {
      try {
        const stat = await fsStat(options.modeSource);
        mode = stat.mode;
      } catch {
        // Source doesn't exist — no mode to preserve
      }
    }

    if (mode === undefined) {
      try {
        const stat = await fsStat(filePath);
        mode = stat.mode;
      } catch {
        // file doesn't exist yet — no mode to preserve
      }
    }

    // Write to temp with restrictive mode (0o600) for security
    await fsWriteFile(
      tmpPath,
      content,
      typeof content === "string" ? { encoding: "utf-8", mode: 0o600 } : { mode: 0o600 },
    );

    // Read mode immediately before chmod (after write, in case file was replaced)
    if (mode !== undefined) {
      effectiveMode = mode;
    } else {
      try {
        const stat = await fsStat(tmpPath);
        effectiveMode = stat.mode;
      } catch {
        // Could not read mode — use whatever was set
      }
    }

    // Restore original mode if we have one
    if (effectiveMode !== undefined) {
      await fsChmod(tmpPath, effectiveMode);
    }

    // Atomic rename
    await fsRename(tmpPath, filePath);
  } catch (err) {
    // Clean up temp on failure
    try {
      await fsUnlink(tmpPath);
    } catch {
      /* ignore cleanup errors */
    }

    // If rename failed (e.g., cross-device), fall back to atomic write on target filesystem
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "EXDEV"
    ) {
      // Write to a temp file on the TARGET filesystem first, then rename
      const targetTmpName = `.${base}.smart_edit_exdev_${randomBytes(6).toString("hex")}`;
      const targetTmpPath = resolve(dir, targetTmpName);

      // Write with restrictive mode
      await fsWriteFile(
        targetTmpPath,
        content,
        typeof content === "string" ? { encoding: "utf-8", mode: 0o600 } : { mode: 0o600 },
      );

      // Apply mode if we determined one earlier
      if (effectiveMode !== undefined) {
        try {
          await fsChmod(targetTmpPath, effectiveMode);
        } catch {
          // Mode application failed — proceed anyway with default mode
        }
      }

      // Rename on the same device (this should succeed since we're on target filesystem)
      try {
        await fsRename(targetTmpPath, filePath);
      } catch (renameErr) {
        // Clean up temp file
        try {
          await fsUnlink(targetTmpPath);
        } catch {
          /* ignore cleanup errors */
        }
        throw renameErr;
      }
      return;
    }

    throw err;
  }
}
