import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRpcServer, RPC_CHANNELS, LANGUAGE_INTELLIGENCE_RPC_METHODS } from "@rhinos0608/pi-workspace-protocol";
import { createSmartReadDiagnosticsClient } from "../src/lsp/smartread-diagnostics-client.js";

function makeBus() {
  const subs = new Map<string, Set<(d: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      const set = subs.get(channel);
      if (!set) return;
      for (const h of [...set]) h(data);
    },
    on(channel: string, handler: (d: unknown) => void) {
      if (!subs.has(channel)) subs.set(channel, new Set());
      subs.get(channel)!.add(handler);
      return () => subs.get(channel)!.delete(handler);
    },
  };
}

function makeMockManager(): { getServer: (id: string) => Promise<unknown>; calls: () => number; manager: any } {
  let count = 0;
  const manager: any = {
    async getServer(_id: string) {
      count++;
      return null;
    },
  };
  return { getServer: manager.getServer.bind(manager), calls: () => count, manager };
}

// Helper to register a SmartRead-like provider
function registerProvider(bus: ReturnType<typeof makeBus>, handlerOverrides?: { capabilities?: unknown; diagnostics?: unknown | ((payload: unknown) => unknown | Promise<unknown>); delayMs?: number }) {
  let capCalls = 0;
  const server = createRpcServer({
    bus,
    channel: RPC_CHANNELS.languageIntelligence,
    handler: async (req) => {
      if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.capabilities) {
        capCalls++;
        if (handlerOverrides?.capabilities !== undefined) return handlerOverrides.capabilities;
        return { provider: "pi-smartread", capabilities: ["post-edit-diagnostics"] as const };
      }
      if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics) {
        if (handlerOverrides?.delayMs) await new Promise((r) => setTimeout(r, handlerOverrides.delayMs));
        if (typeof handlerOverrides?.diagnostics === "function") {
          return (handlerOverrides.diagnostics as (p: unknown) => unknown)(req.payload);
        }
        if (handlerOverrides?.diagnostics !== undefined) return handlerOverrides.diagnostics;
        return { status: "confirmed", diagnostics: [{ message: "oops", severity: 1 as const, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, source: "test-lsp" }], truncated: false };
      }
      throw new Error("unknown rpc " + req.rpc);
    },
  });
  return { server, capCalls: () => capCalls };
}

describe("SmartRead diagnostics client", () => {
  it("provider available -> mode remote, local getServer NEVER called", async () => {
    const bus = makeBus();
    const { server } = registerProvider(bus);
    const client = createSmartReadDiagnosticsClient(bus);
    const { manager } = makeMockManager();
    // instrument manager.getServer to detect calls
    let getServerCalled = false;
    const orig = manager.getServer;
    manager.getServer = async (id: string) => { getServerCalled = true; return orig(id); };
    const result = await client.checkPostEditDiagnostics("/tmp/a.ts", "const x=1;", "typescript", "/tmp", manager);
    assert.equal(result.source, "lsp");
    assert.equal(result.status, "confirmed");
    assert.equal(getServerCalled, false, "local lspManager.getServer must NOT be called in remote mode");
    // second call also remote, still no local call
    getServerCalled = false;
    const result2 = await client.checkPostEditDiagnostics("/tmp/b.ts", "const y=2;", "typescript", "/tmp", manager);
    assert.equal(getServerCalled, false);
    assert.equal(result2.source, "lsp");
    client.dispose();
    server.dispose();
  });

  it("provider absent (no responder, probe times out) -> standalone, local path used", async () => {
    const bus = makeBus();
    const client = createSmartReadDiagnosticsClient(bus);
    // manager returns null => status unavailable, but proves local was called
    let called = 0;
    const manager: any = {
      async getServer() { called++; return null; },
    };
    const result = await client.checkPostEditDiagnostics("/tmp/a.ts", "const x=1;", "nonexistent-lang", "/tmp", manager);
    assert.equal(called, 1, "local path should have been called");
    assert.equal(result.source, "none");
    assert.equal(result.status, "unavailable");
    // second call: still standalone, should call again (mode sticky)
    await client.checkPostEditDiagnostics("/tmp/a.ts", "const x=1;", "nonexistent-lang", "/tmp", manager);
    assert.equal(called, 2);
    client.dispose();
  });

  it("wire empty -> internal confirmed with empty diagnostics (authoritative)", async () => {
    const bus = makeBus();
    const { server } = registerProvider(bus, { diagnostics: { status: "empty", diagnostics: [], truncated: false } });
    const client = createSmartReadDiagnosticsClient(bus);
    const { manager } = makeMockManager();
    let localCalled = false;
    (manager as any).getServer = async () => { localCalled = true; return null; };
    const result = await client.checkPostEditDiagnostics("/tmp/a.ts", "clean;", "typescript", "/tmp", manager);
    assert.equal(result.status, "confirmed");
    assert.equal(result.source, "lsp");
    assert.deepEqual(result.diagnostics, []);
    assert.equal(localCalled, false);
    client.dispose();
    server.dispose();
  });

  it("remote status mapping: confirmed/empty/unavailable/degraded and failed on error", async () => {
    // confirmed already tested; test degraded/unavailable/malformed/timeout
    const bus = makeBus();
    let diagResponse: unknown = { status: "degraded", reason: "unconfirmed", diagnostics: [], truncated: false };
    const { server } = registerProvider(bus, { diagnostics: () => diagResponse as unknown });
    const client = createSmartReadDiagnosticsClient(bus);
    const { manager } = makeMockManager();
    (manager as any).getServer = async () => { throw new Error("should not be called"); };
    let r = await client.checkPostEditDiagnostics("/tmp/a.ts", "x", "typescript", "/tmp", manager);
    assert.equal(r.status, "unconfirmed");
    assert.equal(r.source, "none");
    diagResponse = { status: "unavailable", reason: "no-server", diagnostics: [], truncated: false };
    r = await client.checkPostEditDiagnostics("/tmp/b.ts", "x", "typescript", "/tmp", manager);
    assert.equal(r.status, "unavailable");
    assert.equal(r.source, "none");
    // malformed -> failed
    diagResponse = { status: "confirmed", diagnostics: "not-an-array", truncated: false };
    r = await client.checkPostEditDiagnostics("/tmp/c.ts", "x", "typescript", "/tmp", manager);
    assert.equal(r.status, "failed");
    assert.equal(r.source, "none");
    client.dispose();
    server.dispose();

    // transport timeout/error -> failed (new client to avoid sticky degraded affecting)
    const bus2 = makeBus();
    const client2 = createSmartReadDiagnosticsClient(bus2);
    // probe succeeds to get into remote mode
    const srv = createRpcServer({
      bus: bus2,
      channel: RPC_CHANNELS.languageIntelligence,
      handler: async (req) => {
        if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.capabilities) return { provider: "pi-smartread", capabilities: ["post-edit-diagnostics"] };
        if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics) throw new Error("transport boom");
        throw new Error("unknown");
      },
    });
    const { manager: m2 } = makeMockManager();
    let localCalled2 = false;
    (m2 as any).getServer = async () => { localCalled2 = true; return null; };
    const r2 = await client2.checkPostEditDiagnostics("/tmp/a.ts", "x", "typescript", "/tmp", m2);
    assert.equal(r2.status, "failed");
    assert.equal(r2.source, "none");
    assert.equal(localCalled2, false, "remote failure must NOT fall back to local getServer");
    client2.dispose();
    srv.dispose();
  });

  it("remote timeout on diagnostics -> failed, not fallback to local", async () => {
    const bus = makeBus();
    // Server delays beyond 5000ms timeout
    const client = createSmartReadDiagnosticsClient(bus);
    let capDone = false;
    const srv = createRpcServer({
      bus,
      channel: RPC_CHANNELS.languageIntelligence,
      handler: async (req) => {
        if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.capabilities) return { provider: "pi-smartread", capabilities: ["post-edit-diagnostics"] };
        if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics) {
          await new Promise((r) => setTimeout(r, 6000));
          return { status: "empty", diagnostics: [], truncated: false };
        }
        throw new Error("unknown");
      },
    });
    const { manager } = makeMockManager();
    let localCalled = false;
    (manager as any).getServer = async () => { localCalled = true; return null; };
    const r = await client.checkPostEditDiagnostics("/tmp/a.ts", "x", "typescript", "/tmp", manager);
    assert.equal(r.status, "failed");
    assert.equal(localCalled, false);
    client.dispose();
    srv.dispose();
    // Note: need small delay to let hanging server timer not leak? server will still try emit after dispose; harmless.
  });

  it("concurrent first-calls share one probe (only ONE capabilities request)", async () => {
    const bus = makeBus();
    let capCount = 0;
    const srv = createRpcServer({
      bus,
      channel: RPC_CHANNELS.languageIntelligence,
      handler: async (req) => {
        if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.capabilities) {
          capCount++;
          await new Promise((r) => setTimeout(r, 50));
          return { provider: "pi-smartread", capabilities: ["post-edit-diagnostics"] };
        }
        if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics) {
          return { status: "empty", diagnostics: [], truncated: false };
        }
        throw new Error("unknown");
      },
    });
    const client = createSmartReadDiagnosticsClient(bus);
    const { manager } = makeMockManager();
    const p1 = client.checkPostEditDiagnostics("/tmp/a.ts", "x", "typescript", "/tmp", manager);
    const p2 = client.checkPostEditDiagnostics("/tmp/b.ts", "y", "typescript", "/tmp", manager);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(capCount, 1, "probe must be coalesced to one request");
    assert.equal(r1.status, "confirmed");
    assert.equal(r2.status, "confirmed");
    client.dispose();
    srv.dispose();
  });

  it("mode stays sticky across multiple checks (probe only once)", async () => {
    const bus = makeBus();
    let capCount = 0;
    const srv = createRpcServer({
      bus,
      channel: RPC_CHANNELS.languageIntelligence,
      handler: async (req) => {
        if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.capabilities) { capCount++; return { provider: "pi-smartread", capabilities: ["post-edit-diagnostics"] }; }
        return { status: "empty", diagnostics: [], truncated: false };
      },
    });
    const client = createSmartReadDiagnosticsClient(bus);
    const { manager } = makeMockManager();
    await client.checkPostEditDiagnostics("/tmp/a.ts", "x", "typescript", "/tmp", manager);
    await client.checkPostEditDiagnostics("/tmp/a.ts", "x", "typescript", "/tmp", manager);
    await client.checkPostEditDiagnostics("/tmp/a.ts", "x", "typescript", "/tmp", manager);
    assert.equal(capCount, 1, "probe must happen only once per session");
    // reset clears sticky mode -> next call re-probes
    client.reset();
    await client.checkPostEditDiagnostics("/tmp/a.ts", "x", "typescript", "/tmp", manager);
    assert.equal(capCount, 2, "after reset probe should fire again");
    client.dispose();
    srv.dispose();
  });

  it("capability probe without post-edit-diagnostics -> standalone", async () => {
    const bus = makeBus();
    const srv = createRpcServer({
      bus,
      channel: RPC_CHANNELS.languageIntelligence,
      handler: async (req) => {
        if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.capabilities) return { provider: "pi-smartread", capabilities: [] as const };
        throw new Error("should not be called for diagnostics");
      },
    });
    const client = createSmartReadDiagnosticsClient(bus);
    let localCalled = 0;
    const manager: any = { async getServer() { localCalled++; return null; } };
    const r = await client.checkPostEditDiagnostics("/tmp/a.ts", "x", "typescript", "/tmp", manager);
    assert.equal(localCalled, 1);
    assert.equal(r.status, "unavailable");
    client.dispose();
    srv.dispose();
  });

  it("dispose/reset lifecycle hooks exist and reset clears sticky state", async () => {
    const bus = makeBus();
    const client = createSmartReadDiagnosticsClient(bus);
    assert.equal(typeof client.dispose, "function");
    assert.equal(typeof client.reset, "function");
    client.reset();
    client.dispose();
  });
});
