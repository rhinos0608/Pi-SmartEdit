/** Tool-neutral mutation lifecycle kernel. Frontends (`edit`,
 *  `transfer`) own schema, validation, and domain planning, then hand a
 *  `MutationPreparation` here. The kernel owns evidence validation,
 *  transaction planning, grouped application, verifiers, commit/rollback,
 *  undo capture, invalidation, post-edit evidence, and finalization.
 *
 *  This module has no runtime imports from `../patch/*`: it takes only the
 *  type-only `PatchToolDeps`/`PatchResult` names, while transaction
 *  orchestration and finalization arrive via `./transaction-runner.js` and
 *  `./final-result.js` peers. Planned mutations arrive as kernel-native
 *  `MutationOperation`s — no transfer side channels. */
import type { PatchToolDeps, PatchResult } from "../patch/types.js";
import { runPatchTransaction } from "./transaction-runner.js";
import { finalizeAppliedPatch } from "./final-result.js";
import type {
    MutationPreparation,
    MutationToolIdentity,
} from "./types.js";

export type { MutationToolIdentity };
export type { MutationPreparation };

export interface MutationKernelInvocation {
    readonly toolCallId: string;
    readonly params: Record<string, unknown>;
    readonly signal: AbortSignal | undefined;
    readonly onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined;
    readonly ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown };
    readonly tool: MutationToolIdentity;
    readonly prepare: (args: { signal: AbortSignal | undefined; stream: (text: string) => void }) => Promise<{ ok: true; value: MutationPreparation } | { ok: false; result: PatchResult }>;
}

export async function executeMutationKernel(deps: PatchToolDeps, invocation: MutationKernelInvocation): Promise<PatchResult> {
    const { toolCallId, ctx, onUpdate } = invocation;
    const stream = (text: string) => { onUpdate?.({ content: [{ type: "text", text }] }); };
    const prep = await invocation.prepare({ signal: invocation.signal, stream });
    if (!prep.ok) return prep.result;
    const prepared = prep.value;
    const txResult = await runPatchTransaction({
        deps, ctx, toolCallId, tool: invocation.tool,
        evidenceRefForDetails: prepared.evidenceRefForDetails,
        canonicalRoot: prepared.canonicalRoot,
        envelope: prepared.envelope, priorStore: prepared.priorStore,
        groups: prepared.groups, resourceIntents: prepared.resourceIntents,
        operations: prepared.operations, state: prepared.state, stream,
    });
    if (!txResult.ok) return txResult.result;
    return finalizeAppliedPatch({
        deps, ctx, toolCallId, state: prepared.state,
        autoInspected: prepared.autoInspected,
        evidenceRefForDetails: prepared.evidenceRefForDetails,
        tool: invocation.tool, rollbackInfo: txResult.rollbackInfo,
    });
}
