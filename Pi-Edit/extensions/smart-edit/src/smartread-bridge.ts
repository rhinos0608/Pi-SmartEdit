/**
 * Pi-SmartRead Bridge — writes graph mutation events (breakage, co-change)
 * to the EdgeStore JSONL file that Pi-SmartRead reads during graph construction.
 *
 * This is the file-level IPC bridge between Smart-Edit and Pi-SmartRead.
 * No shared imports, no process coupling — just append-only JSONL files
 * in a well-known location: <project-root>/.pi-smartread/graph-mutations.jsonl
 *
 * Smart-Edit writes here after:
 *   1. Post-edit diagnostics detect breakage in files outside the edit target
 *   2. Git history analysis finds files that co-change together
 *
 * Pi-SmartRead reads from here during:
 *   1. ContextGraph.buildContextGraph() — replays events into mutation edges
 *   2. EdgeStore.readEdges() — converts events to Provenance objects
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

// ─── Constants ─────────────────────────────────────────────────────

const EDGE_LOG_RELPATH = ".pi-smartread/graph-mutations.jsonl";

// ─── Types (mirrors Pi-SmartRead's MutationEvent) ──────────────────

interface MutationEvent {
  type: "breakage" | "co_change";
  data: {
    from: string;
    to: string;
    context?: string;
    confidence?: number;
    source?: string;
  };
  timestamp: number;
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Record a breakage edge — editing `from` caused diagnostic errors in `to`.
 *
 * Call this after post-edit diagnostics find errors in files outside the
 * edit target (or cross-file breakage). The edge is written to Pi-SmartRead's
 * mutation log and replayed during the next graph construction.
 *
 * @param root    Project root directory (used for log file location).
 * @param from    Relative or absolute path to the edited file/symbol.
 * @param to      Relative or absolute path to the broken file/symbol.
 * @param context Optional description (e.g., "TS2322: type mismatch in User.balance").
 * @param confidence Confidence score 0-1 (default 1.0 for observed diagnostics).
 */
export function recordBreakage(
  root: string,
  from: string,
  to: string,
  context?: string,
  confidence?: number,
): void {
  const event: MutationEvent = {
    type: "breakage",
    data: { from, to, context, confidence, source: "diagnostics" },
    timestamp: Date.now(),
  };
  appendEvent(root, event);
}

/**
 * Record a co-change edge — `from` and `to` consistently change in the same
 * git commits. Call this after git history analysis identifies coupled files.
 *
 * @param root    Project root directory.
 * @param from    Relative or absolute path to the edited file.
 * @param to      Relative or absolute path to the co-changing file.
 * @param context Optional description (e.g., commit hash).
 * @param confidence Confidence score 0-1 (default 0.7 for git history).
 */
export function recordCoChange(
  root: string,
  from: string,
  to: string,
  context?: string,
  confidence?: number,
): void {
  const event: MutationEvent = {
    type: "co_change",
    data: { from, to, context, confidence: confidence ?? 0.7, source: "git_history" },
    timestamp: Date.now(),
  };
  appendEvent(root, event);
}

// ─── Helpers ───────────────────────────────────────────────────────

function appendEvent(root: string, event: MutationEvent): void {
  const logPath = resolve(root, EDGE_LOG_RELPATH);
  const dir = dirname(logPath);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const line = JSON.stringify(event) + "\n";
  try {
    appendFileSync(logPath, line, "utf-8");
  } catch {
    // Silently ignore write failures — edge recording is advisory
  }
}
