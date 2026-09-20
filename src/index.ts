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

import { sortHashlineEditsForApplication, formatHashlineBatchSummary } from "./hashline/hashline-batching.js";
import {
  prepareArguments,
  validateInput,
  formatEditError,
} from "./args.js";
import { claimDiagnosticsOwner } from "./mutation/mutation-ownership.js";
import { isMutationTool } from "./mutation/types.js";
import type { WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";

// ─── Schema ───────────────────────────────────────────────────────
// The canonical edit request schema lives in src/edit-contract.ts
// (EDIT_PARAMETERS) and is the single registration source. Rich edit
// metadata is validated there.


export { resolveEditPath } from "./extension/paths.js";

export {
  renderEditCall,
  renderEditResult,
  getEditDisplayPaths,
  getRawEditDisplayPaths,
  renderEditDiff,
  EditTextComponent,
} from "./extension/render.js";
export type { EditRenderArgs, EditRenderResult } from "./extension/render.js";

export { combineMultiFileEditResults } from "./extension/combine.js";
import {
  handleIntentReadResult,
  handleMultiReadResult,
  handleSingleReadResult,
  ingestWorkspaceEvidence,
  releaseClaimOnFailedMutation,
} from "./extension/read-events.js";
export type { ToolEditResult } from "./extension/combine.js";






import {
  createSessionState,
  initSessionState,
  shutdownSessionState,
  buildMutationEvidence as buildSessionMutationEvidence,
} from "./extension/session.js";

/**
 * Compute the containing line range for a set of edits from their oldText.
 * Returns [startLine, endLine] (1-based) or null if oldText can't be located.
 *
 * Used by the range coverage guard to validate that edit targets fall within
 * lines that were actually read this session.
 */


export { sortHashlineEditsForApplication, formatHashlineBatchSummary };

import {
  validateFileAndBuildFeedback,
  refreshReadCacheAfterEdit,
  handleWriteResult,
  handleEditRetryResult,
  handleEditSuccessResult,
  type NarrowHintsByPath,
} from "./extension/post-lanes.js";

import { registerTransferTool } from "./extension/register-transfer.js";
import {
  registerEditTool,
  buildRetryEvidenceForSession,
  type RetryEvidenceEvent,
} from "./extension/register-edit.js";

// ─── Extension entry point ──────────────────────────────────────────

export default function smartEdit(pi: ExtensionAPI) {
  /** Per-extension, per-session state (singletons consolidated in ./extension/session.js). */
  const session = createSessionState();

  const buildMutationEvidence = (
    paths: string[],
    narrowHints?: NarrowHintsByPath,
  ): Promise<WorkspaceEvidenceEnvelope | undefined> =>
    buildSessionMutationEvidence(session, paths, narrowHints);

  const buildRetryEvidence = (
    event: RetryEvidenceEvent,
    cwd: string,
  ): Promise<{ envelope: WorkspaceEvidenceEnvelope; text: string } | undefined> =>
    buildRetryEvidenceForSession(session, event, cwd);

  // ── Claim post-mutation diagnostics ownership for write/edit ──
  // SmartRead's fallback checks isDiagnosticsClaimed() on tool_result and
  // skips its own diagnostics collection when this extension has claimed the
  // toolCallId, regardless of extension load order (see ./mutation/mutation-ownership.js).
  pi.on("tool_call", (event) => {
    if (isMutationTool(event.toolName)) {
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
    ingestWorkspaceEvidence(event, session.priorAuthorityStore);

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
    const writeResult = await handleWriteResult(event, toolCwd, buildMutationEvidence, session.priorAuthorityStore);
    if (writeResult) return writeResult;

    // Failed classic-text matches may return narrowly authorized retry context.
    // Delegated to handleEditRetryResult (file-local).
    const retryResult = await handleEditRetryResult(event, toolCwd, buildRetryEvidence, session.priorAuthorityStore);
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
    const editResult = await handleEditSuccessResult(event, toolCwd, buildMutationEvidence, session.priorAuthorityStore);
    if (editResult) return editResult;
  });

  // ── Initialize per-session state ──

  pi.on("session_start", async (_event, ctx) => {
    await initSessionState(session, pi, ctx);
  });

  // ── Shutdown on session end ──
  pi.on("session_shutdown", async () => {
    await shutdownSessionState(session);
  });


  // ── Register `edit` tool (overrides native built-in edit) ──
  // Registration + patch wiring live in ./extension/register-edit.js;
  // event wiring above stays here and calls into session/lane fns.
  registerEditTool(pi, session);
  registerTransferTool(pi, session);
}

// ── Exports for testing ─────────────────────────────────────────────
// These are used by test/error-handling.test.ts only.
// At runtime, only the default export is consumed by Pi.
export {
  prepareArguments,
  formatEditError,
  validateInput,
};
