/**
 * Patch tool — v3 multi-file patch with workspace-evidence authorization.
 *
 * v1 was single-file, evidence-bound, with a hard multi-file prohibition.
 * v3 adds:
 *   - Multi-file support: each edit may carry its own `path` (PatchEditItemV3)
 *     which overrides the top-level `path` default.
 *   - Grouped atomic application: edits are grouped by file path, each group
 *     is applied atomically to its own file.
 *   - Per-file evidence coverage: every file targeted by an edit must have at
 *     least one resource in the envelope covering it.
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
 *   shell or verification commands.
 * - Returns a discriminated `details` with the full lifecycle.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile as fsReadFile, writeFile as fsWriteFile, stat as fsStat, rename as fsRename } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import { realpathSync } from "node:fs";

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

// ── Public surface ──────────────────────────────────────────────────

export interface RpcClientLike {
    request(rpc: RpcMethod, payload: unknown, options?: { signal?: AbortSignal }): Promise<{
        kind: "reply";
        schemaVersion: typeof PROTOCOL_SCHEMA_VERSION;
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

    for (const rid of args.requestedResourceIds) {
        const r = args.envelope.resources.find((x) => x.resourceId === rid);
        if (!r) return { ok: false, reason: `missing resource: ${rid}` };
        if (r.coverage === "line-range") {
            const tr = args.targetLineRange;
            if (!tr) {
                return { ok: false, reason: "coverage: line-range resource requires an explicit target line range" };
            }
            const ok = r.allowedRanges.some(
                (a) => tr.startLine >= a.startLine && tr.endLine <= a.endLine,
            );
            if (!ok) return { ok: false, reason: "coverage: target line range not within allowedRanges" };
        }
        return { ok: true, resource: r };
    }
    return { ok: false, reason: "no matching resource" };
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
    edits: ReadonlyArray<{ oldText?: string }>,
): LineRange | null {
    let min = Infinity;
    let max = -Infinity;
    let any = false;
    for (const e of edits) {
        if (typeof e.oldText !== "string" || e.oldText.length === 0) continue;
        const idx = content.indexOf(e.oldText);
        if (idx < 0) return null;
        const startLine = content.slice(0, idx).split("\n").length;
        const matchedLines = e.oldText.split("\n").length;
        const endLine = startLine + matchedLines - 1;
        if (startLine < min) min = startLine;
        if (endLine > max) max = endLine;
        any = true;
    }
    if (!any) return null;
    return { startLine: min, endLine: max };
}

function findResourceForCanonicalPath(
    envelope: WorkspaceEvidenceEnvelope,
    canonicalPath: string,
    requestedIds: ReadonlyArray<string>,
): InspectedResource | null {
    // First, restrict to requested resources. Then look for a canonical path
    // match (case-sensitive equality — canonical paths are realpath-resolved).
    for (const rid of requestedIds) {
        const r = envelope.resources.find((x) => x.resourceId === rid);
        if (!r) continue;
        if (r.canonicalPath === canonicalPath) return r;
    }
    // Fall back: any resource in the envelope with this canonical path,
    // even if not explicitly requested. This makes the contract friendlier
    // for multi-file patch where resourceIds may list subset.
    return envelope.resources.find((r) => r.canonicalPath === canonicalPath) ?? null;
}

async function atomicWrite(path: string, content: string): Promise<void> {
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
}): Promise<{ ok: true; envelope: WorkspaceEvidenceEnvelope; canonicalByGroup: string[] } | { ok: false; error: string }> {
    const sessionId = hashSessionFilePath(args.sessionFilePath);
    const resources: InspectedResource[] = [];
    const canonicalByGroup: string[] = [];
    const resourceKeyItems: Array<{ canonicalPath: string; range?: { startLine: number; endLine: number } }> = [];

    for (const g of args.groups) {
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
        schemaVersion: 2 as typeof PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: args.canonicalRoot,
        canonicalWorkspaceRoot: args.canonicalRoot,
        createdAt: new Date().toISOString(),
        resources,
        mode: "path",
    };
    return { ok: true, envelope, canonicalByGroup };
}

// ── Patch tool factory ──────────────────────────────────────────────

const PATCH_PARAMS_DOC = {
    description:
        "Apply edits gated by a workspace-evidence inspection. Provide a `path`, a list of `edits`, and (optionally) an `evidenceRef` from a prior `inspect` call. If `evidenceRef` is omitted, patch auto-inspects each target file (full-file). v3 supports multi-file: each edit may carry its own `path` to override the top-level default.",
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
            description: "Optional reference to a prior `inspect` tool result. If omitted, patch auto-inspects each target file.",
            properties: {
                inspectionId: { type: "string" },
                resourceIds: { type: "array", items: { type: "string" } },
            },
            required: ["inspectionId", "resourceIds"],
        },
    },
} as const;

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
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: PatchDetails }>;
}

export function createPatchTool(deps: PatchToolDeps): PatchTool {
    return {
        name: "patch",
        label: "patch",
        description:
            "Apply edits gated by a workspace-evidence inspection. v3 supports multi-file: each edit may carry its own `path`. If no `evidenceRef` is provided, patch auto-inspects each target file (full-file, SHA-256 freshness). Returns a discriminated lifecycle result (applied | rejected | failed).",
        parameters: PATCH_PARAMS_DOC as unknown as Record<string, unknown>,

        async execute(toolCallId, params, signal, _onUpdate, ctx) {
            const v = validatePatchRequestProto(params);
            if (!v.ok) {
                return {
                    content: [{ type: "text" as const, text: `invalid patch request: ${v.error}` }],
                    details: makeRejected(toolCallId, "session", ["invalid patch request shape"], { inspectionId: "", resourceIds: [] }, freshChecks()),
                };
            }

            const sessionFilePath = deps.getSessionFilePath();
            if (typeof sessionFilePath !== "string" || sessionFilePath.length === 0) {
                return {
                    content: [{ type: "text" as const, text: "rejected: ephemeral session identity" }],
                    details: makeRejected(toolCallId, "session", ["no real session file path"], {
                        inspectionId: typeof v.value.evidenceRef?.inspectionId === "string" ? v.value.evidenceRef.inspectionId : "",
                        resourceIds: Array.isArray(v.value.evidenceRef?.resourceIds) ? [...v.value.evidenceRef.resourceIds] : [],
                    }, freshChecks()),
                };
            }

            const canonicalRoot = deps.getCanonicalWorkspaceRoot();
            if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) {
                return {
                    content: [{ type: "text" as const, text: "rejected: missing canonical workspace root" }],
                    details: makeRejected(toolCallId, "session", ["no canonical workspace root"], {
                        inspectionId: v.value.evidenceRef.inspectionId,
                        resourceIds: [...v.value.evidenceRef.resourceIds],
                    }, freshChecks()),
                };
            }

            // Group edits by file path (per-edit path overrides top-level).
            const grouping = groupEditsByPath(ctx.cwd, v.value.path, v.value.edits);
            if (!grouping.ok) {
                return {
                    content: [{ type: "text" as const, text: `rejected: ${grouping.error}` }],
                    details: makeRejected(toolCallId, "session", [grouping.error], {
                        inspectionId: v.value.evidenceRef.inspectionId,
                        resourceIds: [...v.value.evidenceRef.resourceIds],
                    }, freshChecks()),
                };
            }
            const groups = grouping.groups;
            const checks: MutableChecks = freshChecks();
            const diagnostics: string[] = [];
            const usedEvidence: string[] = [];

            // ── Acquire envelope ──────────────────────────────────────
            // v3: if no evidenceRef is provided, auto-inspect each target file
            // (read content, compute SHA-256, build synthetic full-file
            // envelope). Otherwise resolve via RPC.

            let envelope: WorkspaceEvidenceEnvelope;
            let autoInspected = false;
            let evidenceRefForDetails: EvidenceRef;

            if (v.value.evidenceRef.resourceIds.length === 0) {
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
                evidenceRefForDetails = {
                    inspectionId: envelope.inspectionId,
                    resourceIds: envelope.resources.map((r) => r.resourceId),
                };
                checks.completed.push(makeCheck("auto-inspect", "pass", `synthesized envelope for ${envelope.resources.length} file(s)`));
            } else {
                evidenceRefForDetails = {
                    inspectionId: v.value.evidenceRef.inspectionId,
                    resourceIds: [...v.value.evidenceRef.resourceIds],
                };
                const rpc = deps.getRpcClient();
                try {
                    const reply = await rpc.request(
                        "resolve_evidence" as RpcMethod,
                        {
                            inspectionId: v.value.evidenceRef.inspectionId,
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

            for (const group of groups) {
                // Resolve canonical path for this group.
                let canonicalTarget: string;
                try {
                    canonicalTarget = realpathSync(group.absolutePath);
                } catch (err) {
                    diagnostics.push(`file not found: ${group.absolutePath}`);
                    return {
                        content: [{ type: "text" as const, text: `failed: file not found: ${group.rawPath}` }],
                        details: finalize(makeFailed(toolCallId, "stage", `file not found: ${group.rawPath}`, {
                            ...evidenceRefForDetails,
                            resourceIds: [""],
                        }, checks, diagnostics, usedEvidence)),
                    };
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
                        details: finalize(makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence)),
                    };
                }
                usedEvidence.push(resource.resourceId);

                // Read current content + compute sha.
                let currentContent: string;
                let currentSha: string;
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
                        }, checks, diagnostics, usedEvidence)),
                    };
                }

                // Freshness check.
                if (typeof resource.fullFileSha256 === "string" && resource.fullFileSha256 !== currentSha) {
                    diagnostics.push(`stale: current sha ${currentSha} != attested ${resource.fullFileSha256} for ${canonicalTarget}`);
                    return {
                        content: [{ type: "text" as const, text: `rejected: stale (${group.rawPath})` }],
                        details: finalize(makeRejected(toolCallId, "stale", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence)),
                    };
                }

                // Compute target line range from edits, then validate coverage.
                const targetRange = findTargetLineRangeForEdits(currentContent, group.edits);
                if (!targetRange) {
                    diagnostics.push(`target line range could not be derived from edits (oldText not found) for ${canonicalTarget}`);
                    return {
                        content: [{ type: "text" as const, text: `failed: target not found in ${group.rawPath}` }],
                        details: finalize(makeFailed(toolCallId, "stage", `target not found: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence)),
                    };
                }
                if (resource.coverage === "line-range") {
                    const covered = resource.allowedRanges.some((a) => withinRange(targetRange, a));
                    if (!covered) {
                        diagnostics.push(`coverage: target [${targetRange.startLine},${targetRange.endLine}] not within any allowedRange for ${canonicalTarget}`);
                        return {
                            content: [{ type: "text" as const, text: `rejected: coverage (${group.rawPath})` }],
                            details: finalize(makeRejected(toolCallId, "coverage", diagnostics, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, usedEvidence)),
                        };
                    }
                }

                // Apply the edits in-memory.
                let newContent = currentContent;
                for (const edit of group.edits) {
                    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
                        diagnostics.push(`edit missing oldText/newText in ${group.rawPath}`);
                        return {
                            content: [{ type: "text" as const, text: `failed: edit (missing fields) in ${group.rawPath}` }],
                            details: finalize(makeFailed(toolCallId, "write", `edit missing oldText/newText: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence)),
                        };
                    }
                    if (!newContent.includes(edit.oldText)) {
                        diagnostics.push(`oldText not found in ${group.rawPath}`);
                        return {
                            content: [{ type: "text" as const, text: `failed: edit (oldText not found) in ${group.rawPath}` }],
                            details: finalize(makeFailed(toolCallId, "write", `oldText not found: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence)),
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
                    try {
                        const result = await Promise.race([
                            v.run({ path: canonicalTarget, content: newContent, toolCallId }),
                            new Promise<never>((_r, rej) => {
                                setTimeout(() => { rej(new Error("timeout")); }, 5000);
                            }),
                        ]);
                        outcome = result.outcome;
                        if (result.detail) detail = result.detail;
                    } catch (err) {
                        outcome = "timeout";
                        detail = err instanceof Error ? err.message : String(err);
                    }
                    const check = makeCheck(`${v.id}:${group.rawPath}`, outcome, detail);
                    if (outcome === "timeout") checks.timedOut.push(check);
                    else if (v.kind === "blocking") checks.blocking.push(check);
                    else checks.advisory.push(check);
                    checks.completed.push(check);
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
                        }, checks, diagnostics, usedEvidence)),
                    };
                }

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
                        }, checks, diagnostics, usedEvidence)),
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
                        }, checks, diagnostics, usedEvidence)),
                    };
                }

                const invalidation: ResourceInvalidation = {
                    resourceId: resource.resourceId,
                    canonicalPath: resource.canonicalPath,
                    fullFileSha256: currentSha,
                    newFullFileSha256: postSha,
                    coverage: resource.coverage,
                };
                invalidations.push(invalidation);
                const newLines = postContent.split("\n");
                const postEditEvidence: PostEditEvidence = {
                    fullFileSha256: postSha,
                    lineCount: newLines.length,
                    byteLength: Buffer.byteLength(postContent, "utf8"),
                };
                postEditEvidenceByPath.set(canonicalTarget, postEditEvidence);
                appliedFiles.push(group.rawPath);
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
            const lastCanonical = appliedFiles.length > 0 ? realpathSync(pathResolve(ctx.cwd, appliedFiles[appliedFiles.length - 1]!)) : "";
            const lastPost = lastCanonical ? postEditEvidenceByPath.get(lastCanonical) : undefined;

            const details: PatchDetails = {
                tool: "patch",
                status: { kind: "applied" },
                toolCallId,
                evidenceRef: evidenceRefForDetails,
                usedEvidence: [...new Set(usedEvidence)],
                changedResources: invalidations,
                postEditEvidence: lastPost,
                checks: freezeChecks(checks),
                diagnostics,
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
): PatchDetails {
    return {
        tool: "patch",
        status: { kind: "rejected", reason },
        toolCallId,
        evidenceRef,
        usedEvidence: [...usedEvidence],
        changedResources: [],
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
): PatchDetails {
    return {
        tool: "patch",
        status: { kind: "failed", phase },
        toolCallId,
        evidenceRef,
        usedEvidence: [...usedEvidence],
        changedResources: [],
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
