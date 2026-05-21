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

import { diffLines } from "diff";

import { parseCodexPatch, type CodexHunk, type CodexPatchResult } from "./codex-patch";

// ─── Types ──────────────────────────────────────────────────────────

export type OnUpdateCallback = (
  update: { content: Array<{ type: "text"; text: string }> }
) => void;

// ─── StreamingDiffResult ───────────────────────────────────────────

/**
 * Result of computing a diff during streaming.
 * Exported for observability.
 */
export interface StreamingDiffResult {
  /** Number of hunks processed */
  hunks: number;
  /** Formatted unified diff string, or null if fileContent not available */
  diff: string | null;
}

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
  /** Current file content for computing live diffs */
  private fileContent: string | undefined;

  constructor(
    onUpdate?: OnUpdateCallback,
    bufferIntervalMs = 500,
    fileContent?: string,
  ) {
    this.onUpdate = onUpdate;
    this.bufferIntervalMs = bufferIntervalMs;
    this.fileContent = fileContent;
    // Initialize accumulated buffer
    this.accumulated = '';
  }

  /**
   * Feed a partial patch text delta.
   * Re-parses the accumulated text and emits any newly-completed hunks
   * (throttled by bufferIntervalMs).
   *
   * @param delta - The partial patch text
   * @param fileContent - Optional current file content for computing live diffs
   */
  pushDelta(delta: string, fileContent?: string): void {
    if (!this.onUpdate) return; // Graceful degradation

    // Update stored file content if provided
    if (fileContent !== undefined) {
      this.fileContent = fileContent;
    }

    // Normalize line endings and strip BOM from the delta
    const normalizedDelta = delta.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
    this.accumulated += normalizedDelta;

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
      // This is a coalescing throttle: multiple rapid pushDelta calls within
      // bufferIntervalMs result in exactly one deferred flush. The callback
      // re-parses this.accumulated to include any data that arrived since the
      // timer was set. Emission may occur later than exactly bufferIntervalMs
      // after the first delta (timing is not exact), so callers should not
      // rely on precise timing guarantees.
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

    // Compute live diff preview if fileContent is available
    if (newHunks.length > 0 && this.fileContent !== undefined) {
      const diffResult = this.computeDiffFromHunks(newHunks, this.fileContent);
      if (diffResult.diff !== null) {
        lines.push("");
        lines.push("Live diff preview:");
        lines.push(diffResult.diff);
      }
    }

    this.emit("progress", lines.join("\n"));
  }

  /**
   * Compute a unified diff from parsed hunks against the current file content.
   *
   * For UpdateFile hunks, finds the matching region in fileContent using scope
   * markers or by locating removed lines, then computes a diff between the old
   * region and the new content.
   *
   * @param hunks - The parsed CodexHunks to diff
   * @param content - The current file content
   * @returns StreamingDiffResult with diff string or null if no fileContent
   */
  private computeDiffFromHunks(hunks: CodexHunk[], content: string): StreamingDiffResult {
    if (!content) {
      return { hunks: hunks.length, diff: null };
    }

    const diffParts: string[] = [];
    let hunkCount = 0;

    for (const hunk of hunks) {
      hunkCount++;

      switch (hunk.kind) {
        case "AddFile": {
          // New file: show all content as added
          const newLines = hunk.contents.split("\n");
          const changes = diffLines("", hunk.contents);
          diffParts.push(`--- /dev/null`);
          diffParts.push(`+++ b/${hunk.path}`);
          diffParts.push(`@@ -0,0 +1,${newLines.length} @@`);
          for (const part of changes) {
            if (part.added) {
              for (const line of part.value.split("\n")) {
                if (line !== "") {
                  diffParts.push(`+${line}`);
                }
              }
            }
          }
          diffParts.push("");
          break;
        }

        case "DeleteFile": {
          // Deletion: no new content
          diffParts.push(`--- a/${hunk.path}`);
          diffParts.push(`+++ /dev/null`);
          diffParts.push("");
          break;
        }

        case "UpdateFile": {
          const path = hunk.movePath ?? hunk.path;

          for (const chunk of hunk.chunks) {
            // Find the region in fileContent that this chunk modifies
            const { oldText, newText, scopeFound } = this.extractRegionFromFile(chunk, content);

            // Compute diff between old and new
            const changes = diffLines(oldText, newText);

            diffParts.push(`--- a/${path}`);
            diffParts.push(`+++ b/${path}`);

            // Use scope marker as anchor if found
            if (scopeFound && chunk.scope.length > 0) {
              diffParts.push(`@@ ${chunk.scope.join(" > ")} @@`);
            } else {
              diffParts.push("@@ @@");
            }

            for (const part of changes) {
              if (part.added) {
                for (const line of part.value.split("\n")) {
                  if (line !== "") {
                    diffParts.push(`+${line}`);
                  }
                }
              } else if (part.removed) {
                for (const line of part.value.split("\n")) {
                  if (line !== "") {
                    diffParts.push(`-${line}`);
                  }
                }
              }
              // Unchanged lines from diffLines are skipped in unified diff output
            }

            diffParts.push("");
          }
          break;
        }
      }
    }

    return {
      hunks: hunkCount,
      diff: diffParts.join("\n"),
    };
  }

  /**
   * Extract the old region from fileContent that a chunk modifies.
   * Uses scope markers if available, otherwise finds removed lines in content.
   *
   * @param chunk - The UpdateFile chunk
   * @param content - The current file content
   * @returns Object with oldText, newText, and whether scope was found
   */
  private extractRegionFromFile(
    chunk: { scope: string[]; contextLines: string[]; removedLines: string[]; addedLines: string[] },
    content: string,
  ): { oldText: string; newText: string; scopeFound: boolean } {
    const { scope, contextLines, removedLines, addedLines } = chunk;

    // Build new text (context + added lines)
    const newLines = [...contextLines, ...addedLines];
    const newText = newLines.join("\n");

    // Try to find the scope in the file content
    if (scope.length > 0) {
      const scopeText = scope.join("\n");
      const scopeIdx = content.indexOf(scopeText);
      if (scopeIdx !== -1) {
        // Found scope - find surrounding context
        const beforeScope = content.slice(0, scopeIdx);
        const afterScopeAndContext = content.slice(scopeIdx + scopeText.length);

        // Find how much context is before and after
        const beforeLines = beforeScope.split("\n");
        const contextBeforeLines = beforeLines.slice(-contextLines.length);
        const contextAfterLines = afterScopeAndContext.split("\n").slice(0, contextLines.length);

        // Build old text: context before + removed + context after
        const oldLines = [...contextBeforeLines, ...removedLines, ...contextAfterLines];
        return { oldText: oldLines.join("\n"), newText, scopeFound: true };
      }
    }

    // Fallback: find the first removed line in content to determine region
    if (removedLines.length > 0) {
      const firstRemoved = removedLines[0];
      const firstIdx = content.indexOf(firstRemoved);

      if (firstIdx !== -1) {
        // Found the removed line - extract surrounding region
        const beforeContent = content.slice(0, firstIdx);
        const afterContent = content.slice(firstIdx + firstRemoved.length);

        // Count context lines before
        const beforeLines = beforeContent.split("\n");
        const contextBefore = beforeLines.slice(-contextLines.length);

        // Count context lines after (up to removed + added length)
        const afterLines = afterContent.split("\n");
        const contextAfterCount = Math.min(contextLines.length, afterLines.length);
        const contextAfter = afterLines.slice(0, contextAfterCount);

        // Build old text
        const oldLines = [...contextBefore, ...removedLines, ...contextAfter];
        return { oldText: oldLines.join("\n"), newText, scopeFound: false };
      }
    }

    // Cannot find region - use context lines as approximation
    const oldLines = [...contextLines, ...removedLines];
    return { oldText: oldLines.join("\n"), newText, scopeFound: false };
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
