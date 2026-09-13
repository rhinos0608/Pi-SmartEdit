/**
 * Patch request preparation — grouping, auto-inspect envelope synthesis,
 * preparation, transfer resolution, and envelope acquisition.
 * Pure move: verbatim from src/patch.ts (MS4 of patch.ts split), no logic
 * change. Owns node fs/path reads plus the getRpcClient resolve_evidence
 * call (rpc.dispose() in finally). Must NOT import tx, planner, verifiers.
 * resolvePatchTransfers mutates the groups array in place (reserved
 * transfer groups) — preserved as-is.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { resolve as pathResolve, dirname, basename, join as pathJoin } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    resourceIdFor,
    sha256OfString,
    validateInspectionEnvelope,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
    type EvidenceRef,
    type RpcMethod,
} from "@rhinos0608/pi-workspace-protocol";
import type {
    PatchToolDeps,
    GroupedEdit,
    EditGroup,
    RawTopology,
    MutableChecks,
    PatchResult,
    PreparedPatchRequest,
    ResolvedPatchTransfer,
} from "./types.js";
import {
    freshChecks,
    makeCheck,
    makeRejected,
    makeFailed,
    classifyRpcError,
} from "./result-builders.js";
import { adaptTransferOps } from "../transfer/adapter.js";
import { normalizeRawEdit } from "../formats/edit-intents.js";
import type { EditOperation } from "../edit-contract.js";

export function safeReadUtf8(path: string): Promise<string> {
    return fsReadFile(path).then((b) => b.toString("utf8"));
}

export function groupEditsByPath(
    cwd: string,
    topLevelPath: string,
    edits: ReadonlyArray<GroupedEdit & { path?: string }>,
): { ok: true; groups: EditGroup[] } | { ok: false; error: string } {
    const buckets = new Map<string, EditGroup>();
    for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const rawPath = typeof e.path === "string" && e.path.length > 0 ? e.path : topLevelPath;
        if (typeof rawPath !== "string" || rawPath.length === 0) {
            return { ok: false, error: `edits[${i}]: no path (top-level path missing and per-edit path missing)` };
        }
        const absolutePath = pathResolve(cwd, rawPath);
        const existing = buckets.get(absolutePath);
        const groupEdit: GroupedEdit = {
            oldText: e.oldText,
            newText: e.newText,
            description: e.description,
            replaceAll: e.replaceAll,
            target: e.target,
            lineRange: e.lineRange,
            hashline: e.hashline,
        };
        if (existing) {
            // Replace the entry in the map with an extended group.
            buckets.set(absolutePath, {
                absolutePath: existing.absolutePath,
                rawPath: existing.rawPath,
                edits: [...existing.edits, groupEdit],
            });
        } else {
            buckets.set(absolutePath, { absolutePath, rawPath, edits: [groupEdit] });
        }
    }
    return { ok: true, groups: [...buckets.values()] };
}

export async function buildAutoInspectEnvelope(args: {
    sessionFilePath: string;
    canonicalRoot: string;
    groups: ReadonlyArray<EditGroup>;
    newFileAllowed?: ReadonlySet<string>;
}): Promise<{
    ok: true;
    envelope: WorkspaceEvidenceEnvelope;
    canonicalByGroup: string[];
    newFileCanonicals: ReadonlySet<string>;
} | { ok: false; error: string }> {
    const sessionId = hashSessionFilePath(args.sessionFilePath);
    const resources: InspectedResource[] = [];
    const canonicalByGroup: string[] = [];
    const newFileCanonicals = new Set<string>();
    const resourceKeyItems: Array<{ canonicalPath: string; range?: { startLine: number; endLine: number } }> = [];

    for (const g of args.groups) {
        const fileExists = existsSync(g.absolutePath);
        if (!fileExists) {
            // New-file creation is only valid when every edit has empty oldText,
            // or the group is a transfer-op destination explicitly allowed to
            // create a new file (its synthesized edit uses the EOF append
            // branch, not oldText, so it wouldn't satisfy the .every() below).
            const allEmpty = (args.newFileAllowed?.has(g.absolutePath) ?? false) || g.edits.every(
                (e) => typeof e.oldText === "string" && e.oldText.length === 0,
            );
            if (!allEmpty) {
                return {
                    ok: false,
                    error:
                        `auto-inspect: file not found: ${g.absolutePath}. ` +
                        `Patch can only create new files when every edit has empty oldText ` +
                        `(use oldText: "" with newText containing the new file contents). ` +
                        `For arbitrary new files, use the write tool instead.`,
                };
            }
            // Synthesize an empty-file full-file resource so the rest of the
            // pipeline can run unchanged. Mark this path as a synthesized new
            // file so the per-group executor skips the realpath / SHA / range
            // checks that only make sense for existing content.
            const emptySha = sha256OfString("");
            // The file does not exist yet, so realpathSync on the full path is
            // impossible (ENOENT). Resolve the parent dir (which must exist for
            // a creatable file) and join the basename: symlink-aware and stable,
            // matching the canonical path used once the file exists.
            let newCanonical: string;
            try {
                newCanonical = pathJoin(realpathSync(dirname(g.absolutePath)), basename(g.absolutePath));
            } catch {
                newCanonical = g.absolutePath;
            }
            const resource: InspectedResource = {
                resourceId: resourceIdFor({ canonicalPath: newCanonical, kind: "full" }),
                canonicalPath: newCanonical,
                kind: "full",
                coverage: "full-file",
                allowedRanges: [{ startLine: 1, endLine: 1 }],
                fullFileSha256: emptySha,
                fresh: true,
                byteLength: 0,
                lineCount: 0,
            };
            resources.push(resource);
            resourceKeyItems.push({ canonicalPath: newCanonical });
            canonicalByGroup.push(newCanonical);
            newFileCanonicals.add(newCanonical);
            continue;
        }
        let canonical: string;
        try {
            canonical = realpathSync(g.absolutePath);
        } catch (err) {
            return { ok: false, error: `auto-inspect: file not found: ${g.absolutePath} (${err instanceof Error ? err.message : String(err)})` };
        }
        let content: string;
        try {
            content = await safeReadUtf8(canonical);
        } catch (err) {
            return { ok: false, error: `auto-inspect: read failed for ${canonical} (${err instanceof Error ? err.message : String(err)})` };
        }
        const sha = sha256OfString(content);
        const lineCount = content.split("\n").length;
        const resource: InspectedResource = {
            resourceId: resourceIdFor({ canonicalPath: canonical, kind: "full" }),
            canonicalPath: canonical,
            kind: "full",
            coverage: "full-file",
            allowedRanges: [{ startLine: 1, endLine: lineCount }],
            fullFileSha256: sha,
            fresh: true,
            byteLength: Buffer.byteLength(content, "utf8"),
            lineCount,
        };
        resources.push(resource);
        resourceKeyItems.push({ canonicalPath: canonical });
        canonicalByGroup.push(canonical);
    }

    const inspectionId = inspectionIdFor({
        sessionId,
        workspaceRoot: args.canonicalRoot,
        resources: resourceKeyItems,
    });
    const envelope: WorkspaceEvidenceEnvelope = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: args.canonicalRoot,
        canonicalWorkspaceRoot: args.canonicalRoot,
        createdAt: new Date().toISOString(),
        resources,
        mode: "path",
    };
    return { ok: true, envelope, canonicalByGroup, newFileCanonicals };
}

export function preparePatchRequest(args: {
    validated: { ok: true; value: { evidenceRef?: EvidenceRef; edits?: EditOperation[]; raw?: unknown; path?: string } };
    deps: PatchToolDeps;
    ctx: { cwd: string };
    toolCallId: string;
}): { ok: true; prepared: PreparedPatchRequest } | { ok: false; result: PatchResult } {
    const { validated, deps, ctx, toolCallId } = args;
    const requestEvidenceRef = validated.value.evidenceRef;
    const sessionFilePath = deps.getSessionFilePath();
    if (typeof sessionFilePath !== "string" || sessionFilePath.length === 0) {
        return { ok: false, result: { content: [{ type: "text" as const, text: "rejected: ephemeral session identity" }], details: makeRejected(toolCallId, "session", ["no real session file path"], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, freshChecks()) } };
    }
    const canonicalRoot = deps.getCanonicalWorkspaceRoot();
    if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) {
        return { ok: false, result: { content: [{ type: "text" as const, text: "rejected: missing canonical workspace root" }], details: makeRejected(toolCallId, "session", ["no canonical workspace root"], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, freshChecks()) } };
    }
    let requestEdits: ReadonlyArray<EditOperation> = validated.value.edits ?? [];
    let rawTopology: RawTopology[] = [];
    const rawWarnings: string[] = [];
    if (validated.value.raw !== undefined) {
        const normalized = normalizeRawEdit(validated.value.raw as never, validated.value.path);
        rawWarnings.push(...normalized.warnings);
        if (normalized.diagnostics.length > 0 || normalized.intents.length === 0) {
            const diagnostics = [...rawWarnings, ...normalized.diagnostics, "Raw patch parsed into no executable update operations."];
            return { ok: false, result: { content: [{ type: "text" as const, text: "failed: raw patch parsing" }], details: makeFailed(toolCallId, "stage", "raw patch normalization failed", { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, freshChecks(), diagnostics) } };
        }
        rawTopology = normalized.intents.flatMap((intent): RawTopology[] => {
            if (intent.kind === "text") return [];
            return intent.kind === "rename" ? [{ kind: "rename", oldPath: intent.oldPath, newPath: intent.newPath }] : [intent];
        });
        requestEdits = normalized.intents.flatMap((intent) => intent.kind === "text" ? [intent.operation] : []);
    }
    const transferOps = requestEdits.filter((e) => (e as { op?: unknown }).op !== undefined);
    const textOps = requestEdits.filter((e) => (e as { op?: unknown }).op === undefined);
    const adaptedTransfers = adaptTransferOps(transferOps, validated.value.path);
    if (!adaptedTransfers.ok) {
        return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${adaptedTransfers.error}` }], details: makeRejected(toolCallId, "session", [adaptedTransfers.error], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, freshChecks()) } };
    }
    const grouping = groupEditsByPath(ctx.cwd, validated.value.path ?? "", textOps);
    if (!grouping.ok) {
        return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${grouping.error}` }], details: makeRejected(toolCallId, "session", [grouping.error], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, freshChecks()) } };
    }
    const groups = grouping.groups;
    const topologyConflicts: Array<{ path: string; existingKind: string; newKind: string }> = [];
    for (const op of rawTopology) {
        const entries = op.kind === "rename" ? [[op.oldPath, op], [op.newPath, undefined]] : [[op.path, op]];
        for (const [rawPath, topology] of entries as Array<[string, RawTopology | undefined]>) {
            const absolutePath = pathResolve(ctx.cwd, rawPath);
            const existingIdx = groups.findIndex((g) => g.absolutePath === absolutePath);
            if (existingIdx >= 0) {
                const existingTopology = groups[existingIdx].topology;
                if (topology) {
                    if (existingTopology) topologyConflicts.push({ path: rawPath, existingKind: existingTopology.kind, newKind: topology.kind });
                    else groups[existingIdx] = { ...groups[existingIdx], topology };
                } else if (existingTopology && op.kind === "rename") {
                    topologyConflicts.push({ path: rawPath, existingKind: existingTopology.kind, newKind: op.kind });
                }
            } else groups.push({ absolutePath, rawPath, edits: [], ...(topology ? { topology } : {}) });
        }
    }
    if (topologyConflicts.length > 0) {
        const message = topologyConflicts.map((c) => `conflicting topology operations for path '${c.path}': ${c.existingKind} vs ${c.newKind}`).join("; ");
        return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${message}` }], details: makeRejected(toolCallId, "conflict", [message], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, freshChecks()) } };
    }
    const checks: MutableChecks = freshChecks();
    const diagnostics: string[] = [...rawWarnings];
    return { ok: true, prepared: { requestEvidenceRef, sessionFilePath, canonicalRoot, textOps, adaptedTransfers: adaptedTransfers as PreparedPatchRequest["adaptedTransfers"], groups, checks, diagnostics } };
}

export function resolvePatchTransfers(args: {
    adaptedTransfers: PreparedPatchRequest["adaptedTransfers"];
    groups: EditGroup[];
    ctx: { cwd: string };
    toolCallId: string;
    requestEvidenceRef: EvidenceRef | undefined;
    checks: MutableChecks;
}): { ok: true; resolvedTransfers: ResolvedPatchTransfer[]; transferNewFileCanonicals: Set<string>; copySourceOnlyPaths: Set<string> } | { ok: false; result: PatchResult } {
    const { adaptedTransfers, groups, ctx, toolCallId, requestEvidenceRef, checks } = args;
    const resolvedTransfers: ResolvedPatchTransfer[] = [];
    const transferNewFileCanonicals = new Set<string>();
    const copySourceOnlyPaths = new Set<string>();
    for (const transferReq of adaptedTransfers.value) {
        const op = transferReq.op;
        const rawFrom = transferReq.from;
        const rawTo = transferReq.to;
        const range = transferReq.range;
        const after = transferReq.after;
        let canonicalFrom: string;
        try {
            canonicalFrom = realpathSync(pathResolve(ctx.cwd, rawFrom));
        } catch (err) {
            const message = `transfer source not found: ${rawFrom} (${err instanceof Error ? err.message : String(err)})`;
            return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${message}` }], details: makeRejected(toolCallId, "coverage", [message], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, checks) } };
        }
        let canonicalTo: string;
        let toIsNewFile = false;
        try {
            canonicalTo = realpathSync(pathResolve(ctx.cwd, rawTo));
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                canonicalTo = pathResolve(ctx.cwd, rawTo);
                toIsNewFile = true;
            } else {
                const message = `transfer destination not found: ${rawTo} (${err instanceof Error ? err.message : String(err)})`;
                return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${message}` }], details: makeRejected(toolCallId, "coverage", [message], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, checks) } };
            }
        }
        if (toIsNewFile) transferNewFileCanonicals.add(canonicalTo);
        const description = transferReq.description;
        resolvedTransfers.push({ op, canonicalFrom, canonicalTo, range, after, rawFrom, rawTo, toIsNewFile, description });
        const buckets: Array<[string, string]> = op === "move" ? [[canonicalTo, rawTo], [canonicalFrom, rawFrom]] : [[canonicalTo, rawTo]];
        for (const [absolutePath, rawPath] of buckets) {
            if (!groups.some((g) => g.absolutePath === absolutePath)) groups.push({ absolutePath, rawPath, edits: [] });
        }
        if (op === "copy") copySourceOnlyPaths.add(canonicalFrom);
    }
    return { ok: true, resolvedTransfers, transferNewFileCanonicals, copySourceOnlyPaths };
}

export async function acquirePatchEnvelope(args: {
    deps: PatchToolDeps;
    groups: EditGroup[];
    sessionFilePath: string;
    canonicalRoot: string;
    requestEvidenceRef: EvidenceRef | undefined;
    transferNewFileCanonicals: ReadonlySet<string>;
    toolCallId: string;
    checks: MutableChecks;
    diagnostics: string[];
    usedEvidence: string[];
    signal: AbortSignal | undefined;
}): Promise<{ ok: true; envelope: WorkspaceEvidenceEnvelope | null; autoInspected: boolean; evidenceRefForDetails: EvidenceRef; newFileCanonicals: ReadonlySet<string> } | { ok: false; result: PatchResult }> {
    const { deps, groups, sessionFilePath, canonicalRoot, requestEvidenceRef, transferNewFileCanonicals, toolCallId, checks, diagnostics, usedEvidence, signal } = args;
    const priorStore = deps.getPriorAuthority?.() ?? null;
    const groupsNeedingEnvelope: EditGroup[] = [];
    for (const g of groups) {
        let prior: InspectedResource | null = null;
        if (priorStore) {
            try {
                const canonical = realpathSync(g.absolutePath);
                prior = priorStore.select(canonical);
            } catch {
                // file does not exist — no prior authority possible
            }
        }
        if (!prior) groupsNeedingEnvelope.push(g);
    }
    let envelope: WorkspaceEvidenceEnvelope | null = null;
    let autoInspected = false;
    let evidenceRefForDetails: EvidenceRef;
    let newFileCanonicals: ReadonlySet<string> = new Set();
    if (groupsNeedingEnvelope.length === 0) {
        evidenceRefForDetails = { inspectionId: "", resourceIds: [] };
        return { ok: true, envelope, autoInspected, evidenceRefForDetails, newFileCanonicals };
    }
    if (!requestEvidenceRef) {
        const existingWithoutPrior = groupsNeedingEnvelope.filter((g) => existsSync(g.absolutePath));
        if (existingWithoutPrior.length > 0) {
            const message = `no prior strong read authority for ${existingWithoutPrior.map((g) => g.rawPath).join(", ")}; read the file first (full file or target range), then retry`;
            diagnostics.push(message);
            return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: coverage (${message})` }], details: makeRejected(toolCallId, "coverage", diagnostics, { inspectionId: "", resourceIds: [] }, checks) } };
        }
        const built = await buildAutoInspectEnvelope({ sessionFilePath, canonicalRoot, groups: groupsNeedingEnvelope, newFileAllowed: transferNewFileCanonicals });
        if (!built.ok) {
            diagnostics.push(built.error);
            checks.completed.push(makeCheck("auto-inspect", "fail", built.error));
            return { ok: false, result: { content: [{ type: "text" as const, text: `failed: ${built.error}` }], details: makeFailed(toolCallId, "stage", built.error, { inspectionId: "", resourceIds: [] }, checks, diagnostics) } };
        }
        envelope = built.envelope;
        autoInspected = true;
        newFileCanonicals = built.newFileCanonicals;
        evidenceRefForDetails = { inspectionId: envelope.inspectionId, resourceIds: envelope.resources.map((r) => r.resourceId) };
        checks.completed.push(makeCheck("auto-inspect", "pass", `synthesized envelope for ${envelope.resources.length} file(s)`));
        return { ok: true, envelope, autoInspected, evidenceRefForDetails, newFileCanonicals };
    }
    evidenceRefForDetails = { inspectionId: requestEvidenceRef.inspectionId, resourceIds: [...requestEvidenceRef.resourceIds] };
    const rpc = deps.getRpcClient();
    try {
        const reply = await rpc.request("resolve_evidence" as RpcMethod, { inspectionId: requestEvidenceRef.inspectionId, sessionFilePath, workspaceRoot: canonicalRoot }, { signal });
        if (!reply.ok || !reply.payload) {
            checks.completed.push(makeCheck("evidence-pipeline", "fail", reply.error ?? "rpc returned no payload"));
            return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${reply.error ?? "unknown rpc error"}` }], details: makeRejected(toolCallId, classifyRpcError(reply.error), [reply.error ?? "rpc failure"], evidenceRefForDetails, checks) } };
        }
        if (reply.schemaVersion !== PROTOCOL_SCHEMA_VERSION) {
            const message = `invalid evidence envelope: schemaVersion must be ${PROTOCOL_SCHEMA_VERSION}`;
            diagnostics.push(message);
            checks.completed.push(makeCheck("evidence-pipeline", "fail", message));
            return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${message}` }], details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks) } };
        }
        const validated = validateInspectionEnvelope(reply.payload);
        if (!validated.ok) {
            const message = `invalid evidence envelope: ${validated.error}`;
            diagnostics.push(message);
            checks.completed.push(makeCheck("evidence-pipeline", "fail", message));
            return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${message}` }], details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks) } };
        }
        envelope = validated.value;
        checks.completed.push(makeCheck("evidence-pipeline", "pass", "rpc resolve_evidence succeeded"));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics.push(msg);
        checks.completed.push(makeCheck("evidence-pipeline", "timeout", msg));
        return { ok: false, result: { content: [{ type: "text" as const, text: `failed: ${msg}` }], details: makeFailed(toolCallId, "stage", msg, evidenceRefForDetails, checks, diagnostics) } };
    } finally {
        rpc.dispose();
    }
    if (envelope) {
        const expectedSessionId = hashSessionFilePath(sessionFilePath);
        if (envelope.sessionId !== expectedSessionId) {
            diagnostics.push("envelope session identity mismatch");
            return { ok: false, result: { content: [{ type: "text" as const, text: "rejected: session identity mismatch" }], details: makeRejected(toolCallId, "session", diagnostics, evidenceRefForDetails, checks, usedEvidence) } };
        }
        if (envelope.canonicalWorkspaceRoot !== canonicalRoot) {
            diagnostics.push("envelope workspace root mismatch");
            return { ok: false, result: { content: [{ type: "text" as const, text: "rejected: workspace mismatch" }], details: makeRejected(toolCallId, "session", diagnostics, evidenceRefForDetails, checks, usedEvidence) } };
        }
    }
    return { ok: true, envelope, autoInspected, evidenceRefForDetails, newFileCanonicals };
}
