import { readFile as fsReadFile } from "fs/promises";
import { resolve } from "path";

import { recordRead, recordReadSession } from "../context/read-cache";
import {
  buildHashlineAnchors,
  HASHLINE_BIGRAM_RE_SRC,
  HASHLINE_CONTENT_SEPARATOR,
} from "../hashline/hashline";
import { getSmartEditRuntimeConfig } from "../config/edit-mode";
import { releaseDiagnosticsOwner } from "../mutation/mutation-ownership.js";
import { isMutationTool } from "../mutation/types.js";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";

const smartEditRuntimeConfig = getSmartEditRuntimeConfig();

type HashlineSnapshotData = Awaited<ReturnType<typeof buildHashlineAnchors>>;

const DISPLAYED_HASHLINE_ROW_RE = new RegExp(
  `^\\s*(?:>>>|>>)?\\s*(\\d+${HASHLINE_BIGRAM_RE_SRC})\\${HASHLINE_CONTENT_SEPARATOR}(.*)$`,
);

export interface DisplayedHashlineRows {
  hashline: HashlineSnapshotData;
  lineNumbers: number[];
}

/**
 * Extract the exact LINE+ID tokens the model actually saw from SmartRead's
 * rendered response. The response may be wrapped in @path/PINE envelope lines;
 * only canonical hashline rows are retained.
 *
 * When rawContent is provided, rows whose displayed text does not equal the
 * corresponding raw file line are discarded. That prevents a raced or
 * malformed tool result from becoming recovery authority.
 */
export function parseDisplayedHashlineRows(
  renderedText: string,
  rawContent?: string,
): DisplayedHashlineRows | null {
  const rawLines = rawContent === undefined ? null : rawContent.replace(/\r/g, "").split("\n");
  const anchors = new Map<string, { text: string; line: number }>();
  const formattedLines: string[] = [];
  const lineNumbers: number[] = [];

  for (const renderedLine of renderedText.replace(/\r/g, "").split("\n")) {
    const match = DISPLAYED_HASHLINE_ROW_RE.exec(renderedLine);
    if (!match) continue;

    const token = match[1];
    const text = match[2] ?? "";
    const lineMatch = /^(\d+)/.exec(token);
    if (!lineMatch) continue;
    const line = Number(lineMatch[1]);
    if (!Number.isSafeInteger(line) || line < 1) continue;

    if (rawLines && rawLines[line - 1] !== text) continue;
    anchors.set(token, { text, line });
    formattedLines.push(`${token}${HASHLINE_CONTENT_SEPARATOR}${text}`);
    lineNumbers.push(line);
  }

  if (anchors.size === 0) return null;
  return { hashline: { anchors, formattedLines }, lineNumbers };
}

function coversWholeFile(rows: DisplayedHashlineRows | null, totalLines: number): boolean {
  if (!rows || rows.lineNumbers.length !== totalLines) return false;
  const seen = new Set(rows.lineNumbers);
  if (seen.size !== totalLines) return false;
  for (let line = 1; line <= totalLines; line++) {
    if (!seen.has(line)) return false;
  }
  return true;
}

export function coerceText(value: unknown): string {
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

/** tool_result seam: release diagnostics claim on failed mutation. */
export function releaseClaimOnFailedMutation(event: { toolName?: string; isError?: boolean; toolCallId: string }): void {
  if (isMutationTool(event.toolName) && event.isError) {
    releaseDiagnosticsOwner(event.toolCallId);
  }
}

/** tool_result seam: ingest SmartRead workspace evidence into prior authority store. */
export function ingestWorkspaceEvidence(
  event: { toolName?: string; isError?: boolean; details?: unknown },
  store: PriorAuthorityStore | null,
): void {
  try {
    const wsEvidence = (event.toolName === "read" ||
      event.toolName === "read_files" ||
      event.toolName === "read_multiple_files" ||
      event.toolName === "intent_read") && !event.isError
      ? (event.details as { workspaceEvidence?: unknown } | undefined)?.workspaceEvidence
      : undefined;
    if (wsEvidence) {
      store?.record(wsEvidence);
    }
  } catch {
    /* silently ignore evidence ingestion errors */
  }
}

export type SingleReadInput = { path?: string; offset?: number; limit?: number };

/** tool_result single-read seam: offset/limit (partial) branch. */
export async function recordOffsetLimitSingleRead(
  input: SingleReadInput,
  toolCwd: string,
  inputPath: string,
  renderedText: string,
): Promise<void> {
  const readOffset = input?.offset ?? 1;
  let rawContent = renderedText;
  try {
    rawContent = (await fsReadFile(resolve(toolCwd, inputPath))).toString("utf-8");
  } catch {
    // Keep the rendered fallback; this snapshot remains partial/fail-closed.
  }

  const rawLines = rawContent.replace(/\r/g, "").split("\n");
  const displayed = parseDisplayedHashlineRows(renderedText, rawContent);

  // Partial reads retain raw bytes for freshness, but hashline provenance is
  // restricted to the exact rows the model actually saw.
  recordRead(inputPath, toolCwd, rawContent, true, displayed?.hashline, readOffset);

  const explicitLimit = input?.limit;
  const totalFileLines = rawLines.length;
  recordReadSession(
    inputPath,
    toolCwd,
    readOffset,
    explicitLimit ?? -1,
    totalFileLines,
    "read",
  );
}

/** tool_result single-read seam: full (possibly truncated) branch. */
export async function recordCompleteSingleRead(
  toolCwd: string,
  inputPath: string,
  renderedText: string,
): Promise<void> {
  let rawContent = renderedText;
  let rawReadSucceeded = false;
  try {
    rawContent = (await fsReadFile(resolve(toolCwd, inputPath))).toString("utf-8");
    rawReadSucceeded = true;
  } catch {
    // Fall back to rendered text, but mark the snapshot partial below.
  }

  const rawLines = rawContent.replace(/\r/g, "").split("\n");
  const displayed = parseDisplayedHashlineRows(
    renderedText,
    rawReadSucceeded ? rawContent : undefined,
  );

  // A "full" SmartRead call can still truncate its presentation. Only mark the
  // cache complete when every raw file line was actually displayed. This keeps
  // provenance scoped to observed rows while freshness hashes the real bytes.
  const isTruncated = !rawReadSucceeded || (
    displayed
      ? !coversWholeFile(displayed, rawLines.length)
      : renderedText !== rawContent
  );

  const hashline = displayed?.hashline ?? (
    smartEditRuntimeConfig.useHashlineEditing && !isTruncated && renderedText === rawContent
      ? await buildHashlineAnchors(rawLines)
      : undefined
  );

  recordRead(inputPath, toolCwd, rawContent, isTruncated, hashline);
  recordReadSession(inputPath, toolCwd, 1, isTruncated ? (displayed?.lineNumbers.length ?? -1) : -1, rawLines.length, "read");
}

/**
 * tool_result seam: single-read cache population.
 * Returns true when the event was a single read (caller preserves the
 * original early return after the offset/limit branch).
 */
export async function handleSingleReadResult(
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
export async function handleMultiReadResult(
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
export async function handleIntentReadResult(
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
