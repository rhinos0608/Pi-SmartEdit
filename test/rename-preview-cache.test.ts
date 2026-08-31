import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RenamePreviewCache } from "../src/rename-preview-cache.js";

describe("rename-preview-cache", () => {
  it("store and retrieve", () => {
    const c = new RenamePreviewCache();
    const id = c.store({ fileEdits: [{ filePath: "/a.ts", edits: [] }] }, { stagedFiles: [], diffString: "" }, { filePath: "/a.ts", line: 0, character: 0, newName: "b" });
    assert.ok(c.get(id));
    assert.match(id, /^[0-9a-f-]{36}$/);
  });
  it("expired returns null", async () => {
    const c = new RenamePreviewCache({ ttlMs: 10 });
    const id = c.store({ fileEdits: [] }, { stagedFiles: [], diffString: "" }, { filePath: "/a.ts", line: 0, character: 0, newName: "b" });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(c.get(id), null);
  });
  it("max entries eviction", () => {
    const c = new RenamePreviewCache({ maxEntries: 16 });
    const ids: string[] = [];
    for (let i = 0; i < 17; i++) ids.push(c.store({ fileEdits: [] }, { stagedFiles: [], diffString: "" }, { filePath: "/a.ts", line: i, character: 0, newName: "b" }));
    assert.equal(c.get(ids[0]), null);
    assert.ok(c.get(ids[16]));
  });
  it("delete", () => {
    const c = new RenamePreviewCache();
    const id = c.store({ fileEdits: [] }, { stagedFiles: [], diffString: "" }, { filePath: "/a.ts", line: 0, character: 0, newName: "b" });
    c.delete(id);
    assert.equal(c.get(id), null);
  });
  it("UUID format", () => {
    const c = new RenamePreviewCache();
    const id = c.store({ fileEdits: [] }, { stagedFiles: [], diffString: "" }, { filePath: "/a.ts", line: 0, character: 0, newName: "b" });
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
