/**
 * Patch result builders — check accumulation, verifier execution, and
 * rejected/failed result construction. Pure logic: no fs, no RPC, no
 * transaction. Moved verbatim from src/patch.ts (MS2 of patch.ts split).
 */
import type {
    MutationDetails,
    EvidenceRef,
    CheckRecord,
    ResourceInvalidation,
} from "@rhinos0608/pi-workspace-protocol";
import type { MutationToolIdentity } from "../mutation/types.js";
import type {
    MutableChecks,
    VerificationCheck,
    CheckOutcome,
    PatchResult,
} from "./types.js";
import { VERIFIER_TIMEOUT_MS } from "./types.js";

export function freshChecks(): MutableChecks {
    return { blocking: [], completed: [], advisory: [], skipped: [], timedOut: [] };
}

export function makeCheck(id: string, outcome: "pass" | "fail" | "skipped" | "timeout", detail?: string): CheckRecord {
    return detail === undefined ? { id, outcome } : { id, outcome, detail };
}

export function freezeChecks(c: MutableChecks): MutationDetails["checks"] {
    return {
        blocking: c.blocking.slice(),
        completed: c.completed.slice(),
        advisory: c.advisory.slice(),
        skipped: c.skipped.slice(),
        timedOut: c.timedOut.slice(),
    };
}

/** Runs one verifier against a race with a timeout so a hung verifier can
 *  never block the caller forever. A thrown error that is not the timeout
 *  itself is classified as "fail" (a verifier crash is a hard fail); the
 *  timeout itself is classified as "timeout" so callers can gate on it. */
export async function runVerifierCheck(
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

export function failResult(toolCallId: string, text: string, message: string, reasons: string[], phase: "stage" | "write" = "stage"): PatchResult {
    return {
        content: [{ type: "text" as const, text }],
        details: makeFailed(toolCallId, phase, message, { inspectionId: "", resourceIds: [] }, freshChecks(), reasons),
    };
}

export function buildRollbackInfo(transactionId: string, outcome: { attempted: string[]; ok: string[]; restored: string[]; failed: string[] }): { ok: boolean; reason?: string } {
    const success = outcome.failed.length === 0;
    if (success) {
        const reason = `transaction ${transactionId}: restored ${outcome.restored.length}/${outcome.attempted.length} path(s)`;
        return { ok: true, reason };
    } else {
        const reason = `transaction ${transactionId}: rollback failed for ${outcome.failed.join(", ")}`;
        return { ok: false, reason };
    }
}

export function makeRejected(
    toolCallId: string,
    reason: "stale" | "coverage" | "conflict" | "approval" | "session",
    diagnostics: string[],
    evidenceRef: EvidenceRef,
    checks: MutableChecks,
    usedEvidence: ReadonlyArray<string> = [],
    changedResources: ReadonlyArray<ResourceInvalidation> = [],
    tool: MutationToolIdentity = "edit",
): MutationDetails {
    return {
        tool,
        status: { kind: "rejected", reason },
        toolCallId,
        evidenceRef,
        usedEvidence,
        changedResources,
        checks: freezeChecks(checks),
        diagnostics,
    };
}

export function makeFailed(
    toolCallId: string,
    phase: "stage" | "write" | "verify",
    message: string,
    evidenceRef: EvidenceRef,
    checks: MutableChecks,
    diagnostics: string[],
    usedEvidence: ReadonlyArray<string> = [],
    changedResources: ReadonlyArray<ResourceInvalidation> = [],
    rollback?: { ok: boolean; reason?: string },
    tool: MutationToolIdentity = "edit",
): MutationDetails {
    return {
        tool,
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

export function classifyRpcError(msg: string | undefined): "stale" | "coverage" | "conflict" | "approval" | "session" {
    if (!msg) return "session";
    if (/coverage/i.test(msg)) return "coverage";
    if (/unknown inspectionId|not in tool result/i.test(msg)) return "coverage";
    if (/stale/i.test(msg)) return "stale";
    if (/conflict|duplicate/i.test(msg)) return "conflict";
    return "session";
}
