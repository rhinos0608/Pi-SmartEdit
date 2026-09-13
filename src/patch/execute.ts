// ── Execute orchestrator (shared kernel: ./patch/execute.js) ──
// Thin dispatch + orchestration for createPatchTool.execute. Pure move:
// verbatim from src/patch.ts (stage 6 of patch.ts split), no logic change.
//
// dispatchValidatedRequest owns toolCallId injection, validateEditRequest,
// the refactor-variant conditional + handleRefactorRequest call, and the
// invalid-shape rejection. Refactor dispatch runs BEFORE the invalid-shape
// check, per the existing ordering ("Refactor variants handle before
// generic session checks").
//
// executePatch owns the stream closure plus the four-phase pipeline:
// dispatch → prepare → runPatchTransaction → finalizeAppliedPatch.
import { validateEditRequest, type EditRequest, type RefactorRequest } from "../edit-contract.js";
import { freshChecks, makeRejected } from "./result-builders.js";
import { handleRefactorRequest } from "./refactor-preview.js";
import { preparePatchExecution } from "./execution-prep.js";
import { runPatchTransaction } from "./transaction-runner.js";
import { finalizeAppliedPatch } from "./final-result.js";
import type {
    PatchInvocation,
    PatchResult,
    PatchToolDeps,
} from "./types.js";

export type ValidatedPatchDispatch =
    | { kind: "handled"; result: PatchResult }
    | { kind: "patch"; validated: { ok: true; value: EditRequest } };

export async function dispatchValidatedRequest(args: {
    deps: PatchToolDeps;
    toolCallId: string;
    params: Record<string, unknown>;
}): Promise<ValidatedPatchDispatch> {
    const { deps, toolCallId, params } = args;
    // The wire payload from the model never includes toolCallId (Pi
    // supplies it out-of-band as this function's first argument).
    // Inject it before validating so the schema-conforming request
    // the model actually sends can pass validation.
    const v = validateEditRequest({ ...params, toolCallId });
    // Refactor variants handle before generic session checks (but still validate shape via above)
    // Refactor variants route to file-local helpers (Lane A extract-only).
    if ((v as { ok: boolean; value?: { refactor?: { kind: string } } }).ok && (v as unknown as { value: { refactor?: { kind: string } } }).value?.refactor) {
        // validateEditRequest accepted the payload above, so the broad wire shape narrows to RefactorRequest here.
        const refactor = (v as unknown as { value: { refactor: RefactorRequest } }).value.refactor;
        const handled = await handleRefactorRequest(deps, toolCallId, refactor);
        if (handled) return { kind: "handled", result: handled };
    }
    if (!v.ok) {
        return {
            kind: "handled",
            result: {
                content: [{ type: "text" as const, text: `invalid patch request: ${v.error}` }],
                details: makeRejected(toolCallId, "session", ["invalid patch request shape"], { inspectionId: "", resourceIds: [] }, freshChecks()),
            },
        };
    }
    return { kind: "patch", validated: v };
}

export async function executePatch(deps: PatchToolDeps, invocation: PatchInvocation): Promise<PatchResult> {
    const { toolCallId, params, signal, onUpdate, ctx } = invocation;
    const stream = (text: string) => { onUpdate?.({ content: [{ type: "text", text }] }); };

    const dispatched = await dispatchValidatedRequest({ deps, toolCallId, params });
    if (dispatched.kind === "handled") return dispatched.result;

    const prep = await preparePatchExecution({ deps, toolCallId, ctx, signal, validated: dispatched.validated, stream });
    if (!prep.ok) return prep.result;

    const txResult = await runPatchTransaction({
        deps,
        ctx,
        toolCallId,
        evidenceRefForDetails: prep.evidenceRefForDetails,
        canonicalRoot: prep.canonicalRoot,
        envelope: prep.envelope,
        priorStore: prep.priorStore,
        groups: prep.groups,
        resolvedTransfers: prep.resolvedTransfers,
        copySourceOnlyPaths: prep.copySourceOnlyPaths,
        newFileCanonicals: prep.newFileCanonicals,
        state: prep.state,
        stream,
    });
    if (!txResult.ok) return txResult.result;
    const rollbackInfo = txResult.rollbackInfo;

    return finalizeAppliedPatch({
        deps,
        ctx,
        toolCallId,
        state: prep.state,
        autoInspected: prep.autoInspected,
        evidenceRefForDetails: prep.evidenceRefForDetails,
        rollbackInfo,
    });
}
