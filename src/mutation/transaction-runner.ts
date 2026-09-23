/**
 * Mutation transaction runner — EditTransaction begin/commit/rollback orchestration.
 * Pure move: verbatim from src/patch.ts (stage 5 of patch.ts split),
 * no logic change. The orchestrator keeps preparation, transfer resolution,
 * envelope acquisition, and finalization; this module owns everything from
 * canonicalTxPath construction through the commit/rollback finally.
 *
 * Covers, in exact pipeline order:
 *   canonicalTxPath + transaction lock-path set → EditTransaction.begin()
 *   (begin-failure maps to a terminal result) → try { mutation operations
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
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EditTransaction } from "./edit-transaction.js";
import type { TransactionOutcome } from "./edit-transaction.js";
import {
    appendIntent,
    buildJournalRecord,
    deleteJournal,
    markCommitted,
    recoverStaleJournals,
    writePreparedJournal,
} from "./recovery-journal.js";
import { saveTransactionUndoRecords } from "../undo/edit-history.js";
import { executeEditGroup } from "../patch/group-application.js";
import { buildRollbackInfo, makeFailed, makeRejected } from "../patch/result-builders.js";
import type { MutationResourceIntent } from "./resource-intent.js";
import type { PatchToolDeps, PatchResult } from "../patch/types.js";
import type {
    MutationGroup,
    MutationOperation,
    MutationState,
    MutationToolIdentity,
} from "./types.js";
export type { MutationOperationContext } from "./types.js";

export interface RunPatchTransactionArgs {
    readonly deps: PatchToolDeps;
    readonly ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown };
    readonly toolCallId: string;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly canonicalRoot: string;
    readonly envelope: WorkspaceEvidenceEnvelope | null;
    readonly priorStore: PriorAuthorityStore | null;
    readonly tool: MutationToolIdentity;
    /** Live groups array; mutation operations may add planned edits in place. */
    readonly groups: MutationGroup[];
    readonly resourceIntents: ReadonlyArray<MutationResourceIntent>;
    readonly operations: ReadonlyArray<MutationOperation>;
    /** Live accumulator bag — the SAME array/map instances the caller
     *  finalizes with afterward. Never cloned. */
    readonly state: MutationState;
    readonly stream: (text: string) => void;
}

export type RunPatchTransactionResult =
    | { ok: true; rollbackInfo?: { ok: boolean; reason?: string } }
    | { ok: false; result: PatchResult };

/**
 * Crash-journal per-mutation hook: wrap the transaction's fs-op methods so
 * each intent is durably journaled BEFORE its filesystem op runs. A throw
 * from the journal write propagates, blocking the mutation.
 */
function armJournalIntents(transaction: EditTransaction, transactionId: string): void {
    const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
    const write = transaction.write.bind(transaction);
    const create = transaction.create.bind(transaction);
    const remove = transaction.remove.bind(transaction);
    const rename = transaction.rename.bind(transaction);
    transaction.write = async (path: string, content: string): Promise<void> => {
        await appendIntent(transactionId, { op: "write", paths: [path], expectedPostSha: sha(content), expectedExists: true });
        await write(path, content);
    };
    transaction.create = async (path: string, content: string, mode?: number): Promise<void> => {
        await appendIntent(transactionId, { op: "create", paths: [path], expectedPostSha: sha(content), expectedExists: true });
        await create(path, content, mode);
    };
    transaction.remove = async (path: string): Promise<void> => {
        await appendIntent(transactionId, { op: "remove", paths: [path], expectedPostSha: null, expectedExists: false });
        await remove(path);
    };
    transaction.rename = async (oldPath: string, newPath: string): Promise<void> => {
        // Two per-path intents: source must end absent, destination must end
        // holding the source's bytes. Recovery matches each path separately.
        let expectedPostSha: string | null = null;
        try {
            expectedPostSha = sha(await readFile(oldPath, "utf8"));
        } catch { expectedPostSha = null; }
        await appendIntent(transactionId, { op: "rename", paths: [oldPath], expectedPostSha: null, expectedExists: false });
        await appendIntent(transactionId, { op: "rename", paths: [newPath], expectedPostSha, expectedExists: true });
        await rename(oldPath, newPath);
    };}

export async function runPatchTransaction(args: RunPatchTransactionArgs): Promise<RunPatchTransactionResult> {
    const { deps, ctx, toolCallId, tool, evidenceRefForDetails, canonicalRoot, envelope, priorStore, groups, resourceIntents, operations, state, stream } = args;
    const createdPaths = new Set(resourceIntents.filter((intent) => intent.kind === "create-new").map((intent) => intent.canonicalPath));
    const observationPaths = resourceIntents.filter((intent) => intent.kind === "observe-source").map((intent) => intent.canonicalPath);
    const { checks, diagnostics, usedEvidence, invalidations } = state;

    // One canonicalization for transaction planning and every mutation:
    // new files keep their raw resolved path (no on-disk file to
    // realpath), existing files resolve symlinks — so every path passed
    // to EditTransaction.before() was included during begin().
    const canonicalTxPath = (absolutePath: string): string => {
        if (createdPaths.has(absolutePath)) return absolutePath;
        try {
            return realpathSync(absolutePath);
        } catch {
            return absolutePath;
        }
    };
    const transactionPaths = [...new Set([
        ...groups.map((group) => canonicalTxPath(group.absolutePath)),
        ...observationPaths,
    ])];
    // Crash-journal recovery runs BEFORE new mutations: roll back partial
    // writes from dead-PID journals (or preserve committed ones) first.
    // Best-effort: recovery failure must not block this transaction.
    try {
        const recovery = await recoverStaleJournals();
        for (const conflict of recovery.conflicts) {
            diagnostics.push(
                `recovery conflict: ${conflict.path} drifted after crash of ${conflict.transactionId}; preserved on disk`,
            );
        }
    } catch (err) {
        diagnostics.push(`recovery scan failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
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
                }, checks, diagnostics, usedEvidence, invalidations, undefined, tool),
            },
        };
    }
    let committed = false;
    let rollbackInfo: { ok: boolean; reason?: string } | undefined;

    try {
        // Create-new race guard: a path planned as `create-new` must still
        // be absent in the begin snapshot. If it exists now, another writer
        // won the race between planning and begin — reject as a conflict
        // before any write lands. Runs inside the try so the outer finally
        // still rolls back (a no-op when nothing was written yet).
        for (const created of createdPaths) {
            if (transaction.getSnapshot(created)?.exists) {
                const message = `create-new conflict: ${created} already exists; read the file and retry against the existing destination`;
                diagnostics.push(message);
                return {
                    ok: false,
                    result: {
                        content: [{ type: "text" as const, text: `rejected: ${message}` }],
                        details: makeRejected(toolCallId, "conflict", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations, tool),
                    },
                };
            }
        }

        // Crash-journal PREPARED write: locks held + snapshots taken, no
        // mutation yet. Failure fails tx before first mutation (never decorative).
        const snapshots = transactionPaths.map((path) => {
            const snap = transaction.getSnapshot(path);
            return { path, exists: snap?.exists ?? false, content: snap?.content, mode: snap?.mode };
        });
        try {
            await writePreparedJournal(buildJournalRecord(transaction.transactionId, snapshots));
        } catch (err) {
            committed = false;
            await transaction.rollback().catch(() => {});
            await deleteJournal(transaction.transactionId).catch(() => {});
            const msg = `crash-journal prepare failed: ${err instanceof Error ? err.message : String(err)}`;
            diagnostics.push(msg);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `error: ${msg}` }],
                    details: makeFailed(toolCallId, "stage", msg, evidenceRefForDetails, checks, diagnostics, usedEvidence, invalidations),
                },
            };
        }
        // Per-mutation hook: each intent durable BEFORE its fs op.
        armJournalIntents(transaction, transaction.transactionId);
        for (const operation of operations) {
            const applied = operation({ transaction, groups, priorStore, envelope, evidenceRefForDetails, toolCallId, tool, checks, diagnostics, usedEvidence, invalidations });
            if (!applied.ok) return { ok: false, result: applied.result };
        }
        const groupAppContext = { deps, ctx, toolCallId, tool, evidenceRefForDetails, canonicalRoot, envelope, priorStore, createdPaths, transaction, canonicalTxPath, stream };
        // MutationState is structurally identical to GroupApplicationState
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
        // Mark COMMITTED while locks still held (writes already durable).
        // A commit-mark failure is FATAL, never advisory: the journal still
        // reads PREPARED, so acknowledging success would let a later crash
        // recovery roll back a "committed" transaction. Return terminal
        // failure instead; the outer finally rolls the landed writes back.
        try {
            await markCommitted(transaction.transactionId);
        } catch (err) {
            const msg = `crash-journal commit mark failed: ${err instanceof Error ? err.message : String(err)}; commit NOT acknowledged, writes rolled back`;
            diagnostics.push(msg);
            return {
                ok: false,
                result: {
                    content: [{ type: "text" as const, text: `error: ${msg}` }],
                    details: makeFailed(toolCallId, "stage", msg, evidenceRefForDetails, checks, diagnostics, usedEvidence, invalidations),
                },
            };
        }
        await transaction.commit();
        committed = true;
        await deleteJournal(transaction.transactionId).catch(() => {});
        try {
            await saveTransactionUndoRecords(ctx.cwd, undoRecords);
        } catch (err) {
            // Undo persistence is best-effort and must never turn a durable
            // applied result into a failure.
            diagnostics.push(`undo persistence failed after commit: ${err instanceof Error ? err.message : String(err)}`);
        }
    } finally {
        if (!committed) {
            // Rollback BEFORE journal removal: the journal is the durable
            // record for a rollback that never completes in-process. Delete
            // it only after a fully successful rollback; on partial failure
            // (or a rollback throw) preserve it so the next process's
            // recoverStaleJournals() can finish the job.
            let rollback: TransactionOutcome | null = null;
            try {
                rollback = await transaction.rollback();
            } catch (err) {
                const msg = `rollback threw: ${err instanceof Error ? err.message : String(err)}; crash journal preserved for recovery`;
                diagnostics.push(msg);
                rollbackInfo = { ok: false, reason: msg };
            }
            if (rollback !== null) {
                rollbackInfo = buildRollbackInfo(transaction.transactionId, rollback);
                const failedRollbackPaths = new Set(rollback.failed);
                invalidations.splice(
                    0,
                    invalidations.length,
                    ...invalidations.filter((invalidation) => failedRollbackPaths.has(invalidation.canonicalPath)),
                );
                diagnostics.push(`rollback: restored ${rollback.restored.length} path(s)`);
                if (rollback.failed.length > 0) {
                    diagnostics.push(`rollback failed: ${rollback.failed.join(", ")}; crash journal preserved for recovery`);
                } else {
                    // Own-journal cleanup: nothing left to recover.
                    await deleteJournal(transaction.transactionId).catch(() => {});
                }
            }
        }
    }

    return { ok: true, rollbackInfo };
}
