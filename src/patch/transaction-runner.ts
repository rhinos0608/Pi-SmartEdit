/**
 * Patch transaction runner — EditTransaction begin/commit/rollback orchestration.
 * Pure move: verbatim from src/patch.ts (stage 5 of patch.ts split),
 * no logic change. The orchestrator keeps preparation, transfer resolution,
 * envelope acquisition, and finalization; this module owns everything from
 * canonicalTxPath construction through the commit/rollback finally.
 *
 * Covers, in exact pipeline order:
 *   canonicalTxPath + transaction lock-path set → EditTransaction.begin()
 *   (begin-failure maps to a terminal result) → try { materializeTransfers
 *   → per-group executeEditGroup loop with the write-failure committed/
 *   rollbackInfo outbox → undo-record capture BEFORE commit → commit() →
 *   best-effort undo persistence AFTER commit } finally { rollback if not
 *   committed, filtering invalidations to paths whose rollback failed }.
 *
 * Invariants (never change without explicit approval):
 * - Terminal returns happen INSIDE the try so the finally's
 *   rollback-on-not-committed still runs for them. Never restructure into
 *   "return early, caller rolls back" — that changes rollback timing.
 * - Terminal results reference the SAME live diagnostics/invalidations
 *   arrays the finally mutates afterward (no clones/snapshots).
 * - Undo-record capture happens BEFORE commit() (post-write disk content
 *   read under lock); persistence AFTER commit is best-effort/advisory-only.
 * - Write failure sets committed=true in the loop (immediate rollback
 *   already done inside persistContentGroup); every other failure leaves
 *   committed=false for the outer finally. Never merge/normalize these.
 * - checkEditSafety stays advisory-only (owned by group-application.js).
 *   Never wire assertEditableFile.
 * - All writes go through EditTransaction. No path-containment/cwd-scoping gate.
 */
import { realpathSync } from "node:fs";

import type {
    EvidenceRef,
    WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";
import { EditTransaction } from "../mutation/edit-transaction.js";
import { saveTransactionUndoRecords } from "../undo/edit-history.js";
import { materializeTransfers } from "./transfer-staging.js";
import { executeEditGroup } from "./group-application.js";
import { buildRollbackInfo, makeFailed } from "./result-builders.js";
import type {
    EditGroup,
    PatchExecutionState,
    PatchResult,
    PatchToolDeps,
    ResolvedPatchTransfer,
} from "./types.js";

export interface RunPatchTransactionArgs {
    readonly deps: PatchToolDeps;
    readonly ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown };
    readonly toolCallId: string;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly canonicalRoot: string;
    readonly envelope: WorkspaceEvidenceEnvelope | null;
    readonly priorStore: PriorAuthorityStore | null;
    /** Live groups array — materializeTransfers appends synthesized transfer
     *  edits to its entries in place. Never a copy. */
    readonly groups: EditGroup[];
    readonly resolvedTransfers: ReadonlyArray<ResolvedPatchTransfer>;
    readonly copySourceOnlyPaths: ReadonlySet<string>;
    readonly newFileCanonicals: ReadonlySet<string>;
    /** Live accumulator bag — the SAME array/map instances the caller
     *  finalizes with afterward. Never cloned. */
    readonly state: PatchExecutionState;
    readonly stream: (text: string) => void;
}

export type RunPatchTransactionResult =
    | { ok: true; rollbackInfo?: { ok: boolean; reason?: string } }
    | { ok: false; result: PatchResult };

export async function runPatchTransaction(args: RunPatchTransactionArgs): Promise<RunPatchTransactionResult> {
    const { deps, ctx, toolCallId, evidenceRefForDetails, canonicalRoot, envelope, priorStore, groups, resolvedTransfers, copySourceOnlyPaths, newFileCanonicals, state, stream } = args;
    const { checks, diagnostics, usedEvidence, invalidations } = state;

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
            ok: false,
            result: {
                content: [{ type: "text" as const, text: `failed: begin transaction (${msg})` }],
                details: makeFailed(toolCallId, "stage", `failed to begin transaction: ${msg}`, {
                    inspectionId: evidenceRefForDetails.inspectionId,
                    resourceIds: [],
                }, checks, diagnostics, usedEvidence, invalidations),
            },
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
        if (!staged.ok) return { ok: false, result: staged.result };

        const groupAppContext = { deps, ctx, toolCallId, evidenceRefForDetails, canonicalRoot, envelope, priorStore, newFileCanonicals, transaction, canonicalTxPath, stream };
        // PatchExecutionState is structurally identical to GroupApplicationState
        // (same eleven live array/map references) — pass it straight through,
        // never a copy.
        const groupAppState = state;
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
            if (groupResult.status === "terminal") return { ok: false, result: groupResult.result };
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

    return { ok: true, rollbackInfo };
}
