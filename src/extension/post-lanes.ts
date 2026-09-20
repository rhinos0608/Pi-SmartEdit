import { readFile as fsReadFile } from "fs/promises";
import { resolve } from "path";

import type { ToolResultEvent } from "@mariozechner/pi-coding-agent";
import type { LineRange, WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";

import { recordRead, recordReadSession } from "../context/read-cache";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";
import { isMutationTool } from "../mutation/types.js";
import { runAutoValidation, formatValidationFeedback } from "../verification/auto-validate";
import { appendDiagnosticsToContent } from "../mutation/post-mutation.js";
import type { PatchToolDetails } from "../patch.js";
import type { RetryToolEvent } from "./retry-evidence.js";

/**
 * Shared single-file read+record+validation helper, hoisted out of the
 * tool_result callback (used by the write post-processing path).
 */
export async function validateFileAndBuildFeedback(
  filePath: string,
  cwd: string,
): Promise<
  | {
    path: string;
    feedback: string;
    retryCount: number;
    shouldDecompose: boolean;
  }
  | undefined
> {
  const resolvedPath = resolve(cwd, filePath);
  const content = (await fsReadFile(resolvedPath)).toString("utf-8");
  recordRead(filePath, cwd, content);
  const lines = content.split("\n");
  recordReadSession(filePath, cwd, 1, -1, lines.length, "edit");
  if (!content) {
    return undefined;
  }
  const validationResult = await runAutoValidation(filePath, content, {
    cwd,
    maxRetries: 3,
    enabled: true,
  });
  if (validationResult.passed) return undefined;
  const feedback = formatValidationFeedback(validationResult);
  if (!feedback) return undefined;
  return {
    path: filePath,
    feedback,
    retryCount: validationResult.retryCount,
    shouldDecompose: validationResult.shouldDecompose,
  };
}

/** Lightweight read-cache refresh (no validation), hoisted out of tool_result. */
export async function refreshReadCacheAfterEdit(filePath: string, cwd: string): Promise<void> {
  const resolvedPath = resolve(cwd, filePath);
  const content = (await fsReadFile(resolvedPath)).toString("utf-8");
  recordRead(filePath, cwd, content);
  const lines = content.split("\n");
  recordReadSession(filePath, cwd, 1, -1, lines.length, "edit");
}

/** One contiguous changed hunk in pre-edit (old) and post-edit (new) line coordinates. */
export interface PostEditLineBlock {
  oldStartLine: number;
  oldLineCount: number;
  newStartLine: number;
  newLineCount: number;
}

/**
 * Narrow-mint hint for one edited file: the model-visible postimage changed
 * ranges (diff hunks surfaced to the model) plus the old→new line mapping
 * blocks needed to transform prior authority through the edit.
 */
export interface PostEditNarrowHint {
  changedRanges: LineRange[];
  blocks: PostEditLineBlock[];
}

/** Per-display-path narrow hints, keyed by the same path strings used for minting. */
export type NarrowHintsByPath = ReadonlyMap<string, PostEditNarrowHint>;

/** Mutation-evidence minter with optional post-edit narrowing hints (edit path). */
export type BuildMutationEvidence = (
  paths: string[],
  narrowHints?: NarrowHintsByPath,
) => Promise<WorkspaceEvidenceEnvelope | undefined>;

/**
 * Parse an edit display diff (generateDiffString format: `+NNN`/`-NNN`/` NNN`
 * lines with `...` elisions) into model-visible postimage changed ranges and
 * old→new line mapping blocks. Unknown lines break sync conservatively.
 */
export function parsePostEditDiff(diff: string): PostEditNarrowHint {
  const changedRanges: LineRange[] = [];
  const blocks: PostEditLineBlock[] = [];
  let delta = 0;
  let oldPtr: number | null = null;
  let block: { oldStart: number; oldLen: number; newLen: number } | null = null;
  const finishBlock = (): void => {
    if (!block) return;
    const newStart = block.oldStart + delta;
    if (block.newLen > 0) changedRanges.push({ startLine: newStart, endLine: newStart + block.newLen - 1 });
    blocks.push({
      oldStartLine: block.oldStart,
      oldLineCount: block.oldLen,
      newStartLine: newStart,
      newLineCount: block.newLen,
    });
    delta += block.newLen - block.oldLen;
    block = null;
  };
  for (const line of diff.split("\n")) {
    if (/^ +\.\.\.$/.test(line)) {
      finishBlock();
      oldPtr = null;
      continue;
    }
    const m = /^([+\- ]) *(\d+)(?: (.*))?$/.exec(line);
    if (!m) {
      finishBlock();
      oldPtr = null;
      continue;
    }
    const sign = m[1];
    const n = Number.parseInt(m[2] ?? "0", 10);
    if (!Number.isInteger(n) || n < 1) {
      finishBlock();
      oldPtr = null;
      continue;
    }
    if (sign === " ") {
      finishBlock();
      oldPtr = n + 1;
    } else if (sign === "-") {
      if (!block) block = { oldStart: n, oldLen: 0, newLen: 0 };
      block.oldLen++;
      oldPtr = n + 1;
    } else {
      if (!block) block = { oldStart: oldPtr ?? n - delta, oldLen: 0, newLen: 0 };
      block.newLen++;
    }
  }
  finishBlock();
  return { changedRanges, blocks };
}

/** Merge overlapping/adjacent 1-based line ranges into minimal disjoint form. */
function mergeDisjointRanges(ranges: ReadonlyArray<LineRange>): LineRange[] {
  if (ranges.length <= 1) return ranges.map((r) => ({ ...r }));
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
  const out: Array<{ startLine: number; endLine: number }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, r.endLine);
    } else {
      out.push({ startLine: r.startLine, endLine: r.endLine });
    }
  }
  return out;
}

/**
 * Transform prior (pre-edit) authority ranges through the edit mapping and
 * union the model-visible postimage changed ranges, clamped to the post-edit
 * line count. Ranges over entirely deleted lines collapse and are dropped —
 * the model must re-read to gain authority there.
 */
export function narrowPostEditRanges(
  prior: ReadonlyArray<LineRange>,
  hint: PostEditNarrowHint,
  lineCount: number,
): LineRange[] {
  const blocks = [...hint.blocks].sort((a, b) => a.oldStartLine - b.oldStartLine);
  const mapPoint = (x: number, isEnd: boolean): number => {
    let shift = 0;
    for (const b of blocks) {
      if (b.oldLineCount > 0) {
        const oldEnd = b.oldStartLine + b.oldLineCount - 1;
        if (x < b.oldStartLine) return x + shift;
        if (x > oldEnd) {
          shift += b.newLineCount - b.oldLineCount;
          continue;
        }
        if (b.newLineCount === 0) return isEnd ? b.newStartLine - 1 : b.newStartLine;
        return isEnd ? b.newStartLine + b.newLineCount - 1 : b.newStartLine;
      }
      if (x < b.oldStartLine) return x + shift;
      shift += b.newLineCount;
    }
    return x + shift;
  };
  const out: LineRange[] = [];
  for (const r of prior) {
    const s = mapPoint(r.startLine, false);
    const e = mapPoint(r.endLine, true);
    if (s <= e) out.push({ startLine: s, endLine: e });
  }
  for (const r of hint.changedRanges) out.push({ ...r });
  return mergeDisjointRanges(
    out
      .filter((r) => r.startLine <= r.endLine && r.endLine >= 1 && r.startLine <= lineCount)
      .map((r) => ({ startLine: Math.max(1, r.startLine), endLine: Math.min(lineCount, r.endLine) })),
  );
}

/** tool_result seam: write diagnostics lane (awaited + returned, not fire-and-forget). */
export async function handleWriteResult(
  event: { toolName?: string; isError?: boolean; input?: unknown; content?: unknown; details?: unknown },
  toolCwd: string,
  buildMutationEvidence: BuildMutationEvidence,
  store: PriorAuthorityStore | null,
): Promise<{ content: ToolResultEvent["content"]; details: unknown } | undefined> {
  const writePath = (event.input as { path?: string } | undefined)?.path;
  if (
    event.toolName !== "write" ||
    event.isError ||
    !writePath
  ) {
    return undefined;
  }
  try {
    const entry = await validateFileAndBuildFeedback(writePath, toolCwd);
    const workspaceEvidence = await buildMutationEvidence([writePath]);
    if (workspaceEvidence) store?.record(workspaceEvidence);
    if (entry || workspaceEvidence) {
      const block = entry ? `\n\nPost-write diagnostics:\n${entry.feedback}` : "";
      return {
        content: block ? appendDiagnosticsToContent(event.content as Array<{ type: string; text?: unknown }>, block) as ToolResultEvent["content"] : event.content as ToolResultEvent["content"],
        details: {
          ...((event.details as Record<string, unknown> | undefined) ?? {}),
          ...(entry ? {
            postEditDiagnostics: { schemaVersion: 1, paths: [writePath], checked: true },
            validationRetries: entry.retryCount,
            shouldDecompose: entry.shouldDecompose,
          } : {}),
          ...(workspaceEvidence ? { workspaceEvidence } : {}),
        },
      };
    }
    return undefined;
  } catch {
    // File might not exist yet or can't be read — skip silently
    return undefined;
  }
}

/** tool_result seam: failed classic-text retry-evidence minting. */
export async function handleEditRetryResult(
  event: RetryToolEvent,
  toolCwd: string,
  buildRetryEvidence: (event: RetryToolEvent, cwd: string) => Promise<{ envelope: WorkspaceEvidenceEnvelope; text: string } | undefined>,
  store: PriorAuthorityStore | null,
): Promise<{ content: ToolResultEvent["content"]; details: unknown } | undefined> {
  if (event.toolName !== "edit" || event.isError) return undefined;
  try {
    const retry = await buildRetryEvidence(event, toolCwd);
    if (retry) {
      store?.record(retry.envelope);
      return {
        content: appendDiagnosticsToContent(event.content as Array<{ type: string; text?: unknown }>, `\n\n${retry.text}\nRe-edit using exact text and lineRange above; no separate read needed.`) as ToolResultEvent["content"],
        details: { ...(event.details as Record<string, unknown> ?? {}), workspaceEvidence: retry.envelope },
      };
    }
    return undefined;
  } catch {
    // Retry context is advisory; failed reads and races produce no evidence.
    return undefined;
  }
}

/** tool_result seam: edit success read-cache refresh + evidence mint. */
export async function handleEditSuccessResult(
  event: { toolName?: string; isError?: boolean; content?: unknown; details?: unknown },
  toolCwd: string,
  buildMutationEvidence: BuildMutationEvidence,
  store: PriorAuthorityStore | null,
): Promise<{ content: ToolResultEvent["content"]; details: unknown } | undefined> {
  if (!isMutationTool(event.toolName) || event.isError) {
    return undefined;
  }
  try {
    const details = (event as unknown as { details?: PatchToolDetails }).details;
    if (
      details?.status?.kind !== "applied" ||
      !Array.isArray(details.diffs) ||
      details.diffs.length === 0
    ) {
      return undefined;
    }
    const uniquePaths = [
      ...new Set(
        details.diffs
          .map((d) => d.path)
          .filter((p): p is string => typeof p === "string"),
      ),
    ];
    for (const p of uniquePaths) {
      await refreshReadCacheAfterEdit(p, toolCwd).catch(() => {
        // File might not exist yet or can't be read — skip silently
      });
    }
    // Narrow-mint hints: the diff hunks surfaced to the model carry the
    // postimage changed ranges plus the old→new line mapping, so the mint can
    // advance the SHA past the stale guard without broadening coverage.
    // Group diff strings per path, then concatenate BEFORE parsing: parsePostEditDiff
    // tracks a running delta, so parsing chunks separately and concatenating
    // blocks would leave later chunks offset wrong when an earlier chunk shifts lines.
    const diffsByPath = new Map<string, string[]>();
    for (const d of details.diffs) {
      const entry = d as { path?: unknown; diff?: unknown };
      if (typeof entry.path !== "string" || typeof entry.diff !== "string" || entry.diff.length === 0) continue;
      const chunks = diffsByPath.get(entry.path);
      if (chunks) chunks.push(entry.diff);
      else diffsByPath.set(entry.path, [entry.diff]);
    }
    const narrowHints = new Map<string, PostEditNarrowHint>();
    for (const [path, chunks] of diffsByPath) narrowHints.set(path, parsePostEditDiff(chunks.join("\n")));
    const workspaceEvidence = await buildMutationEvidence(uniquePaths, narrowHints);
    if (workspaceEvidence) {
      store?.record(workspaceEvidence);
      return {
        content: event.content as ToolResultEvent["content"],
        details: { ...(event.details as Record<string, unknown> ?? {}), workspaceEvidence },
      };
    }
    return undefined;
  } catch {
    // Edit post-processing is advisory — silent degradation
    return undefined;
  }
}
