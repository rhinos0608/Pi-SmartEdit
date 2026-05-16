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
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "fs/promises";
import { resolve, dirname, basename } from "path";

export interface AtomicWriteOptions {
  /** Mode bits to apply to the new file */
  mode?: number;

  /** Path to read mode bits from (alternative to mode) */
  modeSource?: string;
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
  content: string,
  options?: AtomicWriteOptions,
): Promise<void> {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const tmpName = `.${base}.smart_edit_tmp_${randomBytes(6).toString("hex")}`;
  const tmpPath = resolve(dir, tmpName);

  let mode: number | undefined = options?.mode;

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

    // Write to temp
    await fsWriteFile(tmpPath, content, "utf-8");

    // Restore mode
    if (mode !== undefined) {
      await fsChmod(tmpPath, mode);
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

    // If rename failed (e.g., cross-device), fall back to direct write
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "EXDEV"
    ) {
      await fsWriteFile(filePath, content, { encoding: "utf-8", mode });
      return;
    }

    throw err;
  }
}
