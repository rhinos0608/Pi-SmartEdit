// ── Execute orchestrator (shared kernel: ./patch/execute.js) ──
import {
    validateEditRequest,
    validateHashlineOnlyEditRequest,
    type EditRequest,
    type RefactorRequest,
} from "../edit-contract.js";
import { freshChecks, makeRejected } from "./result-builders.js";
import { handleRefactorRequest } from "./refactor-preview.js";
import { executeMutationKernel } from "../mutation/kernel.js";
import { preparePatchExecution } from "./execution-prep.js";
import type { PatchInvocation, PatchResult, PatchToolDeps } from "./types.js";

export type ValidatedPatchDispatch =
    | { kind: "handled"; result: PatchResult }
    | { kind: "patch"; validated: { ok: true; value: EditRequest } };

export async function dispatchValidatedRequest(args: { deps: PatchToolDeps; toolCallId: string; params: Record<string, unknown> }): Promise<ValidatedPatchDispatch> {
    const { deps, toolCallId, params } = args;
    const validate = deps.useHashlineEditing ? validateHashlineOnlyEditRequest : validateEditRequest;
    const v = validate({ ...params, toolCallId });
    if ((v as { ok: boolean; value?: { refactor?: { kind: string } } }).ok && (v as unknown as { value: { refactor?: { kind: string } } }).value?.refactor) {
        const refactor = (v as unknown as { value: { refactor: RefactorRequest } }).value.refactor;
        const handled = await handleRefactorRequest(deps, toolCallId, refactor);
        if (handled) return { kind: "handled", result: handled };
    }
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
