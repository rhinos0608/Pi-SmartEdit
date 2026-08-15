/**
 * Per-session prior-authority store (tool-owned evidence policy B).
 *
 * The agent-visible `edit` schema omits `evidenceRef`; authority is owned by
 * the tool. This store ingests validated SmartRead `details.workspaceEvidence`
 * envelopes as they arrive on `tool_result` events and indexes the strongest
 * accumulated resource per canonical path. Weak evidence (search-match,
 * metadata-only) never authorizes a patch.
 *
 * Evidence for the SAME unchanged file content accumulates: a newer line-range
 * resource is unioned with an existing line-range resource, and never narrows
 * an existing full-file grant, as long as both attest the same fullFileSha256
 * (proof they describe the same on-disk content). This lets an agent read a
 * file in several windows across a session and still edit anywhere it has
 * actually seen, instead of the newest windowed read silently discarding
 * everything read earlier. Only a genuine content change — a differing (or
 * missing) fullFileSha256 — causes newer evidence to replace older evidence
 * outright, since stale ranges from a since-modified file cannot be trusted.
 * The store is per-session and cleared on session lifecycle.
 */
import { hashSessionFilePath, validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import type { InspectedResource, LineRange } from "@rhinos0608/pi-workspace-protocol";

/** Per-session latest-strong prior authority tracking. */
export interface PriorAuthorityStore {
    /**
     * Validate and index a workspace-evidence envelope. Invalid envelopes,
     * session/root mismatches, and weak-coverage resources are ignored.
     * Strong resources are indexed by canonical path: evidence for the same
     * attested file content (matching fullFileSha256) accumulates rather
     * than being replaced; evidence for different (or unattested) content
     * replaces the prior entry outright.
     */
    record(envelope: unknown): void;
    /** Latest strong prior authority for a canonical path, or null. */
    select(canonicalPath: string): InspectedResource | null;
    /** Clear all indexed authority (session lifecycle). */
    clear(): void;
}

/** Merge overlapping/adjacent 1-based line ranges into their minimal disjoint form. */
function mergeLineRanges(ranges: ReadonlyArray<LineRange>): LineRange[] {
    if (ranges.length <= 1) return ranges.map((r) => ({ ...r }));
    const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
    const out: Array<{ startLine: number; endLine: number }> = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r.startLine <= last.endLine + 1) {
            last.endLine = Math.max(last.endLine, r.endLine);
        } else {
            out.push({ ...r });
        }
    }
    return out;
}

export function createPriorAuthorityStore(args: {
    sessionFilePath: string;
    canonicalWorkspaceRoot: string;
}): PriorAuthorityStore {
    const expectedSessionId = hashSessionFilePath(args.sessionFilePath);
    const byPath = new Map<string, InspectedResource>();

    return {
        record(envelope: unknown) {
            const validated = validateInspectionEnvelope(envelope);
            if (!validated.ok) return; // invalid envelope ignored
            const env = validated.value;
            if (env.sessionId !== expectedSessionId) return; // session mismatch ignored
            if (env.canonicalWorkspaceRoot !== args.canonicalWorkspaceRoot) return; // root mismatch ignored
            for (const r of env.resources) {
                // Explicit allowlist: only full-file and line-range evidence are
                // strong enough to authorize a patch. Any other coverage value
                // (search-match, metadata-only, or a future protocol value) is
                // treated as weak and ignored rather than implicitly authorized.
                if (r.coverage !== "full-file" && r.coverage !== "line-range") continue;
                // Snapshot validated data so later mutation of a tool-result object
                // cannot mutate authority after validation.
                const snapshot: InspectedResource = {
                    ...r,
                    allowedRanges: r.allowedRanges.map((range) => ({ ...range })),
                };

                const existing = byPath.get(snapshot.canonicalPath);
                const sameFileContent =
                    existing !== undefined &&
                    typeof existing.fullFileSha256 === "string" &&
                    typeof snapshot.fullFileSha256 === "string" &&
                    existing.fullFileSha256 === snapshot.fullFileSha256;

                if (!existing || !sameFileContent) {
                    // No prior grant, or the file content changed (or either
                    // side lacks a hash to compare) — the older evidence
                    // cannot be trusted to still describe current content.
                    // Newest wins outright.
                    byPath.set(snapshot.canonicalPath, snapshot);
                } else if (existing.coverage === "full-file") {
                    // Already fully authorized for this unchanged content; a
                    // subsequent windowed read must not narrow it.
                } else if (snapshot.coverage === "full-file") {
                    // A fresh full-file read always widens (or re-affirms)
                    // authority to the entire unchanged file.
                    byPath.set(snapshot.canonicalPath, snapshot);
                } else {
                    // Both are line-range reads of the same unchanged file:
                    // accumulate everything actually read this session.
                    byPath.set(snapshot.canonicalPath, {
                        ...snapshot,
                        allowedRanges: mergeLineRanges([...existing.allowedRanges, ...snapshot.allowedRanges]),
                    });
                }
            }
        },
        select(canonicalPath: string) {
            return byPath.get(canonicalPath) ?? null;
        },
        clear() {
            byPath.clear();
        },
    };
}
