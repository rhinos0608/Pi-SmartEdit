import { readFile } from "node:fs/promises";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  RPC_CHANNELS,
  createRpcServer,
  hashSessionFilePath,
  validateApplyStagedEditRequest,
  validateStageWorkspaceEditRequest,
  type ApplyStagedEditResponse,
  type LspWorkspaceEdit,
  type RequestEvent,
  type StageWorkspaceEditResponse,
} from "@rhinos0608/pi-workspace-protocol";

import { generateDiffString } from "../core/edit-diff.js";
import { planPositionalEdits } from "../lsp/positional-planner.js";
import { globalRefactorPreviewCache } from "../lsp/refactor-preview-cache.js";
import { claimDiagnosticsOwner, releaseDiagnosticsOwner } from "../mutation/mutation-ownership.js";
import type { PatchToolDeps } from "../patch/types.js";
import {
  checkPlannedPreviewCaps,
  checkWorkspaceEditEncoding,
  findPreviewUnauthorizedFiles,
  handleApplyRefactorPreview,
} from "../patch/refactor-preview.js";
import { checkEditSafety } from "../safety/approval-gating.js";
import { buildPatchToolDeps } from "./patch-deps.js";
import { parsePostEditDiff, refreshReadCacheAfterEdit } from "./post-lanes.js";
import { buildMutationEvidence, type SessionState } from "./session.js";

/** Bounded diff bytes returned in a stage reply (mirrors preview text cap). */
const STAGE_DIFF_MAX_CHARS = 4000;

/**
 * Working directory for lanes and diagnostics. Always session-derived:
 * the RPC payload cwd is caller-controlled and must never reach
 * compiler/linter execution (a hostile cwd could point at a crate whose
 * build scripts run during `cargo check`). Null when the session has none.
 */
function resolveSessionCwd(deps: PatchToolDeps, session: SessionState): string | null {
  const cwd = session.currentCwd ?? deps.getCanonicalWorkspaceRoot();
  return cwd && cwd.length > 0 ? cwd : null;
}

function currentSession(deps: PatchToolDeps): string | null {
  return deps.getSessionFilePath();
}

function sessionMatches(deps: PatchToolDeps, sessionFilePath: string): boolean {
  const current = currentSession(deps);
  return !!current && current === sessionFilePath;
}

function sessionBinding(deps: PatchToolDeps): { sessionId: string; sessionRoot: string } | null {
  const current = currentSession(deps);
  if (!current) return null;
  return { sessionId: hashSessionFilePath(current), sessionRoot: deps.getCanonicalWorkspaceRoot() };
}

export async function stageWorkspaceEdit(args: {
  deps: PatchToolDeps;
  session: SessionState;
  payload: unknown;
}): Promise<StageWorkspaceEditResponse> {
  const { deps, session, payload } = args;
  const v = validateStageWorkspaceEditRequest(payload);
  if (!v.ok) return { ok: false, reason: `invalid stage request: ${v.error}` };
  const req = v.value;
  if (!sessionMatches(deps, req.sessionFilePath)) {
    return { ok: false, reason: "rejected: session mismatch — proposal belongs to another session" };
  }
  if (!resolveSessionCwd(deps, session)) {
    return { ok: false, reason: "rejected: no active session working directory" };
  }
  const enc = checkWorkspaceEditEncoding(req.workspaceEdit);
  if (enc) return { ok: false, reason: enc };
  const stored = await planAndStoreStagedEdit(deps, req);
  if ("reason" in stored) return { ok: false, reason: stored.reason };
  return {
    ok: true,
    proposalId: stored.previewId,
    files: stored.planned.stagedFiles.map((f) => f.filePath),
    diff: stored.planned.diffString.slice(0, STAGE_DIFF_MAX_CHARS),
  };
}

type StagedPlan = Awaited<ReturnType<typeof planPositionalEdits>>;

async function planAndStoreStagedEdit(
  deps: PatchToolDeps,
  req: { workspaceEdit: unknown; source: { operation: string; serverDescriptorId?: string } },
): Promise<{ planned: StagedPlan; previewId: string } | { reason: string }> {
  let planned: StagedPlan;
  try {
    planned = await planPositionalEdits(req.workspaceEdit as LspWorkspaceEdit, async (p) =>
      (await readFile(p)).toString("utf-8"),
    );
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
  const capsErr = checkPlannedPreviewCaps(planned);
  if (capsErr) return { reason: capsErr };
  // Fail closed before disclosing anything: staging reads the files and
  // returns their diffs, so it requires the same prior read authority as
  // apply. Otherwise any bus caller could exfiltrate unread file content.
  const unauthorized = findPreviewUnauthorizedFiles(deps, planned.stagedFiles);
  if (unauthorized.length > 0) {
    return { reason: `rejected: missing read authority for: ${unauthorized.join(", ")} — read the file first, then retry` };
  }
  const binding = sessionBinding(deps);
  if (!binding) return { reason: "rejected: no active session" };
  const previewId = globalRefactorPreviewCache.store(req.workspaceEdit as never, planned as never, {
    source: { kind: "workspace-edit", operation: req.source.operation },
    ...(req.source.serverDescriptorId !== undefined ? { serverDescriptorId: req.source.serverDescriptorId } : {}),
    sessionId: binding.sessionId,
    sessionRoot: binding.sessionRoot,
  });
  return { planned, previewId };
}

function applyRejected(text: string, diagnostics: string[] = []): ApplyStagedEditResponse {
  return { ok: false, status: "rejected", text, diagnostics, changedFiles: [] };
}

type ApplyGate = {
  req: { proposalId: string; toolCallId: string; sessionFilePath: string; cwd: string };
  binding: { sessionId: string; sessionRoot: string };
  cached: NonNullable<ReturnType<typeof globalRefactorPreviewCache.get>>;
};

function gateApplyRequest(
  deps: PatchToolDeps,
  session: SessionState,
  payload: unknown,
): { ok: true; req: ApplyGate["req"]; binding: ApplyGate["binding"]; cached: ApplyGate["cached"] } | { ok: false; rejected: ApplyStagedEditResponse } {
  const v = validateApplyStagedEditRequest(payload);
  if (!v.ok) {
    return { ok: false, rejected: applyRejected(`rejected: invalid apply request: ${v.error}`, [v.error]) };
  }
  const req = v.value;
  if (!sessionMatches(deps, req.sessionFilePath)) {
    return { ok: false, rejected: applyRejected("rejected: session mismatch — proposal belongs to another session", ["session mismatch"]) };
  }
  const binding = sessionBinding(deps);
  if (!binding) return { ok: false, rejected: applyRejected("rejected: no active session", ["no active session"]) };
  // The mutation lands under the SmartRead `lsp` tool name, so the edit
  // tool's own execute wrapper and `edit`-keyed tool_result hooks never run.
  // The loop-guard preflight the edit path would do happens here instead.
  const loopBlocked = session.mutationLoopGuard.preflight("edit", { proposalId: req.proposalId }, req.toolCallId);
  if (loopBlocked) {
    const text = loopBlocked.content.map((e) => e.text).join("\n");
    return { ok: false, rejected: applyRejected(text, [...(loopBlocked.details.diagnostics ?? [])]) };
  }
  const cached = globalRefactorPreviewCache.get(req.proposalId, binding);
  if (!cached) {
    return { ok: false, rejected: applyRejected("rejected: unknown or expired preview", ["unknown or expired preview"]) };
  }
  return { ok: true, req, binding, cached };
}

type StagedFile = ApplyGate["cached"]["planned"]["stagedFiles"][number];

async function runApplyPostLanes(
  deps: PatchToolDeps,
  req: ApplyGate["req"],
  cwd: string,
  stagedFiles: StagedFile[],
): Promise<string[]> {
  const laneDiagnostics: string[] = [];
  // Advisory risk warnings the edit path emits via checkEditSafety
  // (dangerous paths, generated files, risky symbols). Advisory only:
  // collected into diagnostics, never block the already-committed apply.
  // Never wire assertEditableFile here (see transaction-runner invariants).
  try {
    for (const sf of stagedFiles) {
      const safety = await checkEditSafety(sf.filePath, [], undefined, [sf.newContent]);
      laneDiagnostics.push(...safety.warnings);
    }
  } catch {
    // Safety scan is advisory — silent degradation
  }
  try {
    const lanes = await deps.runFinalSuccessLanes?.({
      cwd,
      toolCallId: req.toolCallId,
      files: stagedFiles.map((sf) => ({
        path: sf.filePath,
        oldContent: sf.originalContent,
        content: sf.newContent,
        changedLineRanges: sf.edits.map((e) => ({
          startLine: e.range.start.line + 1,
          endLine: e.range.end.line + 1,
        })),
      })),
    });
    if (lanes) laneDiagnostics.push(...(lanes.diagnostics ?? []));
  } catch (err) {
    laneDiagnostics.push(`finalization: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const sf of stagedFiles) {
    await refreshReadCacheAfterEdit(sf.filePath, cwd).catch(() => {
      // File might not exist yet or can't be read — skip silently
    });
  }
  return laneDiagnostics;
}

async function mintApplyEvidence(session: SessionState, stagedFiles: StagedFile[]): Promise<void> {
  try {
    const narrowHints = new Map(
      stagedFiles.map((sf) => [sf.filePath, parsePostEditDiff(generateDiffString(sf.originalContent, sf.newContent).diff)]),
    );
    const envelope = await buildMutationEvidence(
      session,
      stagedFiles.map((sf) => sf.filePath),
      narrowHints,
    );
    if (envelope) session.priorAuthorityStore?.record(envelope);
  } catch {
    // Evidence mint is advisory — silent degradation
  }
}

export async function applyStagedEdit(args: {
  deps: PatchToolDeps;
  session: SessionState;
  payload: unknown;
}): Promise<ApplyStagedEditResponse> {
  const { deps, session, payload } = args;
  const sessionCwd = resolveSessionCwd(deps, session);
  if (!sessionCwd) {
    return applyRejected("rejected: no active session working directory", ["no active session working directory"]);
  }
  const gate = gateApplyRequest(deps, session, payload);
  if (!gate.ok) return gate.rejected;
  const { req, binding, cached } = gate;
  claimDiagnosticsOwner(req.toolCallId);
  const result = session.mutationLoopGuard.observe(
    "edit",
    { proposalId: req.proposalId },
    await handleApplyRefactorPreview(
      deps,
      req.toolCallId,
      { kind: "apply-refactor-preview", previewId: req.proposalId },
      sessionCwd,
    ),
  );
  const text = result.content.map((e) => e.text).join("\n");
  const kind = result.details.status.kind;
  if (kind !== "applied") {
    releaseDiagnosticsOwner(req.toolCallId);
    return {
      ok: false,
      status: kind === "failed" ? "failed" : "rejected",
      text,
      diagnostics: [...result.details.diagnostics],
      changedFiles: [],
    };
  }
  const stagedFiles = cached.planned.stagedFiles;
  const laneDiagnostics = await runApplyPostLanes(deps, req, sessionCwd, stagedFiles);
  await mintApplyEvidence(session, stagedFiles);
  return {
    ok: true,
    status: "applied",
    text,
    diagnostics: [...result.details.diagnostics, ...laneDiagnostics],
    changedFiles: stagedFiles.map((sf) => sf.filePath),
  };
}

/** Register the workspace-edit RPC server next to the edit tool. */
export function registerWorkspaceEditRpc(
  pi: ExtensionAPI,
  session: SessionState,
): { dispose: () => void } {
  const bus = pi.events as unknown as {
    emit: (c: string, d: unknown) => void;
    on: (c: string, h: (d: unknown) => void) => () => void;
  };
  const deps = buildPatchToolDeps(session, bus);
  const server = createRpcServer({
    bus,
    channel: RPC_CHANNELS.workspaceEdit,
    handler: async (req: RequestEvent): Promise<unknown> => {
      if (req.rpc === "stage_workspace_edit") return stageWorkspaceEdit({ deps, session, payload: req.payload });
      if (req.rpc === "apply_staged_edit") return applyStagedEdit({ deps, session, payload: req.payload });
      throw new Error(`unknown workspace-edit method ${req.rpc}`);
    },
  });
  return server;
}
