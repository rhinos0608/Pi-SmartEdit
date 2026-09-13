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
import { generateDiffString } from "./core/edit-diff.js";
import { materializeTransfers } from "./patch/transfer-staging.js";
import { checkEditSafety } from "./safety/approval-gating.js";
import { EDIT_PARAMETERS, validateEditRequest, type RefactorRequest } from "./edit-contract.js";
import type { PriorAuthorityStore } from "./context/evidence-authority.js";
import { EditTransaction } from "./mutation/edit-transaction.js";
import { saveTransactionUndoRecords } from "./undo/edit-history.js";
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
    runVerifierCheck,
    failResult,
    makeRejected,
    makeFailed,
    buildRollbackInfo,
    classifyRpcError,
} from "./patch/result-builders.js";
import { finalizeAppliedPatch } from "./patch/final-result.js";

// ── Group planning (shared kernel: ./patch/group-planning.js) ──────────
// Per-group preimage authorization, candidate mutation planning, and
// advisory repair integration live in the shared kernel; imported here so
// the orchestrator keeps working untouched. Pure move: zero logic change.
import { resolveAuthorizedGroupPreimage, planGroupMutation, applyAuthorizedRepair } from "./patch/group-planning.js";

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
            // triggers the finally-block rollback below. Staging lives in
            // ./patch/transfer-staging.js (pure move, zero logic change).
            const staged = materializeTransfers({
                resolvedTransfers,
                transaction,
                groups,
                priorStore,
                envelope,
                evidenceRefForDetails,
                toolCallId,
                checks,
                diagnostics,
                usedEvidence,
                invalidations,
            });
            if (!staged.ok) return staged.result;

            for (const group of groups) {
                // Skip bookkeeping placeholders (e.g. rename destination paths) that have
                // no text edits and no topology — nothing to apply.
                if (group.edits.length === 0 && !group.topology) continue;

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
                if (!preimage.ok) return preimage.result;
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
                let displayPath: string = group.rawPath;

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
                    appliedFiles,
                    appliedCanonical,
                    appliedSummaries,
                    displayDiffs,
                    stream,
                });
                if (!planned.ok) return planned.result;
                if (planned.kind === "deleted") continue;
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
                    repairsByPath,
                });
                newContent = repaired.content;

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

            return finalizeAppliedPatch({
                deps,
                ctx,
                toolCallId,
                state: {
                    checks,
                    diagnostics,
                    usedEvidence,
                    invalidations,
                    postEditEvidenceByPath,
                    repairsByPath,
                    finalizedFiles,
                    appliedFiles,
                    appliedCanonical,
                    appliedSummaries,
                    displayDiffs,
                },
                autoInspected,
                evidenceRefForDetails,
                rollbackInfo,
            });
        },
    };
}

// Repair-span helpers (mapRepairSpanToPreimage, changedLineRanges) live in
// the shared kernel (./patch/repair-spans.js), consumed by
// ./patch/group-planning.js.

// buildRollbackInfo, makeRejected, makeFailed, classifyRpcError live in
// ./patch/result-builders.js (imported above).
