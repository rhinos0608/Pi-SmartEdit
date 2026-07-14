import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeTraceability } from "../../src/verification/traceability.js";
import { defaultTraceabilityConfig } from "../../src/verification/config.js";
import type { ChangedTarget } from "../../src/verification/types.js";

function makeLogicTarget(name: string, overrides?: Partial<ChangedTarget>): ChangedTarget {
  return {
    path: `/project/src/${name}.ts`,
    languageId: "typescript",
    kind: "function",
    name,
    lineRange: { startLine: 1, endLine: 10 },
    byteRange: { startIndex: 0, endIndex: 100 },
    editKind: "logic",
    concurrencySignals: [],
    ...overrides,
  };
}

describe("traceability", () => {
  describe("analyzeTraceability", () => {
    it("returns 100% coverage with empty targets list", async () => {
      const result = await analyzeTraceability({
        cwd: "/tmp",
        path: "/tmp/test.ts",
        content: "",
        changedTargets: [],
        editedPaths: [],
        lspManager: null,
        config: defaultTraceabilityConfig(),
      });
      assert.strictEqual(result.coveragePercent, 100);
      assert.strictEqual(result.targets.length, 0);
    });

    it("marks test and docs targets as not-applicable", async () => {
      const testTarget = makeLogicTarget("test", { editKind: "test" });
      const docsTarget = makeLogicTarget("readme", { editKind: "docs" });
      const result = await analyzeTraceability({
        cwd: "/tmp",
        path: "/tmp/test.test.ts",
        content: "",
        changedTargets: [testTarget, docsTarget],
        editedPaths: [],
        lspManager: null,
        config: defaultTraceabilityConfig(),
      });
      for (const t of result.targets) {
        assert.strictEqual(t.status, "not-applicable");
      }
      assert.strictEqual(result.coveragePercent, 100);
    });

    it("reports missing for logic target with no matching test file", async () => {
      const target = makeLogicTarget("orphanFunction");
      const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
      try {
        const result = await analyzeTraceability({
          cwd: dir,
          path: join(dir, "orphan.ts"),
          content: `function orphanFunction() {}`,
          changedTargets: [target],
          editedPaths: [],
          lspManager: null,
          config: defaultTraceabilityConfig(),
        });
        const entry = result.targets.find((t) => t.target.name === "orphanFunction");
        assert.ok(entry, "Expected traceability entry for orphanFunction");
        assert.strictEqual(entry.status, "missing");
        assert.strictEqual(result.coveragePercent, 0);
      } finally {
        // Cleanup happens on OS temp dir
      }
    });

    it("reports candidate when test file references target name", async () => {
      const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
      try {
        // Create a test file that references the target
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(
          join(dir, "src", "service.test.ts"),
          `import { describe, it } from "node:test";
           describe("processOrder", () => { it("works", () => {}); });`,
          "utf-8",
        );

        const target = makeLogicTarget("processOrder", {
          path: join(dir, "src", "service.ts"),
        });
        const result = await analyzeTraceability({
          cwd: dir,
          path: join(dir, "src", "service.ts"),
          content: `function processOrder() {}`,
          changedTargets: [target],
          editedPaths: [join(dir, "src", "service.ts")],
          lspManager: null,
          config: defaultTraceabilityConfig(),
        });
        const entry = result.targets.find((t) => t.target.name === "processOrder");
        assert.ok(entry, "Expected traceability entry for processOrder");
        assert.ok(
          entry.status === "candidate" || entry.status === "covered",
          `Expected candidate or covered, got ${entry.status}`,
        );
      } finally {
        // Temp dir cleaned by OS
      }
    });

    it("reports covered when test was also edited", async () => {
      const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
      try {
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(
          join(dir, "src", "service.test.ts"),
          `describe("processOrder", () => { it("works", () => {}); });`,
          "utf-8",
        );

        const target = makeLogicTarget("processOrder", {
          path: join(dir, "src", "service.ts"),
        });
        const result = await analyzeTraceability({
          cwd: dir,
          path: join(dir, "src", "service.ts"),
          content: `function processOrder() {}`,
          changedTargets: [target],
          editedPaths: [join(dir, "src", "service.ts"), join(dir, "src", "service.test.ts")],
          lspManager: null,
          config: defaultTraceabilityConfig(),
        });
        const entry = result.targets.find((t) => t.target.name === "processOrder");
        assert.ok(entry, "Expected traceability entry for processOrder");
        // Covered is the expected status
        assert.strictEqual(entry.status, "covered");
      } finally {
        // Temp dir cleaned by OS
      }
    });

    it("returns applicable-only coverage percent", async () => {
      const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
      try {
        // One test target (ignored for coverage) and one logic target (counted)
        const testTarget = makeLogicTarget("testHelper", { editKind: "test" });
        const logicTarget = makeLogicTarget("unlinkedFn");

        const result = await analyzeTraceability({
          cwd: dir,
          path: join(dir, "src", "app.ts"),
          content: "",
          changedTargets: [testTarget, logicTarget],
          editedPaths: [],
          lspManager: null,
          config: defaultTraceabilityConfig(),
        });
        // Only logicTarget is applicable; it's missing -> 0%
        assert.strictEqual(result.coveragePercent, 0);
      } finally {
        // Temp dir cleaned by OS
      }
    });
  });
});
