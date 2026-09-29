/**
 * Workspace-edit preview staging + apply (shared kernel).
 *
 *  Stages raw LspWorkspaceEdit payloads (checkWorkspaceEditEncoding +
 *  planPositionalEdits + the global refactor preview cache) and applies
 *  them through EditTransaction with stale-file and prior-authority
 *  guards, crash-journal protection, and undo capture. The only
 *  stager/applier is the workspace-edit RPC server
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
} from "@rhinos0608/pi-workspace-protocol";
import { planPositionalEdits } from "../lsp/positional-planner.js";
import { globalRefactorPreviewCache, type RefactorPreviewSource } from "../lsp/refactor-preview-cache.js";
import {
    buildJournalRecord,
    deleteJournal,
    markCommitted,
    recoverStaleJournals,
    writePreparedJournal,
} from "../mutation/recovery-journal.js";
import { saveTransactionUndoRecords } from "../undo/edit-history.js";
import { checkResourceCoverage } from "../context/patch-authorization.js";
import type {
    PatchToolDeps,
    PatchResult,
    BusPreviewResponse,
    StagedPreviewFile,
    PatchToolDetails,
} from "./types.js";
/** Stage 4 owns the edit-tool refactor contract; the workspace-edit RPC
 *  server (src/extension/register-workspace-edit-rpc.ts) stages raw
 *  LspWorkspaceEdit payloads directly via checkWorkspaceEditEncoding +
 *  planPositionalEdits + storeRefactorPreview, and applies them via
 *  handleApplyRefactorPreview. */
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

export async function storeRefactorPreview(args: {
    deps: PatchToolDeps;
    toolCallId: string;
    workspaceEdit: unknown;
    planned: { stagedFiles: Array<{ filePath: string; newContent: string }>; diffString: string };
    source: RefactorPreviewSource;
}): Promise<PatchResult | null> {
    const { deps, toolCallId, workspaceEdit, planned, source } = args;
    const sessionFilePath = deps.getSessionFilePath();
    if (!sessionFilePath) {
        return failResult(toolCallId, "failed: refactor preview requires an active session (no session file path available)", "no session file path", ["no session file path"]);
    }
    const root = deps.getCanonicalWorkspaceRoot();
    const sid = hashSessionFilePath(sessionFilePath);
    const previewId = globalRefactorPreviewCache.store(workspaceEdit as never, planned as never, { source, serverDescriptorId: (source as { serverDescriptorId?: unknown }).serverDescriptorId as string | undefined, sessionId: sid, sessionRoot: root });
    return {
        content: [{ type: "text" as const, text: `preview ${previewId}: ${planned.stagedFiles.length} file(s)\n${planned.diffString.slice(0, 4000)}` }],
        details: { tool: "edit", status: { kind: "applied" }, toolCallId, evidenceRef: { inspectionId: "", resourceIds: [] }, usedEvidence: [], changedResources: [], checks: freezeChecks(freshChecks()), diagnostics: [], diff: planned.diffString, diffs: planned.stagedFiles.map((sf) => ({ path: sf.filePath, diff: sf.newContent })), previewId, stagedFiles: planned.stagedFiles.length } as unknown as PatchToolDetails,
    };
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

export async function planAndStorePreview(
    deps: PatchToolDeps,
    toolCallId: string,
    workspaceEdit: unknown,
    source: RefactorPreviewSource & { serverDescriptorId?: unknown },
): Promise<PatchResult> {
    const encErr = checkWorkspaceEditEncoding(workspaceEdit);
    if (encErr) return failResult(toolCallId, `rejected: ${encErr}`, encErr, [encErr]);
    const planned = await planPositionalEdits(workspaceEdit as never, async (p) => (await fsReadFile(p)).toString("utf8"));
    const capsErr = checkPlannedPreviewCaps(planned);
    if (capsErr) return failResult(toolCallId, `rejected: ${capsErr}`, capsErr, [capsErr]);
    const stored = await storeRefactorPreview({ deps, toolCallId, workspaceEdit, planned, source });
    if (stored) return stored;
    return failResult(toolCallId, "failed: refactor preview requires an active session (no session file path available)", "no session file path", ["no session file path"]);
}

export async function runBusPreview(args: {
    deps: PatchToolDeps;
    toolCallId: string;
    label: string;
    request: (bus: NonNullable<ReturnType<NonNullable<PatchToolDeps["getBus"]>>>) => Promise<BusPreviewResponse>;
    source: RefactorPreviewSource;
}): Promise<PatchResult> {
    const { deps, toolCallId, label, request, source } = args;
    const bus = deps.getBus?.() ?? null;
    if (!bus) return failResult(toolCallId, `failed: ${label} requires bus`, "bus unavailable", ["bus unavailable"]);
    try {
        const resp = await request(bus);
        if (!resp.ok || !resp.workspaceEdit) {
            return failResult(toolCallId, `failed: ${label}: ${resp.error ?? "no edit"}`, resp.error ?? "no workspaceEdit", [resp.error ?? "no workspaceEdit"]);
        }
        return await planAndStorePreview(deps, toolCallId, resp.workspaceEdit, { ...source, ...(resp.serverDescriptorId !== undefined ? { serverDescriptorId: resp.serverDescriptorId } : {}) });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failResult(toolCallId, `failed: ${label} ${msg}`, msg, [msg]);
    }
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

export async function handleApplyRefactorPreview(deps: PatchToolDeps, toolCallId: string, refactor: ApplyRefactorPreviewRefactor, cwd?: string): Promise<PatchResult> {
    const sessionFilePath = deps.getSessionFilePath();
    if (!sessionFilePath) {
        return failResult(toolCallId, "failed: refactor preview requires an active session (no session file path available)", "no session file path", ["no session file path"]);
    }
    const root = deps.getCanonicalWorkspaceRoot();
    const sid = hashSessionFilePath(sessionFilePath);
    const applyPreviewId = refactor.previewId;
    const cached = globalRefactorPreviewCache.get(applyPreviewId, { sessionId: sid, sessionRoot: root });
    if (!cached) {
        return { content: [{ type: "text" as const, text: "rejected: preview not found or expired" }], details: makeRejected(toolCallId, "coverage", ["preview not found or expired"], { inspectionId: "", resourceIds: [] }, freshChecks()) };
    }
    const files = cached.planned.stagedFiles;
    const undoCwd = cwd ?? deps.getCanonicalWorkspaceRoot();
    try {
        const { EditTransaction: ET } = await import("../mutation/edit-transaction.js");
        // Best-effort crash recovery first, mirroring the mutation kernel:
        // roll back partial writes from dead-PID journals before mutating.
        try { await recoverStaleJournals(); } catch { /* advisory; never block apply */ }
        const tx = await ET.begin(files.map((f) => f.filePath));
        try {
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
            for (const sf of files) await tx.write(sf.filePath, sf.newContent);
            // Capture undo records (post-write disk content) BEFORE commit
            // releases the lock; persist AFTER commit, best-effort.
            const undoRecords = await tx.getUndoRecords().catch(() => []);
            await markCommitted(tx.transactionId);
            await tx.commit();
            await deleteJournal(tx.transactionId).catch(() => {});
            try { await saveTransactionUndoRecords(undoCwd, undoRecords); } catch { /* undo persistence is advisory */ }
        } catch (e) {
            try { await tx.rollback(); } catch {}
            throw e;
        }
        globalRefactorPreviewCache.delete(applyPreviewId);
        return { content: [{ type: "text" as const, text: `applied refactor ${applyPreviewId}: ${files.length} file(s)` }], details: { tool: "edit", status: { kind: "applied" }, toolCallId, evidenceRef: { inspectionId: "", resourceIds: [] }, usedEvidence: [], changedResources: [], checks: freezeChecks(freshChecks()), diagnostics: [], diff: cached.planned.diffString } as unknown as PatchToolDetails };
    } catch (err) {
        return mapApplyPreviewError(toolCallId, err);
    }
}
