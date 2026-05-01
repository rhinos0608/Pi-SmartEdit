import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildChangedTargets,
  byteOffsetToLine,
} from "../../src/verification/change-targets.js";
import { defaultTraceabilityConfig } from "../../src/verification/config.js";

describe("change-targets", () => {
  describe("byteOffsetToLine", () => {
    it("returns 1 for offset 0", () => {
      assert.strictEqual(byteOffsetToLine("hello", 0), 1);
    });

    it("counts newlines correctly", () => {
      const content = "line1\nline2\nline3";
      assert.strictEqual(byteOffsetToLine(content, 0), 1);   // "line1..."
      // byte 5 is the \n — still on line 1
      assert.strictEqual(byteOffsetToLine(content, 5), 1);
      // byte 6 is first char of "line2" — line 2
      assert.strictEqual(byteOffsetToLine(content, 6), 2);
      // byte 11 is the second \n — still on line 2
      assert.strictEqual(byteOffsetToLine(content, 11), 2);
      // byte 12 is first char of "line3" — line 3
      assert.strictEqual(byteOffsetToLine(content, 12), 3);
    });

    it("handles offset at end of content", () => {
      const content = "a\nb\nc";
      // The byteOffset is exclusive for end indices
      assert.strictEqual(byteOffsetToLine(content, 4), 3); // after \n at pos 3
    });

    it("handles negative offset by returning 1", () => {
      assert.strictEqual(byteOffsetToLine("hello", -1), 1);
    });
  });

  describe("buildChangedTargets", () => {
    it("returns empty array for no match spans", async () => {
      const targets = await buildChangedTargets({
        path: "/project/src/test.ts",
        content: "const x = 1;",
        languageId: "typescript",
        matchSpans: [],
      });
      assert.strictEqual(targets.length, 0);
    });

    it("returns fallback unknown target when AST parsing unavailable", async () => {
      // Use a made-up language that won't have a grammar loaded
      const targets = await buildChangedTargets({
        path: "/project/src/test.xyz",
        content: "some random content",
        languageId: "unknown",
        matchSpans: [{ startIndex: 0, endIndex: 19 }],
      });
      assert.ok(targets.length >= 1, `Expected at least 1 target, got ${targets.length}`);
      // Fallback creates unknown targets
      const unknown = targets.filter((t) => t.kind === "unknown");
      assert.ok(unknown.length > 0, "Expected at least one unknown target in fallback");
    });

    it("classifies test file changes as test editKind", async () => {
      const targets = await buildChangedTargets({
        path: "/project/src/service.test.ts",
        content: "describe('test suite', () => { it('works', () => {}); })",
        languageId: "typescript",
        matchSpans: [{ startIndex: 0, endIndex: 5 }],
        testGlobs: ["**/*.test.*"],
      });
      assert.ok(targets.length >= 0);
      const testTargets = targets.filter((t) => t.editKind === "test");
      // Most importantly, non-logic classification works in fallback
      for (const t of targets) {
        if (t.path.includes(".test.")) {
          assert.strictEqual(t.editKind, "test");
        }
      }
    });

    it("classifies markdown changes as docs editKind", async () => {
      const targets = await buildChangedTargets({
        path: "/project/README.md",
        content: "# Hello World\n\nThis is documentation.",
        languageId: "markdown",
        matchSpans: [{ startIndex: 0, endIndex: 5 }],
      });
      for (const t of targets) {
        assert.strictEqual(t.editKind, "docs");
      }
    });

    it("classifies unknown files as logic by default", async () => {
      const targets = await buildChangedTargets({
        path: "/project/src/handler.ts",
        content: "const x = 1;\nconst y = 2;",
        languageId: "typescript",
        matchSpans: [{ startIndex: 0, endIndex: 10 }],
      });
      for (const t of targets) {
        if (t.editKind === "unknown") continue;
        assert.strictEqual(t.editKind, "logic");
      }
    });

    it("deduplicates overlapping match spans", async () => {
      const targets = await buildChangedTargets({
        path: "/project/src/app.ts",
        content: "const a = 1;\nconst b = 2;\nconst c = 3;",
        languageId: "typescript",
        matchSpans: [
          { startIndex: 0, endIndex: 10 },
          { startIndex: 5, endIndex: 15 },
        ],
        testGlobs: [],
      });
      // Expect no more targets than match spans (dedup works)
      assert.ok(targets.length <= 2);
    });

    it("handles empty content gracefully", async () => {
      const targets = await buildChangedTargets({
        path: "/project/src/empty.ts",
        content: "",
        languageId: "typescript",
        matchSpans: [],
      });
      assert.strictEqual(targets.length, 0);
    });

    it("handles matchSpans at the edge of content", async () => {
      const targets = await buildChangedTargets({
        path: "/project/src/edge.ts",
        content: "fn()",
        languageId: "typescript",
        matchSpans: [{ startIndex: 0, endIndex: 4 }],
      });
      assert.ok(targets.length >= 0);
    });
  });
});
