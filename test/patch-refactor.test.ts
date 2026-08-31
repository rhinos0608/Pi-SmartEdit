import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateEditRequest } from "../src/edit-contract.js";

describe("patch-refactor contract", () => {
  it("mutually exclusive edits/raw/refactor", () => {
    const v = validateEditRequest({ edits: [{ oldText: "a", newText: "b" }], refactor: { kind: "rename-preview", path: "/a.ts", line: 0, character: 0, newName: "b" }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, false);
  });
  it("rename-preview requires path/newName", () => {
    const v = validateEditRequest({ refactor: { kind: "rename-preview" }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, false);
  });
  it("valid rename-preview passes", () => {
    const v = validateEditRequest({ refactor: { kind: "rename-preview", path: "/a.ts", line: 0, character: 0, newName: "b" }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, true);
  });
  it("apply-refactor-preview requires previewId", () => {
    const v = validateEditRequest({ refactor: { kind: "apply-refactor-preview" }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, false);
  });
  it("valid apply-refactor-preview passes", () => {
    const v = validateEditRequest({ refactor: { kind: "apply-refactor-preview", previewId: "uuid" }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, true);
  });
});
