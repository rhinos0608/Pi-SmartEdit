import { execSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseTscOutput,
  parsePyrightOutput,
  getCompilerForLanguage,
  checkTscDiagnostics
} from "../src/lsp/diagnostic-dispatcher.js";

const tscAvailable = (() => {
  try {
    execSync("npx tsc --version", { encoding: "utf-8", timeout: 10000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const testTsc: typeof it = tscAvailable ? it : (it.skip as typeof it);

describe("Diagnostic Dispatcher", () => {
  describe("parseTscOutput", () => {
    it("correctly parses single TypeScript error", () => {
      const output = "file.ts(10,5): error TS2322: Type 'number' is not assignable to type 'string'.";
      const diagnostics = parseTscOutput(output);
      
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(diagnostics[0].message, "file.ts:Type 'number' is not assignable to type 'string'.");
      assert.strictEqual(diagnostics[0].severity, 1);
      assert.strictEqual(diagnostics[0].range.start.line, 9);
      assert.strictEqual(diagnostics[0].range.start.character, 4);
      assert.strictEqual(diagnostics[0].source, "tsc");
    });

    it("correctly parses multiple errors", () => {
      const output = [
        "file1.ts(1,1): error TS1005: ';' expected.",
        "file2.ts(5,10): warning TS0001: some warning"
      ].join("\n");
      const diagnostics = parseTscOutput(output);
      
      assert.strictEqual(diagnostics.length, 2);
      assert.strictEqual(diagnostics[0].severity, 1);
      assert.strictEqual(diagnostics[1].severity, 2);
    });

    it("returns empty array for non-matching output", () => {
      const output = "some random build message";
      const diagnostics = parseTscOutput(output);
      assert.strictEqual(diagnostics.length, 0);
    });
  });

  describe("parsePyrightOutput", () => {
    it("correctly parses pyright JSON output", () => {
      const jsonOutput = JSON.stringify({
        generalDiagnostics: [
          {
            file: "test.py",
            severity: "error",
            message: "Expression of type 'int' cannot be assigned to declared type 'str'",
            range: {
              start: { line: 0, character: 4 },
              end: { line: 0, character: 7 }
            }
          }
        ]
      });
      
      const diagnostics = parsePyrightOutput(jsonOutput);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual(diagnostics[0].severity, 1);
      assert.strictEqual(diagnostics[0].message, "Expression of type 'int' cannot be assigned to declared type 'str'");
      assert.strictEqual(diagnostics[0].source, "pyright");
    });

    it("handles invalid JSON gracefully", () => {
      const diagnostics = parsePyrightOutput("not json");
      assert.strictEqual(diagnostics.length, 0);
    });
  });

  describe("getCompilerForLanguage", () => {
    it("returns runners for supported languages", () => {
      assert.notStrictEqual(getCompilerForLanguage("typescript"), null);
      assert.notStrictEqual(getCompilerForLanguage("python"), null);
      assert.notStrictEqual(getCompilerForLanguage("go"), null);
      assert.notStrictEqual(getCompilerForLanguage("rust"), null);
    });

    it("returns null for unsupported languages", () => {
      assert.strictEqual(getCompilerForLanguage("coffeescript"), null);
    });
  });

  describe("checkTscDiagnostics", () => {
    testTsc("runs and returns proper DiagnosticResult", async () => {
      const result = await checkTscDiagnostics("test.ts", process.cwd());
      assert.ok(result && typeof result === "object");
      assert.ok(Array.isArray(result.diagnostics));
      assert.strictEqual(typeof result.source, "string");
    });
  });
});
