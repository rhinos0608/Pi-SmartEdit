import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRpcServer,
  RPC_CHANNELS,
  LANGUAGE_INTELLIGENCE_RPC_METHODS,
  hashSessionFilePath,
} from "@rhinos0608/pi-workspace-protocol";
import { globalRefactorPreviewCache } from "../src/lsp/refactor-preview-cache.js";
import { runBusPreview } from "../src/patch/refactor-preview.js";
import type { PatchToolDeps } from "../src/patch/types.js";

function makeBus() {
  const subs = new Map<string, Set<(d: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      const set = subs.get(channel);
      if (!set) return;
      for (const h of [...set]) h(data);
    },
    on(channel: string, handler: (d: unknown) => void) {
      if (!subs.has(channel)) subs.set(channel, new Set());
      subs.get(channel)!.add(handler);
      return () => subs.get(channel)!.delete(handler);
    },
  };
}

function depsFor(dir: string): PatchToolDeps {
  const bus = { emit() {}, on: () => () => {} };
  return {
    getBus: () => bus,
    getSessionFilePath: () => join(dir, "session.json"),
    getCanonicalWorkspaceRoot: () => dir,
  } as unknown as PatchToolDeps;
}

/** Stage a proposal directly in the preview cache, as the workspace-edit RPC
 *  server would after SmartRead stages through stage_workspace_edit. */
function stageLocalProposal(args: {
  dir: string;
  filePath: string;
  originalContent: string;
  newContent: string;
  diff: string;
}): string {
  const sessionFilePath = join(args.dir, "session.json");
  return globalRefactorPreviewCache.store(
    { positionEncoding: "utf-16", fileEdits: [] } as never,
    {
      stagedFiles: [
        {
          filePath: args.filePath,
          originalContent: args.originalContent,
          newContent: args.newContent,
          edits: [],
        },
      ],
      diffString: args.diff,
    } as never,
    {
      source: { kind: "workspace-edit", operation: "rename", document: undefined as never },
      sessionId: hashSessionFilePath(sessionFilePath),
      sessionRoot: args.dir,
    },
  );
}

describe("D-81 staged proposals (consumer)", () => {
  it("rename preview consumes a proposalId and never sees a workspaceEdit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d81-rename-"));
    writeFileSync(join(dir, "session.json"), "{}");
    const proposalId = stageLocalProposal({
      dir,
      filePath: "/a.ts",
      originalContent: "const x = 1;\n",
      newContent: "const y = 1;\n",
      diff: "-const x = 1;\n+const y = 1;\n",
    });
    try {
      // The wire reply carries a forged diff: the test fails if runBusPreview
      // surfaces wire-supplied text instead of the staged cache entry.
      const WIRE_DIFF = "forged wire diff — must never surface";
      const res = await runBusPreview({
        deps: depsFor(dir),
        toolCallId: "t",
        label: "rename-preview",
        kind: "rename",
        request: async () => ({ ok: true as const, proposalId, files: ["/a.ts"], diff: WIRE_DIFF }),
      } as never);
      const details = res.details as { previewId?: string; diff?: string; stagedFiles?: number };
      assert.equal(details.previewId, proposalId, "preview must reference the staged proposalId");
      assert.equal(details.diff, "-const x = 1;\n+const y = 1;\n", "preview diff must come from the staged cache entry, never the wire reply");
      assert.equal(details.stagedFiles, 1, "staged file count must come from the staged cache entry");
      assert.equal("workspaceEdit" in details, false, "staged proposal details must not carry a workspaceEdit");
      assert.match(res.content[0]!.text, /const y = 1/);
      assert.ok(!res.content[0]!.text.includes(WIRE_DIFF), "rendered preview must not include wire-supplied diff text");
    } finally {
      globalRefactorPreviewCache.delete(proposalId);
    }
  });

  it("formatting preview consumes a proposalId and never sees a workspaceEdit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d81-format-"));
    writeFileSync(join(dir, "session.json"), "{}");
    const proposalId = stageLocalProposal({
      dir,
      filePath: "/b.ts",
      originalContent: "const x=1;\n",
      newContent: "const x = 1;\n",
      diff: "-const x=1;\n+const x = 1;\n",
    });
    try {
      const res = await runBusPreview({
        deps: depsFor(dir),
        toolCallId: "t",
        label: "formatting",
        kind: "formatting",
        request: async () => ({ ok: true as const, proposalId, files: ["/b.ts"], diff: "-const x=1;\n+const x = 1;\n" }),
      } as never);
      assert.equal((res.details as { previewId?: string }).previewId, proposalId);
    } finally {
      globalRefactorPreviewCache.delete(proposalId);
    }
  });

  it("runBusPreview rejects a reply carrying workspaceEdit (fail-closed, no raw edits)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d81-rawedit-"));
    writeFileSync(join(dir, "session.json"), "{}");
    const p = join(dir, "a.ts");
    writeFileSync(p, "const x = 1;\n");
    const res = await runBusPreview({
      deps: depsFor(dir),
      toolCallId: "t",
      label: "rename-preview",
      kind: "rename",
      request: async () => ({
        ok: true,
        proposalId: "00000000-0000-0000-0000-000000000000",
        files: [p],
        diff: "forged",
        workspaceEdit: {
          positionEncoding: "utf-16",
          fileEdits: [
            { filePath: p, edits: [{ filePath: p, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "y" }] },
          ],
        },
      }),
    } as never);
    assert.equal(res.details.status.kind, "failed", "raw-edit reply must be rejected, never staged");
    assert.match(res.content[0]!.text, /workspaceEdit|unknown field|raw edit/i);
  });

  it("organize-imports consumer path is removed (no client, no RPC method, no preview kind)", async () => {
    const m = (await import("../src/lsp/lsp-smartread-client.js")) as unknown as Record<string, unknown>;
    assert.equal(m.requestOrganizeImports, undefined, "requestOrganizeImports must be removed");
    assert.equal(
      (LANGUAGE_INTELLIGENCE_RPC_METHODS as Record<string, unknown>).organizeImports,
      undefined,
      "protocol must no longer define organizeImports",
    );
  });

  it("code-action resolution requires explicit selection", async () => {
    const bus = makeBus();
    const m = (await import("../src/lsp/lsp-smartread-client.js")) as unknown as {
      resolveCodeAction: (b: unknown, r: unknown) => Promise<unknown>;
    };
    await assert.rejects(
      m.resolveCodeAction(bus as never, { filePath: "/a.ts", line: 1, character: 2 }),
      /selection/,
      "resolution without an explicit {actionId, sourceSha256} selection must be rejected client-side",
    );
  });

  it("code-action discovery reply carrying edits is rejected (edit-free candidates only)", async () => {
    const bus = makeBus();
    const srv = createRpcServer({
      bus,
      channel: RPC_CHANNELS.languageIntelligence,
      handler: async (req) => {
        if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction) {
          return {
            ok: true,
            actions: [{ title: "fix", actionId: "a".repeat(64), sourceSha256: "b".repeat(64), workspaceEdit: { fileEdits: [] } }],
          };
        }
        throw new Error("unknown rpc " + req.rpc);
      },
    });
    try {
      const { requestCodeAction } = await import("../src/lsp/lsp-smartread-client.js");
      await assert.rejects(
        requestCodeAction(bus as never, { filePath: "/a.ts", line: 1, character: 2 }),
        /unknown field|workspaceEdit|edit/i,
        "discovery candidates must be edit-free",
      );
    } finally {
      srv.dispose();
    }
  });

  it("rename client rejects a reply carrying workspaceEdit", async () => {
    const bus = makeBus();
    const srv = createRpcServer({
      bus,
      channel: RPC_CHANNELS.languageIntelligence,
      handler: async (req) => {
        if (req.rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview) {
          return { ok: true, proposalId: "p-1", files: ["/a.ts"], diff: "d", workspaceEdit: { fileEdits: [] } };
        }
        throw new Error("unknown rpc " + req.rpc);
      },
    });
    try {
      const { requestRenamePreview } = await import("../src/lsp/lsp-smartread-client.js");
      await assert.rejects(
        requestRenamePreview(bus as never, { filePath: "/a.ts", line: 0, character: 0, newName: "b" }),
        /unknown field|workspaceEdit/i,
        "raw-edit rename reply must be rejected by protocol validation",
      );
    } finally {
      srv.dispose();
    }
  });
});
