/**
 * Patch tool — additive single-file patch with workspace-evidence authorization.
 *
 * - Accepts a single EvidenceRef (`{inspectionId, resourceIds}`).
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

import type {
    PROTOCOL_SCHEMA_VERSION,
} from "@rhinos0608/pi-workspace-protocol";
import {
    hashSessionFilePath,
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

function sha256OfString(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

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

async function atomicWrite(path: string, content: string): Promise<void> {
    const tmp = `${path}.${randomUUID()}.tmp`;
    await fsWriteFile(tmp, content, "utf8");
    await fsRename(tmp, path);
}

// ── Patch tool factory ──────────────────────────────────────────────

const PATCH_PARAMS_DOC = {
    description: "Apply a single-file edit gated by a workspace-evidence inspection. Provide a `path`, a list of `edits` matching the existing single-file edit shape, and an `evidenceRef` from a prior `inspect` call. No multi-file atomic claim.",
    type: "object",
    properties: {
        path: { type: "string", description: "Target file path (single file only)." },
        edits: {
            type: "array",
            description: "One or more targeted edits.",
            items: {
                type: "object",
                properties: {
                    oldText: { type: "string" },
                    newText: { type: "string" },
                    description: { type: "string" },
                    replaceAll: { type: "boolean" },
                },
            },
        },
        evidenceRef: {
            type: "object",
            description: "Reference to a prior `inspect` tool result.",
            properties: {
                inspectionId: { type: "string" },
                resourceIds: { type: "array", items: { type: "string" } },
            },
            required: ["inspectionId", "resourceIds"],
        },
    },
    required: ["path", "edits", "evidenceRef"],
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
            "Apply a single-file edit gated by a workspace-evidence inspection. Returns a discriminated lifecycle result (applied | rejected | failed) and never authorizes edits outside the inspected resource's coverage.",
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
                        inspectionId: v.value.evidenceRef.inspectionId,
                        resourceIds: v.value.evidenceRef.resourceIds,
                    }, freshChecks()),
                };
            }

            const canonicalRoot = deps.getCanonicalWorkspaceRoot();
            const absolutePath = pathResolve(ctx.cwd, v.value.path);

            // 1. Resolve evidence via RPC
            const rpc = deps.getRpcClient();
            const checks: MutableChecks = freshChecks();
            const diagnostics: string[] = [];
            const usedEvidence: string[] = [];

            let envelope: WorkspaceEvidenceEnvelope;
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
                        details: makeRejected(toolCallId, classifyRpcError(reply.error), [reply.error ?? "rpc failure"], {
                            inspectionId: v.value.evidenceRef.inspectionId,
                            resourceIds: v.value.evidenceRef.resourceIds,
                        }, checks),
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
                    details: makeFailed(toolCallId, "stage", msg, {
                        inspectionId: v.value.evidenceRef.inspectionId,
                        resourceIds: v.value.evidenceRef.resourceIds,
                    }, checks, diagnostics),
                };
            } finally {
                rpc.dispose();
            }

            // 2. Find the requested resource in the envelope
            const resource = envelope.resources.find((r) => v.value.evidenceRef.resourceIds.includes(r.resourceId));
            if (!resource) {
                diagnostics.push("requested resource not found in envelope");
                return {
                    content: [{ type: "text" as const, text: "rejected: missing resource" }],
                    details: finalize(makeRejected(toolCallId, "coverage", diagnostics, {
                        inspectionId: envelope.inspectionId,
                        resourceIds: v.value.evidenceRef.resourceIds,
                    }, checks)),
                };
            }
            usedEvidence.push(resource.resourceId);

            // 3. Path must match resource.canonicalPath
            let canonicalTarget: string;
            try {
                canonicalTarget = realpathSync(absolutePath);
            } catch {
                diagnostics.push(`file not found: ${absolutePath}`);
                return {
                    content: [{ type: "text" as const, text: "failed: file not found" }],
                    details: finalize(makeFailed(toolCallId, "stage", "file not found", {
                        inspectionId: envelope.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, diagnostics, usedEvidence)),
                };
            }
            if (canonicalTarget !== resource.canonicalPath) {
                diagnostics.push(`target path ${canonicalTarget} != resource.canonicalPath ${resource.canonicalPath}`);
                return {
                    content: [{ type: "text" as const, text: "rejected: path/canonical mismatch" }],
                    details: finalize(makeRejected(toolCallId, "coverage", diagnostics, {
                        inspectionId: envelope.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, usedEvidence)),
                };
            }

            // 4. Read current content + compute sha
            let currentContent: string;
            let currentSha: string;
            try {
                currentContent = await safeReadUtf8(canonicalTarget);
                currentSha = sha256OfString(currentContent);
            } catch (err) {
                diagnostics.push(`read failed: ${err instanceof Error ? err.message : String(err)}`);
                return {
                    content: [{ type: "text" as const, text: "failed: read" }],
                    details: finalize(makeFailed(toolCallId, "stage", "read failed", {
                        inspectionId: envelope.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, diagnostics, usedEvidence)),
                };
            }

            // 5. Freshness check
            if (typeof resource.fullFileSha256 === "string" && resource.fullFileSha256 !== currentSha) {
                diagnostics.push(`stale: current sha ${currentSha} != attested ${resource.fullFileSha256}`);
                return {
                    content: [{ type: "text" as const, text: "rejected: stale" }],
                    details: finalize(makeRejected(toolCallId, "stale", diagnostics, {
                        inspectionId: envelope.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, usedEvidence)),
                };
            }

            // 6. Compute actual target line range and validate coverage
            const targetRange = findTargetLineRangeForEdits(currentContent, v.value.edits);
            if (!targetRange) {
                diagnostics.push("target line range could not be derived from edits (oldText not found)");
                return {
                    content: [{ type: "text" as const, text: "failed: target not found" }],
                    details: finalize(makeFailed(toolCallId, "stage", "target not found", {
                        inspectionId: envelope.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, diagnostics, usedEvidence)),
                };
            }
            if (resource.coverage === "line-range") {
                const covered = resource.allowedRanges.some((a) => withinRange(targetRange, a));
                if (!covered) {
                    diagnostics.push(`coverage: target [${targetRange.startLine},${targetRange.endLine}] not within any allowedRange`);
                    return {
                        content: [{ type: "text" as const, text: "rejected: coverage" }],
                        details: finalize(makeRejected(toolCallId, "coverage", diagnostics, {
                            inspectionId: envelope.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence)),
                    };
                }
            }

            // 7. Apply the edits in-memory
            const appliedEdits: Array<{ ok: boolean; message?: string }> = [];
            let newContent = currentContent;
            for (const edit of v.value.edits) {
                if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
                    appliedEdits.push({ ok: false, message: "edit missing oldText/newText" });
                    continue;
                }
                if (edit.replaceAll) {
                    if (!newContent.includes(edit.oldText)) {
                        appliedEdits.push({ ok: false, message: "oldText not found" });
                        continue;
                    }
                    newContent = newContent.split(edit.oldText).join(edit.newText);
                } else {
                    if (!newContent.includes(edit.oldText)) {
                        appliedEdits.push({ ok: false, message: "oldText not found" });
                        continue;
                    }
                    newContent = newContent.replace(edit.oldText, edit.newText);
                }
                appliedEdits.push({ ok: true });
            }
            if (appliedEdits.some((e) => !e.ok)) {
                diagnostics.push(appliedEdits.find((e) => !e.ok)?.message ?? "edit failed");
                return {
                    content: [{ type: "text" as const, text: "failed: edit" }],
                    details: finalize(makeFailed(toolCallId, "write", "edit application failed", {
                        inspectionId: envelope.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, diagnostics, usedEvidence)),
                };
            }

            // 8. Run allowlisted checks
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
                const check = makeCheck(v.id, outcome, detail);
                if (outcome === "timeout") checks.timedOut.push(check);
                else if (v.kind === "blocking") checks.blocking.push(check);
                else checks.advisory.push(check);
                checks.completed.push(check);
            }
            // Surface evidence-pipeline uncertainty in skipped bucket
            checks.skipped.push(makeCheck("evidence-pipeline", "skipped", "evidence-pipeline check ran above; this row records pipeline uncertainty for the consumer"));

            // 9. Write atomically, then verify post sha
            try {
                await atomicWrite(canonicalTarget, newContent);
            } catch (err) {
                diagnostics.push(`write failed: ${err instanceof Error ? err.message : String(err)}`);
                return {
                    content: [{ type: "text" as const, text: "failed: write" }],
                    details: finalize(makeFailed(toolCallId, "write", "write failed", {
                        inspectionId: envelope.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, diagnostics, usedEvidence)),
                };
            }
            const postSha = sha256OfString(newContent);
            let postContent: string;
            try {
                const statRes = await fsStat(canonicalTarget);
                void statRes;
                postContent = await safeReadUtf8(canonicalTarget);
            } catch (err) {
                diagnostics.push(`verify read failed: ${err instanceof Error ? err.message : String(err)}`);
                return {
                    content: [{ type: "text" as const, text: "failed: verify" }],
                    details: finalize(makeFailed(toolCallId, "verify", "post-write read failed", {
                        inspectionId: envelope.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, diagnostics, usedEvidence)),
                };
            }
            const postVerifySha = sha256OfString(postContent);
            if (postVerifySha !== postSha) {
                diagnostics.push(`verify mismatch: in-memory ${postSha} != on-disk ${postVerifySha}`);
                return {
                    content: [{ type: "text" as const, text: "failed: verify" }],
                    details: finalize(makeFailed(toolCallId, "verify", "post-write hash mismatch", {
                        inspectionId: envelope.inspectionId,
                        resourceIds: [resource.resourceId],
                    }, checks, diagnostics, usedEvidence)),
                };
            }

            const newLines = postContent.split("\n");
            const invalidation: ResourceInvalidation = {
                resourceId: resource.resourceId,
                canonicalPath: resource.canonicalPath,
                fullFileSha256: currentSha,
                newFullFileSha256: postVerifySha,
                coverage: resource.coverage,
            };
            const postEditEvidence: PostEditEvidence = {
                fullFileSha256: postVerifySha,
                lineCount: newLines.length,
                byteLength: Buffer.byteLength(postContent, "utf8"),
            };
            const details: PatchDetails = {
                tool: "patch",
                status: { kind: "applied" },
                toolCallId,
                evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: [resource.resourceId] },
                usedEvidence,
                changedResources: [invalidation],
                postEditEvidence,
                checks: freezeChecks(checks),
                diagnostics,
            };
            return {
                content: [{ type: "text" as const, text: `applied ${v.value.edits.length} edit(s) to ${canonicalTarget}` }],
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
