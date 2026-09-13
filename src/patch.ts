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
import { executeEditGroup } from "./patch/group-application.js";

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

            const groupAppContext = { deps, ctx, toolCallId, evidenceRefForDetails, canonicalRoot, envelope, priorStore, newFileCanonicals, transaction, canonicalTxPath, stream };
            const groupAppState = { checks, diagnostics, usedEvidence, invalidations, postEditEvidenceByPath, repairsByPath, finalizedFiles, appliedFiles, appliedCanonical, appliedSummaries, displayDiffs };
            for (const group of groups) {
                // Write-failure outbox: executeEditGroup marks outcome.committed
                // ONLY on the write-failure path (immediate rollback already
                // done inside); every other terminal leaves committed=false so
                // the outer finally still rolls back. Never normalize these.
                const groupOutcome: { committed: boolean; rollbackInfo?: { ok: boolean; reason?: string } } = { committed };
                if (rollbackInfo !== undefined) groupOutcome.rollbackInfo = rollbackInfo;
                const groupResult = await executeEditGroup({ context: groupAppContext, state: groupAppState, group, outcome: groupOutcome });
                committed = groupOutcome.committed;
                if (groupOutcome.rollbackInfo !== undefined) rollbackInfo = groupOutcome.rollbackInfo;
                if (groupResult.status === "terminal") return groupResult.result;
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
