/**
 * Per-session prior-authority store (tool-owned evidence policy B).
 *
 * The agent-visible `edit` schema omits `evidenceRef`; authority is owned by
 * the tool. This store ingests validated SmartRead `details.workspaceEvidence`
 * envelopes as they arrive on `tool_result` events and indexes the latest
 * STRONG resource per canonical path. Weak evidence (search-match,
 * metadata-only) never authorizes a patch.
 *
 * Arrival order is the authority order: a newer line-range resource supersedes
 * an older full-file resource for the same canonical path, and a later full-file
 * read widens authority again. The store is per-session and cleared on session
 * lifecycle.
 */
import { hashSessionFilePath, validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import type { InspectedResource } from "@rhinos0608/pi-workspace-protocol";

/** Per-session latest-strong prior authority tracking. */
export interface PriorAuthorityStore {
    /**
     * Validate and index a workspace-evidence envelope. Invalid envelopes,
     * session/root mismatches, and weak-coverage resources are ignored. Strong
     * resources are indexed by canonical path; the last recorded strong
     * resource for a path wins (arrival order).
     */
    record(envelope: unknown): void;
    /** Latest strong prior authority for a canonical path, or null. */
    select(canonicalPath: string): InspectedResource | null;
    /** Clear all indexed authority (session lifecycle). */
    clear(): void;
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
                // Latest strong wins by arrival order (newer line-range supersedes
                // older full-file; later full-file widens again).
                byPath.set(snapshot.canonicalPath, snapshot);
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
