import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_SCHEMA_VERSION,
  hashSessionFilePath,
  inspectionIdFor,
  resourceIdFor,
  sha256OfString,
  createRpcClient,
  type LspWorkspaceEdit,
} from "@rhinos0608/pi-workspace-protocol";
import { createSessionState, type SessionState } from "../src/extension/session.js";
import { createPriorAuthorityStore } from "../src/context/evidence-authority.js";
import { buildPatchToolDeps } from "../src/extension/patch-deps.js";
import type { PatchToolDeps } from "../src/patch/types.js";
import {
  registerWorkspaceEditRpc,
  stageWorkspaceEdit,
  applyStagedEdit,
} from "../src/extension/register-workspace-edit-rpc.js";
import { getSnapshot } from "../src/context/read-cache.js";
import { fastHash } from "../src/core/types.js";
import { isDiagnosticsClaimed } from "../src/mutation/mutation-ownership.js";
import { getUndoHistory } from "../src/undo/edit-history.js";

type Bus = {
  emit: (c: string, d: unknown) => void;
  on: (c: string, h: (d: unknown) => void) => () => void;
};

function fakeBus(): Bus & { channels: Map<string, Array<(d: unknown) => void>> } {
  const channels = new Map<string, Array<(d: unknown) => void>>();
  return {
    channels,
    emit(c: string, d: unknown) {
      for (const h of channels.get(c) ?? []) queueMicrotask(() => { h(d); });
    },
    on(c: string, h: (d: unknown) => void) {
      const list = channels.get(c) ?? [];
      list.push(h);
      channels.set(c, list);
      return () => {
        channels.set(c, (channels.get(c) ?? []).filter((x) => x !== h));
      };
    },
  };
}

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-edit-rpc-")));
  const sessionFile = join(dir, "session.json");
  writeFileSync(sessionFile, "{}");
  const file = join(dir, "a.txt");
  writeFileSync(file, "hello\nworld\n");
  const session: SessionState = createSessionState();
  session.currentSessionFilePath = sessionFile;
  session.currentCanonicalWorkspaceRoot = dir;
  session.currentCwd = dir;
  session.priorAuthorityStore = createPriorAuthorityStore({
    sessionFilePath: sessionFile,
    canonicalWorkspaceRoot: dir,
  });
  // Grant read authority for the temp file (full-file, fresh SHA).
  const content = readFileSync(file, "utf8");
  const sha = sha256OfString(content);
  const sid = hashSessionFilePath(sessionFile);
  session.priorAuthorityStore.record({
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    inspectionId: inspectionIdFor({ sessionId: sid, workspaceRoot: dir, resources: [{ canonicalPath: file }] }),
    sessionId: sid,
    workspaceRoot: dir,
    canonicalWorkspaceRoot: dir,
    createdAt: new Date().toISOString(),
    resources: [
      {
        resourceId: resourceIdFor({ canonicalPath: file, kind: "full" }),
        canonicalPath: file,
        kind: "full",
        coverage: "full-file",
        allowedRanges: [{ startLine: 1, endLine: 2 }],
        fullFileSha256: sha,
        fresh: true,
      },
    ],
    mode: "path",
  });
  const bus = fakeBus();
  let finalLanesCalls = 0;
  const deps: PatchToolDeps = buildPatchToolDeps(session, bus, {
    runFinalSuccessLanes: async () => {
      finalLanesCalls++;
      return { diagnostics: [], checks: [], evidence: [] };
    },
  });
  return { dir, sessionFile, file, session, bus, deps, finalLanesCalls: () => finalLanesCalls };
}

function renameEdit(file: string, from: string, to: string): LspWorkspaceEdit {
  return {
    positionEncoding: "utf-16",
    fileEdits: [
      {
        filePath: file,
        edits: [
          { filePath: file, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: to },
        ],
      },
    ],
  };
}

describe("workspace-edit RPC", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("stage→apply round trip applies the change on disk", async () => {
    const edit = renameEdit(ctx.file, "hello", "HELLO");
    const staged = await stageWorkspaceEdit({
      deps: ctx.deps,
      payload: { workspaceEdit: edit, source: { operation: "rename" }, sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(staged.ok, true);
    if (!staged.ok) return;
    assert.match(staged.proposalId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(staged.files, [ctx.file]);
    assert.ok(staged.diff.length > 0);

    const applied = await applyStagedEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { proposalId: staged.proposalId, toolCallId: "lsp-1", sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.status, "applied");
    assert.deepEqual(applied.changedFiles, [ctx.file]);
    assert.equal(readFileSync(ctx.file, "utf8"), "HELLO\nworld\n");
  });

  it("stale file between stage and apply → rejected, file untouched", async () => {
    const staged = await stageWorkspaceEdit({
      deps: ctx.deps,
      payload: {
        workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
        source: { operation: "rename" },
        sessionFilePath: ctx.sessionFile,
        cwd: ctx.dir,
      },
    });
    assert.equal(staged.ok, true);
    if (!staged.ok) return;
    writeFileSync(ctx.file, "someone else\n");
    const applied = await applyStagedEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { proposalId: staged.proposalId, toolCallId: "lsp-2", sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, "rejected");
    assert.equal(readFileSync(ctx.file, "utf8"), "someone else\n");
  });

  it("unknown proposalId → rejected", async () => {
    const applied = await applyStagedEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: {
        proposalId: "00000000-0000-0000-0000-000000000000",
        toolCallId: "lsp-3",
        sessionFilePath: ctx.sessionFile,
        cwd: ctx.dir,
      },
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, "rejected");
  });

  it("foreign sessionFilePath → rejected on stage and apply", async () => {
    const staged = await stageWorkspaceEdit({
      deps: ctx.deps,
      payload: {
        workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
        source: { operation: "rename" },
        sessionFilePath: "/elsewhere/session.json",
        cwd: ctx.dir,
      },
    });
    assert.equal(staged.ok, false);

    const real = await stageWorkspaceEdit({
      deps: ctx.deps,
      payload: {
        workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
        source: { operation: "rename" },
        sessionFilePath: ctx.sessionFile,
        cwd: ctx.dir,
      },
    });
    assert.equal(real.ok, true);
    if (!real.ok) return;
    const applied = await applyStagedEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { proposalId: real.proposalId, toolCallId: "lsp-4", sessionFilePath: "/elsewhere/session.json", cwd: ctx.dir },
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, "rejected");
    assert.equal(readFileSync(ctx.file, "utf8"), "hello\nworld\n");
  });

  it("invalid payload → rejected", async () => {
    const staged = await stageWorkspaceEdit({ deps: ctx.deps, payload: { source: {}, sessionFilePath: ctx.sessionFile, cwd: ctx.dir } });
    assert.equal(staged.ok, false);
    const staged2 = await stageWorkspaceEdit({
      deps: ctx.deps,
      payload: {
        workspaceEdit: { positionEncoding: "utf-8", fileEdits: [] },
        source: { operation: "rename" },
        sessionFilePath: ctx.sessionFile,
        cwd: ctx.dir,
      },
    });
    assert.equal(staged2.ok, false);
    const applied = await applyStagedEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { proposalId: "", toolCallId: "", sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, "rejected");
  });

  it("apply runs post-mutation lanes: undo record, read cache, final lanes, diagnostics claim", async () => {
    const staged = await stageWorkspaceEdit({
      deps: ctx.deps,
      payload: {
        workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
        source: { operation: "rename" },
        sessionFilePath: ctx.sessionFile,
        cwd: ctx.dir,
      },
    });
    assert.equal(staged.ok, true);
    if (!staged.ok) return;
    const applied = await applyStagedEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { proposalId: staged.proposalId, toolCallId: "lsp-5", sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(applied.status, "applied");
    // Undo record exists.
    const history = await getUndoHistory(ctx.dir, ctx.file);
    assert.ok(history.length > 0, "expected an undo record for the applied refactor");
    // Read cache reflects new content (contentHash matches the applied content).
    assert.equal(getSnapshot(ctx.file, ctx.dir)?.contentHash, fastHash("HELLO\nworld\n"));
    // Final lanes invoked via injected deps.
    assert.equal(ctx.finalLanesCalls(), 1);
    // Diagnostics ownership claimed for the LSP tool call.
    assert.equal(isDiagnosticsClaimed("lsp-5"), true);
    // Prior authority advanced past the stale guard (full-file SHA matches new content).
    const selected = ctx.session.priorAuthorityStore?.select(ctx.file);
    assert.equal(selected?.fullFileSha256, sha256OfString("HELLO\nworld\n"));
  });

  it("two-file apply mints per-file narrow authority (no cross-file range leak)", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const fileA = join(ctx.dir, "leak-a.txt");
    const fileB = join(ctx.dir, "leak-b.txt");
    writeFileSync(fileA, lines.join("\n") + "\n");
    writeFileSync(fileB, lines.join("\n") + "\n");
    const sid = hashSessionFilePath(ctx.sessionFile);
    const grantRange = (file: string, range: { startLine: number; endLine: number }) => {
      const content = readFileSync(file, "utf8");
      ctx.session.priorAuthorityStore?.record({
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId: inspectionIdFor({ sessionId: sid, workspaceRoot: ctx.dir, resources: [{ canonicalPath: file }] }),
        sessionId: sid,
        workspaceRoot: ctx.dir,
        canonicalWorkspaceRoot: ctx.dir,
        createdAt: new Date().toISOString(),
        resources: [
          {
            resourceId: resourceIdFor({ canonicalPath: file, kind: "range", range }),
            canonicalPath: file,
            kind: "range",
            coverage: "line-range",
            allowedRanges: [range],
            fullFileSha256: sha256OfString(content),
            fresh: true,
          },
        ],
        mode: "path",
      });
    };
    grantRange(fileA, { startLine: 1, endLine: 10 });
    grantRange(fileB, { startLine: 80, endLine: 100 });
    const edit: LspWorkspaceEdit = {
      positionEncoding: "utf-16",
      fileEdits: [
        {
          filePath: fileA,
          edits: [
            { filePath: fileA, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, newText: "CHANGED-A" },
          ],
        },
        {
          filePath: fileB,
          edits: [
            { filePath: fileB, range: { start: { line: 89, character: 0 }, end: { line: 89, character: 7 } }, newText: "CHANGED-B" },
          ],
        },
      ],
    };
    const staged = await stageWorkspaceEdit({
      deps: ctx.deps,
      payload: { workspaceEdit: edit, source: { operation: "rename" }, sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(staged.ok, true);
    if (!staged.ok) return;
    const applied = await applyStagedEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { proposalId: staged.proposalId, toolCallId: "lsp-leak", sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(applied.status, "applied");
    const authA = ctx.session.priorAuthorityStore?.select(fileA);
    const authB = ctx.session.priorAuthorityStore?.select(fileB);
    assert.ok(authA, "expected post-apply authority for file A");
    assert.ok(authB, "expected post-apply authority for file B");
    for (const r of authA.allowedRanges) {
      assert.ok(r.endLine < 50, `file A authority leaked a high range: ${r.startLine}-${r.endLine}`);
    }
    for (const r of authB.allowedRanges) {
      assert.ok(r.startLine > 50, `file B authority leaked a low range: ${r.startLine}-${r.endLine}`);
    }
  });

  it("full RPC round trip over the event bus", async () => {
    const pi = {
      events: ctx.bus,
      registerTool: () => {},
    } as unknown as Parameters<typeof registerWorkspaceEditRpc>[0];
    const server = registerWorkspaceEditRpc(pi, ctx.session);
    try {
      const client = createRpcClient({ bus: ctx.bus, channel: "pi.workspace.workspace_edit.rpc", timeoutMs: 5000 });
      try {
        const s = await client.request("stage_workspace_edit", {
          workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
          source: { operation: "rename" },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        });
        assert.equal(s.ok, true);
        const stagePayload = s.payload as { ok: boolean; proposalId?: string };
        assert.equal(stagePayload.ok, true);
        const a = await client.request("apply_staged_edit", {
          proposalId: stagePayload.proposalId,
          toolCallId: "lsp-bus-1",
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        });
        assert.equal(a.ok, true);
        const applyPayload = a.payload as { ok: boolean; status?: string };
        assert.equal(applyPayload.ok, true);
        assert.equal(applyPayload.status, "applied");
        assert.equal(readFileSync(ctx.file, "utf8"), "HELLO\nworld\n");
      } finally {
        client.dispose();
      }
    } finally {
      server.dispose();
    }
  });
});
