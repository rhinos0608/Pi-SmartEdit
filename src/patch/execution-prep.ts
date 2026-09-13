// ── Execution preparation (shared kernel: ./patch/execution-prep.js) ──
// Preparation / transfer resolution / envelope acquisition plus the
// PatchExecutionState accumulator construction. Pure move: verbatim from
// src/patch.ts (stage 6 of patch.ts split), no logic change. The
// orchestrator (./execute.js) builds the `stream` closure and passes it in;
// this module owns everything from preparePatchRequest through the state
// bag construction. The double-fetch of deps.getPriorAuthority?.() is
// preserved exactly: one call here for the priorStore handed to
// runPatchTransaction, plus the internal call inside acquirePatchEnvelope.
import type {
    EvidenceRef,
    ResourceInvalidation,
    PostEditEvidence,
    WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";
import type { RepairLoopResult } from "../verification/repair-loop.js";
import type { EditRequest } from "../edit-contract.js";
import {
    preparePatchRequest,
    resolvePatchTransfers,
    acquirePatchEnvelope,
} from "./request-prep.js";
import type {
    EditGroup,
    FinalSuccessFile,
    MutableChecks,
    PatchDisplayDiff,
    PatchExecutionState,
    PatchResult,
    PatchToolDeps,
    ResolvedPatchTransfer,
} from "./types.js";

export interface PreparePatchExecutionArgs {
    readonly deps: PatchToolDeps;
    readonly toolCallId: string;
    readonly ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown };
    readonly signal: AbortSignal | undefined;
    readonly validated: { ok: true; value: EditRequest };
    readonly stream: (text: string) => void;
}

export type PreparePatchExecutionResult =
    | {
        ok: true;
        groups: EditGroup[];
        resolvedTransfers: ResolvedPatchTransfer[];
        copySourceOnlyPaths: Set<string>;
        newFileCanonicals: ReadonlySet<string>;
        envelope: WorkspaceEvidenceEnvelope | null;
        priorStore: PriorAuthorityStore | null;
        evidenceRefForDetails: EvidenceRef;
        canonicalRoot: string;
        autoInspected: boolean;
        state: PatchExecutionState;
    }
    | { ok: false; result: PatchResult };

export async function preparePatchExecution(args: PreparePatchExecutionArgs): Promise<PreparePatchExecutionResult> {
    const { deps, toolCallId, ctx, signal, validated, stream } = args;
    // Preparation / transfer resolution / envelope acquisition live in
    // file-local helpers (Lane A extract-only); orchestrator keeps the
    // transaction begin/commit/finalize phases.
    const prepared = preparePatchRequest({ validated, deps, ctx, toolCallId });
    if (!prepared.ok) return { ok: false as const, result: prepared.result };
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
    if (!transfers.ok) return { ok: false as const, result: transfers.result };
    const resolvedTransfers = transfers.resolvedTransfers;
    const transferNewFileCanonicals = transfers.transferNewFileCanonicals;
    const copySourceOnlyPaths = transfers.copySourceOnlyPaths;

    const priorStore = deps.getPriorAuthority?.() ?? null;
    const acquired = await acquirePatchEnvelope({ deps, groups, sessionFilePath, canonicalRoot, requestEvidenceRef, transferNewFileCanonicals, toolCallId, checks, diagnostics, usedEvidence, signal });
    if (!acquired.ok) return { ok: false as const, result: acquired.result };
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
    return {
        ok: true,
        groups,
        resolvedTransfers,
        copySourceOnlyPaths,
        newFileCanonicals,
        envelope,
        priorStore,
        evidenceRefForDetails,
        canonicalRoot,
        autoInspected,
        state,
    };
}
