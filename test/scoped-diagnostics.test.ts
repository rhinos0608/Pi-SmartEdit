import { describe, it } from "node:test";
import assert from "node:assert";
import { scopeDiagnosticsToChangedTargets } from "../src/verification/scoped-diagnostics.js";
import type { ChangedTarget } from "../src/verification/types.js";

const target: ChangedTarget = {
  path: "/project/src/example.ts",
  languageId: "typescript",
  kind: "function",
  name: "target",
  lineRange: { startLine: 2, endLine: 4 },
  byteRange: { startIndex: 20, endIndex: 80 },
  editKind: "logic",
  concurrencySignals: [],
};

describe("scoped diagnostics", () => {
  it("labels diagnostics inside edited symbols", async () => {
    const result = await scopeDiagnosticsToChangedTargets({
      cwd: "/project",
      path: "/project/src/example.ts",
      content: "function keep() {}\nfunction target() {\n  broken();\n}\n",
      languageId: "typescript",
      diagnostics: [{
        message: "Cannot find name broken",
        severity: 1,
        source: "tsc",
        range: { start: { line: 2, character: 2 }, end: { line: 2, character: 8 } },
        filePath: "/project/src/example.ts",
      }],
      changedTargets: [target],
      lspManager: null,
    });

    assert.strictEqual(result[0].scope, "edited-symbol");
    assert.strictEqual(result[0].targetName, "target");
  });

  it("labels same-file diagnostics outside edited symbols", async () => {
    const result = await scopeDiagnosticsToChangedTargets({
      cwd: "/project",
      path: "/project/src/example.ts",
      content: "",
      languageId: "typescript",
      diagnostics: [{
        message: "Other error",
        severity: 1,
        source: "tsc",
        range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } },
        filePath: "/project/src/example.ts",
      }],
      changedTargets: [target],
      lspManager: null,
    });

    assert.strictEqual(result[0].scope, "same-file");
  });

  it("uses LSP references when available", async () => {
    const requests: unknown[] = [];
    const lspManager = {
      async getServer() {
        return {
          async initialize() { return {}; },
          async shutdown() {},
          async notify() {},
          async request(method: string, params: unknown) {
            requests.push({ method, params });
            return [{
              uri: "file:///project/src/consumer.ts",
              range: { start: { line: 4, character: 10 }, end: { line: 4, character: 16 } },
            }];
          },
        };
      },
    };

    const result = await scopeDiagnosticsToChangedTargets({
      cwd: "/project",
      path: "/project/src/example.ts",
      content: "function keep() {}\nfunction target() {\n  return 1;\n}\n",
      languageId: "typescript",
      diagnostics: [{
        message: "Call site error",
        severity: 1,
        source: "lsp",
        range: { start: { line: 4, character: 12 }, end: { line: 4, character: 16 } },
        filePath: "/project/src/consumer.ts",
      }],
      changedTargets: [target],
      lspManager,
    });

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(result[0].scope, "referencing-symbol");
    assert.strictEqual(result[0].referenceCount, 1);
  });
});
