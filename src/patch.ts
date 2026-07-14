/**
 * Patch tool — v3 multi-file patch with workspace-evidence authorization.
 *
 * v1 was single-file, evidence-bound, with a hard multi-file prohibition.
 * v3 adds:
 *   - Multi-file support: each edit may carry its own `path` (PatchEditItemV3)
 *     which overrides the top-level `path` default.
 *   - Validated batch mutation (NOT atomic across files): edits are grouped
 *     by file path and applied in order, one file at a time. Each single
 *     file's write is atomic (tmp + rename). If a later file in the batch
 *     fails, files already written earlier in the batch remain on disk as
 *     written — the caller must inspect `changedResources` in the failure
 *     result to see exactly which files were mutated before the failure.
 *   - Per-file evidence coverage: every file targeted by an edit must have a
 *     strong-coverage resource (full-file or line-range) in the envelope
 *     covering it. Weak-coverage resources (search-match, metadata-only —
 *     produced by inspect's query/symbol modes) are explicitly rejected;
 *     the model must path-mode inspect a file before patching it.
 *   - Auto-inspect fallback: if no `evidenceRef` is provided, the patch tool
 *     reads each target file, computes SHA-256, and constructs a synthetic
 *     full-file evidence envelope so the patch is self-contained for simple
 *     cases. SHA-256 freshness is computed against the on-disk content.
 *
 * - Accepts a single EvidenceRef (`{inspectionId, resourceIds}`) or no
 *   evidenceRef at all (auto-inspect).
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
import { createHash, randomUUID } from "node:crypto";
import { readFile as fsReadFile, writeFile as fsWriteFile, stat as fsStat, rename as fsRename, mkdir as fsMkdir } from "node:fs/promises";
import { resolve as pathResolve, dirname as pathDirname } from "node:path";
import { realpathSync, existsSync } from "node:fs";

import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    resourceIdFor,
    sha256OfString,
    validatePatchRequest as validatePatchRequestProto,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
    type LineRange,
    type PatchDetails,
    type EvidenceRef,
    type CheckRecord,
    type ResourceInvalidation,
    type PostEditEvidence,
    type RpcMethod,
} from "@rhinos0608/pi-workspace-protocol";
import { generateDiffString } from "./core/edit-diff.js";

// ── Public surface ──────────────────────────────────────────────────

export interface RpcClientLike {
    request(rpc: RpcMethod, payload: unknown, options?: { signal?: AbortSignal }): Promise<{
        kind: "reply";
        schemaVersion: number;
        requestId: string;
        ok: boolean;
        payload?: unknown;
        error?: string;
    }>;
    dispose(): void;
}

export interface PatchToolDeps {
    readonly getRpcClient: () => RpcClientLike;
    readonly getSessionFilePath: () => string | null;
    readonly getCanonicalWorkspaceRoot: () => string;
    readonly getVerificationChecks?: () => ReadonlyArray<VerificationCheck>;
}

export interface VerificationCheck {
    readonly id: string;
    readonly kind: "blocking" | "advisory";
    readonly run: (ctx: { path: string; content: string; toolCallId: string }) => Promise<CheckOutcome>;
}

export interface CheckOutcome {
    readonly outcome: "pass" | "fail" | "skipped" | "timeout";
    readonly detail?: string;
}

interface MutableChecks {
    blocking: CheckRecord[];
    completed: CheckRecord[];
    advisory: CheckRecord[];
    skipped: CheckRecord[];
    timedOut: CheckRecord[];
}

function freshChecks(): MutableChecks {
    return { blocking: [], completed: [], advisory: [], skipped: [], timedOut: [] };
}

function makeCheck(id: string, outcome: "pass" | "fail" | "skipped" | "timeout", detail?: string): CheckRecord {
    return detail === undefined ? { id, outcome } : { id, outcome, detail };
}

function freezeChecks(c: MutableChecks): PatchDetails["checks"] {
    return {
        blocking: c.blocking.slice(),
        completed: c.completed.slice(),
        advisory: c.advisory.slice(),
        skipped: c.skipped.slice(),
        timedOut: c.timedOut.slice(),
    };
}

// ── Authorization ───────────────────────────────────────────────────

export type AuthorizationResult =
    | { ok: true; resource: InspectedResource }
    | { ok: false; reason: string };

/**
 * NOTE: not on execute()'s runtime hot path.
 *
 * `execute()` below does its own per-group authorization inline, using
 * `findResourceForCanonicalPath` plus per-group weak-coverage/line-range
 * checks — it does not call this function. That inline path is
 * canonical-path-aware (required for v3 multi-file batches, where each
 * edit group targets a different file), whereas this function checks a
 * single `targetLineRange` against all `requestedResourceIds` without any
 * path matching. The two are semantically equivalent today, but that is
 * not structurally enforced.
 *
 * This function is retained because its behavior is directly unit-tested
 * (see test/patch.test.ts) and expresses the authorization policy (reject
 * missing resources, reject weak coverage, require line-range coverage) in
 * one place for that purpose. Until the two are unified, any change to
 * authorization policy here MUST be mirrored in `execute()`'s inline
 * checks, and vice versa.
 */
export function resolvePatchAuthorization(args: {
    envelope: WorkspaceEvidenceEnvelope;
    sessionFilePath: string;
    canonicalWorkspaceRoot: string;
    requestedResourceIds: ReadonlyArray<string>;
    targetLineRange?: LineRange;
}): AuthorizationResult {
    if (!args.envelope) return { ok: false, reason: "missing envelope" };
    const expectedSessionId = hashSessionFilePath(args.sessionFilePath);
    if (args.envelope.sessionId !== expectedSessionId) {
        return { ok: false, reason: "session identity mismatch" };
    }
    if (args.envelope.canonicalWorkspaceRoot !== args.canonicalWorkspaceRoot) {
        return { ok: false, reason: "workspace mismatch" };
    }
    if (args.requestedResourceIds.length === 0) return { ok: false, reason: "missing resourceIds" };

    const resources: InspectedResource[] = [];
    for (const rid of args.requestedResourceIds) {
        const r = args.envelope.resources.find((x) => x.resourceId === rid);
        if (!r) return { ok: false, reason: `missing resource: ${rid}` };
        if (r.coverage === "search-match" || r.coverage === "metadata-only") {
            return { ok: false, reason: `coverage: ${r.coverage} is weak evidence and cannot authorize a patch (path-mode inspect this file first)` };
        }
        resources.push(r);
    }

    for (const r of resources) {
        if (r.coverage === "line-range") {
            const tr = args.targetLineRange;
            if (!tr) continue;
            const covered = r.allowedRanges.some(
                (a) => tr.startLine >= a.startLine && tr.endLine <= a.endLine,
            );
            if (!covered) continue;
        }
        return { ok: true, resource: r };
    }
    return { ok: false, reason: "coverage: no requested resource covers the target line range" };
}

// ── Helpers ─────────────────────────────────────────────────────────

function safeReadUtf8(path: string): Promise<string> {
    return fsReadFile(path).then((b) => b.toString("utf8"));
}

function withinRange(target: LineRange, range: LineRange): boolean {
    return target.startLine >= range.startLine && target.endLine <= range.endLine;
}

function findTargetLineRangeForEdits(
    content: string,
    edits: ReadonlyArray<{ oldText?: string; replaceAll?: boolean }>,
): { minMax: LineRange | null; occurrences: ReadonlyArray<LineRange> } {
    const occurrences: LineRange[] = [];
    let min = Infinity;
    let max = -Infinity;
    for (const e of edits) {
        if (typeof e.oldText !== "string" || e.oldText.length === 0) continue;
        const matchedLines = e.oldText.split("\n").length;
        if (e.replaceAll) {
            let searchFrom = 0;
            let anyFound = false;
            while (true) {
                const idx = content.indexOf(e.oldText, searchFrom);
                if (idx < 0) break;
                anyFound = true;
                const startLine = content.slice(0, idx).split("\n").length;
                const endLine = startLine + matchedLines - 1;
                occurrences.push({ startLine, endLine });
                if (startLine < min) min = startLine;
                if (endLine > max) max = endLine;
                searchFrom = idx + e.oldText.length;
            }
            if (!anyFound) return { minMax: null, occurrences: [] };
        } else {
            const idx = content.indexOf(e.oldText);
            if (idx < 0) return { minMax: null, occurrences: [] };
            const startLine = content.slice(0, idx).split("\n").length;
            const endLine = startLine + matchedLines - 1;
            occurrences.push({ startLine, endLine });
            if (startLine < min) min = startLine;
            if (endLine > max) max = endLine;
        }
    }
    if (occurrences.length === 0) return { minMax: null, occurrences: [] };
    return { minMax: { startLine: min, endLine: max }, occurrences };
}

function findResourceForCanonicalPath(
    envelope: WorkspaceEvidenceEnvelope,
    canonicalPath: string,
    requestedIds: ReadonlyArray<string>,
): InspectedResource | null {
    // Restrict strictly to requested resources — evidenceRef.resourceIds is
    // the explicit authorization list. A resource not listed there must
    // never authorize a patch, even if it happens to share a canonical path
    // with a listed resource.
    for (const rid of requestedIds) {
        const r = envelope.resources.find((x) => x.resourceId === rid);
        if (!r) continue;
        if (r.canonicalPath === canonicalPath) return r;
    }
    return null;
}

async function atomicWrite(path: string, content: string): Promise<void> {
    const parent = pathDirname(path);
    await fsMkdir(parent, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await fsWriteFile(tmp, content, "utf8");
    await fsRename(tmp, path);
}

// ── Per-edit grouping ───────────────────────────────────────────────

interface GroupedEdit {
    readonly oldText?: string;
    readonly newText?: string;
    readonly description?: string;
    readonly replaceAll?: boolean;
}

interface EditGroup {
    /** Resolved absolute path (cwd-relative input has been resolved). */
    readonly absolutePath: string;
    /** Original input path string (used for diagnostics). */
    readonly rawPath: string;
    readonly edits: ReadonlyArray<GroupedEdit>;
}

function groupEditsByPath(
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

// ── Auto-inspect envelope construction ──────────────────────────────

async function buildAutoInspectEnvelope(args: {
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
            // New-file creation is only valid when every edit has empty oldText.
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
            const resource: InspectedResource = {
                resourceId: resourceIdFor({ canonicalPath: g.absolutePath, kind: "full" }),
                canonicalPath: g.absolutePath,
                kind: "full",
                coverage: "full-file",
                allowedRanges: [{ startLine: 1, endLine: 1 }],
                fullFileSha256: emptySha,
                fresh: true,
                byteLength: 0,
                lineCount: 0,
            };
            resources.push(resource);
            resourceKeyItems.push({ canonicalPath: g.absolutePath });
            canonicalByGroup.push(g.absolutePath);
            newFileCanonicals.add(g.absolutePath);
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

// ── Patch tool factory ──────────────────────────────────────────────

const PATCH_PARAMS_DOC = {
    description:
        "Apply edits gated by a workspace-evidence inspection. Provide a `path`, a list of `edits`, and (optionally) an `evidenceRef` from a prior `inspect` or `read` call. If `evidenceRef` is omitted, patch auto-inspects each target file (full-file). v3 supports multi-file: each edit may carry its own `path` to override the top-level default.",
    type: "object",
    properties: {
        path: { type: "string", description: "Default target file path. May be omitted when every edit provides its own path." },
        edits: {
            type: "array",
            description: "One or more targeted edits.",
            items: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Per-edit target file path. Overrides the top-level path." },
                    oldText: { type: "string" },
                    newText: { type: "string" },
                    description: { type: "string" },
                    replaceAll: { type: "boolean" },
                },
            },
        },
        evidenceRef: {
            type: "object",
            description: "Optional reference to a prior `inspect` or `read` tool result. If omitted, patch auto-inspects each target file.",
            properties: {
                inspectionId: { type: "string" },
                resourceIds: { type: "array", items: { type: "string" } },
            },
            required: ["inspectionId", "resourceIds"],
        },
    },
} as const;

export interface PatchDisplayDiff {
    readonly path: string;
    readonly diff: string;
}

export type PatchToolDetails = PatchDetails & {
    readonly diff?: string;
    readonly diffs?: ReadonlyArray<PatchDisplayDiff>;
};

export interface PatchTool {
    readonly name: "patch";
    readonly label: "patch";
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: ((u: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
        ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown },
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: PatchToolDetails }>;
}

export function createPatchTool(deps: PatchToolDeps): PatchTool {
    return {
        name: "patch",
        label: "patch",
        description:
            "Apply edits gated by a workspace-evidence inspection. v3 supports multi-file: each edit may carry its own `path`. If no `evidenceRef` is provided, patch auto-inspects each target file (full-file, SHA-256 freshness). Returns a discriminated lifecycle result (applied | rejected | failed).",
        parameters: PATCH_PARAMS_DOC as unknown as Record<string, unknown>,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const stream = (text: string) => { onUpdate?.({ content: [{ type: "text", text }] }); };

            // The wire payload from the model never includes toolCallId (Pi
            // supplies it out-of-band as this function's first argument).
            // Inject it before validating so the schema-conforming request
            // the model actually sends can pass validation.
            const v = validatePatchRequestProto({ ...params, toolCallId });
            if (!v.ok) {
                return {
                    content: [{ type: "text" as const, text: `invalid patch request: ${v.error}` }],
                    details: makeRejected(toolCallId, "session", ["invalid patch request shape"], { inspectionId: "", resourceIds: [] }, freshChecks()),
                };
            }
            const requestEvidenceRef = v.value.evidenceRef;

            const sessionFilePath = deps.getSessionFilePath();
            if (typeof sessionFilePath !== "string" || sessionFilePath.length === 0) {
                return {
                    content: [{ type: "text" as const, text: "rejected: ephemeral session identity" }],
                    details: makeRejected(toolCallId, "session", ["no real session file path"], {
                        inspectionId: requestEvidenceRef?.inspectionId ?? "",
                        resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [],
                    }, freshChecks()),
                };
            }

            const canonicalRoot = deps.getCanonicalWorkspaceRoot();
            if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) {
                return {
                    content: [{ type: "text" as const, text: "rejected: missing canonical workspace root" }],
                    details: makeRejected(toolCallId, "session", ["no canonical workspace root"], {
                        inspectionId: requestEvidenceRef?.inspectionId ?? "",
                        resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [],
                    }, freshChecks()),
                };
            }

            // Group edits by file path (per-edit path overrides top-level).
            // v.value.path may be undefined when every edit supplies its own
            // path (validator enforces this invariant).
            const grouping = groupEditsByPath(ctx.cwd, v.value.path ?? "", v.value.edits);
            if (!grouping.ok) {
                return {
                    content: [{ type: "text" as const, text: `rejected: ${grouping.error}` }],
                    details: makeRejected(toolCallId, "session", [grouping.error], {
                        inspectionId: requestEvidenceRef?.inspectionId ?? "",
                        resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [],
                    }, freshChecks()),
                };
            }
            const groups = grouping.groups;
            const checks: MutableChecks = freshChecks();
            const diagnostics: string[] = [];
            const usedEvidence: string[] = [];

            const totalEdits = groups.reduce((sum, g) => sum + g.edits.length, 0);
            const fileWord = groups.length === 1 ? "file" : "files";
            const editWord = totalEdits === 1 ? "edit" : "edits";
            stream(`patch — ${totalEdits} ${editWord} across ${groups.length} ${fileWord}`);

            // ── Acquire envelope ──────────────────────────────────────
            // v3: if no evidenceRef is provided, auto-inspect each target file
            // (read content, compute SHA-256, build synthetic full-file
            // envelope). Otherwise resolve via RPC.

            let envelope: WorkspaceEvidenceEnvelope;
            let autoInspected = false;
            let evidenceRefForDetails: EvidenceRef;
            let newFileCanonicals: ReadonlySet<string> = new Set();

            if (!requestEvidenceRef) {
                // No evidenceRef — auto-inspect.
                const built = await buildAutoInspectEnvelope({
                    sessionFilePath,
                    canonicalRoot,
                    groups,
                });
                if (!built.ok) {
                    diagnostics.push(built.error);
                    checks.completed.push(makeCheck("auto-inspect", "fail", built.error));
                    return {
                        content: [{ type: "text" as const, text: `failed: ${built.error}` }],
                        details: makeFailed(toolCallId, "stage", built.error, {
                            inspectionId: "",
                            resourceIds: [],
                        }, checks, diagnostics),
                    };
                }
                envelope = built.envelope;
                autoInspected = true;
                newFileCanonicals = built.newFileCanonicals;
                evidenceRefForDetails = {
                    inspectionId: envelope.inspectionId,
                    resourceIds: envelope.resources.map((r) => r.resourceId),
                };
                checks.completed.push(makeCheck("auto-inspect", "pass", `synthesized envelope for ${envelope.resources.length} file(s)`));
            } else {
                evidenceRefForDetails = {
                    inspectionId: requestEvidenceRef.inspectionId,
                    resourceIds: [...requestEvidenceRef.resourceIds],
                };
                const rpc = deps.getRpcClient();
                try {
                    const reply = await rpc.request(
                        "resolve_evidence" as RpcMethod,
                        {
                            inspectionId: requestEvidenceRef.inspectionId,
                            sessionFilePath,
                            workspaceRoot: canonicalRoot,
                        },
                        { signal },
                    );
                    if (!reply.ok || !reply.payload) {
                        checks.completed.push(makeCheck("evidence-pipeline", "fail", reply.error ?? "rpc returned no payload"));
                        return {
                            content: [{ type: "text" as const, text: `rejected: ${reply.error ?? "unknown rpc error"}` }],
                            details: makeRejected(toolCallId, classifyRpcError(reply.error), [reply.error ?? "rpc failure"], evidenceRefForDetails, checks),
                        };
                    }
                    envelope = reply.payload as WorkspaceEvidenceEnvelope;
                    checks.completed.push(makeCheck("evidence-pipeline", "pass", "rpc resolve_evidence succeeded"));
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    diagnostics.push(msg);
                    checks.completed.push(makeCheck("evidence-pipeline", "timeout", msg));
                    return {
                        content: [{ type: "text" as const, text: `failed: ${msg}` }],
                        details: makeFailed(toolCallId, "stage", msg, evidenceRefForDetails, checks, diagnostics),
                    };
                } finally {
                    rpc.dispose();
                }
            }

            // Verify session/workspace binding on the envelope.
            const expectedSessionId = hashSessionFilePath(sessionFilePath);
            if (envelope.sessionId !== expectedSessionId) {
                diagnostics.push("envelope session identity mismatch");
                return {
                    content: [{ type: "text" as const, text: "rejected: session identity mismatch" }],
                    details: finalize(makeRejected(toolCallId, "session", diagnostics, evidenceRefForDetails, checks, usedEvidence)),
                };
            }
            if (envelope.canonicalWorkspaceRoot !== canonicalRoot) {
                diagnostics.push("envelope workspace root mismatch");
                return {
                    content: [{ type: "text" as const, text: "rejected: workspace mismatch" }],
                    details: finalize(makeRejected(toolCallId, "session", diagnostics, evidenceRefForDetails, checks, usedEvidence)),
                };
            }

            // ── Per-group application ────────────────────────────────
            // We validate and apply each file's edits in order. On the
            // first failure, abort the whole batch and report.

            const invalidations: ResourceInvalidation[] = [];
            const postEditEvidenceByPath = new Map<string, PostEditEvidence>();
            const appliedFiles: string[] = [];
            const displayDiffs: PatchDisplayDiff[] = [];

            for (const group of groups) {
                stream(`  ${group.rawPath} — ${group.edits.length} edit(s)`);

                // Resolve canonical path for this group.
                let canonicalTarget: string;
                let isNewFileGroup = false;
                if (newFileCanonicals.has(group.absolutePath)) {
                    // Synthesized new-file: there's no on-disk file to resolve, so
                    // skip realpath and remember this fact for the rest of the loop.
                    canonicalTarget = group.absolutePath;
                    isNewFileGroup = true;
                } else {
                    try {
                        canonicalTarget = realpathSync(group.absolutePath);
                    } catch (err) {
                        diagnostics.push(`file not found: ${group.absolutePath}`);
                        return {
                            content: [{ type: "text" as const, text: `failed: file not found: ${group.rawPath}` }],
                            details: finalize(makeFailed(toolCallId, "stage", `file not found: ${group.rawPath}`, {
                                ...evidenceRefForDetails,
                                resourceIds: [""],
                            }, checks, diagnostics, usedEvidence, invalidations)),
                        };
                    }
                }

                // Find a resource that authorizes this path.
                const resource = findResourceForCanonicalPath(
                    envelope,
                    canonicalTarget,
                    evidenceRefForDetails.resourceIds,
                );
                if (!resource) {
                    diagnostics.push(`coverage: no resource in envelope for ${canonicalTarget}`);
                    return {
                        content: [{ type: "text" as const, text: `rejected: coverage (no resource for ${group.rawPath})` }],
                        details: finalize(makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations)),
                    };
                }
                if (resource.coverage === "search-match" || resource.coverage === "metadata-only") {
                    diagnostics.push(`coverage: ${resource.coverage} is weak evidence and cannot authorize a patch for ${canonicalTarget} (path-mode inspect this file first)`);
                    return {
                        content: [{ type: "text" as const, text: `rejected: coverage (weak evidence for ${group.rawPath})` }],
                        details: finalize(makeRejected(toolCallId, "coverage", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations)),
                    };
                }
                usedEvidence.push(resource.resourceId);

                // Read current content + compute sha.
                let currentContent: string;
                let currentSha: string;
                if (isNewFileGroup) {
                    // Synthesized new-file: the file does not exist on disk yet.
                    // We treat current content as empty so the rest of the pipeline
                    // (in-memory apply + verifiers + atomicWrite) operates as if the
                    // file currently contains the empty string. Empty oldText is
                    // expected to find its match at the start of the empty content.
                    currentContent = "";
                    currentSha = sha256OfString("");
                } else {
                    try {
                        currentContent = await safeReadUtf8(canonicalTarget);
                        currentSha = sha256OfString(currentContent);
                    } catch (err) {
                        diagnostics.push(`read failed: ${err instanceof Error ? err.message : String(err)}`);
                        return {
                            content: [{ type: "text" as const, text: `failed: read ${group.rawPath}` }],
                            details: finalize(makeFailed(toolCallId, "stage", `read failed: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations)),
                        };
                    }
                }

                // Freshness check.
                if (typeof resource.fullFileSha256 === "string" && resource.fullFileSha256 !== currentSha) {
                    diagnostics.push(`stale: current sha ${currentSha} != attested ${resource.fullFileSha256} for ${canonicalTarget}`);
                    return {
                        content: [{ type: "text" as const, text: `rejected: stale (${group.rawPath})` }],
                        details: finalize(makeRejected(toolCallId, "stale", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations)),
                    };
                }

                // Compute target line range from edits, then validate coverage.
                let targetRange: LineRange | null;
                let editOccurrences: ReadonlyArray<LineRange> = [];
                if (isNewFileGroup) {
                    // New-file creation: the empty oldText is implicit at offset 0
                    // of the (empty) current content. There's no pre-existing
                    // target range to validate against line-range coverage.
                    targetRange = { startLine: 1, endLine: 1 };
                    editOccurrences = [targetRange];
                } else {
                    const found = findTargetLineRangeForEdits(currentContent, group.edits);
                    targetRange = found.minMax;
                    editOccurrences = found.occurrences;
                }
                if (!targetRange) {
                    diagnostics.push(`target line range could not be derived from edits (oldText not found) for ${canonicalTarget}`);
                    return {
                        content: [{
                            type: "text" as const,
                            text: `failed: target not found in ${group.rawPath}; re-inspect the file and retry with current exact text`,
                        }],
                        details: finalize(makeFailed(toolCallId, "stage", `target not found: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence, invalidations)),
                    };
                }
                if (resource.coverage === "line-range") {
                    // For replaceAll edits we must verify EVERY occurrence falls within an allowed range;
                    // a non-replaceAll edit only needs the (single) occurrence to fall in range.
                    const uncovered = editOccurrences.filter(
                        (occ) => !resource.allowedRanges.some((a) => withinRange(occ, a)),
                    );
                    if (uncovered.length > 0) {
                        const first = uncovered[0];
                        if (first) {
                            diagnostics.push(`coverage: ${uncovered.length} occurrence(s) outside allowedRanges for ${canonicalTarget} (e.g. [${first.startLine},${first.endLine}])`);
                        } else {
                            diagnostics.push(`coverage: ${uncovered.length} occurrence(s) outside allowedRanges for ${canonicalTarget}`);
                        }
                        return {
                            content: [{ type: "text" as const, text: `rejected: coverage (${group.rawPath})` }],
                            details: finalize(makeRejected(toolCallId, "coverage", diagnostics, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, usedEvidence, invalidations)),
                        };
                    }
                }

                // Apply the edits in-memory.
                let newContent = currentContent;
                for (const edit of group.edits) {
                    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
                        // Pre-write: input shape problem. No file write happened.
                        diagnostics.push(`edit missing oldText/newText in ${group.rawPath}`);
                        return {
                            content: [{ type: "text" as const, text: `failed: edit (missing fields) in ${group.rawPath}` }],
                            details: finalize(makeFailed(toolCallId, "stage", `edit missing oldText/newText: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations)),
                        };
                    }
                    // The target range check above already verified oldText is
                    // present in currentContent, so we can rely on the include
                    // here. (We still defensively re-check for newContent
                    // because successive edits compose the buffer.)
                    if (!newContent.includes(edit.oldText)) {
                        // Pre-write: content mismatch on a composed buffer. No
                        // file write happened. This is a stage error, not a
                        // write error.
                        diagnostics.push(`oldText not found in composed buffer for ${group.rawPath}`);
                        return {
                            content: [{ type: "text" as const, text: `failed: edit (oldText not found) in ${group.rawPath}` }],
                            details: finalize(makeFailed(toolCallId, "stage", `oldText not found: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations)),
                        };
                    }
                    if (edit.replaceAll) {
                        newContent = newContent.split(edit.oldText).join(edit.newText);
                    } else {
                        newContent = newContent.replace(edit.oldText, edit.newText);
                    }
                }

                // Run allowlisted checks (per file).
                const verifiers = deps.getVerificationChecks?.() ?? [];
                for (const v of verifiers) {
                    let outcome: "pass" | "fail" | "skipped" | "timeout" = "pass";
                    let detail: string | undefined;
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try {
                        const result = await Promise.race([
                            v.run({ path: canonicalTarget, content: newContent, toolCallId }),
                            new Promise<never>((_r, rej) => {
                                timer = setTimeout(() => { rej(new Error("timeout")); }, 5000);
                            }),
                        ]);
                        outcome = result.outcome;
                        if (result.detail) detail = result.detail;
                    } catch (err) {
                        // Only the racing timer maps to "timeout". A blocking
                        // verifier that throws for any other reason is treated
                        // as a hard fail so the gate below actually blocks the
                        // write.
                        if (err instanceof Error && err.message === "timeout") {
                            outcome = "timeout";
                        } else {
                            outcome = "fail";
                        }
                        detail = err instanceof Error ? err.message : String(err);
                    } finally {
                        if (timer) clearTimeout(timer);
                    }
                    const check = makeCheck(`${v.id}:${group.rawPath}`, outcome, detail);
                    if (outcome === "timeout") checks.timedOut.push(check);
                    else if (v.kind === "blocking") checks.blocking.push(check);
                    else checks.advisory.push(check);
                    checks.completed.push(check);
                }

                // A failing blocking check must prevent the write — recording
                // it in checks.blocking is not itself a gate.
                const failedBlocking = checks.blocking.find((c) => c.outcome === "fail");
                if (failedBlocking) {
                    diagnostics.push(`blocking check failed: ${failedBlocking.id}${failedBlocking.detail ? ` (${failedBlocking.detail})` : ""}`);
                    return {
                        content: [{ type: "text" as const, text: `rejected: blocking check failed (${group.rawPath})` }],
                        details: finalize(makeRejected(toolCallId, "approval", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations)),
                    };
                }

                // Fix #6: re-read and re-hash immediately before writing so a
                // concurrent writer between the initial SHA check and the actual
                // atomicWrite cannot slip a stale write in. For new files
                // there's nothing on disk to race against, so the check is a
                // no-op.
                if (!isNewFileGroup) {
                    let preWriteContent: string;
                    try {
                        preWriteContent = await safeReadUtf8(canonicalTarget);
                    } catch (err) {
                        diagnostics.push(`re-read failed: ${err instanceof Error ? err.message : String(err)}`);
                        return {
                            content: [{ type: "text" as const, text: `rejected: stale (${group.rawPath})` }],
                            details: finalize(makeRejected(toolCallId, "stale", diagnostics, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, usedEvidence, invalidations)),
                        };
                    }
                    if (sha256OfString(preWriteContent) !== currentSha) {
                        diagnostics.push(`stale re-read for ${canonicalTarget} (sha changed during apply)`);
                        return {
                            content: [{ type: "text" as const, text: `rejected: stale (${group.rawPath})` }],
                            details: finalize(makeRejected(toolCallId, "stale", diagnostics, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, usedEvidence, invalidations)),
                        };
                    }
                }

                // Atomic write.
                try {
                    await atomicWrite(canonicalTarget, newContent);
                } catch (err) {
                    diagnostics.push(`write failed: ${err instanceof Error ? err.message : String(err)}`);
                    return {
                        content: [{ type: "text" as const, text: `failed: write ${group.rawPath}` }],
                        details: finalize(makeFailed(toolCallId, "write", `write failed: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence, invalidations)),
                    };
                }

                // Fix #3: record the invalidation right after the write, before
                // post-write verify. This way, every later failure path
                // (including post-write read/hash failures) reports the file
                // as actually changed on disk.
                const newSha = sha256OfString(newContent);
                invalidations.push({
                    resourceId: resource.resourceId,
                    canonicalPath: resource.canonicalPath,
                    fullFileSha256: currentSha,
                    newFullFileSha256: newSha,
                    coverage: resource.coverage,
                });

                // Post-write verify.
                let postContent: string;
                try {
                    const statRes = await fsStat(canonicalTarget);
                    void statRes;
                    postContent = await safeReadUtf8(canonicalTarget);
                } catch (err) {
                    diagnostics.push(`verify read failed: ${err instanceof Error ? err.message : String(err)}`);
                    return {
                        content: [{ type: "text" as const, text: `failed: verify ${group.rawPath}` }],
                        details: finalize(makeFailed(toolCallId, "verify", `post-write read failed: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence, invalidations)),
                    };
                }
                const postSha = sha256OfString(postContent);
                const postVerifySha = sha256OfString(newContent);
                if (postSha !== postVerifySha) {
                    diagnostics.push(`verify mismatch: in-memory ${postVerifySha} != on-disk ${postSha} for ${canonicalTarget}`);
                    return {
                        content: [{ type: "text" as const, text: `failed: verify ${group.rawPath}` }],
                        details: finalize(makeFailed(toolCallId, "verify", `post-write hash mismatch: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence, invalidations)),
                    };
                }

                // Fix #3: the invalidation was already recorded immediately after
                // atomicWrite succeeded, so we don't push it again here. We only
                // compute post-write metadata (sha, line count, diff) for the
                // PatchDetails response.
                const newLines = postContent.split("\n");
                const postEditEvidence: PostEditEvidence = {
                    fullFileSha256: postSha,
                    lineCount: newLines.length,
                    byteLength: Buffer.byteLength(postContent, "utf8"),
                };
                postEditEvidenceByPath.set(canonicalTarget, postEditEvidence);
                const generatedDiff = generateDiffString(currentContent, postContent).diff;
                displayDiffs.push({ path: group.rawPath, diff: generatedDiff });
                appliedFiles.push(group.rawPath);
                stream(`  ✓ wrote ${group.rawPath}`);
            }

            // Surface evidence-pipeline uncertainty in skipped bucket.
            if (autoInspected) {
                checks.skipped.push(makeCheck("evidence-pipeline", "skipped", "auto-inspected (no prior inspect call); pipeline check was replaced by in-tool read+sha"));
            } else {
                checks.skipped.push(makeCheck("evidence-pipeline", "skipped", "evidence-pipeline check ran above; this row records pipeline uncertainty for the consumer"));
            }

            // Build the final details. For v3 multi-file, postEditEvidence is
            // emitted per file via the postEditEvidenceByPath map, and the
            // top-level postEditEvidence is the last (or only) file's value
            // for backward compatibility with v1 single-file consumers.
            const lastAppliedFile = appliedFiles.at(-1);
            const lastCanonical = lastAppliedFile ? realpathSync(pathResolve(ctx.cwd, lastAppliedFile)) : "";
            const lastPost = lastCanonical ? postEditEvidenceByPath.get(lastCanonical) : undefined;

            const singleDiff = displayDiffs.length === 1 ? displayDiffs[0] : undefined;
            const combinedDiff = singleDiff
                ? singleDiff.diff
                : displayDiffs.map((entry) => `${entry.path}\n${entry.diff}`).join("\n\n");
            const details: PatchToolDetails = {
                tool: "patch",
                status: { kind: "applied" },
                toolCallId,
                evidenceRef: evidenceRefForDetails,
                usedEvidence: [...new Set(usedEvidence)],
                changedResources: invalidations,
                postEditEvidence: lastPost,
                checks: freezeChecks(checks),
                diagnostics,
                diff: combinedDiff,
                diffs: displayDiffs,
            };
            const summary = appliedFiles.length === 1
                ? `applied ${groups[0]?.edits.length ?? 0} edit(s) to ${appliedFiles[0]}`
                : `applied edits to ${appliedFiles.length} file(s): ${appliedFiles.join(", ")}`;
            return {
                content: [{ type: "text" as const, text: summary }],
                details,
            };
        },
    };
}

// ── helpers ──

function makeRejected(
    toolCallId: string,
    reason: "stale" | "coverage" | "conflict" | "approval" | "session",
    diagnostics: string[],
    evidenceRef: EvidenceRef,
    checks: MutableChecks,
    usedEvidence: ReadonlyArray<string> = [],
    changedResources: ReadonlyArray<ResourceInvalidation> = [],
): PatchDetails {
    return {
        tool: "patch",
        status: { kind: "rejected", reason },
        toolCallId,
        evidenceRef,
        usedEvidence: [...usedEvidence],
        changedResources: [...changedResources],
        checks: freezeChecks(checks),
        diagnostics,
    };
}

function makeFailed(
    toolCallId: string,
    phase: "stage" | "write" | "verify",
    message: string,
    evidenceRef: EvidenceRef,
    checks: MutableChecks,
    diagnostics: string[],
    usedEvidence: ReadonlyArray<string> = [],
    changedResources: ReadonlyArray<ResourceInvalidation> = [],
): PatchDetails {
    return {
        tool: "patch",
        status: { kind: "failed", phase },
        toolCallId,
        evidenceRef,
        usedEvidence: [...usedEvidence],
        changedResources: [...changedResources],
        checks: freezeChecks(checks),
        diagnostics: [...diagnostics, message],
        error: message,
    };
}

function finalize(d: PatchDetails): PatchDetails {
    return d;
}

function classifyRpcError(msg: string | undefined): "stale" | "coverage" | "conflict" | "approval" | "session" {
    if (!msg) return "session";
    if (/coverage/i.test(msg)) return "coverage";
    if (/stale/i.test(msg)) return "stale";
    if (/conflict|duplicate/i.test(msg)) return "conflict";
    return "session";
}
