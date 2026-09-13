// ── Final-result construction (shared kernel: ./patch/final-result.js) ──
// Tail of createPatchTool.execute after commit/rollback: final-only lanes,
// the auto-inspect evidence-pipeline record, backward-compatible post-edit
// evidence assembly, single-diff vs combined multi-diff formatting,
// applied/summary construction, and bounded diagnostics appended to
// model-visible content. Pure move: zero logic change.

import type { EvidenceRef } from "@rhinos0608/pi-workspace-protocol";
import { formatBoundedDiagnostics, appendDiagnosticsToContent } from "../mutation/post-mutation.js";
import { makeCheck, freezeChecks } from "./result-builders.js";
import type {
    PatchExecutionState,
    PatchResult,
    PatchToolDeps,
    PatchToolDetails,
} from "./types.js";

export interface FinalizeAppliedPatchArgs {
    readonly deps: PatchToolDeps;
    readonly ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown };
    readonly toolCallId: string;
    readonly state: PatchExecutionState;
    readonly autoInspected: boolean;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly rollbackInfo: { ok: boolean; reason?: string } | undefined;
}

export async function finalizeAppliedPatch({
    deps,
    ctx,
    toolCallId,
    state,
    autoInspected,
    evidenceRefForDetails,
    rollbackInfo,
}: FinalizeAppliedPatchArgs): Promise<PatchResult> {
    // Final-only lanes must observe committed state. They remain
    // advisory: a diagnostic or bridge failure cannot turn a durable
    // transaction into a reported rollback.
    let finalization: unknown;
    if (deps.runFinalSuccessLanes && state.finalizedFiles.length > 0) {
        try {
            const result = await deps.runFinalSuccessLanes({ cwd: ctx.cwd, toolCallId, files: state.finalizedFiles });
            finalization = result.evidence;
            state.diagnostics.push(...(result.diagnostics ?? []));
            for (const lane of result.checks ?? []) {
                const check = makeCheck(lane.id, lane.outcome, lane.detail);
                state.checks.advisory.push(check);
                state.checks.completed.push(check);
            }
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            state.diagnostics.push(`finalization: ${detail}`);
            const check = makeCheck("finalization", "skipped", detail);
            state.checks.advisory.push(check);
            state.checks.completed.push(check);
        }
    }

    // Surface evidence-pipeline uncertainty in skipped bucket.
    if (autoInspected) {
        state.checks.skipped.push(makeCheck("evidence-pipeline", "skipped", "auto-inspected (no prior inspect call); pipeline check was replaced by in-tool read+sha"));
    } else {
        state.checks.skipped.push(makeCheck("evidence-pipeline", "skipped", "evidence-pipeline check ran above; this row records pipeline uncertainty for the consumer"));
    }

    // Build the final details. For v3 multi-file, postEditEvidence is
    // emitted per file via the postEditEvidenceByPath map, and the
    // top-level postEditEvidence is the last (or only) file's value
    // for backward compatibility with v1 single-file consumers.
    // Post evidence is keyed by canonical target, not the caller's raw
    // path. Use the per-applied canonical target so a symlinked or
    // topology path resolves to its real file's evidence.
    const lastCanonical = state.appliedCanonical.at(-1) ?? "";
    const lastPost = lastCanonical ? state.postEditEvidenceByPath.get(lastCanonical) : undefined;

    const singleDiff = state.displayDiffs.length === 1 ? state.displayDiffs[0] : undefined;
    const combinedDiff = singleDiff
        ? singleDiff.diff
        : state.displayDiffs.map((entry) => `${entry.path}\n${entry.diff}`).join("\n\n");
    const details: PatchToolDetails = {
        tool: "patch",
        status: { kind: "applied" },
        toolCallId,
        evidenceRef: evidenceRefForDetails,
        usedEvidence: [...new Set(state.usedEvidence)],
        changedResources: state.invalidations,
        postEditEvidence: lastPost,
        checks: freezeChecks(state.checks),
        diagnostics: state.diagnostics,
        diff: combinedDiff,
        diffs: state.displayDiffs,
        repairs: Object.fromEntries(state.repairsByPath),
        finalization,
        rollback: rollbackInfo,
    };
    // Built from appliedSummaries (recorded per applied group at the
    // point it was applied) rather than indexing groups[0], which does
    // not necessarily correspond to appliedFiles[0] and previously
    // reported "applied 0 edit(s)" for a topology-only group.
    const summary = state.appliedSummaries.length === 1
        ? `applied ${state.appliedSummaries[0]}`
        : `applied: ${state.appliedSummaries.join("; ")}`;
    // Diagnostics were already collected into `details.diagnostics` by
    // runFinalSuccessLanes above; without this, they were only visible
    // via `details` (not shown to the model) — surface a bounded copy
    // in `content` too, advisory-only, without changing pass/fail.
    const diagnosticsBlock = formatBoundedDiagnostics(state.diagnostics);
    return {
        content: appendDiagnosticsToContent(
            [{ type: "text" as const, text: summary }],
            diagnosticsBlock,
        ) as { type: "text"; text: string }[],
        details,
    };
}
