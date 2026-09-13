import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { realpathSync, statSync } from "fs";
import { readFile as fsReadFile } from "fs/promises";
import { resolve, relative } from "path";

import { createAstResolver } from "../ast/ast-resolver";
import { LSPManager } from "../lsp/lsp-manager";
import { createSmartReadDiagnosticsClient } from "../lsp/smartread-diagnostics-client.js";
import { resetRetryCounts } from "../verification/auto-validate";
import { createPriorAuthorityStore, type PriorAuthorityStore } from "../context/evidence-authority.js";
import {
  PROTOCOL_SCHEMA_VERSION,
  hashSessionFilePath,
  inspectionIdFor,
  resourceIdFor,
  sha256OfString,
  type WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";

/** Per-session module singletons, consolidated from index.ts (M7). */
export type SessionState = {
  astResolver: ReturnType<typeof createAstResolver> | null;
  lspManager: LSPManager | null;
  smartReadDiagnosticsClient: ReturnType<typeof createSmartReadDiagnosticsClient> | null;
  priorAuthorityStore: PriorAuthorityStore | null;
  currentSessionFilePath: string | null;
  currentCanonicalWorkspaceRoot: string | null;
  currentCwd: string | null;
};

export function createSessionState(): SessionState {
  return {
    astResolver: null,
    lspManager: null,
    smartReadDiagnosticsClient: null,
    priorAuthorityStore: null,
    currentSessionFilePath: null,
    currentCanonicalWorkspaceRoot: null,
    currentCwd: null,
  };
}

/** session_start body, moved verbatim (mutates state). */
export async function initSessionState(state: SessionState, pi: ExtensionAPI, ctx: unknown): Promise<void> {
  const sessionCwd = process.cwd();
  state.currentCwd = sessionCwd;
  // Create AST resolver (returns null if Tree-sitter unavailable)
  state.astResolver = createAstResolver();

  // Create LSP manager for semantic intelligence
  state.lspManager = new LSPManager(sessionCwd);
  // Create SmartRead diagnostics client (lazy probe, sticky mode)
  if (pi.events && typeof (pi.events as { on?: unknown }).on === "function") {
    const b = pi.events as { emit: (c: string, d: unknown) => void; on: (c: string, h: (d: unknown) => void) => () => void };
    state.smartReadDiagnosticsClient = createSmartReadDiagnosticsClient(b);
  }

  resetRetryCounts();

  // Capture the real session file path and canonical workspace root.
  // We require a REAL (non-ephemeral) session file for `patch` authorization.
  try {
    const sm = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined)
      ?.sessionManager;
    const p = typeof sm?.getSessionFile === "function" ? sm.getSessionFile() : undefined;
    state.currentSessionFilePath = typeof p === "string" && p.length > 0 ? p : null;
  } catch {
    state.currentSessionFilePath = null;
  }
  try {
    // canonical workspace root = realpath of cwd, no trailing slash
    const { realpathSync } = await import("node:fs");
    let r = realpathSync(sessionCwd);
    if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
    state.currentCanonicalWorkspaceRoot = r;
  } catch {
    state.currentCanonicalWorkspaceRoot = null;
  }

  // Create the per-session prior-authority store bound to this session.
  state.priorAuthorityStore = createPriorAuthorityStore({
    sessionFilePath: state.currentSessionFilePath ?? "",
    canonicalWorkspaceRoot: state.currentCanonicalWorkspaceRoot ?? "",
  });
}

/** session_shutdown body, moved verbatim (mutates state). */
export async function shutdownSessionState(state: SessionState): Promise<void> {
  state.smartReadDiagnosticsClient?.dispose();
  state.smartReadDiagnosticsClient = null;
  await state.lspManager?.shutdown();
  state.lspManager = null;
  state.priorAuthorityStore?.clear();
  state.priorAuthorityStore = null;
}

export async function buildMutationEvidence(
  state: SessionState,
  paths: string[],
): Promise<WorkspaceEvidenceEnvelope | undefined> {
  if (!state.currentSessionFilePath || !state.currentCanonicalWorkspaceRoot) return undefined;
  const resources: Array<WorkspaceEvidenceEnvelope["resources"][number]> = [];
  for (const path of [...new Set(paths)]) {
    try {
      const resolvedPath = resolve(state.currentCwd ?? process.cwd(), path);
      const canonicalPath = realpathSync(resolvedPath);
      // Evidence-provenance containment: only mint evidence for paths inside the canonical workspace root.
      // Mutations to outside paths still succeed — they simply get no workspaceEvidence.
      // Use path.relative for containment: root "/" must still match /tmp/x.ts, and
      // /workspace-evil must NOT match root /workspace. relative() returns "" for
      // identity, a bare name for children, or "../.." for outside — only reject the last.
      if (relative(state.currentCanonicalWorkspaceRoot, canonicalPath).startsWith("..")) continue;
      if (!statSync(canonicalPath).isFile()) continue;
      const content = (await fsReadFile(canonicalPath)).toString("utf8");
      const lineCount = content.split("\n").length;
      resources.push({
        resourceId: resourceIdFor({ canonicalPath, kind: "full" }),
        canonicalPath,
        kind: "full",
        coverage: "full-file",
        allowedRanges: [{ startLine: 1, endLine: lineCount }],
        fullFileSha256: sha256OfString(content),
        fresh: true,
        byteLength: Buffer.byteLength(content, "utf8"),
        lineCount,
      });
    } catch {
      // Evidence is advisory; unreadable or deleted paths are omitted.
    }
  }
  if (resources.length === 0) return undefined;
  const sessionId = hashSessionFilePath(state.currentSessionFilePath);
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    inspectionId: inspectionIdFor({
      sessionId,
      workspaceRoot: state.currentCanonicalWorkspaceRoot,
      resources: resources.map((resource) => ({ canonicalPath: resource.canonicalPath })),
    }),
    sessionId,
    workspaceRoot: state.currentCanonicalWorkspaceRoot,
    canonicalWorkspaceRoot: state.currentCanonicalWorkspaceRoot,
    createdAt: new Date().toISOString(),
    resources,
    mode: "path",
  };
}
