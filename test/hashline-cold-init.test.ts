import test from "node:test";
import assert from "node:assert/strict";

import { applyHashlinePath } from "../src/hashline/hashline-edit.js";

test("applyHashlinePath initializes xxhash before sync validation", async () => {
  const result = await applyHashlinePath(
    {
      anchor: { range: { pos: "1st", end: "1st" } },
      content: ["const ready = true;"],
    },
    "{\n",
    null,
    async () => null,
    () => ({
      found: false,
      index: -1,
      matchLength: 0,
      tier: "exact",
      usedFuzzyMatch: false,
      matchedText: "",
    }),
    () => ({ char: " ", width: 2 }),
  );

  assert.equal(result.tier, "hashline-direct");
  assert.equal(result.newContent, "const ready = true;\n");
});
