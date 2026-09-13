/**
 * Patch refactor preview — rename / organize-imports / formatting /
 * code-action preview planning plus apply-preview with stale-file and
 * prior-authority guards. Pure move: verbatim from src/patch.ts (MS5 of
 * patch.ts split), no logic change. Owns the LSP preview calls plus the
 * local dynamic import("./mutation/edit-transaction.js") inside
 * handleApplyRefactorPreview. handleRefactorRequest returns
 * PatchResult|null (null = not refactor → orchestrator continues).
 * isBlockingPostwriteFailure is also used by the orchestrator postwrite
 * loop and imported back in src/patch.ts — not duplicated there.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import {
    hashSessionFilePath,
    sha256OfString,
} from "@rhinos0608/pi-workspace-protocol";
import { planPositionalEdits } from "../lsp/positional-planner.js";
import { globalRenamePreviewCache } from "../lsp/rename-preview-cache.js";
import { requestRenamePreview, requestOrganizeImports, requestFormatting, requestCodeAction } from "../lsp/lsp-smartread-client.js";
import { checkResourceCoverage } from "../context/patch-authorization.js";
import type {
    PatchToolDeps,
    PatchResult,
    BusPreviewResponse,
    StagedPreviewFile,
    RefactorRequestFields,
    PatchToolDetails,
} from "./types.js";
import type {
    RenamePreviewRefactor,
    ApplyRefactorPreviewRefactor,
    OrganizeImportsPreviewRefactor,
    FormattingPreviewRefactor,
    CodeActionPreviewRefactor,
} from "../edit-contract.js";
import {
    freshChecks,
    freezeChecks,
    failResult,
    makeRejected,
} from "./result-builders.js";

/**
 * Legacy runtime helpers kept for backward-compatible imports. Required
 * fields are enforced at validation time by `validateEditRequest` (kind-
 * discriminated contract in `src/edit-contract.ts`), so handlers below
 * receive narrowed variants and do not re-check required fields.
 */
export function isMissingRenamePreviewFields(path: string | undefined, line: number | undefined, character: number | undefined, newName: string | undefined): boolean {
    return path === undefined || line === undefined || character === undefined || newName === undefined;
}

export function isMissingCodeActionFields(path: string | undefined, line: number | undefined, character: number | undefined): boolean {
    return path === undefined || line === undefined || character === undefined;
}

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
    meta: { filePath: string; line: number; character: number; newName: string; serverDescriptorId: unknown };
}): Promise<PatchResult | null> {
    const { deps, toolCallId, workspaceEdit, planned, meta } = args;
    const sessionFilePath = deps.getSessionFilePath();
    if (!sessionFilePath) {
        return failResult(toolCallId, "failed: refactor preview requires an active session (no session file path available)", "no session file path", ["no session file path"]);
    }
    const root = deps.getCanonicalWorkspaceRoot();
    const sid = hashSessionFilePath(sessionFilePath);
    const previewId = globalRenamePreviewCache.store(workspaceEdit as never, planned as never, { ...meta, serverDescriptorId: meta.serverDescriptorId as never, sessionId: sid, sessionRoot: root });
    return {
        content: [{ type: "text" as const, text: `preview ${previewId}: ${planned.stagedFiles.length} file(s)\n${planned.diffString.slice(0, 4000)}` }],
        details: { tool: "patch", status: { kind: "applied" }, toolCallId, evidenceRef: { inspectionId: "", resourceIds: [] }, usedEvidence: [], changedResources: [], checks: freezeChecks(freshChecks()), diagnostics: [], diff: planned.diffString, diffs: planned.stagedFiles.map((sf) => ({ path: sf.filePath, diff: sf.newContent })), previewId, stagedFiles: planned.stagedFiles.length } as unknown as PatchToolDetails,
    };
}

export async function planAndStorePreview(
    deps: PatchToolDeps,
    toolCallId: string,
    workspaceEdit: unknown,
    meta: { filePath: string; line: number; character: number; newName: string; serverDescriptorId: unknown },
): Promise<PatchResult> {
    const planned = await planPositionalEdits(workspaceEdit as never, async (p) => (await fsReadFile(p)).toString("utf8"));
    const stored = await storeRefactorPreview({ deps, toolCallId, workspaceEdit, planned, meta });
    if (stored) return stored;
    return failResult(toolCallId, "failed: refactor preview requires an active session (no session file path available)", "no session file path", ["no session file path"]);
}

export async function runBusPreview(args: {
    deps: PatchToolDeps;
    toolCallId: string;
    label: string;
    request: (bus: NonNullable<ReturnType<NonNullable<PatchToolDeps["getBus"]>>>) => Promise<BusPreviewResponse>;
    meta: { filePath: string; line: number; character: number; newName: string };
}): Promise<PatchResult> {
    const { deps, toolCallId, label, request, meta } = args;
    const bus = deps.getBus?.() ?? null;
    if (!bus) return failResult(toolCallId, `failed: ${label} requires bus`, "bus unavailable", ["bus unavailable"]);
    try {
        const resp = await request(bus);
        if (!resp.ok || !resp.workspaceEdit) {
            return failResult(toolCallId, `failed: ${label}: ${resp.error ?? "no edit"}`, resp.error ?? "no workspaceEdit", [resp.error ?? "no workspaceEdit"]);
        }
        return await planAndStorePreview(deps, toolCallId, resp.workspaceEdit, { ...meta, serverDescriptorId: resp.serverDescriptorId });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failResult(toolCallId, `failed: ${label} ${msg}`, msg, [msg]);
    }
}

export function selectCodeActionWorkspaceEdit(actions: ReadonlyArray<{ readonly workspaceEdit?: unknown; readonly isPreferred?: boolean }>): { ok: true; workspaceEdit: unknown } | { ok: false; reason: string } {
    if (actions.length === 0) return { ok: false, reason: "no code actions available" };
    const withEdit = actions.filter((a) => !!a.workspaceEdit);
    if (withEdit.length === 0) return { ok: false, reason: "no applicable code action" };
    const selected = withEdit.length === 1 ? withEdit[0] : (withEdit.find((a) => a.isPreferred) ?? withEdit[0]);
    if (!selected?.workspaceEdit) return { ok: false, reason: "no applicable code action" };
    return { ok: true, workspaceEdit: selected.workspaceEdit };
}

export async function handleRenamePreview(deps: PatchToolDeps, toolCallId: string, refactor: RenamePreviewRefactor): Promise<PatchResult> {
    if (!deps.getBus?.()) return failResult(toolCallId, "failed: rename-preview requires bus", "bus unavailable", ["bus unavailable"]);
    const { path, line, character, newName } = refactor;
    return runBusPreview({ deps, toolCallId, label: "rename-preview",
        request: (bus) => requestRenamePreview(bus, { filePath: path, line, character, newName }),
        meta: { filePath: path, line, character, newName } });
}

export async function handleOrganizeImportsPreview(deps: PatchToolDeps, toolCallId: string, refactor: OrganizeImportsPreviewRefactor): Promise<PatchResult> {
    if (!deps.getBus?.()) return failResult(toolCallId, "failed: organize-imports-preview requires bus", "bus unavailable", ["bus unavailable"]);
    const path = refactor.path;
    return runBusPreview({ deps, toolCallId, label: "organize-imports-preview",
        request: (bus) => requestOrganizeImports(bus, { filePath: path }),
        meta: { filePath: path, line: 0, character: 0, newName: "" } });
}

export async function handleFormattingPreview(deps: PatchToolDeps, toolCallId: string, refactor: FormattingPreviewRefactor): Promise<PatchResult> {
    if (!deps.getBus?.()) return failResult(toolCallId, "failed: formatting-preview requires bus", "bus unavailable", ["bus unavailable"]);
    const path = refactor.path;
    const { tabSize, insertSpaces } = refactor;
    return runBusPreview({ deps, toolCallId, label: "formatting-preview",
        request: (bus) => requestFormatting(bus, { filePath: path, tabSize, insertSpaces }),
        meta: { filePath: path, line: 0, character: 0, newName: "" } });
}

export async function handleCodeActionPreview(deps: PatchToolDeps, toolCallId: string, refactor: CodeActionPreviewRefactor): Promise<PatchResult> {
    const bus = deps.getBus?.() ?? null;
    if (!bus) return failResult(toolCallId, "failed: code-action-preview requires bus", "bus unavailable", ["bus unavailable"]);
    try {
        const resp = await requestCodeAction(bus, { filePath: refactor.path, line: refactor.line, character: refactor.character, endLine: refactor.endLine, endCharacter: refactor.endCharacter, diagnostics: refactor.diagnostics as never, only: refactor.only as never });
        if (!resp.ok) {
            return failResult(toolCallId, `failed: code-action-preview: ${resp.error ?? "no actions"}`, resp.error ?? "code action failed", [resp.error ?? "code action failed"]);
        }
        const selected = selectCodeActionWorkspaceEdit(resp.actions ?? []);
        if (!selected.ok) return failResult(toolCallId, `failed: ${selected.reason}`, selected.reason, [selected.reason]);
        return await planAndStorePreview(deps, toolCallId, selected.workspaceEdit, { filePath: refactor.path, line: refactor.line, character: refactor.character, newName: "", serverDescriptorId: resp.serverDescriptorId });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failResult(toolCallId, `failed: code-action-preview ${msg}`, msg, [msg]);
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

export async function handleApplyRefactorPreview(deps: PatchToolDeps, toolCallId: string, refactor: ApplyRefactorPreviewRefactor): Promise<PatchResult> {
    const sessionFilePath = deps.getSessionFilePath();
    if (!sessionFilePath) {
        return failResult(toolCallId, "failed: refactor preview requires an active session (no session file path available)", "no session file path", ["no session file path"]);
    }
    const root = deps.getCanonicalWorkspaceRoot();
    const sid = hashSessionFilePath(sessionFilePath);
    const applyPreviewId = refactor.previewId;
    const cached = globalRenamePreviewCache.get(applyPreviewId, { sessionId: sid, sessionRoot: root });
    if (!cached) {
        return { content: [{ type: "text" as const, text: "rejected: preview not found or expired" }], details: makeRejected(toolCallId, "coverage", ["preview not found or expired"], { inspectionId: "", resourceIds: [] }, freshChecks()) };
    }
    const files = cached.plannedRename.stagedFiles;
    try {
        const { EditTransaction: ET } = await import("../mutation/edit-transaction.js");
        const tx = await ET.begin(files.map((f) => f.filePath));
        try {
            const staleFiles = await findStalePreviewFiles(files);
            if (staleFiles.length > 0) {
                await tx.rollback();
                return { content: [{ type: "text", text: `rejected: files changed since preview: ${staleFiles.join(", ")}` }], details: makeRejected(toolCallId, "stale", [`files changed since preview: ${staleFiles.join(", ")}`], { inspectionId: "", resourceIds: [] }, freshChecks()) };
            }
            const unauthorized = findPreviewUnauthorizedFiles(deps, files);
            if (unauthorized.length > 0) {
                await tx.rollback();
                return { content: [{ type: "text", text: `rejected: missing read authority for: ${unauthorized.join(", ")} — read the file first, then retry` }], details: makeRejected(toolCallId, "coverage", [`missing read authority for: ${unauthorized.join(", ")}`], { inspectionId: "", resourceIds: [] }, freshChecks()) };
            }
            for (const sf of files) await tx.write(sf.filePath, sf.newContent);
            await tx.commit();
        } catch (e) {
            try { await tx.rollback(); } catch {}
            throw e;
        }
        globalRenamePreviewCache.delete(applyPreviewId);
        return { content: [{ type: "text" as const, text: `applied refactor ${applyPreviewId}: ${files.length} file(s)` }], details: { tool: "patch", status: { kind: "applied" }, toolCallId, evidenceRef: { inspectionId: "", resourceIds: [] }, usedEvidence: [], changedResources: [], checks: freezeChecks(freshChecks()), diagnostics: [], diff: cached.plannedRename.diffString } as unknown as PatchToolDetails };
    } catch (err) {
        return mapApplyPreviewError(toolCallId, err);
    }
}

export async function handleRefactorRequest(deps: PatchToolDeps, toolCallId: string, refactor: RefactorRequestFields | undefined): Promise<PatchResult | null> {
    if (!refactor) return null;
    // The orchestrator validates via `validateEditRequest` before dispatch,
    // so each branch narrows the broad wire type to its discriminated
    // variant (defined in `src/edit-contract.ts`). Direct callers bypassing
    // validation get the same narrowing by kind.
    if (refactor.kind === "rename-preview") return handleRenamePreview(deps, toolCallId, refactor as unknown as RenamePreviewRefactor);
    if (refactor.kind === "organize-imports-preview") return handleOrganizeImportsPreview(deps, toolCallId, refactor as unknown as OrganizeImportsPreviewRefactor);
    if (refactor.kind === "formatting-preview") return handleFormattingPreview(deps, toolCallId, refactor as unknown as FormattingPreviewRefactor);
    if (refactor.kind === "code-action-preview") return handleCodeActionPreview(deps, toolCallId, refactor as unknown as CodeActionPreviewRefactor);
    return handleApplyRefactorPreview(deps, toolCallId, refactor as unknown as ApplyRefactorPreviewRefactor);
}
