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
import { checkEditSafety } from "./safety/approval-gating.js";
import { EDIT_PARAMETERS, validateEditRequest, type RefactorRequest } from "./edit-contract.js";
import type { PriorAuthorityStore } from "./context/evidence-authority.js";
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
    PatchExecutionState,
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
    classifyRpcError,
} from "./patch/result-builders.js";
import { finalizeAppliedPatch } from "./patch/final-result.js";

// ── Transaction runner (shared kernel: ./patch/transaction-runner.js) ──
// EditTransaction begin/commit/rollback orchestration lives in the shared
// kernel; imported here so the orchestrator keeps working untouched.
// Pure move: zero logic change. The runner owns the try/finally, so
// terminal returns inside its try still trigger its own
// rollback-on-not-committed finally.
import { runPatchTransaction } from "./patch/transaction-runner.js";

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

            // ── Transaction lifecycle ──────────────────────────────────
            // Begin/commit/rollback orchestration lives in
            // ./patch/transaction-runner.js (pure move, zero logic change).
            // The runner owns the try/finally: terminal returns inside its
            // try still trigger its own rollback-on-not-committed finally.
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
            const state: PatchExecutionState = {
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
            };
            const txResult = await runPatchTransaction({
                deps,
                ctx,
                toolCallId,
                evidenceRefForDetails,
                canonicalRoot,
                envelope,
                priorStore,
                groups,
                resolvedTransfers,
                copySourceOnlyPaths,
                newFileCanonicals,
                state,
                stream,
            });
            if (!txResult.ok) return txResult.result;
            const rollbackInfo = txResult.rollbackInfo;

            return finalizeAppliedPatch({
                deps,
                ctx,
                toolCallId,
                state,
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
