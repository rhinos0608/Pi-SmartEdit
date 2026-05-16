/**
 * Streaming Patch Parser — incremental parsing for live progress feedback.
 *
 * Processes partial apply_patch text as `pushDelta()` feeds it, re-parses
 * periodically with `parseCodexPatch(text, 'lenient')`, and emits completed
 * hunks via an `onUpdate` callback. Emissions are throttled at `bufferIntervalMs`
 * intervals (default 500ms, matching Codex's streaming patch preview).
 *
 * Graceful degradation: if no `onUpdate` callback is provided, pushDelta and
 * finish are no-ops.
 *
 * Inspired by: codex-rs/apply-patch/src/streaming_parser.rs
 */

import { parseCodexPatch, type CodexHunk, type CodexPatchResult } from "./codex-patch";

// ─── Types ──────────────────────────────────────────────────────────

export type OnUpdateCallback = (
  update: { content: Array<{ type: "text"; text: string }> }
) => void;

// ─── StreamingPatchParser ───────────────────────────────────────────

export class StreamingPatchParser {
  private onUpdate: OnUpdateCallback | undefined;
  private bufferIntervalMs: number;
  private accumulated = "";
  private lastEmitTime = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Set of hunk signatures already emitted (dedup across re-parse cycles) */
  private emittedHunks = new Set<string>();
  /** Total hunks seen in the most recent parse */
  private totalHunks = 0;

  constructor(
    onUpdate?: OnUpdateCallback,
    bufferIntervalMs = 500,
  ) {
    this.onUpdate = onUpdate;
    this.bufferIntervalMs = bufferIntervalMs;
  }

  /**
   * Feed a partial patch text delta.
   * Re-parses the accumulated text and emits any newly-completed hunks
   * (throttled by bufferIntervalMs).
   */
  pushDelta(delta: string): void {
    if (!this.onUpdate) return; // Graceful degradation

    this.accumulated += delta;

    // Re-parse with lenient mode (tolerates partial text)
    const result = parseCodexPatch(this.accumulated, "lenient");
    this.totalHunks = result.hunks.length;

    const newHunks = this.findNewHunks(result.hunks);
    if (newHunks.length === 0) return;

    const now = Date.now();
    const elapsed = now - this.lastEmitTime;

    if (elapsed >= this.bufferIntervalMs) {
      this.emitHunks(newHunks, result);
    } else if (!this.timer) {
      // Schedule a deferred flush — only if no timer is already pending.
      // This avoids stacking timers on every pushDelta call within the buffer window.
      this.timer = setTimeout(() => {
        this.timer = null;
        // Re-parse because accumulated may have grown since the timer was set
        const latestResult = parseCodexPatch(this.accumulated, "lenient");
        const latestNew = this.findNewHunks(latestResult.hunks);
        if (latestNew.length > 0) {
          this.emitHunks(latestNew, latestResult);
        }
      }, this.bufferIntervalMs - elapsed);
    }
  }

  /**
   * Signal that all text has been received.
   * Cancels any pending timer, flushes remaining hunks, and emits a
   * final completion message.
   */
  finish(): void {
    if (!this.onUpdate) return;

    // Cancel any pending deferred flush
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Final parse
    const result = parseCodexPatch(this.accumulated, "lenient");
    this.totalHunks = result.hunks.length;
    const newHunks = this.findNewHunks(result.hunks);

    if (newHunks.length > 0) {
      this.emitHunks(newHunks, result);
    }

    // Emit final completion message (always, even if no new hunks)
    this.emit("finish");
  }

  /**
   * Build a deterministic signature for a hunk so we can detect duplicates
   * across successive re-parses.
   */
  private hunkSignature(hunk: CodexHunk): string {
    switch (hunk.kind) {
      case "AddFile":
        return `add:${hunk.path}`;
      case "DeleteFile":
        return `delete:${hunk.path}`;
      case "UpdateFile":
        // Sign each chunk by its scope chain
        return hunk.chunks
          .map((chunk) => `update:${hunk.path}:${chunk.scope.join(" > ")}`)
          .join("|");
      default: {
        // Exhaustive check
        const _exhaustive: never = hunk;
        return `unknown:${JSON.stringify(hunk)}`;
      }
    }
  }

  /**
   * Extract signatures for each discrete "unit" we can emit — one per chunk
   * for UpdateFile, one per file for AddFile/DeleteFile.
   */
  private hunkSignatures(hunk: CodexHunk): string[] {
    switch (hunk.kind) {
      case "AddFile":
        return [`add:${hunk.path}`];
      case "DeleteFile":
        return [`delete:${hunk.path}`];
      case "UpdateFile":
        return hunk.chunks.map(
          (chunk) => `update:${hunk.path}:${chunk.scope.join(" > ")}`,
        );
      default: {
        const _exhaustive: never = hunk;
        return [];
      }
    }
  }

  /**
   * Return hunks (or individual chunks) whose signature has not yet been emitted.
   * We emit at chunk granularity for UpdateFile hunks so the caller sees progress
   * within a multi-chunk file update.
   */
  private findNewHunks(hunks: CodexHunk[]): CodexHunk[] {
    const newHunks: CodexHunk[] = [];

    for (const hunk of hunks) {
      const signatures = this.hunkSignatures(hunk);
      const allSeen = signatures.every((sig) => this.emittedHunks.has(sig));

      if (!allSeen) {
        // Mark all signatures as emitted (even if only some chunks are new —
        // in practice parseCodexPatch returns UpdateFile as a single hunk
        // with all its chunks, so they're all new together on first discovery)
        for (const sig of signatures) {
          this.emittedHunks.add(sig);
        }
        newHunks.push(hunk);
      }
    }

    return newHunks;
  }

  /**
   * Emit hunks through the onUpdate callback.
   */
  private emitHunks(newHunks: CodexHunk[], _result: CodexPatchResult): void {
    this.lastEmitTime = Date.now();

    const lines: string[] = [];
    const completedHunks = this.emittedHunks.size;

    // Progress header
    const completedCount = Math.min(completedHunks, this.totalHunks > 0 ? this.totalHunks : completedHunks);
    const totalLabel = this.totalHunks > 0 ? String(this.totalHunks) : "?";
    lines.push(`📋 Streaming patch progress: ${completedCount}/${totalLabel} hunks complete`);
    lines.push("");

    // Diff for each new hunk
    for (const hunk of newHunks) {
      const diffLines = this.formatHunkDiff(hunk);
      if (diffLines.length > 0) {
        lines.push(...diffLines);
      }
    }

    this.emit("progress", lines.join("\n"));
  }

  /**
   * Format a single CodexHunk as a compact diff string for the progress output.
   */
  private formatHunkDiff(hunk: CodexHunk): string[] {
    const lines: string[] = [];

    switch (hunk.kind) {
      case "AddFile":
        lines.push(`--- /dev/null`);
        lines.push(`+++ b/${hunk.path}`);
        lines.push(`@@ -0,0 +1,${hunk.contents.split("\n").length} @@`);
        lines.push(...hunk.contents.split("\n").map((l) => `+${l}`));
        lines.push("");
        break;

      case "DeleteFile":
        lines.push(`--- a/${hunk.path}`);
        lines.push(`+++ /dev/null`);
        lines.push("");
        break;

      case "UpdateFile": {
        const path = hunk.movePath ?? hunk.path;
        for (const chunk of hunk.chunks) {
          lines.push(`--- a/${path}`);
          lines.push(`+++ b/${path}`);
          const scopeLabel = chunk.scope.length > 0
            ? ` ${chunk.scope.join(" > ")}`
            : "";
          lines.push(`@@${scopeLabel} @@`);
          for (const ctx of chunk.contextLines) {
            lines.push(` ${ctx}`);
          }
          for (const rem of chunk.removedLines) {
            lines.push(`-${rem}`);
          }
          for (const add of chunk.addedLines) {
            lines.push(`+${add}`);
          }
          lines.push("");
        }
        break;
      }

      default: {
        const _exhaustive: never = hunk;
        break;
      }
    }

    return lines;
  }

  /**
   * Send a text update through the onUpdate callback.
   */
  private emit(kind: "progress" | "finish", text?: string): void {
    if (!this.onUpdate) return;

    let message: string;
    if (kind === "finish") {
      const finalCount = this.emittedHunks.size;
      message = `✅ Patch streaming complete: all ${Math.max(finalCount, 1)} hunks processed`;
    } else {
      message = text ?? "";
    }

    this.onUpdate({ content: [{ type: "text", text: message }] });
  }
}
