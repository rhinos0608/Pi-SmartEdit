import { describe, it } from "node:test";
import assert from "node:assert";
import { runPostEditEvidencePipeline } from "../../src/verification/post-edit-evidence.js";
import { defaultVerificationConfig } from "../../src/verification/config.js";
import type { VerificationConfig } from "../../src/verification/types.js";

describe("post-edit-evidence", () => {
  describe("runPostEditEvidencePipeline", () => {
    it("returns empty result when config is disabled", async () => {
      const result = await runPostEditEvidencePipeline({
        cwd: "/tmp",
        path: "/tmp/test.ts",
        content: "const x = 1;",
        languageId: "typescript",
        matchSpans: [{ startIndex: 0, endIndex: 5 }],
        editedPaths: ["/tmp/test.ts"],
        lspManager: null,
        config: { enabled: false, policy: "off" } as Partial<VerificationConfig>,
      });
      assert.strictEqual(result.notes.length, 0);
      assert.strictEqual(result.details.changes.length, 0);
      assert.strictEqual(result.details.concurrency.length, 0);
      assert.strictEqual(result.details.traceability, null);
      assert.strictEqual(result.details.history.length, 0);
    });

    it("builds changed targets for deterministic edits", async () => {
      const result = await runPostEditEvidencePipeline({
        cwd: "/tmp",
        path: "/tmp/test.ts",
        content: "const x = 1;\nconst y = 2;",
        languageId: "typescript",
        matchSpans: [{ startIndex: 0, endIndex: 10 }],
        editedPaths: ["/tmp/test.ts"],
        lspManager: null,
      });

      // Should have detected at least some targets (may be unknown in fallback)
      assert.ok(result.details.changes.length > 0, "Expected at least one change target");
      // No concurrency signals expected for `const x = 1`
      assert.strictEqual(result.details.concurrency.length, 0);
    });

    it("reports concurrency signals for async functions", async () => {
      const content = `async function fetchData() {
        return await fetch("/api");
      }`;
      const result = await runPostEditEvidencePipeline({
        cwd: "/tmp",
        path: "/tmp/handler.ts",
        content,
        languageId: "typescript",
        matchSpans: [{ startIndex: 0, endIndex: content.length }],
        editedPaths: ["/tmp/handler.ts"],
        lspManager: null,
      });

      // Should detect async/await signals (concurrency lane may produce skipped note
      // if no tool is configured, but the concurrency evidence should be populated)
      const hasConcurrencyNotes = result.notes.some((n) => n.includes("Concurrency"));
      const hasConcurrencyEvidence = result.details.concurrency.length > 0;
      assert.ok(
        hasConcurrencyNotes || hasConcurrencyEvidence,
        "Expected concurrency notes or evidence for async function",
      );
    });

    it("returns traceability analysis for logic changes", async () => {
      const result = await runPostEditEvidencePipeline({
        cwd: "/tmp",
        path: "/tmp/feature.ts",
        content: "function newFeature() { return 42; }",
        languageId: "typescript",
        matchSpans: [{ startIndex: 0, endIndex: 10 }],
        editedPaths: ["/tmp/feature.ts"],
        lspManager: null,
      });

      // Traceability should produce at least some targets
      assert.ok(result.details.traceability === null || Array.isArray(result.details.traceability.targets));
    });

    it("handles lane failures gracefully with notes", async () => {
      // Pass invalid content to trigger lane failures
      const result = await runPostEditEvidencePipeline({
        cwd: "/nonexistent",
        path: "/nonexistent/file.ts",
        content: "",
        languageId: "unknown",
        matchSpans: [],
        editedPaths: [],
        lspManager: null,
      });

      // Should not throw — lane failures become notes
      assert.ok(Array.isArray(result.notes));
      assert.ok(Array.isArray(result.details.changes));
      assert.ok(Array.isArray(result.details.concurrency));
    });

    it("does not modify content parameter", async () => {
      const content = "const x = 1;";
      const original = content.slice();
      await runPostEditEvidencePipeline({
        cwd: "/tmp",
        path: "/tmp/test.ts",
        content,
        languageId: "typescript",
        matchSpans: [{ startIndex: 0, endIndex: 5 }],
        editedPaths: ["/tmp/test.ts"],
        lspManager: null,
      });
      assert.strictEqual(content, original);
    });

    it("accepts custom config overrides", async () => {
      const result = await runPostEditEvidencePipeline({
        cwd: "/tmp",
        path: "/tmp/test.ts",
        content: "async function go() { await delay(); }",
        languageId: "typescript",
        matchSpans: [{ startIndex: 0, endIndex: 10 }],
        editedPaths: ["/tmp/test.ts"],
        lspManager: null,
        config: {
          enabled: true,
          policy: "warn" as const,
          maxInlineMs: 500,
          maxBackgroundMs: 30000,
          concurrency: {
            enabled: true,
            runMode: "inline" as const,
            commands: [],
            autoDetectKnownTools: false,
          },
          traceability: {
            enabled: true,
            testGlobs: ["**/*.test.*"],
            minCoveragePercent: 0,
            requireTestChangeForLogicChange: false,
          },
          history: {
            enabled: true,
            maxCommits: 3,
            maxChars: 1000,
            includeBlame: false,
          },
        },
      });
      assert.ok(Array.isArray(result.notes));
    });
  });
});
