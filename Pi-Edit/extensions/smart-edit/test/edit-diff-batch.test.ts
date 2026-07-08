import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyEdits } from "../src/core/edit-diff.js";

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
