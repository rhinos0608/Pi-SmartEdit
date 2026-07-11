import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyEdits } from "../src/core/edit-diff.js";

describe("applyEdits fuzzy matching", () => {
  const content = [
    "function helloWorld() {",
    "  const x = 1;",
    "  console.log(\"hello\");",
    "  return x;",
    "}",
  ].join("\n");
  const nearMatch = content.replace("helloWorld", "hulloWorld");

  it("uses similarity rescue by default", async () => {
    const result = await applyEdits(
      content,
      [{ oldText: nearMatch, newText: "function replacement() {}" }],
      "sample.ts",
    );

    assert.strictEqual(result.newContent, "function replacement() {}");
  });

  it("allows similarity rescue to be disabled", async () => {
    await assert.rejects(
      applyEdits(
        content,
        [{ oldText: nearMatch, newText: "function replacement() {}" }],
        "sample.ts",
        { allowFuzzy: false },
      ),
      /Fuzzy matching is disabled/,
    );
  });
});

describe("applyEdits batch validation", () => {
  it("does not run pre-apply hooks for overlapping edits", async () => {
    let hookCalls = 0;

    await assert.rejects(
      applyEdits(
        "abcdef",
        [
          { oldText: "abc", newText: "ABC" },
          { oldText: "cde", newText: "CDE" },
        ],
        "sample.txt",
        {
          onBeforeApply: async () => {
            hookCalls++;
          },
        },
      ),
      /overlap in sample\.txt/,
    );

    assert.strictEqual(hookCalls, 0);
  });

  it("runs pre-apply hooks for non-overlapping edits", async () => {
    let hookCalls = 0;
    await applyEdits(
      "abcdef",
      [
        { oldText: "abc", newText: "ABC" },
        { oldText: "def", newText: "DEF" },
      ],
      "sample.txt",
      {
        onBeforeApply: async () => {
          hookCalls++;
        },
      },
    );
    assert.strictEqual(hookCalls, 1);
  });
});
