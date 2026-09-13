/**
 * Smart Edit — Improved edit tool extension for Pi Coding Agent.
 *
 * Overrides Pi's built-in edit tool with improved matching, fuzzy-match
 * safety, replaceAll support, stale-file detection, atomic writes, and
 * richer diagnostics.
 *
 * Installation: copy to ~/.pi/agent/extensions/smart-edit.ts
 *   or load ./src/index.ts for repository-local use.
 */

import type { ExtensionAPI, Theme, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui";

import { realpathSync, statSync } from "fs";
import { readFile as fsReadFile } from "fs/promises";
import { resolve, relative } from "path";
import { sortHashlineEditsForApplication, formatHashlineBatchSummary } from "./hashline-batching.js";
import {
  prepareArguments,
  validateInput,
  formatEditError,
} from "./args.js";

import { createAstResolver } from "./core/ast-resolver";

import { recordRead, recordReadSession, getSnapshot } from "./core/read-cache";

import { buildHashlineAnchors } from "./core/hashline";

import { LSPManager } from "./lsp/lsp-manager";
import { checkPostEditDiagnostics } from "./lsp/diagnostics";
import { createSmartReadDiagnosticsClient } from "./lsp/smartread-diagnostics-client.js";
import { getCompilerForLanguage } from "./lsp/diagnostic-dispatcher";
import { detectLanguageFromExtension } from "./lsp/language-id";



import { getSmartEditRuntimeConfig } from "./edit-mode";
import { runAutoValidation, formatValidationFeedback, resetRetryCounts } from "./verification/auto-validate";
import { runRepairLoop } from "./verification/repair-loop";
import { runPostEditEvidencePipeline } from "./verification/post-edit-evidence";
import { recordBreakage, recordCoChange } from "./smartread-bridge";
import { claimDiagnosticsOwner, releaseDiagnosticsOwner } from "./mutation-ownership.js";
import { appendDiagnosticsToContent } from "./post-mutation.js";
import { createPatchTool, type PatchToolDeps, type PatchToolDetails } from "./patch.js";
import { normalizeFlatEditRequest } from "./edit-contract.js";
import { normalizeRawEdit } from "./edit-intents.js";
import { createPriorAuthorityStore, type PriorAuthorityStore } from "./evidence-authority.js";
import {
  createRpcClient,
  RPC_CHANNELS,
  PROTOCOL_SCHEMA_VERSION,
  hashSessionFilePath,
  inspectionIdFor,
  resourceIdFor,
  sha256OfString,
  type WorkspaceEvidenceEnvelope,
  type LineRange,
} from "@rhinos0608/pi-workspace-protocol";

import type {
  EditResult,
  EditCapability,
} from "./core/types";

const smartEditRuntimeConfig = getSmartEditRuntimeConfig();

function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "symbol") return value.description ?? value.toString();
  if (typeof value === "function") return value.name ? `[Function: ${value.name}]` : "[Function]";
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function lineRangeToOffsets(content: string, range: { startLine: number; endLine: number }): { startIndex: number; endIndex: number } {
  const lines = content.split("\n");
  const offsetForLine = (line: number): number => lines.slice(0, Math.max(line - 1, 0)).reduce((offset, value) => offset + value.length + 1, 0);
  return {
    startIndex: offsetForLine(range.startLine),
    endIndex: Math.min(offsetForLine(range.endLine + 1), content.length),
  };
}

function omitAgentEvidenceRef(args: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(args, "evidenceRef")) return args;
  const { evidenceRef: _ignored, ...toolOwnedArgs } = args;
  return toolOwnedArgs;
}

// ─── Schema ───────────────────────────────────────────────────────
// The canonical edit request schema lives in src/edit-contract.ts
// (EDIT_PARAMETERS) and is the single registration source. Rich edit
// metadata is validated there.


export function resolveEditPath(cwd: string, targetPath: string): string {
  return resolve(cwd, targetPath);
}

type EditRenderArgs = {
  path?: unknown;
  edits?: unknown;
  raw?: unknown;
};

type EditRenderResult = {
  content: Array<{ type: string; text?: string }>;
  details?: PatchToolDetails;
};

class EditTextComponent implements Component {
  constructor(private readonly text: string, private readonly paddingX = 0) {}

  render(width: number): string[] {
    const padding = " ".repeat(this.paddingX);
    return this.text.split("\n").map((line) => {
      const renderedLine = `${padding}${line}`;
      return visibleWidth(renderedLine) <= width
        ? renderedLine
        : truncateToWidth(renderedLine, width);
    });
  }

  invalidate(): void {}
}

function renderEditDiff(diff: string, theme: Theme): string {
  return diff.split("\n").map((line) => {
    if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
    if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
    return theme.fg("toolDiffContext", line);
  }).join("\n");
}

/**
 * Extract display paths from a raw patch string (unified diff, search/replace,
 * OpenAI/Codex patch, Atomic Patch, etc.) by reusing the same intent parsing
 * the edit tool applies at execution time. A raw call can legitimately have
 * neither a top-level `path` nor an `edits` array — the path(s) live inside
 * the raw diff content itself (e.g. `--- a/path` / `+++ b/path` headers).
 * Never throws: parse failures simply yield no paths, so the caller falls
 * back to its existing "missing path" display.
 */
function getRawEditDisplayPaths(raw: string, defaultPath: string | undefined): string[] {
  try {
    const normalized = normalizeRawEdit(raw, defaultPath);
    const paths = normalized.intents.flatMap((intent): (string | undefined)[] => {
      switch (intent.kind) {
        case "text":
          return [intent.operation.path];
        case "add":
        case "delete":
          return [intent.path];
        case "rename":
          return [intent.newPath, intent.oldPath];
        default:
          return [];
      }
    });
    return [...new Set(paths.filter((path): path is string => Boolean(path)))];
  } catch {
    return [];
  }
}

export function getEditDisplayPaths(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const input = args as EditRenderArgs;
  const defaultPath = typeof input.path === "string" ? input.path : undefined;
  const edits = Array.isArray(input.edits) ? input.edits : [];

  if (edits.length > 0) {
    const paths = edits
      .map((edit) => {
        if (!edit || typeof edit !== "object") return defaultPath;
        const itemPath = (edit as { path?: unknown }).path;
        return typeof itemPath === "string" ? itemPath : defaultPath;
      })
      .filter((path): path is string => Boolean(path));

    if (paths.length === 0 && defaultPath) paths.push(defaultPath);
    return [...new Set(paths)];
  }

  // No `edits` array — a raw patch call carries its path(s) inside the raw
  // diff content instead of top-level fields. Parse it the same way the
  // tool does at execution time rather than falling straight to "missing path".
  if (typeof input.raw === "string" && input.raw.length > 0) {
    const rawPaths = getRawEditDisplayPaths(input.raw, defaultPath);
    if (rawPaths.length > 0) return rawPaths;
  }

  return defaultPath ? [defaultPath] : [];
}

export function renderEditCall(args: unknown, theme: Theme): Component {
  const paths = getEditDisplayPaths(args);
  const pathText = paths.length > 0
    ? theme.fg("accent", paths.join(", "))
    : theme.fg("error", "missing path");
  return new EditTextComponent(`${theme.fg("toolTitle", theme.bold("edit"))} ${pathText}`);
}

export function renderEditResult(
  result: EditRenderResult,
  options: { isPartial: boolean },
  theme: Theme,
): Component {
  if (options.isPartial) {
    return new EditTextComponent(theme.fg("warning", "Editing..."), 1);
  }

  const details = result.details;
  const diffs = details?.diffs?.filter(
    (entry) => typeof entry.path === "string" && typeof entry.diff === "string" && entry.diff.length > 0,
  );
  if (diffs && diffs.length > 0) {
    const output = diffs.length === 1
      ? renderEditDiff(diffs[0].diff, theme)
      : diffs
          .map((entry) => `${theme.fg("accent", entry.path)}\n${renderEditDiff(entry.diff, theme)}`)
          .join("\n\n");
    return new EditTextComponent(output, 1);
  }
  if (typeof details?.diff === "string" && details.diff.length > 0) {
    return new EditTextComponent(renderEditDiff(details.diff, theme), 1);
  }

  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
  const failed = details?.status.kind !== "applied";
  return new EditTextComponent(theme.fg(failed ? "error" : "success", text || (failed ? "Edit failed" : "Applied")), 1);
}

type ToolEditResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: EditResult["details"];
};

export function combineMultiFileEditResults(results: ToolEditResult[]): ToolEditResult {
  const details: EditResult["details"] = {};
  const diffs: string[] = [];
  const matchNotes: string[] = [];
  const conflictWarnings: string[] = [];
  const mutatedPaths = new Set<string>();
  const diagnostics: NonNullable<EditResult["details"]["diagnostics"]> = [];
  const editCapabilities = new Set<EditCapability>();
  const scopedDiagnostics: NonNullable<EditResult["details"]["scopedDiagnostics"]> = [];

  for (const result of results) {
    const childDetails = result.details;
    if (!childDetails) continue;
    if (childDetails.diff) diffs.push(childDetails.diff);
    matchNotes.push(...(childDetails.matchNotes ?? []));
    conflictWarnings.push(...(childDetails.conflictWarnings ?? []));
    for (const path of childDetails.mutatedPaths ?? []) mutatedPaths.add(path);
    diagnostics.push(...(childDetails.diagnostics ?? []));
    for (const capability of childDetails.editCapabilities ?? []) editCapabilities.add(capability);
    scopedDiagnostics.push(...(childDetails.scopedDiagnostics ?? []));
  }

  if (diffs.length > 0) details.diff = diffs.join("\n");
  if (matchNotes.length > 0) details.matchNotes = matchNotes;
  if (conflictWarnings.length > 0) details.conflictWarnings = conflictWarnings;
  if (mutatedPaths.size > 0) details.mutatedPaths = [...mutatedPaths];
  if (diagnostics.length > 0) details.diagnostics = diagnostics;
  if (editCapabilities.size > 0) details.editCapabilities = [...editCapabilities].sort();
  if (scopedDiagnostics.length > 0) details.scopedDiagnostics = scopedDiagnostics;

  return {
    content: results.flatMap((result) => result.content),
    details,
  };
}






// ─── AST resolver instance (per-session) ────

/** AST resolver instance, created once per session. null if Tree-sitter unavailable. */
let astResolver: ReturnType<typeof createAstResolver> | null = null;

/** LSP manager instance, created once per session. */
let lspManager: LSPManager | null = null;
/** SmartRead diagnostics client (sticky remote/standalone mode). */
let smartReadDiagnosticsClient: ReturnType<typeof createSmartReadDiagnosticsClient> | null = null;

/**
 * Compute the containing line range for a set of edits from their oldText.
 * Returns [startLine, endLine] (1-based) or null if oldText can't be located.
 *
 * Used by the range coverage guard to validate that edit targets fall within
 * lines that were actually read this session.
 */


export { sortHashlineEditsForApplication, formatHashlineBatchSummary };

// ─── Lane B file-local helpers (extract-only; no behavior change) ───

type RetryToolEvent = {
  input?: unknown;
  details?: unknown;
  content?: unknown;
  isError?: boolean;
  toolName?: string;
};

type RetrySessionState = {
  sessionFilePath: string | null;
  canonicalWorkspaceRoot: string | null;
  priorAuthority: PriorAuthorityStore | null;
};

type RetryEligibility = {
  canonicalPath: string;
  content: string;
  sha: string;
  resource: NonNullable<ReturnType<PriorAuthorityStore["select"]>>;
  explicitRange?: { startLine: number; endLine: number };
  matchFailure: "NOT_FOUND" | "AMBIGUOUS";
  oldText: string;
};

/** buildRetryEvidence seam: eligibility + target resolution + prior-authority freshness. */
async function checkRetryEligibility(
  event: RetryToolEvent,
  cwd: string,
  state: RetrySessionState,
): Promise<RetryEligibility | undefined> {
  if (event.toolName !== "edit" || event.isError || !state.sessionFilePath || !state.canonicalWorkspaceRoot) return undefined;
  const details = event.details as { status?: { kind?: string; phase?: string }; matchFailure?: string } | undefined;
  if (details?.status?.kind !== "failed" || details.status.phase !== "stage") return undefined;
  if (details.matchFailure !== "NOT_FOUND" && details.matchFailure !== "AMBIGUOUS") return undefined;
  const input = event.input as { path?: unknown; edits?: unknown; raw?: unknown } | undefined;
  if (!input || input.raw !== undefined || !Array.isArray(input.edits) || input.edits.length !== 1) return undefined;
  const edit = input.edits[0] as { path?: unknown; oldText?: unknown; target?: unknown; lineRange?: unknown; hashline?: unknown };
  if (typeof edit?.oldText !== "string" || edit.target !== undefined || edit.hashline !== undefined) return undefined;
  if (input.path !== undefined && typeof input.path !== "string") return undefined;
  if (edit.path !== undefined && typeof edit.path !== "string") return undefined;
  if (input.path !== undefined && edit.path !== undefined && resolve(cwd, input.path) !== resolve(cwd, edit.path)) return undefined;
  const targetPath = typeof input.path === "string" ? input.path : edit.path;
  if (typeof targetPath !== "string" || targetPath.length === 0) return undefined;
  const lineRange = edit.lineRange as { startLine?: unknown; endLine?: unknown } | undefined;
  const explicitRange = lineRange && Number.isInteger(lineRange.startLine) && Number.isInteger(lineRange.endLine)
    ? { startLine: lineRange.startLine as number, endLine: lineRange.endLine as number } : undefined;
  const resolvedPath = resolve(cwd, targetPath);
  let canonicalPath: string;
  try { canonicalPath = realpathSync(resolvedPath); } catch { return undefined; }
  const resource = state.priorAuthority?.select(canonicalPath);
  if (!resource || (resource.coverage !== "full-file" && resource.coverage !== "line-range") || typeof resource.fullFileSha256 !== "string") return undefined;
  let content: string;
  try { content = (await fsReadFile(canonicalPath)).toString("utf8"); } catch { return undefined; }
  const sha = sha256OfString(content);
  if (sha !== resource.fullFileSha256) return undefined;
  return { canonicalPath, content, sha, resource, explicitRange, matchFailure: details.matchFailure, oldText: edit.oldText };
}

/** buildRetryEvidence seam: context-window collection around the failure site. */
function collectRetryWindows(
  content: string,
  explicitRange: { startLine: number; endLine: number } | undefined,
  matchFailure: "NOT_FOUND" | "AMBIGUOUS",
  oldText: string,
): LineRange[] | undefined {
  const lines = content.split("\n");
  const ranges: LineRange[] = [];
  const addWindow = (line: number) => {
    if (!Number.isInteger(line) || line < 1 || line > lines.length) return;
    ranges.push({ startLine: Math.max(1, line - 2), endLine: Math.min(lines.length, line + 2) });
  };
  if (explicitRange) addWindow(explicitRange.startLine);
  if (matchFailure === "AMBIGUOUS" && !explicitRange && oldText.length > 0) {
    let from = 0;
    while (ranges.length < 3) {
      const at = content.indexOf(oldText, from);
      if (at < 0) break;
      addWindow(content.slice(0, at).split("\n").length);
      from = at + Math.max(1, oldText.length);
    }
  }
  if (ranges.length === 0) return undefined;
  return ranges;
}

/** buildRetryEvidence seam: intersect candidate windows with prior authority. */
function authorizeRetryWindows(
  resource: RetryEligibility["resource"],
  ranges: LineRange[],
): LineRange[] {
  const authorized = resource.coverage === "full-file" ? ranges : ranges.flatMap((candidate) => resource.allowedRanges.flatMap((allowed) => {
    const startLine = Math.max(candidate.startLine, allowed.startLine);
    const endLine = Math.min(candidate.endLine, allowed.endLine);
    return startLine <= endLine ? [{ startLine, endLine }] : [];
  }));
  return [...new Map(authorized.map((range) => [`${range.startLine}:${range.endLine}`, range])).values()].slice(0, 3);
}

/** buildRetryEvidence seam: cap windows by count, line budget, byte budget. */
function applyRetryBudget(unique: LineRange[], lines: string[]): LineRange[] | undefined {
  const selected: LineRange[] = [];
  let bytes = 0;
  for (const range of unique) {
    const source = lines.slice(range.startLine - 1, range.endLine).join("\n");
    const size = Buffer.byteLength(source, "utf8");
    if (selected.length >= 3 || selected.reduce((n, r) => n + r.endLine - r.startLine + 1, 0) + range.endLine - range.startLine + 1 > 24 || bytes + size > 8192) break;
    selected.push(range); bytes += size;
  }
  if (selected.length === 0) return undefined;
  return selected;
}

/** buildRetryEvidence seam: freshness re-read + envelope mint (keeps session/root recheck). */
async function mintRetryEvidenceFromSelection(
  selected: LineRange[],
  canonicalPath: string,
  sha: string,
  state: RetrySessionState,
): Promise<{ envelope: WorkspaceEvidenceEnvelope; text: string } | undefined> {
  // Re-read after range selection: a concurrent write must never mint retry authority.
  let confirm: string;
  try { confirm = (await fsReadFile(canonicalPath)).toString("utf8"); } catch { return undefined; }
  if (sha256OfString(confirm) !== sha) return undefined;
  const resources = selected.map((range) => ({
    resourceId: resourceIdFor({ canonicalPath, kind: "range", range }), canonicalPath, kind: "range" as const,
    coverage: "line-range" as const, allowedRanges: [range], fullFileSha256: sha,
    fresh: true, byteLength: Buffer.byteLength(confirm, "utf8"), lineCount: confirm.split("\n").length,
  }));
  const sessionFilePath = state.sessionFilePath;
  const workspaceRoot = state.canonicalWorkspaceRoot;
  if (!sessionFilePath || !workspaceRoot) return undefined;
  const sessionId = hashSessionFilePath(sessionFilePath);
  const envelope: WorkspaceEvidenceEnvelope = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    inspectionId: inspectionIdFor({ sessionId, workspaceRoot, resources: resources.map((r) => ({ canonicalPath: r.canonicalPath, allowedRanges: r.allowedRanges })) }),
    sessionId, workspaceRoot, canonicalWorkspaceRoot: workspaceRoot,
    createdAt: new Date().toISOString(), resources, mode: "path",
  };
  const text = selected.map((range) => `lineRange ${range.startLine}-${range.endLine}:\n${confirm.split("\n").slice(range.startLine - 1, range.endLine).join("\n")}`).join("\n");
  return { envelope, text };
}

/** tool_result seam: release diagnostics claim on failed mutation. */
function releaseClaimOnFailedMutation(event: { toolName?: string; isError?: boolean; toolCallId: string }): void {
  if (
    (event.toolName === "write" || event.toolName === "edit") &&
    event.isError
  ) {
    releaseDiagnosticsOwner(event.toolCallId);
  }
}

/** tool_result seam: ingest SmartRead workspace evidence into prior authority store. */
function ingestWorkspaceEvidence(
  event: { toolName?: string; isError?: boolean; details?: unknown },
  store: PriorAuthorityStore | null,
): void {
  try {
    const wsEvidence = event.toolName === "read" && !event.isError
      ? (event.details as { workspaceEvidence?: unknown } | undefined)?.workspaceEvidence
      : undefined;
    if (wsEvidence) {
      store?.record(wsEvidence);
    }
  } catch {
    /* silently ignore evidence ingestion errors */
  }
}

type SingleReadInput = { path?: string; offset?: number; limit?: number };

/** tool_result single-read seam: offset/limit (partial) branch. */
async function recordOffsetLimitSingleRead(
  input: SingleReadInput,
  toolCwd: string,
  inputPath: string,
  fullText: string,
): Promise<void> {
  const readOffset = input?.offset ?? 1;
  const lines = fullText.split("\n");
  const hashline = smartEditRuntimeConfig.useHashlineEditing
    ? await buildHashlineAnchors(lines, readOffset)
    : undefined;
  recordRead(inputPath, toolCwd, fullText, true, hashline, readOffset);
  const explicitLimit = input?.limit;
  if (explicitLimit === undefined) {
    let totalFileLines = lines.length + readOffset - 1;
    try {
      const snapshot = getSnapshot(inputPath, toolCwd);
      if (snapshot?.hashline?.formattedLines?.length) {
        totalFileLines = snapshot.hashline.formattedLines.length;
      }
    } catch {
      // Fall back to computed value
    }
    recordReadSession(inputPath, toolCwd, readOffset, -1, totalFileLines, "read");
  } else {
    recordReadSession(inputPath, toolCwd, readOffset, explicitLimit, lines.length + readOffset - 1, "read");
  }
}

/** tool_result single-read seam: full (possibly truncated) branch. */
async function recordCompleteSingleRead(toolCwd: string, inputPath: string, fullText: string): Promise<void> {
  let isTruncated = false;
  try {
    const resolvedPath = resolve(toolCwd, inputPath);
    const fileStat = statSync(resolvedPath);
    if (fileStat.size > fullText.length) {
      isTruncated = true;
    }
  } catch {
    // file may not exist or stat failed — record normally
  }
  const lines = fullText.split("\n");
  const hashline = smartEditRuntimeConfig.useHashlineEditing
    ? await buildHashlineAnchors(lines)
    : undefined;
  recordRead(inputPath, toolCwd, fullText, isTruncated, hashline);
  recordReadSession(inputPath, toolCwd, 1, -1, lines.length, "read");
}

/**
 * tool_result seam: single-read cache population.
 * Returns true when the event was a single read (caller preserves the
 * original early return after the offset/limit branch).
 */
async function handleSingleReadResult(
  event: { toolName?: string; isError?: boolean; content?: unknown; input?: unknown },
  toolCwd: string,
): Promise<boolean> {
  if (
    event.toolName !== "read" ||
    event.isError ||
    !event.content
  ) {
    return false;
  }
  try {
    const isOffsetLimitRead =
      (event.input as SingleReadInput | undefined)?.offset != null || (event.input as SingleReadInput | undefined)?.limit != null;
    const contentBlocks = Array.isArray(event.content) ? event.content : [];
    const fullText = contentBlocks
      .filter((c) => (c as { type?: string }).type === "text")
      .map((c) => coerceText((c as { text?: unknown }).text))
      .join("");
    const inputPath = (event.input as { path?: string } | undefined)?.path;
    if (!fullText || !inputPath) return true;
    if (isOffsetLimitRead) {
      await recordOffsetLimitSingleRead(event.input as SingleReadInput, toolCwd, inputPath, fullText);
      return true;
    }
    await recordCompleteSingleRead(toolCwd, inputPath, fullText);
    return true;
  } catch {
    /* silently ignore cache population errors */
    return true;
  }
}

/** tool_result seam: read_files / read_multiple_files cache population. */
async function handleMultiReadResult(
  event: { toolName?: string; isError?: boolean; details?: unknown; input?: unknown },
  toolCwd: string,
): Promise<void> {
  if (
    (event.toolName !== "read_files" && event.toolName !== "read_multiple_files") ||
    event.isError
  ) {
    return;
  }
  try {
    const rawDetailFiles = (event.details as { files?: Array<{ path: string; ok?: boolean }> } | undefined)?.files;
    const detailFiles = Array.isArray(rawDetailFiles) ? rawDetailFiles : undefined;
    const rawInputFiles = (event.input as { files?: Array<{ path: string; offset?: number; limit?: number }> } | undefined)?.files;
    const inputFiles = Array.isArray(rawInputFiles) ? rawInputFiles : undefined;
    const filesToProcess = (detailFiles ?? inputFiles) ?? [];
    if (filesToProcess.length > 0) {
      const inputMap = new Map<string, { offset?: number; limit?: number }>();
      if (inputFiles) {
        for (const f of inputFiles) inputMap.set(f.path, { offset: f.offset, limit: f.limit });
      }
      for (const file of filesToProcess) {
        if ("ok" in file && file.ok === false) continue;
        try {
          const resolvedPath = resolve(toolCwd, file.path);
          const content = (await fsReadFile(resolvedPath)).toString("utf-8");
          if (content) {
            const inputInfo = inputMap.get(file.path);
            const isPartial = inputInfo?.offset != null || inputInfo?.limit != null;
            const lines = content.split("\n");
            const hashline = smartEditRuntimeConfig.useHashlineEditing
              ? await buildHashlineAnchors(lines)
              : undefined;
            recordRead(file.path, toolCwd, content, isPartial, hashline);
            const readOffset = inputInfo?.offset ?? 1;
            const readLimit = inputInfo?.limit ?? -1;
            recordReadSession(file.path, toolCwd, readOffset, readLimit, lines.length, "read_files");
          }
        } catch {
          // File may not exist or can't be read — skip silently
        }
      }
    }
  } catch {
    /* silently ignore cache population errors */
  }
}

/** tool_result seam: intent_read cache population. */
async function handleIntentReadResult(
  event: { toolName?: string; isError?: boolean; details?: unknown },
  toolCwd: string,
): Promise<void> {
  if (
    event.toolName !== "intent_read" ||
    event.isError
  ) {
    return;
  }
  try {
    const rawDetailFiles = (event.details as { files?: Array<{ path: string; ok: boolean; inclusion?: string }> } | undefined)?.files;
    const detailFiles = Array.isArray(rawDetailFiles) ? rawDetailFiles : undefined;
    if (detailFiles && detailFiles.length > 0) {
      for (const file of detailFiles) {
        if (!file.ok) continue;
        try {
          const resolvedPath = resolve(toolCwd, file.path);
          const content = (await fsReadFile(resolvedPath)).toString("utf-8");
          if (content) {
            const isPartial = file.inclusion !== "full";
            const lines = content.split("\n");
            const hashline = smartEditRuntimeConfig.useHashlineEditing
              ? await buildHashlineAnchors(lines)
              : undefined;
            recordRead(file.path, toolCwd, content, isPartial, hashline);
            recordReadSession(file.path, toolCwd, 1, -1, lines.length, "intent_read");
          }
        } catch {
          // File may not exist or can't be read — skip silently
        }
      }
    }
  } catch {
    /* silently ignore cache population errors */
  }
}

/**
 * Shared single-file read+record+validation helper, hoisted out of the
 * tool_result callback (used by the write post-processing path).
 */
async function validateFileAndBuildFeedback(
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
async function refreshReadCacheAfterEdit(filePath: string, cwd: string): Promise<void> {
  const resolvedPath = resolve(cwd, filePath);
  const content = (await fsReadFile(resolvedPath)).toString("utf-8");
  recordRead(filePath, cwd, content);
  const lines = content.split("\n");
  recordReadSession(filePath, cwd, 1, -1, lines.length, "edit");
}

/** tool_result seam: write diagnostics lane (awaited + returned, not fire-and-forget). */
async function handleWriteResult(
  event: { toolName?: string; isError?: boolean; input?: unknown; content?: unknown; details?: unknown },
  toolCwd: string,
  buildMutationEvidence: (paths: string[]) => Promise<WorkspaceEvidenceEnvelope | undefined>,
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
async function handleEditRetryResult(
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
async function handleEditSuccessResult(
  event: { toolName?: string; isError?: boolean; content?: unknown; details?: unknown },
  toolCwd: string,
  buildMutationEvidence: (paths: string[]) => Promise<WorkspaceEvidenceEnvelope | undefined>,
  store: PriorAuthorityStore | null,
): Promise<{ content: ToolResultEvent["content"]; details: unknown } | undefined> {
  if (
    event.toolName !== "edit" ||
    event.isError
  ) {
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
    const workspaceEvidence = await buildMutationEvidence(uniquePaths);
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

type FinalLaneFile = {
  readonly path: string;
  readonly content: string;
  readonly oldContent: string;
  readonly changedLineRanges: ReadonlyArray<{ readonly startLine: number; readonly endLine: number }>;
};

type FinalLaneContext = {
  cwd: string;
  diagnostics: string[];
  checks: Array<{ id: string; outcome: "pass" | "fail" | "skipped" | "timeout"; detail?: string }>;
  evidence: unknown[];
  editedPaths: string[];
  lspManager: LSPManager | null;
  diagnosticsClient: ReturnType<typeof createSmartReadDiagnosticsClient> | null;
};

/** runFinalSuccessLanes seam: per-file diagnostics + evidence finalization. */
async function runSingleFileFinalLanes(file: FinalLaneFile, ctx: FinalLaneContext): Promise<void> {
  const languageId = detectLanguageFromExtension(file.path);
  if (!languageId) {
    ctx.checks.push({ id: `diagnostics:${file.path}`, outcome: "skipped", detail: "no language diagnostic lane" });
    return;
  }
  let lspConfirmed = false;
  if (ctx.lspManager) {
    const lsp = ctx.diagnosticsClient
      ? await ctx.diagnosticsClient.checkPostEditDiagnostics(file.path, file.content, languageId, ctx.cwd, ctx.lspManager)
      : await checkPostEditDiagnostics(file.path, file.content, languageId, ctx.lspManager);
    if (lsp.status === "confirmed") {
      lspConfirmed = true;
      const lspHasError = lsp.diagnostics.some((d) => d.severity === 1);
      ctx.checks.push({ id: `lsp:${file.path}`, outcome: lspHasError ? "fail" : "pass", detail: `${lsp.diagnostics.length} diagnostic(s), ${lsp.source}, ${lsp.status}` });
      ctx.diagnostics.push(...lsp.diagnostics.map((d) => `lsp ${file.path}:${d.range.start.line + 1}: ${d.message}`));
    } else {
      ctx.checks.push({ id: `lsp:${file.path}`, outcome: "skipped", detail: `${lsp.diagnostics.length} diagnostic(s), ${lsp.source}, ${lsp.status}` });
    }
  }
  const compiler = !lspConfirmed ? getCompilerForLanguage(languageId) : null;
  if (compiler) {
    const result = await compiler(file.path, ctx.cwd);
    const compilerHasError = result.diagnostics.some((d) => d.severity === 1);
    ctx.checks.push({ id: `compiler:${file.path}`, outcome: compilerHasError ? "fail" : "pass", detail: `${result.diagnostics.length} diagnostic(s), ${result.source}` });
    ctx.diagnostics.push(...result.diagnostics.map((d) => `${d.source} ${file.path}:${d.range.start.line + 1}: ${d.message}`));
    for (const diagnostic of result.diagnostics) {
      if (!diagnostic.filePath) continue;
      let canonicalDiagPath: string;
      try {
        canonicalDiagPath = realpathSync(resolve(ctx.cwd, diagnostic.filePath));
      } catch {
        canonicalDiagPath = resolve(ctx.cwd, diagnostic.filePath);
      }
      if (canonicalDiagPath !== file.path) {
        const bridgeError = recordBreakage(ctx.cwd, file.path, canonicalDiagPath, diagnostic.message);
        if (bridgeError) ctx.diagnostics.push(bridgeError);
      }
    }
  }
  const post = await runPostEditEvidencePipeline({
    cwd: ctx.cwd,
    path: file.path,
    content: file.content,
    oldContent: file.oldContent,
    languageId,
    matchSpans: file.changedLineRanges.map((range) => lineRangeToOffsets(file.content, range)),
    editedPaths: ctx.editedPaths,
    lspManager: ctx.lspManager as unknown as { getServer(languageId: string): unknown } | null,
    config: { repair: { enabled: false, maxRetries: 0, autoRepair: false, notifyOnRetry: false } },
  });
  ctx.evidence.push(post);
  ctx.diagnostics.push(...post.notes);
}

/** runFinalSuccessLanes seam: pairwise co-change recording. */
function recordFileCoChanges(files: readonly FinalLaneFile[], cwd: string, diagnostics: string[]): void {
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const bridgeError = recordCoChange(cwd, files[i].path, files[j].path, "committed in one SmartEdit transaction");
      if (bridgeError) diagnostics.push(bridgeError);
    }
  }
}


// ─── Extension entry point ──────────────────────────────────────────

export default function smartEdit(pi: ExtensionAPI) {
  /** Per-extension, per-session authority; never shared across Pi instances. */
  let priorAuthorityStore: PriorAuthorityStore | null = null;
  let currentSessionFilePath: string | null = null;
  let currentCanonicalWorkspaceRoot: string | null = null;
  let currentCwd: string | null = null;

  const buildMutationEvidence = async (paths: string[]): Promise<WorkspaceEvidenceEnvelope | undefined> => {
    if (!currentSessionFilePath || !currentCanonicalWorkspaceRoot) return undefined;
    const resources: Array<WorkspaceEvidenceEnvelope["resources"][number]> = [];
    for (const path of [...new Set(paths)]) {
      try {
        const resolvedPath = resolve(currentCwd ?? process.cwd(), path);
        const canonicalPath = realpathSync(resolvedPath);
        // Evidence-provenance containment: only mint evidence for paths inside the canonical workspace root.
        // Mutations to outside paths still succeed — they simply get no workspaceEvidence.
        // Use path.relative for containment: root "/" must still match /tmp/x.ts, and
        // /workspace-evil must NOT match root /workspace. relative() returns "" for
        // identity, a bare name for children, or "../.." for outside — only reject the last.
        if (relative(currentCanonicalWorkspaceRoot, canonicalPath).startsWith("..")) continue;
        if (!statSync(canonicalPath).isFile()) continue;
        const content = (await fsReadFile(canonicalPath)).toString("utf8");
        const lineCount = content.split("\n").length;
        resources.push({
          resourceId: resourceIdFor({ canonicalPath, kind: "full" }),
          canonicalPath,
          kind: "full",
          coverage: "full-file",
          allowedRanges: [{ startLine: 1, endLine: lineCount }],
          fullFileSha256: sha256OfString(content),
          fresh: true,
          byteLength: Buffer.byteLength(content, "utf8"),
          lineCount,
        });
      } catch {
        // Evidence is advisory; unreadable or deleted paths are omitted.
      }
    }
    if (resources.length === 0) return undefined;
    const sessionId = hashSessionFilePath(currentSessionFilePath);
    return {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      inspectionId: inspectionIdFor({
        sessionId,
        workspaceRoot: currentCanonicalWorkspaceRoot,
        resources: resources.map((resource) => ({ canonicalPath: resource.canonicalPath })),
      }),
      sessionId,
      workspaceRoot: currentCanonicalWorkspaceRoot,
      canonicalWorkspaceRoot: currentCanonicalWorkspaceRoot,
      createdAt: new Date().toISOString(),
      resources,
      mode: "path",
    };
  };

  const buildRetryEvidence = async (
    event: { input?: unknown; details?: unknown; content?: unknown; isError?: boolean; toolName?: string },
    cwd: string,
  ): Promise<{ envelope: WorkspaceEvidenceEnvelope; text: string } | undefined> => {
    const retryState = {
      sessionFilePath: currentSessionFilePath,
      canonicalWorkspaceRoot: currentCanonicalWorkspaceRoot,
      priorAuthority: priorAuthorityStore,
    };
    const eligible = await checkRetryEligibility(event, cwd, retryState);
    if (!eligible) return undefined;
    const ranges = collectRetryWindows(eligible.content, eligible.explicitRange, eligible.matchFailure, eligible.oldText);
    if (!ranges) return undefined;
    const unique = authorizeRetryWindows(eligible.resource, ranges);
    const selected = applyRetryBudget(unique, eligible.content.split("\n"));
    if (!selected) return undefined;
    retryState.sessionFilePath = currentSessionFilePath;
    retryState.canonicalWorkspaceRoot = currentCanonicalWorkspaceRoot;
    return mintRetryEvidenceFromSelection(selected, eligible.canonicalPath, eligible.sha, retryState);
  };

  // ── Claim post-mutation diagnostics ownership for write/edit ──
  // SmartRead's fallback checks isDiagnosticsClaimed() on tool_result and
  // skips its own diagnostics collection when this extension has claimed the
  // toolCallId, regardless of extension load order (see mutation-ownership.ts).
  pi.on("tool_call", (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      claimDiagnosticsOwner(event.toolCallId);
    }
    return undefined;
  });

  // ── Populate read cache on every successful read ──
  pi.on("tool_result", async (event, _ctx) => {
    const toolCwd = process.cwd();

    // Release the claim on a failed mutation — SmartEdit only owns
    // diagnostics for mutations that actually succeeded.
    releaseClaimOnFailedMutation(event);

    // ── Ingest SmartRead workspace evidence into prior authority store ──
    // Tool-owned evidence policy B: validated `details.workspaceEvidence`
    // envelopes are recorded as they arrive; the store indexes the latest
    // strong resource per canonical path and ignores weak evidence.
    ingestWorkspaceEvidence(event, priorAuthorityStore);

    // ── Populate read cache for SmartRead single `read` results ──
    // Delegated to handleSingleReadResult (file-local); the single-read
    // early return is preserved via its boolean result.
    if (await handleSingleReadResult(event, toolCwd)) return;

    // ── Track read_files results ──
    // Delegated to handleMultiReadResult (file-local).
    await handleMultiReadResult(event, toolCwd);

    // ── Track intent_read results ──
    // Delegated to handleIntentReadResult (file-local).
    await handleIntentReadResult(event, toolCwd);

    // ── Track writes so write-then-edit flow doesn't trigger stale-file guard ──
    // Delegated to handleWriteResult (file-local); awaited + returned as before.
    const writeResult = await handleWriteResult(event, toolCwd, buildMutationEvidence, priorAuthorityStore);
    if (writeResult) return writeResult;

    // Failed classic-text matches may return narrowly authorized retry context.
    // Delegated to handleEditRetryResult (file-local).
    const retryResult = await handleEditRetryResult(event, toolCwd, buildRetryEvidence, priorAuthorityStore);
    if (retryResult) return retryResult;

    // ── Track edits so edit-then-edit flow doesn't trigger stale-file guard ──
    //
    // This branch used to also run a second, fully independent
    // runAutoValidation pass per edited file (compiler + eslint + fake-logic
    // + structural-diff + format-equivalence), mirroring the write path's
    // advisory hook. For the `edit` tool that pass was pure duplicate work:
    //
    //   1. The edit tool already runs the SAME runAutoValidation pipeline
    //      synchronously, pre-write, via the repair loop (patch.ts's
    //      deps.runRepair -> runRepairLoop -> runAutoValidation).
    //   2. The edit tool also runs LSP + compiler diagnostics synchronously,
    //      post-write, via deps.runFinalSuccessLanes (see below in this
    //      file), whose results are returned in the tool's own `details`.
    //   3. This handler's mutations to `event.validationFeedback` /
    //      `validationRetries` / `shouldDecompose` were never actually
    //      consumed anywhere: nothing in this repo reads them, and the
    //      pi-coding-agent extension runner's emitToolResult only honors a
    //      tool_result handler's RETURN value (content/details/isError) —
    //      never later mutations to the event object passed in — and this
    //      handler never returns anything. The fire-and-forget promise chain
    //      (not awaited before the handler resolves) also races the
    //      framework reading the event, so even a returned value would be
    //      too late.
    //
    // So the second validation pass cost a real tsc/eslint subprocess spawn
    // on every edit for zero observable benefit. Only the read-cache refresh
    // (needed so a later edit to the same file doesn't trip the stale-file
    // guard) is preserved here; see refreshReadCacheAfterEdit above.
    //
    // The `write` tool's diagnostics lane above is unrelated: it is the only
    // diagnostic lane for `write`, so no duplication applies.
    // Delegated to handleEditSuccessResult (file-local); only the
    // read-cache refresh + evidence mint below is preserved (see comment above).
    const editResult = await handleEditSuccessResult(event, toolCwd, buildMutationEvidence, priorAuthorityStore);
    if (editResult) return editResult;
  });

  // ── Initialize per-session state ──

  pi.on("session_start", async (_event, ctx) => {
    const sessionCwd = process.cwd();
    currentCwd = sessionCwd;
    // Create AST resolver (returns null if Tree-sitter unavailable)
    astResolver = createAstResolver();

    // Create LSP manager for semantic intelligence
    lspManager = new LSPManager(sessionCwd);
    // Create SmartRead diagnostics client (lazy probe, sticky mode)
    if (pi.events && typeof (pi.events as { on?: unknown }).on === "function") {
      const b = pi.events as { emit: (c: string, d: unknown) => void; on: (c: string, h: (d: unknown) => void) => () => void };
      smartReadDiagnosticsClient = createSmartReadDiagnosticsClient(b);
    }

    resetRetryCounts();

    // Capture the real session file path and canonical workspace root.
    // We require a REAL (non-ephemeral) session file for `patch` authorization.
    try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined)
        ?.sessionManager;
      const p = typeof sm?.getSessionFile === "function" ? sm.getSessionFile() : undefined;
      currentSessionFilePath = typeof p === "string" && p.length > 0 ? p : null;
    } catch {
      currentSessionFilePath = null;
    }
    try {
      // canonical workspace root = realpath of cwd, no trailing slash
      const { realpathSync } = await import("node:fs");
      let r = realpathSync(sessionCwd);
      if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
      currentCanonicalWorkspaceRoot = r;
    } catch {
      currentCanonicalWorkspaceRoot = null;
    }

    // Create the per-session prior-authority store bound to this session.
    priorAuthorityStore = createPriorAuthorityStore({
      sessionFilePath: currentSessionFilePath ?? "",
      canonicalWorkspaceRoot: currentCanonicalWorkspaceRoot ?? "",
    });
  });

  // ── Shutdown on session end ──
  pi.on("session_shutdown", async () => {
    smartReadDiagnosticsClient?.dispose();
    smartReadDiagnosticsClient = null;
    await lspManager?.shutdown();
    lspManager = null;
    priorAuthorityStore?.clear();
    priorAuthorityStore = null;
  });


  // ── Register `edit` tool (overrides native built-in edit) ──
  // v3: workspace-evidence gated. Uses patch implementation under the hood.
  // Rejects ephemeral session identity.
  if (pi.events && typeof pi.events.on === "function") {
    const bus = pi.events as {
      emit: (c: string, d: unknown) => void;
      on: (c: string, h: (d: unknown) => void) => () => void;
    };
    const patchDeps: PatchToolDeps = {
      getBus: () => bus,
      getRpcClient: () => createRpcClient({ bus, channel: RPC_CHANNELS.inspectPatch, timeoutMs: 2000 }),
      getSessionFilePath: () => currentSessionFilePath,
      getCanonicalWorkspaceRoot: () => currentCanonicalWorkspaceRoot ?? "",
      getPriorAuthority: () => priorAuthorityStore,
      getAstResolver: () => astResolver,
      getSnapshot: (path) => (currentCwd ? getSnapshot(path, currentCwd) : null),
      // The coordinator owns acceptance and evidence reauthorization; the
      // extension only supplies the session-bound repair implementation.
      //
      // maxRetries is capped at 1 here (runRepairLoop's own default is 3).
      // runRepairLoop only advances its staged content when a repair attempt
      // actually passes validation — and when that happens it breaks out of
      // the loop immediately. So whenever the first attempt fails and the
      // narrow auto-repair heuristics (brace/bracket balance, indentation,
      // trailing whitespace, blank lines) don't fix it, every subsequent
      // retry re-validates byte-identical content and is guaranteed to
      // reach the same pass/fail outcome — it cannot converge differently.
      // Each retry still pays for a full runAutoValidation pass (a real
      // tsc/eslint subprocess spawn apiece), so the default of 3 retries
      // means up to 3x redundant compiler/linter spawns, synchronously,
      // before the edit is even written. Repair is advisory-only (failures
      // never block the write — see repair-loop.ts), so capping retries at
      // 1 does not change what gets accepted or what content lands on disk;
      // it only removes provably-wasted synchronous spawns on the hot path.
      runRepair: ({ path, content, cwd }) => runRepairLoop(path, content, { maxRetries: 1 }, cwd),
      // These lanes are invoked by patch only after a successful commit.  The
      // extension supplies session-owned LSP state; the coordinator owns the
      // ordering and result assembly.
      runFinalSuccessLanes: async ({ cwd, files }) => {
        const diagnostics: string[] = [];
        const checks: Array<{ id: string; outcome: "pass" | "fail" | "skipped" | "timeout"; detail?: string }> = [];
        const evidence: unknown[] = [];
        for (const file of files) {
          await runSingleFileFinalLanes(file, {
            cwd, diagnostics, checks, evidence,
            editedPaths: files.map((entry) => entry.path),
            lspManager, diagnosticsClient: smartReadDiagnosticsClient,
          });
        }
        recordFileCoChanges(files, cwd, diagnostics);
        return { diagnostics, checks, evidence };
      },
    };
    const patchTool = createPatchTool(patchDeps);
    (pi.registerTool as (t: unknown) => void)({
      ...patchTool,
      name: "edit",
      label: "edit",
      // Canonical schema (EDIT_PARAMETERS) already omits `evidenceRef`; the
      // tool-level description above is the single canonical description.
      parameters: patchTool.parameters,
      renderShell: "self",
      renderCall: renderEditCall,
      renderResult: renderEditResult,

      async execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: ((u: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
        ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown },
      ) {
        const result = await patchTool.execute(
          toolCallId,
          omitAgentEvidenceRef(params),
          signal,
          onUpdate,
          ctx,
        );
        const reason = result.details?.status?.kind === "rejected" ? result.details.status.reason : undefined;
        const hasLineRangeFailure = reason === "coverage" && result.details.diagnostics.some(
          (diagnostic) => diagnostic.includes("outside allowedRanges"),
        );
        const note = reason === "stale"
          ? "\n\nNot applied: file changed since last read. Read the file again, then retry."
          : hasLineRangeFailure
            ? "\n\nNot applied: exact target lines were not detected as read. Read those lines, then retry."
            : reason === "coverage"
              ? "\n\nNot applied: required file coverage was unavailable. Read the file (full file or target lines), then retry."
              : "";
        return note
          ? { ...result, content: appendDiagnosticsToContent(result.content, note) as typeof result.content }
          : result;
      },

      // Compatibility shim for resumed sessions with stored `edit` calls
      // using flat oldText/newText instead of edits array.
      prepareArguments(args: Record<string, unknown> | undefined): Record<string, unknown> {
        if (!args || typeof args !== "object") return args ?? {};
        const toolOwnedArgs = omitAgentEvidenceRef(args);
        // Migrate flat single oldText/newText to edits array via the canonical
        // contract normalizer (flat fields are authoritative).
        return normalizeFlatEditRequest(toolOwnedArgs);
      },
    } as unknown);
  }
}

// ── Exports for testing ─────────────────────────────────────────────
// These are used by test/error-handling.test.ts only.
// At runtime, only the default export is consumed by Pi.
export {
  prepareArguments,
  formatEditError,
  validateInput,
};
