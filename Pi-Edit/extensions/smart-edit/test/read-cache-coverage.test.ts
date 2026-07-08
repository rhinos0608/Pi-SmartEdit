import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { clearCache, checkRangeCoverage, recordReadSession } from "../src/core/read-cache";

describe("checkRangeCoverage read summary", () => {
  beforeEach(() => {
    clearCache();
  });

  it("lists every recorded read span when coverage is incomplete", () => {
    const cwd = process.cwd();
    const path = "src/config.ts";

    recordReadSession(path, cwd, 198, 150, 347, "read_multiple_files");
    recordReadSession(path, cwd, 610, 102, 711, "read_multiple_files");
    recordReadSession(path, cwd, 996, 42, 1037, "read_multiple_files");

    const result = checkRangeCoverage(path, cwd, 204, 1008);

    assert.strictEqual(result.covered, false);
    assert.ok(result.reason.includes("lines 198-347"));
    assert.ok(result.reason.includes("lines 610-711"));
    assert.ok(result.reason.includes("lines 996-1037"));
  });

  it("does not cover lines beyond the original read range when no post-edit session read is recorded", () => {
    // Regression: after an edit that expands a file, the session reads
    // only reflect the original read range. Without a post-edit call to
    // recordReadSession, lines added by the edit are not covered.
    const cwd = process.cwd();
    const path = "src/example.ts";

    // Initial read of a 100-line file
    recordReadSession(path, cwd, 1, -1, 100, "read");

    // Edit expands file to 150 lines (pre-fix: recordReadSession is NOT called here)
    // Line 120 is in the expanded region — not in any recorded session read
    const result = checkRangeCoverage(path, cwd, 120, 130);
    assert.strictEqual(result.covered, false);
  });

  it("covers lines in the expanded range when a post-edit session read is recorded", () => {
    // After the fix: index.ts calls recordReadSession(path, cwd, 1, -1, postEditLines.length, "edit")
    // immediately after recordReadWithStat. This test verifies that call makes the
    // new lines visible to checkRangeCoverage for subsequent edits.
    const cwd = process.cwd();
    const path = "src/example.ts";

    // Initial read of a 100-line file
    recordReadSession(path, cwd, 1, -1, 100, "read");

    // Post-edit session read (recorded by the fix in index.ts after atomicWrite)
    recordReadSession(path, cwd, 1, -1, 150, "edit");

    // Line 120 is now within the post-edit range
    const result = checkRangeCoverage(path, cwd, 120, 130);
    assert.deepStrictEqual(result, { covered: true });
  });
});
