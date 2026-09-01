import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RenamePreviewCache } from "../src/rename-preview-cache.js";

describe("rename-preview-cache", () => {
  it("store and retrieve", () => {
    const c = new RenamePreviewCache();
    const id = c.store({ fileEdits: [{ filePath: "/a.ts", edits: [] }] }, { stagedFiles: [], diffString: "" }, { filePath: "/a.ts", line: 1, character: 1, newName: "b", sessionId: "s1", sessionRoot: "/root" });
    assert.ok(c.get(id, { sessionId: "s1", sessionRoot: "/root" }));
    assert.match(id, /^[0-9a-f-]{36}$/);
  });
  it("expired returns null", async () => {
    const c = new RenamePreviewCache({ ttlMs: 10 });
    const id = c.store({ fileEdits: [] }, { stagedFiles: [], diffString: "" }, { filePath: "/a.ts", line: 1, character: 1, newName: "b", sessionId: "s1", sessionRoot: "/root" });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(c.get(id), null);
  });
  it("max entries eviction", () => {
    const c = new RenamePreviewCache({ maxEntries: 16 });
    const ids: string[] = [];
    for (let i = 0; i < 17; i++) ids.push(c.store({ fileEdits: [] }, { stagedFiles: [], diffString: "" }, { filePath: "/a.ts", line: i + 1, character: 1, newName: "b", sessionId: "s1", sessionRoot: "/root" }));
    assert.equal(c.get(ids[0]), null);
    assert.ok(c.get(ids[16]));
  });
  it("delete", () => {
    const c = new RenamePreviewCache();
    const id = c.store({ fileEdits: [] }, { stagedFiles: [], diffString: "" }, { filePath: "/a.ts", line: 1, character: 1, newName: "b", sessionId: "s1", sessionRoot: "/root" });
    c.delete(id);
    assert.equal(c.get(id), null);
  });
  it("UUID format", () => {
    const c = new RenamePreviewCache();
    const id = c.store({ fileEdits: [] }, { stagedFiles: [], diffString: "" }, { filePath: "/a.ts", line: 1, character: 1, newName: "b", sessionId: "s1", sessionRoot: "/root" });
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
  it("session binding", () => {
    const c = new RenamePreviewCache();
    const id = c.store({ fileEdits: [] }, { stagedFiles: [], diffString: "" }, { filePath: "/a.ts", line: 1, character: 1, newName: "b", sessionId: "s1", sessionRoot: "/root" });
    assert.equal(c.get(id, { sessionId: "s2", sessionRoot: "/root" }), null);
    assert.equal(c.get(id, { sessionId: "s1", sessionRoot: "/other" }), null);
    assert.ok(c.get(id, { sessionId: "s1", sessionRoot: "/root" }));
    assert.equal(c.size({ sessionId: "s1" }), 1);
    assert.equal(c.size({ sessionId: "s2" }), 0);
  });
});
