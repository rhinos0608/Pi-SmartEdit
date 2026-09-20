/**
 * Patch group planning — per-group preimage authorization, candidate
 * mutation planning, and advisory repair integration. Pure move: verbatim
 * from src/patch.ts (per-group loop body inside createPatchTool.execute),
 * no logic change. The orchestrator keeps the delete/write dispatch,
 * verifiers, and finalization.
 *
 * Must NOT add path-containment gates; must NOT touch checkEditSafety
 * risk-warning wiring (advisory only). Slice-based text replacement below
 * is intentional — never use String.prototype.replace with variable
 * replacement text ($-patterns would be interpreted).
 */
import { realpathSync } from "node:fs";
import {
    sha256OfString,
    type EvidenceRef,
    type InspectedResource,
    type LineRange,
    type ResourceInvalidation,
    type WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";
import { generateDiffString } from "../core/edit-diff.js";
import { checkEditSafety } from "../safety/approval-gating.js";
import { planTextEdits } from "../core/edit-planner.js";
import { MatchError } from "../core/errors.js";
import type { EditItem } from "../core/types.js";
import type { RepairLoopResult } from "../verification/repair-loop.js";
import {
    authorizeResource,
    checkResourceCoverage,
    findResourceForCanonicalPath,
    isValidFullFileSha256,
} from "../context/patch-authorization.js";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";
import type { MutationToolIdentity } from "../mutation/types.js";
import type { EditTransaction } from "../mutation/edit-transaction.js";
import { safeReadUtf8 } from "./request-prep.js";
import { makeCheck, makeFailed, makeRejected } from "./result-builders.js";
import { mapRepairSpanToPreimage, changedLineRanges } from "./repair-spans.js";
import type {
    EditGroup,
    MutableChecks,
    PatchDisplayDiff,
    PatchResult,
    PatchToolDeps,
} from "./types.js";

export interface ResolveAuthorizedGroupPreimageArgs {
    readonly group: EditGroup;
    readonly createdPaths: ReadonlySet<string>;
    readonly tool: MutationToolIdentity;
    readonly priorStore: PriorAuthorityStore | null;
    readonly envelope: WorkspaceEvidenceEnvelope | null;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly canonicalRoot: string;
    readonly toolCallId: string;
    readonly checks: MutableChecks;
    readonly diagnostics: string[];
    readonly usedEvidence: string[];
    readonly invalidations: ReadonlyArray<ResourceInvalidation>;
}

export type AuthorizedGroupPreimage =
    | {
        ok: true;
        canonicalTarget: string;
        isNewFileGroup: boolean;
        resource: InspectedResource;
        currentContent: string;
        currentSha: string;
        usedPriorAuthority: boolean;
    }
    | { ok: false; result: PatchResult };

interface CanonicalizedTarget {
    canonicalTarget: string;
    isNewFileGroup: boolean;
}

function failedResult(
    toolCallId: string,
    stage: "stage" | "write" | "verify",
    message: string,
    evidenceRef: EvidenceRef,
    checks: MutableChecks,
    diagnostics: string[],
    usedEvidence: string[],
    invalidations: ReadonlyArray<ResourceInvalidation>,
    text: string,
    tool: MutationToolIdentity = "edit",
): PatchResult {
    return {
        content: [{ type: "text" as const, text }],
        details: makeFailed(toolCallId, stage, message, evidenceRef, checks, diagnostics, usedEvidence, invalidations, undefined, tool),
    };
}

function rejectedResult(
    toolCallId: string,
    reason: "stale" | "coverage" | "conflict" | "approval" | "session",
    evidenceRef: EvidenceRef,
    checks: MutableChecks,
    diagnostics: string[],
    usedEvidence: string[],
    invalidations: ReadonlyArray<ResourceInvalidation>,
    text: string,
    tool: MutationToolIdentity = "edit",
): PatchResult {
    return {
        content: [{ type: "text" as const, text }],
        details: makeRejected(toolCallId, reason, diagnostics, evidenceRef, checks, usedEvidence, invalidations, tool),
    };
}

/** Canonicalize the group target. Synthesized new-files skip realpath. */
function canonicalizeGroupTarget(
    group: EditGroup,
    createdPaths: ReadonlySet<string>,
): { ok: true; value: CanonicalizedTarget } | { ok: false; message: string } {
    if (createdPaths.has(group.absolutePath)) {
        return { ok: true, value: { canonicalTarget: group.absolutePath, isNewFileGroup: true } };
    }
    try {
        return { ok: true, value: { canonicalTarget: realpathSync(group.absolutePath), isNewFileGroup: false } };
    } catch {
        return { ok: false, message: `file not found: ${group.absolutePath}` };
    }
}

/**
 * Select authority: a strong prior authority wins; otherwise fall back to
 * the envelope resource. A selected prior grant is never overridden by
 * caller evidenceRef and never falls back to full-file auto-inspection.
 */
function selectGroupAuthority(
    canonicalTarget: string,
    isNewFileGroup: boolean,
    priorStore: PriorAuthorityStore | null,
    envelope: WorkspaceEvidenceEnvelope | null,
    evidenceRefForDetails: EvidenceRef,
): { ok: true; resource: InspectedResource; usedPriorAuthority: boolean } | { ok: false; kind: "no-authority" | "no-resource"; detail: string } {
    if (priorStore && !isNewFileGroup) {
        const prior = priorStore.select(canonicalTarget);
        if (prior !== null) return { ok: true, resource: prior, usedPriorAuthority: true };
    }
    if (!envelope) {
        return { ok: false, kind: "no-authority", detail: `coverage: no prior authority and no envelope for ${canonicalTarget}` };
    }
    const resource = findResourceForCanonicalPath(
        envelope,
        canonicalTarget,
        evidenceRefForDetails.resourceIds,
    );
    if (!resource) {
        return { ok: false, kind: "no-resource", detail: `coverage: no resource in envelope for ${canonicalTarget}` };
    }
    return { ok: true, resource, usedPriorAuthority: false };
}

/** Authorize the selected resource. Delete/rename groups require full evidence. */
function authorizeGroupResource(
    group: EditGroup,
    resource: InspectedResource,
    canonicalTarget: string,
    canonicalRoot: string,
): { ok: true } | { ok: false; reason: string } {
    const requiresFullEvidence = group.topology?.kind === "delete" || group.topology?.kind === "rename";
    const authorization = authorizeResource({
        resources: [resource],
        canonicalPath: canonicalTarget,
        canonicalWorkspaceRoot: canonicalRoot,
        requestedResourceIds: [resource.resourceId],
        targetRanges: [],
        requireFull: requiresFullEvidence,
    });
    if (!authorization.ok) return { ok: false, reason: authorization.reason };
    return { ok: true };
}

/** Read the preimage content. Synthesized new-files read as empty. */
async function readGroupPreimage(
    canonicalTarget: string,
    isNewFileGroup: boolean,
): Promise<{ ok: true; content: string; sha: string } | { ok: false; message: string }> {
    if (isNewFileGroup) {
        // Synthesized new-file: the file does not exist on disk yet.
        // We treat current content as empty so the rest of the pipeline
        // (in-memory apply + verifiers + atomicWrite) operates as if the
        // file currently contains the empty string. Empty oldText is
        // expected to find its match at the start of the empty content.
        return { ok: true, content: "", sha: sha256OfString("") };
    }
    try {
        const currentContent = await safeReadUtf8(canonicalTarget);
        return { ok: true, content: currentContent, sha: sha256OfString(currentContent) };
    } catch (err) {
        return { ok: false, message: `read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
}

/**
 * Freshness check. A selected prior line-range authority REQUIRES
 * a freshness hash; missing SHA rejects rather than silently
 * skipping freshness. A selected prior grant never falls back to
 * full-file auto-inspection on staleness.
 */
function validatePreimageFreshness(
    resource: InspectedResource,
    currentSha: string,
    canonicalTarget: string,
): { ok: true } | { ok: false; kind: "missing-sha" | "stale"; detail: string } {
    if (!isValidFullFileSha256(resource.fullFileSha256)) {
        return {
            ok: false,
            kind: "missing-sha",
            detail: `coverage: missing or malformed fullFileSha256 for ${canonicalTarget}; read the file again before editing`,
        };
    }
    if (resource.fullFileSha256 !== currentSha) {
        return {
            ok: false,
            kind: "stale",
            detail: `stale: current sha ${currentSha} != attested ${resource.fullFileSha256} for ${canonicalTarget}`,
        };
    }
    return { ok: true };
}

/** Authorized preimage resolution: existing/new target canonicalization,
 *  prior-authority-first selection, full-file requirement for delete/rename
 *  groups, resource authorization/coverage check, preimage read, SHA validity
 *  + freshness check. Returns terminal PatchResult on failure. */
export async function resolveAuthorizedGroupPreimage(
    args: ResolveAuthorizedGroupPreimageArgs,
): Promise<AuthorizedGroupPreimage> {
    const { group, createdPaths, tool, priorStore, envelope, evidenceRefForDetails, canonicalRoot, toolCallId, checks, diagnostics, usedEvidence, invalidations } = args;
    // Resolve canonical path for this group.
    const canonicalized = canonicalizeGroupTarget(group, createdPaths);
    if (!canonicalized.ok) {
        diagnostics.push(canonicalized.message);
        return {
            ok: false,
            result: failedResult(toolCallId, "stage", `file not found: ${group.rawPath}`, {
                ...evidenceRefForDetails,
                resourceIds: [""],
            }, checks, diagnostics, usedEvidence, invalidations, `failed: file not found: ${group.rawPath}`, tool),
        };
    }
    const { canonicalTarget, isNewFileGroup } = canonicalized.value;

    const selected = selectGroupAuthority(canonicalTarget, isNewFileGroup, priorStore, envelope, evidenceRefForDetails);
    if (!selected.ok) {
        diagnostics.push(selected.detail);
        const text = selected.kind === "no-authority"
            ? `rejected: coverage (no authority for ${group.rawPath})`
            : `rejected: coverage (no resource for ${group.rawPath})`;
        return { ok: false, result: rejectedResult(toolCallId, "coverage", evidenceRefForDetails, checks, diagnostics, usedEvidence, invalidations, text) };
    }
    const { resource, usedPriorAuthority } = selected;

    const authorization = authorizeGroupResource(group, resource, canonicalTarget, canonicalRoot);
    if (!authorization.ok) {
        diagnostics.push(`${authorization.reason} for ${canonicalTarget} (path-mode inspect this file first)`, tool);
        return {
            ok: false,
            result: rejectedResult(toolCallId, "coverage", {
                inspectionId: evidenceRefForDetails.inspectionId,
                resourceIds: [resource.resourceId],
            }, checks, diagnostics, usedEvidence, invalidations, `rejected: coverage (weak evidence for ${group.rawPath})`, tool),
        };
    }
    usedEvidence.push(resource.resourceId);

    // Read current content + compute sha.
    const preimage = await readGroupPreimage(canonicalTarget, isNewFileGroup);
    if (!preimage.ok) {
        diagnostics.push(preimage.message);
        return {
            ok: false,
            result: failedResult(toolCallId, "stage", `read failed: ${group.rawPath}`, {
                inspectionId: evidenceRefForDetails.inspectionId,
                resourceIds: [resource.resourceId],
            }, checks, diagnostics, usedEvidence, invalidations, `failed: read ${group.rawPath}`, tool),
        };
    }
    const { content: currentContent, sha: currentSha } = preimage;

    const freshness = validatePreimageFreshness(resource, currentSha, canonicalTarget);
    if (!freshness.ok) {
        diagnostics.push(freshness.detail);
        if (freshness.kind === "missing-sha") {
            return {
                ok: false,
                result: rejectedResult(toolCallId, "coverage", {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [resource.resourceId],
                }, checks, diagnostics, usedEvidence, invalidations, `rejected: coverage (missing valid snapshot SHA for ${group.rawPath})`, tool),
            };
        }
        return {
            ok: false,
            result: rejectedResult(toolCallId, "stale", {
                inspectionId: evidenceRefForDetails.inspectionId,
                resourceIds: [resource.resourceId],
            }, checks, diagnostics, usedEvidence, invalidations, `rejected: stale (${group.rawPath})`, tool),
        };
    }

    return { ok: true, canonicalTarget, isNewFileGroup, resource, currentContent, currentSha, usedPriorAuthority };
}

export interface PlanGroupMutationArgs {
    readonly tool: MutationToolIdentity;
    readonly group: EditGroup;
    readonly canonicalTarget: string;
    readonly resource: InspectedResource;
    readonly currentContent: string;
    readonly currentSha: string;
    readonly isNewFileGroup: boolean;
    readonly usedPriorAuthority: boolean;
    readonly deps: PatchToolDeps;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly toolCallId: string;
    readonly checks: MutableChecks;
    readonly diagnostics: string[];
    readonly usedEvidence: string[];
    readonly invalidations: ResourceInvalidation[];
    readonly transaction: EditTransaction;
    readonly canonicalTxPath: (absolutePath: string) => string;
    readonly displayPath: string;
    readonly appliedFiles: string[];
    readonly appliedCanonical: string[];
    readonly appliedSummaries: string[];
    readonly displayDiffs: PatchDisplayDiff[];
    readonly stream: (text: string) => void;
}

export type PlannedGroupMutation =
    | { ok: true; kind: "deleted" }
    | {
        ok: true;
        kind: "content";
        newContent: string;
        preimageLineRanges: ReadonlyArray<LineRange>;
        postimageLineRanges: ReadonlyArray<LineRange>;
    }
    | { ok: false; result: PatchResult };

interface PlanContext {
    readonly toolCallId: string;
    readonly tool: MutationToolIdentity;
    readonly group: EditGroup;
    readonly resource: InspectedResource;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly checks: MutableChecks;
    readonly diagnostics: string[];
    readonly usedEvidence: string[];
    readonly invalidations: ResourceInvalidation[];
}

/** Reject patches combining text edits with delete topology. */
function rejectConflictingOperations(ctx: PlanContext): PlannedGroupMutation {
    ctx.diagnostics.push(`text edits combined with delete topology for ${ctx.group.rawPath}: cannot edit and delete the same file in one group`);
    return {
        ok: false,
        result: rejectedResult(ctx.toolCallId, "conflict", {
            inspectionId: ctx.evidenceRefForDetails.inspectionId,
            resourceIds: [ctx.resource.resourceId],
        }, ctx.checks, ctx.diagnostics, ctx.usedEvidence, ctx.invalidations, `rejected: conflicting operations (${ctx.group.rawPath})`, ctx.tool),
    };
}

/**
 * DELETE: there is no post-edit content to lint/typecheck.
 * Perform the delete through the shared transaction, invalidate
 * the resource, emit a diff entry, and count it in the applied
 * total/changedResources — but skip evidence/diagnostics
 * generation for this path (the reviewer's carved-out exception:
 * add/rename flow through the full pipeline below, delete does
 * not).
 */
async function runTopologyOnlyDelete(
    ctx: PlanContext,
    canonicalTarget: string,
    absolutePath: string,
    currentContent: string,
    currentSha: string,
    transaction: EditTransaction,
    canonicalTxPath: (absolutePath: string) => string,
    displayPath: string,
    appliedFiles: string[],
    appliedCanonical: string[],
    appliedSummaries: string[],
    displayDiffs: PatchDisplayDiff[],
    stream: (text: string) => void,
): Promise<PlannedGroupMutation> {
    // Advisory risk-warning check for topology-only delete
    // (path warnings). Non-blocking — delete proceeds regardless.
    const safetyResult = await checkEditSafety(canonicalTarget, [], undefined, []);
    if (safetyResult.warnings.length > 0) {
        for (const w of safetyResult.warnings) {
            ctx.checks.advisory.push(makeCheck("risk-warning", "pass", w));
        }
    }
    try {
        await transaction.remove(canonicalTxPath(absolutePath));
    } catch (err) {
        // Return a write-phase failure so the outer finally still
        // runs the transaction rollback for any earlier mutations.
        ctx.diagnostics.push(`topology delete failed: ${err instanceof Error ? err.message : String(err)}`);
        return {
            ok: false,
            result: failedResult(ctx.toolCallId, "write", `delete failed: ${ctx.group.rawPath}`, {
                inspectionId: ctx.evidenceRefForDetails.inspectionId,
                resourceIds: [ctx.resource.resourceId],
            }, ctx.checks, ctx.diagnostics, ctx.usedEvidence, ctx.invalidations, `failed: delete ${ctx.group.rawPath}`, ctx.tool),
        };
    }
    ctx.invalidations.push({
        resourceId: ctx.resource.resourceId,
        canonicalPath: ctx.resource.canonicalPath,
        fullFileSha256: currentSha,
        coverage: ctx.resource.coverage,
    });
    const generatedDiff = generateDiffString(currentContent, "").diff;
    displayDiffs.push({ path: displayPath, diff: generatedDiff });
    appliedFiles.push(displayPath);
    appliedCanonical.push(canonicalTarget);
    appliedSummaries.push(`delete of ${displayPath}`);
    stream(`  ✓ deleted ${displayPath}`);
    return { ok: true, kind: "deleted" };
}

/** ADD groups skip the planner — content is already fully determined. */
function buildAddCandidate(content: string): { newContent: string; postimageLineRanges: ReadonlyArray<LineRange> } {
    return {
        newContent: content,
        postimageLineRanges: [{ startLine: 1, endLine: Math.max(1, content.split("\n").length) }],
    };
}

type ClassicComposeResult =
    | { ok: true; newContent: string; preimageLineRanges: ReadonlyArray<LineRange>; postimageLineRanges: ReadonlyArray<LineRange> }
    | { ok: false; result: PatchResult };

/**
 * New-file creation via oldText:"": the empty oldText is implicit
 * at offset 0 of the (empty) current content. applyEdits rejects
 * empty oldText, so this path stays separate. A new-file group
 * built from a transfer op carries a hashline (append_file) edit
 * instead, which falls through to the planTextEdits branch below
 * (it operates on `currentContent` generically and needs no
 * special-casing for an empty starting file).
 */
function composeNewFileClassic(ctx: PlanContext, currentContent: string): ClassicComposeResult {
    let newContent = currentContent;
    for (const edit of ctx.group.edits) {
        if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
            // Pre-write: input shape problem. No file write happened.
            ctx.diagnostics.push(`edit missing oldText/newText in ${ctx.group.rawPath}`);
            return {
                ok: false,
                result: failedResult(ctx.toolCallId, "stage", `edit missing oldText/newText: ${ctx.group.rawPath}`, {
                    inspectionId: ctx.evidenceRefForDetails.inspectionId,
                    resourceIds: [ctx.resource.resourceId],
                }, ctx.checks, ctx.diagnostics, ctx.usedEvidence, ctx.invalidations, `failed: edit (missing fields) in ${ctx.group.rawPath}`, ctx.tool),
            };
        }
        if (!newContent.includes(edit.oldText)) {
            ctx.diagnostics.push(`oldText not found in composed buffer for ${ctx.group.rawPath}`);
            return {
                ok: false,
                result: failedResult(ctx.toolCallId, "stage", `oldText not found: ${ctx.group.rawPath}`, {
                    inspectionId: ctx.evidenceRefForDetails.inspectionId,
                    resourceIds: [ctx.resource.resourceId],
                }, ctx.checks, ctx.diagnostics, ctx.usedEvidence, ctx.invalidations, `failed: edit (oldText not found) in ${ctx.group.rawPath}`, ctx.tool),
            };
        }
        if (edit.replaceAll) {
            newContent = newContent.split(edit.oldText).join(edit.newText);
        } else {
            // slice-based: safe against $-pattern interpretation in edit.newText
            const idx = newContent.indexOf(edit.oldText);
            if (idx >= 0) {
                newContent = newContent.slice(0, idx) + edit.newText + newContent.slice(idx + edit.oldText.length);
            }
        }
    }
    return {
        ok: true,
        newContent,
        preimageLineRanges: [{ startLine: 1, endLine: 1 }],
        postimageLineRanges: [{ startLine: 1, endLine: Math.max(1, newContent.split("\n").length) }],
    };
}

type NormalPlanResult =
    | { ok: true; newContent: string; preimageLineRanges: ReadonlyArray<LineRange>; postimageLineRanges: ReadonlyArray<LineRange> }
    | { ok: false; result: PatchResult };

/** Normal text planning through the shared planner; maps MatchError to rejected/failed. */
async function planNormalTextEdits(
    ctx: PlanContext,
    currentContent: string,
    canonicalTarget: string,
    deps: PatchToolDeps,
): Promise<NormalPlanResult> {
    try {
        const planned = await planTextEdits({
            content: currentContent,
            edits: ctx.group.edits as EditItem[],
            filePath: canonicalTarget,
            astResolver: deps.getAstResolver?.() ?? null,
            structuralResolver: deps.getStructuralResolver?.() ?? null,
            getSnapshot: deps.getSnapshot ?? (() => null),
        });
        for (const note of planned.matchNotes) ctx.diagnostics.push(note);
        return {
            ok: true,
            newContent: planned.newContent,
            preimageLineRanges: planned.preimageLineRanges,
            postimageLineRanges: planned.postimageLineRanges,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.diagnostics.push(msg);
        const matchCode = err instanceof MatchError ? err.code : null;
        const message = matchCode === "NOT_FOUND"
            ? `failed: target not found in ${ctx.group.rawPath}; re-inspect the file and retry with current exact text`
            : matchCode === "AMBIGUOUS"
                ? `failed: ambiguous edit in ${ctx.group.rawPath}; provide more surrounding context, add target/lineRange scope, or use replaceAll`
                : `failed: edit (${ctx.group.rawPath})`;
        return {
            ok: false,
            result: {
                content: [{ type: "text" as const, text: message }],
                details: {
                    ...makeFailed(ctx.toolCallId, "stage", `edit planning failed: ${ctx.group.rawPath}`, {
                        inspectionId: ctx.evidenceRefForDetails.inspectionId,
                        resourceIds: [ctx.resource.resourceId],
                    }, ctx.checks, ctx.diagnostics, ctx.usedEvidence, ctx.invalidations, undefined, ctx.tool),
                    ...(matchCode === "NOT_FOUND" || matchCode === "AMBIGUOUS" ? { matchFailure: matchCode } : {}),
                },
            },
        };
    }
}

/**
 * Authorize using ACTUAL resolved spans (not an exact oldText
 * lookup), so fuzzy/scoped matches authorize correctly and cannot
 * escape prior line-range authority. For replaceAll, every actual
 * span is authorized.
 */
function rejectUncoveredSpans(
    ctx: PlanContext,
    canonicalTarget: string,
    preimageLineRanges: ReadonlyArray<LineRange>,
    usedPriorAuthority: boolean,
): PlannedGroupMutation | null {
    const coverageError = checkResourceCoverage(ctx.resource, preimageLineRanges);
    if (!coverageError) return null;
    ctx.diagnostics.push(`${coverageError} for ${canonicalTarget}`);
    if (usedPriorAuthority) {
        ctx.diagnostics.push(`coverage: prior authority is line-range for ${canonicalTarget}; a fresh full-file read is required to widen authority`);
    }
    return {
        ok: false,
        result: rejectedResult(ctx.toolCallId, "coverage", {
            inspectionId: ctx.evidenceRefForDetails.inspectionId,
            resourceIds: [ctx.resource.resourceId],
        }, ctx.checks, ctx.diagnostics, ctx.usedEvidence, ctx.invalidations, `rejected: coverage (${ctx.group.rawPath})`, ctx.tool),
    };
}

/** Candidate mutation planning: dispatches on group shape — text+delete
 *  conflict rejection, delete discriminant (executed here through the shared
 *  transaction), add candidate, topology-only rename candidate, new-file
 *  classic edit composition, or the normal planTextEdits call; maps
 *  MatchError to a rejected/failed result; validates the planner's resolved
 *  span coverage against the authorized preimage. Returns terminal
 *  PatchResult on failure. */
export async function planGroupMutation(args: PlanGroupMutationArgs): Promise<PlannedGroupMutation> {
    const { tool, group, canonicalTarget, resource, currentContent, currentSha, isNewFileGroup, usedPriorAuthority, deps, evidenceRefForDetails, toolCallId, checks, diagnostics, usedEvidence, invalidations, transaction, canonicalTxPath, displayPath, appliedFiles, appliedCanonical, appliedSummaries, displayDiffs, stream } = args;
    const hasTextEdits = group.edits.length > 0;
    const ctx: PlanContext = { toolCallId, tool, group, resource, evidenceRefForDetails, checks, diagnostics, usedEvidence, invalidations };

    // Reject patches combining text edits with delete topology.
    if (hasTextEdits && group.topology?.kind === "delete") {
        return rejectConflictingOperations(ctx);
    }

    if (!hasTextEdits && group.topology?.kind === "delete") {
        return runTopologyOnlyDelete(ctx, canonicalTarget, group.absolutePath, currentContent, currentSha, transaction, canonicalTxPath, displayPath, appliedFiles, appliedCanonical, appliedSummaries, displayDiffs, stream);
    }

    // Stage edits through the planner (no writes). The planner routes
    // text edits through applyEdits (fuzzy tiers, replaceAll, AST/lineRange
    // scopes, literal $ replacement) and returns actual resolved spans.
    // ADD and topology-only RENAME groups skip the planner — their
    // content is already fully determined — but still flow through
    // the exact same write/verify/evidence/finalization machinery
    // below as a text edit would, rather than an early-exit
    // shortcut that bypasses the compiler/LSP/post-edit pipeline.
    let newContent: string;
    let preimageLineRanges: ReadonlyArray<LineRange> = [];
    let postimageLineRanges: ReadonlyArray<LineRange> = [];
    if (!hasTextEdits && group.topology?.kind === "add") {
        const add = buildAddCandidate(group.topology.content);
        newContent = add.newContent;
        postimageLineRanges = add.postimageLineRanges;
    } else if (!hasTextEdits && group.topology?.kind === "rename") {
        // Topology-only rename: content unchanged; the rename happens after post-write verify.
        newContent = currentContent;
    } else if (isNewFileGroup && group.edits.every((e) => typeof e.oldText === "string")) {
        const composed = composeNewFileClassic(ctx, currentContent);
        if (!composed.ok) return composed;
        newContent = composed.newContent;
        preimageLineRanges = composed.preimageLineRanges;
        postimageLineRanges = composed.postimageLineRanges;
    } else {
        const planned = await planNormalTextEdits(ctx, currentContent, canonicalTarget, deps);
        if (!planned.ok) return planned;
        newContent = planned.newContent;
        preimageLineRanges = planned.preimageLineRanges;
        postimageLineRanges = planned.postimageLineRanges;
    }

    const uncovered = rejectUncoveredSpans(ctx, canonicalTarget, preimageLineRanges, usedPriorAuthority);
    if (uncovered) return uncovered;

    return { ok: true, kind: "content", newContent, preimageLineRanges, postimageLineRanges };
}

export interface ApplyAuthorizedRepairArgs {
    readonly canonicalTarget: string;
    readonly content: string;
    readonly preimageLineRanges: ReadonlyArray<LineRange>;
    readonly postimageLineRanges: ReadonlyArray<LineRange>;
    readonly resource: InspectedResource;
    readonly rawPath: string;
    readonly deps: PatchToolDeps;
    readonly cwd: string;
    readonly checks: MutableChecks;
    readonly diagnostics: string[];
    readonly repairsByPath: Map<string, RepairLoopResult>;
}

/**
 * Repair confinement decision: repair ranges are computed in staged
 * (post-edit) coordinates, so they cannot be compared against the
 * resource's pre-edit allowedRanges. Map each repair span back to original
 * coordinates via the edit mapping, then require it to stay
 * within the edit's already-authorized preimage footprint.
 * Full-file grants accept any in-file repair; a repair that
 * cannot be re-authorized is skipped.
 */
function decideRepairConfinement(
    resource: InspectedResource,
    repairRanges: ReadonlyArray<LineRange>,
    preimageLineRanges: ReadonlyArray<LineRange>,
    postimageLineRanges: ReadonlyArray<LineRange>,
): boolean {
    return resource.coverage === "full-file" ||
        (repairRanges.length > 0 &&
            repairRanges.every((r) => {
                const mapped = mapRepairSpanToPreimage(r, preimageLineRanges, postimageLineRanges);
                return mapped !== null &&
                    preimageLineRanges.some((p) => mapped.startLine >= p.startLine && mapped.endLine <= p.endLine);
            }));
}

/** Advisory repair integration: runs the repair loop against the staged
 *  candidate (never fails the edit — repair rejection is advisory), maps the
 *  repair's staged output back to a preimage-relative range, confines the
 *  repair to the changed range, and records the repair check/diagnostic.
 *  Returns the original-or-repaired candidate content. */
export async function applyAuthorizedRepair(args: ApplyAuthorizedRepairArgs): Promise<{ content: string }> {
    const { canonicalTarget, content, preimageLineRanges, postimageLineRanges, resource, rawPath, deps, cwd, checks, diagnostics, repairsByPath } = args;
    // Repair is evaluated only against the in-memory candidate.
    // A successful repair is still an untrusted new mutation: compute
    // its changed preimage range and require the same evidence
    // authority before it can reach a write.
    let newContent = content;
    const repairRunner = deps.runRepair;
    const repair = repairRunner
        ? await repairRunner({ path: canonicalTarget, content: newContent, cwd }).catch((err: unknown): RepairLoopResult => ({
            passed: false,
            attempts: [],
            finalValidation: null,
            summary: `repair unavailable: ${err instanceof Error ? err.message : String(err)}`,
            repairedContent: null,
        }))
        : null;
    if (repair) {
        repairsByPath.set(canonicalTarget, repair);
        if (repair.repairedContent && repair.repairedContent !== newContent) {
            const repairRanges = changedLineRanges(newContent, repair.repairedContent);
            const confinedToPreimage = decideRepairConfinement(resource, repairRanges, preimageLineRanges, postimageLineRanges);
            if (confinedToPreimage) {
                newContent = repair.repairedContent;
                diagnostics.push(`repair: accepted staged repair for ${canonicalTarget}`);
                checks.advisory.push(makeCheck(`repair:${rawPath}`, "pass", repair.summary));
            } else {
                diagnostics.push(`repair: skipped for ${canonicalTarget}; repaired content exceeded the edit's authorized preimage range`);
                checks.advisory.push(makeCheck(`repair:${rawPath}`, "skipped", "repaired content exceeded existing evidence authority"));
            }
        } else if (!repair.passed) {
            checks.advisory.push(makeCheck(`repair:${rawPath}`, "skipped", repair.summary));
        }
    }
    return { content: newContent };
}
