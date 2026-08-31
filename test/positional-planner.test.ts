import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planPositionalEdits } from "../src/positional-planner.js";

describe("positional-planner", () => {
  it("single edit", async () => {
    const r = await planPositionalEdits({ fileEdits: [{ filePath: "/a.ts", edits: [{ filePath: "/a.ts", range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "bar" }] }] }, async () => "const foo = 1;");
    assert.equal(r.stagedFiles[0].newContent, "const bar = 1;");
  });
  it("multi-edit same file", async () => {
    const r = await planPositionalEdits({ fileEdits: [{ filePath: "/a.ts", edits: [{ filePath: "/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "let" }, { filePath: "/a.ts", range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "baz" }] }] }, async () => "const foo = 1;");
    assert.equal(r.stagedFiles[0].newContent, "let baz = 1;");
  });
  it("multi-file", async () => {
    const r = await planPositionalEdits({ fileEdits: [{ filePath: "/a.ts", edits: [{ filePath: "/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "hi" }] }, { filePath: "/b.ts", edits: [{ filePath: "/b.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "X" }] }] }, async (p) => p === "/a.ts" ? "foo" : "a");
    assert.equal(r.stagedFiles.length, 2);
  });
  it("empty workspaceEdit throws", async () => {
    await assert.rejects(() => planPositionalEdits({ fileEdits: [] }, async () => ""));
  });
  it("out of bounds throws", async () => {
    await assert.rejects(() => planPositionalEdits({ fileEdits: [{ filePath: "/a.ts", edits: [{ filePath: "/a.ts", range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } }, newText: "x" }] }] }, async () => "a\nb"));
  });
  it("utf-16 emoji", async () => {
    const content = "let a = '😀';";
    // 😀 is 2 code units, position after it
    const r = await planPositionalEdits({ fileEdits: [{ filePath: "/a.ts", edits: [{ filePath: "/a.ts", range: { start: { line: 0, character: 8 }, end: { line: 0, character: 10 } }, newText: "x" }] }] }, async () => content);
    assert.ok(r.stagedFiles[0].newContent.includes("x"));
  });
  it("diff string generated", async () => {
    const r = await planPositionalEdits({ fileEdits: [{ filePath: "/a.ts", edits: [{ filePath: "/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "hi" }] }] }, async () => "foo");
    assert.ok(r.diffString.length > 0);
  });
  it("descending order", async () => {
    const r = await planPositionalEdits({ fileEdits: [{ filePath: "/a.ts", edits: [{ filePath: "/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "A" }, { filePath: "/a.ts", range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } }, newText: "B" }] }] }, async () => "x y z");
    assert.equal(r.stagedFiles[0].newContent, "A y B");
  });
  it("zero-width insertion at end", async () => {
    const r = await planPositionalEdits({ fileEdits: [{ filePath: "/a.ts", edits: [{ filePath: "/a.ts", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, newText: "!" }] }] }, async () => "foo");
    assert.equal(r.stagedFiles[0].newContent, "foo!");
  });
});
