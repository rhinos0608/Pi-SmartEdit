import { spawn } from "child_process";
import { existsSync } from "fs";
import { access } from "fs/promises";
import { delimiter, dirname, join, resolve } from "path";

export interface SpawnOptions {
  cwd?: string;
  timeout?: number;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

// ── Windows cmd escaping (pattern + regexes ported from cross-spawn, MIT) ──
// Since Node's CVE-2024-27980 mitigation, spawning a `.cmd`/`.bat` without a
// shell throws EINVAL on Windows. Route those through `cmd.exe /d /s /c`.
// Two traps shape this, both confirmed against cross-spawn's lib/parse.js:
//  1. Node's libuv quoting targets the C runtime, not cmd — pre-quoted argv
//     elements get backslash-mangled (`"` is literal to cmd). So the whole
//     line is built here as ONE pre-escaped string, wrapped in a single outer
//     quote pair (defeats /s quote-stripping), spawned with
//     windowsVerbatimArguments so Node passes it through untouched.
//  2. cmd parses the /c line itself, so every element gets `^`-escaping for
//     cmd metachars — otherwise a filename like `x&whoami.ts` would chain.
//     Args here undergo exactly one cmd parse before reaching node (npx),
//     so single-level escaping is correct. A bare `.cmd` invoked directly
//     (double parse via a forwarding shim) would need double escaping — no
//     caller does that; the test fake's fixtures are static strings.
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

function escapeCmdArgument(arg: string): string {
  let escaped = arg;
  // Backslashes before a quote, and trailing backslashes, are doubled so the
  // C runtime of the downstream program does not eat the closing quote.
  escaped = escaped.replace(/(\\*)"/g, "$1$1\\\"");
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = '"' + escaped + '"';
  return escaped.replace(CMD_META_CHARS, "^$1");
}

export interface SpawnTarget {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  /** Original batch-shim name when gated through cmd.exe (win32 only). */
  batchFile?: string;
}

/**
 * Map a spawn target through the Windows batch-file gate.
 *
 * Everything except win32 `.cmd`/`.bat` passes through unchanged
 * (notably extensionless names like `npx`, which fail closed with ENOENT
 * rather than crashing the caller).
 *
 * Pure over (`command`, `args`, `platform`) so it is unit-testable on any OS.
 */
export function buildSpawnTarget(
  command: string,
  args: string[],
  platform: string = process.platform,
): SpawnTarget {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const shellCommand = [escapeCmdCommand(command), ...args.map((a) => escapeCmdArgument(a))].join(" ");
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `"${shellCommand}"`],
      windowsVerbatimArguments: true,
      batchFile: command,
    };
  }
  return { command, args };
}

/**
 * Ordered spawn attempts for a command.
 *
 * On Windows, CreateProcess resolves a bare name to `.exe` only, so npm
 * (`.cmd`) and RubyGems (`.bat`) shims need explicit suffix attempts after
 * the as-is try. Only names already carrying a Windows executable suffix
 * (`.cmd`/`.bat`/`.exe`/`.com`) yield a single attempt — a version-like
 * basename such as `tool-1.2` is extensionless for this purpose. POSIX
 * always yields exactly the primary target: zero behavior change.
 *
 * Pure over (`command`, `args`, `platform`) so it is unit-testable on any OS.
 */
export function buildSpawnTargets(
  command: string,
  args: string[],
  platform: string = process.platform,
): SpawnTarget[] {
  const primary = buildSpawnTarget(command, args, platform);
  if (platform === "win32" && !/\.(cmd|bat|exe|com)$/i.test(command)) {
    // Windows ignores trailing dots/spaces in names: `tool.` resolves as
    // `tool`, so suffix the trimmed form (`tool.cmd`, not `tool..cmd`).
    const base = command.replace(/[. ]+$/, "");
    return [
      primary,
      buildSpawnTarget(`${base}.cmd`, args, platform),
      buildSpawnTarget(`${base}.bat`, args, platform),
    ];
  }
  return [primary];
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
    let timedOut = false;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let activeChild: ReturnType<typeof spawn> | undefined;
    // Guards late events from an attempt superseded by a fallback retry.
    let attemptId = 0;

    const targets = buildSpawnTargets(command, args);
    let index = 0;

    if (options.timeout) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          const target = activeChild;
          if (process.platform === "win32" && target?.pid !== undefined) {
            // Batch shims run under cmd.exe: killing the direct child alone
            // orphans the real process. taskkill /t fells the whole tree.
            try {
              const killer = spawn("taskkill", ["/pid", String(target.pid), "/t", "/f"], {
                stdio: "ignore",
              });
              killer.on("error", () => {
                try {
                  target.kill("SIGKILL");
                } catch {
                  // Fallback kill failed; close event or finish(-1) settles.
                }
              });
              killer.unref?.();
            } catch {
              target.kill("SIGKILL");
            }
          } else {
            target?.kill("SIGKILL");
          }
        } catch {
          // A throwing kill delivers no terminal event; settle here to honor
          // the documented timeout contract instead of hanging the promise.
          finish(-1);
        }
      }, options.timeout);
    }

    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout, stderr, status: timedOut ? -1 : status });
    };

    const attempt = (): void => {
      const id = ++attemptId;
      const target = targets[index];
      // Missing shims must never reach cmd.exe: on current Windows Server
      // images `cmd /c "missing.cmd"` exits 1 with a localized
      // "not recognized" message, not 9009 with empty output — so exit-code
      // sniffing alone misreports them as real failures. Skip ungated when
      // the batch file is not resolvable; the close handler re-checks as a
      // backstop for files deleted between this check and exit.
      if (target.batchFile && !isBatchFileResolvable(target.batchFile, options.cwd)) {
        if (!timedOut && index + 1 < targets.length) {
          index++;
          attempt();
          return;
        }
        finish(-1);
        return;
      }
      const child = spawn(target.command, target.args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: target.windowsVerbatimArguments,
      });
      activeChild = child;

      child.stdout?.on("data", (data: Buffer) => {
        stdout = appendBounded(stdout, data.toString(), maxOutputChars);
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr = appendBounded(stderr, data.toString(), maxOutputChars);
      });

      child.on("close", (code: number | null) => {
        if (settled || id !== attemptId) return;
        // cmd.exe reports an unresolvable command via `close`, not `error` —
        // without this the `.bat` fallback would be dead when only a later
        // suffix exists. The classic signal is exit 9009 with empty output
        // (9009 is cmd-specific; POSIX exit codes are 8-bit). Current
        // Windows Server images instead exit 1 with a localized
        // "not recognized" message, so message/exit-code sniffing alone
        // misreports. Backstop: a non-zero exit from a cmd-gated target
        // whose batch file does not resolve on disk is a lookup failure
        // regardless of code or text — a tool that really ran either exited
        // 0 or left its shim resolvable. Never start new work after the
        // deadline. A terminal lookup failure (all suffixes exhausted)
        // normalizes to -1, the missing-command status on every OS.
        const gatedMiss = target.batchFile !== undefined && code !== 0 &&
          !isBatchFileResolvable(target.batchFile, options.cwd);
        const lookupFailure = (code === 9009 && stdout === "" && stderr === "") || gatedMiss;
        if (!timedOut && lookupFailure && index + 1 < targets.length) {
          index++;
          attempt();
          return;
        }
        finish(lookupFailure ? -1 : code);
      });

      child.on("error", () => {
        if (settled || id !== attemptId) return;
        // A spawn failure racing a fired timeout must not start new work.
        if (timedOut) {
          finish(-1);
          return;
        }
        // Spawn failure (ENOENT/EINVAL): fall through to the next suffixed
        // attempt. Any other outcome resolves here.
        if (index + 1 < targets.length) {
          index++;
          attempt();
          return;
        }
        finish(-1);
      });
    };

    attempt();
  });
}

/**
 * Check whether a cmd-gated batch shim resolves without spawning.
 *
 * Locale-independent by design: cmd.exe's "not recognized" text is
 * localized and its exit code varies (9009 vs 1) across images, so
 * existence on disk decides. Path-like names resolve against `cwd`;
 * bare names search `cwd` then each `PATH` entry (quotes stripped).
 * Sync and failure-path-only (at most 2 checks per missing command).
 */
export function isBatchFileResolvable(batchFile: string, cwd?: string): boolean {
  const base = cwd ?? process.cwd();
  try {
    if (/[/\\]/.test(batchFile)) {
      return existsSync(resolve(base, batchFile));
    }
    if (existsSync(join(base, batchFile))) return true;
    const pathEnv = process.env.PATH ?? "";
    for (const entry of pathEnv.split(delimiter)) {
      const dir = entry.replace(/^"+|"+$/g, "").trim();
      if (!dir) continue;
      try {
        if (existsSync(join(dir, batchFile))) return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

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
