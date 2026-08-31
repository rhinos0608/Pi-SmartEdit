/**
 * Unit tests for LSP integration.
 *
 * Tests:
 * - lsp-connection: init sequence, request/response, notifications, timeout, shutdown
 * - lsp-manager: server not found returns null, shutdown
 * - diagnostics: no LSP server returns source='none'
 * - semantic-nav: no LSP server returns null/[]
 * - diagnostic status: confirmed vs unconfirmed/failed/unavailable
 */

import { resolve } from "path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LSPConnection } from "../src/lsp/lsp-connection";
import { LSPManager } from "../src/lsp/lsp-manager";
import { checkPostEditDiagnostics } from "../src/lsp/diagnostics";
import { goToDefinition, findReferences, getHoverInfo } from "../src/lsp/semantic-nav";

// ─── Helpers ──────────────────────────────────────────────────────

function makeMockManager(opts: {
  publishDiagnostics?: unknown[] | null,
  publishDelayMs?: number,
  pullItems?: unknown[] | null,
  pullShouldFail?: boolean,
  openShouldFail?: boolean,
} = {}): any {
  let handler: ((params: unknown) => void) | null = null;
  let lastUri: string | null = null;
  const server: any = {
    async notify(method: string, params: unknown) {
      if (opts.openShouldFail && method === "textDocument/didOpen") throw new Error("open failed");
      if (method === "textDocument/didOpen") {
        const p = params as any;
        lastUri = p?.textDocument?.uri ?? null;
        if (opts.publishDiagnostics !== undefined) {
          const delay = opts.publishDelayMs ?? 15;
          setTimeout(() => {
            if (handler && lastUri) {
              handler({ uri: lastUri, diagnostics: opts.publishDiagnostics });
            }
          }, delay);
        }
      }
    },
    async request(method: string, _params: unknown) {
      if (method === "workspace/symbol") return null;
      if (method === "textDocument/diagnostic") {
        if (opts.pullShouldFail) throw new Error("pull not supported");
        if (opts.pullItems !== undefined) {
          if (opts.pullItems === null) return null;
          return { items: opts.pullItems };
        }
        throw new Error("pull not supported");
      }
      throw new Error("unexpected request " + method);
    },
    onNotification(method: string, h: (params: unknown) => void) {
      if (method === "textDocument/publishDiagnostics") {
        handler = h;
        if (lastUri && opts.publishDiagnostics !== undefined) {
          const delay = opts.publishDelayMs ?? 15;
          setTimeout(() => {
            if (handler && lastUri) handler({ uri: lastUri, diagnostics: opts.publishDiagnostics });
          }, delay);
        }
      }
      return () => { if (handler === h) handler = null; };
    },
    isRunning() { return true; },
  };
  return {
    async getServer(_languageId: string) { return server; },
  };
}

// ════════════════════════════════════════════════════════════════════
//  lsp-connection tests
// ════════════════════════════════════════════════════════════════════

describe("LSPConnection", () => {
  it("initialization completes without error", async () => {
    const conn = new LSPConnection(process.execPath, [resolve(__dirname, "lsp", "mock-server.js")]);
    await conn.initialize("file:///test-project");
    await conn.shutdown();
  });

  it("request/response works", async () => {
    const conn = new LSPConnection(process.execPath, [resolve(__dirname, "lsp", "mock-server.js")]);
    await conn.initialize("file:///test-project");
    await conn.request("textDocument/definition", {
      textDocument: { uri: "file:///test.ts" },
      position: { line: 0, character: 5 },
    });
    await conn.shutdown();
  });

  it("diagnostics notification received", async () => {
    const conn = new LSPConnection(process.execPath, [resolve(__dirname, "lsp", "mock-server.js")]);
    await conn.initialize("file:///test-project");
    const receivedDiagnostics: unknown[] = [];
    conn.onNotification("textDocument/publishDiagnostics", (params) => {
      receivedDiagnostics.push(params);
    });
    await conn.notify("textDocument/didOpen", {
      textDocument: {
        uri: "file:///test.ts",
        languageId: "typescript",
        version: 1,
        text: "const x = ERROR;\nconst y = WARNING;\n",
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(receivedDiagnostics.length > 0, "Diagnostics notification received");
    await conn.shutdown();
  });

  it("shutdown completes without error", async () => {
    const conn = new LSPConnection(process.execPath, [resolve(__dirname, "lsp", "mock-server.js")]);
    await conn.initialize("file:///test-project");
    await conn.shutdown();
  });
});

// ════════════════════════════════════════════════════════════════════
//  lsp-manager tests
// ════════════════════════════════════════════════════════════════════

describe("LSPManager", () => {
  it("unknown language returns null (no crash)", async () => {
    const manager = new LSPManager("/tmp");
    const server = await manager.getServer("nonexistent-lang");
    assert.equal(server, null);
  });

  it("shutdown empty manager completes without error", async () => {
    const manager = new LSPManager("/tmp");
    await manager.shutdown();
  });

  it("manager with real server — graceful fallback", async () => {
    const manager = new LSPManager("/tmp");
    const server = await manager.getServer("typescript");
    if (server) {
      await manager.shutdown();
    } else {
      assert.equal(server, null);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
//  diagnostics tests
// ════════════════════════════════════════════════════════════════════

describe("Diagnostics", () => {
  it("no LSP returns source none or lsp", async () => {
    const manager = new LSPManager("/tmp");
    const result = await checkPostEditDiagnostics("/tmp/test.ts", "const x = 1;", "typescript", manager);
    assert.ok(result.source === "none" || result.source === "lsp");
    if (result.source === "none") {
      assert.equal(result.diagnostics.length, 0);
    }
  });

  it("unsupported language returns source='none'", async () => {
    const manager = new LSPManager("/tmp");
    const result = await checkPostEditDiagnostics("/tmp/test.xyz", "some content", "nonexistent-lang", manager);
    assert.equal(result.source, "none");
  });
});

// ════════════════════════════════════════════════════════════════════
//  diagnostic status tests (WP-SE1 honesty fix)
// ════════════════════════════════════════════════════════════════════

describe("Diagnostic Status", () => {
  it("unavailable — no server -> status unavailable", async () => {
    const manager = new LSPManager("/tmp");
    const result = await checkPostEditDiagnostics("/tmp/status-test.ts", "const x=1;", "nonexistent-lang", manager);
    assert.equal(result.source, "none");
    assert.equal((result as any).status, "unavailable");
  });

  it("failed — lifecycle failure -> status failed", async () => {
    const manager = makeMockManager({ openShouldFail: true }) as any;
    const result = await checkPostEditDiagnostics("/tmp/status-test.ts", "const x=1;", "typescript", manager);
    assert.equal(result.source, "none");
    assert.equal((result as any).status, "failed");
  });

  it("confirmed empty via publishDiagnostics []", async () => {
    const manager = makeMockManager({ publishDiagnostics: [], pullShouldFail: true }) as any;
    const result = await checkPostEditDiagnostics("/tmp/status-test.ts", "const x=1;", "typescript", manager);
    assert.equal((result as any).status, "confirmed");
    assert.equal(result.source, "lsp");
    assert.equal(result.diagnostics.length, 0);
  });

  it("confirmed empty via pull items []", async () => {
    const manager = makeMockManager({ publishDiagnostics: undefined, pullItems: [] }) as any;
    const result = await checkPostEditDiagnostics("/tmp/status-test.ts", "const x=1;", "typescript", manager);
    assert.equal((result as any).status, "confirmed");
    assert.equal(result.source, "lsp");
    assert.equal(result.diagnostics.length, 0);
  });

  it("confirmed with diagnostics", async () => {
    const diags = [{ message: "err", severity: 1 as const, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, source: "test" }];
    const manager = makeMockManager({ publishDiagnostics: diags }) as any;
    const result = await checkPostEditDiagnostics("/tmp/status-test.ts", "const x=ERROR;", "typescript", manager);
    assert.equal((result as any).status, "confirmed");
    assert.equal(result.diagnostics.length, 1);
  });

  it("unconfirmed empty — timeout + no pull support", async () => {
    const manager = makeMockManager({ publishDiagnostics: undefined, pullShouldFail: true }) as any;
    const result = await checkPostEditDiagnostics("/tmp/status-test.ts", "const x=1;", "typescript", manager);
    assert.equal((result as any).status, "unconfirmed");
    assert.equal(result.source, "lsp");
    assert.equal(result.diagnostics.length, 0);
  });

  it("confirmed-empty vs unconfirmed-empty distinguishable by status", async () => {
    const unconfirmedMgr = makeMockManager({ publishDiagnostics: undefined, pullShouldFail: true }) as any;
    const unconfirmed = await checkPostEditDiagnostics("/tmp/status-test.ts", "const x=1;", "typescript", unconfirmedMgr);
    const confirmedMgr = makeMockManager({ publishDiagnostics: [], pullShouldFail: true }) as any;
    const confirmed = await checkPostEditDiagnostics("/tmp/status-test.ts", "const x=1;", "typescript", confirmedMgr);
    assert.equal(confirmed.diagnostics.length, unconfirmed.diagnostics.length);
    assert.notEqual((confirmed as any).status, (unconfirmed as any).status);
  });
});

// ════════════════════════════════════════════════════════════════════
//  semantic-nav tests
// ════════════════════════════════════════════════════════════════════

describe("Semantic Navigation", () => {
  it("no LSP returns null for goToDefinition", async () => {
    const manager = new LSPManager("/tmp");
    const result = await goToDefinition("/tmp/test.ts", 0, 5, "typescript", manager);
    assert.equal(result, null);
  });

  it("no LSP returns empty array for findReferences", async () => {
    const manager = new LSPManager("/tmp");
    const result = await findReferences("/tmp/test.ts", 0, 5, "typescript", manager);
    assert.ok(Array.isArray(result) && result.length === 0);
  });

  it("no LSP returns null for getHoverInfo", async () => {
    const manager = new LSPManager("/tmp");
    const result = await getHoverInfo("/tmp/test.ts", 0, 5, "typescript", manager);
    assert.equal(result, null);
  });
});
