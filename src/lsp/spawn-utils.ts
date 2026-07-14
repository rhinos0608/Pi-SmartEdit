import { spawn } from "child_process";
import { access } from "fs/promises";
import { dirname, resolve } from "path";

export interface SpawnOptions {
  cwd?: string;
  timeout?: number;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Spawn a command asynchronously with timeout support.
 *
 * Resolves (rather than rejects) on spawn error or timeout. On timeout the
 * child is killed with SIGKILL and the returned status is `-1`.
 */
export function safeSpawnAsync(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<SpawnResult> {
  const maxOutputChars = 100_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (options.timeout) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeout);
    }

    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        stdout = appendBounded(stdout, data.toString(), maxOutputChars);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        stderr = appendBounded(stderr, data.toString(), maxOutputChars);
      });
    }

    child.on("close", (code: number | null) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({
        stdout,
        stderr,
        status: timedOut ? -1 : code,
      });
    });

    child.on("error", () => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({
        stdout,
        stderr,
        status: -1,
      });
    });
  });
}

/**
 * Append `chunk` to `current` while capping total length at `maxChars`.
 */
export function appendBounded(
  current: string,
  chunk: string,
  maxChars: number,
): string {
  if (current.length >= maxChars) return current;
  return (current + chunk).slice(0, maxChars);
}

/**
 * Walk up from `startDir` looking for a directory that contains `fileName`.
 * Returns the directory path, or `null` if no ancestor contains the file.
 */
export async function findAncestorDirWithFile(
  startDir: string,
  fileName: string,
): Promise<string | null> {
  let current = resolve(startDir);

  while (true) {
    try {
      await access(resolve(current, fileName));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}
