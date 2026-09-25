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
    type MutationDetails,
    type EvidenceRef,
    type CheckRecord,
    type ResourceInvalidation,
    type PostEditEvidence,
} from "@rhinos0608/pi-workspace-protocol";
import { generateDiffString } from "./core/edit-diff.js";
import { checkEditSafety } from "./safety/approval-gating.js";
import { getEditParameters, validateEditRequest, type RefactorRequest } from "./edit-contract.js";
import type { PriorAuthorityStore } from "./context/evidence-authority.js";
import type { EditItem, EditTarget, FileSnapshot, HashlineEditMetadata } from "./core/types.js";
import type { RepairLoopResult } from "./verification/repair-loop.js";

// ── Public surface (shared kernel: ./patch/types.js) ────────────────
// Type definitions live in the shared kernel; re-exported here so existing
// importers keep working untouched. Pure move: zero logic change.
import type {
    PatchToolDeps,
    PatchResult,
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
import { finalizeAppliedPatch } from "./mutation/final-result.js";

// ── Transaction runner (shared kernel: ./patch/transaction-runner.js) ──
// EditTransaction begin/commit/rollback orchestration lives in the shared
// kernel; imported here so the orchestrator keeps working untouched.
// Pure move: zero logic change. The runner owns the try/finally, so
// terminal returns inside its try still trigger its own
// rollback-on-not-committed finally.

// ── Group planning (shared kernel: ./patch/group-planning.js) ──────────
// Per-group preimage authorization, candidate mutation planning, and
// advisory repair integration live in the shared kernel; imported here so
// the orchestrator keeps working untouched. Pure move: zero logic change.

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

// ── Refactor preview (shared kernel: ./patch/refactor-preview.js) ──
// Rename / organize-imports / formatting / code-action preview planning
// plus apply-preview live in the shared kernel; imported here so the
// orchestrator keeps working untouched. Pure move: zero logic change.
// handleRefactorRequest returns PatchResult|null (null = not refactor →
// orchestrator continues). isBlockingPostwriteFailure is shared with the
// orchestrator postwrite loop (imported, not duplicated).

// ── Execute orchestrator (shared kernel: ./patch/execute.js) ───────
// dispatchValidatedRequest + preparePatchExecution + executePatch own the
// execute() pipeline verbatim; patch.ts stays the stable public facade.
// Pure move: zero logic change.
import { executePatch } from "./patch/execute.js";

// ── Patch tool factory ──────────────────────────────────────────────

export function createPatchTool(deps: PatchToolDeps): PatchTool {
    const hashlineOnly = deps.useHashlineEditing === true;
    return {
        name: "patch",
        label: "patch",
        description: hashlineOnly
            ? [
                "Apply hashline edits only, gated by workspace evidence.",
                "Read each target file first and copy complete LINE+ID anchors exactly from read output; only anchor lines actually shown by read, and read an elided/unseen target range before editing it.",
                "Keep ranges tight around changed lines; split nonadjacent changes into separate edit items instead of including unchanged keeper lines.",
                "The top-level edits field must be a native JSON array of edit objects, never a JSON-encoded string and never a singleton object. Each edit must use nested hashline.range plus hashline.content. Replace/delete example: { edits: [{ hashline: { range: { pos: \"112zc\", end: \"114aa\" }, content: replacement } }] }. Insert-after example: { edits: [{ hashline: { range: { pos: \"112zc:after\", end: \"112zc\" }, content: inserted } }] }.",
                "Copy only the LINE+ID token before the | separator from read output; never include the | or source text. Use :after or :before on pos for pure insertion instead of re-emitting keeper source lines. All anchors in one call refer to the same pre-edit file version.",
                "After a successful edit call, re-read before issuing another hashline edit against that file.",
                "Do not send oldText/newText, raw patches, lineRange, AST target operations, or refactor requests in hashline mode.",
              ].join(" ")
            : "Apply edits to files gated by workspace evidence. Existing files require prior strong read authority; new files may use empty-file semantics. Provide a `path` and a list of `edits`, or a `raw` patch string (mutually exclusive); each edit may carry its own `path`. Freshness and coverage are validated automatically; returns a discriminated lifecycle result (applied | rejected | failed). Use patch to transform or generate content; when existing content should be preserved and relocated/reused, prefer transfer.",
        parameters: getEditParameters(hashlineOnly) as unknown as Record<string, unknown>,

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
