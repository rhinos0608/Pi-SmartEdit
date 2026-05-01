/**
 * Unit tests for LSP foundational components.
 * 
 * Covers: normalizeLocations, navigation wrappers (graceful failure),
 * and withOpenDocument lifecycle/serialization.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { normalizeLocations, goToDefinitions, getDocumentSymbols } from "../src/lsp/semantic-nav.js";
import { withOpenDocument } from "../src/lsp/document-sync.js";

// Mock LSPConnection
class MockLSPConnection {
  public notifications: any[] = [];
  public requests: any[] = [];
  public serverCapabilities: any = {
    capabilities: {
      semanticTokensProvider: {
        legend: {
          tokenTypes: ["type"],
          tokenModifiers: ["declaration"]
        }
      }
    }
  };

  async request(method: string, params: any) {
    this.requests.push({ method, params });
    return null;
  }

  async notify(method: string, params: any) {
    this.notifications.push({ method, params });
  }
}

// Mock LSPManager
class MockLSPManager {
  constructor(private server: any) {}
  async getServer() {
    return this.server;
  }
}

describe("LSP Foundational Components", () => {
  describe("normalizeLocations", () => {
    it("handles null", () => {
      const result = normalizeLocations(null);
      assert.deepStrictEqual(result, []);
    });

    it("handles single Location", () => {
      const loc = { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
      const result = normalizeLocations(loc);
      assert.strictEqual(result.length, 1);
      assert.deepStrictEqual(result[0].location, loc);
      assert.strictEqual(result[0].originRange, undefined);
    });

    it("handles Location[]", () => {
      const locs = [
        { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        { uri: "file:///b.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
      ];
      const result = normalizeLocations(locs);
      assert.strictEqual(result.length, 2);
      assert.deepStrictEqual(result[0].location, locs[0]);
      assert.deepStrictEqual(result[1].location, locs[1]);
    });

    it("handles LocationLink[]", () => {
      const links = [
        {
          originSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          targetUri: "file:///a.ts",
          targetRange: { start: { line: 10, character: 0 }, end: { line: 10, character: 20 } },
          targetSelectionRange: { start: { line: 10, character: 5 }, end: { line: 10, character: 10 } },
        }
      ];
      const result = normalizeLocations(links);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].location.uri, links[0].targetUri);
      assert.deepStrictEqual(result[0].location.range, links[0].targetRange);
      assert.deepStrictEqual(result[0].originRange, links[0].originSelectionRange);
    });
  });

  describe("Navigation wrappers graceful failure", () => {
    it("goToDefinitions returns empty array if no server", async () => {
      const manager = new MockLSPManager(null) as any;
      const result = await goToDefinitions("test.ts", 0, 0, "typescript", manager);
      assert.deepStrictEqual(result, []);
    });

    it("getDocumentSymbols returns empty array if no server", async () => {
      const manager = new MockLSPManager(null) as any;
      const result = await getDocumentSymbols("test.ts", "typescript", manager);
      assert.deepStrictEqual(result, []);
    });
  });

  describe("withOpenDocument", () => {
    it("manages lifecycle (didOpen/didClose)", async () => {
      const server = new MockLSPConnection() as any;
      const input = { uri: "file:///test.ts", languageId: "typescript", content: "const x = 1;" };
      
      let called = false;
      await withOpenDocument(server, input, async () => {
        called = true;
        assert.strictEqual(server.notifications.length, 1);
        assert.strictEqual(server.notifications[0].method, "textDocument/didOpen");
        assert.strictEqual(server.notifications[0].params.textDocument.text, input.content);
      });

      assert.strictEqual(called, true);
      assert.strictEqual(server.notifications.length, 2);
      assert.strictEqual(server.notifications[1].method, "textDocument/didClose");
    });

    it("closes document on callback failure", async () => {
      const server = new MockLSPConnection() as any;
      const input = { uri: "file:///test.ts", languageId: "typescript", content: "const x = 1;" };

      try {
        await withOpenDocument(server, input, async () => {
          throw new Error("fail");
        });
      } catch (err: any) {
        assert.strictEqual(err.message, "fail");
      }

      assert.strictEqual(server.notifications.length, 2);
      assert.strictEqual(server.notifications[0].method, "textDocument/didOpen");
      assert.strictEqual(server.notifications[1].method, "textDocument/didClose");
    });

    it("serializes concurrent requests for same URI", async () => {
        const server = new MockLSPConnection() as any;
        const input = { uri: "file:///shared.ts", languageId: "typescript", content: "shared" };
        
        let active = 0;
        let maxActive = 0;

        const op = async () => {
            await withOpenDocument(server, input, async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise(r => setTimeout(r, 10));
                active--;
            });
        };

        await Promise.all([op(), op(), op()]);
        
        assert.strictEqual(maxActive, 1, "Operations did not serialize");
        // Each op should have done a didOpen and didClose because they are serialized.
        assert.strictEqual(server.notifications.length, 6);
    });
  });
});
