import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { RefactorPreviewCache, type RefactorPreviewSource } from "../src/lsp/refactor-preview-cache.js";
import { checkWorkspaceEditEncoding, runBusPreview } from "../src/patch/refactor-preview.js";
import type { PatchToolDeps } from "../src/patch/types.js";

const SID = "s1";
const ROOT = "/root";

function edit16(filePath: string): LspWorkspaceEdit {
  return { positionEncoding: "utf-16", fileEdits: [{ filePath, edits: [] }] };
}

const SOURCES: RefactorPreviewSource[] = [
  { kind: "rename", filePath: "/a.ts", line: 1, character: 1, newName: "b" },
  { kind: "organize-imports", filePath: "/a.ts" },
  { kind: "formatting", filePath: "/a.ts", tabSize: 2, insertSpaces: true },
  { kind: "code-action", filePath: "/a.ts", line: 1, character: 2, endLine: 1, endCharacter: 5 },
];

describe("refactor-preview-cache", () => {
  for (const source of SOURCES) {
    it(`store and retrieve (${source.kind})`, () => {
      const c = new RefactorPreviewCache();
      const id = c.store(edit16("/a.ts"), { stagedFiles: [], diffString: "" }, { source, sessionId: SID, sessionRoot: ROOT });
      const got = c.get(id, { sessionId: SID, sessionRoot: ROOT });
      assert.ok(got);
      assert.deepEqual(got.source, source);
      assert.match(id, /^[0-9a-f-]{36}$/);
    });
  }

  it("no sentinel fields for non-rename kinds", () => {
    const c = new RefactorPreviewCache();
    for (const source of SOURCES.filter((s) => s.kind !== "rename")) {
      const id = c.store(edit16("/a.ts"), { stagedFiles: [], diffString: "" }, { source, sessionId: SID, sessionRoot: ROOT });
      const got = c.get(id)!;
      assert.ok(got);
      assert.equal("line" in got, false, `${source.kind} must not carry top-level line`);
      assert.equal("character" in got, false, `${source.kind} must not carry top-level character`);
      assert.equal("newName" in got, false, `${source.kind} must not carry top-level newName`);
      assert.equal("filePath" in got, false, `${source.kind} must not carry top-level filePath`);
      assert.equal("plannedRename" in got, false, "plannedRename renamed to planned");
    }
  });

  it("expired returns null", async () => {
    const c = new RefactorPreviewCache({ ttlMs: 10 });
    const id = c.store(edit16("/a.ts"), { stagedFiles: [], diffString: "" }, { source: SOURCES[0]!, sessionId: SID, sessionRoot: ROOT });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(c.get(id), null);
  });

  it("max entries eviction", () => {
    const c = new RefactorPreviewCache({ maxEntries: 16 });
    const ids: string[] = [];
    for (let i = 0; i < 17; i++) {
      ids.push(c.store(edit16("/a.ts"), { stagedFiles: [], diffString: "" }, { source: { kind: "rename", filePath: "/a.ts", line: i + 1, character: 1, newName: "b" }, sessionId: SID, sessionRoot: ROOT }));
    }
    assert.equal(c.get(ids[0]!), null);
    assert.ok(c.get(ids[16]!));
  });

  it("delete", () => {
    const c = new RefactorPreviewCache();
    const id = c.store(edit16("/a.ts"), { stagedFiles: [], diffString: "" }, { source: SOURCES[0]!, sessionId: SID, sessionRoot: ROOT });
    c.delete(id);
    assert.equal(c.get(id), null);
  });

  it("UUID format", () => {
    const c = new RefactorPreviewCache();
    const id = c.store(edit16("/a.ts"), { stagedFiles: [], diffString: "" }, { source: SOURCES[0]!, sessionId: SID, sessionRoot: ROOT });
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("session binding", () => {
    const c = new RefactorPreviewCache();
    const id = c.store(edit16("/a.ts"), { stagedFiles: [], diffString: "" }, { source: SOURCES[0]!, sessionId: SID, sessionRoot: ROOT });
    assert.equal(c.get(id, { sessionId: "s2", sessionRoot: ROOT }), null);
    assert.equal(c.get(id, { sessionId: SID, sessionRoot: "/other" }), null);
    assert.ok(c.get(id, { sessionId: SID, sessionRoot: ROOT }));
    assert.equal(c.size({ sessionId: SID }), 1);
    assert.equal(c.size({ sessionId: "s2" }), 0);
  });
});

describe("refactor-preview-cache encoding gate", () => {
  it("missing encoding rejected", () => {
    assert.match(checkWorkspaceEditEncoding({ fileEdits: [] }) ?? "", /positionEncoding must be 'utf-16'/);
  });
  it("wrong encoding rejected", () => {
    assert.match(checkWorkspaceEditEncoding({ positionEncoding: "utf-8", fileEdits: [] }) ?? "", /positionEncoding must be 'utf-16'/);
  });
  it("utf-16 accepted", () => {
    assert.equal(checkWorkspaceEditEncoding({ positionEncoding: "utf-16", fileEdits: [] }), null);
  });
  it("planAndStorePreview rejects missing encoding before staging", async () => {
    const deps = {} as unknown as PatchToolDeps;
    const res = await import("../src/patch/refactor-preview.js").then((m) =>
      m.planAndStorePreview(deps, "t", { fileEdits: [] }, { kind: "organize-imports", filePath: "/a.ts" }),
    );
    assert.equal(res.details.status.kind, "failed");
    assert.match(res.content[0]!.text, /positionEncoding must be 'utf-16'/);
  });
});

describe("refactor-preview-cache handler discriminants", () => {
  function tmpFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "refactor-cache-"));
    const p = join(dir, "a.ts");
    writeFileSync(p, content);
    return p;
  }

  function depsFor(dir: string): PatchToolDeps {
    const bus = { emit() {}, on: () => () => {} };
    return {
      getBus: () => bus,
      getSessionFilePath: () => join(dir, "session.json"),
      getCanonicalWorkspaceRoot: () => dir,
    } as unknown as PatchToolDeps;
  }

  it("runBusPreview stores proper discriminant per kind", async () => {
    const { globalRefactorPreviewCache } = await import("../src/lsp/refactor-preview-cache.js");
    const table: RefactorPreviewSource[] = [
      { kind: "rename", filePath: "__P__", line: 1, character: 1, newName: "b" },
      { kind: "organize-imports", filePath: "__P__" },
      { kind: "formatting", filePath: "__P__", tabSize: 2, insertSpaces: true },
      { kind: "code-action", filePath: "__P__", line: 1, character: 2, endLine: 1, endCharacter: 5 },
    ];
    for (const template of table) {
      const p = tmpFile("const x = 1;\n");
      const source = { ...template, filePath: p } as RefactorPreviewSource;
      const dir = join(tmpdir());
      const deps = depsFor(dir);
      const res2 = await runBusPreview({
        deps,
        toolCallId: "t",
        label: `${source.kind}-preview`,
        request: async () =>
          ({
            ok: true,
            workspaceEdit: {
              positionEncoding: "utf-16",
              fileEdits: [{ filePath: p, edits: [{ filePath: p, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "y" }] }],
            },
          }),
        source,
      });
      const previewId = (res2.details as { previewId?: string }).previewId;
      assert.ok(previewId, `${source.kind} must return a previewId`);
      const entry = globalRefactorPreviewCache.get(previewId!);
      assert.ok(entry, `${source.kind} preview must be cached`);
      assert.deepEqual(entry!.source, source);
      globalRefactorPreviewCache.delete(previewId!);
    }
  });

  it("apply is kind-agnostic (same routing for every kind)", async () => {
    const m = await import("../src/patch/refactor-preview.js");
    const kinds: RefactorPreviewSource[] = [
      { kind: "rename", filePath: "__P__", line: 1, character: 1, newName: "b" },
      { kind: "organize-imports", filePath: "__P__" },
    ];
    for (const template of kinds) {
      const p = tmpFile("const x = 1;\n");
      const dir = mkdtempSync(join(tmpdir(), "refactor-apply-"));
      const bus = { emit() {}, on: () => () => {} };
      const deps = {
        getBus: () => bus,
        getSessionFilePath: () => join(dir, "session.json"),
        getCanonicalWorkspaceRoot: () => dir,
      } as unknown as PatchToolDeps;
      const source = { ...template, filePath: p } as RefactorPreviewSource;
      const preview = await runBusPreview({
        deps,
        toolCallId: "t",
        label: `${source.kind}-preview`,
        request: async () =>
          ({
            ok: true,
            workspaceEdit: {
              positionEncoding: "utf-16",
              fileEdits: [{ filePath: p, edits: [{ filePath: p, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "y" }] }],
            },
          }),
        source,
      });
      const previewId = (preview.details as { previewId?: string }).previewId;
      assert.ok(previewId);
      // No read authority in this harness, so the transaction rejects at the
      // coverage gate — identically for every kind. That proves the apply path
      // resolved the cached preview (not "unknown or expired") and routed
      // kind-agnostically past the cache into EditTransaction.
      const applied = await m.handleApplyRefactorPreview(deps, "t2", { kind: "apply-refactor-preview", previewId: previewId! });
      assert.match(applied.content[0]!.text, /read authority/, `${source.kind} must reach the transaction stage`);
      assert.ok(!/unknown or expired preview/.test(applied.content[0]!.text), `${source.kind} preview must resolve`);
    }
  });
});
