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
    readonly newFileCanonicals: ReadonlySet<string>;
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

/** Authorized preimage resolution: existing/new target canonicalization,
 *  prior-authority-first selection, full-file requirement for delete/rename
 *  groups, resource authorization/coverage check, preimage read, SHA validity
 *  + freshness check. Returns terminal PatchResult on failure. */
export async function resolveAuthorizedGroupPreimage(
    args: ResolveAuthorizedGroupPreimageArgs,
): Promise<AuthorizedGroupPreimage> {
    const { group, newFileCanonicals, priorStore, envelope, evidenceRefForDetails, canonicalRoot, toolCallId, checks, diagnostics, usedEvidence, invalidations } = args;
    // Resolve canonical path for this group.
    let canonicalTarget: string;
    let isNewFileGroup = false;
    if (newFileCanonicals.has(group.absolutePath)) {
        // Synthesized new-file: there's no on-disk file to resolve, so
        // skip realpath and remember this fact for the rest of the loop.
        canonicalTarget = group.absolutePath;
        isNewFileGroup = true;
    } else {
        try {
            canonicalTarget = realpathSync(group.absolutePath);
        } catch (err) {
            diagnostics.push(`file not found: ${group.absolutePath}`);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `failed: file not found: ${group.rawPath}` }],
                    details: makeFailed(toolCallId, "stage", `file not found: ${group.rawPath}`, {
                        ...evidenceRefForDetails,
                        resourceIds: [""],
                    }, checks, diagnostics, usedEvidence, invalidations),
                },
            };
        }
    }

    // Select authority: a strong prior authority wins; otherwise
    // fall back to the envelope resource. A selected prior grant is
    // never overridden by caller evidenceRef and never falls back to
    // full-file auto-inspection.
    let resource: InspectedResource | null = null;
    let usedPriorAuthority = false;
    if (priorStore && !isNewFileGroup) {
        resource = priorStore.select(canonicalTarget);
        usedPriorAuthority = resource !== null;
    }
    if (!resource) {
        if (!envelope) {
            diagnostics.push(`coverage: no prior authority and no envelope for ${canonicalTarget}`);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `rejected: coverage (no authority for ${group.rawPath})` }],
                    details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations),
                },
            };
        }
        resource = findResourceForCanonicalPath(
            envelope,
            canonicalTarget,
            evidenceRefForDetails.resourceIds,
        );
    }
    if (!resource) {
        diagnostics.push(`coverage: no resource in envelope for ${canonicalTarget}`);
        return {
            ok: false,
            result: {
                content: [{ type: "text" as const, text: `rejected: coverage (no resource for ${group.rawPath})` }],
                details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations),
            },
        };
    }
    const requiresFullEvidence = group.topology?.kind === "delete" || group.topology?.kind === "rename";
    const authorization = authorizeResource({
        resources: [resource],
        canonicalPath: canonicalTarget,
        canonicalWorkspaceRoot: canonicalRoot,
        requestedResourceIds: [resource.resourceId],
        targetRanges: [],
        requireFull: requiresFullEvidence,
    });
    if (!authorization.ok) {
        const initialCoverageError = authorization.reason;
        diagnostics.push(`${initialCoverageError} for ${canonicalTarget} (path-mode inspect this file first)`);
        return {
            ok: false,
            result: {
                content: [{ type: "text" as const, text: `rejected: coverage (weak evidence for ${group.rawPath})` }],
                details: makeRejected(toolCallId, "coverage", diagnostics, {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [resource.resourceId],
                }, checks, usedEvidence, invalidations),
            },
        };
    }
    usedEvidence.push(resource.resourceId);

    // Read current content + compute sha.
    let currentContent: string;
    let currentSha: string;
    if (isNewFileGroup) {
        // Synthesized new-file: the file does not exist on disk yet.
        // We treat current content as empty so the rest of the pipeline
        // (in-memory apply + verifiers + atomicWrite) operates as if the
        // file currently contains the empty string. Empty oldText is
        // expected to find its match at the start of the empty content.
        currentContent = "";
        currentSha = sha256OfString("");
    } else {
        try {
            currentContent = await safeReadUtf8(canonicalTarget);
            currentSha = sha256OfString(currentContent);
        } catch (err) {
            diagnostics.push(`read failed: ${err instanceof Error ? err.message : String(err)}`);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `failed: read ${group.rawPath}` }],
                    details: makeFailed(toolCallId, "stage", `read failed: ${group.rawPath}`, {
                        inspectionId: evidenceRefForDetails.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, diagnostics, usedEvidence, invalidations),
                },
            };
        }
    }

    // Freshness check. A selected prior line-range authority REQUIRES
    // a freshness hash; missing SHA rejects rather than silently
    // skipping freshness. A selected prior grant never falls back to
    // full-file auto-inspection on staleness.
    if (!isValidFullFileSha256(resource.fullFileSha256)) {
        diagnostics.push(`coverage: missing or malformed fullFileSha256 for ${canonicalTarget}; read the file again before editing`);
        return {
            ok: false,
            result: {
                content: [{ type: "text" as const, text: `rejected: coverage (missing valid snapshot SHA for ${group.rawPath})` }],
                details: makeRejected(toolCallId, "coverage", diagnostics, {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [resource.resourceId],
                }, checks, usedEvidence, invalidations),
            },
        };
    }
    if (resource.fullFileSha256 !== currentSha) {
        diagnostics.push(`stale: current sha ${currentSha} != attested ${resource.fullFileSha256} for ${canonicalTarget}`);
        return {
            ok: false,
            result: {
                content: [{ type: "text" as const, text: `rejected: stale (${group.rawPath})` }],
                details: makeRejected(toolCallId, "stale", diagnostics, {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [resource.resourceId],
                }, checks, usedEvidence, invalidations),
            },
        };
    }

    return { ok: true, canonicalTarget, isNewFileGroup, resource, currentContent, currentSha, usedPriorAuthority };
}

export interface PlanGroupMutationArgs {
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

/** Candidate mutation planning: dispatches on group shape — text+delete
 *  conflict rejection, delete discriminant (executed here through the shared
 *  transaction), add candidate, topology-only rename candidate, new-file
 *  classic edit composition, or the normal planTextEdits call; maps
 *  MatchError to a rejected/failed result; validates the planner's resolved
 *  span coverage against the authorized preimage. Returns terminal
 *  PatchResult on failure. */
export async function planGroupMutation(args: PlanGroupMutationArgs): Promise<PlannedGroupMutation> {
    const { group, canonicalTarget, resource, currentContent, currentSha, isNewFileGroup, usedPriorAuthority, deps, evidenceRefForDetails, toolCallId, checks, diagnostics, usedEvidence, invalidations, transaction, canonicalTxPath, displayPath, appliedFiles, appliedCanonical, appliedSummaries, displayDiffs, stream } = args;
    const hasTextEdits = group.edits.length > 0;

    // Reject patches combining text edits with delete topology.
    if (hasTextEdits && group.topology?.kind === "delete") {
        diagnostics.push(`text edits combined with delete topology for ${group.rawPath}: cannot edit and delete the same file in one group`);
        return {
            ok: false,
            result: {
                content: [{ type: "text" as const, text: `rejected: conflicting operations (${group.rawPath})` }],
                details: makeRejected(toolCallId, "conflict", diagnostics, {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [resource.resourceId],
                }, checks, usedEvidence, invalidations),
            },
        };
    }

    // DELETE: there is no post-edit content to lint/typecheck.
    // Perform the delete through the shared transaction, invalidate
    // the resource, emit a diff entry, and count it in the applied
    // total/changedResources — but skip evidence/diagnostics
    // generation for this path (the reviewer's carved-out exception:
    // add/rename flow through the full pipeline below, delete does
    // not).
    if (!hasTextEdits && group.topology?.kind === "delete") {
        // Advisory risk-warning check for topology-only delete
        // (path warnings). Non-blocking — delete proceeds regardless.
        const safetyResult = await checkEditSafety(canonicalTarget, [], undefined, []);
        if (safetyResult.warnings.length > 0) {
            for (const w of safetyResult.warnings) {
                checks.advisory.push(makeCheck("risk-warning", "pass", w));
            }
        }
        try {
            await transaction.remove(canonicalTxPath(group.absolutePath));
        } catch (err) {
            // Return a write-phase failure so the outer finally still
            // runs the transaction rollback for any earlier mutations.
            diagnostics.push(`topology delete failed: ${err instanceof Error ? err.message : String(err)}`);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `failed: delete ${group.rawPath}` }],
                    details: makeFailed(toolCallId, "write", `delete failed: ${group.rawPath}`, {
                        inspectionId: evidenceRefForDetails.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, diagnostics, usedEvidence, invalidations),
                },
            };
        }
        invalidations.push({
            resourceId: resource.resourceId,
            canonicalPath: resource.canonicalPath,
            fullFileSha256: currentSha,
            coverage: resource.coverage,
        });
        const generatedDiff = generateDiffString(currentContent, "").diff;
        displayDiffs.push({ path: displayPath, diff: generatedDiff });
        appliedFiles.push(displayPath);
        appliedCanonical.push(canonicalTarget);
        appliedSummaries.push(`delete of ${displayPath}`);
        stream(`  ✓ deleted ${displayPath}`);
        return { ok: true, kind: "deleted" };
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
        newContent = group.topology.content;
        postimageLineRanges = [{ startLine: 1, endLine: Math.max(1, newContent.split("\n").length) }];
    } else if (!hasTextEdits && group.topology?.kind === "rename") {
        // Content is unchanged; the rename itself happens further
        // below (after post-write verify), which reassigns
        // canonicalTarget/displayPath to the new path before any
        // evidence/finalization records anything against it.
        newContent = currentContent;
    } else if (isNewFileGroup && group.edits.every((e) => typeof e.oldText === "string")) {
        // New-file creation via oldText:"": the empty oldText is implicit
        // at offset 0 of the (empty) current content. applyEdits rejects
        // empty oldText, so this path stays separate. A new-file group
        // built from a transfer op carries a hashline (append_file) edit
        // instead, which falls through to the planTextEdits branch below
        // (it operates on `currentContent` generically and needs no
        // special-casing for an empty starting file).
        newContent = currentContent;
        for (const edit of group.edits) {
            if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
                // Pre-write: input shape problem. No file write happened.
                diagnostics.push(`edit missing oldText/newText in ${group.rawPath}`);
                return {
                    ok: false,
                    result: {
                        content: [{ type: "text" as const, text: `failed: edit (missing fields) in ${group.rawPath}` }],
                        details: makeFailed(toolCallId, "stage", `edit missing oldText/newText: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence, invalidations),
                    },
                };
            }
            if (!newContent.includes(edit.oldText)) {
                diagnostics.push(`oldText not found in composed buffer for ${group.rawPath}`);
                return {
                    ok: false,
                    result: {
                        content: [{ type: "text" as const, text: `failed: edit (oldText not found) in ${group.rawPath}` }],
                        details: makeFailed(toolCallId, "stage", `oldText not found: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence, invalidations),
                    },
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
        preimageLineRanges = [{ startLine: 1, endLine: 1 }];
        postimageLineRanges = [{ startLine: 1, endLine: Math.max(1, newContent.split("\n").length) }];
    } else {
        try {
            const planned = await planTextEdits({
                content: currentContent,
                edits: group.edits as EditItem[],
                filePath: canonicalTarget,
                astResolver: deps.getAstResolver?.() ?? null,
                structuralResolver: deps.getStructuralResolver?.() ?? null,
                getSnapshot: deps.getSnapshot ?? (() => null),
            });
            newContent = planned.newContent;
            preimageLineRanges = planned.preimageLineRanges;
            postimageLineRanges = planned.postimageLineRanges;
            for (const note of planned.matchNotes) diagnostics.push(note);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            diagnostics.push(msg);
            const matchCode = err instanceof MatchError ? err.code : null;
            const message = matchCode === "NOT_FOUND"
                ? `failed: target not found in ${group.rawPath}; re-inspect the file and retry with current exact text`
                : matchCode === "AMBIGUOUS"
                    ? `failed: ambiguous edit in ${group.rawPath}; provide more surrounding context, add target/lineRange scope, or use replaceAll`
                    : `failed: edit (${group.rawPath})`;
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: message }],
                    details: {
                        ...makeFailed(toolCallId, "stage", `edit planning failed: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence, invalidations),
                        ...(matchCode === "NOT_FOUND" || matchCode === "AMBIGUOUS" ? { matchFailure: matchCode } : {}),
                    },
                },
            };
        }
    }

    // Authorize using ACTUAL resolved spans (not an exact oldText
    // lookup), so fuzzy/scoped matches authorize correctly and cannot
    // escape prior line-range authority. For replaceAll, every actual
    // span is authorized.
    const coverageError = checkResourceCoverage(resource, preimageLineRanges);
    if (coverageError) {
        diagnostics.push(`${coverageError} for ${canonicalTarget}`);
        if (usedPriorAuthority) {
            diagnostics.push(`coverage: prior authority is line-range for ${canonicalTarget}; a fresh full-file read is required to widen authority`);
        }
        return {
            ok: false,
            result: {
                content: [{ type: "text" as const, text: `rejected: coverage (${group.rawPath})` }],
                details: makeRejected(toolCallId, "coverage", diagnostics, {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [resource.resourceId],
                }, checks, usedEvidence, invalidations),
            },
        };
    }

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
            // Repair ranges are computed in staged (post-edit) coordinates,
            // so they cannot be compared against the resource's pre-edit
            // allowedRanges. Map each repair span back to original
            // coordinates via the edit mapping, then require it to stay
            // within the edit's already-authorized preimage footprint.
            // Full-file grants accept any in-file repair; a repair that
            // cannot be re-authorized is skipped.
            const confinedToPreimage =
                resource.coverage === "full-file" ||
                (repairRanges.length > 0 &&
                    repairRanges.every((r) => {
                        const mapped = mapRepairSpanToPreimage(r, preimageLineRanges, postimageLineRanges);
                        return mapped !== null &&
                            preimageLineRanges.some((p) => mapped.startLine >= p.startLine && mapped.endLine <= p.endLine);
                    }));
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
