import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";

import { appendDiagnosticsToContent } from "../mutation/post-mutation.js";
import { createPatchTool } from "../patch.js";
import { getActiveEditMode } from "../edit-modes/index.js";
import { buildPatchToolDeps } from "./patch-deps.js";
import { loadConfig } from "../config/schema.js";
import { renderEditCall, renderEditResult } from "./render.js";
import {
  applyRetryBudget,
  authorizeRetryWindows,
  checkRetryEligibility,
  collectRetryWindows,
  mintRetryEvidenceFromSelection,
} from "./retry-evidence.js";
import type { SessionState } from "./session.js";
function omitAgentEvidenceRef(args: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(args, "evidenceRef")) return args;
  const { evidenceRef: _ignored, ...toolOwnedArgs } = args;
  return toolOwnedArgs;
}

export type RetryEvidenceEvent = {
  input?: unknown;
  details?: unknown;
  content?: unknown;
  isError?: boolean;
  toolName?: string;
};

/** buildRetryEvidence closure body, moved verbatim from src/index.ts (M8 final). */
export async function buildRetryEvidenceForSession(
  session: SessionState,
  event: RetryEvidenceEvent,
  cwd: string,
): Promise<{ envelope: WorkspaceEvidenceEnvelope; text: string } | undefined> {
  const retryState = {
    sessionFilePath: session.currentSessionFilePath,
    canonicalWorkspaceRoot: session.currentCanonicalWorkspaceRoot,
    priorAuthority: session.priorAuthorityStore,
  };
  const eligible = await checkRetryEligibility(event, cwd, retryState);
  if (!eligible) return undefined;
  const ranges = collectRetryWindows(eligible.content, eligible.explicitRange, eligible.matchFailure, eligible.oldText);
  if (!ranges) return undefined;
  const unique = authorizeRetryWindows(eligible.resource, ranges);
  const selected = applyRetryBudget(unique, eligible.content.split("\n"));
  if (!selected) return undefined;
  retryState.sessionFilePath = session.currentSessionFilePath;
  retryState.canonicalWorkspaceRoot = session.currentCanonicalWorkspaceRoot;
  return mintRetryEvidenceFromSelection(selected, eligible.canonicalPath, eligible.sha, retryState);
}

let editModeWarningEmitted = false;

/** `edit` tool registration, moved verbatim from src/index.ts (M8 final). */
export function registerEditTool(pi: ExtensionAPI, session: SessionState): void {
  const buildRetryEvidence = (
    event: RetryEvidenceEvent,
    cwd: string,
  ): Promise<{ envelope: WorkspaceEvidenceEnvelope; text: string } | undefined> =>
    buildRetryEvidenceForSession(session, event, cwd);

  // ── Register `edit` tool (overrides native built-in edit) ──
  // v3: workspace-evidence gated. Uses patch implementation under the hood.
  // Rejects ephemeral session identity.
  if (pi.events && typeof pi.events.on === "function") {
    const bus = pi.events as {
      emit: (c: string, d: unknown) => void;
      on: (c: string, h: (d: unknown) => void) => () => void;
    };
    const config = loadConfig();
    // Surface an invalid-PI_EDIT_MODE warning once; no existing config
    // warning channel exists at registration, so console.warn is the seam.
    if (config.editModeWarning && !editModeWarningEmitted) {
      editModeWarningEmitted = true;
      console.warn(config.editModeWarning);
    }
    const editMode = getActiveEditMode();
    const patchDeps = buildPatchToolDeps(session, bus);
    const patchTool = createPatchTool(patchDeps);
    (pi.registerTool as (t: unknown) => void)({
      ...patchTool,
      name: "edit",
      label: "edit",
      // Schema and description come from the active edit mode spec, which
      // omits `evidenceRef` (authority is tool-owned).
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
        const toolOwnedParams = omitAgentEvidenceRef(params);
        const loopBlocked = session.mutationLoopGuard.preflight("edit", toolOwnedParams, toolCallId);
        if (loopBlocked) return loopBlocked;
        const result = session.mutationLoopGuard.observe(
          "edit",
          toolOwnedParams,
          await patchTool.execute(
            toolCallId,
            toolOwnedParams,
            signal,
            onUpdate,
            ctx,
          ),
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
        // Classic mode keeps the resumed-session compatibility shim. In
        // hashline-only mode, oldText/newText is deliberately not migrated:
        // the active protocol is exclusive and runtime validation rejects it.
        return editMode.prepareArguments(toolOwnedArgs);
      },
    } as unknown);
  }
}
