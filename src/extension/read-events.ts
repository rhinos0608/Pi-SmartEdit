import { statSync } from "fs";
import { readFile as fsReadFile } from "fs/promises";
import { resolve } from "path";

import { recordRead, recordReadSession, getSnapshot } from "../context/read-cache";
import { buildHashlineAnchors } from "../hashline/hashline";
import { getSmartEditRuntimeConfig } from "../config/edit-mode";
import { releaseDiagnosticsOwner } from "../mutation/mutation-ownership.js";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";

const smartEditRuntimeConfig = getSmartEditRuntimeConfig();

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
  if (
    (event.toolName === "write" || event.toolName === "edit") &&
    event.isError
  ) {
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
      event.toolName === "read_multiple_files") && !event.isError
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
export async function recordCompleteSingleRead(toolCwd: string, inputPath: string, fullText: string): Promise<void> {
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
