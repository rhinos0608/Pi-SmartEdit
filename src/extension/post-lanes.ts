import { readFile as fsReadFile } from "fs/promises";
import { resolve } from "path";

import type { ToolResultEvent } from "@mariozechner/pi-coding-agent";
import type { WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";

import { recordRead, recordReadSession } from "../context/read-cache";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";
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

/** tool_result seam: write diagnostics lane (awaited + returned, not fire-and-forget). */
export async function handleWriteResult(
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
