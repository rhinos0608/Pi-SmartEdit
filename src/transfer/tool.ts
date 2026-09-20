/**
 * First-class transfer tool frontend.
 *
 * Public contract is `transfer({ transfers: [...] })`. The frontend owns
 * only schema, batch validation, and transfer-specific planning; the shared
 * mutation kernel (`src/mutation/kernel.ts`) owns evidence, transaction,
 * verification, rollback, undo, invalidation, and finalization.
 */
import { existsSync } from "node:fs";
import {
    validateEvidenceRef,
    type EvidenceRef,
    type PostEditEvidence,
    type ResourceInvalidation,
} from "@rhinos0608/pi-workspace-protocol";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";
import { executeMutationKernel, type MutationPreparation } from "../mutation/kernel.js";
import type { MutationResourceIntent } from "../mutation/resource-intent.js";
import { materializeTransfers } from "./staging.js";
import type {
    MutationDisplayDiff,
    MutationGroup,
    MutationOperationContext,
    MutationResult,
    MutationState,
    MutableChecks,
    FinalSuccessFile,
} from "../mutation/types.js";
import {
    acquirePatchEnvelope,
} from "../patch/request-prep.js";
import { resolveTransferBatch } from "./resolve-batch.js";
import {
    freshChecks,
    makeRejected,
} from "../patch/result-builders.js";
import type { PatchToolDeps } from "../patch/types.js";
import type { RepairLoopResult } from "../verification/repair-loop.js";
import { TRANSFER_PARAMETERS, validateTransferRequest, type TransferRequest } from "./contract.js";

export const TRANSFER_TOOL_DESCRIPTION =
    "Use transfer when moving, copying, or reusing text/code that already exists in an observed source, " +
    "especially during refactors or when implementing from a reference. It preserves the source content " +
    "directly instead of regenerating it. Prefer transfer over reproducing observed blocks through `newText`.";

export const TRANSFER_TOOL_PARAMETERS = {
    type: "object",
    additionalProperties: false,
    properties: {
        transfers: {
            type: "array",
            minItems: 1,
            description: "One or more copy/move transfers. All transfers resolve against the same pre-transaction state and commit atomically.",
            items: TRANSFER_PARAMETERS,
        },
    },
    required: ["transfers"],
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateTransferBatch(
    input: unknown,
): { ok: true; value: { transfers: TransferRequest[]; evidenceRef?: EvidenceRef } } | { ok: false; error: string } {
    if (!isPlainObject(input)) return { ok: false, error: "transfer request must be an object" };
    for (const key of Object.keys(input)) {
        if (key !== "transfers" && key !== "evidenceRef" && key !== "toolCallId") return { ok: false, error: `transfer.${key} is not supported` };
    }
    const { transfers, evidenceRef } = input;
    if (!Array.isArray(transfers) || transfers.length === 0) {
        return { ok: false, error: "transfer.transfers must be a non-empty array" };
    }
    const out: TransferRequest[] = [];
    for (let i = 0; i < transfers.length; i++) {
        const validated = validateTransferRequest(transfers[i]);
        if (!validated.ok) return { ok: false, error: `transfer.transfers[${i}]: ${validated.error}` };
        out.push(validated.value);
    }
    // evidenceRef is optional stored-call compat (tool-owned authority, never
    // advertised). Validated when present, never required.
    if (evidenceRef !== undefined) {
        const er = validateEvidenceRef(evidenceRef);
        if (!er.ok) return { ok: false, error: `transfer.evidenceRef is malformed` };
        return { ok: true, value: { transfers: out, evidenceRef: er.value } };
    }
    return { ok: true, value: { transfers: out } };
}

export interface TransferTool {
    readonly name: "transfer";
    readonly label: "transfer";
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: ((u: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
        ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown },
    ): Promise<MutationResult>;
}

async function prepareTransferExecution(args: {
    deps: PatchToolDeps;
    toolCallId: string;
    ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown };
    signal: AbortSignal | undefined;
    validated: { ok: true; value: { transfers: TransferRequest[]; evidenceRef?: EvidenceRef } };
    stream: (text: string) => void;
}): Promise<{ ok: true; value: MutationPreparation } | { ok: false; result: MutationResult }> {
    const { deps, toolCallId, ctx, signal, validated, stream } = args;
    const sessionFilePath = deps.getSessionFilePath();
    if (typeof sessionFilePath !== "string" || sessionFilePath.length === 0) {
        return { ok: false as const, result: { content: [{ type: "text" as const, text: "rejected: ephemeral session identity" }], details: makeRejected(toolCallId, "session", ["no real session file path"], { inspectionId: "", resourceIds: [] }, freshChecks(), [], [], "transfer") } };
    }
    const canonicalRoot = deps.getCanonicalWorkspaceRoot();
    if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) {
        return { ok: false as const, result: { content: [{ type: "text" as const, text: "rejected: missing canonical workspace root" }], details: makeRejected(toolCallId, "session", ["no canonical workspace root"], { inspectionId: "", resourceIds: [] }, freshChecks(), [], [], "transfer") } };
    }
    const checks: MutableChecks = freshChecks();
    const diagnostics: string[] = [];
    const usedEvidence: string[] = [];
    const requestEvidenceRef: EvidenceRef | undefined = validated.value.evidenceRef;
    const groups: MutationGroup[] = [];
    const transfers = resolveTransferBatch({
        transfers: validated.value.transfers,
        groups,
        ctx,
        toolCallId,
        requestEvidenceRef,
        checks,
    });
    if (!transfers.ok) return { ok: false as const, result: transfers.result };
    const resolvedTransfers = transfers.resolvedTransfers;
    const fileWord = groups.length === 1 ? "file" : "files";
    const transferWord = resolvedTransfers.length === 1 ? "transfer" : "transfers";
    stream(`transfer — ${resolvedTransfers.length} ${transferWord} across ${groups.length} ${fileWord}`);

    const resourceIntents: MutationResourceIntent[] = groups.map((group) => ({
        canonicalPath: group.absolutePath,
        kind: !existsSync(group.absolutePath) ? "create-new" : "mutate-existing",
    }));
    for (const transfer of resolvedTransfers) {
        if (transfer.op === "copy") resourceIntents.push({ canonicalPath: transfer.canonicalFrom, kind: "observe-source" });
        if (transfer.toIsNewFile) resourceIntents.push({ canonicalPath: transfer.canonicalTo, kind: "create-new" });
    }

    const priorStore = deps.getPriorAuthority?.() ?? null;
    const acquired = await acquirePatchEnvelope({ deps, groups, resourceIntents, sessionFilePath, canonicalRoot, requestEvidenceRef, toolCallId, tool: "transfer", checks, diagnostics, usedEvidence, signal });
    if (!acquired.ok) return { ok: false as const, result: acquired.result };

    const invalidations: ResourceInvalidation[] = [];
    const state: MutationState = {
        checks,
        diagnostics,
        usedEvidence,
        invalidations,
        postEditEvidenceByPath: new Map<string, PostEditEvidence>(),
        repairsByPath: new Map<string, RepairLoopResult>(),
        finalizedFiles: [] as FinalSuccessFile[],
        appliedFiles: [],
        appliedCanonical: [],
        appliedSummaries: [],
        displayDiffs: [] as MutationDisplayDiff[],
    };
    const operations = [
        (operationContext: MutationOperationContext) => materializeTransfers({ ...operationContext, resolvedTransfers }),
    ];
    return {
        ok: true,
        value: {
        groups,
        resourceIntents,
        operations,
        envelope: acquired.envelope,
        priorStore,
        evidenceRefForDetails: acquired.evidenceRefForDetails,
        canonicalRoot,
        autoInspected: acquired.autoInspected,
        state,
        },
    };
}

export function createTransferTool(deps: PatchToolDeps): TransferTool {
    return {
        name: "transfer",
        label: "transfer",
        description: TRANSFER_TOOL_DESCRIPTION,
        parameters: TRANSFER_TOOL_PARAMETERS as unknown as Record<string, unknown>,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const v = validateTransferBatch(params);
            if (!v.ok) {
                return {
                    content: [{ type: "text" as const, text: `invalid transfer request: ${v.error}` }],
                    details: makeRejected(toolCallId, "session", ["invalid transfer request shape"], { inspectionId: "", resourceIds: [] }, freshChecks(), [], [], "transfer"),
                };
            }
            const stream = (text: string) => { onUpdate?.({ content: [{ type: "text", text }] }); };
            return executeMutationKernel(deps, {
                toolCallId,
                params,
                signal,
                onUpdate,
                ctx,
                tool: "transfer",
                prepare: async ({ signal: prepareSignal, stream: prepareStream }) =>
                    prepareTransferExecution({ deps, toolCallId, ctx, signal: prepareSignal, validated: v, stream: prepareStream ?? stream }),
            });
        },
    };
}
