/**
 * Unit tests for src/transfer-edit.ts (resolveSourceRange, buildTransferInsertEdit,
 * buildTransferDeleteEdit) — pure anchor-drift-tolerant source-range resolution
 * for copy/move transfer edits.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import {
    resolveSourceRange,
    buildTransferInsertEdit,
    buildTransferDeleteEdit,
} from "../src/transfer-edit.js";
import { computeLineHashSync, initHashline } from "../src/core/hashline.js";

let hashlineInitialized = false;
async function ensureHashline(): Promise<void> {
    if (!hashlineInitialized) {
        await initHashline();
        hashlineInitialized = true;
    }
}

before(async () => {
    await ensureHashline();
});

function lineAnchor(lineNum: number, text: string): string {
    return `${lineNum}${computeLineHashSync(lineNum, text)}`;
}

test("resolveSourceRange: exact-match resolution returns the literal line range", () => {
    const lines = ["alpha", "beta", "gamma", "delta"];
    const content = lines.join("\n");
    const pos = lineAnchor(2, lines[1]!);
    const end = lineAnchor(3, lines[2]!);
    const result = resolveSourceRange(content, pos, end);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.startLine, 2);
        assert.equal(result.value.endLine, 3);
        assert.deepEqual(result.value.lines, ["beta", "gamma"]);
    }
});

test("resolveSourceRange: rebases within the +/-5 anchor window when lines shift", () => {
    const originalLines = ["alpha", "beta", "gamma", "delta"];
    // Capture the anchor for "beta" at its original position (line 2), then
    // shift file content so "beta" now lives at line 4 — still within +/-5.
    const pos = lineAnchor(2, "beta");
    const end = lineAnchor(2, "beta");
    const shiftedContent = ["one", "two", "three", "beta", "five"].join("\n");
    const result = resolveSourceRange(shiftedContent, pos, end);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.value.startLine, 4);
        assert.equal(result.value.endLine, 4);
        assert.deepEqual(result.value.lines, ["beta"]);
    }
    void originalLines;
});

test("resolveSourceRange: rejects when the anchor cannot be found within the rebase window", () => {
    const pos = lineAnchor(2, "beta");
    const end = lineAnchor(2, "beta");
    // "beta" content does not appear anywhere in this file at all.
    const content = ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n");
    const result = resolveSourceRange(content, pos, end);
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.match(result.error, /stale|ambiguous/i);
        assert.match(result.error, /re-read/i);
    }
});

test("resolveSourceRange: rejects ambiguous anchor (duplicate hash within window, not at exact position)", () => {
    // Two structurally identical lines within the rebase window of an anchor
    // that itself does not match either position exactly.
    const dupLines = ["const x = 1;", "const x = 1;", "unrelated"];
    const targetHash = computeLineHashSync(1, dupLines[0]!);
    // Anchor claims line 3 with line 1's hash — line 3 doesn't match, so the
    // engine searches the window and finds the hash at both line 1 and line 2.
    const pos = `3${targetHash}`;
    const content = dupLines.join("\n");
    const result = resolveSourceRange(content, pos, pos);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /stale|ambiguous/i);
});

test("resolveSourceRange: rejects an inverted range where pos.line > end.line", () => {
    const lines = ["alpha", "beta", "gamma", "delta"];
    const content = lines.join("\n");
    const pos = lineAnchor(3, lines[2]!);
    const end = lineAnchor(1, lines[0]!);
    const result = resolveSourceRange(content, pos, end);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /pos must not come after.*end|re-read/i);
});

test("resolveSourceRange: rejects a range that inverts only after independent anchor relocation", () => {
    // pos anchors "gamma" (originally line 3) and end anchors "beta"
    // (originally line 2) — pos.line (3) > end.line (2) up front, so this is
    // actually caught by the pre-rebase ordering check, not post-relocation.
    // To exercise genuine post-relocation inversion, construct anchors whose
    // *original* line order is valid (pos.line <= end.line) but whose rebased
    // positions land inverted.
    const pos = `1${computeLineHashSync(1, "zzz")}`; // originally line 1, "zzz" relocates to line 5
    const end = `2${computeLineHashSync(2, "aaa")}`; // originally line 2, "aaa" relocates to line 1
    const content = ["aaa", "b", "c", "d", "zzz"].join("\n");
    const result = resolveSourceRange(content, pos, end);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /inverted|re-read/i);
});

test("buildTransferInsertEdit: builds an :after-suffixed hashline insert with the given source lines", () => {
    const item = buildTransferInsertEdit("18cd", ["one", "two"], "copy from a.ts:5aa-6bb");
    assert.deepEqual(item, {
        hashline: { range: { pos: "18cd:after", end: "18cd:after" }, content: ["one", "two"] },
        description: "copy from a.ts:5aa-6bb",
    });
});

test("buildTransferInsertEdit: omits description when not provided", () => {
    const item = buildTransferInsertEdit("18cd", ["one"]);
    assert.deepEqual(item, {
        hashline: { range: { pos: "18cd:after", end: "18cd:after" }, content: ["one"] },
    });
    assert.equal("description" in item, false);
});

test("buildTransferInsertEdit: EOF/new-file branch uses pos:EOF with no anchor and no description", () => {
    const item = buildTransferInsertEdit(undefined, ["one", "two"]);
    assert.deepEqual(item, {
        hashline: { range: { pos: "EOF", end: "EOF" }, content: ["one", "two"] },
    });
    assert.equal("description" in item, false);
});

test("buildTransferDeleteEdit: builds a content:null hashline delete over the given range", () => {
    const item = buildTransferDeleteEdit({ pos: "5aa", end: "6bb" }, "move from a.ts:5aa-6bb");
    assert.deepEqual(item, {
        hashline: { range: { pos: "5aa", end: "6bb" }, content: null },
        description: "move from a.ts:5aa-6bb",
    });
});
