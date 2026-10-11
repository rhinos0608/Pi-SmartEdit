import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
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
import { verifySourceOriginDocument } from "../src/patch/source-origin.js";
import { globalRefactorPreviewCache } from "../src/lsp/refactor-preview-cache.js";
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
  let lastLanesCwd: string | null = null;
  const deps: PatchToolDeps = buildPatchToolDeps(session, bus, {
    runFinalSuccessLanes: async (args: { cwd: string }) => {
      finalLanesCalls++;
      lastLanesCwd = args.cwd;
      return { diagnostics: [], checks: [], evidence: [] };
    },
  });
  return { dir, sessionFile, file, session, bus, deps, finalLanesCalls: () => finalLanesCalls, lanesCwd: () => lastLanesCwd };
}

function grantFullFile(args: { session: SessionState; dir: string; sessionFile: string; file: string; endLine: number }): void {
  const { session, dir, sessionFile, file, endLine } = args;
  const content = readFileSync(file, "utf8");
  const sid = hashSessionFilePath(sessionFile);
  const store = session.priorAuthorityStore;
  assert.ok(store, "expected a prior-authority store on the test session");
  store.record({
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
        allowedRanges: [{ startLine: 1, endLine }],
        fullFileSha256: sha256OfString(content),
        fresh: true,
      },
    ],
    mode: "path",
  });
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

function originDoc(file: string): { canonicalPath: string; sha256: string } {
  const bytes = readFileSync(file);
  return {
    canonicalPath: realpathSync(file),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("workspace-edit RPC", () => {
  let ctx: ReturnType<typeof setup>;
  const tempDirsToClean: string[] = [];

  beforeEach(() => {
    ctx = setup();
    tempDirsToClean.push(ctx.dir);
  });

  afterEach(() => {
    while (tempDirsToClean.length > 0) {
      const d = tempDirsToClean.pop();
      if (d) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  });

  it("stage→apply round trip applies the change on disk", async () => {
    const edit = renameEdit(ctx.file, "hello", "HELLO");
    const staged = await stageWorkspaceEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { workspaceEdit: edit, source: { operation: "rename", document: originDoc(ctx.file) }, sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
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
      session: ctx.session,
      payload: {
        workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
        source: { operation: "rename", document: originDoc(ctx.file) },
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
      session: ctx.session,
      payload: {
        workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
        source: { operation: "rename", document: originDoc(ctx.file) },
        sessionFilePath: "/elsewhere/session.json",
        cwd: ctx.dir,
      },
    });
    assert.equal(staged.ok, false);

    const real = await stageWorkspaceEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: {
        workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
        source: { operation: "rename", document: originDoc(ctx.file) },
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
    const staged = await stageWorkspaceEdit({ deps: ctx.deps, session: ctx.session, payload: { source: {}, sessionFilePath: ctx.sessionFile, cwd: ctx.dir } });
    assert.equal(staged.ok, false);
    const staged2 = await stageWorkspaceEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: {
        workspaceEdit: { positionEncoding: "utf-8", fileEdits: [] },
        source: { operation: "rename", document: originDoc(ctx.file) },
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
      session: ctx.session,
      payload: {
        workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
        source: { operation: "rename", document: originDoc(ctx.file) },
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

  async function setupTwoFileEdit() {
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
      session: ctx.session,
      payload: { workspaceEdit: edit, source: { operation: "rename", document: originDoc(fileA) }, sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(staged.ok, true);
    if (!staged.ok) throw new Error("two-file stage failed");
    const applied = await applyStagedEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { proposalId: staged.proposalId, toolCallId: "lsp-leak", sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(applied.status, "applied");
    return { fileA, fileB };
  }

  it("two-file apply writes both files", async () => {
    const { fileA, fileB } = await setupTwoFileEdit();
    assert.ok(readFileSync(fileA, "utf8").includes("CHANGED-A"));
    assert.ok(readFileSync(fileB, "utf8").includes("CHANGED-B"));
  });

  it("two-file apply mints per-file narrow authority (no cross-file range leak)", async () => {
    const { fileA, fileB } = await setupTwoFileEdit();
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

  it("stage without prior read authority is rejected and leaks no diff", async () => {
    const other = join(ctx.dir, "unread.txt");
    writeFileSync(other, "top secret\n");
    const staged = await stageWorkspaceEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: {
        workspaceEdit: renameEdit(other, "secret", "SECRET"),
        source: { operation: "rename", document: originDoc(other) },
        sessionFilePath: ctx.sessionFile,
        cwd: ctx.dir,
      },
    });
    assert.equal(staged.ok, false);
    if (staged.ok) return;
    assert.match(staged.reason, /read authority/);
    assert.ok(!("diff" in staged) || !(staged as { diff?: string }).diff?.includes("top secret"));
    assert.ok(!("proposalId" in staged));
  });

  it("apply ignores caller-supplied cwd and uses the session directory", async () => {
    const edit = renameEdit(ctx.file, "hello", "HELLO");
    const staged = await stageWorkspaceEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { workspaceEdit: edit, source: { operation: "rename", document: originDoc(ctx.file) }, sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(staged.ok, true);
    if (!staged.ok) return;
    const applied = await applyStagedEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { proposalId: staged.proposalId, toolCallId: "lsp-evil-cwd", sessionFilePath: ctx.sessionFile, cwd: "/nonexistent-evil-dir" },
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.status, "applied");
    assert.equal(readFileSync(ctx.file, "utf8"), "HELLO\nworld\n");
    assert.equal(ctx.lanesCwd(), ctx.dir);
  });

  it("apply on a dangerous path succeeds with an advisory risk warning", async () => {
    const risky = join(ctx.dir, "app-config.ts");
    writeFileSync(risky, "export const x = 1;\n");
    grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: risky, endLine: 1 });
    const edit = renameEdit(risky, "x", "y");
    const staged = await stageWorkspaceEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { workspaceEdit: edit, source: { operation: "rename", document: originDoc(risky) }, sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(staged.ok, true);
    if (!staged.ok) return;
    const applied = await applyStagedEdit({
      deps: ctx.deps,
      session: ctx.session,
      payload: { proposalId: staged.proposalId, toolCallId: "lsp-risky", sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
    });
    assert.equal(applied.status, "applied");
    assert.ok(applied.diagnostics.some((d) => d.includes("Risk warning")), "expected an advisory risk warning in diagnostics");
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
          source: { operation: "rename", document: originDoc(ctx.file) },
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

  describe("action-origin generation precondition (defect regression)", () => {
    it("staged edit with stale source document generation (H0->H1 with refreshed authority) is rejected and not cached", async () => {
      // 1. Prepare proposal against source H0
      const contentH0 = readFileSync(ctx.file, "utf8");
      const h0 = sha256OfString(contentH0);
      const edit = renameEdit(ctx.file, "hello", "HELLO");

      // 2. Mutate disk to H1 (so line 0 is no longer "hello")
      writeFileSync(ctx.file, "header\nhello\nworld\n");
      const contentH1 = readFileSync(ctx.file, "utf8");
      const h1 = sha256OfString(contentH1);
      assert.notEqual(h0, h1, "disk content must have changed from H0 to H1");

      // 3. Refresh session read authority to H1
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: ctx.file, endLine: 3 });
      const authorityH1 = ctx.session.priorAuthorityStore?.select(ctx.file);
      assert.equal(authorityH1?.fullFileSha256, h1, "session read authority must be refreshed to H1");

      // 4. Stage old H0-derived positional edits with source.document carrying generation H0
      const cacheSizeBefore = globalRefactorPreviewCache.size();
      const staged = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: edit,
          source: {
            operation: "rename",
            document: {
              canonicalPath: ctx.file,
              sha256: h0,
            },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });

      // Expected: staging refusal, no cached proposal, disk untouched
      // (Current old code incorrectly accepts because authority H1 matches planner H1)
      assert.equal(staged.ok, false, "staged edit must be refused when source document generation is stale (H0 != H1)");
      assert.equal("proposalId" in staged, false, "rejected staging must not produce a proposalId");
      assert.equal(globalRefactorPreviewCache.size(), cacheSizeBefore, "rejected staging must not cache any proposal");
      assert.equal(readFileSync(ctx.file, "utf8"), contentH1, "disk must remain untouched");
    });

    it("staged edit with stale origin document outside edit list is rejected and does not mutate disk", async () => {
      // 1. Origin document at originH0
      const originFile = join(ctx.dir, "origin.ts");
      writeFileSync(originFile, "export function original() {}\n");
      const originH0 = sha256OfString(readFileSync(originFile, "utf8"));
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: originFile, endLine: 1 });

      // 2. Target document (the only file in the proposal edit list)
      const targetFile = join(ctx.dir, "target.ts");
      const targetInitial = "import { original } from './origin.js';\noriginal();\n";
      writeFileSync(targetFile, targetInitial);
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: targetFile, endLine: 2 });

      // Proposal derived from action on originFile at originH0, editing targetFile
      const edit: LspWorkspaceEdit = {
        positionEncoding: "utf-16",
        fileEdits: [
          {
            filePath: targetFile,
            edits: [
              { filePath: targetFile, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } }, newText: "modified" },
            ],
          },
        ],
      };

      // 3. Mutate origin document on disk to originH1
      writeFileSync(originFile, "export function mutated() {}\n");
      const originH1 = sha256OfString(readFileSync(originFile, "utf8"));
      assert.notEqual(originH0, originH1, "origin file must have changed from H0 to H1");

      // 4. Refresh session read authority for originFile to originH1
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: originFile, endLine: 1 });
      assert.equal(ctx.session.priorAuthorityStore?.select(originFile)?.fullFileSha256, originH1);

      // Target file remains untouched and authorized
      assert.equal(readFileSync(targetFile, "utf8"), targetInitial);

      // 5. Stage request with source.document pointing to originFile at stale generation originH0
      const cacheSizeBefore = globalRefactorPreviewCache.size();
      const staged = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: edit,
          source: {
            operation: "codeAction",
            document: {
              canonicalPath: originFile,
              sha256: originH0,
            },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });

      // Expected: staging refusal because origin document is stale, even though origin is not in edit list
      // (Current old code only checks files in edit list, so incorrectly accepts)
      assert.equal(staged.ok, false, "staged edit must be refused when origin document is stale even if origin is not in edit list");
      assert.equal("proposalId" in staged, false, "rejected staging must not produce a proposalId");
      assert.equal(globalRefactorPreviewCache.size(), cacheSizeBefore, "rejected staging must not cache any proposal");
      assert.equal(readFileSync(targetFile, "utf8"), targetInitial, "target file must not be modified");
      assert.equal(readFileSync(originFile, "utf8"), "export function mutated() {}\n", "origin file must remain as mutated");
    });

    it("staged edit with stale origin document outside workspace cwd (no path jail) is rejected for staleness", async () => {
      // 1. Origin document outside workspace cwd
      const extDir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-edit-ext-")));
      tempDirsToClean.push(extDir);
      const extOrigin = join(extDir, "shared-origin.ts");
      writeFileSync(extOrigin, "export const SHARED_SYMBOL = 1;\n");
      const extH0 = sha256OfString(readFileSync(extOrigin, "utf8"));
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: extOrigin, endLine: 1 });

      // Target file is within session workspace (ctx.file)
      const edit = renameEdit(ctx.file, "hello", "HELLO");

      // 2. Mutate external origin file to extH1
      writeFileSync(extOrigin, "export const SHARED_SYMBOL = 2;\n");
      const extH1 = sha256OfString(readFileSync(extOrigin, "utf8"));
      assert.notEqual(extH0, extH1, "external origin must have changed from H0 to H1");

      // 3. Refresh session read authority for external origin to extH1
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: extOrigin, endLine: 1 });
      assert.equal(ctx.session.priorAuthorityStore?.select(extOrigin)?.fullFileSha256, extH1);

      // 4. Stage request with stale generation extH0 for external origin
      const cacheSizeBefore = globalRefactorPreviewCache.size();
      const staged = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: edit,
          source: {
            operation: "codeAction",
            document: {
              canonicalPath: extOrigin,
              sha256: extH0,
            },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });

      // Expected: staging refusal for staleness (not due to a path jail, but because extOrigin is stale)
      // (Current old code ignores source.document entirely and accepts)
      assert.equal(staged.ok, false, "staged edit must be refused when external origin document is stale");
      assert.equal("proposalId" in staged, false, "rejected staging must not produce a proposalId");
      assert.equal(globalRefactorPreviewCache.size(), cacheSizeBefore, "no proposal should be cached");
      assert.equal(readFileSync(ctx.file, "utf8"), "hello\nworld\n", "file on disk must remain untouched");
    });

    it("origin changes AFTER successful stage but is outside edit list => apply rejected/zero writes", async () => {
      const originFile = join(ctx.dir, "apply-origin.ts");
      writeFileSync(originFile, "export const ORIGIN_VAR = 1;\n");
      const originSha = originDoc(originFile).sha256;

      const targetFile = join(ctx.dir, "apply-target.ts");
      writeFileSync(targetFile, "target initial content\n");
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: targetFile, endLine: 1 });

      const edit = renameEdit(targetFile, "target", "TARGET");
      const staged = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: edit,
          source: {
            operation: "codeAction",
            document: { canonicalPath: originFile, sha256: originSha },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(staged.ok, true, "stage must succeed when origin is fresh");
      if (!staged.ok) return;

      // Mutate origin file on disk AFTER stage
      writeFileSync(originFile, "export const ORIGIN_VAR = 2;\n");

      // Apply must be rejected because origin document changed
      const applied = await applyStagedEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: { proposalId: staged.proposalId, toolCallId: "lsp-apply-origin-stale", sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
      });
      assert.equal(applied.ok, false, "apply must be rejected when origin document changed after stage");
      assert.equal(applied.status, "rejected");
      assert.equal(readFileSync(targetFile, "utf8"), "target initial content\n", "target file must have zero writes on disk");
    });

    it("current origin outsidecwd accepted with valid authority for edited targets", async () => {
      const extDir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-edit-ext-ok-")));
      tempDirsToClean.push(extDir);
      const extOrigin = join(extDir, "shared-origin.ts");
      writeFileSync(extOrigin, "export const SHARED_EXT = 42;\n");
      const extSha = originDoc(extOrigin).sha256;

      const edit = renameEdit(ctx.file, "hello", "HELLO");
      const staged = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: edit,
          source: {
            operation: "codeAction",
            document: { canonicalPath: extOrigin, sha256: extSha },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(staged.ok, true, "fresh origin outside cwd must be accepted");
      if (!staged.ok) return;

      const applied = await applyStagedEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: { proposalId: staged.proposalId, toolCallId: "lsp-ext-ok", sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
      });
      assert.equal(applied.ok, true, "apply must succeed when external origin is fresh");
      assert.equal(applied.status, "applied");
      assert.equal(readFileSync(ctx.file, "utf8"), "HELLO\nworld\n");
    });

    it("canonical symlink rebind/refusal", async () => {
      const realFile = join(ctx.dir, "symlink-real.ts");
      writeFileSync(realFile, "export const S = 1;\n");
      const linkFile = join(ctx.dir, "symlink-link.ts");
      symlinkSync(realFile, linkFile);
      const sha = originDoc(realFile).sha256;

      // linkFile is non-canonical (symlink)
      const staged = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
          source: {
            operation: "rename",
            document: { canonicalPath: linkFile, sha256: sha },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(staged.ok, false, "symlink origin path must be refused");
      assert.match(staged.reason ?? "", /symlink rebind|not canonical/i);
    });

    it("absent/malformed/missing/directory source", async () => {
      // 1. Missing source.document
      const absent = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
          source: { operation: "rename" },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(absent.ok, false, "missing source.document must be rejected");

      // 2. Malformed: relative canonicalPath
      const relativePath = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
          source: {
            operation: "rename",
            document: { canonicalPath: "relative.ts", sha256: originDoc(ctx.file).sha256 },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(relativePath.ok, false, "relative canonicalPath must be rejected");

      // 3. Malformed: non-hex sha
      const badSha = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
          source: {
            operation: "rename",
            document: { canonicalPath: ctx.file, sha256: "not-a-valid-sha" },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(badSha.ok, false, "non-hex sha must be rejected");

      // 4. Missing file on disk
      const missingFile = join(ctx.dir, "does-not-exist.ts");
      const missing = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
          source: {
            operation: "rename",
            document: { canonicalPath: missingFile, sha256: "0".repeat(64) },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(missing.ok, false, "missing source file must be rejected");
      assert.match(missing.reason ?? "", /does not exist|ENOENT/i);

      // 5. Directory path instead of file
      const dirOrigin = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
          source: {
            operation: "rename",
            document: { canonicalPath: ctx.dir, sha256: "0".repeat(64) },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(dirOrigin.ok, false, "directory origin must be rejected");
      assert.match(dirOrigin.reason ?? "", /not a regular file/i);
    });

    it("BOM/raw digest", async () => {
      const bomFile = join(ctx.dir, "bom-test.ts");
      const rawBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const BOM = 1;\n", "utf8")]);
      writeFileSync(bomFile, rawBytes);
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: bomFile, endLine: 1 });

      const rawSha = createHash("sha256").update(rawBytes).digest("hex");
      const textWithoutBomSha = createHash("sha256").update("export const BOM = 1;\n", "utf8").digest("hex");
      assert.notEqual(rawSha, textWithoutBomSha, "raw digest with BOM must differ from digest without BOM");

      // 1. Stage with rawSha succeeds
      const stagedRaw = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: renameEdit(bomFile, "BOM", "RENAMED"),
          source: {
            operation: "rename",
            document: { canonicalPath: realpathSync(bomFile), sha256: rawSha },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(stagedRaw.ok, true, stagedRaw.ok ? "" : (stagedRaw as { reason: string }).reason);

      // 2. Stage with textWithoutBomSha fails
      const stagedWithoutBom = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: renameEdit(bomFile, "BOM", "RENAMED"),
          source: {
            operation: "rename",
            document: { canonicalPath: realpathSync(bomFile), sha256: textWithoutBomSha },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(stagedWithoutBom.ok, false, "stage with non-raw digest must fail");
    });

    it("refreshed authority never bypasses origin", async () => {
      const originFile = join(ctx.dir, "bypass-origin.ts");
      writeFileSync(originFile, "export const INITIAL = 1;\n");
      const h0 = originDoc(originFile).sha256;

      // Proposal prepared against h0
      const edit = renameEdit(ctx.file, "hello", "HELLO");

      // Origin mutates to h1
      writeFileSync(originFile, "export const MUTATED = 2;\n");
      const h1 = originDoc(originFile).sha256;
      assert.notEqual(h0, h1);

      // Session authority store is aggressively refreshed for originFile and ctx.file
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: originFile, endLine: 1 });
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: ctx.file, endLine: 2 });
      assert.equal(ctx.session.priorAuthorityStore?.select(originFile)?.fullFileSha256, h1);

      // Attempt to stage with h0 (old proposal generation): refreshed authority must NOT bypass origin check
      const staged = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: edit,
          source: {
            operation: "codeAction",
            document: { canonicalPath: originFile, sha256: h0 },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(staged.ok, false, "refreshed authority must never bypass stale origin generation check");
    });

    it("scheduled origin mutation during staging is refused", async () => {
      const origin = join(ctx.dir, "deferred-origin.ts");
      writeFileSync(origin, "export const ORIGIN_V1 = 1;\n");
      const doc = originDoc(origin);
      const target = ctx.file;

      let deferredFired = false;
      const timer = setImmediate(() => {
        deferredFired = true;
        writeFileSync(origin, "export const ORIGIN_V2 = 2;\n");
      });

      try {
        const staged = await stageWorkspaceEdit({
          deps: ctx.deps,
          session: ctx.session,
          payload: {
            workspaceEdit: renameEdit(target, "hello", "HELLO"),
            source: { operation: "rename", document: doc },
            sessionFilePath: ctx.sessionFile,
            cwd: ctx.dir,
          },
        });
        assert.equal(deferredFired, true, "scheduled mutation must have fired before staging returned");
        assert.equal(staged.ok, false, "stage must be refused when origin changed during staging");
        assert.match(staged.reason ?? "", /generation mismatch/i);
      } finally {
        clearImmediate(timer);
      }
    });

    it("error messages never leak source content", async () => {
      const secretFile = join(ctx.dir, "secret.ts");
      const secretContent = "TOP_SECRET_PROPRIETARY_KEY_9876543210\n";
      writeFileSync(secretFile, secretContent);
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: secretFile, endLine: 1 });

      const wrongSha = "f".repeat(64);
      const staged = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: renameEdit(ctx.file, "hello", "HELLO"),
          source: {
            operation: "rename",
            document: { canonicalPath: secretFile, sha256: wrongSha },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(staged.ok, false);
      const reason = staged.reason ?? "";
      assert.ok(reason.length > 0);
      assert.equal(reason.includes("TOP_SECRET"), false, "error message must never leak source content");
      assert.equal(reason.includes("9876543210"), false, "error message must never leak sensitive source tokens");
    });

    it("RED 1: cached origin document must be an immutable snapshot; caller payload mutation after stage must not bypass apply", async () => {
      const originFile = join(ctx.dir, "immut-origin.ts");
      writeFileSync(originFile, "export const IMMUT = 1;\n");
      const originH0 = originDoc(originFile).sha256;

      const targetFile = join(ctx.dir, "immut-target.ts");
      const targetInitial = "target initial content\n";
      writeFileSync(targetFile, targetInitial);
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: targetFile, endLine: 1 });

      // Caller holds a direct reference to the document object inside payload
      const docRef = { canonicalPath: realpathSync(originFile), sha256: originH0 };
      const payload = {
        workspaceEdit: renameEdit(targetFile, "target", "TARGET"),
        source: {
          operation: "codeAction",
          document: docRef,
        },
        sessionFilePath: ctx.sessionFile,
        cwd: ctx.dir,
      };

      const staged = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload,
      });
      assert.equal(staged.ok, true, "staging must succeed initially");
      if (!staged.ok) return;

      // Mutate origin file on disk to H1
      writeFileSync(originFile, "export const IMMUT = 2;\n");
      const originH1 = originDoc(originFile).sha256;
      assert.notEqual(originH0, originH1);

      // Caller mutates the original payload document reference to H1
      docRef.sha256 = originH1;

      // Refresh target authority so target authority is valid
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: targetFile, endLine: 1 });

      // Apply must reject because preview cache must hold an immutable snapshot of H0, not docRef
      const applied = await applyStagedEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: { proposalId: staged.proposalId, toolCallId: "lsp-immut-mut", sessionFilePath: ctx.sessionFile, cwd: ctx.dir },
      });

      assert.equal(applied.ok, false, "apply must reject when caller mutated original payload document reference");
      assert.equal(applied.status, "rejected");
      assert.equal(readFileSync(targetFile, "utf8"), targetInitial, "target file must remain untouched");
    });

    it("RED 2: bounded IO must refuse origin document that grows beyond 4MB after stat check", async () => {
      const originFile = join(ctx.dir, "grown-origin.bin");
      tempDirsToClean.push(originFile);
      const initialBytes = Buffer.alloc(1024, "a"); // 1 KB initially
      const appendBytes = Buffer.alloc(4.5 * 1024 * 1024, "b"); // 4.5 MB append
      const fullBytes = Buffer.concat([initialBytes, appendBytes]);
      // Expected SHA intentionally matches the final overgrown file to isolate SIZE failure
      const fullSha = createHash("sha256").update(fullBytes).digest("hex");
      writeFileSync(originFile, initialBytes);

      // Schedule a deferred mutation that appends 4.5MB right after statSync completes,
      // while the async read is in flight
      const verifyPromise = verifySourceOriginDocument({
        canonicalPath: realpathSync(originFile),
        sha256: fullSha,
      });
      process.nextTick(() => {
        appendFileSync(originFile, appendBytes);
      });

      const res = await verifyPromise;
      // Must refuse because the file grew beyond 4MB, even though the SHA matches the larger file
      assert.equal(res.ok, false, "must refuse origin document exceeding 4MB cap during read");
      assert.match((res as { reason: string }).reason, /exceeds size cap|4194304/i);
    });

    it("RED 3: staging must not publish preview when origin is mutated after planner consumed origin bytes", async () => {
      const originFile = join(ctx.dir, "multi-plan-origin.ts");
      writeFileSync(originFile, "export const ORIGIN_SEAM3 = 1;\n");
      const originH0 = originDoc(originFile).sha256;
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: originFile, endLine: 1 });

      const targetFile = join(ctx.dir, "multi-plan-target.ts");
      writeFileSync(targetFile, "export const TARGET_SEAM3 = 1;\n");
      const targetH0 = originDoc(targetFile).sha256;
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: targetFile, endLine: 1 });

      // Proposal edits BOTH origin and target (origin is read first by planner)
      const edit: LspWorkspaceEdit = {
        positionEncoding: "utf-16",
        fileEdits: [
          {
            filePath: originFile,
            edits: [
              { filePath: originFile, range: { start: { line: 0, character: 28 }, end: { line: 0, character: 29 } }, newText: "2" },
            ],
          },
          {
            filePath: targetFile,
            edits: [
              { filePath: targetFile, range: { start: { line: 0, character: 28 }, end: { line: 0, character: 29 } }, newText: "2" },
            ],
          },
        ],
      };

      // Hook getPriorAuthority to fire mutation right after planPositionalEdits finishes reading all files
      let mutatedAfterPlanner = false;
      const hookedDeps: PatchToolDeps = {
        ...ctx.deps,
        getPriorAuthority: () => {
          if (!mutatedAfterPlanner) {
            mutatedAfterPlanner = true;
            // Mutate origin on disk to H1 after planner consumed origin bytes
            writeFileSync(originFile, "export const ORIGIN_SEAM3 = 999;\n");
            // Target authority is refreshed if needed
            grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: targetFile, endLine: 1 });
          }
          return ctx.session.priorAuthorityStore;
        },
      };

      const cacheSizeBefore = globalRefactorPreviewCache.size();
      const staged = await stageWorkspaceEdit({
        deps: hookedDeps,
        session: ctx.session,
        payload: {
          workspaceEdit: edit,
          source: {
            operation: "rename",
            document: { canonicalPath: realpathSync(originFile), sha256: originH0 },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });

      assert.equal(mutatedAfterPlanner, true, "mutation must have fired after planner read");
      // Current code fails this assertion because it only checked verifyExactOriginBytes and published
      assert.equal(staged.ok, false, "staging must not publish preview when origin changed after planner read");
      assert.equal(globalRefactorPreviewCache.size(), cacheSizeBefore, "must not cache preview");
    });

    it("RED 4: apply must recheck origin immediately before writes and reject if origin changed during target stale check / journal PREPARED", async () => {
      const originFile = join(ctx.dir, "apply-race-origin.ts");
      writeFileSync(originFile, "export const APPLY_RACE_O = 1;\n");
      const originH0 = originDoc(originFile).sha256;

      const targetFile = join(ctx.dir, "apply-race-target.ts");
      const targetInitial = "target initial content for apply race\n";
      writeFileSync(targetFile, targetInitial);
      grantFullFile({ session: ctx.session, dir: ctx.dir, sessionFile: ctx.sessionFile, file: targetFile, endLine: 1 });

      const edit = renameEdit(targetFile, "target", "TARGET");
      const staged = await stageWorkspaceEdit({
        deps: ctx.deps,
        session: ctx.session,
        payload: {
          workspaceEdit: edit,
          source: {
            operation: "codeAction",
            document: { canonicalPath: realpathSync(originFile), sha256: originH0 },
          },
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });
      assert.equal(staged.ok, true, "staging must succeed");
      if (!staged.ok) return;

      // Hook getPriorAuthority during apply (called by findPreviewUnauthorizedFiles inside verifyPreviewPreconditions,
      // after verifySourceOriginDocument and findStalePreviewFiles have already succeeded)
      let mutatedDuringApply = false;
      const hookedApplyDeps: PatchToolDeps = {
        ...ctx.deps,
        getPriorAuthority: () => {
          if (!mutatedDuringApply) {
            mutatedDuringApply = true;
            // Origin mutates to H1 while target preconditions / journal prepared write are in flight
            writeFileSync(originFile, "export const APPLY_RACE_O = 2;\n");
          }
          return ctx.session.priorAuthorityStore;
        },
      };

      const applied = await applyStagedEdit({
        deps: hookedApplyDeps,
        session: ctx.session,
        payload: {
          proposalId: staged.proposalId,
          toolCallId: "lsp-apply-race",
          sessionFilePath: ctx.sessionFile,
          cwd: ctx.dir,
        },
      });

      assert.equal(mutatedDuringApply, true, "origin mutation must have fired during apply preconditions");
      // Current code fails this assertion because it only checked origin once at start of verifyPreviewPreconditions
      assert.equal(applied.ok, false, "apply must reject after final origin generation check before writes");
      assert.equal(applied.status, "rejected");
      assert.equal(readFileSync(targetFile, "utf8"), targetInitial, "target file must have zero writes on disk");
    });
  });
});
