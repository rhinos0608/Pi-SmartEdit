/**
 * Evidence authorization — resource selection, coverage validation, SHA-shape
 * validation, and requested-resource lookup for the patch tool.
 *
 * Extracted verbatim from src/patch.ts (Seam1). Rule order and message text
 * are preserved exactly: sessionId → canonicalWorkspaceRoot → resource-ID →
 * coverage → fullFileSha256. No cwd containment is added here — workspace
 * scoping is an evidence-trust boundary only, never a mutation gate.
 */
import {
    hashSessionFilePath,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
    type LineRange,
} from "@rhinos0608/pi-workspace-protocol";

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

function withinRange(target: LineRange, range: LineRange): boolean {
    return target.startLine >= range.startLine && target.endLine <= range.endLine;
}

export const SHA256_RE = /^[0-9a-f]{64}$/i;

export function isValidFullFileSha256(value: unknown): value is string {
    return typeof value === "string" && SHA256_RE.test(value);
}

export function validateResourceAuthority(resource: InspectedResource, targetRanges: ReadonlyArray<LineRange>, requireFull: boolean): string | null {
    if (resource.coverage !== "full-file" && resource.coverage !== "line-range") return checkResourceCoverage(resource, targetRanges);
    if (requireFull && resource.coverage !== "full-file") return "coverage: full-file evidence required for topology mutation";
    if (typeof resource.fullFileSha256 !== "string" || !SHA256_RE.test(resource.fullFileSha256)) {
        return "coverage: strong evidence is missing a valid fullFileSha256 snapshot SHA-256; read the file again before editing";
    }
    return checkResourceCoverage(resource, targetRanges);
}

/** Canonical resource selection and authorization used by direct and execute paths. */
export function authorizeResource(args: {
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

export function findResourceForCanonicalPath(
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
