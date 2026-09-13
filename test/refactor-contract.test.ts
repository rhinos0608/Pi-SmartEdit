/**
 * Kind-discriminated refactor contract tests (TDD RED first).
 *
 * Each refactor variant enforces its own required fields at validation
 * time with precise errors, and rejects fields that are irrelevant to
 * its kind. Wire compat: every valid per-kind payload still passes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateEditRequest } from "../src/edit-contract.js";

function refactor(r: Record<string, unknown>) {
    return validateEditRequest({ refactor: r, toolCallId: "t" } as unknown as Record<string, unknown>);
}

describe("refactor contract: rename-preview", () => {
    it("missing newName fails with precise error", () => {
        const v = refactor({ kind: "rename-preview", path: "/a.ts", line: 1, character: 1 });
        assert.equal(v.ok, false);
        assert.match(v.error, /newName.*required.*rename-preview/);
    });
    it("irrelevant previewId rejected for rename-preview", () => {
        const v = refactor({ kind: "rename-preview", path: "/a.ts", line: 1, character: 1, newName: "b", previewId: "x" });
        assert.equal(v.ok, false);
        assert.match(v.error, /previewId.*rename-preview|not supported/);
    });
    it("valid rename-preview passes", () => {
        const v = refactor({ kind: "rename-preview", path: "/a.ts", line: 1, character: 1, newName: "b" });
        assert.equal(v.ok, true);
    });
});

describe("refactor contract: apply-refactor-preview", () => {
    it("missing previewId fails with precise error", () => {
        const v = refactor({ kind: "apply-refactor-preview" });
        assert.equal(v.ok, false);
        assert.match(v.error, /previewId.*required.*apply-refactor-preview/);
    });
    it("irrelevant path rejected for apply-refactor-preview", () => {
        const v = refactor({ kind: "apply-refactor-preview", previewId: "uuid", path: "/a.ts" });
        assert.equal(v.ok, false);
        assert.match(v.error, /path.*apply-refactor-preview|not supported/);
    });
    it("valid apply-refactor-preview passes", () => {
        const v = refactor({ kind: "apply-refactor-preview", previewId: "uuid" });
        assert.equal(v.ok, true);
    });
});

describe("refactor contract: organize-imports-preview", () => {
    it("missing path fails with precise error", () => {
        const v = refactor({ kind: "organize-imports-preview" });
        assert.equal(v.ok, false);
        assert.match(v.error, /path.*required.*organize-imports-preview/);
    });
    it("irrelevant newName rejected for organize-imports-preview", () => {
        const v = refactor({ kind: "organize-imports-preview", path: "/a.ts", newName: "b" });
        assert.equal(v.ok, false);
        assert.match(v.error, /newName.*organize-imports-preview|not supported/);
    });
    it("valid organize-imports-preview passes", () => {
        const v = refactor({ kind: "organize-imports-preview", path: "/a.ts" });
        assert.equal(v.ok, true);
    });
});

describe("refactor contract: formatting-preview", () => {
    it("missing path fails with precise error", () => {
        const v = refactor({ kind: "formatting-preview" });
        assert.equal(v.ok, false);
        assert.match(v.error, /path.*required.*formatting-preview/);
    });
    it("irrelevant newName rejected for formatting-preview", () => {
        const v = refactor({ kind: "formatting-preview", path: "/a.ts", newName: "b" });
        assert.equal(v.ok, false);
        assert.match(v.error, /newName.*formatting-preview|not supported/);
    });
    it("valid formatting-preview passes", () => {
        const v = refactor({ kind: "formatting-preview", path: "/a.ts", tabSize: 2, insertSpaces: true });
        assert.equal(v.ok, true);
    });
});

describe("refactor contract: code-action-preview", () => {
    it("missing character fails with precise error", () => {
        const v = refactor({ kind: "code-action-preview", path: "/a.ts", line: 1 });
        assert.equal(v.ok, false);
        assert.match(v.error, /character.*required.*code-action-preview/);
    });
    it("irrelevant newName rejected for code-action-preview", () => {
        const v = refactor({ kind: "code-action-preview", path: "/a.ts", line: 1, character: 1, newName: "b" });
        assert.equal(v.ok, false);
        assert.match(v.error, /newName.*code-action-preview|not supported/);
    });
    it("valid code-action-preview passes", () => {
        const v = refactor({ kind: "code-action-preview", path: "/a.ts", line: 1, character: 1 });
        assert.equal(v.ok, true);
    });
});
