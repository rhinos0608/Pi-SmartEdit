/** classifyRpcError resolver-string mapping. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyRpcError } from "../src/patch/result-builders.js";

test("unknown inspectionId resolver error maps to coverage", () => {
    assert.equal(
        classifyRpcError("rejected: unknown inspectionId (not in tool result details index)"),
        "coverage",
    );
});

test("not in tool result maps to coverage", () => {
    assert.equal(classifyRpcError("rejected: inspectionId not in tool result index"), "coverage");
});

test("existing mappings preserved", () => {
    assert.equal(classifyRpcError("coverage gap on path"), "coverage");
    assert.equal(classifyRpcError("stale evidence"), "stale");
    assert.equal(classifyRpcError("duplicate patch"), "conflict");
    assert.equal(classifyRpcError(undefined), "session");
    assert.equal(classifyRpcError("some other failure"), "session");
});
