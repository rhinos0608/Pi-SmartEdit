/** First-class transfer integration through the registered tool.
 *
 * Real FS + read-authority coverage via `executeMutationKernel` (through
 * `createTransferTool.execute`): copy, move, new-file destination, and
 * existing-destination insertion, plus the create-new race guard and
 * transfer terminal identity (`details.tool === "transfer"`).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    resourceIdFor,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
} from "@rhinos0608/pi-workspace-protocol";
import { createTransferTool } from "../src/transfer/tool.js";
import type { PatchToolDeps } from "../src/patch.js";
import { createPriorAuthorityStore } from "../src/context/evidence-authority.js";
import { computeLineHashSync, initHashline } from "../src/hashline/hashline.js";
import { freshChecks } from "../src/patch/result-builders.js";
import { runPatchTransaction } from "../src/mutation/transaction-runner.js";

let hashlineInitialized = false;
async function ensureHashline(): Promise<void> {
    if (!hashlineInitialized) {
        await initHashline();
        hashlineInitialized = true;
    }
}
before(async () => { await ensureHashline(); });

function anchorFor(lineNum: number, text: string): string {
    return `${lineNum}${computeLineHashSync(lineNum, text)}`;
}

function sha256(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

function makeResource(canonicalPath: string, content: string): InspectedResource {
    const totalLines = content.split("\n").length;
    return {
        resourceId: resourceIdFor({ canonicalPath, kind: "full" }),
        canonicalPath,
        kind: "full",
        coverage: "full-file",
        allowedRanges: [{ startLine: 1, endLine: totalLines }],
        fullFileSha256: sha256(content),
        fresh: true,
        byteLength: Buffer.byteLength(content, "utf8"),
        lineCount: totalLines,
    };
}

function makeEnvelope(args: { sessionFilePath: string; canonicalRoot: string; resources: InspectedResource[] }): WorkspaceEvidenceEnvelope {
    const sessionId = hashSessionFilePath(args.sessionFilePath);
    const resourceKey = [...args.resources]
        .map((r) => `${r.canonicalPath}|${r.kind}|${r.allowedRanges.map((x) => `${x.startLine}-${x.endLine}`).join(",")}`)
        .sort()
        .join("\n");
    const inspectionId = createHash("sha256")
        .update(`inspection|${sessionId}|${args.canonicalRoot}\n${resourceKey}`, "utf8")
        .digest("hex");
    return {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: args.canonicalRoot,
        canonicalWorkspaceRoot: args.canonicalRoot,
        createdAt: new Date().toISOString(),
        resources: args.resources,
    };
}

function makeCtx(cwd: string): { cwd: string; hasUI: boolean; ui: unknown } {
    return { cwd, hasUI: false, ui: {} };
}

/** Deps with full prior read authority for every existing file; RPC must
 *  never fire (all authority is tool-owned). */
function depsWithPriorAuthority(workdir: string, sessionFilePath: string, files: string[]): PatchToolDeps {
    const store = createPriorAuthorityStore({ sessionFilePath, canonicalWorkspaceRoot: workdir });
    const resources = files.map((f) => makeResource(realpathSync(join(workdir, f)), readFileSync(join(workdir, f), "utf8")));
    store.record(makeEnvelope({ sessionFilePath, canonicalRoot: workdir, resources }));
    return {
        getRpcClient: () => ({
            request: async () => { throw new Error("prior authority must not use RPC"); },
            dispose: () => {},
        }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
        getPriorAuthority: () => store,
    };
}

test("transfer kernel: cross-file copy preserves the source and inserts at the anchor", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "xfer-kernel-")));
    const srcContent = "one\ntwo\nthree\n";
    const dstContent = "uno\ndos\n";
    writeFileSync(join(workdir, "a.ts"), srcContent, "utf8");
    writeFileSync(join(workdir, "b.ts"), dstContent, "utf8");
    const srcLines = srcContent.split("\n");
    const dstLines = dstContent.split("\n");
    const tool = createTransferTool(depsWithPriorAuthority(workdir, "/sessions/xfer-kernel.jsonl", ["a.ts", "b.ts"]));
    const res = await tool.execute("tk1", {
        transfers: [{
            op: "copy", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "b.ts", after: anchorFor(2, dstLines[1]!),
        }],
    }, undefined, undefined, makeCtx(workdir));
    const d = res.details as unknown as { status: { kind: string }; tool: string };
    assert.equal(d.status.kind, "applied");
    assert.equal(d.tool, "transfer");
    assert.equal(readFileSync(join(workdir, "a.ts"), "utf8"), srcContent, "copy source must be unchanged");
    assert.equal(readFileSync(join(workdir, "b.ts"), "utf8"), "uno\ndos\ntwo\n");
});

test("transfer kernel: cross-file move removes the source span", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "xfer-kernel-")));
    const srcContent = "one\ntwo\nthree\n";
    const dstContent = "uno\ndos\n";
    writeFileSync(join(workdir, "a.ts"), srcContent, "utf8");
    writeFileSync(join(workdir, "b.ts"), dstContent, "utf8");
    const srcLines = srcContent.split("\n");
    const dstLines = dstContent.split("\n");
    const tool = createTransferTool(depsWithPriorAuthority(workdir, "/sessions/xfer-kernel.jsonl", ["a.ts", "b.ts"]));
    const res = await tool.execute("tk2", {
        transfers: [{
            op: "move", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "b.ts", after: anchorFor(2, dstLines[1]!),
        }],
    }, undefined, undefined, makeCtx(workdir));
    const d = res.details as unknown as { status: { kind: string }; tool: string };
    assert.equal(d.status.kind, "applied");
    assert.equal(d.tool, "transfer");
    assert.equal(readFileSync(join(workdir, "a.ts"), "utf8"), "one\nthree\n");
    assert.equal(readFileSync(join(workdir, "b.ts"), "utf8"), "uno\ndos\ntwo\n");
});

test("transfer kernel: copy into a new file needs no prior destination authority", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "xfer-kernel-")));
    const srcContent = "one\ntwo\nthree\n";
    writeFileSync(join(workdir, "a.ts"), srcContent, "utf8");
    const srcLines = srcContent.split("\n");
    const tool = createTransferTool(depsWithPriorAuthority(workdir, "/sessions/xfer-kernel.jsonl", ["a.ts"]));
    const res = await tool.execute("tk3", {
        transfers: [{
            op: "copy", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "new.ts",
        }],
    }, undefined, undefined, makeCtx(workdir));
    const d = res.details as unknown as { status: { kind: string }; tool: string };
    assert.equal(d.status.kind, "applied", JSON.stringify(d));
    assert.equal(d.tool, "transfer");
    assert.equal(readFileSync(join(workdir, "new.ts"), "utf8"), "two");
    assert.equal(readFileSync(join(workdir, "a.ts"), "utf8"), srcContent, "copy source must be unchanged");
});

test("transfer kernel: existing destination prepends after `start`", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "xfer-kernel-")));
    const srcContent = "one\ntwo\nthree\n";
    const dstContent = "uno\ndos\n";
    writeFileSync(join(workdir, "a.ts"), srcContent, "utf8");
    writeFileSync(join(workdir, "b.ts"), dstContent, "utf8");
    const srcLines = srcContent.split("\n");
    const tool = createTransferTool(depsWithPriorAuthority(workdir, "/sessions/xfer-kernel.jsonl", ["a.ts", "b.ts"]));
    const res = await tool.execute("tk4", {
        transfers: [{
            op: "copy", from: "a.ts",
            range: { pos: anchorFor(1, srcLines[0]!), end: anchorFor(1, srcLines[0]!) },
            to: "b.ts", after: "start",
        }],
    }, undefined, undefined, makeCtx(workdir));
    const d = res.details as unknown as { status: { kind: string }; tool: string };
    assert.equal(d.status.kind, "applied", JSON.stringify(d));
    assert.equal(d.tool, "transfer");
    assert.equal(readFileSync(join(workdir, "b.ts"), "utf8"), "one\nuno\ndos\n");
});

test("transfer kernel: create-new race rejects before any write", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "xfer-kernel-")));
    mkdirSync(workdir, { recursive: true });
    // The destination already exists on disk, but the plan claims it as
    // `create-new` — exactly the post-planning race (another writer won).
    const existing = join(workdir, "raced.ts");
    writeFileSync(existing, "present\n", "utf8");
    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => { throw new Error("must not be called"); }, dispose: () => {} }),
        getSessionFilePath: () => "/sessions/xfer-race.jsonl",
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const checks = freshChecks();
    const diagnostics: string[] = [];
    const usedEvidence: string[] = [];
    const state = {
        checks, diagnostics, usedEvidence,
        invalidations: [],
        postEditEvidenceByPath: new Map(),
        repairsByPath: new Map(),
        finalizedFiles: [],
        appliedFiles: [],
        appliedCanonical: [],
        appliedSummaries: [],
        displayDiffs: [],
    };
    const result = await runPatchTransaction({
        deps,
        ctx: makeCtx(workdir),
        toolCallId: "tk-race",
        tool: "transfer",
        evidenceRefForDetails: { inspectionId: "", resourceIds: [] },
        canonicalRoot: workdir,
        envelope: null,
        priorStore: null,
        groups: [{ absolutePath: existing, rawPath: "raced.ts", edits: [] }],
        resourceIntents: [{ canonicalPath: existing, kind: "create-new" }],
        operations: [],
        state,
        stream: () => {},
    });
    assert.equal(result.ok, false, "create-new race must reject");
    if (result.ok) return;
    const d = result.result.details as unknown as { status: { kind: string; reason: string }; tool: string };
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "conflict");
    assert.equal(d.tool, "transfer");
    assert.match(String(diagnostics), /already exists/);
    assert.equal(readFileSync(existing, "utf8"), "present\n", "racy destination must be untouched");
    assert.ok(!existsSync(join(workdir, "other.ts")));
});

test("transfer kernel: invalid batch shape carries transfer identity", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "xfer-kernel-")));
    const tool = createTransferTool(depsWithPriorAuthority(workdir, "/sessions/xfer-kernel.jsonl", []));
    const res = await tool.execute("tk5", { transfers: [] }, undefined, undefined, makeCtx(workdir));
    const d = res.details as unknown as { status: { kind: string }; tool: string };
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.tool, "transfer");
});
