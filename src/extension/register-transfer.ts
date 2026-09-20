import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
    createRpcClient,
    RPC_CHANNELS,
} from "@rhinos0608/pi-workspace-protocol";
import { getSnapshot } from "../context/read-cache.js";
import { runRepairLoop } from "../verification/repair-loop.js";
import { appendDiagnosticsToContent } from "../mutation/post-mutation.js";
import type { PatchToolDeps } from "../patch.js";
import { createTransferTool } from "../transfer/tool.js";
import { EditTextComponent, renderEditDiff } from "./render.js";
import {
    runSingleFileFinalLanes,
    recordFileCoChanges,
} from "./final-lanes.js";
import type { SessionState } from "./session.js";

export function getTransferDisplayPaths(args: unknown): string[] {
    if (!args || typeof args !== "object") return [];
    const transfers = (args as { transfers?: unknown }).transfers;
    if (!Array.isArray(transfers)) return [];
    const paths: string[] = [];
    for (const t of transfers) {
        if (!t || typeof t !== "object") continue;
        const from = (t as { from?: unknown }).from;
        const to = (t as { to?: unknown }).to;
        if (typeof from === "string" && from.length > 0) paths.push(from);
        if (typeof to === "string" && to.length > 0) paths.push(to);
    }
    return [...new Set(paths)];
}

export function renderTransferCall(args: unknown, theme: Theme): unknown {
    const paths = getTransferDisplayPaths(args);
    const transfers = (args as { transfers?: unknown[] }).transfers;
    const count = Array.isArray(transfers) ? transfers.length : 0;
    const noun = count === 1 ? "transfer" : "transfers";
    const pathText = paths.length > 0
        ? theme.fg("accent", paths.join(", "))
        : theme.fg("error", "missing paths");
    return new EditTextComponent(`${theme.fg("toolTitle", theme.bold("transfer"))} ${count} ${noun} ${pathText}`);
}

export function renderTransferResult(
    result: { content: Array<{ type: string; text?: string }>; details?: { diffs?: Array<{ path?: unknown; diff?: unknown }>; diff?: unknown } },
    options: { isPartial: boolean },
    theme: Theme,
): unknown {
    if (options.isPartial) {
        return new EditTextComponent(theme.fg("warning", "Transferring..."), 1);
    }
    const diffs = result.details?.diffs?.filter(
        (entry) => typeof entry.path === "string" && typeof entry.diff === "string" && (entry.diff as string).length > 0,
    ) as Array<{ path: string; diff: string }> | undefined;
    if (diffs && diffs.length > 0) {
        const output = diffs.length === 1
            ? renderEditDiff(diffs[0].diff, theme)
            : diffs
                .map((entry) => `${theme.fg("accent", entry.path)}\n${renderEditDiff(entry.diff, theme)}`)
                .join("\n\n");
        return new EditTextComponent(output, 1);
    }
    if (typeof result.details?.diff === "string" && (result.details.diff as string).length > 0) {
        return new EditTextComponent(renderEditDiff(result.details.diff as string, theme), 1);
    }
    const text = result.content
        .filter((entry) => entry.type === "text" && typeof entry.text === "string")
        .map((entry) => entry.text as string)
        .join("\n")
        .split("\n")
        .slice(0, 5)
        .join("\n");
    return new EditTextComponent(theme.fg("success", text || "transfer complete"), 1);
}

/** `transfer` tool registration — peer of `registerEditTool`, same kernel. */
export function registerTransferTool(pi: ExtensionAPI, session: SessionState): void {
    if (pi.events && typeof pi.events.on === "function") {
        const bus = pi.events as {
            emit: (c: string, d: unknown) => void;
            on: (c: string, h: (d: unknown) => void) => () => void;
        };
        const transferDeps: PatchToolDeps = {
            getBus: () => bus,
            getRpcClient: () => createRpcClient({ bus, channel: RPC_CHANNELS.inspectPatch, timeoutMs: 2000 }),
            getSessionFilePath: () => session.currentSessionFilePath,
            getCanonicalWorkspaceRoot: () => session.currentCanonicalWorkspaceRoot ?? "",
            getPriorAuthority: () => session.priorAuthorityStore,
            getAstResolver: () => session.astResolver,
            getSnapshot: (path) => (session.currentCwd ? getSnapshot(path, session.currentCwd) : null),
            runRepair: ({ path, content, cwd }) => runRepairLoop(path, content, { maxRetries: 1 }, cwd),
            runFinalSuccessLanes: async ({ cwd, files }) => {
                const diagnostics: string[] = [];
                const checks: Array<{ id: string; outcome: "pass" | "fail" | "skipped" | "timeout"; detail?: string }> = [];
                const evidence: unknown[] = [];
                for (const file of files) {
                    await runSingleFileFinalLanes(file, {
                        cwd, diagnostics, checks, evidence,
                        editedPaths: files.map((entry) => entry.path),
                        lspManager: session.lspManager, diagnosticsClient: session.smartReadDiagnosticsClient,
                    });
                }
                recordFileCoChanges(files, cwd, diagnostics);
                return { diagnostics, checks, evidence };
            },
        };
        const transferTool = createTransferTool(transferDeps);
        (pi.registerTool as (t: unknown) => void)({
            ...transferTool,
            renderShell: "self",
            renderCall: renderTransferCall,
            renderResult: renderTransferResult,
            async execute(
                toolCallId: string,
                params: Record<string, unknown>,
                signal: AbortSignal | undefined,
                onUpdate: ((u: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
                ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown },
            ) {
                const { evidenceRef: _ignored, ...toolOwnedArgs } = params;
                const result = await transferTool.execute(
                    toolCallId,
                    toolOwnedArgs,
                    signal,
                    onUpdate,
                    ctx,
                );
                const reason = result.details?.status?.kind === "rejected" ? result.details.status.reason : undefined;
                const note = reason === "stale"
                    ? "\n\nNot applied: source changed since last read. Read the source file again, then retry the transfer."
                    : reason === "coverage"
                        ? "\n\nNot applied: required read authority was unavailable. Read the source and destination files, then retry."
                        : reason === "conflict"
                            ? "\n\nNot applied: conflicting transfer. Adjust the source range or destination anchor, then retry."
                            : "";
                return note
                    ? { ...result, content: appendDiagnosticsToContent(result.content, note) as typeof result.content }
                    : result;
            },
        } as unknown);
    }
}
