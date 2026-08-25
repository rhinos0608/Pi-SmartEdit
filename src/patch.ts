/**
 * Patch tool — v3 multi-file patch with workspace-evidence authorization.
 *
 * v1 was single-file, evidence-bound, with a hard multi-file prohibition.
 * v3 adds:
 *   - Multi-file support: each edit may carry its own `path` (PatchEditItemV3)
 *     which overrides the top-level `path` default.
 *   - Validated batch mutation is failure-atomic for handled failures: edits
 *     run in one EditTransaction with cross-file rollback before failure is
 *     reported. Files are individually written atomically.
 *   - Per-file evidence coverage: every file targeted by an edit must have a
 *     strong-coverage resource (full-file or line-range) in the envelope
 *     covering it. Weak-coverage resources (search-match, metadata-only —
 *     produced by inspect's query/symbol modes) are explicitly rejected;
 *     the model must path-mode inspect a file before patching it.
 *   - Existing files require prior strong model-visible read evidence. Missing
 *     or weak prior evidence is rejected with actionable read guidance. New
 *     in-root files may use explicit empty-file semantics.
 *
 * - Accepts a single EvidenceRef (`{inspectionId, resourceIds}`); tool-owned
 *   prior authority is preferred when available.
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
import { readFile as fsReadFile, stat as fsStat, mkdir as fsMkdir } from "node:fs/promises";
import { resolve as pathResolve, dirname as pathDirname, relative as pathRelative } from "node:path";
import { realpathSync, existsSync } from "node:fs";

import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    resourceIdFor,
    sha256OfString,
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
import { formatBoundedDiagnostics, appendDiagnosticsToContent } from "./post-mutation.js";
import { generateDiffString, stripBom, normalizeToLF } from "./core/edit-diff.js";
import { resolveSourceRange, buildTransferInsertEdit, buildTransferDeleteEdit } from "./transfer-edit.js";
import { checkEditSafety } from "./safety/approval-gating.js";
import { EDIT_PARAMETERS, validateEditRequest, type EditOperation } from "./edit-contract.js";
import { normalizeRawEdit } from "./edit-intents.js";
import type { PriorAuthorityStore } from "./evidence-authority.js";
import { planTextEdits, type StructuralResolver } from "./edit-planner.js";
import { EditTransaction } from "./edit-transaction.js";
import { saveTransactionUndoRecords } from "./undo/edit-history.js";
import { MatchError } from "./core/errors.js";
import type { AstResolverLike } from "./anchor-resolution.js";
import type { EditItem, EditTarget, FileSnapshot, HashlineEditMetadata } from "./core/types.js";
import type { RepairLoopResult } from "./verification/repair-loop.js";

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
    /** Per-session prior-authority store (tool-owned evidence policy B). When
     *  present, a strong prior authority for a target path is selected before
     *  RPC envelope resolution; missing prior authority for existing files is
     *  rejected with actionable read guidance. */
    readonly getPriorAuthority?: () => PriorAuthorityStore | null;
    /** Per-session AST resolver for target/lineRange scoping. null when
     *  tree-sitter is unavailable. */
    readonly getAstResolver?: () => AstResolverLike | null;
    /** Per-session structural (ast-grep) resolver. Defaults to the real
     *  ast-grep engine when absent. */
    readonly getStructuralResolver?: () => StructuralResolver | null;
    /** Per-session snapshot lookup for hashline oldText reconstruction.
     *  Tool-owned; never exposed in the agent schema. When absent, hashline
     *  fallback cannot reconstruct oldText and falls through to mismatch
     *  rejection (fast path and rebase still work). */
    readonly getSnapshot?: (path: string) => FileSnapshot | null;
    /** Runs the advisory repair loop against the staged candidate.  It never
     * writes itself; accepted repaired content is re-authorized below. */
    readonly runRepair?: (args: { path: string; content: string; cwd: string }) => Promise<RepairLoopResult>;
    /** Runs advisory, filesystem-dependent lanes only after the transaction is
     * committed. It is deliberately not invoked on rollback or rejection. */
    readonly runFinalSuccessLanes?: (args: FinalSuccessInput) => Promise<FinalSuccessResult>;
}

export interface FinalSuccessFile {
    readonly path: string;
    readonly oldContent: string;
    readonly content: string;
    readonly changedLineRanges: ReadonlyArray<LineRange>;
}
export interface FinalSuccessInput {
    readonly cwd: string;
    readonly toolCallId: string;
    readonly files: ReadonlyArray<FinalSuccessFile>;
}
export interface FinalSuccessResult {
    readonly diagnostics?: ReadonlyArray<string>;
    readonly checks?: ReadonlyArray<{ id: string; outcome: CheckOutcome["outcome"]; detail?: string }>;
    readonly evidence?: unknown;
}

export interface VerificationCheck {
    readonly id: string;
    readonly kind: "blocking" | "advisory";
    /** precommit runs before writes; postwrite runs while transaction locks remain held. */
    readonly phase?: "precommit" | "postwrite";
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

/** Shared timeout budget for both the pre-commit and post-write verifier
 *  loops, so a verifier cannot hold the transaction lock (post-write runs
 *  before commit()) or block the write indefinitely (pre-commit). */
const VERIFIER_TIMEOUT_MS = 5000;

/** Runs one verifier against a race with a timeout so a hung verifier can
 *  never block the caller forever. A thrown error that is not the timeout
 *  itself is classified as "fail" (a verifier crash is a hard fail); the
 *  timeout itself is classified as "timeout" so callers can gate on it. */
async function runVerifierCheck(
    v: VerificationCheck,
    ctx: { path: string; content: string; toolCallId: string },
): Promise<{ outcome: CheckOutcome["outcome"]; detail?: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            v.run(ctx),
            new Promise<never>((_r, rej) => {
                timer = setTimeout(() => { rej(new Error("timeout")); }, VERIFIER_TIMEOUT_MS);
            }),
        ]);
        return result.detail === undefined ? { outcome: result.outcome } : { outcome: result.outcome, detail: result.detail };
    } catch (err) {
        const outcome = err instanceof Error && err.message === "timeout" ? "timeout" : "fail";
        const detail = err instanceof Error ? err.message : String(err);
        return { outcome, detail };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// ── Authorization ───────────────────────────────────────────────────

export type AuthorizationResult =
    | { ok: true; resource: InspectedResource }
    | { ok: false; reason: string };

/**
 * Canonical authorization helper — the single source of truth for resource
 * selection, coverage, SHA, and topology policy. `execute()` also calls
 * `authorizeResource` for per-group authorization, keeping both paths
 * structurally unified.
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

    const result = authorizeResource({
        resources: args.envelope.resources,
        canonicalWorkspaceRoot: args.canonicalWorkspaceRoot,
        requestedResourceIds: args.requestedResourceIds,
        targetRanges: args.targetLineRange ? [args.targetLineRange] : [],
    });
    if (!result.ok && result.reason === "missing resource") {
        const missing = args.requestedResourceIds.find((id) => !args.envelope.resources.some((r) => r.resourceId === id));
        return { ok: false, reason: `missing resource: ${missing ?? "unknown"}` };
    }
    return result;
}

// ── Helpers ─────────────────────────────────────────────────────────

function safeReadUtf8(path: string): Promise<string> {
    return fsReadFile(path).then((b) => b.toString("utf8"));
}

function withinRange(target: LineRange, range: LineRange): boolean {
    return target.startLine >= range.startLine && target.endLine <= range.endLine;
}

const SHA256_RE = /^[0-9a-f]{64}$/i;

/** Canonicalize path without ever treating a mutation-time read as authority. */
function canonicalizeContainedPath(root: string, absolutePath: string): { ok: true; path: string; exists: boolean } | { ok: false; error: string } {
    const resolved = pathResolve(absolutePath);
    let existing = resolved;
    while (!existsSync(existing)) {
        const parent = pathDirname(existing);
        if (parent === existing) return { ok: false, error: `path has no canonical parent: ${absolutePath}` };
        existing = parent;
    }
    let canonicalExisting: string;
    try { canonicalExisting = realpathSync(existing); }
    catch (err) { return { ok: false, error: `cannot canonicalize path ${absolutePath}: ${err instanceof Error ? err.message : String(err)}` }; }
    const candidate = existsSync(resolved)
        ? canonicalExisting
        : pathResolve(canonicalExisting, pathRelative(existing, resolved));
    const rel = pathRelative(root, candidate);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
        return { ok: false, error: `path outside canonical workspace root: ${absolutePath}` };
    }
    // Existing symlink targets are represented by canonicalExisting above.
    return { ok: true, path: candidate, exists: existsSync(resolved) };
}

function validateResourceAuthority(resource: InspectedResource, targetRanges: ReadonlyArray<LineRange>, requireFull: boolean): string | null {
    if (resource.coverage !== "full-file" && resource.coverage !== "line-range") return checkResourceCoverage(resource, targetRanges);
    if (requireFull && resource.coverage !== "full-file") return "coverage: full-file evidence required for topology mutation";
    if (typeof resource.fullFileSha256 !== "string" || !SHA256_RE.test(resource.fullFileSha256)) {
        return "coverage: strong evidence is missing a valid fullFileSha256 snapshot SHA-256; read the file again before editing";
    }
    return checkResourceCoverage(resource, targetRanges);
}

/** Canonical resource selection and authorization used by direct and execute paths. */
function authorizeResource(args: {
    resources: ReadonlyArray<InspectedResource>;
    canonicalPath?: string;
    canonicalWorkspaceRoot: string;
    requestedResourceIds?: ReadonlyArray<string>;
    targetRanges: ReadonlyArray<LineRange>;
    requireFull?: boolean;
}): AuthorizationResult {
    const candidates = args.requestedResourceIds
        ? args.requestedResourceIds.map((id) => args.resources.find((r) => r.resourceId === id) ?? null)
        : [...args.resources];
    if (candidates.some((r) => r === null)) return { ok: false, reason: "missing resource" };
    for (const resource of candidates as InspectedResource[]) {
        const rel = pathRelative(args.canonicalWorkspaceRoot, resource.canonicalPath);
        if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
            return { ok: false, reason: "workspace containment: evidence resource is outside canonical workspace root" };
        }
        if (args.canonicalPath !== undefined && resource.canonicalPath !== args.canonicalPath) continue;
        const error = validateResourceAuthority(resource, args.targetRanges, args.requireFull === true);
        if (!error) return { ok: true, resource };
        if (args.canonicalPath !== undefined) return { ok: false, reason: error };
    }
    return { ok: false, reason: "coverage: no requested resource covers the target line range" };
}

/** One coverage policy shared by direct authorization tests and execute(). */
export function checkResourceCoverage(
    resource: InspectedResource,
    targetRanges: ReadonlyArray<LineRange>,
): string | null {
    if (resource.coverage === "search-match" || resource.coverage === "metadata-only") {
        return `coverage: ${resource.coverage} is weak evidence and cannot authorize a patch`;
    }
    if (resource.coverage !== "line-range") return null;
    const uncovered = targetRanges.filter(
        (target) => !resource.allowedRanges.some((allowed) => withinRange(target, allowed)),
    );
    if (uncovered.length === 0) return null;
    const first = uncovered[0];
    return first
        ? `coverage: ${uncovered.length} occurrence(s) outside allowedRanges (e.g. [${first.startLine},${first.endLine}])`
        : `coverage: ${uncovered.length} occurrence(s) outside allowedRanges`;
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

// ── Per-edit grouping ───────────────────────────────────────────────

interface GroupedEdit {
    readonly oldText?: string;
    readonly newText?: string;
    readonly description?: string;
    readonly replaceAll?: boolean;
    readonly target?: EditTarget;
    readonly lineRange?: LineRange;
    readonly hashline?: HashlineEditMetadata;
}

interface EditGroup {
    /** Resolved absolute path (cwd-relative input has been resolved). */
    readonly absolutePath: string;
    /** Original input path string (used for diagnostics). */
    readonly rawPath: string;
    readonly edits: ReadonlyArray<GroupedEdit>;
    readonly topology?: RawTopology;
}

type RawTopology =
    | { kind: "add"; path: string; content: string }
    | { kind: "delete"; path: string }
    | { kind: "rename"; oldPath: string; newPath: string };

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

// ── Auto-inspect envelope construction ──────────────────────────────

async function buildAutoInspectEnvelope(args: {
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

export interface PatchDisplayDiff {
    readonly path: string;
    readonly diff: string;
}

export type PatchToolDetails = PatchDetails & {
    /** Exact classic-text match failure; used only for bounded retry guidance. */
    readonly matchFailure?: "NOT_FOUND" | "AMBIGUOUS";
    readonly diff?: string;
    readonly diffs?: ReadonlyArray<PatchDisplayDiff>;
    /** Advisory repair results for staged candidates, keyed by canonical path. */
    readonly repairs?: Readonly<Record<string, RepairLoopResult>>;
    readonly finalization?: unknown;
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
            "Apply edits to files gated by workspace evidence. Existing files require prior strong read authority; new files may use empty-file semantics. Provide a `path` and a list of `edits`, or a `raw` patch string (mutually exclusive); each edit may carry its own `path`. Freshness and coverage are validated automatically; returns a discriminated lifecycle result (applied | rejected | failed).",
        parameters: EDIT_PARAMETERS as unknown as Record<string, unknown>,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const stream = (text: string) => { onUpdate?.({ content: [{ type: "text", text }] }); };

            // The wire payload from the model never includes toolCallId (Pi
            // supplies it out-of-band as this function's first argument).
            // Inject it before validating so the schema-conforming request
            // the model actually sends can pass validation.
            const v = validateEditRequest({ ...params, toolCallId });
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

            // Raw parsing is pure. All intents enter one transaction lifecycle.
            let requestEdits: ReadonlyArray<EditOperation> = v.value.edits ?? [];
            let rawTopology: RawTopology[] = [];
            const rawWarnings: string[] = [];
            if (v.value.raw !== undefined) {
                const normalized = normalizeRawEdit(v.value.raw, v.value.path);
                rawWarnings.push(...normalized.warnings);
                if (normalized.diagnostics.length > 0 || normalized.intents.length === 0) {
                    const diagnostics = [
                        ...rawWarnings,
                        ...normalized.diagnostics,
                        "Raw patch parsed into no executable update operations.",
                    ];
                    return {
                        content: [{ type: "text" as const, text: "failed: raw patch parsing" }],
                        details: makeFailed(toolCallId, "stage", "raw patch normalization failed", {
                            inspectionId: requestEvidenceRef?.inspectionId ?? "",
                            resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [],
                        }, freshChecks(), diagnostics),
                    };
                }
                rawTopology = normalized.intents.flatMap((intent): RawTopology[] => {
                    if (intent.kind === "text") return [];
                    return intent.kind === "rename"
                        ? [{ kind: "rename", oldPath: intent.oldPath, newPath: intent.newPath }]
                        : [intent];
                });
                requestEdits = normalized.intents.flatMap((intent) => intent.kind === "text" ? [intent.operation] : []);
            }

            // Split transfer (copy/move) ops out of the plain-edit path so
            // groupEditsByPath's existing behavior for text/symbolic/structural/
            // hashline edits stays byte-for-byte unchanged. Raw patches never
            // produce `op`, so this is a no-op split when v.value.raw was used.
            const transferOps = requestEdits.filter((e) => e.op !== undefined);
            const textOps = requestEdits.filter((e) => e.op === undefined);

            // Group edits by file path (per-edit path overrides top-level).
            // v.value.path may be undefined when every edit supplies its own
            // path (validator enforces this invariant).
            const grouping = groupEditsByPath(ctx.cwd, v.value.path ?? "", textOps);
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
            // Include topology source/destination paths in evidence and transaction plan.
            // A second topology op targeting the same absolutePath as a group
            // that already carries a topology is a hard conflict (e.g. delete
            // old.ts, then rename old.ts -> moved.ts, in the same call):
            // silently letting the later op overwrite the earlier one drops
            // caller intent without telling them. Collect every such conflict
            // and reject the whole batch atomically — before any lock is
            // acquired or file touched — rather than attempt a full ordered
            // multi-op-per-path execution engine.
            const topologyConflicts: Array<{ path: string; existingKind: string; newKind: string }> = [];
            for (const op of rawTopology) {
                const entries = op.kind === "rename" ? [[op.oldPath, op], [op.newPath, undefined]] : [[op.path, op]];
                for (const [rawPath, topology] of entries as Array<[string, RawTopology | undefined]>) {
                    const absolutePath = pathResolve(ctx.cwd, rawPath);
                    const existingIdx = groups.findIndex((g) => g.absolutePath === absolutePath);
                    if (existingIdx >= 0) {
                        const existingTopology = groups[existingIdx].topology;
                        if (topology) {
                            if (existingTopology) {
                                topologyConflicts.push({ path: rawPath, existingKind: existingTopology.kind, newKind: topology.kind });
                            } else {
                                // Replace immutably, preserving the group's existing fields.
                                groups[existingIdx] = { ...groups[existingIdx], topology };
                            }
                        } else if (existingTopology && op.kind === "rename") {
                            // Rename destination conflicts with existing group's topology
                            topologyConflicts.push({ path: rawPath, existingKind: existingTopology.kind, newKind: op.kind });
                        }
                    } else groups.push({ absolutePath, rawPath, edits: [], ...(topology ? { topology } : {}) });
                }
            }
            if (topologyConflicts.length > 0) {
                const message = topologyConflicts
                    .map((c) => `conflicting topology operations for path '${c.path}': ${c.existingKind} vs ${c.newKind}`)
                    .join("; ");
                return {
                    content: [{ type: "text" as const, text: `rejected: ${message}` }],
                    details: makeRejected(toolCallId, "conflict", [message], {
                        inspectionId: requestEvidenceRef?.inspectionId ?? "",
                        resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [],
                    }, freshChecks()),
                };
            }
            const checks: MutableChecks = freshChecks();
            const diagnostics: string[] = [...rawWarnings];
            const usedEvidence: string[] = [];

            const totalEdits = groups.reduce((sum, g) => sum + g.edits.length, 0);
            const fileWord = groups.length === 1 ? "file" : "files";
            const editWord = totalEdits === 1 ? "edit" : "edits";
            stream(`patch — ${totalEdits} ${editWord} across ${groups.length} ${fileWord}`);

            // ── Transfer (copy/move) ops: resolve from/to canonical paths ──
            // Both files must already exist (no create-via-transfer in v1).
            // Reserve a bucket in `groups` for the `to` path (and, for `move`,
            // the `from` path too) so evidence resolution and the transaction
            // path list cover them — mirrors the rename-destination placeholder
            // pattern above. `copy`'s source deliberately does NOT get a group
            // (it produces no mutation; authorized separately below).
            const resolvedTransfers: Array<{
                op: "copy" | "move";
                canonicalFrom: string;
                canonicalTo: string;
                range: { pos: string; end: string };
                after: string | undefined;
                rawFrom: string;
                rawTo: string;
                toIsNewFile: boolean;
            }> = [];
            // Transfer destinations that don't exist yet: allowed to be created
            // by the transfer (the append_file / EOF branch), authorized the
            // same way as an oldText:"" new-file group.
            const transferNewFileCanonicals = new Set<string>();
            // `copy`'s source deliberately does not get a `groups` bucket (no
            // mutation happens there), but its content must still be snapshotted
            // by the transaction for resolveSourceRange/staleness to read it.
            const copySourceOnlyPaths = new Set<string>();
            for (const transferOp of transferOps) {
                const op = transferOp.op as "copy" | "move";
                const rawFrom = transferOp.from as string;
                const rawTo = transferOp.to as string;
                const range = transferOp.range as { pos: string; end: string };
                const after = transferOp.after as string | undefined;

                let canonicalFrom: string;
                try {
                    canonicalFrom = realpathSync(pathResolve(ctx.cwd, rawFrom));
                } catch (err) {
                    const message = `transfer source not found: ${rawFrom} (${err instanceof Error ? err.message : String(err)})`;
                    return {
                        content: [{ type: "text" as const, text: `rejected: ${message}` }],
                        details: makeRejected(toolCallId, "coverage", [message], {
                            inspectionId: requestEvidenceRef?.inspectionId ?? "",
                            resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [],
                        }, checks),
                    };
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
                        return {
                            content: [{ type: "text" as const, text: `rejected: ${message}` }],
                            details: makeRejected(toolCallId, "coverage", [message], {
                                inspectionId: requestEvidenceRef?.inspectionId ?? "",
                                resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [],
                            }, checks),
                        };
                    }
                }
                if (toIsNewFile) transferNewFileCanonicals.add(canonicalTo);

                resolvedTransfers.push({ op, canonicalFrom, canonicalTo, range, after, rawFrom, rawTo, toIsNewFile });

                const buckets: Array<[string, string]> = op === "move"
                    ? [[canonicalTo, rawTo], [canonicalFrom, rawFrom]]
                    : [[canonicalTo, rawTo]];
                for (const [absolutePath, rawPath] of buckets) {
                    if (!groups.some((g) => g.absolutePath === absolutePath)) {
                        groups.push({ absolutePath, rawPath, edits: [] });
                    }
                }
                if (op === "copy") copySourceOnlyPaths.add(canonicalFrom);
            }

            // Every mutation and transfer endpoint must resolve inside the
            // canonical workspace. Existing symlinks are checked by realpath;
            // absent paths are checked through their existing parent.
            const containmentPaths = new Set<string>();
            for (const g of groups) containmentPaths.add(g.absolutePath);
            for (const op of rawTopology) {
                containmentPaths.add(pathResolve(ctx.cwd, op.kind === "rename" ? op.oldPath : op.path));
                if (op.kind === "rename") containmentPaths.add(pathResolve(ctx.cwd, op.newPath));
            }
            for (const op of transferOps) {
                containmentPaths.add(pathResolve(ctx.cwd, op.from as string));
                containmentPaths.add(pathResolve(ctx.cwd, op.to as string));
            }
            for (const candidate of containmentPaths) {
                const contained = canonicalizeContainedPath(canonicalRoot, candidate);
                if (!contained.ok) {
                    diagnostics.push(contained.error);
                    return {
                        content: [{ type: "text" as const, text: `rejected: ${contained.error}` }],
                        details: makeRejected(toolCallId, "coverage", diagnostics, { inspectionId: "", resourceIds: [] }, checks, usedEvidence),
                    };
                }
            }

            // ── Acquire envelope ──────────────────────────────────────
            // Tool-owned evidence policy B: existing targets require strong
            // prior authority. Mutation-time reads can check freshness only;
            // they never mint authority.

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
                // Every group has a strong prior authority; no envelope needed.
                evidenceRefForDetails = { inspectionId: "", resourceIds: [] };
            } else if (!requestEvidenceRef) {
                const existingWithoutPrior = groupsNeedingEnvelope.filter((g) => existsSync(g.absolutePath));
                if (existingWithoutPrior.length > 0) {
                    const message = `no prior strong read authority for ${existingWithoutPrior.map((g) => g.rawPath).join(", ")}; read the file first (full file or target range), then retry`;
                    diagnostics.push(message);
                    return {
                        content: [{ type: "text" as const, text: `rejected: coverage (${message})` }],
                        details: makeRejected(toolCallId, "coverage", diagnostics, { inspectionId: "", resourceIds: [] }, checks),
                    };
                }
                // Explicit empty-file semantics remain valid for genuinely new
                // in-root files; synthesize authority only for those paths.
                const built = await buildAutoInspectEnvelope({
                    sessionFilePath,
                    canonicalRoot,
                    groups: groupsNeedingEnvelope,
                    newFileAllowed: transferNewFileCanonicals,
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

            // Verify session/workspace binding on the envelope (only when an
            // envelope was acquired; prior authority was already validated at
            // record time).
            if (envelope) {
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
            }

            // ── Per-group application ────────────────────────────────
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
            // One canonicalization for transaction planning and every mutation:
            // new files keep their raw resolved path (no on-disk file to
            // realpath), existing files resolve symlinks — so every path passed
            // to EditTransaction.before() was included during begin().
            const canonicalTxPath = (absolutePath: string): string => {
                if (newFileCanonicals.has(absolutePath)) return absolutePath;
                try {
                    return realpathSync(absolutePath);
                } catch {
                    return absolutePath;
                }
            };
            const transactionPaths = [...new Set([
                ...groups.map((group) => canonicalTxPath(group.absolutePath)),
                ...copySourceOnlyPaths,
            ])];
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
                    content: [{ type: "text" as const, text: `failed: begin transaction (${msg})` }],
                    details: finalize(makeFailed(toolCallId, "stage", `failed to begin transaction: ${msg}`, {
                        inspectionId: evidenceRefForDetails.inspectionId,
                        resourceIds: [],
                    }, checks, diagnostics, usedEvidence, invalidations)),
                };
            }
            let committed = false;
            let rollbackInfo: { ok: boolean; reason?: string } | undefined;

            try {
            // ── Resolve transfer (copy/move) ops against the pre-transaction
            // snapshot, then fill in the reserved groups' edits with the
            // synthesized hashline EditItems. Runs before the main per-group
            // loop (which then treats these exactly like any other hashline
            // group) and inside this try so an early rejection here still
            // triggers the finally-block rollback below.
            for (const rt of resolvedTransfers) {
                const snapshot = transaction.getSnapshot(rt.canonicalFrom);
                if (!snapshot || !snapshot.exists) {
                    diagnostics.push(`transfer source does not exist: ${rt.rawFrom}`);
                    return {
                        content: [{ type: "text" as const, text: `failed: transfer source does not exist: ${rt.rawFrom}` }],
                        details: finalize(makeFailed(toolCallId, "stage", `transfer source does not exist: ${rt.rawFrom}`, evidenceRefForDetails, checks, diagnostics, usedEvidence, invalidations)),
                    };
                }
                const rawSourceContent = snapshot.content ? snapshot.content.toString("utf8") : "";
                const { text: strippedSource } = stripBom(rawSourceContent);
                const sourceContent = normalizeToLF(strippedSource);

                const resolved = resolveSourceRange(sourceContent, rt.range.pos, rt.range.end);
                if (!resolved.ok) {
                    diagnostics.push(`transfer: ${resolved.error} (${rt.rawFrom})`);
                    return {
                        content: [{ type: "text" as const, text: `failed: transfer range resolution (${rt.rawFrom})` }],
                        details: finalize(makeFailed(toolCallId, "stage", `${resolved.error} (${rt.rawFrom})`, evidenceRefForDetails, checks, diagnostics, usedEvidence, invalidations)),
                    };
                }

                if (rt.op === "copy") {
                    // `move`'s source becomes a real deletion group below and is
                    // authorized through the main loop's existing per-group
                    // pipeline; `copy` produces no mutation at the source, so it
                    // never becomes a group and needs this standalone check.
                    let sourceResource: InspectedResource | null = null;
                    let usedPriorSourceAuthority = false;
                    if (priorStore) {
                        sourceResource = priorStore.select(rt.canonicalFrom);
                        usedPriorSourceAuthority = sourceResource !== null;
                    }
                    if (!sourceResource && envelope) {
                        sourceResource = findResourceForCanonicalPath(envelope, rt.canonicalFrom, evidenceRefForDetails.resourceIds);
                    }
                    if (!sourceResource) {
                        diagnostics.push(`coverage: no authority for copy source ${rt.rawFrom}`);
                        return {
                            content: [{ type: "text" as const, text: `rejected: coverage (copy source ${rt.rawFrom})` }],
                            details: finalize(makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations)),
                        };
                    }
                    const coverageError = validateResourceAuthority(sourceResource, [{ startLine: resolved.value.startLine, endLine: resolved.value.endLine }], false);
                    if (coverageError) {
                        diagnostics.push(`${coverageError} for copy source ${rt.rawFrom}`);
                        return {
                            content: [{ type: "text" as const, text: `rejected: coverage (copy source ${rt.rawFrom})` }],
                            details: finalize(makeRejected(toolCallId, "coverage", diagnostics, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [sourceResource.resourceId],
                            }, checks, usedEvidence, invalidations)),
                        };
                    }
                    if (typeof sourceResource.fullFileSha256 !== "string" || !SHA256_RE.test(sourceResource.fullFileSha256)) {
                        diagnostics.push(`coverage: missing or malformed fullFileSha256 for ${rt.rawFrom}; read the source file again before copying`);
                        return {
                            content: [{ type: "text" as const, text: `rejected: coverage (missing valid snapshot SHA for copy source ${rt.rawFrom})` }],
                            details: finalize(makeRejected(toolCallId, "coverage", diagnostics, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [sourceResource.resourceId],
                            }, checks, usedEvidence, invalidations)),
                        };
                    }
                    if (sourceResource.fullFileSha256 !== sha256OfString(sourceContent)) {
                        diagnostics.push(`stale: copy source ${rt.rawFrom} sha mismatch`);
                        return {
                            content: [{ type: "text" as const, text: `rejected: stale (copy source ${rt.rawFrom})` }],
                            details: finalize(makeRejected(toolCallId, "stale", diagnostics, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [sourceResource.resourceId],
                            }, checks, usedEvidence, invalidations)),
                        };
                    }
                }

                if (!rt.toIsNewFile && rt.after === undefined) {
                    const message = `transfer destination ${rt.rawTo} already exists; \`after\` is required to choose an insertion point`;
                    diagnostics.push(message);
                    return {
                        content: [{ type: "text" as const, text: `rejected: ${message}` }],
                        details: finalize(makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations)),
                    };
                }

                const description = `${rt.op} from ${rt.rawFrom}:${rt.range.pos}-${rt.range.end}`;
                const toIdx = groups.findIndex((g) => g.absolutePath === rt.canonicalTo);
                groups[toIdx] = { ...groups[toIdx], edits: [...groups[toIdx].edits, buildTransferInsertEdit(rt.toIsNewFile ? undefined : rt.after, resolved.value.lines, description)] };

                if (rt.op === "move") {
                    const fromIdx = groups.findIndex((g) => g.absolutePath === rt.canonicalFrom);
                    groups[fromIdx] = { ...groups[fromIdx], edits: [...groups[fromIdx].edits, buildTransferDeleteEdit(rt.range, description)] };
                }
            }

            for (const group of groups) {
                // Skip bookkeeping placeholders (e.g. rename destination paths) that have
                // no text edits and no topology — nothing to apply.
                if (group.edits.length === 0 && !group.topology) continue;

                stream(`  ${group.rawPath} — ${group.edits.length} edit(s)`);

                // Resolve canonical path for this group.
                let canonicalTarget: string;
                let isNewFileGroup = false;
                // Display/applied path for this group; reassigned to the new
                // path after a successful rename so downstream diffs, applied
                // lists, and finalization all reference where the file now
                // lives (the old path no longer exists once renamed).
                let displayPath: string = group.rawPath;
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

                // Select authority: a strong prior authority wins; otherwise
                // fall back to the envelope resource. A selected prior grant is
                // never overridden by caller evidenceRef and never falls back to
                // full-file auto-inspection.
                let resource: InspectedResource | null = null;
                let usedPriorAuthority = false;
                if (priorStore && !isNewFileGroup) {
                    resource = priorStore.select(canonicalTarget);
                    usedPriorAuthority = resource !== null;
                }
                if (!resource) {
                    if (!envelope) {
                        diagnostics.push(`coverage: no prior authority and no envelope for ${canonicalTarget}`);
                        return {
                            content: [{ type: "text" as const, text: `rejected: coverage (no authority for ${group.rawPath})` }],
                            details: finalize(makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations)),
                        };
                    }
                    resource = findResourceForCanonicalPath(
                        envelope,
                        canonicalTarget,
                        evidenceRefForDetails.resourceIds,
                    );
                }
                if (!resource) {
                    diagnostics.push(`coverage: no resource in envelope for ${canonicalTarget}`);
                    return {
                        content: [{ type: "text" as const, text: `rejected: coverage (no resource for ${group.rawPath})` }],
                        details: finalize(makeRejected(toolCallId, "coverage", diagnostics, evidenceRefForDetails, checks, usedEvidence, invalidations)),
                    };
                }
                const requiresFullEvidence = group.topology?.kind === "delete" || group.topology?.kind === "rename";
                const authorization = authorizeResource({
                    resources: [resource],
                    canonicalPath: canonicalTarget,
                    canonicalWorkspaceRoot: canonicalRoot,
                    requestedResourceIds: [resource.resourceId],
                    targetRanges: [],
                    requireFull: requiresFullEvidence,
                });
                if (!authorization.ok) {
                    const initialCoverageError = authorization.reason;
                    diagnostics.push(`${initialCoverageError} for ${canonicalTarget} (path-mode inspect this file first)`);
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

                // Freshness check. A selected prior line-range authority REQUIRES
                // a freshness hash; missing SHA rejects rather than silently
                // skipping freshness. A selected prior grant never falls back to
                // full-file auto-inspection on staleness.
                if (typeof resource.fullFileSha256 !== "string" || !SHA256_RE.test(resource.fullFileSha256)) {
                    diagnostics.push(`coverage: missing or malformed fullFileSha256 for ${canonicalTarget}; read the file again before editing`);
                    return {
                        content: [{ type: "text" as const, text: `rejected: coverage (missing valid snapshot SHA for ${group.rawPath})` }],
                        details: finalize(makeRejected(toolCallId, "coverage", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations)),
                    };
                }
                if (resource.fullFileSha256 !== currentSha) {
                    diagnostics.push(`stale: current sha ${currentSha} != attested ${resource.fullFileSha256} for ${canonicalTarget}`);
                    return {
                        content: [{ type: "text" as const, text: `rejected: stale (${group.rawPath})` }],
                        details: finalize(makeRejected(toolCallId, "stale", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations)),
                    };
                }

                const hasTextEdits = group.edits.length > 0;

                // Reject patches combining text edits with delete topology.
                if (hasTextEdits && group.topology?.kind === "delete") {
                    diagnostics.push(`text edits combined with delete topology for ${group.rawPath}: cannot edit and delete the same file in one group`);
                    return {
                        content: [{ type: "text" as const, text: `rejected: conflicting operations (${group.rawPath})` }],
                        details: finalize(makeRejected(toolCallId, "conflict", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations)),
                    };
                }

                // DELETE: there is no post-edit content to lint/typecheck.
                // Perform the delete through the shared transaction, invalidate
                // the resource, emit a diff entry, and count it in the applied
                // total/changedResources — but skip evidence/diagnostics
                // generation for this path (the reviewer's carved-out exception:
                // add/rename flow through the full pipeline below, delete does
                // not).
                if (!hasTextEdits && group.topology?.kind === "delete") {
                    // Advisory risk-warning check for topology-only delete
                    // (path warnings). Non-blocking — delete proceeds regardless.
                    const safetyResult = await checkEditSafety(canonicalTarget, [], undefined, []);
                    if (safetyResult.warnings.length > 0) {
                        for (const w of safetyResult.warnings) {
                            checks.advisory.push(makeCheck("risk-warning", "pass", w));
                        }
                    }
                    try {
                        await transaction.remove(canonicalTxPath(group.absolutePath));
                    } catch (err) {
                        // Return a write-phase failure so the outer finally still
                        // runs the transaction rollback for any earlier mutations.
                        diagnostics.push(`topology delete failed: ${err instanceof Error ? err.message : String(err)}`);
                        return {
                            content: [{ type: "text" as const, text: `failed: delete ${group.rawPath}` }],
                            details: finalize(makeFailed(toolCallId, "write", `delete failed: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations)),
                        };
                    }
                    invalidations.push({
                        resourceId: resource.resourceId,
                        canonicalPath: resource.canonicalPath,
                        fullFileSha256: currentSha,
                        coverage: resource.coverage,
                    });
                    const generatedDiff = generateDiffString(currentContent, "").diff;
                    displayDiffs.push({ path: displayPath, diff: generatedDiff });
                    appliedFiles.push(displayPath);
                    appliedCanonical.push(canonicalTarget);
                    appliedSummaries.push(`delete of ${displayPath}`);
                    stream(`  ✓ deleted ${displayPath}`);
                    continue;
                }

                // Stage edits through the planner (no writes). The planner routes
                // text edits through applyEdits (fuzzy tiers, replaceAll, AST/lineRange
                // scopes, literal $ replacement) and returns actual resolved spans.
                // ADD and topology-only RENAME groups skip the planner — their
                // content is already fully determined — but still flow through
                // the exact same write/verify/evidence/finalization machinery
                // below as a text edit would, rather than an early-exit
                // shortcut that bypasses the compiler/LSP/post-edit pipeline.
                let newContent: string;
                let preimageLineRanges: ReadonlyArray<LineRange> = [];
                let postimageLineRanges: ReadonlyArray<LineRange> = [];
                if (!hasTextEdits && group.topology?.kind === "add") {
                    newContent = group.topology.content;
                    postimageLineRanges = [{ startLine: 1, endLine: Math.max(1, newContent.split("\n").length) }];
                } else if (!hasTextEdits && group.topology?.kind === "rename") {
                    // Content is unchanged; the rename itself happens further
                    // below (after post-write verify), which reassigns
                    // canonicalTarget/displayPath to the new path before any
                    // evidence/finalization records anything against it.
                    newContent = currentContent;
                } else if (isNewFileGroup && group.edits.every((e) => typeof e.oldText === "string")) {
                    // New-file creation via oldText:"": the empty oldText is implicit
                    // at offset 0 of the (empty) current content. applyEdits rejects
                    // empty oldText, so this path stays separate. A new-file group
                    // built from a transfer op carries a hashline (append_file) edit
                    // instead, which falls through to the planTextEdits branch below
                    // (it operates on `currentContent` generically and needs no
                    // special-casing for an empty starting file).
                    newContent = currentContent;
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
                        if (!newContent.includes(edit.oldText)) {
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
                            // slice-based: safe against $-pattern interpretation in edit.newText
                            const idx = newContent.indexOf(edit.oldText);
                            if (idx >= 0) {
                                newContent = newContent.slice(0, idx) + edit.newText + newContent.slice(idx + edit.oldText.length);
                            }
                        }
                    }
                    preimageLineRanges = [{ startLine: 1, endLine: 1 }];
                    postimageLineRanges = [{ startLine: 1, endLine: Math.max(1, newContent.split("\n").length) }];
                } else {
                    try {
                        const planned = await planTextEdits({
                            content: currentContent,
                            edits: group.edits as EditItem[],
                            filePath: canonicalTarget,
                            astResolver: deps.getAstResolver?.() ?? null,
                            structuralResolver: deps.getStructuralResolver?.() ?? null,
                            getSnapshot: deps.getSnapshot ?? (() => null),
                        });
                        newContent = planned.newContent;
                        preimageLineRanges = planned.preimageLineRanges;
                        postimageLineRanges = planned.postimageLineRanges;
                        for (const note of planned.matchNotes) diagnostics.push(note);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        diagnostics.push(msg);
                        const matchCode = err instanceof MatchError ? err.code : null;
                        const message = matchCode === "NOT_FOUND"
                            ? `failed: target not found in ${group.rawPath}; re-inspect the file and retry with current exact text`
                            : matchCode === "AMBIGUOUS"
                                ? `failed: ambiguous edit in ${group.rawPath}; provide more surrounding context, add target/lineRange scope, or use replaceAll`
                                : `failed: edit (${group.rawPath})`;
                        return {
                            content: [{ type: "text" as const, text: message }],
                            details: finalize({
                                ...makeFailed(toolCallId, "stage", `edit planning failed: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations),
                                ...(matchCode === "NOT_FOUND" || matchCode === "AMBIGUOUS" ? { matchFailure: matchCode } : {}),
                            }),
                        };
                    }
                }

                // Authorize using ACTUAL resolved spans (not an exact oldText
                // lookup), so fuzzy/scoped matches authorize correctly and cannot
                // escape prior line-range authority. For replaceAll, every actual
                // span is authorized.
                const coverageError = checkResourceCoverage(resource, preimageLineRanges);
                if (coverageError) {
                    diagnostics.push(`${coverageError} for ${canonicalTarget}`);
                    if (usedPriorAuthority) {
                        diagnostics.push(`coverage: prior authority is line-range for ${canonicalTarget}; a fresh full-file read is required to widen authority`);
                    }
                    return {
                        content: [{ type: "text" as const, text: `rejected: coverage (${group.rawPath})` }],
                        details: finalize(makeRejected(toolCallId, "coverage", diagnostics, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, usedEvidence, invalidations)),
                    };
                }

                // Repair is evaluated only against the in-memory candidate.
                // A successful repair is still an untrusted new mutation: compute
                // its changed preimage range and require the same evidence
                // authority before it can reach a write.
                const repairRunner = deps.runRepair;
                const repair = repairRunner
                    ? await repairRunner({ path: canonicalTarget, content: newContent, cwd: ctx.cwd }).catch((err: unknown): RepairLoopResult => ({
                    passed: false,
                    attempts: [],
                    finalValidation: null,
                    summary: `repair unavailable: ${err instanceof Error ? err.message : String(err)}`,
                    repairedContent: null,
                    }))
                    : null;
                if (repair) {
                repairsByPath.set(canonicalTarget, repair);
                if (repair.repairedContent && repair.repairedContent !== newContent) {
                    const repairRanges = changedLineRanges(newContent, repair.repairedContent);
                    // Repair ranges are computed in staged (post-edit) coordinates,
                    // so they cannot be compared against the resource's pre-edit
                    // allowedRanges. Map each repair span back to original
                    // coordinates via the edit mapping, then require it to stay
                    // within the edit's already-authorized preimage footprint.
                    // Full-file grants accept any in-file repair; a repair that
                    // cannot be re-authorized is skipped.
                    const confinedToPreimage =
                        resource.coverage === "full-file" ||
                        (repairRanges.length > 0 &&
                            repairRanges.every((r) => {
                                const mapped = mapRepairSpanToPreimage(r, preimageLineRanges, postimageLineRanges);
                                return mapped !== null &&
                                    preimageLineRanges.some((p) => mapped.startLine >= p.startLine && mapped.endLine <= p.endLine);
                            }));
                    if (confinedToPreimage) {
                        newContent = repair.repairedContent;
                        diagnostics.push(`repair: accepted staged repair for ${canonicalTarget}`);
                        checks.advisory.push(makeCheck(`repair:${group.rawPath}`, "pass", repair.summary));
                    } else {
                        diagnostics.push(`repair: skipped for ${canonicalTarget}; repaired content exceeded the edit's authorized preimage range`);
                        checks.advisory.push(makeCheck(`repair:${group.rawPath}`, "skipped", "repaired content exceeded existing evidence authority"));
                    }
                } else if (!repair.passed) {
                    checks.advisory.push(makeCheck(`repair:${group.rawPath}`, "skipped", repair.summary));
                }
                }

                // Run allowlisted checks (per file). Postwrite-phase checks run
                // only after the write (below); running them here would observe
                // the pre-write content and mis-record them.
                const verifiers = deps.getVerificationChecks?.() ?? [];
                for (const v of verifiers.filter((candidate) => candidate.phase !== "postwrite")) {
                    // Only the racing timer maps to "timeout". A blocking
                    // verifier that throws for any other reason is treated
                    // as a hard fail so the gate below actually blocks the
                    // write.
                    const { outcome, detail } = await runVerifierCheck(v, { path: canonicalTarget, content: newContent, toolCallId });
                    const check = makeCheck(`${v.id}:${group.rawPath}`, outcome, detail);
                    checks.completed.push(check);
                    if (outcome === "timeout") {
                        // A timed-out BLOCKING verifier must still be visible to
                        // the gate below (it also stays in timedOut for
                        // observability) — a timeout is not merely advisory, it
                        // must block the write exactly like an outright failure.
                        checks.timedOut.push(check);
                        if (v.kind === "blocking") checks.blocking.push(check);
                    } else if (v.kind === "blocking") {
                        checks.blocking.push(check);
                    } else {
                        checks.advisory.push(check);
                    }
                }

                // A failing (or timed-out) blocking check must prevent the
                // write — recording it in checks.blocking is not itself a gate.
                const failedBlocking = checks.blocking.find((c) => c.outcome === "fail" || c.outcome === "timeout");
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

                // Advisory risk-warning check (non-blocking, warnings only).
                // Runs before write to catch dangerous patterns in edit content
                // and paths. Topology-only groups (add/delete/rename) still run
                // path risk warnings; add-file content is scanned too.
                const safetyEdits: readonly EditItem[] = group.edits;
                const safetyExtraContent: string[] =
                  group.topology?.kind === "add" && typeof group.topology.content === "string"
                    ? [group.topology.content]
                    : [];
                const safetyResult = await checkEditSafety(canonicalTarget, safetyEdits, undefined, safetyExtraContent);
                if (safetyResult.warnings.length > 0) {
                    // Surface warnings as advisory check records
                    for (const w of safetyResult.warnings) {
                        checks.advisory.push(makeCheck("risk-warning", "pass", w));
                    }
                }

                // Atomic write. Skipped when content is unchanged (a
                // topology-only rename with no text edits) — there is nothing
                // new to persist at canonicalTarget before the rename below
                // moves the file to its destination. New files are always written
                // even if empty.
                try {
                    if (newContent !== currentContent || isNewFileGroup) {
                        // Ensure parent directory exists before atomic write
                        await fsMkdir(pathDirname(canonicalTarget), { recursive: true });
                        await transaction.write(canonicalTarget, newContent);
                    }
                } catch (err) {
                    diagnostics.push(`write failed: ${err instanceof Error ? err.message : String(err)}`);
                    const rollback = await transaction.rollback();
                    rollbackInfo = buildRollbackInfo(transaction.transactionId, rollback);
                    committed = true;
                    return {
                        content: [{ type: "text" as const, text: `failed: write ${group.rawPath}` }],
                        details: finalize(makeFailed(toolCallId, "write", `write failed: ${group.rawPath}`, {
                            inspectionId: evidenceRefForDetails.inspectionId,
                            resourceIds: [resource.resourceId],
                        }, checks, diagnostics, usedEvidence, invalidations, rollbackInfo)),
                    };
                }

                // Fix #3: record the invalidation right after the write, before
                // post-write verify. This way, every later failure path
                // (including post-write read/hash failures) reports the file
                // as actually changed on disk.
                const newSha = sha256OfString(newContent);
                const pendingInvalidation: ResourceInvalidation = {
                    resourceId: resource.resourceId,
                    canonicalPath: resource.canonicalPath,
                    fullFileSha256: currentSha,
                    // A rename removes this source path; its destination gets a
                    // separate post-rename invalidation below.
                    ...(group.topology?.kind === "rename" ? {} : { newFullFileSha256: newSha }),
                    coverage: resource.coverage,
                };
                invalidations.push(pendingInvalidation);

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

                // Post-write checks execute under transaction lock (this runs
                // before commit()); blocking failure rolls back. Wrapped in the
                // same timeout mechanism as the pre-commit loop so a hung
                // post-write verifier cannot hold the transaction lock forever
                // — a timeout here is treated exactly like a blocking failure.
                for (const v of verifiers.filter((candidate) => candidate.phase === "postwrite")) {
                    const { outcome, detail } = await runVerifierCheck(v, { path: canonicalTarget, content: postContent, toolCallId });
                    const check = makeCheck(`${v.id}:${group.rawPath}`, outcome, detail);
                    checks.completed.push(check);
                    if (v.kind === "advisory") checks.advisory.push(check);
                    else checks.blocking.push(check);
                    if (v.kind === "blocking" && (outcome === "fail" || outcome === "timeout")) {
                        diagnostics.push(`blocking post-write check failed: ${check.id}`);
                        return {
                            content: [{ type: "text" as const, text: `failed: post-write check (${group.rawPath})` }],
                            details: finalize(makeFailed(toolCallId, "verify", `blocking post-write check failed: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations)),
                        };
                    }
                }

                if (group.topology?.kind === "rename") {
                    try {
                        await transaction.rename(
                            canonicalTxPath(pathResolve(ctx.cwd, group.topology.oldPath)),
                            canonicalTxPath(pathResolve(ctx.cwd, group.topology.newPath)),
                        );
                    } catch (err) {
                        diagnostics.push(`rename failed: ${err instanceof Error ? err.message : String(err)}`);
                        return {
                            content: [{ type: "text" as const, text: `failed: rename ${group.rawPath}` }],
                            details: finalize(makeFailed(toolCallId, "write", `rename failed: ${group.rawPath}`, {
                                inspectionId: evidenceRefForDetails.inspectionId,
                                resourceIds: [resource.resourceId],
                            }, checks, diagnostics, usedEvidence, invalidations)),
                        };
                    }
                    // The old path no longer exists on disk. Every downstream
                    // use — post-edit evidence, finalizedFiles (and therefore
                    // the LSP/compiler finalization lanes), the displayed diff
                    // path, and the applied-file lists — must reference the
                    // file at its NEW location, not the deleted old path.
                    const renamedAbsolute = pathResolve(ctx.cwd, group.topology.newPath);
                    try {
                        canonicalTarget = realpathSync(renamedAbsolute);
                    } catch {
                        canonicalTarget = renamedAbsolute;
                    }
                    displayPath = group.topology.newPath;
                    // SmartRead consumes changedResources as the authoritative
                    // cache/LSP invalidation protocol. Both rename endpoints may
                    // have prior cached state, so report destination explicitly.
                    invalidations.push({
                        resourceId: resource.resourceId,
                        canonicalPath: canonicalTarget,
                        fullFileSha256: currentSha,
                        newFullFileSha256: postSha,
                        coverage: resource.coverage,
                    });
                }

                const newLines = postContent.split("\n");
                const postEditEvidence: PostEditEvidence = {
                    fullFileSha256: postSha,
                    lineCount: newLines.length,
                    byteLength: Buffer.byteLength(postContent, "utf8"),
                };
                postEditEvidenceByPath.set(canonicalTarget, postEditEvidence);
                finalizedFiles.push({
                    path: canonicalTarget,
                    oldContent: currentContent,
                    content: postContent,
                    // Postimage ranges: paired with post-edit `postContent` so
                    // downstream consumers (index.ts's lineRangeToOffsets) scope
                    // diagnostics/evidence against the same coordinate space as
                    // the content itself, not the pre-edit line numbering.
                    changedLineRanges: postimageLineRanges,
                });
                const generatedDiff = generateDiffString(currentContent, postContent).diff;
                displayDiffs.push({ path: displayPath, diff: generatedDiff });
                appliedFiles.push(displayPath);
                appliedCanonical.push(canonicalTarget);
                appliedSummaries.push(
                    !hasTextEdits && group.topology?.kind === "add" ? `add of ${displayPath}`
                        : !hasTextEdits && group.topology?.kind === "rename" ? `rename of ${group.rawPath} to ${displayPath}`
                            : `${group.edits.length} edit(s) to ${displayPath}`,
                );
                stream(`  ✓ wrote ${displayPath}`);
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
            await transaction.commit();
            committed = true;
            try {
                await saveTransactionUndoRecords(ctx.cwd, undoRecords);
            } catch (err) {
                // Undo persistence is best-effort and must never turn a durable
                // applied result into a failure.
                diagnostics.push(`undo persistence failed after commit: ${err instanceof Error ? err.message : String(err)}`);
            }
            } finally {
                if (!committed) {
                    const rollback = await transaction.rollback();
                    rollbackInfo = buildRollbackInfo(transaction.transactionId, rollback);
                    const failedRollbackPaths = new Set(rollback.failed);
                    invalidations.splice(
                        0,
                        invalidations.length,
                        ...invalidations.filter((invalidation) => failedRollbackPaths.has(invalidation.canonicalPath)),
                    );
                    diagnostics.push(`rollback: restored ${rollback.restored.length} path(s)`);
                    if (rollback.failed.length > 0) diagnostics.push(`rollback failed: ${rollback.failed.join(", ")}`);
                }
            }

            // Final-only lanes must observe committed state. They remain
            // advisory: a diagnostic or bridge failure cannot turn a durable
            // transaction into a reported rollback.
            let finalization: unknown;
            if (deps.runFinalSuccessLanes && finalizedFiles.length > 0) {
                try {
                    const result = await deps.runFinalSuccessLanes({ cwd: ctx.cwd, toolCallId, files: finalizedFiles });
                    finalization = result.evidence;
                    diagnostics.push(...(result.diagnostics ?? []));
                    for (const lane of result.checks ?? []) {
                        const check = makeCheck(lane.id, lane.outcome, lane.detail);
                        checks.advisory.push(check);
                        checks.completed.push(check);
                    }
                } catch (err) {
                    const detail = err instanceof Error ? err.message : String(err);
                    diagnostics.push(`finalization: ${detail}`);
                    const check = makeCheck("finalization", "skipped", detail);
                    checks.advisory.push(check);
                    checks.completed.push(check);
                }
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
            // Post evidence is keyed by canonical target, not the caller's raw
            // path. Use the per-applied canonical target so a symlinked or
            // topology path resolves to its real file's evidence.
            const lastCanonical = appliedCanonical.at(-1) ?? "";
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
                repairs: Object.fromEntries(repairsByPath),
                finalization,
                rollback: rollbackInfo,
            };
            // Built from appliedSummaries (recorded per applied group at the
            // point it was applied) rather than indexing groups[0], which does
            // not necessarily correspond to appliedFiles[0] and previously
            // reported "applied 0 edit(s)" for a topology-only group.
            const summary = appliedSummaries.length === 1
                ? `applied ${appliedSummaries[0]}`
                : `applied: ${appliedSummaries.join("; ")}`;
            // Diagnostics were already collected into `details.diagnostics` by
            // runFinalSuccessLanes above; without this, they were only visible
            // via `details` (not shown to the model) — surface a bounded copy
            // in `content` too, advisory-only, without changing pass/fail.
            const diagnosticsBlock = formatBoundedDiagnostics(diagnostics);
            return {
                content: appendDiagnosticsToContent(
                    [{ type: "text" as const, text: summary }],
                    diagnosticsBlock,
                ) as { type: "text"; text: string }[],
                details,
            };
        },
    };
}

/**
 * Conservative line coverage for an arbitrary repaired candidate.  We use
 * the smallest contiguous preimage range containing the textual delta; this
 * can reject a repair that a finer diff could allow, but can never widen a
 * line-range grant.
 */
/**
 * Map a line span from staged (post-edit) coordinates back to the original
 * file's coordinates using the planner's preimage/postimage ranges. Lines
 * outside edited regions map 1:1 with the accumulated line-count delta;
 * lines inside an edited region map to that region's preimage start. Returns
 * null when the mapping cannot be established (no or mismatched planner
 * ranges) so the caller skips the repair rather than mis-authorizing it.
 */
function mapRepairSpanToPreimage(
    span: LineRange,
    preimage: ReadonlyArray<LineRange>,
    postimage: ReadonlyArray<LineRange>,
): LineRange | null {
    if (preimage.length === 0 || preimage.length !== postimage.length) return null;
    const mapLine = (line: number): number => {
        let shift = 0;
        for (let i = 0; i < postimage.length; i++) {
            const post = postimage[i];
            const pre = preimage[i];
            if (line >= post.startLine && line <= post.endLine) return pre.startLine;
            if (line > post.endLine) shift += (pre.endLine - pre.startLine) - (post.endLine - post.startLine);
        }
        return line + shift;
    };
    return { startLine: mapLine(span.startLine), endLine: mapLine(span.endLine) };
}

function changedLineRanges(before: string, after: string): ReadonlyArray<LineRange> {
    if (before === after) return [];
    let prefix = 0;
    const shared = Math.min(before.length, after.length);
    while (prefix < shared && before[prefix] === after[prefix]) prefix++;
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
        beforeEnd--;
        afterEnd--;
    }
    const startLine = before.slice(0, prefix).split("\n").length;
    const endLine = Math.max(startLine, before.slice(0, beforeEnd).split("\n").length);
    return [{ startLine, endLine }];
}

// ── helpers ──

function buildRollbackInfo(transactionId: string, outcome: { attempted: string[]; ok: string[]; restored: string[]; failed: string[] }): { ok: boolean; reason?: string } {
    const success = outcome.failed.length === 0;
    if (success) {
        const reason = `transaction ${transactionId}: restored ${outcome.restored.length}/${outcome.attempted.length} path(s)`;
        return { ok: true, reason };
    } else {
        const reason = `transaction ${transactionId}: rollback failed for ${outcome.failed.join(", ")}`;
        return { ok: false, reason };
    }
}

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
        usedEvidence,
        changedResources,
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
    rollback?: { ok: boolean; reason?: string },
): PatchDetails {
    return {
        tool: "patch",
        status: { kind: "failed", phase },
        toolCallId,
        evidenceRef,
        usedEvidence,
        changedResources,
        checks: freezeChecks(checks),
        diagnostics,
        error: message,
        ...(rollback ? { rollback } : {}),
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
