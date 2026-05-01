/**
 * Background verification run tracker.
 *
 * Manages in-memory verification runs that continue after the edit
 * response has been returned. Supports querying run status and
 * diagnostics via a future `smart_edit_verification_status` tool.
 *
 * Design constraints:
 * - Fixed max concurrent runs (default: 3).
 * - Runs are killed after `maxBackgroundMs` timeout.
 * - Old runs are evicted from memory after `evictAfterMs`.
 * - Run IDs are opaque strings.
 * - Commands come from config only — never from model-provided input.
 */

import { randomUUID } from "crypto";

// ─── Types ──────────────────────────────────────────────────────────

export interface VerificationRunStatus {
  /** Unique run identifier */
  runId: string;
  /** When the run was started (epoch ms) */
  startedAt: number;
  /** When the run finished (epoch ms, undefined while running) */
  finishedAt?: number;
  /** Current status of the run */
  status: "running" | "passed" | "failed" | "timeout";
  /** The command that was executed */
  command: string[];
  /** Parsed diagnostics from the tool output */
  diagnostics: Array<{
    message: string;
    severity: 1 | 2 | 3 | 4;
    evidence?: string;
  }>;
  /** Human-readable summary */
  summary: string;
}

interface ManagedRun {
  runId: string;
  startedAt: number;
  command: string[];
  resolve: (status: VerificationRunStatus) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// ─── Registry ───────────────────────────────────────────────────────

export class BackgroundRunRegistry {
  private runs = new Map<string, ManagedRun>();
  private completedRuns = new Map<string, VerificationRunStatus>();
  private activeCount = 0;

  readonly maxConcurrent: number;
  readonly defaultTimeoutMs: number;
  readonly evictAfterMs: number;

  constructor(options?: {
    maxConcurrent?: number;
    defaultTimeoutMs?: number;
    evictAfterMs?: number;
  }) {
    this.maxConcurrent = options?.maxConcurrent ?? 3;
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 120_000;
    this.evictAfterMs = options?.evictAfterMs ?? 300_000;
  }

  /**
   * Register a new background verification run.
   * Returns a run ID and a promise that resolves when the run completes.
   * If max concurrent runs are reached, rejects immediately.
   */
  schedule(
    command: string[],
    timeoutMs?: number,
  ): { runId: string; promise: Promise<VerificationRunStatus> } {
    if (this.activeCount >= this.maxConcurrent) {
      throw new Error(
        `Max concurrent verification runs reached (${this.maxConcurrent}). ` +
        "Wait for an active run to complete or check status of existing runs.",
      );
    }

    const runId = randomUUID().slice(0, 12); // short unique ID
    const startedAt = Date.now();
    const actualTimeout = timeoutMs ?? this.defaultTimeoutMs;

    const promise = new Promise<VerificationRunStatus>((resolve, reject) => {
      const run: ManagedRun = { runId, startedAt, command, resolve, reject };

      // Timeout guard
      run.timer = setTimeout(() => {
        this.finalize(runId, {
          runId,
          startedAt,
          finishedAt: Date.now(),
          status: "timeout",
          command,
          diagnostics: [
            {
              message: `Background verification timed out after ${actualTimeout}ms`,
              severity: 3,
            },
          ],
          summary: `Timed out after ${actualTimeout}ms. Command: ${command.join(" ")}`,
        });
      }, actualTimeout + 1_000); // extra 1s grace for SIGKILL delivery

      this.runs.set(runId, run);
      this.activeCount++;
    });

    return { runId, promise };
  }

  /**
   * Finalize a run with a result status.
   * Cleans up the timer and moves the run to the completed store.
   */
  finalize(runId: string, status: VerificationRunStatus): void {
    const run = this.runs.get(runId);
    if (!run) return;

    clearTimeout(run.timer);
    this.runs.delete(runId);
    this.activeCount--;

    this.completedRuns.set(runId, {
      ...status,
      finishedAt: status.finishedAt ?? Date.now(),
    });

    run.resolve(status);

    // Schedule eviction of old completed runs
    setTimeout(() => {
      this.completedRuns.delete(runId);
    }, this.evictAfterMs).unref();
  }

  /**
   * Get the status of a specific run by ID.
   */
  getStatus(runId: string): VerificationRunStatus | null {
    // Check active runs
    const active = this.runs.get(runId);
    if (active) {
      return {
        runId: active.runId,
        startedAt: active.startedAt,
        status: "running",
        command: active.command,
        diagnostics: [],
        summary: "Running...",
      };
    }

    // Check completed runs
    const completed = this.completedRuns.get(runId);
    if (completed) return completed;

    return null;
  }

  /**
   * List all active and recent completed runs.
   */
  listRuns(includeCompleted?: boolean): VerificationRunStatus[] {
    const result: VerificationRunStatus[] = [];

    for (const run of this.runs.values()) {
      result.push({
        runId: run.runId,
        startedAt: run.startedAt,
        status: "running",
        command: run.command,
        diagnostics: [],
        summary: "Running...",
      });
    }

    if (includeCompleted) {
      for (const status of this.completedRuns.values()) {
        result.push(status);
      }
    }

    // Sort by startedAt descending
    result.sort((a, b) => b.startedAt - a.startedAt);
    return result;
  }

  /**
   * Cancel a running verification.
   */
  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;

    this.finalize(runId, {
      runId,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      status: "failed",
      command: run.command,
      diagnostics: [
        { message: "Cancelled by user", severity: 3 },
      ],
      summary: "Cancelled.",
    });
    return true;
  }
}

// ─── Singleton export ──────────────────────────────────────────────

/**
 * Global background run registry singleton.
 * Shared across the extension lifecycle.
 */
export const backgroundRuns = new BackgroundRunRegistry();

/**
 * Convenience: register a command to run in background.
 * The caller provides the command and what to do when it completes.
 *
 * Example:
 * ```ts
 * const { runId, promise } = scheduleBackgroundRun(["go", "test", "-race", "./..."]);
 * // Return immediate response with runId
 * // Later: query backgroundRuns.getStatus(runId)
 * ```
 */
export function scheduleBackgroundRun(
  command: string[],
  options?: {
    timeoutMs?: number;
  },
): { runId: string; promise: Promise<VerificationRunStatus> } {
  return backgroundRuns.schedule(command, options?.timeoutMs);
}
