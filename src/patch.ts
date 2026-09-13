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

// ── Execute orchestrator (shared kernel: ./patch/execute.js) ───────
// dispatchValidatedRequest + preparePatchExecution + executePatch own the
// execute() pipeline verbatim; patch.ts stays the stable public facade.
// Pure move: zero logic change.
import { executePatch } from "./patch/execute.js";

// ── Patch tool factory ──────────────────────────────────────────────

export function createPatchTool(deps: PatchToolDeps): PatchTool {
    return {
        name: "patch",
        label: "patch",
        description:
            "Apply edits to files gated by workspace evidence. Existing files require prior strong read authority; new files may use empty-file semantics. Provide a `path` and a list of `edits`, or a `raw` patch string (mutually exclusive); each edit may carry its own `path`. Freshness and coverage are validated automatically; returns a discriminated lifecycle result (applied | rejected | failed).",
        parameters: EDIT_PARAMETERS as unknown as Record<string, unknown>,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            // Pipeline owned by ./patch/execute.js (dispatchValidatedRequest →
            // preparePatchExecution → runPatchTransaction →
            // finalizeAppliedPatch). The stream closure now builds inside
            // executePatch; this facade only forwards the PatchInvocation.
            // Pure move: zero logic change.
            return executePatch(deps, { toolCallId, params, signal, onUpdate, ctx });
        },
    };
}

// Repair-span helpers (mapRepairSpanToPreimage, changedLineRanges) live in
// the shared kernel (./patch/repair-spans.js), consumed by
// ./patch/group-planning.js.

// buildRollbackInfo, makeRejected, makeFailed, classifyRpcError live in
// ./patch/result-builders.js (imported above).
