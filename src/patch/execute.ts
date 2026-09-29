// ── Execute orchestrator (shared kernel: ./patch/execute.js) ──
import type { EditRequest } from "../edit-contract.js";
import { freshChecks, makeRejected } from "./result-builders.js";
import { executeMutationKernel } from "../mutation/kernel.js";
import { preparePatchExecution } from "./execution-prep.js";
import type { PatchInvocation, PatchResult, PatchToolDeps } from "./types.js";

export type ValidatedPatchDispatch =
    | { kind: "handled"; result: PatchResult }
    | { kind: "patch"; validated: { ok: true; value: EditRequest } };

export async function dispatchValidatedRequest(args: { deps: PatchToolDeps; toolCallId: string; params: Record<string, unknown> }): Promise<ValidatedPatchDispatch> {
    const { deps, toolCallId, params } = args;
    // Mode-owned validation: the text spec layers its own rejections over the
    // shared internal validator; the hashline spec enforces hashline-only.
    // validateEditRequest also backs the public args.ts API; raw stays there
    // for internal planners only — no agent schema exposes it in either mode.
    const v = deps.editMode.validate({ ...params, toolCallId });
    if (!v.ok) return { kind: "handled", result: { content: [{ type: "text" as const, text: `invalid patch request: ${v.error}` }], details: makeRejected(toolCallId, "session", [v.error], { inspectionId: "", resourceIds: [] }, freshChecks(), [], [], "edit") } };
    return { kind: "patch", validated: v };
}

export async function executePatch(deps: PatchToolDeps, invocation: PatchInvocation): Promise<PatchResult> {
    const { toolCallId } = invocation;
    const dispatched = await dispatchValidatedRequest({ deps, toolCallId, params: invocation.params });
    if (dispatched.kind === "handled") return dispatched.result;
    return executeMutationKernel(deps, {
        ...invocation,
        tool: "edit",
        prepare: async ({ signal, stream }) => {
            const prepared = await preparePatchExecution({ deps, toolCallId, ctx: invocation.ctx, signal, validated: dispatched.validated, stream });
            return prepared.ok ? { ok: true, value: prepared } : prepared;
        },
    });
}
