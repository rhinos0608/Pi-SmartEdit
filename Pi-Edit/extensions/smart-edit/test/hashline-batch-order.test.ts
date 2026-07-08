import { describe, it } from "node:test";
import assert from "node:assert";
import { formatHashlineBatchSummary, sortHashlineEditsForApplication } from "../src/index.js";

describe("sortHashlineEditsForApplication", () => {
  it("sorts higher lines before lower lines and preserves original order on ties", () => {
    const ordered = sortHashlineEditsForApplication([
      { editIdx: 0, sortLine: 230 },
      { editIdx: 1, sortLine: 377 },
      { editIdx: 2, sortLine: 230 },
      { editIdx: 3, sortLine: 1 },
    ]);

    assert.deepStrictEqual(
      ordered.map((e) => e.editIdx),
      [1, 0, 2, 3],
    );
  });
});

describe("formatHashlineBatchSummary", () => {
  it("summarizes partial success with skipped edit indices", () => {
    assert.strictEqual(
      formatHashlineBatchSummary(3, 2, [
        { editIdx: 1, message: "Edit rejected: line 42 changed." },
      ]),
      "Hashline batch: applied 2/3 edit(s); skipped stale edit #2.",
    );
  });

  it("returns null when all edits succeed or all fail", () => {
    assert.strictEqual(formatHashlineBatchSummary(2, 2, []), null);
    assert.strictEqual(
      formatHashlineBatchSummary(2, 0, [
        { editIdx: 0, message: "x" },
        { editIdx: 1, message: "y" },
      ]),
      null,
    );
  });
});
