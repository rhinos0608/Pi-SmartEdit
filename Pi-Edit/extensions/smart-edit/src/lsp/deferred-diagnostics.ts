/**
 * Deferred LSP diagnostics collection.
 *
 * Captures diagnostics that arrive AFTER the edit tool returns, allowing
 * follow-up feedback for diagnostics that the LSP server produces with
 * a delay after the initial document sync.
 *
 * Pattern from oh-my-pi's `beginDeferredDiagnosticsForPath` and
 * `injectLateDiagnostics`.
 */

import type { Diagnostic } from "./diagnostic-dispatcher";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * A diagnostic that arrived after the initial edit response was built.
 */
export interface DeferredDiagnostic {
  /** Absolute file path */
  path: string;
  /** The diagnostic object */
  diagnostic: Diagnostic;
  /** Unix timestamp when the diagnostic was collected (ms) */
  timestamp: number;
}

// ─── Collector ───────────────────────────────────────────────────────

/**
 * Collects deferred diagnostics per file path.
 *
 * Uses an AbortController sentinel to track which paths are actively
 * being monitored. Diagnostics are only stored for paths that have
 * an active deferral session.
 */
export class DeferredDiagnosticCollector {
  /**
   * Pending diagnostics keyed by absolute file path.
   * Each entry is a list of diagnostics collected during the deferral window.
   */
  private readonly pending = new Map<string, DeferredDiagnostic[]>();

  /**
   * Sentinel map: path → AbortController that signals when deferral ends.
   * Entries exist only while a deferral session is active for that path.
   */
  private readonly sentinels = new Map<string, AbortController>();

  /**
   * Begin a deferral session for the given file path.
   *
   * Creates an AbortController that can be used to cancel the session.
   * Subsequent calls to `collect()` for this path will store diagnostics
   * until `flush()` or `cancel()` is called.
   *
   * @param path Absolute file path being edited
   */
  beginDeferred(path: string): AbortController {
    // Cancel any existing session for this path first
    const existing = this.sentinels.get(path);
    if (existing) {
      existing.abort();
    }

    const controller = new AbortController();
    this.sentinels.set(path, controller);
    this.pending.set(path, []);
    return controller;
  }

  /**
   * Collect a diagnostic for the given path if it is still pending.
   *
   * Silently ignores the diagnostic if no active deferral session exists
   * for the path (e.g., the session was flushed or cancelled).
   *
   * @param path Absolute file path
   * @param diagnostic Diagnostic to collect
   */
  collect(path: string, diagnostic: Diagnostic): void {
    if (!this.sentinels.has(path)) return;

    const pending = this.pending.get(path);
    if (!pending) return;

    pending.push({
      path,
      diagnostic,
      timestamp: Date.now(),
    });
  }

  /**
   * Flush all deferred diagnostics for a path, clearing the deferral session.
   *
   * Returns an empty array if no active session exists.
   *
   * @param path Absolute file path
   * @returns List of collected diagnostics, oldest first
   */
  flush(path: string): DeferredDiagnostic[] {
    const result = [...(this.pending.get(path) ?? [])];
    this.pending.delete(path);
    this.sentinels.delete(path);
    return result;
  }

  /**
   * Cancel the deferral session for a path, discarding any collected diagnostics.
   *
   * Use this when the edit succeeded without issues and late diagnostics
   * are not needed.
   *
   * @param path Absolute file path
   */
  cancel(path: string): void {
    this.pending.delete(path);
    const existing = this.sentinels.get(path);
    if (existing) {
      existing.abort();
      this.sentinels.delete(path);
    }
  }
}

// ─── Singleton export ───────────────────────────────────────────────

/**
 * Global singleton instance for deferred diagnostic collection.
 */
export const deferredDiagnostics = new DeferredDiagnosticCollector();