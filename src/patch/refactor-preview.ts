/**
 * Workspace-edit preview consume + apply (shared kernel).
 *
 *  D-81: SmartRead stages language-intelligence results through SmartEdit's
 *  own stage_workspace_edit handler and returns SmartEdit-STAGED proposals
 *  ({ok:true, proposalId, files, diff} | {ok:false, error}). This kernel
 *  consumes those proposals by proposalId — raw workspaceEdit payloads never
 *  ride the preview path and are rejected fail-closed by the protocol
 *  validators. The only stager/applier is the workspace-edit RPC server
 *  (src/extension/register-workspace-edit-rpc.ts); the agent-facing edit
 *  tool exposes no refactor path.
 *  isBlockingPostwriteFailure is also used by the orchestrator postwrite
 * loop and imported back in src/patch.ts — not duplicated there.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import {
    hashSessionFilePath,
    sha256OfString,
    validateCodeActionResponse,
    validateFormattingResponse,
    validateRenamePreviewResponse,
} from "@rhinos0608/pi-workspace-protocol";
import type { EditTransaction } from "../mutation/edit-transaction.js";
import { globalRefactorPreviewCache } from "../lsp/refactor-preview-cache.js";
import {
    buildJournalRecord,
    deleteJournal,
    markCommitted,
    recoverStaleJournals,
    writePreparedJournal,
} from "../mutation/recovery-journal.js";
import { saveTransactionUndoRecords } from "../undo/edit-history.js";
import { checkResourceCoverage } from "../context/patch-authorization.js";
import { verifySourceOriginDocument } from "./source-origin.js";
import type {
    PatchToolDeps,
    PatchResult,
    StagedPreviewFile,
    PatchToolDetails,
} from "./types.js";
/** The only stager is the workspace-edit RPC server
 *  (src/extension/register-workspace-edit-rpc.ts), which stages raw
 *  LspWorkspaceEdit payloads via checkWorkspaceEditEncoding +
 *  planPositionalEdits and applies them via handleApplyRefactorPreview. */
export interface ApplyRefactorPreviewRefactor {
    kind: "apply-refactor-preview";
    previewId: string;
}
import {
    freshChecks,
    freezeChecks,
    failResult,
    makeRejected,
} from "./result-builders.js";

const CAPS_REQUIRED_DOC = "message must be an object";

/** Service-side budget sent inside each proposal request (protocol v0.6.0 timeoutMs envelope). */
export const PREVIEW_SERVICE_TIMEOUT_MS = 10_000;
/** Transport timeout = service budget + slack. */
export const PREVIEW_TRANSPORT_TIMEOUT_MS = 15_000;

/**
 * Require UTF-16 proposal encoding before staging.
 * LspWorkspaceEdit.positionEncoding carries this (protocol v0.6.0).
 */
export function checkWorkspaceEditEncoding(workspaceEdit: unknown): string | null {
    const enc = (workspaceEdit as { positionEncoding?: unknown } | null | undefined)?.positionEncoding;
    if (enc !== "utf-16") return "refactor preview workspaceEdit positionEncoding must be 'utf-16' (UTF-16 proposal encoding required before staging)";
    return null;
}

/**
 * Legacy runtime helpers kept for backward-compatible imports. Required
 * fields are enforced at validation time by `validateEditRequest` (kind-
 * discriminated contract in `src/edit-contract.ts`), so handlers below
 * receive narrowed variants and do not re-check required fields.
 */
export function moveSpansOverlap(seen: { canonicalFrom: string; startLine: number; endLine: number }, canonicalFrom: string, startLine: number, endLine: number): boolean {
    return seen.canonicalFrom === canonicalFrom && startLine <= seen.endLine && seen.startLine <= endLine;
}

export function isSameFileMoveCandidate(op: string, canonicalFrom: string, canonicalTo: string, after: string | undefined): boolean {
    return op === "move" && canonicalFrom === canonicalTo && after !== undefined && after !== "start";
}

export function isAfterLineInsideSourceSpan(afterLine: number | null, startLine: number, endLine: number): boolean {
    return afterLine !== null && afterLine >= startLine - 1 && afterLine <= endLine;
}

export function isBlockingPostwriteFailure(kind: string, outcome: string): boolean {
    return kind === "blocking" && (outcome === "fail" || outcome === "timeout");
}

/** Language-intelligence preview kinds. organize_imports no longer exists
 *  (D-81): callers use code-action discovery filtered to kind
 *  "source.organizeImports" plus an explicit selection — never auto-pick. */
export type BusPreviewKind = "rename" | "formatting" | "code-action";

export async function runBusPreview(args: {
    deps: PatchToolDeps;
    toolCallId: string;
    label: string;
    kind: BusPreviewKind;
    request: (bus: NonNullable<ReturnType<NonNullable<PatchToolDeps["getBus"]>>>) => Promise<unknown>;
}): Promise<PatchResult> {
    const { deps, toolCallId, label, kind, request } = args;
    const bus = deps.getBus?.() ?? null;
    if (!bus) return failResult(toolCallId, `failed: ${label} requires bus`, "bus unavailable", ["bus unavailable"]);
    try {
        const raw = await request(bus);
        const checked = validateBusProposal(kind, raw);
        if (!checked.ok) {
            return failResult(toolCallId, `failed: ${label}: ${checked.error}`, checked.error, [checked.error]);
        }
        const sessionFilePath = deps.getSessionFilePath();
        if (!sessionFilePath) {
            return failResult(toolCallId, "failed: refactor preview requires an active session (no session file path available)", "no session file path", ["no session file path"]);
        }
        // Fail closed: the proposal must already be staged in our own cache
        // (SmartRead stages through stage_workspace_edit). A bare diff plus a
        // proposalId never fabricates a preview — apply runs only via
        // apply_staged_edit/proposalId against this entry.
        const cached = globalRefactorPreviewCache.get(checked.proposalId, {
            sessionId: hashSessionFilePath(sessionFilePath),
            sessionRoot: deps.getCanonicalWorkspaceRoot(),
        });
        if (!cached) {
            const msg = "unknown or expired proposal";
            return failResult(toolCallId, `failed: ${label}: ${msg}`, msg, [msg]);
        }
        const diffString = cached.planned.diffString;
        const stagedFiles = cached.planned.stagedFiles;
        return {
            content: [{ type: "text" as const, text: `preview ${checked.proposalId}: ${stagedFiles.length} file(s)\n${diffString.slice(0, 4000)}` }],
            details: { tool: "edit", status: { kind: "applied" }, toolCallId, evidenceRef: { inspectionId: "", resourceIds: [] }, usedEvidence: [], changedResources: [], checks: freezeChecks(freshChecks()), diagnostics: [], diff: diffString, diffs: stagedFiles.map((sf) => ({ path: sf.filePath, diff: sf.newContent })), previewId: checked.proposalId, stagedFiles: stagedFiles.length } as unknown as PatchToolDetails,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failResult(toolCallId, `failed: ${label} ${msg}`, msg, [msg]);
    }
}

/** Validate a bus reply as a staged proposal (D-81). Raw workspaceEdit
 *  payloads are rejected fail-closed by the protocol validators' exact key
 *  sets; code-action discovery candidates without an explicit selection are
 *  rejected here — never auto-pick. */
function validateBusProposal(kind: BusPreviewKind, raw: unknown): { ok: true; proposalId: string } | { ok: false; error: string } {
    if (kind === "rename") {
        const v = validateRenamePreviewResponse(raw);
        if (!v.ok) return { ok: false, error: v.error };
        if (!v.value.ok) return { ok: false, error: v.value.error };
        return { ok: true, proposalId: v.value.proposalId };
    }
    if (kind === "formatting") {
        const v = validateFormattingResponse(raw);
        if (!v.ok) return { ok: false, error: v.error };
        if (!v.value.ok) return { ok: false, error: v.value.error };
        return { ok: true, proposalId: v.value.proposalId };
    }
    const v = validateCodeActionResponse(raw);
    if (!v.ok) return { ok: false, error: v.error };
    if (!v.value.ok) return { ok: false, error: v.value.error };
    if (!("proposalId" in v.value)) {
        return { ok: false, error: "code_action discovery returned candidates without an explicit selection — refusing to auto-pick (pass selection {actionId, sourceSha256} to resolve)" };
    }
    return { ok: true, proposalId: v.value.proposalId };
}

/** Admission caps for LSP-planned refactor output, enforced before caching/apply. Mirrors edit caps. */
export const MAX_PREVIEW_FILES = 50;
export const MAX_PREVIEW_TEXT_BYTES = 4 * 1024 * 1024;

export function checkPlannedPreviewCaps(planned: { stagedFiles: Array<{ filePath: string; newContent: string }>; diffString: string }): string | null {
    if (planned.stagedFiles.length > MAX_PREVIEW_FILES)
        return `refactor preview touches ${planned.stagedFiles.length} files (max ${MAX_PREVIEW_FILES}): narrow the refactor scope and retry`;
    let total = Buffer.byteLength(planned.diffString, "utf8");
    for (const sf of planned.stagedFiles) {
        total += Buffer.byteLength(sf.newContent, "utf8");
        if (total > MAX_PREVIEW_TEXT_BYTES)
            return `refactor preview text is over ${MAX_PREVIEW_TEXT_BYTES} bytes total: narrow the refactor scope and retry`;
    }
    return null;
}

export async function findStalePreviewFiles(files: StagedPreviewFile[]): Promise<string[]> {
    const staleFiles: string[] = [];
    for (const sf of files) {
        try {
            const current = (await fsReadFile(sf.filePath)).toString("utf8");
            if (current !== sf.originalContent) staleFiles.push(sf.filePath);
        } catch {
            staleFiles.push(sf.filePath);
        }
    }
    return staleFiles;
}

export function findPreviewUnauthorizedFiles(deps: PatchToolDeps, files: StagedPreviewFile[]): string[] {
    const priorStore = deps.getPriorAuthority?.() ?? null;
    const unauthorized: string[] = [];
    for (const sf of files) {
        let canonical: string;
        try { canonical = realpathSync(sf.filePath); } catch { canonical = sf.filePath; }
        let res = priorStore ? priorStore.select(canonical) : null;
        if (!res) res = priorStore ? priorStore.select(sf.filePath) : null;
        if (!res) { unauthorized.push(`${sf.filePath} (no prior read authority)`); continue; }
        const preimageSha = sha256OfString(sf.originalContent);
        if (res.fullFileSha256 !== preimageSha) { unauthorized.push(`${sf.filePath} (SHA mismatch: authority ${String(res.fullFileSha256).slice(0, 8)} != preimage ${preimageSha.slice(0, 8)})`); continue; }
        const touched: Array<{ startLine: number; endLine: number }> = sf.edits.length === 0 ? [] : sf.edits.map((e) => ({ startLine: e.range.start.line + 1, endLine: e.range.end.line + 1 }));
        if (touched.length === 0) continue;
        const covErr = checkResourceCoverage(res, touched);
        if (covErr) unauthorized.push(`${sf.filePath} (${covErr})`);
    }
    return unauthorized;
}

export function mapApplyPreviewError(toolCallId: string, err: unknown): PatchResult {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("rejected:")) {
        return { content: [{ type: "text" as const, text: msg }], details: makeRejected(toolCallId, "coverage", [msg], { inspectionId: "", resourceIds: [] }, freshChecks()) };
    }
    return failResult(toolCallId, `failed: apply refactor ${msg}`, msg, [msg], "write");
}

type PreviewApplyContext = {
    deps: PatchToolDeps;
    toolCallId: string;
    tx: EditTransaction;
    files: StagedPreviewFile[];
    originDocument?: { canonicalPath: string; sha256: string };
};

async function resolveApplyPreviewTarget(args: { deps: PatchToolDeps; toolCallId: string; previewId: string }): Promise<{ files: StagedPreviewFile[]; diffString: string; originDocument?: { canonicalPath: string; sha256: string } } | PatchResult> {
    const { deps, toolCallId, previewId } = args;
    const sessionFilePath = deps.getSessionFilePath();
    if (!sessionFilePath) {
        return failResult(toolCallId, "failed: refactor preview requires an active session (no session file path available)", "no session file path", ["no session file path"]);
    }
    const root = deps.getCanonicalWorkspaceRoot();
    const sid = hashSessionFilePath(sessionFilePath);
    const cached = globalRefactorPreviewCache.get(previewId, { sessionId: sid, sessionRoot: root });
    if (!cached) {
        return { content: [{ type: "text" as const, text: "rejected: preview not found or expired" }], details: makeRejected(toolCallId, "coverage", ["preview not found or expired"], { inspectionId: "", resourceIds: [] }, freshChecks()) };
    }
    return { files: cached.planned.stagedFiles, diffString: cached.planned.diffString, originDocument: cached.originDocument };
}

async function verifyPreviewPreconditions(args: PreviewApplyContext): Promise<PatchResult | null> {
    const { deps, toolCallId, tx, files, originDocument } = args;
    if (originDocument) {
        const originCheck = await verifySourceOriginDocument(originDocument);
        if (!originCheck.ok) {
            await tx.rollback();
            await deleteJournal(tx.transactionId).catch(() => {});
            return { content: [{ type: "text", text: originCheck.reason }], details: makeRejected(toolCallId, "stale", [originCheck.reason], { inspectionId: "", resourceIds: [] }, freshChecks()) };
        }
    }
    const staleFiles = await findStalePreviewFiles(files);
    if (staleFiles.length > 0) {
        await tx.rollback();
        await deleteJournal(tx.transactionId).catch(() => {});
        return { content: [{ type: "text", text: `rejected: files changed since preview: ${staleFiles.join(", ")}` }], details: makeRejected(toolCallId, "stale", [`files changed since preview: ${staleFiles.join(", ")}`], { inspectionId: "", resourceIds: [] }, freshChecks()) };
    }
    const unauthorized = findPreviewUnauthorizedFiles(deps, files);
    if (unauthorized.length > 0) {
        await tx.rollback();
        await deleteJournal(tx.transactionId).catch(() => {});
        return { content: [{ type: "text", text: `rejected: missing read authority for: ${unauthorized.join(", ")} — read the file first, then retry` }], details: makeRejected(toolCallId, "coverage", [`missing read authority for: ${unauthorized.join(", ")}`], { inspectionId: "", resourceIds: [] }, freshChecks()) };
    }
    return null;
}

async function writePreviewPreparedJournal(args: { tx: EditTransaction; files: StagedPreviewFile[] }): Promise<void> {
    const { tx, files } = args;
    // Crash-journal PREPARED write while locks are held, before the
    // first mutation — mirrors runPatchTransaction.
    try {
        const snapshots = files.map((f) => {
            const snap = tx.getSnapshot(f.filePath);
            return { path: f.filePath, exists: snap?.exists ?? false, content: snap?.content, mode: snap?.mode };
        });
        await writePreparedJournal(buildJournalRecord(tx.transactionId, snapshots));
    } catch (e) {
        try { await tx.rollback(); } catch { /* rollback best-effort */ }
        throw e;
    }
}

async function commitPreviewFiles(args: {
    tx: EditTransaction;
    files: StagedPreviewFile[];
    undoCwd: string;
    originDocument?: { canonicalPath: string; sha256: string };
    toolCallId: string;
}): Promise<PatchResult | null> {
    const { tx, files, undoCwd, originDocument, toolCallId } = args;
    await writePreviewPreparedJournal({ tx, files });

    // Final generation recheck immediately before entering first mutation while existing transaction held
    if (originDocument) {
        const finalOriginCheck = await verifySourceOriginDocument(originDocument);
        if (!finalOriginCheck.ok) {
            await tx.rollback();
            await deleteJournal(tx.transactionId).catch(() => {});
            return {
                content: [{ type: "text", text: finalOriginCheck.reason }],
                details: makeRejected(
                    toolCallId,
                    "stale",
                    [finalOriginCheck.reason],
                    { inspectionId: "", resourceIds: [] },
                    freshChecks()
                ),
            };
        }
    }

    for (const sf of files) await tx.write(sf.filePath, sf.newContent);
    // Capture undo records (post-write disk content) BEFORE commit
    // releases the lock; persist AFTER commit, best-effort.
    const undoRecords = await tx.getUndoRecords().catch(() => []);
    await markCommitted(tx.transactionId);
    await tx.commit();
    await deleteJournal(tx.transactionId).catch(() => {});
    try { await saveTransactionUndoRecords(undoCwd, undoRecords); } catch { /* undo persistence is advisory */ }
    return null;
}

export async function handleApplyRefactorPreview(deps: PatchToolDeps, toolCallId: string, refactor: ApplyRefactorPreviewRefactor, cwd?: string): Promise<PatchResult> {
    const target = await resolveApplyPreviewTarget({ deps, toolCallId, previewId: refactor.previewId });
    if ("content" in target) return target;
    const { files, diffString, originDocument } = target;
    const undoCwd = cwd ?? deps.getCanonicalWorkspaceRoot();
    try {
        const { EditTransaction: ET } = await import("../mutation/edit-transaction.js");
        // Best-effort crash recovery first, mirroring the mutation kernel:
        // roll back partial writes from dead-PID journals before mutating.
        try { await recoverStaleJournals(); } catch { /* advisory; never block apply */ }
        const tx = await ET.begin(files.map((f) => f.filePath));
        try {
            const blocked = await verifyPreviewPreconditions({ deps, toolCallId, tx, files, originDocument });
            if (blocked) return blocked;
            const commitBlocked = await commitPreviewFiles({ tx, files, undoCwd, originDocument, toolCallId });
            if (commitBlocked) return commitBlocked;
        } catch (e) {
            try { await tx.rollback(); } catch {}
            throw e;
        }
        globalRefactorPreviewCache.delete(refactor.previewId);
        return { content: [{ type: "text" as const, text: `applied refactor ${refactor.previewId}: ${files.length} file(s)` }], details: { tool: "edit", status: { kind: "applied" }, toolCallId, evidenceRef: { inspectionId: "", resourceIds: [] }, usedEvidence: [], changedResources: [], checks: freezeChecks(freshChecks()), diagnostics: [], diff: diffString } as unknown as PatchToolDetails };
    } catch (err) {
        return mapApplyPreviewError(toolCallId, err);
    }
}
