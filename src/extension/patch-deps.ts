import { createRpcClient, RPC_CHANNELS } from "@rhinos0608/pi-workspace-protocol";

import { getSnapshot } from "../context/read-cache.js";
import { runRepairLoop } from "../verification/repair-loop.js";
import type { PatchToolDeps } from "../patch.js";
import { getActiveEditMode } from "../edit-modes/index.js";
import { runSingleFileFinalLanes, recordFileCoChanges } from "./final-lanes.js";
import type { SessionState } from "./session.js";

export type PatchBus = {
  emit: (c: string, d: unknown) => void;
  on: (c: string, h: (d: unknown) => void) => () => void;
};

/**
 * Session-bound PatchToolDeps shared by the `edit` tool and the
 * workspace-edit RPC server. Single builder so both frontends run the same
 * repair/final-lane pipeline against the same session state.
 */
export function buildPatchToolDeps(
  session: SessionState,
  bus: PatchBus,
  overrides?: Partial<PatchToolDeps>,
): PatchToolDeps {
  return {
    editMode: getActiveEditMode(),
    getBus: () => bus,
    getRpcClient: () => createRpcClient({ bus, channel: RPC_CHANNELS.inspectPatch, timeoutMs: 2000 }),
    getSessionFilePath: () => session.currentSessionFilePath,
    getCanonicalWorkspaceRoot: () => session.currentCanonicalWorkspaceRoot ?? "",
    getPriorAuthority: () => session.priorAuthorityStore,
    getAstResolver: () => session.astResolver,
    getSnapshot: (path) => (session.currentCwd ? getSnapshot(path, session.currentCwd) : null),
    // The coordinator owns acceptance and evidence reauthorization; the
    // extension only supplies the session-bound repair implementation.
    //
    // maxRetries is capped at 1 here (runRepairLoop's own default is 3).
    // runRepairLoop only advances its staged content when a repair attempt
    // actually passes validation — and when that happens it breaks out of
    // the loop immediately. So whenever the first attempt fails and the
    // narrow auto-repair heuristics (brace/bracket balance, indentation,
    // trailing whitespace, blank lines) don't fix it, every subsequent
    // retry re-validates byte-identical content and is guaranteed to
    // reach the same pass/fail outcome — it cannot converge differently.
    // Each retry still pays for a full runAutoValidation pass (a real
    // tsc/eslint subprocess spawn apiece), so the default of 3 retries
    // means up to 3x redundant compiler/linter spawns, synchronously,
    // before the edit is even written. Repair is advisory-only (failures
    // never block the write — see repair-loop.ts), so capping retries at
    // 1 does not change what gets accepted or what content lands on disk;
    // it only removes provably-wasted synchronous spawns on the hot path.
    runRepair: ({ path, content, cwd }) => runRepairLoop(path, content, { maxRetries: 1 }, cwd),
    // These lanes are invoked by patch only after a successful commit.  The
    // extension supplies session-owned LSP state; the coordinator owns the
    // ordering and result assembly.
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
    ...overrides,
  };
}
