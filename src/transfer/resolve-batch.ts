/** Transfer batch resolution — transfer-domain owned. Maps validated
 *  `TransferRequest`s to canonical source/destination paths (reserving
 *  destination groups in place) without touching edit-request shapes.
 *  The transfer frontend's peer lowering into kernel operations starts here.
 *
 *  Must NOT add path-containment gates.
 */
import { resolve as pathResolve, dirname, basename, join as pathJoin } from "node:path";
import { realpathSync } from "node:fs";
import type { EvidenceRef } from "@rhinos0608/pi-workspace-protocol";
import type { MutableChecks, MutationGroup, MutationResult } from "../mutation/types.js";
import { makeRejected } from "../patch/result-builders.js";
import type { TransferRequest } from "./contract.js";

export interface ResolvedTransferBatch {
    op: "copy" | "move";
    canonicalFrom: string;
    canonicalTo: string;
    range: { pos: string; end: string };
    after: string | undefined;
    rawFrom: string;
    rawTo: string;
    toIsNewFile: boolean;
    description: string | undefined;
}

export function resolveTransferBatch(args: {
    transfers: ReadonlyArray<TransferRequest>;
    groups: MutationGroup[];
    ctx: { cwd: string };
    toolCallId: string;
    requestEvidenceRef: EvidenceRef | undefined;
    checks: MutableChecks;
}): { ok: true; resolvedTransfers: ResolvedTransferBatch[] } | { ok: false; result: MutationResult } {
    const { transfers, groups, ctx, toolCallId, requestEvidenceRef, checks } = args;
    const resolvedTransfers: ResolvedTransferBatch[] = [];
    for (const transferReq of transfers) {
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
            return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${message}` }], details: makeRejected(toolCallId, "coverage", [message], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, checks, [], [], "transfer") } };
        }
        let canonicalTo: string;
        let toIsNewFile = false;
        try {
            canonicalTo = realpathSync(pathResolve(ctx.cwd, rawTo));
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                const absTo = pathResolve(ctx.cwd, rawTo);
                try {
                    canonicalTo = pathJoin(realpathSync(dirname(absTo)), basename(absTo));
                } catch {
                    canonicalTo = absTo;
                }
                toIsNewFile = true;
            } else {
                const message = `transfer destination not found: ${rawTo} (${err instanceof Error ? err.message : String(err)})`;
                return { ok: false, result: { content: [{ type: "text" as const, text: `rejected: ${message}` }], details: makeRejected(toolCallId, "coverage", [message], { inspectionId: requestEvidenceRef?.inspectionId ?? "", resourceIds: requestEvidenceRef ? [...requestEvidenceRef.resourceIds] : [] }, checks, [], [], "transfer") } };
            }
        }
        const description = transferReq.description;
        resolvedTransfers.push({ op, canonicalFrom, canonicalTo, range, after, rawFrom, rawTo, toIsNewFile, description });
        const buckets: Array<[string, string]> = op === "move" ? [[canonicalTo, rawTo], [canonicalFrom, rawFrom]] : [[canonicalTo, rawTo]];
        for (const [absolutePath, rawPath] of buckets) {
            if (!groups.some((g) => g.absolutePath === absolutePath)) groups.push({ absolutePath, rawPath, edits: [] });
        }
    }
    return { ok: true, resolvedTransfers };
}

