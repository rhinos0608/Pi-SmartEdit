/**
 * Transfer staging — copy/move materialization against the active
 * transaction snapshot. Owned by the transfer domain; the shared kernel
 * owns evidence, transaction, verification, rollback, and finalization. Resolves each
 * transfer's source range against the pre-transaction snapshot (never a
 * fresh disk read), authorizes copy sources, rejects conflicting transfers,
 * and appends the synthesized insert/delete edits into the reserved groups
 * in place. Must NOT add path-containment gates; must NOT reorder, sort,
 * or rebuild the groups array.
 */
import {
    sha256OfString,
    type EvidenceRef,
    type InspectedResource,
    type ResourceInvalidation,
    type WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";
import { stripBom, normalizeToLF } from "../core/edit-diff.js";
import { resolveSourceRange, resolveDestination, type ResolvedSourceRange } from "./resolve.js";
import {
    planTransfer,
    bindResolvedTransfer,
    planTransferMutations,
    buildTransferDescription,
    buildTransferInsertEdit,
    buildTransferDeleteEdit,
    type TransferPlan,
} from "./plan.js";
import {
    validateResourceAuthority,
    findResourceForCanonicalPath,
    isValidFullFileSha256,
} from "../context/patch-authorization.js";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";
import type { EditTransaction } from "../mutation/edit-transaction.js";
import { makeFailed, makeRejected } from "../patch/result-builders.js";
import { moveSpansOverlap, isSameFileMoveCandidate, isAfterLineInsideSourceSpan } from "../patch/refactor-preview.js";
import type { MutableChecks, MutationResult } from "../mutation/types.js";
import type { ResolvedTransferBatch } from "./resolve-batch.js";
import type { MutationGroup, MutationToolIdentity } from "../mutation/types.js";

export interface MaterializeTransfersArgs {
    readonly tool: MutationToolIdentity;
    readonly resolvedTransfers: ReadonlyArray<ResolvedTransferBatch>;
    readonly transaction: EditTransaction;
    readonly groups: MutationGroup[];
    readonly priorStore: PriorAuthorityStore | null;
    readonly envelope: WorkspaceEvidenceEnvelope | null;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly toolCallId: string;
    readonly checks: MutableChecks;
    readonly diagnostics: string[];
    readonly usedEvidence: string[];
    readonly invalidations: ReadonlyArray<ResourceInvalidation>;
}

interface MoveSourceSpan {
    canonicalFrom: string;
    startLine: number;
    endLine: number;
}

/** Snapshot read + logical-line preimage for one transfer's source. Reads
 *  from the active transaction's snapshot, never fresh disk. */
function readTransferSourcePreimage(args: {
    transaction: EditTransaction;
    rt: ResolvedTransferBatch;
    toolCallId: string;
    tool: MutationToolIdentity;
    checks: MutableChecks;
    diagnostics: string[];
    usedEvidence: string[];
    invalidations: ReadonlyArray<ResourceInvalidation>;
    evidenceRefForDetails: EvidenceRef;
}): { ok: true; rawSourceContent: string; sourceLogicalLines: string[] } | { ok: false; result: MutationResult } {
    const { transaction, rt, toolCallId, tool, checks, diagnostics, usedEvidence, invalidations, evidenceRefForDetails } = args;
    const snapshot = transaction.getSnapshot(rt.canonicalFrom);
    if (!snapshot || !snapshot.exists) {
        diagnostics.push(`transfer source does not exist: ${rt.rawFrom}`);
        return {
            ok: false,
            result: {
                content: [{ type: "text" as const, text: `failed: transfer source does not exist: ${rt.rawFrom}` }],
                details: makeFailed(toolCallId, "stage", `transfer source does not exist: ${rt.rawFrom}`, evidenceRefForDetails, checks, diagnostics, usedEvidence, invalidations, undefined, tool),
            },
        };
    }
    const rawSourceContent = snapshot.content ? snapshot.content.toString("utf8") : "";
    // Anchors address logical lines (BOM-stripped, LF-normalized);
    // freshness below hashes the raw snapshot preimage instead.
    const sourceLogicalLines = normalizeToLF(stripBom(rawSourceContent).text).split("\n");
    return { ok: true, rawSourceContent, sourceLogicalLines };
}

/** Standalone copy-source authority check. `move`'s source becomes a real
 *  deletion group authorized through the main loop; `copy` produces no
 *  mutation at the source so it needs this check. Returns a terminal
 *  result on failure, null when authorized. */
function authorizeCopySource(args: {
    priorStore: PriorAuthorityStore | null;
    envelope: WorkspaceEvidenceEnvelope | null;
    evidenceRefForDetails: EvidenceRef;
    toolCallId: string;
    tool: MutationToolIdentity;
    checks: MutableChecks;
    diagnostics: string[];
    usedEvidence: string[];
    invalidations: ReadonlyArray<ResourceInvalidation>;
    rt: ResolvedTransferBatch;
    resolved: ResolvedSourceRange;
    rawSourceContent: string;
}): MutationResult | null {
    const { priorStore, envelope, evidenceRefForDetails, toolCallId, tool, checks, diagnostics, usedEvidence, invalidations, rt, resolved, rawSourceContent } = args;
    let sourceResource: InspectedResource | null = null;
    let usedPriorSourceAuthority = false;
    if (priorStore) {
        sourceResource = priorStore.select(rt.canonicalFrom);
        usedPriorSourceAuthority = sourceResource !== null;
    }
    if (!sourceResource && envelope) {
        sourceResource = findResourceForCanonicalPath(envelope, rt.canonicalFrom, evidenceRefForDetails.resourceIds);
    }
    if (!sourceResource) {
        diagnostics.push(`coverage: no authority for copy source ${rt.rawFrom}`);
        return {
            content: [{ type: "text" as const, text: `rejected: coverage (copy source ${rt.rawFrom})` }],
            details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations, tool),
        };
    }
    const coverageError = validateResourceAuthority(sourceResource, [{ startLine: resolved.startLine, endLine: resolved.endLine }], false);
    if (coverageError) {
        diagnostics.push(`${coverageError} for copy source ${rt.rawFrom}`);
        return {
            content: [{ type: "text" as const, text: `rejected: coverage (copy source ${rt.rawFrom})` }],
            details: makeRejected(toolCallId, "coverage", diagnostics, {
                inspectionId: evidenceRefForDetails.inspectionId,
                resourceIds: [sourceResource.resourceId],
            }, checks, usedEvidence, invalidations, tool),
        };
    }
    if (!isValidFullFileSha256(sourceResource.fullFileSha256)) {
        diagnostics.push(`coverage: missing or malformed fullFileSha256 for ${rt.rawFrom}; read the source file again before copying`);
        return {
            content: [{ type: "text" as const, text: `rejected: coverage (missing valid snapshot SHA for copy source ${rt.rawFrom})` }],
            details: makeRejected(toolCallId, "coverage", diagnostics, {
                inspectionId: evidenceRefForDetails.inspectionId,
                resourceIds: [sourceResource.resourceId],
            }, checks, usedEvidence, invalidations, tool),
        };
    }
    // Freshness hashes the raw snapshot preimage (BOM/CRLF
    // included): normalized content would hash differently from
    // the attested fullFileSha256 on such files.
    if (sourceResource.fullFileSha256 !== sha256OfString(rawSourceContent)) {
        diagnostics.push(`stale: copy source ${rt.rawFrom} sha mismatch`);
        return {
            content: [{ type: "text" as const, text: `rejected: stale (copy source ${rt.rawFrom})` }],
            details: makeRejected(toolCallId, "stale", diagnostics, {
                inspectionId: evidenceRefForDetails.inspectionId,
                resourceIds: [sourceResource.resourceId],
            }, checks, usedEvidence, invalidations, tool),
        };
    }
    if (!usedEvidence.includes(sourceResource.resourceId)) usedEvidence.push(sourceResource.resourceId);
    return null;
}

/** Overlapping move deletions resolve against the same original
 *  pre-transaction snapshot, so overlapping spans are a planning conflict.
 *  Returns the rejection message, or null when clear. */
function findOverlappingMoveSpan(
    moveSourceSpans: ReadonlyArray<MoveSourceSpan>,
    rt: ResolvedTransferBatch,
    resolved: ResolvedSourceRange,
): string | null {
    for (const seen of moveSourceSpans) {
        if (moveSpansOverlap(seen, rt.canonicalFrom, resolved.startLine, resolved.endLine)) {
            return `transfer source spans overlap in ${rt.rawFrom} ([${seen.startLine},${seen.endLine}] vs [${resolved.startLine},${resolved.endLine}]): refusing conflicting move deletions`;
        }
    }
    return null;
}

/** Same-file destination landing inside or touching the source span (insert
 *  point between lines [startLine-1, endLine]) has no well-defined
 *  pre/post-delete meaning. Returns the rejection message, or null. */
function checkSameFileDestination(
    rt: ResolvedTransferBatch,
    sourceLogicalLines: string[],
    resolved: ResolvedSourceRange,
): string | null {
    // Sentinel `start`/`end` dests are absolute file edges and never
    // participate in this check.
    if (isSameFileMoveCandidate(rt.op, rt.canonicalFrom, rt.canonicalTo, rt.after)) {
        const rebasedAfter = resolveDestination(rt.after, sourceLogicalLines);
        const afterLine = typeof rebasedAfter === "number" ? rebasedAfter : null;
        if (isAfterLineInsideSourceSpan(afterLine, resolved.startLine, resolved.endLine)) {
            return `transfer destination after anchor ${rt.after} lands inside or touching the source span [${resolved.startLine},${resolved.endLine}] in ${rt.rawFrom}: refusing conflicting same-file transfer`;
        }
    }
    return null;
}

/** Hashline inserts are idempotent downstream; reject pre-write with a
 *  transfer-specific conflict instead of silently dropping the insert.
 *  Returns the rejection message, or null. */
function findDuplicateDestination(args: {
    transaction: EditTransaction;
    rt: ResolvedTransferBatch;
    sourceLines: string[];
    sourceLogicalLines: string[];
}): string | null {
    const { transaction, rt, sourceLines, sourceLogicalLines } = args;
    if (sourceLines.length > 0 && !rt.toIsNewFile) {
        let destLines: string[] | null = null;
        if (rt.canonicalFrom === rt.canonicalTo) {
            destLines = sourceLogicalLines;
        } else {
            const destSnapshot = transaction.getSnapshot(rt.canonicalTo);
            const rawDest = destSnapshot?.content ? destSnapshot.content.toString("utf8") : null;
            if (rawDest !== null) destLines = normalizeToLF(stripBom(rawDest).text).split("\n");
        }
        if (destLines !== null) {
            const linesEqual = (a: string[], b: string[]): boolean =>
                a.length === b.length && a.every((line, i) => line === b[i]);
            let existingAtDest: string[] | null = null;
            if (rt.after === "start") {
                existingAtDest = destLines.slice(0, sourceLines.length);
            } else if (rt.after !== undefined) {
                const destAfterLine = resolveDestination(rt.after, destLines);
                if (typeof destAfterLine === "number") existingAtDest = destLines.slice(destAfterLine, destAfterLine + sourceLines.length);
            }
            if (existingAtDest !== null && linesEqual(existingAtDest, sourceLines)) {
                return `transfer destination already contains the source lines after ${rt.after ?? "start"} in ${rt.rawTo}: refusing duplicate transfer that the insert layer would silently drop`;
            }
        }
    }
    return null;
}

/** Literal mutation plan: destination insert + (for move) source delete as
 *  plain data, converted to hashline EditItems appended to the reserved
 *  groups in place (matching entries replaced, never reordered). */
function appendTransferMutations(args: {
    groups: MutationGroup[];
    rt: ResolvedTransferBatch;
    transferPlan: TransferPlan;
    resolved: ResolvedSourceRange;
}): void {
    const { groups, rt, transferPlan, resolved } = args;
    // Transaction/evidence/verifier/rollback/undo/finalization stay shared
    // in the pipeline — plan.ts owns no lifecycle engine.
    const mutations = planTransferMutations(
        bindResolvedTransfer(transferPlan, { startLine: resolved.startLine, endLine: resolved.endLine, sourceLines: resolved.lines }),
        buildTransferDescription({ op: rt.op, from: rt.rawFrom, range: rt.range, description: rt.description }),
    );
    const description = mutations.description;
    const destAfter = mutations.insert.afterAnchor;
    const toIdx = groups.findIndex((g) => g.absolutePath === rt.canonicalTo);
    groups[toIdx] = { ...groups[toIdx], edits: [...groups[toIdx].edits, buildTransferInsertEdit(destAfter, mutations.insert.lines, description)] };

    if (mutations.erase !== null) {
        const fromIdx = groups.findIndex((g) => g.absolutePath === rt.canonicalFrom);
        groups[fromIdx] = { ...groups[fromIdx], edits: [...groups[fromIdx].edits, buildTransferDeleteEdit(mutations.erase, description)] };
    }
}

/** Resolve transfer (copy/move) ops against the pre-transaction snapshot,
 *  then fill in the reserved groups' edits with the synthesized hashline
 *  EditItems. Returns success, or a terminal MutationResult the caller must
 *  return (call inside try so the finally-block rollback still triggers). */
export function materializeTransfers(args: MaterializeTransfersArgs): { ok: true } | { ok: false; result: MutationResult } {
    const { tool, resolvedTransfers, transaction, groups, priorStore, envelope, evidenceRefForDetails, toolCallId, checks, diagnostics, usedEvidence, invalidations } = args;
    const moveSourceSpans: Array<{ canonicalFrom: string; startLine: number; endLine: number }> = [];
    for (const rt of resolvedTransfers) {
        const preimage = readTransferSourcePreimage({ transaction, rt, toolCallId, tool, checks, diagnostics, usedEvidence, invalidations, evidenceRefForDetails });
        if (!preimage.ok) return preimage;
        const rawSourceContent = preimage.rawSourceContent;
        const sourceLogicalLines = preimage.sourceLogicalLines;

        // Plan the destination first: a supplied `after` on a new-file
        // destination (or a non-public sentinel/suffix) is a pure
        // planning error — reject pre-write with a transfer conflict
        // before any source authority is consulted.
        let transferPlan: TransferPlan;
        try {
            transferPlan = planTransfer({ op: rt.op, from: rt.rawFrom, range: rt.range, to: rt.rawTo, after: rt.after, toIsNewFile: rt.toIsNewFile });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            diagnostics.push(message);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `rejected: ${message}` }],
                    details: makeRejected(toolCallId, "conflict", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations, tool),
                },
            };
        }

        const resolved = resolveSourceRange(rawSourceContent, rt.range.pos, rt.range.end);
        if (!resolved.ok) {
            diagnostics.push(`transfer: ${resolved.error} (${rt.rawFrom})`);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `failed: transfer range resolution (${rt.rawFrom})` }],
                    details: makeFailed(toolCallId, "stage", `${resolved.error} (${rt.rawFrom})`, evidenceRefForDetails, checks, diagnostics, usedEvidence, invalidations, undefined, tool),
                },
            };
        }

        if (rt.op === "copy") {
            const authFailure = authorizeCopySource({ priorStore, envelope, evidenceRefForDetails, toolCallId, tool, checks, diagnostics, usedEvidence, invalidations, rt, resolved: resolved.value, rawSourceContent });
            if (authFailure) return { ok: false, result: authFailure };
        }

        if (!rt.toIsNewFile && rt.after === undefined) {
            const message = `transfer destination ${rt.rawTo} already exists; \`after\` is required to choose an insertion point`;
            diagnostics.push(message);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `rejected: ${message}` }],
                    details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations, tool),
                },
            };
        }

        // Overlapping move deletions resolve against the same original
        // pre-transaction snapshot, so overlapping spans are a planning
        // conflict — reject transfer-specifically rather than letting
        // the unified overlap check report a generic failure.
        if (rt.op === "move") {
            const overlapMessage = findOverlappingMoveSpan(moveSourceSpans, rt, resolved.value);
            if (overlapMessage !== null) {
                diagnostics.push(overlapMessage);
                return {
                    ok: false,
                    result: {
                        content: [{ type: "text" as const, text: `rejected: ${overlapMessage}` }],
                        details: makeRejected(toolCallId, "conflict", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations, tool),
                    },
                };
            }
            moveSourceSpans.push({ canonicalFrom: rt.canonicalFrom, startLine: resolved.value.startLine, endLine: resolved.value.endLine });
        }
        // Same-file destination landing inside or touching the source
        // span (insert point between lines [startLine-1, endLine]) has
        // no well-defined pre/post-delete meaning — reject with a
        // transfer-specific conflict.
        const sameFileMessage = checkSameFileDestination(rt, sourceLogicalLines, resolved.value);
        if (sameFileMessage !== null) {
            diagnostics.push(sameFileMessage);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `rejected: ${sameFileMessage}` }],
                    details: makeRejected(toolCallId, "conflict", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations, tool),
                },
            };
        }

        // Hashline inserts are idempotent: an insert whose lines already
        // follow the destination anchor is a silent no-op downstream
        // (./core/edit-planner.js skips no-change spans; hashline append_at no-ops
        // on identical following lines). Reject pre-write with a
        // transfer-specific conflict instead of silently dropping the
        // insert — covers same-file and cross-file. Generic hashline
        // idempotence itself is unchanged.
        const sourceLines = resolved.value.lines;
        const duplicateMessage = findDuplicateDestination({ transaction, rt, sourceLines, sourceLogicalLines });
        if (duplicateMessage !== null) {
            diagnostics.push(duplicateMessage);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `rejected: ${duplicateMessage}` }],
                    details: makeRejected(toolCallId, "conflict", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations, tool),
                },
            };
        }
        appendTransferMutations({ groups, rt, transferPlan, resolved: resolved.value });
    }
    return { ok: true };
}
