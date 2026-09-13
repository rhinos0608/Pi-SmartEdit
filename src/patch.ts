/**
 * Patch tool — v3 multi-file patch with workspace-evidence authorization.
 *
 * v1 was single-file, evidence-bound, with a hard multi-file prohibition.
 * v3 adds:
 *   - Multi-file support: each edit may carry its own `path` (PatchEditItemV3)
 *     which overrides the top-level `path` default.
 *   - Validated batch mutation is failure-atomic for handled failures: edits
 *     run in one EditTransaction with cross-file rollback before failure is
 *     reported. Files are individually written atomically.
 *   - Per-file evidence coverage: every file targeted by an edit must have a
 *     strong-coverage resource (full-file or line-range) in the envelope
 *     covering it. Weak-coverage resources (search-match, metadata-only —
 *     produced by inspect's query/symbol modes) are explicitly rejected;
 *     the model must path-mode inspect a file before patching it.
 *   - Existing files require prior strong model-visible read evidence. Missing
 *     or weak prior evidence is rejected with actionable read guidance. New
 *     in-root files may use explicit empty-file semantics.
 *
 * - Accepts a single EvidenceRef (`{inspectionId, resourceIds}`); tool-owned
 *   prior authority is preferred when available.
 * - Resolves evidence through event-RPC against the SmartRead resolver.
 * - Validates that the current on-disk full content SHA-256 matches the
 *   resource's attested `fullFileSha256` (stale-file guard).
 * - Validates that the actual target line range is covered by the resource's
 *   `allowedRanges` (coverage guard).
 * - For full-file resources: the single resource is authoritative for the
 *   whole file.
 * - For line-range resources: only the attested lines may be edited.
 * - Only structural/LSP/configured allowlisted checks run. No arbitrary
 *   shell or verification commands. A failing blocking check rejects the
 *   patch before the write — it is not merely advisory.
 * - Returns a discriminated `details` with the full lifecycle.
 */
import { readFile as fsReadFile, stat as fsStat, mkdir as fsMkdir } from "node:fs/promises";
import { resolve as pathResolve, dirname as pathDirname } from "node:path";
import { realpathSync } from "node:fs";

import {
    hashSessionFilePath,
    sha256OfString,
    type InspectedResource,
    type LineRange,
    type PatchDetails,
    type EvidenceRef,
    type CheckRecord,
    type ResourceInvalidation,
    type PostEditEvidence,
} from "@rhinos0608/pi-workspace-protocol";
import { formatBoundedDiagnostics, appendDiagnosticsToContent } from "./mutation/post-mutation.js";
import { generateDiffString, stripBom, normalizeToLF } from "./core/edit-diff.js";
import { resolveSourceRange, resolveDestination } from "./transfer/resolve.js";
import { planTransfer, bindResolvedTransfer, planTransferMutations, buildTransferDescription, buildTransferInsertEdit, buildTransferDeleteEdit, type TransferPlan } from "./transfer/plan.js";
import { checkEditSafety } from "./safety/approval-gating.js";
import { EDIT_PARAMETERS, validateEditRequest, type RefactorRequest } from "./edit-contract.js";
import type { PriorAuthorityStore } from "./context/evidence-authority.js";
import { planTextEdits, type StructuralResolver } from "./core/edit-planner.js";
import { EditTransaction } from "./mutation/edit-transaction.js";
import { saveTransactionUndoRecords } from "./undo/edit-history.js";
import { MatchError } from "./core/errors.js";
import type { AstResolverLike } from "./anchor/anchor-resolution.js";
import type { EditItem, EditTarget, FileSnapshot, HashlineEditMetadata } from "./core/types.js";
import type { RepairLoopResult } from "./verification/repair-loop.js";

// ── Public surface (shared kernel: ./patch/types.js) ────────────────
// Type definitions live in the shared kernel; re-exported here so existing
// importers keep working untouched. Pure move: zero logic change.
import type {
    PatchToolDeps,
    FinalSuccessFile,
    VerificationCheck,
    CheckOutcome,
    MutableChecks,
    GroupedEdit,
    EditGroup,
    RawTopology,
    PatchResult,
    PreparedPatchRequest,
    ResolvedPatchTransfer,
    PatchDisplayDiff,
    PatchToolDetails,
    PatchTool,
} from "./patch/types.js";
import { VERIFIER_TIMEOUT_MS } from "./patch/types.js";
export type {
    RpcClientLike,
    PatchToolDeps,
    FinalSuccessFile,
    FinalSuccessInput,
    FinalSuccessResult,
    VerificationCheck,
    CheckOutcome,
    PatchDisplayDiff,
    PatchToolDetails,
    PatchTool,
} from "./patch/types.js";

// ── Result builders (shared kernel: ./patch/result-builders.js) ─────
// Check accumulation, verifier execution, and rejected/failed result
// construction live in the shared kernel; imported here so the
// orchestrator keeps working untouched. Pure move: zero logic change.
import {
    freshChecks,
    makeCheck,
    freezeChecks,
    runVerifierCheck,
    failResult,
    makeRejected,
    makeFailed,
    buildRollbackInfo,
    classifyRpcError,
} from "./patch/result-builders.js";

// ── Repair spans (shared kernel: ./patch/repair-spans.js) ────────────
// Staged-to-preimage mapping and textual delta coverage live in the shared
// kernel; imported here so the orchestrator keeps working untouched.
// Pure move: zero logic change.
import { mapRepairSpanToPreimage, changedLineRanges } from "./patch/repair-spans.js";

// ── Authorization (see ./context/patch-authorization.js) ───────────────────
// Evidence authorization (types, resource selection, coverage validation,
// SHA-shape validation, requested-resource lookup) lives in
// context/patch-authorization.js. patch.ts keeps evidence RPC, grouping, mutation,
// and rollback. Re-exported here so existing importers keep working.
export {
    resolvePatchAuthorization,
    authorizeResource,
    checkResourceCoverage,
    validateResourceAuthority,
    findResourceForCanonicalPath,
    isValidFullFileSha256,
    SHA256_RE,
    type AuthorizationResult,
} from "./context/patch-authorization.js";
import {
    authorizeResource,
    checkResourceCoverage,
    validateResourceAuthority,
    findResourceForCanonicalPath,
    isValidFullFileSha256,
} from "./context/patch-authorization.js";

// ── Request preparation (shared kernel: ./patch/request-prep.js) ───
// Grouping, auto-inspect envelope synthesis, preparation, transfer
// resolution, and envelope acquisition live in the shared kernel;
// imported here so the orchestrator keeps working untouched.
// Pure move: zero logic change.
import {
    safeReadUtf8,
    preparePatchRequest,
    resolvePatchTransfers,
    acquirePatchEnvelope,
} from "./patch/request-prep.js";

// ── Refactor preview (shared kernel: ./patch/refactor-preview.js) ──
// Rename / organize-imports / formatting / code-action preview planning
// plus apply-preview live in the shared kernel; imported here so the
// orchestrator keeps working untouched. Pure move: zero logic change.
// handleRefactorRequest returns PatchResult|null (null = not refactor →
// orchestrator continues). isBlockingPostwriteFailure is shared with the
// orchestrator postwrite loop (imported, not duplicated).
import {
    moveSpansOverlap,
    isSameFileMoveCandidate,
    isAfterLineInsideSourceSpan,
    isBlockingPostwriteFailure,
    handleRefactorRequest,
} from "./patch/refactor-preview.js";

// ── Patch tool factory ──────────────────────────────────────────────

export function createPatchTool(deps: PatchToolDeps): PatchTool {
    return {
        name: "patch",
        label: "patch",
        description:
            "Apply edits to files gated by workspace evidence. Existing files require prior strong read authority; new files may use empty-file semantics. Provide a `path` and a list of `edits`, or a `raw` patch string (mutually exclusive); each edit may carry its own `path`. Freshness and coverage are validated automatically; returns a discriminated lifecycle result (applied | rejected | failed).",
        parameters: EDIT_PARAMETERS as unknown as Record<string, unknown>,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const stream = (text: string) => { onUpdate?.({ content: [{ type: "text", text }] }); };

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
                if (handled) return handled;
            }
            if (!v.ok) {
                return {
                    content: [{ type: "text" as const, text: `invalid patch request: ${v.error}` }],
                    details: makeRejected(toolCallId, "session", ["invalid patch request shape"], { inspectionId: "", resourceIds: [] }, freshChecks()),
                };
            }
            // Preparation / transfer resolution / envelope acquisition live in
            // file-local helpers (Lane A extract-only); orchestrator keeps the
            // transaction begin/commit/finalize phases.
            const prepared = preparePatchRequest({ validated: v, deps, ctx, toolCallId });
            if (!prepared.ok) return prepared.result;
            const requestEvidenceRef = prepared.prepared.requestEvidenceRef;
            const sessionFilePath = prepared.prepared.sessionFilePath;
            const canonicalRoot = prepared.prepared.canonicalRoot;
            const groups = prepared.prepared.groups;
            const checks: MutableChecks = prepared.prepared.checks;
            const diagnostics: string[] = prepared.prepared.diagnostics;
            const usedEvidence: string[] = [];

            const totalEdits = groups.reduce((sum, g) => sum + g.edits.length, 0);
            const fileWord = groups.length === 1 ? "file" : "files";
            const editWord = totalEdits === 1 ? "edit" : "edits";
            stream(`patch — ${totalEdits} ${editWord} across ${groups.length} ${fileWord}`);

            const transfers = resolvePatchTransfers({ adaptedTransfers: prepared.prepared.adaptedTransfers, groups, ctx, toolCallId, requestEvidenceRef, checks });
            if (!transfers.ok) return transfers.result;
            const resolvedTransfers = transfers.resolvedTransfers;
            const transferNewFileCanonicals = transfers.transferNewFileCanonicals;
            const copySourceOnlyPaths = transfers.copySourceOnlyPaths;

            const priorStore = deps.getPriorAuthority?.() ?? null;
            const acquired = await acquirePatchEnvelope({ deps, groups, sessionFilePath, canonicalRoot, requestEvidenceRef, transferNewFileCanonicals, toolCallId, checks, diagnostics, usedEvidence, signal });
            if (!acquired.ok) return acquired.result;
            const envelope = acquired.envelope;
            const autoInspected = acquired.autoInspected;
            const evidenceRefForDetails = acquired.evidenceRefForDetails;
            const newFileCanonicals = acquired.newFileCanonicals;

            // ── Per-group application ────────────────────────────────
            // We validate and apply each file's edits in order. On the
            // first failure, abort the whole batch and report.

            const invalidations: ResourceInvalidation[] = [];
            const postEditEvidenceByPath = new Map<string, PostEditEvidence>();
            const repairsByPath = new Map<string, RepairLoopResult>();
            const finalizedFiles: FinalSuccessFile[] = [];
            const appliedFiles: string[] = [];
            const appliedCanonical: string[] = [];
            const appliedSummaries: string[] = [];
            const displayDiffs: PatchDisplayDiff[] = [];
            // One canonicalization for transaction planning and every mutation:
            // new files keep their raw resolved path (no on-disk file to
            // realpath), existing files resolve symlinks — so every path passed
            // to EditTransaction.before() was included during begin().
            const canonicalTxPath = (absolutePath: string): string => {
                if (newFileCanonicals.has(absolutePath)) return absolutePath;
                try {
                    return realpathSync(absolutePath);
                } catch {
                    return absolutePath;
                }
            };
            const transactionPaths = [...new Set([
                ...groups.map((group) => canonicalTxPath(group.absolutePath)),
                ...copySourceOnlyPaths,
            ])];
            let transaction: EditTransaction;
            try {
                transaction = await EditTransaction.begin(transactionPaths);
            } catch (err) {
                // begin() can throw (lock-timeout, or a snapshot failure while
                // reading a target path). It runs before any per-group work, so
                // there is nothing to roll back yet — just report a typed
                // failure rather than letting the rejection propagate past the
                // tool boundary as an uncaught promise rejection.
                const msg = err instanceof Error ? err.message : String(err);
                diagnostics.push(`failed to begin transaction: ${msg}`);
                return {
                    content: [{ type: "text" as const, text: `failed: begin transaction (${msg})` }],
                    details: makeFailed(toolCallId, "stage", `failed to begin transaction: ${msg}`, {
                        inspectionId: evidenceRefForDetails.inspectionId,
                        resourceIds: [],
                    }, checks, diagnostics, usedEvidence, invalidations),
                };
            }
            let committed = false;
            let rollbackInfo: { ok: boolean; reason?: string } | undefined;

            try {
            // ── Resolve transfer (copy/move) ops against the pre-transaction
            // snapshot, then fill in the reserved groups' edits with the
            // synthesized hashline EditItems. Runs before the main per-group
            // loop (which then treats these exactly like any other hashline
            // group) and inside this try so an early rejection here still
            // triggers the finally-block rollback below.
            const moveSourceSpans: Array<{ canonicalFrom: string; startLine: number; endLine: number }> = [];
            for (const rt of resolvedTransfers) {
                const snapshot = transaction.getSnapshot(rt.canonicalFrom);
                if (!snapshot || !snapshot.exists) {
                    diagnostics.push(`transfer source does not exist: ${rt.rawFrom}`);
                    return {
                        content: [{ type: "text" as const, text: `failed: transfer source does not exist: ${rt.rawFrom}` }],
                        details: makeFailed(toolCallId, "stage", `transfer source does not exist: ${rt.rawFrom}`, evidenceRefForDetails, checks, diagnostics, usedEvidence, invalidations),
                    };
                }
                const rawSourceContent = snapshot.content ? snapshot.content.toString("utf8") : "";
                // Anchors address logical lines (BOM-stripped, LF-normalized);
                // freshness below hashes the raw snapshot preimage instead.
                const sourceLogicalLines = normalizeToLF(stripBom(rawSourceContent).text).split("\n");

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
                        content: [{ type: "text" as const, text: `rejected: ${message}` }],
                        details: makeRejected(toolCallId, "conflict", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations),
                    };
                }

                const resolved = resolveSourceRange(rawSourceContent, rt.range.pos, rt.range.end);
                if (!resolved.ok) {
                    diagnostics.push(`transfer: ${resolved.error} (${rt.rawFrom})`);
                    return {
                        content: [{ type: "text" as const, text: `failed: transfer range resolution (${rt.rawFrom})` }],
                        details: makeFailed(toolCallId, "stage", `${resolved.error} (${rt.rawFrom})`, evidenceRefForDetails, checks, diagnostics, usedEvidence, invalidations),
                    };
                }

                if (rt.op === "copy") {
                    // `move`'s source becomes a real deletion group below and is
                    // authorized through the main loop's existing per-group
                    // pipeline; `copy` produces no mutation at the source, so it
                    // never becomes a group and needs this standalone check.
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
                            details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations),
                        };
                    }
                    const coverageError = validateResourceAuthority(sourceResource, [{ startLine: resolved.value.startLine, endLine: resolved.value.endLine }], false);
                    if (coverageError) {
                        diagnostics.push(`${coverageError} for copy source ${rt.rawFrom}`);
                        return {
                            content: [{ type: "text" as const, text: `rejected: coverage (copy source ${rt.rawFrom})` }],
                            details: makeRejected(toolCallId, "coverage", diagnostics, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [sourceResource.resourceId],
                            }, checks, usedEvidence, invalidations),
                        };
                    }
                    if (!isValidFullFileSha256(sourceResource.fullFileSha256)) {
                        diagnostics.push(`coverage: missing or malformed fullFileSha256 for ${rt.rawFrom}; read the source file again before copying`);
                        return {
                            content: [{ type: "text" as const, text: `rejected: coverage (missing valid snapshot SHA for copy source ${rt.rawFrom})` }],
                            details: makeRejected(toolCallId, "coverage", diagnostics, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [sourceResource.resourceId],
                            }, checks, usedEvidence, invalidations),
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
                            }, checks, usedEvidence, invalidations),
                        };
                    }
                }

                if (!rt.toIsNewFile && rt.after === undefined) {
                    const message = `transfer destination ${rt.rawTo} already exists; \`after\` is required to choose an insertion point`;
                    diagnostics.push(message);
                    return {
                        content: [{ type: "text" as const, text: `rejected: ${message}` }],
                        details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations),
                    };
                }

                // Overlapping move deletions resolve against the same original
                // pre-transaction snapshot, so overlapping spans are a planning
                // conflict — reject transfer-specifically rather than letting
                // the unified overlap check report a generic failure.
                if (rt.op === "move") {
                    for (const seen of moveSourceSpans) {
                        if (moveSpansOverlap(seen, rt.canonicalFrom, resolved.value.startLine, resolved.value.endLine)) {
                            const message = `transfer source spans overlap in ${rt.rawFrom} ([${seen.startLine},${seen.endLine}] vs [${resolved.value.startLine},${resolved.value.endLine}]): refusing conflicting move deletions`;
                            diagnostics.push(message);
                            return {
                                content: [{ type: "text" as const, text: `rejected: ${message}` }],
                                details: makeRejected(toolCallId, "conflict", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations),
                            };
                        }
                    }
                    moveSourceSpans.push({ canonicalFrom: rt.canonicalFrom, startLine: resolved.value.startLine, endLine: resolved.value.endLine });
                }
                // Same-file destination landing inside or touching the source
                // span (insert point between lines [startLine-1, endLine]) has
                // no well-defined pre/post-delete meaning — reject with a
                // transfer-specific conflict. Sentinel `start`/`end` dests are
                // absolute file edges and never participate in this check.
                if (isSameFileMoveCandidate(rt.op, rt.canonicalFrom, rt.canonicalTo, rt.after)) {
                    const rebasedAfter = resolveDestination(rt.after, sourceLogicalLines);
                    const afterLine = typeof rebasedAfter === "number" ? rebasedAfter : null;
                    if (isAfterLineInsideSourceSpan(afterLine, resolved.value.startLine, resolved.value.endLine)) {
                        const message = `transfer destination after anchor ${rt.after} lands inside or touching the source span [${resolved.value.startLine},${resolved.value.endLine}] in ${rt.rawFrom}: refusing conflicting same-file transfer`;
                        diagnostics.push(message);
                        return {
                            content: [{ type: "text" as const, text: `rejected: ${message}` }],
                            details: makeRejected(toolCallId, "conflict", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations),
                        };
                    }
                }

                // Hashline inserts are idempotent: an insert whose lines already
                // follow the destination anchor is a silent no-op downstream
                // (./core/edit-planner.js skips no-change spans; hashline append_at no-ops
                // on identical following lines). Reject pre-write with a
                // transfer-specific conflict instead of silently dropping the
                // insert — covers same-file and cross-file. Generic hashline
                // idempotence itself is unchanged.
                const sourceLines = resolved.value.lines;
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
                            const message = `transfer destination already contains the source lines after ${rt.after ?? "start"} in ${rt.rawTo}: refusing duplicate transfer that the insert layer would silently drop`;
                            diagnostics.push(message);
                            return {
                                content: [{ type: "text" as const, text: `rejected: ${message}` }],
                                details: makeRejected(toolCallId, "conflict", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations),
                            };
                        }
                    }
                }
                // Literal mutation plan: destination insert + (for move) source
                // delete as plain data, converted to hashline EditItems below.
                // Transaction/evidence/verifier/rollback/undo/finalization stay
                // shared in this pipeline — plan.ts owns no lifecycle engine.
                const mutations = planTransferMutations(
                    bindResolvedTransfer(transferPlan, { startLine: resolved.value.startLine, endLine: resolved.value.endLine, sourceLines }),
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

            for (const group of groups) {
                // Skip bookkeeping placeholders (e.g. rename destination paths) that have
                // no text edits and no topology — nothing to apply.
                if (group.edits.length === 0 && !group.topology) continue;

                stream(`  ${group.rawPath} — ${group.edits.length} edit(s)`);

                // Resolve canonical path for this group.
                let canonicalTarget: string;
                let isNewFileGroup = false;
                // Display/applied path for this group; reassigned to the new
                // path after a successful rename so downstream diffs, applied
                // lists, and finalization all reference where the file now
                // lives (the old path no longer exists once renamed).
                let displayPath: string = group.rawPath;
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
                            content: [{ type: "text" as const, text: `failed: file not found: ${group.rawPath}` }],
                            details: makeFailed(toolCallId, "stage", `file not found: ${group.rawPath}`, {
                                ...evidenceRefForDetails,
                                resourceIds: [""],
                            }, checks, diagnostics, usedEvidence, invalidations),
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
                            content: [{ type: "text" as const, text: `rejected: coverage (no authority for ${group.rawPath})` }],
                            details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations),
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
                        content: [{ type: "text" as const, text: `rejected: coverage (no resource for ${group.rawPath})` }],
                        details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations),
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
                        content: [{ type: "text" as const, text: `rejected: coverage (weak evidence for ${group.rawPath})` }],
                        details: makeRejected(toolCallId, "coverage", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations),
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
                            content: [{ type: "text" as const, text: `failed: read ${group.rawPath}` }],
                            details: makeFailed(toolCallId, "stage", `read failed: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations),
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
                        content: [{ type: "text" as const, text: `rejected: coverage (missing valid snapshot SHA for ${group.rawPath})` }],
                        details: makeRejected(toolCallId, "coverage", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations),
                    };
                }
                if (resource.fullFileSha256 !== currentSha) {
                    diagnostics.push(`stale: current sha ${currentSha} != attested ${resource.fullFileSha256} for ${canonicalTarget}`);
                    return {
                        content: [{ type: "text" as const, text: `rejected: stale (${group.rawPath})` }],
                        details: makeRejected(toolCallId, "stale", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations),
                    };
                }

                const hasTextEdits = group.edits.length > 0;

                // Reject patches combining text edits with delete topology.
                if (hasTextEdits && group.topology?.kind === "delete") {
                    diagnostics.push(`text edits combined with delete topology for ${group.rawPath}: cannot edit and delete the same file in one group`);
                    return {
                        content: [{ type: "text" as const, text: `rejected: conflicting operations (${group.rawPath})` }],
                        details: makeRejected(toolCallId, "conflict", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations),
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
                            content: [{ type: "text" as const, text: `failed: delete ${group.rawPath}` }],
                            details: makeFailed(toolCallId, "write", `delete failed: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations),
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
                    continue;
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
                                content: [{ type: "text" as const, text: `failed: edit (missing fields) in ${group.rawPath}` }],
                                details: makeFailed(toolCallId, "stage", `edit missing oldText/newText: ${group.rawPath}`, {
                                    inspectionId: evidenceRefForDetails.inspectionId,
                                    resourceIds: [resource.resourceId],
                                }, checks, diagnostics, usedEvidence, invalidations),
                            };
                        }
                        if (!newContent.includes(edit.oldText)) {
                            diagnostics.push(`oldText not found in composed buffer for ${group.rawPath}`);
                            return {
                                content: [{ type: "text" as const, text: `failed: edit (oldText not found) in ${group.rawPath}` }],
                                details: makeFailed(toolCallId, "stage", `oldText not found: ${group.rawPath}`, {
                                    inspectionId: evidenceRefForDetails.inspectionId,
                                    resourceIds: [resource.resourceId],
                                }, checks, diagnostics, usedEvidence, invalidations),
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
                            content: [{ type: "text" as const, text: message }],
                            details: {
                                ...makeFailed(toolCallId, "stage", `edit planning failed: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations),
                                ...(matchCode === "NOT_FOUND" || matchCode === "AMBIGUOUS" ? { matchFailure: matchCode } : {}),
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
                        content: [{ type: "text" as const, text: `rejected: coverage (${group.rawPath})` }],
                        details: makeRejected(toolCallId, "coverage", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations),
                    };
                }

                // Repair is evaluated only against the in-memory candidate.
                // A successful repair is still an untrusted new mutation: compute
                // its changed preimage range and require the same evidence
                // authority before it can reach a write.
                const repairRunner = deps.runRepair;
                const repair = repairRunner
                    ? await repairRunner({ path: canonicalTarget, content: newContent, cwd: ctx.cwd }).catch((err: unknown): RepairLoopResult => ({
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
                        checks.advisory.push(makeCheck(`repair:${group.rawPath}`, "pass", repair.summary));
                    } else {
                        diagnostics.push(`repair: skipped for ${canonicalTarget}; repaired content exceeded the edit's authorized preimage range`);
                        checks.advisory.push(makeCheck(`repair:${group.rawPath}`, "skipped", "repaired content exceeded existing evidence authority"));
                    }
                } else if (!repair.passed) {
                    checks.advisory.push(makeCheck(`repair:${group.rawPath}`, "skipped", repair.summary));
                }
                }

                // Run allowlisted checks (per file). Postwrite-phase checks run
                // only after the write (below); running them here would observe
                // the pre-write content and mis-record them.
                const verifiers = deps.getVerificationChecks?.() ?? [];
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

                // Advisory risk-warning check (non-blocking, warnings only).
                // Runs before write to catch dangerous patterns in edit content
                // and paths. Topology-only groups (add/delete/rename) still run
                // path risk warnings; add-file content is scanned too.
                const safetyEdits: readonly EditItem[] = group.edits;
                const safetyExtraContent: string[] =
                  group.topology?.kind === "add" && typeof group.topology.content === "string"
                    ? [group.topology.content]
                    : [];
                const safetyResult = await checkEditSafety(canonicalTarget, safetyEdits, undefined, safetyExtraContent);
                if (safetyResult.warnings.length > 0) {
                    // Surface warnings as advisory check records
                    for (const w of safetyResult.warnings) {
                        checks.advisory.push(makeCheck("risk-warning", "pass", w));
                    }
                }

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
                    rollbackInfo = buildRollbackInfo(transaction.transactionId, rollback);
                    committed = true;
                    return {
                        content: [{ type: "text" as const, text: `failed: write ${group.rawPath}` }],
                        details: makeFailed(toolCallId, "write", `write failed: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence, invalidations, rollbackInfo),
                    };
                }

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
                invalidations.push(pendingInvalidation);

                // Post-write verify.
                let postContent: string;
                try {
                    const statRes = await fsStat(canonicalTarget);
                    void statRes;
                    postContent = await safeReadUtf8(canonicalTarget);
                } catch (err) {
                    diagnostics.push(`verify read failed: ${err instanceof Error ? err.message : String(err)}`);
                    return {
                        content: [{ type: "text" as const, text: `failed: verify ${group.rawPath}` }],
                        details: makeFailed(toolCallId, "verify", `post-write read failed: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence, invalidations),
                    };
                }
                const postSha = sha256OfString(postContent);
                const postVerifySha = sha256OfString(newContent);
                if (postSha !== postVerifySha) {
                    diagnostics.push(`verify mismatch: in-memory ${postVerifySha} != on-disk ${postSha} for ${canonicalTarget}`);
                    return {
                        content: [{ type: "text" as const, text: `failed: verify ${group.rawPath}` }],
                        details: makeFailed(toolCallId, "verify", `post-write hash mismatch: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence, invalidations),
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
                            content: [{ type: "text" as const, text: `failed: post-write check (${group.rawPath})` }],
                            details: makeFailed(toolCallId, "verify", `blocking post-write check failed: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations),
                        };
                    }
                }

                if (group.topology?.kind === "rename") {
                    try {
                        await transaction.rename(
                            canonicalTxPath(pathResolve(ctx.cwd, group.topology.oldPath)),
                            canonicalTxPath(pathResolve(ctx.cwd, group.topology.newPath)),
                        );
                    } catch (err) {
                        diagnostics.push(`rename failed: ${err instanceof Error ? err.message : String(err)}`);
                        return {
                            content: [{ type: "text" as const, text: `failed: rename ${group.rawPath}` }],
                            details: makeFailed(toolCallId, "write", `rename failed: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations),
                        };
                    }
                    // The old path no longer exists on disk. Every downstream
                    // use — post-edit evidence, finalizedFiles (and therefore
                    // the LSP/compiler finalization lanes), the displayed diff
                    // path, and the applied-file lists — must reference the
                    // file at its NEW location, not the deleted old path.
                    const renamedAbsolute = pathResolve(ctx.cwd, group.topology.newPath);
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
                        fullFileSha256: currentSha,
                        newFullFileSha256: postSha,
                        coverage: resource.coverage,
                    });
                }

                const newLines = postContent.split("\n");
                const postEditEvidence: PostEditEvidence = {
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
            }

            // Capture undo records (which snapshot post-write disk content for
            // afterSha) BEFORE commit() releases the lock. commit()'s only
            // side effect is releasing the lock — every write already landed
            // on disk atomically earlier in this loop — so reading undo state
            // while the lock is still held closes the window where a second,
            // concurrent SmartEdit transaction could mutate the file between
            // release and a fresh post-commit disk read, which would corrupt
            // afterSha with someone else's write.
            const undoRecords = await transaction.getUndoRecords().catch(() => []);
            await transaction.commit();
            committed = true;
            try {
                await saveTransactionUndoRecords(ctx.cwd, undoRecords);
            } catch (err) {
                // Undo persistence is best-effort and must never turn a durable
                // applied result into a failure.
                diagnostics.push(`undo persistence failed after commit: ${err instanceof Error ? err.message : String(err)}`);
            }
            } finally {
                if (!committed) {
                    const rollback = await transaction.rollback();
                    rollbackInfo = buildRollbackInfo(transaction.transactionId, rollback);
                    const failedRollbackPaths = new Set(rollback.failed);
                    invalidations.splice(
                        0,
                        invalidations.length,
                        ...invalidations.filter((invalidation) => failedRollbackPaths.has(invalidation.canonicalPath)),
                    );
                    diagnostics.push(`rollback: restored ${rollback.restored.length} path(s)`);
                    if (rollback.failed.length > 0) diagnostics.push(`rollback failed: ${rollback.failed.join(", ")}`);
                }
            }

            // Final-only lanes must observe committed state. They remain
            // advisory: a diagnostic or bridge failure cannot turn a durable
            // transaction into a reported rollback.
            let finalization: unknown;
            if (deps.runFinalSuccessLanes && finalizedFiles.length > 0) {
                try {
                    const result = await deps.runFinalSuccessLanes({ cwd: ctx.cwd, toolCallId, files: finalizedFiles });
                    finalization = result.evidence;
                    diagnostics.push(...(result.diagnostics ?? []));
                    for (const lane of result.checks ?? []) {
                        const check = makeCheck(lane.id, lane.outcome, lane.detail);
                        checks.advisory.push(check);
                        checks.completed.push(check);
                    }
                } catch (err) {
                    const detail = err instanceof Error ? err.message : String(err);
                    diagnostics.push(`finalization: ${detail}`);
                    const check = makeCheck("finalization", "skipped", detail);
                    checks.advisory.push(check);
                    checks.completed.push(check);
                }
            }

            // Surface evidence-pipeline uncertainty in skipped bucket.
            if (autoInspected) {
                checks.skipped.push(makeCheck("evidence-pipeline", "skipped", "auto-inspected (no prior inspect call); pipeline check was replaced by in-tool read+sha"));
            } else {
                checks.skipped.push(makeCheck("evidence-pipeline", "skipped", "evidence-pipeline check ran above; this row records pipeline uncertainty for the consumer"));
            }

            // Build the final details. For v3 multi-file, postEditEvidence is
            // emitted per file via the postEditEvidenceByPath map, and the
            // top-level postEditEvidence is the last (or only) file's value
            // for backward compatibility with v1 single-file consumers.
            // Post evidence is keyed by canonical target, not the caller's raw
            // path. Use the per-applied canonical target so a symlinked or
            // topology path resolves to its real file's evidence.
            const lastCanonical = appliedCanonical.at(-1) ?? "";
            const lastPost = lastCanonical ? postEditEvidenceByPath.get(lastCanonical) : undefined;

            const singleDiff = displayDiffs.length === 1 ? displayDiffs[0] : undefined;
            const combinedDiff = singleDiff
                ? singleDiff.diff
                : displayDiffs.map((entry) => `${entry.path}\n${entry.diff}`).join("\n\n");
            const details: PatchToolDetails = {
                tool: "patch",
                status: { kind: "applied" },
                toolCallId,
                evidenceRef: evidenceRefForDetails,
                usedEvidence: [...new Set(usedEvidence)],
                changedResources: invalidations,
                postEditEvidence: lastPost,
                checks: freezeChecks(checks),
                diagnostics,
                diff: combinedDiff,
                diffs: displayDiffs,
                repairs: Object.fromEntries(repairsByPath),
                finalization,
                rollback: rollbackInfo,
            };
            // Built from appliedSummaries (recorded per applied group at the
            // point it was applied) rather than indexing groups[0], which does
            // not necessarily correspond to appliedFiles[0] and previously
            // reported "applied 0 edit(s)" for a topology-only group.
            const summary = appliedSummaries.length === 1
                ? `applied ${appliedSummaries[0]}`
                : `applied: ${appliedSummaries.join("; ")}`;
            // Diagnostics were already collected into `details.diagnostics` by
            // runFinalSuccessLanes above; without this, they were only visible
            // via `details` (not shown to the model) — surface a bounded copy
            // in `content` too, advisory-only, without changing pass/fail.
            const diagnosticsBlock = formatBoundedDiagnostics(diagnostics);
            return {
                content: appendDiagnosticsToContent(
                    [{ type: "text" as const, text: summary }],
                    diagnosticsBlock,
                ) as { type: "text"; text: string }[],
                details,
            };
        },
    };
}

// Repair-span helpers (mapRepairSpanToPreimage, changedLineRanges) live in
// the shared kernel (./patch/repair-spans.js); imported above.

// buildRollbackInfo, makeRejected, makeFailed, classifyRpcError live in
// ./patch/result-builders.js (imported above).
