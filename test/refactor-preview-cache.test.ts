import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSessionFilePath, sha256OfString, type LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { RefactorPreviewCache, globalRefactorPreviewCache, type RefactorPreviewSource } from "../src/lsp/refactor-preview-cache.js";
import { checkWorkspaceEditEncoding, runBusPreview } from "../src/patch/refactor-preview.js";
import type { PatchToolDeps } from "../src/patch/types.js";

const SID = "s1";
const ROOT = "/root";

function edit16(filePath: string): LspWorkspaceEdit {
  return { positionEncoding: "utf-16", fileEdits: [{ filePath, edits: [] }] };
}

const SOURCES: RefactorPreviewSource[] = [
  { kind: "rename", filePath: "/a.ts", line: 1, character: 1, newName: "b" },
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

  it("cached originDocument is immutable snapshot not vulnerable to external reference mutation", () => {
    const c = new RefactorPreviewCache();
    const doc = { canonicalPath: "/a.ts", sha256: "0".repeat(64) };
    const id = c.store(edit16("/a.ts"), { stagedFiles: [], diffString: "" }, {
      source: { kind: "workspace-edit", operation: "rename", document: doc },
      sessionId: SID,
      sessionRoot: ROOT,
      originDocument: doc,
    });
    // Caller mutates the passed object
    (doc as Record<string, unknown>).sha256 = "f".repeat(64);
    const got = c.get(id, { sessionId: SID, sessionRoot: ROOT });
    assert.ok(got);
    assert.equal(got.originDocument?.sha256, "0".repeat(64), "cache must retain initial sha256 snapshot, not mutated reference");
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

  it("runBusPreview consumes staged proposals per kind (D-81)", async () => {
    // Static import (module top): dynamic import() of the same .ts file can
    // resolve to a second module instance under tsx on Node 20, so the
    // global cache must be reached through the static binding the src
    // modules share — never a fresh dynamic import.
    const table: Array<{ kind: "rename" | "formatting" | "code-action" }> = [
      { kind: "rename" },
      { kind: "formatting" },
      { kind: "code-action" },
    ];
    for (const { kind } of table) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "refactor-cache-")));
      writeFileSync(join(dir, "session.json"), "{}");
      const p = join(dir, "a.ts");
      writeFileSync(p, "const x = 1;\n");
      const deps = depsFor(dir);
      // Proposal staged by the workspace-edit RPC server (SmartRead stages
      // through stage_workspace_edit); the bus reply carries only the id.
      const proposalId = globalRefactorPreviewCache.store(edit16(p), { stagedFiles: [{ filePath: p, originalContent: "const x = 1;\n", newContent: "const y = 1;\n", edits: [] }], diffString: "-const x = 1;\n+const y = 1;\n" }, {
        source: { kind: "workspace-edit", operation: kind, document: { canonicalPath: p, sha256: sha256OfString("const x = 1;\n") } },
        sessionId: hashSessionFilePath(join(dir, "session.json")),
        sessionRoot: dir,
      });
      try {
        const res2 = await runBusPreview({
          deps,
          toolCallId: "t",
          label: `${kind}-preview`,
          kind,
          request: async () => ({ ok: true, proposalId, files: [p], diff: "-const x = 1;\n+const y = 1;\n" }),
        });
        const previewId = (res2.details as { previewId?: string }).previewId;
        assert.equal(previewId, proposalId, `${kind} must return the staged proposalId`);
        const entry = globalRefactorPreviewCache.get(previewId!);
        assert.ok(entry, `${kind} preview must resolve in the cache`);
        assert.match(res2.content[0]!.text, /const y = 1/);
      } finally {
        globalRefactorPreviewCache.delete(proposalId);
      }
    }
  });

  it("runBusPreview rejects workspaceEdit replies and unknown proposals", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "refactor-cache-")));
    writeFileSync(join(dir, "session.json"), "{}");
    const p = join(dir, "a.ts");
    writeFileSync(p, "const x = 1;\n");
    const deps = depsFor(dir);
    const raw = await runBusPreview({
      deps,
      toolCallId: "t",
      label: "rename-preview",
      kind: "rename",
      request: async () => ({
        ok: true,
        proposalId: "11111111-2222-4333-8444-555555555555",
        files: [p],
        diff: "forged",
        workspaceEdit: { positionEncoding: "utf-16", fileEdits: [] },
      }),
    });
    assert.equal(raw.details.status.kind, "failed");
    assert.match(raw.content[0]!.text, /workspaceEdit|unknown field/i);
    const unknown = await runBusPreview({
      deps,
      toolCallId: "t",
      label: "rename-preview",
      kind: "rename",
      request: async () => ({ ok: true, proposalId: "22222222-3333-4444-8555-666666666666", files: [p], diff: "forged" }),
    });
    assert.equal(unknown.details.status.kind, "failed");
    assert.match(unknown.content[0]!.text, /unknown or expired proposal/);
  });

  it("apply is kind-agnostic (same routing for every kind)", async () => {
    const m = await import("../src/patch/refactor-preview.js");
    const kinds: Array<"rename" | "formatting" | "code-action"> = ["rename", "formatting", "code-action"];
    for (const kind of kinds) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "refactor-apply-")));
      writeFileSync(join(dir, "session.json"), "{}");
      const p = join(dir, "a.ts");
      writeFileSync(p, "const x = 1;\n");
      const bus = { emit() {}, on: () => () => {} };
      const deps = {
        getBus: () => bus,
        getSessionFilePath: () => join(dir, "session.json"),
        getCanonicalWorkspaceRoot: () => dir,
      } as unknown as PatchToolDeps;
      const proposalId = globalRefactorPreviewCache.store(edit16(p), { stagedFiles: [{ filePath: p, originalContent: "const x = 1;\n", newContent: "const y = 1;\n", edits: [] }], diffString: "-const x = 1;\n+const y = 1;\n" }, {
        source: { kind: "workspace-edit", operation: kind, document: { canonicalPath: p, sha256: sha256OfString("const x = 1;\n") } },
        sessionId: hashSessionFilePath(join(dir, "session.json")),
        sessionRoot: dir,
      });
      try {
        const preview = await runBusPreview({
          deps,
          toolCallId: "t",
          label: `${kind}-preview`,
          kind,
          request: async () => ({ ok: true, proposalId, files: [p], diff: "-const x = 1;\n+const y = 1;\n" }),
        });
        const previewId = (preview.details as { previewId?: string }).previewId;
        assert.equal(previewId, proposalId);
        // No read authority in this harness, so the transaction rejects at the
        // coverage gate — identically for every kind. That proves the apply path
        // resolved the cached preview (not "unknown or expired") and routed
        // kind-agnostically past the cache into EditTransaction.
        const applied = await m.handleApplyRefactorPreview(deps, "t2", { kind: "apply-refactor-preview", previewId: previewId! });
        assert.match(applied.content[0]!.text, /read authority/, `${kind} must reach the transaction stage`);
        assert.ok(!/unknown or expired preview/.test(applied.content[0]!.text), `${kind} preview must resolve`);
      } finally {
        globalRefactorPreviewCache.delete(proposalId);
      }
    }
  });
});
