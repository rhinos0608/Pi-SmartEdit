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
  it("organize-imports-preview requires path", () => {
    const v = validateEditRequest({ refactor: { kind: "organize-imports-preview" }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, false);
  });
  it("valid organize-imports-preview passes", () => {
    const v = validateEditRequest({ refactor: { kind: "organize-imports-preview", path: "/a.ts" }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, true);
  });
  it("formatting-preview requires path", () => {
    const v = validateEditRequest({ refactor: { kind: "formatting-preview" }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, false);
  });
  it("valid formatting-preview passes with optional tabSize/insertSpaces", () => {
    const v = validateEditRequest({ refactor: { kind: "formatting-preview", path: "/a.ts", tabSize: 2, insertSpaces: true }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, true);
    const v2 = validateEditRequest({ refactor: { kind: "formatting-preview", path: "/a.ts" }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v2.ok, true);
  });
  it("formatting-preview rejects invalid tabSize/insertSpaces", () => {
    const v = validateEditRequest({ refactor: { kind: "formatting-preview", path: "/a.ts", tabSize: 0 }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, false);
    const v2 = validateEditRequest({ refactor: { kind: "formatting-preview", path: "/a.ts", insertSpaces: "true" as unknown as boolean }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v2.ok, false);
  });
  it("code-action-preview requires path/line/character", () => {
    const v = validateEditRequest({ refactor: { kind: "code-action-preview" }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, false);
    const v2 = validateEditRequest({ refactor: { kind: "code-action-preview", path: "/a.ts" }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v2.ok, false);
    const v3 = validateEditRequest({ refactor: { kind: "code-action-preview", path: "/a.ts", line: 0 }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v3.ok, false);
  });
  it("valid code-action-preview passes with optional endLine/endCharacter", () => {
    const v = validateEditRequest({ refactor: { kind: "code-action-preview", path: "/a.ts", line: 0, character: 0 }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v.ok, true);
    const v2 = validateEditRequest({ refactor: { kind: "code-action-preview", path: "/a.ts", line: 1, character: 2, endLine: 1, endCharacter: 5, diagnostics: [], only: ["quickfix"] }, toolCallId: "t" } as unknown as Record<string, unknown>);
    assert.equal(v2.ok, true);
  });
  it("new kinds are mutually exclusive with edits/raw", () => {
    for (const kind of ["organize-imports-preview", "formatting-preview", "code-action-preview"] as const) {
      const base: Record<string, unknown> = kind === "code-action-preview" ? { kind, path: "/a.ts", line: 0, character: 0 } : { kind, path: "/a.ts" };
      const v = validateEditRequest({ edits: [{ oldText: "a", newText: "b" }], refactor: base, toolCallId: "t" } as unknown as Record<string, unknown>);
      assert.equal(v.ok, false, `${kind} should be mutually exclusive with edits`);
      const v2 = validateEditRequest({ raw: "diff", refactor: base, toolCallId: "t" } as unknown as Record<string, unknown>);
      assert.equal(v2.ok, false, `${kind} should be mutually exclusive with raw`);
    }
  });
});
