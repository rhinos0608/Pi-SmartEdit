/**
 * Patch group application — per-group write/verify/finalize dispatch.
 * Pure move: verbatim from src/patch.ts (stage 4 of patch.ts split),
 * no logic change. The orchestrator keeps transaction begin/commit/finalize.
 *
 * Covers, in exact pipeline order:
 *   prewrite verifiers → prewrite freshness recheck (TOCTOU guard) →
 *   content safety advisory → content persistence → pending invalidation →
 *   postwrite verification → rename + success finalization,
 * tied together by executeEditGroup (placeholder-skip + progress +
 * preimage/plan/repair dispatch).
 *
 * Delete-group application already lives in ./patch/group-planning.js
 * (stage 3): advisory checkEditSafety wired before transaction.remove,
 * invalidation, diff, applied summary. Not duplicated here.
 *
 * Invariants (never change without explicit approval):
 * - checkEditSafety stays advisory-only ("risk-warning", outcome "pass").
 *   Never wire assertEditableFile.
 * - Write failure rolls back immediately and marks committed=true so the
 *   outer finally does NOT roll back twice. All other failures leave the
 *   transaction open for the outer finally. Preserved via the return-value
 *   discriminant (WriteFailure carries rollbackInfo; every other terminal
 *   carries none).
 * - Terminal results pass the SAME mutable checks/diagnostics/usedEvidence/
 *   invalidations array references through (makeRejected/makeFailed freeze
 *   checks but keep diagnostics/changedResources live for the outer finally).
 * - No path-containment / cwd-scoping gate.
 * - All writes go through EditTransaction (atomicWrite/atomicCreate inside).
 */
import { stat as fsStat, mkdir as fsMkdir } from "node:fs/promises";
import { resolve as pathResolve, dirname as pathDirname } from "node:path";
import { realpathSync } from "node:fs";

import {
    sha256OfString,
    type EvidenceRef,
    type InspectedResource,
    type LineRange,
    type ResourceInvalidation,
} from "@rhinos0608/pi-workspace-protocol";
import { generateDiffString } from "../core/edit-diff.js";
import { checkEditSafety } from "../safety/approval-gating.js";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";
import type { EditTransaction } from "../mutation/edit-transaction.js";
import type { RepairLoopResult } from "../verification/repair-loop.js";
import { safeReadUtf8 } from "./request-prep.js";
import {
    makeCheck,
    runVerifierCheck,
    makeRejected,
    makeFailed,
    buildRollbackInfo,
} from "./result-builders.js";
import { isBlockingPostwriteFailure } from "./refactor-preview.js";
import {
    resolveAuthorizedGroupPreimage,
    planGroupMutation,
    applyAuthorizedRepair,
} from "./group-planning.js";
import type {
    EditGroup,
    FinalSuccessFile,
    MutableChecks,
    PatchDisplayDiff,
    PatchResult,
    PatchToolDeps,
    VerificationCheck,
} from "./types.js";

/** Mutable accumulator bag threaded through one group's pipeline. All array
 *  references are the caller's live arrays — never cloned — so terminal
 *  results and the outer transaction finally observe the same mutations. */
export interface GroupApplicationState {
    readonly checks: MutableChecks;
    readonly diagnostics: string[];
    readonly usedEvidence: string[];
    readonly invalidations: ResourceInvalidation[];
    readonly postEditEvidenceByPath: Map<string, import("@rhinos0608/pi-workspace-protocol").PostEditEvidence>;
    readonly repairsByPath: Map<string, RepairLoopResult>;
    readonly finalizedFiles: FinalSuccessFile[];
    readonly appliedFiles: string[];
    readonly appliedCanonical: string[];
    readonly appliedSummaries: string[];
    readonly displayDiffs: PatchDisplayDiff[];
}

export interface GroupApplicationContext {
    readonly deps: PatchToolDeps;
    readonly ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown };
    readonly toolCallId: string;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly canonicalRoot: string;
    readonly envelope: import("@rhinos0608/pi-workspace-protocol").WorkspaceEvidenceEnvelope | null;
    readonly priorStore: PriorAuthorityStore | null;
    readonly newFileCanonicals: ReadonlySet<string>;
    readonly transaction: EditTransaction;
    readonly canonicalTxPath: (absolutePath: string) => string;
    readonly stream: (text: string) => void;
}

export interface ExecuteEditGroupArgs {
    readonly context: GroupApplicationContext;
    readonly state: GroupApplicationState;
    readonly group: EditGroup;
    /** Write-failure outbox: persistContentGroup fills rollbackInfo and the
     *  caller marks committed=true ONLY on the write-failure path. Every
     *  other terminal leaves committed=false for the outer finally. */
    readonly outcome: {
        committed: boolean;
        rollbackInfo?: { ok: boolean; reason?: string };
    };
}

export type ExecuteEditGroupResult =
    | { status: "applied" }
    | { status: "deleted" }
    | { status: "terminal"; result: PatchResult };

interface PrewriteVerifierArgs {
    readonly verifiers: ReadonlyArray<VerificationCheck>;
    readonly group: EditGroup;
    readonly canonicalTarget: string;
    readonly newContent: string;
    readonly toolCallId: string;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly resource: InspectedResource;
    readonly state: GroupApplicationState;
}

/** Prewrite verifiers: fetched once per group after repair (by the caller);
 *  non-postwrite filter; each verifier run with timeout stored in BOTH
 *  timedOut and blocking-when-blocking; cumulative checks.blocking gate. */
export async function runPrewriteVerifiers(args: PrewriteVerifierArgs): Promise<PatchResult | null> {
    const { verifiers, group, canonicalTarget, newContent, toolCallId, evidenceRefForDetails, resource, state } = args;
    const { checks, diagnostics, usedEvidence, invalidations } = state;
    // Run allowlisted checks (per file). Postwrite-phase checks run
    // only after the write (below); running them here would observe
    // the pre-write content and mis-record them.
    for (const v of verifiers.filter((candidate) => candidate.phase !== "postwrite")) {
        // Only the racing timer maps to "timeout". A blocking
        // verifier that throws for any other reason is treated
        // as a hard fail so the gate below actually blocks the
        // write.
        const { outcome, detail } = await runVerifierCheck(v, { path: canonicalTarget, content: newContent, toolCallId });
        const check = makeCheck(`${v.id}:${group.rawPath}`, outcome, detail);
        checks.completed.push(check);
        if (outcome === "timeout") {
            // A timed-out BLOCKING verifier must still be visible to
            // the gate below (it also stays in timedOut for
            // observability) — a timeout is not merely advisory, it
            // must block the write exactly like an outright failure.
            checks.timedOut.push(check);
            if (v.kind === "blocking") checks.blocking.push(check);
        } else if (v.kind === "blocking") {
            checks.blocking.push(check);
        } else {
            checks.advisory.push(check);
        }
    }

    // A failing (or timed-out) blocking check must prevent the
    // write — recording it in checks.blocking is not itself a gate.
    const failedBlocking = checks.blocking.find((c) => c.outcome === "fail" || c.outcome === "timeout");
    if (failedBlocking) {
        diagnostics.push(`blocking check failed: ${failedBlocking.id}${failedBlocking.detail ? ` (${failedBlocking.detail})` : ""}`);
        return {
            content: [{ type: "text" as const, text: `rejected: blocking check failed (${group.rawPath})` }],
            details: makeRejected(toolCallId, "approval", diagnostics, {
                inspectionId: evidenceRefForDetails.inspectionId,
                resourceIds: [resource.resourceId],
            }, checks, usedEvidence, invalidations),
        };
    }
    return null;
}

interface FreshnessRecheckArgs {
    readonly group: EditGroup;
    readonly canonicalTarget: string;
    readonly currentSha: string;
    readonly isNewFileGroup: boolean;
    readonly toolCallId: string;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly resource: InspectedResource;
    readonly state: GroupApplicationState;
}

/** Prewrite freshness recheck: existing-file reread + SHA comparison (TOCTOU
 *  guard) against the resource's attested fullFileSha256; no-op for new
 *  files. */
export async function recheckPrewriteFreshness(args: FreshnessRecheckArgs): Promise<PatchResult | null> {
    const { group, canonicalTarget, currentSha, isNewFileGroup, toolCallId, evidenceRefForDetails, resource, state } = args;
    const { checks, diagnostics, usedEvidence, invalidations } = state;
    // Fix #6: re-read and re-hash immediately before writing so a
    // concurrent writer between the initial SHA check and the actual
    // atomicWrite cannot slip a stale write in. For new files
    // there's nothing on disk to race against, so the check is a
    // no-op.
    if (!isNewFileGroup) {
        let preWriteContent: string;
        try {
            preWriteContent = await safeReadUtf8(canonicalTarget);
        } catch (err) {
            diagnostics.push(`re-read failed: ${err instanceof Error ? err.message : String(err)}`);
            return {
                content: [{ type: "text" as const, text: `rejected: stale (${group.rawPath})` }],
                details: makeRejected(toolCallId, "stale", diagnostics, {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [resource.resourceId],
                }, checks, usedEvidence, invalidations),
            };
        }
        if (sha256OfString(preWriteContent) !== currentSha) {
            diagnostics.push(`stale re-read for ${canonicalTarget} (sha changed during apply)`);
            return {
                content: [{ type: "text" as const, text: `rejected: stale (${group.rawPath})` }],
                details: makeRejected(toolCallId, "stale", diagnostics, {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [resource.resourceId],
                }, checks, usedEvidence, invalidations),
            };
        }
    }
    return null;
}

interface ContentSafetyArgs {
    readonly group: EditGroup;
    readonly canonicalTarget: string;
    readonly state: GroupApplicationState;
}

/** Content-lane advisory risk-warning check (non-blocking, warnings only).
 *  Runs before write to catch dangerous patterns in edit content and paths.
 *  Topology-only groups (add/delete/rename) still run path risk warnings;
 *  add-file content is scanned too. */
export async function runContentSafetyAdvisory(args: ContentSafetyArgs): Promise<void> {
    const { group, canonicalTarget, state } = args;
    const safetyEdits = group.edits;
    const safetyExtraContent: string[] =
        group.topology?.kind === "add" && typeof group.topology.content === "string"
            ? [group.topology.content]
            : [];
    const safetyResult = await checkEditSafety(canonicalTarget, safetyEdits, undefined, safetyExtraContent);
    if (safetyResult.warnings.length > 0) {
        // Surface warnings as advisory check records
        for (const w of safetyResult.warnings) {
            state.checks.advisory.push(makeCheck("risk-warning", "pass", w));
        }
    }
}

interface PersistContentArgs {
    readonly group: EditGroup;
    readonly canonicalTarget: string;
    readonly currentContent: string;
    readonly newContent: string;
    readonly isNewFileGroup: boolean;
    readonly toolCallId: string;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly resource: InspectedResource;
    readonly transaction: EditTransaction;
    readonly state: GroupApplicationState;
}

export type PersistContentResult =
    | { ok: true }
    | { ok: false; result: PatchResult; rollbackInfo: { ok: boolean; reason?: string } };

/** Content-group persistence: conditional transaction.write (unchanged
 *  content skips the write except for new files; topology-only rename has
 *  nothing new to persist before the rename below). Write failure rolls back
 *  IMMEDIATELY and returns its rollbackInfo so the caller marks
 *  committed=true — distinct from every other failure path, which leaves the
 *  transaction open for the outer finally. */
export async function persistContentGroup(args: PersistContentArgs): Promise<PersistContentResult> {
    const { group, canonicalTarget, currentContent, newContent, isNewFileGroup, toolCallId, evidenceRefForDetails, resource, transaction, state } = args;
    const { checks, diagnostics, usedEvidence, invalidations } = state;
    // Atomic write. Skipped when content is unchanged (a
    // topology-only rename with no text edits) — there is nothing
    // new to persist at canonicalTarget before the rename below
    // moves the file to its destination. New files are always written
    // even if empty.
    try {
        if (newContent !== currentContent || isNewFileGroup) {
            // Ensure parent directory exists before atomic write
            await fsMkdir(pathDirname(canonicalTarget), { recursive: true });
            await transaction.write(canonicalTarget, newContent);
        }
    } catch (err) {
        diagnostics.push(`write failed: ${err instanceof Error ? err.message : String(err)}`);
        const rollback = await transaction.rollback();
        const rollbackInfo = buildRollbackInfo(transaction.transactionId, rollback);
        return {
            ok: false,
            result: {
                content: [{ type: "text" as const, text: `failed: write ${group.rawPath}` }],
                details: makeFailed(toolCallId, "write", `write failed: ${group.rawPath}`, {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [resource.resourceId],
                }, checks, diagnostics, usedEvidence, invalidations, rollbackInfo),
            },
            rollbackInfo,
        };
    }
    return { ok: true };
}

interface PendingInvalidationArgs {
    readonly group: EditGroup;
    readonly newContent: string;
    readonly currentSha: string;
    readonly resource: InspectedResource;
    readonly state: GroupApplicationState;
}

/** Immediate invalidation record on success — before post-write verify, so
 *  every later failure path reports the file as actually changed on disk.
 *  Returns the new content SHA for downstream rename evidence. */
export function recordPendingInvalidation(args: PendingInvalidationArgs): { newSha: string } {
    const { group, newContent, currentSha, resource, state } = args;
    // Fix #3: record the invalidation right after the write, before
    // post-write verify. This way, every later failure path
    // (including post-write read/hash failures) reports the file
    // as actually changed on disk.
    const newSha = sha256OfString(newContent);
    const pendingInvalidation: ResourceInvalidation = {
        resourceId: resource.resourceId,
        canonicalPath: resource.canonicalPath,
        fullFileSha256: currentSha,
        // A rename removes this source path; its destination gets a
        // separate post-rename invalidation below.
        ...(group.topology?.kind === "rename" ? {} : { newFullFileSha256: newSha }),
        coverage: resource.coverage,
    };
    state.invalidations.push(pendingInvalidation);
    return { newSha };
}

interface VerifyPersistedArgs {
    readonly group: EditGroup;
    readonly canonicalTarget: string;
    readonly newContent: string;
    readonly toolCallId: string;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly resource: InspectedResource;
    readonly verifiers: ReadonlyArray<VerificationCheck>;
    readonly state: GroupApplicationState;
}

export type VerifyPersistedResult =
    | { ok: true; postContent: string; postSha: string }
    | { ok: false; result: PatchResult };

/** Postwrite verification: stat, read, in-memory-vs-on-disk SHA equality
 *  check, postwrite verifier loop with blocking-postwrite-failure mapping. */
export async function verifyPersistedGroup(args: VerifyPersistedArgs): Promise<VerifyPersistedResult> {
    const { group, canonicalTarget, newContent, toolCallId, evidenceRefForDetails, resource, verifiers, state } = args;
    const { checks, diagnostics, usedEvidence, invalidations } = state;
    // Post-write verify.
    let postContent: string;
    try {
        const statRes = await fsStat(canonicalTarget);
        void statRes;
        postContent = await safeReadUtf8(canonicalTarget);
    } catch (err) {
        diagnostics.push(`verify read failed: ${err instanceof Error ? err.message : String(err)}`);
        return {
            ok: false,
            result: {
                content: [{ type: "text" as const, text: `failed: verify ${group.rawPath}` }],
                details: makeFailed(toolCallId, "verify", `post-write read failed: ${group.rawPath}`, {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [resource.resourceId],
                }, checks, diagnostics, usedEvidence, invalidations),
            },
        };
    }
    const postSha = sha256OfString(postContent);
    const postVerifySha = sha256OfString(newContent);
    if (postSha !== postVerifySha) {
        diagnostics.push(`verify mismatch: in-memory ${postVerifySha} != on-disk ${postSha} for ${canonicalTarget}`);
        return {
            ok: false,
            result: {
                content: [{ type: "text" as const, text: `failed: verify ${group.rawPath}` }],
                details: makeFailed(toolCallId, "verify", `post-write hash mismatch: ${group.rawPath}`, {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [resource.resourceId],
                }, checks, diagnostics, usedEvidence, invalidations),
            },
        };
    }

    // Post-write checks execute under transaction lock (this runs
    // before commit()); blocking failure rolls back. Wrapped in the
    // same timeout mechanism as the pre-commit loop so a hung
    // post-write verifier cannot hold the transaction lock forever
    // — a timeout here is treated exactly like a blocking failure.
    for (const v of verifiers.filter((candidate) => candidate.phase === "postwrite")) {
        const { outcome, detail } = await runVerifierCheck(v, { path: canonicalTarget, content: postContent, toolCallId });
        const check = makeCheck(`${v.id}:${group.rawPath}`, outcome, detail);
        checks.completed.push(check);
        if (v.kind === "advisory") checks.advisory.push(check);
        else checks.blocking.push(check);
        if (isBlockingPostwriteFailure(v.kind, outcome)) {
            diagnostics.push(`blocking post-write check failed: ${check.id}`);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `failed: post-write check (${group.rawPath})` }],
                    details: makeFailed(toolCallId, "verify", `blocking post-write check failed: ${group.rawPath}`, {
                        inspectionId: evidenceRefForDetails.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, diagnostics, usedEvidence, invalidations),
                },
            };
        }
    }
    return { ok: true, postContent, postSha };
}

interface FinalizeGroupArgs {
    readonly group: EditGroup;
    readonly canonicalTarget: string;
    readonly displayPath: string;
    readonly hasTextEdits: boolean;
    readonly currentContent: string;
    readonly currentSha: string;
    readonly postContent: string;
    readonly postSha: string;
    readonly postimageLineRanges: ReadonlyArray<LineRange>;
    readonly toolCallId: string;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly resource: InspectedResource;
    readonly cwd: string;
    readonly transaction: EditTransaction;
    readonly canonicalTxPath: (absolutePath: string) => string;
    readonly state: GroupApplicationState;
    readonly stream: (text: string) => void;
}

export type FinalizeGroupResult =
    | { ok: true; canonicalTarget: string; displayPath: string }
    | { ok: false; result: PatchResult };

/** Finalize group success: optional rename (canonical/display-path
 *  rebasing), destination invalidation, post-edit evidence, final-success
 *  file input construction, diff, applied path/canonical/summary
 *  bookkeeping, success progress event. */
export async function finalizeGroupSuccess(args: FinalizeGroupArgs): Promise<FinalizeGroupResult> {
    const { group, canonicalTarget: incomingCanonical, displayPath: incomingDisplay, hasTextEdits, currentContent, postContent, postSha, postimageLineRanges, toolCallId, evidenceRefForDetails, resource, cwd, transaction, canonicalTxPath, state, stream } = args;
    const { diagnostics, usedEvidence, invalidations, postEditEvidenceByPath, finalizedFiles, appliedFiles, appliedCanonical, appliedSummaries, displayDiffs } = state;
    const { checks } = state;
    let canonicalTarget = incomingCanonical;
    let displayPath = incomingDisplay;
    if (group.topology?.kind === "rename") {
        try {
            await transaction.rename(
                canonicalTxPath(pathResolve(cwd, group.topology.oldPath)),
                canonicalTxPath(pathResolve(cwd, group.topology.newPath)),
            );
        } catch (err) {
            diagnostics.push(`rename failed: ${err instanceof Error ? err.message : String(err)}`);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `failed: rename ${group.rawPath}` }],
                    details: makeFailed(toolCallId, "write", `rename failed: ${group.rawPath}`, {
                        inspectionId: evidenceRefForDetails.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, diagnostics, usedEvidence, invalidations),
                },
            };
        }
        // The old path no longer exists on disk. Every downstream
        // use — post-edit evidence, finalizedFiles (and therefore
        // the LSP/compiler finalization lanes), the displayed diff
        // path, and the applied-file lists — must reference the
        // file at its NEW location, not the deleted old path.
        const renamedAbsolute = pathResolve(cwd, group.topology.newPath);
        try {
            canonicalTarget = realpathSync(renamedAbsolute);
        } catch {
            canonicalTarget = renamedAbsolute;
        }
        displayPath = group.topology.newPath;
        // SmartRead consumes changedResources as the authoritative
        // cache/LSP invalidation protocol. Both rename endpoints may
        // have prior cached state, so report destination explicitly.
        invalidations.push({
            resourceId: resource.resourceId,
            canonicalPath: canonicalTarget,
            fullFileSha256: args.currentSha,
            newFullFileSha256: postSha,
            coverage: resource.coverage,
        });
    }

    const newLines = postContent.split("\n");
    const postEditEvidence = {
        fullFileSha256: postSha,
        lineCount: newLines.length,
        byteLength: Buffer.byteLength(postContent, "utf8"),
    };
    postEditEvidenceByPath.set(canonicalTarget, postEditEvidence);
    finalizedFiles.push({
        path: canonicalTarget,
        oldContent: currentContent,
        content: postContent,
        // Postimage ranges: paired with post-edit `postContent` so
        // downstream consumers (index.ts's lineRangeToOffsets) scope
        // diagnostics/evidence against the same coordinate space as
        // the content itself, not the pre-edit line numbering.
        changedLineRanges: postimageLineRanges,
    });
    const generatedDiff = generateDiffString(currentContent, postContent).diff;
    displayDiffs.push({ path: displayPath, diff: generatedDiff });
    appliedFiles.push(displayPath);
    appliedCanonical.push(canonicalTarget);
    appliedSummaries.push(
        !hasTextEdits && group.topology?.kind === "add" ? `add of ${displayPath}`
            : !hasTextEdits && group.topology?.kind === "rename" ? `rename of ${group.rawPath} to ${displayPath}`
                : `${group.edits.length} edit(s) to ${displayPath}`,
    );
    stream(`  ✓ wrote ${displayPath}`);
    return { ok: true, canonicalTarget, displayPath };
}

/** Outer per-group driver: placeholder-skip + progress + preimage/plan/
 *  repair dispatch, then the write/verify/finalize pipeline above in exact
 *  order. Delete groups resolve inside planGroupMutation ("deleted") and
 *  return early here — the delete lane is owned by group-planning.js. */
export async function executeEditGroup(args: ExecuteEditGroupArgs): Promise<ExecuteEditGroupResult> {
    const { context, state, group, outcome } = args;
    const { deps, ctx, toolCallId, evidenceRefForDetails, canonicalRoot, envelope, priorStore, newFileCanonicals, transaction, canonicalTxPath, stream } = context;
    const { checks, diagnostics, usedEvidence, invalidations } = state;
    // Skip bookkeeping placeholders (e.g. rename destination paths) that have
    // no text edits and no topology — nothing to apply.
    if (group.edits.length === 0 && !group.topology) return { status: "applied" };

    stream(`  ${group.rawPath} — ${group.edits.length} edit(s)`);

    const preimage = await resolveAuthorizedGroupPreimage({
        group,
        newFileCanonicals,
        priorStore,
        envelope,
        evidenceRefForDetails,
        canonicalRoot,
        toolCallId,
        checks,
        diagnostics,
        usedEvidence,
        invalidations,
    });
    if (!preimage.ok) return { status: "terminal", result: preimage.result };
    let canonicalTarget = preimage.canonicalTarget;
    const isNewFileGroup = preimage.isNewFileGroup;
    const resource = preimage.resource;
    const currentContent = preimage.currentContent;
    const currentSha = preimage.currentSha;
    const usedPriorAuthority = preimage.usedPriorAuthority;
    // Display/applied path for this group; reassigned to the new
    // path after a successful rename so downstream diffs, applied
    // lists, and finalization all reference where the file now
    // lives (the old path no longer exists once renamed).
    const displayPath: string = group.rawPath;

    const planned = await planGroupMutation({
        group,
        canonicalTarget,
        resource,
        currentContent,
        currentSha,
        isNewFileGroup,
        usedPriorAuthority,
        deps,
        evidenceRefForDetails,
        toolCallId,
        checks,
        diagnostics,
        usedEvidence,
        invalidations,
        transaction,
        canonicalTxPath,
        displayPath,
        appliedFiles: state.appliedFiles,
        appliedCanonical: state.appliedCanonical,
        appliedSummaries: state.appliedSummaries,
        displayDiffs: state.displayDiffs,
        stream,
    });
    if (!planned.ok) return { status: "terminal", result: planned.result };
    if (planned.kind === "deleted") return { status: "deleted" };
    const hasTextEdits = group.edits.length > 0;
    let newContent = planned.newContent;
    const preimageLineRanges = planned.preimageLineRanges;
    const postimageLineRanges = planned.postimageLineRanges;

    const repaired = await applyAuthorizedRepair({
        canonicalTarget,
        content: newContent,
        preimageLineRanges,
        postimageLineRanges,
        resource,
        rawPath: group.rawPath,
        deps,
        cwd: ctx.cwd,
        checks,
        diagnostics,
        repairsByPath: state.repairsByPath,
    });
    newContent = repaired.content;

    // Fetched once per group, after repair, and reused for both the
    // prewrite and postwrite phases below — the same call the original
    // inline code made once; do not re-fetch per phase.
    const verifiers = deps.getVerificationChecks?.() ?? [];

    const prewriteRejection = await runPrewriteVerifiers({
        verifiers,
        group,
        canonicalTarget,
        newContent,
        toolCallId,
        evidenceRefForDetails,
        resource,
        state,
    });
    if (prewriteRejection) return { status: "terminal", result: prewriteRejection };

    const freshnessRejection = await recheckPrewriteFreshness({
        group,
        canonicalTarget,
        currentSha,
        isNewFileGroup,
        toolCallId,
        evidenceRefForDetails,
        resource,
        state,
    });
    if (freshnessRejection) return { status: "terminal", result: freshnessRejection };

    await runContentSafetyAdvisory({ group, canonicalTarget, state });

    const persisted = await persistContentGroup({
        group,
        canonicalTarget,
        currentContent,
        newContent,
        isNewFileGroup,
        toolCallId,
        evidenceRefForDetails,
        resource,
        transaction,
        state,
    });
    if (!persisted.ok) {
        // Write failure ONLY: immediate rollback already happened inside;
        // mark committed so the outer finally skips its own rollback.
        outcome.committed = true;
        outcome.rollbackInfo = persisted.rollbackInfo;
        return { status: "terminal", result: persisted.result };
    }

    recordPendingInvalidation({ group, newContent, currentSha, resource, state });

    const verified = await verifyPersistedGroup({
        group,
        canonicalTarget,
        newContent,
        toolCallId,
        evidenceRefForDetails,
        resource,
        verifiers,
        state,
    });
    if (!verified.ok) return { status: "terminal", result: verified.result };

    const finalized = await finalizeGroupSuccess({
        group,
        canonicalTarget,
        displayPath,
        hasTextEdits,
        currentContent,
        currentSha,
        postContent: verified.postContent,
        postSha: verified.postSha,
        postimageLineRanges,
        toolCallId,
        evidenceRefForDetails,
        resource,
        cwd: ctx.cwd,
        transaction,
        canonicalTxPath,
        state,
        stream,
    });
    if (!finalized.ok) return { status: "terminal", result: finalized.result };
    canonicalTarget = finalized.canonicalTarget;
    void canonicalTarget;
    return { status: "applied" };
}
