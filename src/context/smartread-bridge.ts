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
 *   3. Same-transaction co-change (source: "same_transaction")
 *
 * Pi-SmartRead reads from here during:
 *   1. ContextGraph.buildContextGraph() — replays events into mutation edges
 *   2. EdgeStore.readEdges() — converts events to Provenance objects
 */

import { appendFileSync, existsSync, mkdirSync, realpathSync } from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";

// ─── Constants ─────────────────────────────────────────────────────

const EDGE_LOG_RELPATH = ".pi-smartread/graph-mutations.jsonl";

// ─── Types (mirrors Pi-SmartRead's MutationEvent) ──────────────────

const EDGE_CONTEXT_MAX_CHARS = 500;
const VALID_SOURCES = ["diagnostics", "git_history", "manual", "same_transaction"] as const;
type MutationSource = (typeof VALID_SOURCES)[number];

interface MutationEvent {
  type: "breakage" | "co_change";
  data: {
    from: string;
    to: string;
    context?: string;
    confidence?: number;
    source?: MutationSource;
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
): string | null {
  const event: MutationEvent = {
    type: "breakage",
    data: { from, to, context, confidence: confidence ?? 1.0, source: "diagnostics" },
    timestamp: Date.now(),
  };
  return appendEvent(root, event);
}

/**
 * Record a same-transaction edge — `from` and `to` changed in one committed
 * SmartEdit transaction.
 *
 * @param root    Project root directory.
 * @param from    Relative or absolute path to the edited file.
 * @param to      Relative or absolute path to the co-changing file.
 * @param context Optional description (e.g., commit hash).
 * @param confidence Confidence score 0-1 (default 1.0 for observed transaction).
 */
export function recordCoChange(
  root: string,
  from: string,
  to: string,
  context?: string,
  confidence?: number,
): string | null {
  const event: MutationEvent = {
    type: "co_change",
    data: { from, to, context, confidence: confidence ?? 1.0, source: "same_transaction" },
    timestamp: Date.now(),
  };
  return appendEvent(root, event);
}

// ─── Helpers ───────────────────────────────────────────────────────

// NOTE: This function uses synchronous appendFileSync which is safe for single-process
// execution (JavaScript is single-threaded). For multi-process scenarios (e.g.,
// multiple Pi instances editing the same project), consider using a file lock or
// switching to an async queue with proper synchronization.
/**
 * Canonicalize a from/to path under root, mirroring the reader's
 * canonicalMutationPath (Pi-SmartRead src/graph/edge-store.ts) minus the
 * existence requirement: files that do not exist yet cannot be realpath'd.
 * A `:symbol` suffix is preserved; a Windows drive-letter colon is skipped.
 * Returns null when the path escapes root.
 */
function canonicalMutationPath(root: string, value: string): string | null {
  let marker = -1;
  for (let i = value.indexOf(":"); i !== -1; i = value.indexOf(":", i + 1)) {
    if (i === 1 && /^[a-zA-Z]:[\\/]/.test(value)) continue;
    marker = i;
    break;
  }
  const filePart = marker > 0 ? value.slice(0, marker) : value;
  const suffix = marker > 0 ? value.slice(marker) : "";
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    realRoot = resolve(root);
  }
  const resolved = resolve(realRoot, filePart);
  const rel = relative(realRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved + suffix;
}

export function appendEvent(root: string, event: MutationEvent): string | null {
  if (event.type !== "breakage" && event.type !== "co_change") {
    return "SmartRead bridge rejected malformed mutation event";
  }
  const from = typeof event.data?.from === "string" ? canonicalMutationPath(root, event.data.from) : null;
  const to = typeof event.data?.to === "string" ? canonicalMutationPath(root, event.data.to) : null;
  if (!from || !to) {
    return "SmartRead bridge rejected out-of-root mutation path";
  }
  if (event.data.from.length > 1000 || event.data.to.length > 1000) {
    return "SmartRead bridge rejected malformed mutation event";
  }
  if (!Number.isFinite(event.timestamp)) {
    return "SmartRead bridge rejected malformed mutation event";
  }
  const confidence = event.data.confidence;
  if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    return "SmartRead bridge rejected out-of-range confidence";
  }
  const source = event.data.source;
  if (source !== undefined && !(VALID_SOURCES as readonly string[]).includes(source)) {
    return "SmartRead bridge rejected unknown mutation source";
  }
  const context = typeof event.data.context === "string"
    ? event.data.context.slice(0, EDGE_CONTEXT_MAX_CHARS)
    : undefined;
  const sanitized: MutationEvent = {
    type: event.type,
    data: {
      from,
      to,
      ...(context !== undefined ? { context } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(source !== undefined ? { source } : {}),
    },
    timestamp: event.timestamp,
  };
  const logPath = resolve(root, EDGE_LOG_RELPATH);
  const dir = dirname(logPath);

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return `SmartRead bridge directory creation failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const line = JSON.stringify(sanitized) + "\n";
  try {
    appendFileSync(logPath, line, "utf-8");
    return null;
  } catch (err) {
    return `SmartRead bridge persistence failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
