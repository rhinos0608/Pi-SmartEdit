// ── Final-result construction (shared mutation kernel) ──
import type { EvidenceRef } from "@rhinos0608/pi-workspace-protocol";
import { formatBoundedDiagnostics, appendDiagnosticsToContent } from "./post-mutation.js";
import { makeCheck, freezeChecks } from "../patch/result-builders.js";
import type { PatchResult, PatchToolDeps, PatchToolDetails } from "../patch/types.js";
import type { MutationState, MutationToolIdentity } from "./types.js";


export interface FinalizeAppliedPatchArgs {
    readonly deps: PatchToolDeps;
    readonly ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown };
    readonly toolCallId: string;
    readonly state: MutationState;
    readonly autoInspected: boolean;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly tool: MutationToolIdentity;
    readonly rollbackInfo: { ok: boolean; reason?: string } | undefined;
}

export async function finalizeAppliedPatch({ deps, ctx, toolCallId, state, autoInspected, evidenceRefForDetails, tool, rollbackInfo }: FinalizeAppliedPatchArgs): Promise<PatchResult> {
    let finalization: unknown;
    if (deps.runFinalSuccessLanes && state.finalizedFiles.length > 0) {
        try {
            const result = await deps.runFinalSuccessLanes({ cwd: ctx.cwd, toolCallId, files: state.finalizedFiles });
            finalization = result.evidence;
            state.diagnostics.push(...(result.diagnostics ?? []));
            for (const lane of result.checks ?? []) { const check = makeCheck(lane.id, lane.outcome, lane.detail); state.checks.advisory.push(check); state.checks.completed.push(check); }
        } catch (err) { const detail = err instanceof Error ? err.message : String(err); state.diagnostics.push(`finalization: ${detail}`); const check = makeCheck("finalization", "skipped", detail); state.checks.advisory.push(check); state.checks.completed.push(check); }
    }
    state.checks.skipped.push(makeCheck("evidence-pipeline", "skipped", autoInspected ? "auto-inspected (no prior inspect call); pipeline check was replaced by in-tool read+sha" : "evidence-pipeline check ran above; this row records pipeline uncertainty for the consumer"));
    const lastCanonical = state.appliedCanonical.at(-1) ?? "";
    const lastPost = lastCanonical ? state.postEditEvidenceByPath.get(lastCanonical) : undefined;
    const singleDiff = state.displayDiffs.length === 1 ? state.displayDiffs[0] : undefined;
    const combinedDiff = singleDiff ? singleDiff.diff : state.displayDiffs.map((entry) => `${entry.path}\n${entry.diff}`).join("\n\n");
    const details: PatchToolDetails = { tool, status: { kind: "applied" }, toolCallId, evidenceRef: evidenceRefForDetails, usedEvidence: [...new Set(state.usedEvidence)], changedResources: state.invalidations, postEditEvidence: lastPost, checks: freezeChecks(state.checks), diagnostics: state.diagnostics, diff: combinedDiff, diffs: state.displayDiffs, repairs: Object.fromEntries(state.repairsByPath), finalization, rollback: rollbackInfo };
    const summary = state.appliedSummaries.length === 1 ? `applied ${state.appliedSummaries[0]}` : `applied: ${state.appliedSummaries.join("; ")}`;
    return { content: appendDiagnosticsToContent([{ type: "text" as const, text: summary }], formatBoundedDiagnostics(state.diagnostics)) as { type: "text"; text: string }[], details };
}
