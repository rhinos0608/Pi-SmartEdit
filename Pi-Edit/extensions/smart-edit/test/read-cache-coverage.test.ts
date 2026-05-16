import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { clearCache, checkRangeCoverage, recordReadSession } from "../lib/read-cache";

describe("checkRangeCoverage read summary", () => {
  beforeEach(() => clearCache());

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
});
