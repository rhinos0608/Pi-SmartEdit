/**
 * Tests for auto-validation hook — SmallCode-inspired validation pipeline.
 */
import { describe, test, afterEach, beforeEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import {
  checkStructural,
  runAutoValidation,
  formatValidationFeedback,
  suggestDecomposition,
  resetRetryCounts,
  incrementRetryCount,
} from "../src/verification/auto-validate";

// ─── Helpers ─────────────────────────────────────────────────────────

const tmpDir = resolve(tmpdir(), "smart-edit-auto-validate-test-" + Date.now());

function cleanup() {
  try {
    unlinkSync(resolve(tmpDir, "test.ts"));
  } catch { /* nop */ }
  try {
    unlinkSync(resolve(tmpDir, "test.js"));
  } catch { /* nop */ }
  try {
    unlinkSync(resolve(tmpDir, "test.py"));
  } catch { /* nop */ }
}

afterEach(cleanup);

// ─── Structural Check Tests ──────────────────────────────────────────

describe("checkStructural", () => {
  test("clean file passes", () => {
    const result = checkStructural(
      "function hello() {\n  return 'world';\n}\n",
      "/test/file.ts",
    );
    assert.strictEqual(result.passed, true);
    assert.deepStrictEqual(result.errors, []);
  });

  test("detects // TODO placeholder", () => {
    const result = checkStructural(
      "function hello() {\n  // TODO: implement\n  return null;\n}\n",
      "/test/file.ts",
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("TODO")));
  });

  test("detects # TODO placeholder (Python)", () => {
    const result = checkStructural(
      "def hello():\n    # TODO: implement\n    pass\n",
      "/test/file.py",
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("TODO")));
  });

  test("detects raise NotImplementedError", () => {
    const result = checkStructural(
      "def hello():\n    raise NotImplementedError\n",
      "/test/file.py",
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("NotImplementedError")));
  });

  test("detects truncation marker", () => {
    const result = checkStructural(
      "function hello() {\n// ... rest of implementation\n}\n",
      "/test/file.ts",
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("truncated")));
  });

  test("detects unbalanced braces", () => {
    const result = checkStructural(
      "function hello() {\n  if (true) {\n    return 1;\n  }\n",
      "/test/file.ts",
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("Unbalanced braces")));
  });

  test("detects unbalanced brackets", () => {
    const result = checkStructural(
      "const arr = [1, 2, [3, 4];\n",
      "/test/file.ts",
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("Unbalanced brackets")));
  });

  test("// ... counts as placeholder", () => {
    const result = checkStructural(
      "// ...\ncalledFunction();\n",
      "/test/file.ts",
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("placeholder")));
  });
});

// ─── Auto-validation Pipeline Tests ──────────────────────────────────

describe("runAutoValidation", () => {
  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    resetRetryCounts();
  });

  afterEach(cleanup);

  test("passes for clean TypeScript file", async () => {
    const content = "export function hello(): string {\n  return 'world';\n}\n";
    const filePath = resolve(tmpDir, "test.ts");
    writeFileSync(filePath, content);

    const result = await runAutoValidation(filePath, content, {
      cwd: tmpDir,
      maxRetries: 3,
    });

    assert.strictEqual(result.structural.passed, true);
    // Compiler may or may not be available; don't assert on diagnostics presence
    assert.strictEqual(typeof result.retryCount, "number");
    assert.strictEqual(typeof result.shouldDecompose, "boolean");
    assert.ok(result.summary.length > 0);
    assert.strictEqual(result.diagnosticSource !== undefined, true);
  });

  test("detects structural issues in file", async () => {
    const content = "function hello() {\n  // TODO: implement\n}\n";
    const filePath = resolve(tmpDir, "test.ts");
    writeFileSync(filePath, content);

    const result = await runAutoValidation(filePath, content, {
      cwd: tmpDir,
      maxRetries: 3,
    });

    assert.strictEqual(result.structural.passed, false);
    assert.strictEqual(result.passed, false);
  });

  test("increments retry count across calls", async () => {
    const content = "// TODO: implement\n";
    const filePath = resolve(tmpDir, "test.ts");
    writeFileSync(filePath, content);

    const r1 = await runAutoValidation(filePath, content, { cwd: tmpDir });
    const r2 = await runAutoValidation(filePath, content, { cwd: tmpDir });
    const r3 = await runAutoValidation(filePath, content, { cwd: tmpDir });
    const r4 = await runAutoValidation(filePath, content, { cwd: tmpDir, maxRetries: 3 });

    assert.strictEqual(r1.retryCount, 1);
    assert.strictEqual(r2.retryCount, 2);
    assert.strictEqual(r3.retryCount, 3);
    assert.strictEqual(r4.retryCount, 4);
    assert.strictEqual(r4.shouldDecompose, true); // 4 > 3 maxRetries
  });

  test("respects enabled: false", async () => {
    const content = "// TODO: implement\n";
    const filePath = resolve(tmpDir, "test.ts");
    writeFileSync(filePath, content);

    const result = await runAutoValidation(filePath, content, {
      cwd: tmpDir,
      enabled: false,
    });

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.diagnosticSource, "disabled");
  });
});

// ─── Format Validation Feedback Tests ────────────────────────────────

describe("formatValidationFeedback", () => {
  test("null for clean result", () => {
    const feedback = formatValidationFeedback({
      passed: true,
      structural: { passed: true, errors: [] },
      diagnostics: [],
      diagnosticSource: "none",
      retryCount: 0,
      shouldDecompose: false,
      summary: "✓ Auto-validation passed",
    });
    assert.strictEqual(feedback, null);
  });

  test("shows structural errors", () => {
    const feedback = formatValidationFeedback({
      passed: false,
      structural: {
        passed: false,
        errors: ["Unbalanced braces: 5 open, 3 close"],
      },
      diagnostics: [],
      diagnosticSource: "none",
      retryCount: 1,
      shouldDecompose: false,
      summary: "fail",
    });
    assert.ok(feedback !== null);
    assert.ok(feedback!.includes("Structural issues"));
    assert.ok(feedback!.includes("Unbalanced braces"));
  });

  test("shows diagnostics", () => {
    const feedback = formatValidationFeedback({
      passed: false,
      structural: { passed: true, errors: [] },
      diagnostics: [
        {
          message: "Type 'string' is not assignable to type 'number'",
          severity: 1,
          range: { start: { line: 4, character: 5 }, end: { line: 4, character: 12 } },
          source: "tsc",
        },
      ],
      diagnosticSource: "tsc",
      retryCount: 2,
      shouldDecompose: false,
      summary: "fail",
    });
    assert.ok(feedback !== null);
    assert.ok(feedback!.includes("tsc errors"));
    assert.ok(feedback!.includes("Type 'string'"));
  });

  test("shows decomposition hint when shouldDecompose", () => {
    const feedback = formatValidationFeedback({
      passed: false,
      structural: { passed: true, errors: [] },
      diagnostics: [],
      diagnosticSource: "none",
      retryCount: 4,
      shouldDecompose: true,
      summary: "fail",
    });
    assert.ok(feedback !== null);
    assert.ok(feedback!.includes("Max retries"));
    assert.ok(feedback!.includes("smaller steps"));
  });
});

// ─── Decomposition Suggestion Tests ──────────────────────────────────

describe("suggestDecomposition", () => {
  test("generates decomposition suggestion", () => {
    const suggestion = suggestDecomposition(
      "Add authentication middleware",
      [
        {
          message: "Cannot find module 'express'",
          severity: 1,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          source: "tsc",
        },
      ],
    );
    assert.ok(suggestion.includes("Decomposition"));
    assert.ok(suggestion.includes("Add authentication middleware"));
    assert.ok(suggestion.includes("Cannot find module"));
  });

  test("handles empty diagnostics", () => {
    const suggestion = suggestDecomposition("Refactor utils", []);
    assert.ok(suggestion.includes("Decomposition"));
    assert.ok(suggestion.includes("Refactor utils"));
  });
});

// ─── Retry Count Tracking Tests ──────────────────────────────────────

describe("retry count tracking", () => {
  beforeEach(() => {
    resetRetryCounts();
  });

  test("starts at 1", () => {
    const count = incrementRetryCount(tmpDir, "test.ts");
    assert.strictEqual(count, 1);
  });

  test("increments across calls", () => {
    incrementRetryCount(tmpDir, "test.ts");
    incrementRetryCount(tmpDir, "test.ts");
    const count = incrementRetryCount(tmpDir, "test.ts");
    assert.strictEqual(count, 3);
  });

  test("separate files have separate counts", () => {
    const a = incrementRetryCount(tmpDir, "a.ts");
    const b = incrementRetryCount(tmpDir, "b.ts");
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 1);
  });

  test("reset clears all counts", () => {
    incrementRetryCount(tmpDir, "test.ts");
    resetRetryCounts();
    const count = incrementRetryCount(tmpDir, "test.ts");
    assert.strictEqual(count, 1);
  });
});
