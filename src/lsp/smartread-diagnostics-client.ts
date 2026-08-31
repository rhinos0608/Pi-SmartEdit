import { realpathSync } from "fs";
import { resolve } from "path";
import {
  createRpcClient,
  RPC_CHANNELS,
  LANGUAGE_INTELLIGENCE_RPC_METHODS,
  sha256OfString,
  validateLanguageIntelligenceCapabilitiesResponse,
  validateCheckPostEditDiagnosticsResponse,
  type CheckPostEditDiagnosticsRequest,
} from "@rhinos0608/pi-workspace-protocol";
import { checkPostEditDiagnostics as checkLocal } from "./diagnostics.js";
import type { Diagnostic, DiagnosticResult } from "./diagnostics.js";
import type { LSPManager } from "./lsp-manager.js";

type BusLike = {
  emit: (c: string, d: unknown) => void;
  on: (c: string, h: (d: unknown) => void) => () => void;
};

type Mode = "remote" | "standalone";

export interface SmartReadDiagnosticsClient {
  checkPostEditDiagnostics(
    filePath: string,
    content: string,
    languageId: string,
    root: string,
    lspManagerForFallback: LSPManager,
  ): Promise<DiagnosticResult>;
  dispose(): void;
  reset(): void;
}

function tryCanonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function mapDiagnostics(remote: readonly Diagnostic[]): Diagnostic[] {
  return remote.map((d) => ({
    message: d.message,
    severity: d.severity,
    range: { start: { line: d.range.start.line, character: d.range.start.character }, end: { line: d.range.end.line, character: d.range.end.character } },
    ...(d.source !== undefined ? { source: d.source } : {}),
  }));
}

export function createSmartReadDiagnosticsClient(bus: BusLike): SmartReadDiagnosticsClient {
  let mode: Mode | null = null;
  let probePromise: Promise<Mode> | null = null;
  let remoteClient: ReturnType<typeof createRpcClient> | null = null;

  function getRemoteClient(): ReturnType<typeof createRpcClient> {
    if (!remoteClient) {
      remoteClient = createRpcClient({ bus, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 5000 });
    }
    return remoteClient;
  }

  async function doProbe(): Promise<Mode> {
    const probeClient = createRpcClient({ bus, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 250 });
    try {
      const reply = await probeClient.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.capabilities, {});
      if (!reply.ok || reply.payload === undefined) return "standalone";
      const v = validateLanguageIntelligenceCapabilitiesResponse(reply.payload);
      if (!v.ok) return "standalone";
      if (Array.isArray(v.value.capabilities) && v.value.capabilities.includes("post-edit-diagnostics")) {
        return "remote";
      }
      return "standalone";
    } catch {
      return "standalone";
    } finally {
      probeClient.dispose();
    }
  }

  async function resolveMode(): Promise<Mode> {
    if (mode !== null) return mode;
    if (probePromise) return probePromise;
    probePromise = doProbe().then((m) => {
      mode = m;
      probePromise = null;
      return m;
    });
    return probePromise;
  }

  async function checkPostEditDiagnostics(
    filePath: string,
    content: string,
    languageId: string,
    root: string,
    lspManagerForFallback: LSPManager,
  ): Promise<DiagnosticResult> {
    const m = await resolveMode();
    if (m === "standalone") {
      return checkLocal(filePath, content, languageId, lspManagerForFallback);
    }
    // remote mode
    const canonicalPath = tryCanonical(resolve(filePath));
    const canonicalWorkspaceRoot = tryCanonical(resolve(root));
    const expectedContentSha256 = sha256OfString(content);
    const req: CheckPostEditDiagnosticsRequest = {
      canonicalPath,
      canonicalWorkspaceRoot,
      expectedContentSha256,
      waitMs: 3000,
      maxDiagnostics: 100,
    };
    try {
      const client = getRemoteClient();
      const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
      if (!reply.ok || reply.payload === undefined) {
        return { diagnostics: [], source: "none", status: "failed" };
      }
      const v = validateCheckPostEditDiagnosticsResponse(reply.payload);
      if (!v.ok) {
        return { diagnostics: [], source: "none", status: "failed" };
      }
      const resp = v.value;
      switch (resp.status) {
        case "confirmed":
          return { diagnostics: mapDiagnostics(resp.diagnostics as unknown as readonly Diagnostic[]), source: "lsp", status: "confirmed" };
        case "empty":
          return { diagnostics: [], source: "lsp", status: "confirmed" };
        case "unavailable":
          return { diagnostics: [], source: "none", status: "unavailable" };
        case "degraded":
          return { diagnostics: [], source: "none", status: "unconfirmed" };
        default:
          return { diagnostics: [], source: "none", status: "failed" };
      }
    } catch {
      return { diagnostics: [], source: "none", status: "failed" };
    }
  }

  function dispose(): void {
    if (remoteClient) {
      remoteClient.dispose();
      remoteClient = null;
    }
    // don't clear mode here unless reset; dispose is for client cleanup
  }

  function reset(): void {
    mode = null;
    probePromise = null;
    if (remoteClient) {
      remoteClient.dispose();
      remoteClient = null;
    }
  }

  return { checkPostEditDiagnostics, dispose, reset };
}
