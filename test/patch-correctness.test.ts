/**
 * Golden tests for patch-correctness families.
 * Locks warning text/order and safePass semantics across the Seam3 split.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { checkPatchCorrectness } from "../src/verification/patch-correctness.js";

describe("patch-correctness golden: clean edit passes", () => {
  it("balanced edit yields passed=true, no warnings", () => {
    const oldContent = "function foo() {\n  return 1;\n}\n";
    const newContent = "function foo() {\n  return 2;\n}\n";
    const r = checkPatchCorrectness(oldContent, newContent, "typescript");
    assert.strictEqual(r.passed, true);
    assert.deepStrictEqual(r.warnings, []);
  });
});

describe("patch-correctness golden: unbalanced delimiters", () => {
  it("flags unbalanced brace delta", () => {
    const oldContent = "function foo() {\n  return 1;\n}\n";
    const newContent = "function foo() {\n  if (x) {\n    return 1;\n}\n";
    const r = checkPatchCorrectness(oldContent, newContent, "typescript");
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.checks.unbalancedDelimiters.passed, false);
    assert.match(r.warnings[0], /\[unbalancedDelimiters\]/);
    assert.match(r.checks.unbalancedDelimiters.details, /\{\}/);
  });
});

describe("patch-correctness golden: duplicate declarations", () => {
  it("flags new declaration duplicating existing name", () => {
    const oldContent = "function foo() {\n  return 1;\n}\n";
    const newContent = "function foo() {\n  return 1;\n}\nfunction foo() {\n  return 2;\n}\n";
    const r = checkPatchCorrectness(oldContent, newContent, "typescript");
    assert.strictEqual(r.checks.duplicateDeclarations.passed, false);
    assert.match(r.checks.duplicateDeclarations.details, /may duplicate existing ones: foo/);
  });
});

describe("patch-correctness golden: orphaned references", () => {
  it("flags removed declaration still referenced", () => {
    const oldContent = "function helper() {\n  return 1;\n}\nfunction main() {\n  return helper();\n}\n";
    const newContent = "function main() {\n  return helper();\n}\n";
    const r = checkPatchCorrectness(oldContent, newContent, "typescript");
    assert.strictEqual(r.checks.orphanedReferences.passed, false);
    assert.match(r.checks.orphanedReferences.details, /still referenced: helper/);
  });
});

describe("patch-correctness golden: import consistency", () => {
  it("flags new call without import", () => {
    const oldContent = "import { existing } from './a';\nexisting();\n";
    const newContent = "import { existing } from './a';\nexisting();\nbrandNewApi();\n";
    const r = checkPatchCorrectness(oldContent, newContent, "typescript");
    assert.strictEqual(r.checks.importConsistency.passed, false);
    assert.match(r.checks.importConsistency.details, /Potential missing imports: brandNewApi/);
  });

  it("skips import check for unsupported language", () => {
    const r = checkPatchCorrectness("a", "b", "markdown");
    assert.strictEqual(r.checks.importConsistency.passed, true);
    assert.match(r.checks.importConsistency.details, /not applicable/);
  });
});

describe("patch-correctness golden: syntax sanity", () => {
  it("flags unclosed string", () => {
    const oldContent = "const a = 1;\n";
    const newContent = "const a = \"oops;\n";
    const r = checkPatchCorrectness(oldContent, newContent, "typescript");
    assert.strictEqual(r.checks.syntaxSanity.passed, false);
    assert.match(r.checks.syntaxSanity.details, /Unclosed string literals/);
  });
});

describe("patch-correctness golden: zero-value placeholders", () => {
  it("flags new return 0 where old returned non-zero", () => {
    const oldContent = "function f() {\n  return 42;\n}\n";
    const newContent = "function f() {\n  return 0;\n}\n";
    const r = checkPatchCorrectness(oldContent, newContent, "typescript");
    assert.strictEqual(r.checks.zeroValuePlaceholders.passed, false);
    assert.match(r.checks.zeroValuePlaceholders.details, /likely placeholder/);
  });

  it("passes when no old content to compare", () => {
    const r = checkPatchCorrectness("", "function f() {\n  return 0;\n}\n", "typescript");
    assert.strictEqual(r.checks.zeroValuePlaceholders.passed, true);
    assert.match(r.checks.zeroValuePlaceholders.details, /No old content/);
  });
});

describe("patch-correctness golden: warning order + assembly", () => {
  it("orders warnings by check insertion order", () => {
    const oldContent = "function foo() {\n  return 42;\n}\n";
    // Unbalanced brace + return-0 placeholder together
    const newContent = "function foo() {\n  if (x) {\n  return 0;\n}\n";
    const r = checkPatchCorrectness(oldContent, newContent, "typescript");
    const names = r.warnings.map((w) => w.slice(1, w.indexOf("]")));
    const expected = [
      "unbalancedDelimiters",
      "duplicateDeclarations",
      "orphanedReferences",
      "importConsistency",
      "syntaxSanity",
      "zeroValuePlaceholders",
    ];
    const filtered = names.filter((n) => expected.includes(n));
    assert.deepStrictEqual(filtered, ["unbalancedDelimiters", "zeroValuePlaceholders"]);
    assert.strictEqual(r.passed, false);
  });

  it("returns safePass when a check throws", () => {
    const r = checkPatchCorrectness(null as unknown as string, "function f() {\n  return 1;\n}\n", "typescript");
    assert.strictEqual(r.passed, true);
    for (const check of Object.values(r.checks)) {
      assert.strictEqual(check.passed, true);
      assert.match(check.details, /Check skipped due to error/);
    }
  });

  it("constrains duplicate candidates via changedSymbols", () => {
    const oldContent = "function foo() {\n  return 1;\n}\n";
    const newContent = "function foo() {\n  return 1;\n}\nfunction foo() {\n  return 2;\n}\n";
    const r = checkPatchCorrectness(oldContent, newContent, "typescript", ["unrelated"]);
    assert.strictEqual(r.checks.duplicateDeclarations.passed, true);
  });
});
