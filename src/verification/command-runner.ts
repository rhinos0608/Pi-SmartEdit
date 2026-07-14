/**
 * Bounded command runner.
 *
 * Safely executes subprocesses with strict timeout, no shell invocation,
 * output truncation, and structured result types.
 *
 * Unlike the existing safeSpawnAsync in diagnostic-dispatcher, this
 * runner adds output truncation to prevent unbounded memory use and
 * a clearer timeout-vs-failure distinction.
 */

import { spawn } from "child_process";

// ─── Types ──────────────────────────────────────────────────────────

export interface CommandResult {
  /** Combined stdout content (truncated to maxOutputChars) */
  stdout: string;
  /** Combined stderr content (truncated to maxOutputChars) */
  stderr: string;
  /** Exit code, or null if the process was killed or couldn't start */
  status: number | null;
  /** Signal name if the process was killed by a signal (e.g., 'SIGTERM'), null otherwise */
  signal: string | null;
  /** Whether the process was killed due to timeout */
  timedOut: boolean;
}

export interface RunOptions {
  /** Working directory */
  cwd?: string;
  /** Timeout in milliseconds (default: 30_000) */
  timeoutMs?: number;
  /** Max chars to capture per stream (default: 10_000) */
  maxOutputChars?: number;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Run a command with bounded timeout and output truncation.
 *
 * Security rules:
 * - No shell: true (arg injection surface is minimal when args are split).
 * - Never accept command or args from model-provided edit arguments.
 * - Always truncate output to avoid unbounded memory.
 *
 * Returns CommandResult with all failures captured as structured data
 * rather than thrown exceptions.
 */
export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const {
    cwd,
    timeoutMs = 30_000,
    maxOutputChars = 10_000,
  } = options;

  return new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let status: number | null = null;
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      shell: false,
    });

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        child.kill("SIGKILL");
        // Give the process 500ms to die before resolving
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve({
              stdout: truncateOutput(stdout, maxOutputChars),
              stderr: truncateOutput(stderr, maxOutputChars),
              status: null,
              signal: "SIGKILL",
              timedOut: true,
            });
          }
        }, 500).unref();
      }
    }, timeoutMs);

    // Accumulate stdout
    if (child.stdout) {
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (data: string) => {
        if (stdout.length < maxOutputChars) {
          stdout += data;
        }
      });
    }

    // Accumulate stderr
    if (child.stderr) {
      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (data: string) => {
        if (stderr.length < maxOutputChars) {
          stderr += data;
        }
      });
    }

    // Handle exit
    child.on("close", (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      status = timedOut ? null : code;
      resolve({
        stdout: truncateOutput(stdout, maxOutputChars),
        stderr: truncateOutput(stderr, maxOutputChars),
        status,
        signal: signal ?? null,
        timedOut,
      });
    });

    // Handle spawn failure (e.g., command not found)
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: `Failed to spawn: ${command}`,
        status: null,
        signal: null,
        timedOut: false,
      });
    });
  });
}

// ─── Utility ────────────────────────────────────────────────────────

function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  // Keep a truncated excerpt from the beginning and end
  const half = Math.floor(maxChars / 2);
  const head = output.slice(0, half);
  const tail = output.slice(output.length - half);
  return `${head}\n... [truncated ${output.length - maxChars} chars] ...\n${tail}`;
}
