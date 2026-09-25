import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  createRpcClient,
  RPC_CHANNELS,
  type WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";

import { getSnapshot } from "../context/read-cache";
import { runRepairLoop } from "../verification/repair-loop";
import { appendDiagnosticsToContent } from "../mutation/post-mutation.js";
import { createPatchTool, type PatchToolDeps } from "../patch.js";
import { normalizeFlatEditRequest } from "../edit-contract.js";
import { loadConfig } from "../config/schema.js";
import { renderEditCall, renderEditResult } from "./render.js";
import {
  applyRetryBudget,
  authorizeRetryWindows,
  checkRetryEligibility,
  collectRetryWindows,
  mintRetryEvidenceFromSelection,
} from "./retry-evidence.js";
import {
  runSingleFileFinalLanes,
  recordFileCoChanges,
} from "./final-lanes.js";
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
    const useHashlineEditing = loadConfig().useHashlineEditing;
    const patchDeps: PatchToolDeps = {
      useHashlineEditing,
      getBus: () => bus,
      getRpcClient: () => createRpcClient({ bus, channel: RPC_CHANNELS.inspectPatch, timeoutMs: 2000 }),
      getSessionFilePath: () => session.currentSessionFilePath,
      getCanonicalWorkspaceRoot: () => session.currentCanonicalWorkspaceRoot ?? "",
      getPriorAuthority: () => session.priorAuthorityStore,
      getAstResolver: () => session.astResolver,
      getSnapshot: (path) => (session.currentCwd ? getSnapshot(path, session.currentCwd) : null),
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
            lspManager: session.lspManager, diagnosticsClient: session.smartReadDiagnosticsClient,
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
        return useHashlineEditing ? toolOwnedArgs : normalizeFlatEditRequest(toolOwnedArgs);
      },
    } as unknown);
  }
}
