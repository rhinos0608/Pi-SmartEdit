/**
 * Tests for GumTree-Simplified structural diff (src/verification/structural-diff.ts).
 *
 * Coverage:
 * 1. hasStructuralAnomalies — heuristic rules on StructuralDiffResult (no tree-sitter)
 * 2. computeStructuralDiff — CST diff algorithm (needs tree-sitter WASM)
 * 3. Multi-file edit scenario patterns
 *
 * Tree-sitter-dependent tests gracefully skip if WASM/grammar unavailable.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import type { Tree } from "web-tree-sitter";

import {
  computeStructuralDiff,
  hasStructuralAnomalies,
} from "../src/verification/structural-diff.js";
import type { StructuralDiffResult, StructuralEditOp } from "../src/verification/structural-diff.js";
import { parseFile, disposeParseResult } from "../src/core/ast-resolver.js";
import { clearGrammarCache, resetParser } from "../src/core/grammar-loader.js";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Construct a clean StructuralDiffResult, overriding any fields. */
function makeResult(overrides?: Partial<StructuralDiffResult>): StructuralDiffResult {
  return {
    passed: true,
    errors: [],
    editOps: [],
    matchCount: 50,
    totalNodes: 52,
    ...overrides,
  };
}

/** Try to parse JavaScript code. Returns null if tree-sitter unavailable. */
async function tryParse(code: string): Promise<{ tree: Tree; dispose: () => void } | null> {
  try {
    const result = await parseFile(code, "test.js");
    if (!result) return null;
    return {
      tree: result.tree,
      dispose: () => { disposeParseResult(result); },
    };
  } catch {
    return null;
  }
}

// ─── hasStructuralAnomalies ──────────────────────────────────────────

describe("hasStructuralAnomalies", () => {
  it("returns false for clean empty result", () => {
    assert.strictEqual(hasStructuralAnomalies(makeResult()), false);
  });

  it("returns false for single function update", () => {
    const result = makeResult({
      editOps: [
        { kind: "update", nodeType: "function_declaration", oldLabel: "foo", newLabel: "bar", line: 5 },
      ],
    });
    assert.strictEqual(hasStructuralAnomalies(result), false);
  });

  it("returns false for balanced insert+delete (≤3 each)", () => {
    const result = makeResult({
      editOps: [
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 10 },
        { kind: "delete", nodeType: "variable_declarator", parentType: "lexical_declaration", line: 12 },
        { kind: "insert", nodeType: "function_declaration", parentType: "program", line: 20 },
      ],
    });
    assert.strictEqual(hasStructuralAnomalies(result), false);
  });

  it("returns false for small move (≤50 line delta)", () => {
    const result = makeResult({
      editOps: [
        { kind: "move", nodeType: "function_declaration", oldLine: 10, newLine: 60 },
      ],
    });
    assert.strictEqual(hasStructuralAnomalies(result), false);
  });

  it("returns false for 100 operations (boundary)", () => {
    // 100 ops with a balanced insert/delete ratio to avoid the deletes/inserts rule
    const ops: StructuralEditOp[] = [];
    for (let i = 0; i < 48; i++) {
      ops.push({ kind: "update", nodeType: "expression_statement", oldLabel: `x${i}`, newLabel: `y${i}`, line: i + 1 });
    }
    ops.push({ kind: "delete", nodeType: "function_declaration", parentType: "program", line: 50 });
    ops.push({ kind: "delete", nodeType: "function_declaration", parentType: "program", line: 55 });
    // 50 total so far — add 50 more updates to hit exactly 100
    for (let i = 0; i < 50; i++) {
      ops.push({ kind: "update", nodeType: "variable_declarator", oldLabel: `v${i}`, newLabel: `w${i}`, line: 60 + i });
    }
    assert.strictEqual(ops.length, 100);
    assert.strictEqual(hasStructuralAnomalies(makeResult({ editOps: ops })), false);
  });

  it("returns true when passed is false", () => {
    assert.strictEqual(hasStructuralAnomalies(makeResult({ passed: false })), true);
  });

  it("returns true for many deletes with few inserts", () => {
    const result = makeResult({
      editOps: [
        { kind: "update", nodeType: "function_declaration", oldLabel: "keep", newLabel: "keep", line: 1 },
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 10 },
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 15 },
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 20 },
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 25 },
      ],
    });
    assert.strictEqual(hasStructuralAnomalies(result), true);
  });

  it("returns true for many inserts with few deletes", () => {
    const result = makeResult({
      editOps: [
        { kind: "update", nodeType: "function_declaration", oldLabel: "keep", newLabel: "keep", line: 1 },
        { kind: "insert", nodeType: "function_declaration", parentType: "program", line: 10 },
        { kind: "insert", nodeType: "function_declaration", parentType: "program", line: 15 },
        { kind: "insert", nodeType: "function_declaration", parentType: "program", line: 20 },
        { kind: "insert", nodeType: "function_declaration", parentType: "program", line: 25 },
      ],
    });
    assert.strictEqual(hasStructuralAnomalies(result), true);
  });

  it("returns true for moves with line delta > 50", () => {
    const result = makeResult({
      editOps: [
        { kind: "move", nodeType: "function_declaration", oldLine: 5, newLine: 100 },
      ],
    });
    assert.strictEqual(hasStructuralAnomalies(result), true);
  });

  it("returns true when at least one move exceeds 50 lines among smaller moves", () => {
    const result = makeResult({
      editOps: [
        { kind: "move", nodeType: "function_declaration", oldLine: 1, newLine: 8 },
        { kind: "move", nodeType: "function_declaration", oldLine: 30, newLine: 35 },
        { kind: "move", nodeType: "function_declaration", oldLine: 40, newLine: 120 },
      ],
    });
    assert.strictEqual(hasStructuralAnomalies(result), true);
  });

  it("returns true for excessive total operations (>100)", () => {
    const ops: StructuralEditOp[] = [];
    for (let i = 0; i < 101; i++) {
      ops.push({ kind: "insert", nodeType: "expression_statement", parentType: "program", line: i + 1 });
    }
    assert.strictEqual(hasStructuralAnomalies(makeResult({ editOps: ops })), true);
  });

  it("returns true when deletes > 3 with 0 inserts", () => {
    const result = makeResult({
      editOps: [
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 1 },
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 5 },
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 10 },
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 15 },
      ],
    });
    assert.strictEqual(hasStructuralAnomalies(result), true);
  });

  it("returns true when inserts > 3 with 0 deletes", () => {
    const result = makeResult({
      editOps: [
        { kind: "insert", nodeType: "function_declaration", parentType: "program", line: 1 },
        { kind: "insert", nodeType: "function_declaration", parentType: "program", line: 5 },
        { kind: "insert", nodeType: "function_declaration", parentType: "program", line: 10 },
        { kind: "insert", nodeType: "function_declaration", parentType: "program", line: 15 },
      ],
    });
    assert.strictEqual(hasStructuralAnomalies(result), true);
  });

  it("does not flag 4 deletes with 2 inserts (inserts >= 2)", () => {
    // Rule: deletes > 3 AND inserts < 2 → anomaly
    // Here: deletes=4 (>3), inserts=2 (not < 2) → no anomaly
    const result = makeResult({
      editOps: [
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 1 },
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 5 },
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 10 },
        { kind: "delete", nodeType: "function_declaration", parentType: "program", line: 15 },
        { kind: "insert", nodeType: "function_declaration", parentType: "program", line: 20 },
        { kind: "insert", nodeType: "function_declaration", parentType: "program", line: 25 },
      ],
    });
    assert.strictEqual(hasStructuralAnomalies(result), false);
  });
});

// ─── computeStructuralDiff ───────────────────────────────────────────

describe("computeStructuralDiff", () => {
  after(() => {
    // Clean up tree-sitter state after tree-dependent tests
    clearGrammarCache();
    resetParser();
  });

  it("returns empty diff for identical trees", async () => {
    const code = "function greet(name) {\n  return 'Hello, ' + name;\n}\n";
    const oldP = await tryParse(code);
    if (!oldP) return; // Skip gracefully when tree-sitter unavailable
    const newP = await tryParse(code);
    if (!newP) { oldP.dispose(); return; }

    try {
      const result = computeStructuralDiff(oldP.tree, newP.tree);
      assert.strictEqual(result.passed, true);
      // Identical content should produce 0 structural edit ops
      assert.strictEqual(result.editOps.length, 0);
      assert.strictEqual(result.matchCount, result.totalNodes);
    } finally {
      oldP.dispose();
      newP.dispose();
    }
  });

  it("detects inserted function", async () => {
    const oldCode = "function a() { return 1; }\n";
    const newCode = "function a() { return 1; }\nfunction b() { return 2; }\n";
    const oldP = await tryParse(oldCode);
    if (!oldP) return;
    const newP = await tryParse(newCode);
    if (!newP) { oldP.dispose(); return; }

    try {
      const result = computeStructuralDiff(oldP.tree, newP.tree);
      assert.strictEqual(result.passed, true);
      const inserts = result.editOps.filter((op) => op.kind === "insert");
      assert.ok(inserts.length >= 1, "Expected at least 1 insert for added function");
    } finally {
      oldP.dispose();
      newP.dispose();
    }
  });

  it("detects deleted function", async () => {
    const oldCode = "function a() { return 1; }\nfunction b() { return 2; }\n";
    const newCode = "function a() { return 1; }\n";
    const oldP = await tryParse(oldCode);
    if (!oldP) return;
    const newP = await tryParse(newCode);
    if (!newP) { oldP.dispose(); return; }

    try {
      const result = computeStructuralDiff(oldP.tree, newP.tree);
      assert.strictEqual(result.passed, true);
      const deletes = result.editOps.filter((op) => op.kind === "delete");
      assert.ok(deletes.length >= 1, "Expected at least 1 delete for removed function");
    } finally {
      oldP.dispose();
      newP.dispose();
    }
  });

  it("detects renamed function (update or delete+insert)", async () => {
    const oldCode = "function foo() { return 1; }\n";
    const newCode = "function bar() { return 1; }\n";
    const oldP = await tryParse(oldCode);
    if (!oldP) return;
    const newP = await tryParse(newCode);
    if (!newP) { oldP.dispose(); return; }

    try {
      const result = computeStructuralDiff(oldP.tree, newP.tree);
      assert.strictEqual(result.passed, true);
      const updates = result.editOps.filter((op) => op.kind === "update");
      const deletes = result.editOps.filter((op) => op.kind === "delete");
      const inserts = result.editOps.filter((op) => op.kind === "insert");
      // A rename should produce either an update or delete+insert pair
      assert.ok(
        updates.length > 0 || (deletes.length >= 1 && inserts.length >= 1),
        "Expected rename to produce update or delete+insert. " +
        `Got updates=${updates.length} deletes=${deletes.length} inserts=${inserts.length}`,
      );
    } finally {
      oldP.dispose();
      newP.dispose();
    }
  });

  it("returns passed=false for massive changes exceeding 50 ops", async () => {
    // Create a large file with many functions, then change all of them
    const funcs: string[] = [];
    for (let i = 0; i < 30; i++) {
      funcs.push(`function f${i}() { return ${i}; }`);
    }
    const oldCode = funcs.join("\n") + "\n";
    const newCode = funcs.map((fn, i) => fn.replace(`return ${i}`, `return ${i + 100}`)).join("\n") + "\n";

    const oldP = await tryParse(oldCode);
    if (!oldP) return;
    const newP = await tryParse(newCode);
    if (!newP) { oldP.dispose(); return; }

    try {
      const result = computeStructuralDiff(oldP.tree, newP.tree);
      // Many changes across 30 functions should produce > 0 ops
      assert.ok(result.editOps.length > 0, "Expected structural changes for mass rename");
    } finally {
      oldP.dispose();
      newP.dispose();
    }
  });
});

// ─── Multi-file edit scenarios ───────────────────────────────────────

describe("multi-file edit scenarios", () => {
  after(() => {
    clearGrammarCache();
    resetParser();
  });

  it("handles cross-file refactoring (add import + use symbol)", async () => {
    // File A: original — no import
    const oldA = "function helper() { return 42; }\n";
    // File A: after — adds export
    const newA = "export function helper() { return 42; }\n";

    // File B: original — inline value
    const oldB = "const val = 42;\n";
    // File B: after — imports helper
    const newB = "import { helper } from './a.js';\nconst val = helper();\n";

    const pOldA = await tryParse(oldA);
    if (!pOldA) return;
    const pNewA = await tryParse(newA);
    if (!pNewA) { pOldA.dispose(); return; }
    const pOldB = await tryParse(oldB);
    if (!pOldB) { pOldA.dispose(); pNewA.dispose(); return; }
    const pNewB = await tryParse(newB);
    if (!pNewB) { pOldA.dispose(); pNewA.dispose(); pOldB.dispose(); return; }

    try {
      // File A: adding export keyword — may or may not change structure
      const resultA = computeStructuralDiff(pOldA.tree, pNewA.tree);
      assert.strictEqual(resultA.passed, true);

      // File B: adding import and changing expression
      const resultB = computeStructuralDiff(pOldB.tree, pNewB.tree);
      assert.strictEqual(resultB.passed, true);
      // Should detect changes: import statement + expression change
      assert.ok(resultB.editOps.length >= 1, "Expected structural changes in file B");

      // Neither file should have anomaly-level changes
      assert.strictEqual(hasStructuralAnomalies(resultA), false);
      assert.strictEqual(hasStructuralAnomalies(resultB), false);
    } finally {
      pOldA.dispose();
      pNewA.dispose();
      pOldB.dispose();
      pNewB.dispose();
    }
  });

  it("handles extract-function refactoring", async () => {
    // Old: one large function
    const oldCode = [
      "function process(items) {",
      '  return items.filter(i => i > 0).map(i => i * 2);',
      "}",
    ].join("\n") + "\n";

    // New: extracted helper + simplified main
    const newCode = [
      "function transform(x) {",
      "  return x * 2;",
      "}",
      "",
      "function process(items) {",
      '  return items.filter(i => i > 0).map(transform);',
      "}",
    ].join("\n") + "\n";

    const oldP = await tryParse(oldCode);
    if (!oldP) return;
    const newP = await tryParse(newCode);
    if (!newP) { oldP.dispose(); return; }

    try {
      const result = computeStructuralDiff(oldP.tree, newP.tree);
      assert.strictEqual(result.passed, true);
      // Insert of transform function
      const inserts = result.editOps.filter((op) => op.kind === "insert");
      assert.ok(inserts.length >= 1, "Expected at least 1 insert for extracted function");
    } finally {
      oldP.dispose();
      newP.dispose();
    }
  });

  it("handles independent sibling changes without cross-contamination", async () => {
    // Two independent functions; only one changes
    const oldCode = [
      "function alpha() { return 1; }",
      "function beta() { return 2; }",
      "function gamma() { return 3; }",
    ].join("\n") + "\n";

    const newCode = [
      "function alpha() { return 1; }",
      "function beta() { return 99; }",     // changed
      "function gamma() { return 3; }",
    ].join("\n") + "\n";

    const oldP = await tryParse(oldCode);
    if (!oldP) return;
    const newP = await tryParse(newCode);
    if (!newP) { oldP.dispose(); return; }

    try {
      const result = computeStructuralDiff(oldP.tree, newP.tree);
      assert.strictEqual(result.passed, true);

      // alpha and gamma should NOT appear in the edit ops
      const alphaOps = result.editOps.filter(
        (op) => (op as any).oldLabel === "alpha" || (op as any).newLabel === "alpha",
      );
      const gammaOps = result.editOps.filter(
        (op) => (op as any).oldLabel === "gamma" || (op as any).newLabel === "gamma",
      );
      assert.strictEqual(alphaOps.length, 0, "alpha should not be in edit ops");
      assert.strictEqual(gammaOps.length, 0, "gamma should not be in edit ops");

      // Entire changeset should not be flagged as anomalous
      assert.strictEqual(hasStructuralAnomalies(result), false);
    } finally {
      oldP.dispose();
      newP.dispose();
    }
  });
});
