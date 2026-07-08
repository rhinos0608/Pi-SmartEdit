/**
 * Integration tests for the Pi-SmartEdit → Pi-SmartRead anchor delta flow.
 *
 * Tests the full pipeline: snapshot → edit → delta → model notification,
 * bridging anchor-registry and hashline modules.
 *
 * Covers:
 *   - computeAnchorDelta: shifted, deleted, changed, empty, edge cases
 *   - formatAnchorDeltaForModel: empty, shifted, deleted, changed, churn threshold
 *   - End-to-end: simulated edit pipeline produces correct delta + notification
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

import { initHashline, buildHashlineAnchors } from "../src/core/hashline.js";
import {
  computeAnchorDelta,
  formatAnchorDeltaForModel,
  ANCHOR_CHURN_THRESHOLD,
} from "../src/anchor-registry.js";
import type { AnchorDelta } from "../src/anchor-registry.js";
import { fastHash } from "../src/core/types.js";
import type { FileSnapshot } from "../src/core/types.js";

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Tests ──────────────────────────────────────────────────────

describe("Anchor Hygiene Bridge", () => {
  let tmpDir: string;

  before(async () => {
    await initHashline();
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "anchor-hygiene-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: create a FileSnapshot from content, computing hashline anchors.
  async function makeSnapshot(
    content: string,
    path?: string,
  ): Promise<FileSnapshot> {
    const lines = content.split("\n");
    const hashline = await buildHashlineAnchors(lines);
    return {
      path: path ?? join(tmpDir, "test.ts"),
      mtimeMs: Date.now(),
      size: Buffer.byteLength(content),
      contentHash: fastHash(content),
      readAt: Date.now(),
      partial: false,
      readOffset: 1,
      hashline,
    };
  }

  // ── computeAnchorDelta ───────────────────────────────────────

  describe("computeAnchorDelta", () => {
    it("detects shifted anchors after line insertion", async () => {
      const oldContent = "line1\nline2\nline3\nline4";
      const snapshot = await makeSnapshot(oldContent);
      // Insert a line between line1 and line2
      const newContent = "line1\ninserted\nline2\nline3\nline4";
      const delta = await computeAnchorDelta(snapshot, newContent);

      // Lines 2,3,4 all shifted down by 1
      assert.ok(delta.shifted.length > 0);
      assert.strictEqual(delta.deleted.length, 0);
      const shiftedLines = delta.shifted.map((s) => s.oldLine).sort();
      assert.ok(shiftedLines.includes(2));
      assert.ok(shiftedLines.includes(3));
      assert.ok(shiftedLines.includes(4));
    });

    it("detects deleted anchors after line removal from end", async () => {
      const oldContent = "line1\nline2\nline3\nline4";
      const snapshot = await makeSnapshot(oldContent);
      // Remove last two lines — old line positions 3 and 4 no longer exist
      const newContent = "line1\nline2";
      const delta = await computeAnchorDelta(snapshot, newContent);

      assert.strictEqual(delta.deleted.length, 2);
      assert.strictEqual(delta.changed.length, 0);
    });

    it("detects changed anchors after content modification", async () => {
      const oldContent = "const x = 1;\nconst y = 2;\nconst z = 3;";
      const snapshot = await makeSnapshot(oldContent);
      // Change line 2 content
      const newContent = "const x = 1;\nconst y = 99;\nconst z = 3;";
      const delta = await computeAnchorDelta(snapshot, newContent);

      assert.strictEqual(delta.changed.length, 1);
      assert.strictEqual(delta.changed[0].oldLine, 2);
      assert.strictEqual(delta.changed[0].newLine, 2);
      assert.strictEqual(delta.changed[0].contentChanged, true);
    });

    it("returns empty delta when nothing changed", async () => {
      const content = "line1\nline2\nline3";
      const snapshot = await makeSnapshot(content);
      const delta = await computeAnchorDelta(snapshot, content);

      assert.strictEqual(delta.shifted.length, 0);
      assert.strictEqual(delta.deleted.length, 0);
      assert.strictEqual(delta.changed.length, 0);
    });

    it("handles empty snapshot (no hashline) gracefully", async () => {
      const snapshot: FileSnapshot = {
        path: join(tmpDir, "empty.ts"),
        mtimeMs: 0,
        size: 0,
        contentHash: "",
        readAt: 0,
        partial: false,
        readOffset: 1,
      };
      const delta = await computeAnchorDelta(snapshot, "anything");
      assert.strictEqual(delta.shifted.length, 0);
      assert.strictEqual(delta.deleted.length, 0);
      assert.strictEqual(delta.changed.length, 0);
    });

    it("handles complete file replacement", async () => {
      const oldContent = "function old() { return 1; }";
      const snapshot = await makeSnapshot(oldContent);
      const newContent =
        "function newFunc() { return 2; }\nfunction extra() {}";
      const delta = await computeAnchorDelta(snapshot, newContent);

      // Original single line not found in new content, but its line
      // position (1) still exists → classified as changed
      assert.strictEqual(delta.changed.length, 1);
    });

    it("detects both shifted and deleted in same delta", async () => {
      const oldContent = "lineA\nlineB\nlineC\nlineD\nlineE";
      const snapshot = await makeSnapshot(oldContent);
      // Remove lineB and lineD, keep the rest
      const newContent = "lineA\nlineC\nlineE";
      const delta = await computeAnchorDelta(snapshot, newContent);

      // lineC (oldLine=3) found at newLine=2 → shifted
      // lineE (oldLine=5) found at newLine=3 → shifted
      assert.strictEqual(delta.shifted.length, 2);
      // lineB (oldLine=2): not found, lineNum(2) <= 3 → changed
      // lineD (oldLine=4): not found, lineNum(4) > 3 → deleted
      assert.strictEqual(delta.changed.length, 1);
      assert.strictEqual(delta.deleted.length, 1);
    });
  });

  // ── formatAnchorDeltaForModel ────────────────────────────────

  describe("formatAnchorDeltaForModel", () => {
    it("returns null for empty delta", () => {
      const delta: AnchorDelta = { shifted: [], deleted: [], changed: [] };
      assert.strictEqual(formatAnchorDeltaForModel(delta), null);
    });

    it("formats shifted anchors concisely", () => {
      const delta: AnchorDelta = {
        shifted: [
          { hash: "ab", oldLine: 2, newLine: 3, contentChanged: false },
          { hash: "cd", oldLine: 3, newLine: 4, contentChanged: false },
        ],
        deleted: [],
        changed: [],
      };
      const result = formatAnchorDeltaForModel(delta);
      assert.ok(result !== null);
      assert.ok(result!.includes("2 shifted"));
      assert.ok(result!.includes("L2→L3"));
    });

    it("formats deleted anchors", () => {
      const delta: AnchorDelta = {
        shifted: [],
        deleted: [{ hash: "ab", status: "deleted" }],
        changed: [],
      };
      const result = formatAnchorDeltaForModel(delta);
      assert.ok(result !== null);
      assert.ok(result!.includes("1 deleted"));
    });

    it("formats changed anchors", () => {
      const delta: AnchorDelta = {
        shifted: [],
        deleted: [],
        changed: [
          {
            hash: "ab",
            newHash: "cd",
            oldLine: 5,
            newLine: 5,
            contentChanged: true,
          },
        ],
      };
      const result = formatAnchorDeltaForModel(delta);
      assert.ok(result !== null);
      assert.ok(result!.includes("1 changed"));
      assert.ok(result!.includes("L5"));
    });

    it("collapses to structural summary above default churn threshold", () => {
      const shifted = Array.from({ length: ANCHOR_CHURN_THRESHOLD + 5 }, (_, i) => ({
        hash: "xx" as const,
        oldLine: i + 1,
        newLine: i + 2,
        contentChanged: false as const,
      }));
      const delta: AnchorDelta = { shifted, deleted: [], changed: [] };
      const result = formatAnchorDeltaForModel(delta);
      assert.ok(result !== null);
      assert.ok(result!.includes("significant structural change"));
      assert.ok(result!.includes("re-read"));
    });

    it("respects custom churn threshold", () => {
      const shifted = Array.from({ length: 5 }, (_, i) => ({
        hash: "xx" as const,
        oldLine: i + 1,
        newLine: i + 2,
        contentChanged: false as const,
      }));
      const delta: AnchorDelta = { shifted, deleted: [], changed: [] };
      // Threshold of 3, so 5 changes should collapse
      const result = formatAnchorDeltaForModel(delta, 3);
      assert.ok(result !== null);
      assert.ok(result!.includes("significant structural change"));
    });

    it("keeps per-line detail below churn threshold", () => {
      const shifted = Array.from({ length: 3 }, (_, i) => ({
        hash: "xx" as const,
        oldLine: i + 1,
        newLine: i + 2,
        contentChanged: false as const,
      }));
      const delta: AnchorDelta = { shifted, deleted: [], changed: [] };
      const result = formatAnchorDeltaForModel(delta, 5);
      assert.ok(result !== null);
      assert.ok(result!.includes("shifted"));
      assert.ok(!result!.includes("significant"));
    });
  });

  // ── End-to-end: snapshot → edit → delta → notification ──────

  describe("end-to-end: snapshot → edit → delta → notification", () => {
    it("produces correct delta after simulated line insertion", async () => {
      // Empty lines and structural lines (like "}") use line-number-dependent
      // hashing, which prevents clean shift detection.  This fixture uses
      // only content-based lines (every line has alphanumeric chars) so all
      // post-insertion anchors shift cleanly.
      const originalContent = [
        "import { foo } from './foo';",
        "function main() {",
        "  const x = foo();",
        "  return x + 1;",
        "}",
        "export { main };",
      ].join("\n");

      const snapshot = await makeSnapshot(originalContent);

      // Simulate edit: add an import line after the first import
      const editedContent = [
        "import { foo } from './foo';",
        "import { bar } from './bar';",
        "function main() {",
        "  const x = foo();",
        "  return x + 1;",
        "}",
        "export { main };",
      ].join("\n");

      const delta = await computeAnchorDelta(snapshot, editedContent);
      const notification = formatAnchorDeltaForModel(delta);

      // All lines after the insertion shifted down by 1
      assert.ok(delta.shifted.length > 0);
      assert.strictEqual(delta.deleted.length, 0);
      assert.strictEqual(delta.changed.length, 0);
      assert.ok(notification !== null);
      assert.ok(notification!.includes("shifted"));
    });

    it("produces correct delta after deleting last line", async () => {
      const originalContent = [
        "function a() { return 1; }",
        "function b() { return 2; }",
        "function c() { return 3; }",
      ].join("\n");

      const snapshot = await makeSnapshot(originalContent);

      // Delete the last function (c) — end-of-file removal produces
      // a deleted anchor (lineNum > new file length).
      const editedContent = [
        "function a() { return 1; }",
        "function b() { return 2; }",
      ].join("\n");

      const delta = await computeAnchorDelta(snapshot, editedContent);
      const notification = formatAnchorDeltaForModel(delta);

      assert.strictEqual(delta.deleted.length, 1);
      assert.strictEqual(delta.shifted.length, 0);
      assert.strictEqual(delta.changed.length, 0);
      assert.ok(notification !== null);
      assert.ok(notification!.includes("deleted"));
    });

    it("produces mixed delta after middle-line removal", async () => {
      const originalContent = [
        "function a() { return 1; }",
        "function b() { return 2; }",
        "function c() { return 3; }",
      ].join("\n");

      const snapshot = await makeSnapshot(originalContent);

      // Delete middle function (b) — line position 2 still exists
      // but with different content (function c moved up), so:
      //   - old line 2 (b): changed (position exists, content replaced)
      //   - old line 3 (c): shifted (content found at earlier line)
      const editedContent = [
        "function a() { return 1; }",
        "function c() { return 3; }",
      ].join("\n");

      const delta = await computeAnchorDelta(snapshot, editedContent);
      const notification = formatAnchorDeltaForModel(delta);

      assert.strictEqual(delta.changed.length, 1);
      assert.strictEqual(delta.shifted.length, 1);
      assert.strictEqual(delta.deleted.length, 0);
      assert.ok(notification !== null);
      assert.ok(notification!.includes("changed"));
      assert.ok(notification!.includes("shifted"));
    });
  });
});
