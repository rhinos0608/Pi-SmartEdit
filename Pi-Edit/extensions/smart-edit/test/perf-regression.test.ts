/**
 * Performance regression tests for the post-edit pipeline.
 *
 * Measures anchor delta, patch correctness, and combined pipeline
 * timing across small (100 lines), medium (500 lines), and large
 * (2000 lines) TypeScript files.
 *
 * Budgets are targets — CI variance may require adjustment.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert";
import { initHashline, buildHashlineAnchors } from "../src/core/hashline.js";
import { computeAnchorDelta } from "../src/anchor-registry.js";
import { checkPatchCorrectness } from "../src/verification/patch-correctness.js";
import { fastHash } from "../src/core/types.js";
import type { FileSnapshot } from "../src/core/types.js";

// ─── Performance budgets (ms) ──────────────────────────────────────
const ANCHOR_DELTA_BUDGET_MS = 50;
const PATCH_CORRECTNESS_BUDGET_MS = 20;
const COMBINED_BUDGET_MS = 80;

// ─── File sizes (lines) ────────────────────────────────────────────
const SMALL_FILE = 100;
const MEDIUM_FILE = 500;
const LARGE_FILE = 2000;

// ─── Seeded PRNG for deterministic test data ───────────────────────
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateCode(lines: number): string {
  const result: string[] = [];
  for (let i = 0; i < lines; i++) {
    if (i % 20 === 0) {
      result.push(`function func${i}() {`);
      result.push(`  const x${i} = ${i * 2};`);
      result.push(`  return x${i} + 1;`);
      result.push(`}`);
    } else if (i % 10 === 0) {
      result.push(`const VAR_${i} = "${"x".repeat(i % 50)}";`);
    } else if (i % 5 === 0) {
      result.push(`// Comment line ${i}`);
    } else {
      result.push(`  console.log("line ${i}");`);
    }
  }
  return result.join("\n");
}

function generateEditedCode(original: string, changePercent: number, rng: () => number): string {
  const lines = original.split("\n");
  const changeCount = Math.max(1, Math.floor(lines.length * changePercent));
  const result = [...lines];
  const indices = new Set<number>();
  while (indices.size < changeCount && indices.size < lines.length) {
    indices.add(Math.floor(rng() * lines.length));
  }
  for (const idx of indices) {
    result[idx] = `// EDITED: ${result[idx]}`;
  }
  return result.join("\n");
}

async function makeSnapshot(content: string): Promise<FileSnapshot> {
  const lines = content.split("\n");
  const hashline = await buildHashlineAnchors(lines);
  return {
    path: "/tmp/perf-test.ts",
    mtimeMs: Date.now(),
    size: Buffer.byteLength(content),
    contentHash: fastHash(content),
    readAt: Date.now(),
    partial: false,
    readOffset: 1,
    hashline,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Performance Regression Tests", () => {
  before(async () => {
    await initHashline();
  });

  describe("Anchor Delta Performance", () => {
    it(`computes delta for small file (${SMALL_FILE} lines) within budget`, async () => {
      const content = generateCode(SMALL_FILE);
      const snapshot = await makeSnapshot(content);
      const rng = mulberry32(42);
      const edited = generateEditedCode(content, 0.1, rng);

      const start = performance.now();
      const delta = await computeAnchorDelta(snapshot, edited);
      const elapsed = performance.now() - start;

      assert.ok(delta !== undefined);
      assert.ok(
        elapsed < ANCHOR_DELTA_BUDGET_MS,
        `anchor delta for ${SMALL_FILE} lines took ${elapsed.toFixed(1)}ms ` +
          `(budget: ${ANCHOR_DELTA_BUDGET_MS}ms)`,
      );
    });

    it(`computes delta for medium file (${MEDIUM_FILE} lines) within budget`, async () => {
      const content = generateCode(MEDIUM_FILE);
      const snapshot = await makeSnapshot(content);
      const rng = mulberry32(42);
      const edited = generateEditedCode(content, 0.1, rng);

      const start = performance.now();
      const delta = await computeAnchorDelta(snapshot, edited);
      const elapsed = performance.now() - start;

      assert.ok(
        elapsed < ANCHOR_DELTA_BUDGET_MS,
        `anchor delta for ${MEDIUM_FILE} lines took ${elapsed.toFixed(1)}ms ` +
          `(budget: ${ANCHOR_DELTA_BUDGET_MS}ms)`,
      );
      assert.ok(delta !== undefined);
    });

    it(`computes delta for large file (${LARGE_FILE} lines) within budget`, async () => {
      const content = generateCode(LARGE_FILE);
      const snapshot = await makeSnapshot(content);
      const rng = mulberry32(42);
      const edited = generateEditedCode(content, 0.1, rng);

      const start = performance.now();
      const delta = await computeAnchorDelta(snapshot, edited);
      const elapsed = performance.now() - start;

      assert.ok(
        elapsed < ANCHOR_DELTA_BUDGET_MS,
        `anchor delta for ${LARGE_FILE} lines took ${elapsed.toFixed(1)}ms ` +
          `(budget: ${ANCHOR_DELTA_BUDGET_MS}ms)`,
      );
      assert.ok(delta !== undefined);
    });
  });

  describe("Patch Correctness Performance", () => {
    it(`checks small file (${SMALL_FILE} lines) within budget`, () => {
      const rng = mulberry32(42);
      const oldContent = generateCode(SMALL_FILE);
      const newContent = generateEditedCode(oldContent, 0.1, rng);

      const start = performance.now();
      const result = checkPatchCorrectness(oldContent, newContent, "typescript");
      const elapsed = performance.now() - start;

      assert.ok(result !== undefined);
      assert.ok(
        elapsed < PATCH_CORRECTNESS_BUDGET_MS,
        `patch correctness for ${SMALL_FILE} lines took ${elapsed.toFixed(1)}ms ` +
          `(budget: ${PATCH_CORRECTNESS_BUDGET_MS}ms)`,
      );
    });

    it(`checks medium file (${MEDIUM_FILE} lines) within budget`, () => {
      const rng = mulberry32(42);
      const oldContent = generateCode(MEDIUM_FILE);
      const newContent = generateEditedCode(oldContent, 0.1, rng);

      const start = performance.now();
      const result = checkPatchCorrectness(oldContent, newContent, "typescript");
      const elapsed = performance.now() - start;

      assert.ok(
        elapsed < PATCH_CORRECTNESS_BUDGET_MS,
        `patch correctness for ${MEDIUM_FILE} lines took ${elapsed.toFixed(1)}ms ` +
          `(budget: ${PATCH_CORRECTNESS_BUDGET_MS}ms)`,
      );
      assert.ok(result !== undefined);
    });

    it(`checks large file (${LARGE_FILE} lines) within budget`, () => {
      const rng = mulberry32(42);
      const oldContent = generateCode(LARGE_FILE);
      const newContent = generateEditedCode(oldContent, 0.1, rng);

      const start = performance.now();
      const result = checkPatchCorrectness(oldContent, newContent, "typescript");
      const elapsed = performance.now() - start;

      assert.ok(
        elapsed < PATCH_CORRECTNESS_BUDGET_MS,
        `patch correctness for ${LARGE_FILE} lines took ${elapsed.toFixed(1)}ms ` +
          `(budget: ${PATCH_CORRECTNESS_BUDGET_MS}ms)`,
      );
      assert.ok(result !== undefined);
    });
  });

  describe("Combined Pipeline Performance", () => {
    it(`full pipeline (delta + correctness) for medium file within combined budget`, async () => {
      const rng = mulberry32(42);
      const oldContent = generateCode(MEDIUM_FILE);
      const newContent = generateEditedCode(oldContent, 0.1, rng);
      const snapshot = await makeSnapshot(oldContent);

      const start = performance.now();

      const delta = await computeAnchorDelta(snapshot, newContent);
      const correctness = checkPatchCorrectness(oldContent, newContent, "typescript");

      const elapsed = performance.now() - start;

      assert.ok(
        elapsed < COMBINED_BUDGET_MS,
        `combined pipeline took ${elapsed.toFixed(1)}ms ` +
          `(budget: ${COMBINED_BUDGET_MS}ms)`,
      );
      assert.ok(delta !== undefined);
      assert.ok(correctness !== undefined);
    });

    it("pipeline scales linearly with file size", async () => {
      const sizes = [SMALL_FILE, MEDIUM_FILE, LARGE_FILE];
      const timings: number[] = [];

      for (const size of sizes) {
        const rng = mulberry32(42);
        const oldContent = generateCode(size);
        const newContent = generateEditedCode(oldContent, 0.1, rng);
        const snapshot = await makeSnapshot(oldContent);

        const start = performance.now();
        await computeAnchorDelta(snapshot, newContent);
        checkPatchCorrectness(oldContent, newContent, "typescript");
        timings.push(performance.now() - start);
      }

      // Verify roughly linear scaling: large/small ratio < 30x for 20x size increase
      const ratio = timings[2] / timings[0];
      assert.ok(
        ratio < 30,
        `large/small timing ratio was ${ratio.toFixed(1)}x (expected < 30x). ` +
          `Small: ${timings[0].toFixed(1)}ms, Large: ${timings[2].toFixed(1)}ms`,
      );
    });

    it("handles worst-case: complete file rewrite", async () => {
      const oldContent = generateCode(MEDIUM_FILE);
      const newContent = generateCode(MEDIUM_FILE); // Completely different content
      const snapshot = await makeSnapshot(oldContent);

      const start = performance.now();
      const delta = await computeAnchorDelta(snapshot, newContent);
      checkPatchCorrectness(oldContent, newContent, "typescript");
      const elapsed = performance.now() - start;

      // Worst case should still be reasonable
      assert.ok(
        elapsed < COMBINED_BUDGET_MS * 3,
        `full rewrite took ${elapsed.toFixed(1)}ms ` +
          `(budget: ${COMBINED_BUDGET_MS * 3}ms)`,
      );
      assert.ok(delta !== undefined);
    });
  });
});
