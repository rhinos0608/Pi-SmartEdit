/**
 * Tests for the fake-logic detector.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { checkFakeLogic, type FakeLogicResult } from "../../src/verification/fake-logic.js";

// ─── Helpers ─────────────────────────────────────────────────────────

async function check(
  content: string,
  filePath = "/test/file.ts",
  languageId: string | null = null,
  opts?: { oldContent?: string; maxFindings?: number },
): Promise<FakeLogicResult> {
  return checkFakeLogic(content, filePath, languageId, opts);
}

function assertFindings(
  result: FakeLogicResult,
  rule: string,
  expectedCount: number,
): void {
  const found = result.findings.filter((f) => f.rule === rule);
  assert.strictEqual(
    found.length,
    expectedCount,
    `Expected ${expectedCount} ${rule} finding(s), got ${found.length}: ${JSON.stringify(result.findings)}`,
  );
}

// ─── stub-body rule (TypeScript) ─────────────────────────────────────

describe("stub-body detection (TypeScript)", () => {
  it("flags function returning a constant", async () => {
    const result = await check("function f(x) { return true; }\n", "/test/a.ts");
    assertFindings(result, "stub-body", 1);
    assert.strictEqual(result.findings[0].line, 1);
  });

  it("flags method throwing not-implemented", async () => {
    const result = await check(
      "class C { m(x) { throw new Error('not implemented'); } }\n",
      "/test/b.ts",
    );
    assertFindings(result, "stub-body", 1);
  });

  it("flags arrow function with block returning null", async () => {
    const result = await check(
      "const fn = (a) => { return null; };\n",
      "/test/c.ts",
    );
    assertFindings(result, "stub-body", 1);
  });

  it("does not flag zero-arg constant getter", async () => {
    const result = await check("function getter() { return 0; }\n", "/test/d.ts");
    assertFindings(result, "stub-body", 0);
  });

  it("does not flag arrow function with expression body", async () => {
    const result = await check("const inc = (n) => n + 1;\n", "/test/e.ts");
    assertFindings(result, "stub-body", 0);
  });
});

// ─── stub-body rule (Python) ─────────────────────────────────────────

describe("stub-body detection (Python)", () => {
  it("flags function returning True", async () => {
    const result = await check(
      "def f(x):\n    return True\n",
      "/test/a.py",
      "python",
    );
    assertFindings(result, "stub-body", 1);
  });

  it("flags function with pass body", async () => {
    const result = await check(
      "def f(x):\n    pass\n",
      "/test/b.py",
      "python",
    );
    assertFindings(result, "stub-body", 1);
  });

  it("flags function raising NotImplementedError", async () => {
    const result = await check(
      "def f(x):\n    raise NotImplementedError\n",
      "/test/c.py",
      "python",
    );
    assertFindings(result, "stub-body", 1);
  });

  it("does not flag zero-arg constant function", async () => {
    const result = await check(
      "def zero():\n    return 0\n",
      "/test/d.py",
      "python",
    );
    assertFindings(result, "stub-body", 0);
  });
});

// ─── constant-condition rule (TypeScript) ────────────────────────────

describe("constant-condition detection (TypeScript)", () => {
  it("flags literal true if", async () => {
    const result = await check("if (true) { console.log(1); }\n", "/test/cc1.ts");
    assertFindings(result, "constant-condition", 1);
  });

  it("flags literal false if", async () => {
    const result = await check("if (false) { console.log(1); }\n", "/test/cc2.ts");
    assertFindings(result, "constant-condition", 1);
  });

  it("flags literal number if", async () => {
    const result = await check("if (0) { console.log(1); }\n", "/test/cc3.ts");
    assertFindings(result, "constant-condition", 1);
  });

  it("flags self-comparison", async () => {
    const result = await check("if (x === x) { console.log(1); }\n", "/test/cc4.ts");
    assertFindings(result, "constant-condition", 1);
  });

  it("flags ternary with literal condition", async () => {
    const result = await check("const v = true ? 1 : 2;\n", "/test/cc5.ts");
    assertFindings(result, "constant-condition", 1);
  });

  it("does not flag while(true) with break", async () => {
    const result = await check("while (true) { if (x) break; }\n", "/test/cc6.ts");
    assertFindings(result, "constant-condition", 0);
  });

  it("does not flag while(true) with throw exit", async () => {
    const result = await check(
      "while (true) { throw new Error('stop'); }\n",
      "/test/cc6b.ts",
    );
    assertFindings(result, "constant-condition", 0);
  });

  it("flags while(true) without exit", async () => {
    const result = await check("while (true) { console.log(1); }\n", "/test/cc7.ts");
    assertFindings(result, "constant-condition", 1);
  });
});

// ─── constant-condition rule (Python) ────────────────────────────────

describe("constant-condition detection (Python)", () => {
  it("flags literal True if", async () => {
    const result = await check(
      "if True:\n    pass\n",
      "/test/pcc1.py",
      "python",
    );
    assertFindings(result, "constant-condition", 1);
  });

  it("flags self-comparison", async () => {
    const result = await check(
      "if a == a:\n    pass\n",
      "/test/pcc2.py",
      "python",
    );
    assertFindings(result, "constant-condition", 1);
  });

  it("flags ternary with literal condition", async () => {
    const result = await check(
      "v = 1 if True else 2\n",
      "/test/pcc3.py",
      "python",
    );
    assertFindings(result, "constant-condition", 1);
  });

  it("does not flag while True with break", async () => {
    const result = await check(
      "while True:\n    break\n",
      "/test/pcc4.py",
      "python",
    );
    assertFindings(result, "constant-condition", 0);
  });

  it("does not flag while True with raise exit", async () => {
    const result = await check(
      "while True:\n    raise RuntimeError('stop')\n",
      "/test/pcc4b.py",
      "python",
    );
    assertFindings(result, "constant-condition", 0);
  });
});

// ─── empty-catch rule (TypeScript) ───────────────────────────────────

describe("empty-catch detection (TypeScript)", () => {
  it("flags empty catch block", async () => {
    const result = await check(
      "try { foo(); } catch (e) {}\n",
      "/test/ec1.ts",
    );
    assertFindings(result, "empty-catch", 1);
  });

  it("flags catch with only a comment", async () => {
    const result = await check(
      "try { foo(); } catch (e) { // TODO handle\n }\n",
      "/test/ec2.ts",
    );
    assertFindings(result, "empty-catch", 1);
  });

  it("does not flag catch with intentional ignore comment", async () => {
    const result = await check(
      "try { foo(); } catch (e) { // Ignore cleanup errors\n }\n",
      "/test/ec3.ts",
    );
    assertFindings(result, "empty-catch", 0);
  });
});

// ─── empty-catch rule (Python) ───────────────────────────────────────

describe("empty-catch detection (Python)", () => {
  it("flags empty except block", async () => {
    const result = await check(
      "try:\n    pass\nexcept Exception:\n    pass\n",
      "/test/pec1.py",
      "python",
    );
    assertFindings(result, "empty-catch", 1);
  });

  it("does not flag except with intentional ignore comment", async () => {
    const result = await check(
      "try:\n    pass\nexcept Exception:\n    # ignore\n    pass\n",
      "/test/pec2.py",
      "python",
    );
    assertFindings(result, "empty-catch", 0);
  });
});

// ─── oldContent suppression ──────────────────────────────────────────

describe("oldContent suppression", () => {
  it("suppresses findings already present in oldContent", async () => {
    const content = "function f(x) { return true; }\n";
    const result = await check(content, "/test/old1.ts", null, {
      oldContent: content,
    });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.findings.length, 0);
  });

  it("keeps findings introduced by the edit", async () => {
    const result = await check(
      "function f(x) { return true; }\n",
      "/test/old2.ts",
      null,
      {
        oldContent: "function f(x) { return 1; }\n",
      },
    );
    assertFindings(result, "stub-body", 1);
  });
});

// ─── Regex fallback ──────────────────────────────────────────────────

describe("regex fallback", () => {
  it("detects empty catch on unsupported extension", async () => {
    const result = await check(
      "try { foo(); } catch (e) {}\nif (true) { bar(); }\n",
      "/test/unknown.xyz",
    );
    assertFindings(result, "empty-catch", 1);
    assertFindings(result, "constant-condition", 1);
  });

  it("does not attempt stub-body detection in fallback", async () => {
    const result = await check(
      "function f(x) { return true; }\n",
      "/test/unknown2.xyz",
    );
    assertFindings(result, "stub-body", 0);
  });
});

// ─── Safety / robustness ─────────────────────────────────────────────

describe("safety", () => {
  it("returns passing result for empty string", async () => {
    const result = await check("", "/test/empty.ts");
    assert.strictEqual(result.passed, true);
    assert.deepStrictEqual(result.findings, []);
  });

  it("does not throw on binary garbage", async () => {
    const garbage = Buffer.from([0x00, 0x1b, 0xff, 0x80]).toString("binary");
    const result = await check(garbage, "/test/garbage.ts");
    assert.strictEqual(result.passed, true);
    assert.deepStrictEqual(result.findings, []);
  });

  it("does not throw on huge string", async () => {
    const huge = "if (true) { console.log(1); }\n".repeat(100_000);
    const result = await check(huge, "/test/huge.ts");
    assert.strictEqual(result.passed, true);
    assert.deepStrictEqual(result.findings, []);
  });

  it("caps findings at maxFindings", async () => {
    const content = "if (true) { console.log(1); }\n".repeat(20);
    const result = await check(content, "/test/cap.ts", null, {
      maxFindings: 5,
    });
    assert.strictEqual(result.findings.length, 5);
  });
});
