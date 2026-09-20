/**
 * Patch request preparation — grouping, auto-inspect envelope synthesis,
 * preparation, and envelope acquisition. Transfer batch resolution lives in
 * the transfer domain (`src/transfer/resolve-batch.ts`).
 * Pure move: verbatim from src/patch.ts (MS4 of patch.ts split), no logic
 * change. Owns node fs/path reads plus the getRpcClient resolve_evidence
 * call (rpc.dispose() in finally). Must NOT import tx, planner, verifiers.
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
import type { MutationResourceIntent } from "../mutation/resource-intent.js";
import type { MutationToolIdentity } from "../mutation/types.js";
import type {
    PatchToolDeps,
    GroupedEdit,
    EditGroup,
    RawTopology,
    MutableChecks,
    PatchResult,
    PreparedPatchRequest,
} from "./types.js";
import {
    freshChecks,
    makeCheck,
    makeRejected,
    makeFailed,
    classifyRpcError,
} from "./result-builders.js";
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
            // New-file creation is only valid when every edit has empty
            // oldText. A transfer destination group carries no text edits at
            // all, so `[].every()` is trivially true and it is allowed here;
            // the kernel's `create-new` intent (plus the create-new race
            // guard in the transaction runner) owns the rest.
            const allEmpty = g.edits.every(
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
    tool: MutationToolIdentity;
}): { ok: true; prepared: PreparedPatchRequest } | { ok: false; result: PatchResult } {
    const { validated, deps, ctx, toolCallId, tool } = args;
    const requestEvidenceRef = validated.value.evidenceRef;
    const sessionFilePath = deps.getSessionFilePath();
    if (typeof sessionFilePath !== "string" || sessionFilePath.length === 0) {
        return { ok: false, result: { content: [{ type: "text" as const, text: "rejected: ephemeral session identity" }], details: makeRejected(toolCallId, "session", ["no real session file path"], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, freshChecks(), [], [], tool) } };
    }
    const canonicalRoot = deps.getCanonicalWorkspaceRoot();
    if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) {
        return { ok: false, result: { content: [{ type: "text" as const, text: "rejected: missing canonical workspace root" }], details: makeRejected(toolCallId, "session", ["no canonical workspace root"], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, freshChecks(), [], [], tool) } };
    }
    let requestEdits: ReadonlyArray<EditOperation> = validated.value.edits ?? [];
    let rawTopology: RawTopology[] = [];
    const rawWarnings: string[] = [];
    if (validated.value.raw !== undefined) {
        const normalized = normalizeRawEdit(validated.value.raw as never, validated.value.path);
        rawWarnings.push(...normalized.warnings);
        if (normalized.diagnostics.length > 0 || normalized.intents.length === 0) {
            const diagnostics = [...rawWarnings, ...normalized.diagnostics, "Raw patch parsed into no executable update operations."];
            return { ok: false, result: { content: [{ type: "text" as const, text: "failed: raw patch parsing" }], details: makeFailed(toolCallId, "stage", "raw patch normalization failed", { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, freshChecks(), diagnostics, [], [], undefined, tool) } };
        }
        rawTopology = normalized.intents.flatMap((intent): RawTopology[] => {
            if (intent.kind === "text") return [];
            return intent.kind === "rename" ? [{ kind: "rename", oldPath: intent.oldPath, newPath: intent.newPath }] : [intent];
        });
        requestEdits = normalized.intents.flatMap((intent) => intent.kind === "text" ? [intent.operation] : []);
    }
    const grouping = groupEditsByPath(ctx.cwd, validated.value.path ?? "", requestEdits);
    if (!grouping.ok) {
        return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${grouping.error}` }], details: makeRejected(toolCallId, "session", [grouping.error], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, freshChecks(), [], [], tool) } };
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
        return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${message}` }], details: makeRejected(toolCallId, "conflict", [message], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, freshChecks(), [], [], tool) } };
    }
    const checks: MutableChecks = freshChecks();
    const diagnostics: string[] = [...rawWarnings];
    return { ok: true, prepared: { requestEvidenceRef, sessionFilePath, canonicalRoot, textOps: [...requestEdits], groups, checks, diagnostics } };
}

export async function acquirePatchEnvelope(args: {
    deps: PatchToolDeps;
    groups: EditGroup[];
    resourceIntents?: ReadonlyArray<MutationResourceIntent>;
    sessionFilePath: string;
    canonicalRoot: string;
    requestEvidenceRef: EvidenceRef | undefined;
    toolCallId: string;
    tool: MutationToolIdentity;
    checks: MutableChecks;
    diagnostics: string[];
    usedEvidence: string[];
    signal: AbortSignal | undefined;
}): Promise<{ ok: true; envelope: WorkspaceEvidenceEnvelope | null; autoInspected: boolean; evidenceRefForDetails: EvidenceRef; newFileCanonicals: ReadonlySet<string> } | { ok: false; result: PatchResult }> {
    const { deps, groups, resourceIntents = [], sessionFilePath, canonicalRoot, requestEvidenceRef, toolCallId, tool, checks, diagnostics, usedEvidence, signal } = args;
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
    // Create-new destinations need no prior authority: the kernel synthesizes
    // an empty preimage for them (owned by the `create-new` resource intents).
    // Observation-only transfer sources are evidence resources even when they
    // are not mutation groups. Copy requires full-file authority and freshness.
    for (const intent of resourceIntents) {
        if (intent.kind !== "observe-source") continue;
        const prior = priorStore?.select(intent.canonicalPath) ?? null;
        if (prior?.coverage === "full-file") continue;
        // Existing partial authority is intentionally left for transfer staging
        // to reject when its required full-file SHA is absent.
        if (prior && !requestEvidenceRef) continue;
        if (!groupsNeedingEnvelope.some((g) => g.absolutePath === intent.canonicalPath)) {
            groupsNeedingEnvelope.push({ absolutePath: intent.canonicalPath, rawPath: intent.canonicalPath, edits: [] });
        }
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
            return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: coverage (${message})` }], details: makeRejected(toolCallId, "coverage", diagnostics, { inspectionId: "", resourceIds: [] }, checks, [], [], tool) } };
        }
        const built = await buildAutoInspectEnvelope({ sessionFilePath, canonicalRoot, groups: groupsNeedingEnvelope });
        if (!built.ok) {
            diagnostics.push(built.error);
            checks.completed.push(makeCheck("auto-inspect", "fail", built.error));
            return { ok: false, result: { content: [{ type: "text" as const, text: `failed: ${built.error}` }], details: makeFailed(toolCallId, "stage", built.error, { inspectionId: "", resourceIds: [] }, checks, diagnostics, [], [], undefined, tool) } };
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
            return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${reply.error ?? "unknown rpc error"}` }], details: makeRejected(toolCallId, classifyRpcError(reply.error), [reply.error ?? "rpc failure"], evidenceRefForDetails, checks, [], [], tool) } };
        }
        if (reply.schemaVersion !== PROTOCOL_SCHEMA_VERSION) {
            const message = `invalid evidence envelope: schemaVersion must be ${PROTOCOL_SCHEMA_VERSION}`;
            diagnostics.push(message);
            checks.completed.push(makeCheck("evidence-pipeline", "fail", message));
            return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${message}` }], details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, [], [], tool) } };
        }
        const validated = validateInspectionEnvelope(reply.payload);
        if (!validated.ok) {
            const message = `invalid evidence envelope: ${validated.error}`;
            diagnostics.push(message);
            checks.completed.push(makeCheck("evidence-pipeline", "fail", message));
            return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${message}` }], details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, [], [], tool) } };
        }
        envelope = validated.value;
        if (requestEvidenceRef && envelope.inspectionId !== requestEvidenceRef.inspectionId) {
            const message = "envelope inspectionId mismatch (possible resolver spoof)";
            diagnostics.push(message);
            checks.completed.push(makeCheck("evidence-pipeline", "fail", message));
            return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${message}` }], details: makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, [], [], tool) } };
        }
        checks.completed.push(makeCheck("evidence-pipeline", "pass", "rpc resolve_evidence succeeded"));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics.push(msg);
        checks.completed.push(makeCheck("evidence-pipeline", "timeout", msg));
        return { ok: false, result: { content: [{ type: "text" as const, text: `failed: ${msg}` }], details: makeFailed(toolCallId, "stage", msg, evidenceRefForDetails, checks, diagnostics, [], [], undefined, tool) } };
    } finally {
        rpc.dispose();
    }
    if (envelope) {
        const expectedSessionId = hashSessionFilePath(sessionFilePath);
        if (envelope.sessionId !== expectedSessionId) {
            diagnostics.push("envelope session identity mismatch");
            return { ok: false, result: { content: [{ type: "text" as const, text: "rejected: session identity mismatch" }], details: makeRejected(toolCallId, "session", diagnostics, evidenceRefForDetails, checks, usedEvidence, [], tool) } };
        }
        if (envelope.canonicalWorkspaceRoot !== canonicalRoot) {
            diagnostics.push("envelope workspace root mismatch");
            return { ok: false, result: { content: [{ type: "text" as const, text: "rejected: workspace mismatch" }], details: makeRejected(toolCallId, "session", diagnostics, evidenceRefForDetails, checks, usedEvidence, [], tool) } };
        }
    }
    return { ok: true, envelope, autoInspected, evidenceRefForDetails, newFileCanonicals };
}
