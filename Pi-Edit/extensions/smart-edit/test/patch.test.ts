/**
 * Patch tool tests — additive single-file patch with workspace-evidence
 * authorization, mutation-queue freshness check, and lifecycle result.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync, readFileSync } from "node:fs";
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

import {
    resolvePatchAuthorization,
    createPatchTool,
    type PatchToolDeps,
} from "../src/patch.js";

function sha256(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

function makeResource(opts: {
    canonicalPath: string;
    full: boolean;
    content: string;
    range?: { startLine: number; endLine: number };
}): InspectedResource {
    const sha = sha256(opts.content);
    const totalLines = opts.content.split("\n").length;
    if (opts.full) {
        return {
            resourceId: resourceIdFor({ canonicalPath: opts.canonicalPath, kind: "full" }),
            canonicalPath: opts.canonicalPath,
            kind: "full",
            coverage: "full-file",
            allowedRanges: [{ startLine: 1, endLine: totalLines }],
            fullFileSha256: sha,
            fresh: true,
            byteLength: Buffer.byteLength(opts.content, "utf8"),
            lineCount: totalLines,
        };
    }
    if (!opts.range) throw new Error("range required for non-full");
    return {
        resourceId: resourceIdFor({
            canonicalPath: opts.canonicalPath,
            kind: "range",
            range: opts.range,
        }),
        canonicalPath: opts.canonicalPath,
        kind: "range",
        coverage: "line-range",
        allowedRanges: [opts.range],
        fullFileSha256: sha,
        fresh: true,
        byteLength: 0,
        lineCount: opts.range.endLine - opts.range.startLine + 1,
    };
}

function makeEnvelope(args: {
    sessionFilePath: string;
    canonicalRoot: string;
    resources: InspectedResource[];
}): WorkspaceEvidenceEnvelope {
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

function makeCtx(cwd: string): { cwd: string; hasUI: boolean; ui: unknown } {
    return { cwd, hasUI: false, ui: {} };
}

// ── resolvePatchAuthorization ────────────────────────────────────────

test("resolvePatchAuthorization: matches inspectionId+resourceIds and session", () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const file = join(workdir, "a.ts");
    const content = "alpha\nbeta\ngamma\ndelta\n";
    writeFileSync(file, content, "utf8");
    const canonicalFile = realpathSync(file);
    const sessionFilePath = "/sessions/p.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [makeResource({ canonicalPath: canonicalFile, full: true, content })],
    });

    const auth = resolvePatchAuthorization({
        envelope,
        sessionFilePath,
        canonicalWorkspaceRoot: workdir,
        requestedResourceIds: [envelope.resources[0]!.resourceId],
    });
    assert.equal(auth.ok, true);
    if (auth.ok) {
        assert.equal(auth.resource.canonicalPath, canonicalFile);
        assert.equal(auth.resource.fullFileSha256, sha256(content));
    }
});

test("resolvePatchAuthorization: rejects wrong session", () => {
    const env = makeEnvelope({
        sessionFilePath: "/sessions/a.jsonl",
        canonicalRoot: "/ws",
        resources: [makeResource({ canonicalPath: "/ws/a.ts", full: true, content: "x\n" })],
    });
    const auth = resolvePatchAuthorization({
        envelope: env,
        sessionFilePath: "/sessions/b.jsonl",
        canonicalWorkspaceRoot: "/ws",
        requestedResourceIds: [env.resources[0]!.resourceId],
    });
    assert.equal(auth.ok, false);
    if (!auth.ok) assert.match(auth.reason, /session/i);
});

test("resolvePatchAuthorization: rejects missing resourceId", () => {
    const env = makeEnvelope({
        sessionFilePath: "/sessions/a.jsonl",
        canonicalRoot: "/ws",
        resources: [makeResource({ canonicalPath: "/ws/a.ts", full: true, content: "x\n" })],
    });
    const auth = resolvePatchAuthorization({
        envelope: env,
        sessionFilePath: "/sessions/a.jsonl",
        canonicalWorkspaceRoot: "/ws",
        requestedResourceIds: ["nope"],
    });
    assert.equal(auth.ok, false);
    if (!auth.ok) assert.match(auth.reason, /resource|missing|not found/i);
});

test("resolvePatchAuthorization: rejects when target line range not in resource.allowedRanges", () => {
    const content = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";
    const env = makeEnvelope({
        sessionFilePath: "/sessions/a.jsonl",
        canonicalRoot: "/ws",
        resources: [
            makeResource({
                canonicalPath: "/ws/a.ts",
                full: false,
                content,
                range: { startLine: 1, endLine: 5 },
            }),
        ],
    });
    const auth = resolvePatchAuthorization({
        envelope: env,
        sessionFilePath: "/sessions/a.jsonl",
        canonicalWorkspaceRoot: "/ws",
        requestedResourceIds: [env.resources[0]!.resourceId],
        targetLineRange: { startLine: 7, endLine: 8 },
    });
    assert.equal(auth.ok, false);
    if (!auth.ok) assert.match(auth.reason, /coverage/i);
});

// ── end-to-end via createPatchTool ───────────────────────────────────

async function runApply(opts: {
    workdir: string;
    fileContent: string;
    envelopeContent: string;
    fullFile: boolean;
    range?: { startLine: number; endLine: number };
    edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>;
    rpc: (envelope: WorkspaceEvidenceEnvelope | null) => { ok: boolean; payload?: unknown; error?: string };
}) {
    const file = join(opts.workdir, "a.ts");
    writeFileSync(file, opts.fileContent, "utf8");
    const canonicalFile = realpathSync(file);
    const sessionFilePath = "/sessions/a.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: opts.workdir,
        resources: [
            makeResource({
                canonicalPath: canonicalFile,
                full: opts.fullFile,
                content: opts.envelopeContent,
                ...(opts.fullFile ? {} : { range: opts.range ?? { startLine: 1, endLine: 1 } }),
            }),
        ],
    });
    const resource = envelope.resources[0]!;
    const deps: PatchToolDeps = {
        getRpcClient: () => ({
            request: async () => {
                const r = opts.rpc(envelope);
                return {
                    kind: "reply" as const,
                    schemaVersion: PROTOCOL_SCHEMA_VERSION,
                    requestId: "r1",
                    ok: r.ok,
                    payload: r.payload,
                    error: r.error,
                };
            },
            dispose: () => {},
        }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => opts.workdir,
    };
    const tool = createPatchTool(deps);
    const res = await tool.execute(
        "tc1",
        {
            path: "a.ts",
            edits: opts.edits,
            evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: [resource.resourceId] },
            toolCallId: "tc1",
        },
        undefined,
        undefined,
        makeCtx(opts.workdir),
    );
    return { res, canonicalFile };
}

test("end-to-end: full-file apply succeeds with proper diff and postEditEvidence", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nbeta\ngamma\n";
    const after = "alpha\nBETA\ngamma\n";
    const { res, canonicalFile } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: (env) => ({ ok: true, payload: env }),
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied");
    const final = readFileSync(canonicalFile, "utf8");
    assert.equal(final, after);
    if (d.status.kind === "applied") {
        assert.ok(d.postEditEvidence);
        assert.equal(d.postEditEvidence.fullFileSha256, sha256(after));
        assert.equal(d.changedResources.length, 1);
        assert.equal(d.changedResources[0].canonicalPath, canonicalFile);
        assert.equal(d.changedResources[0].newFullFileSha256, sha256(after));
        assert.equal(d.usedEvidence.length, 1);
    }
});

test("end-to-end: rejects stale file (current sha != envelope.fullFileSha256)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const { res } = await runApply({
        workdir,
        fileContent: "alpha\nbeta\n",
        envelopeContent: "stale-version\n",
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: (env) => ({ ok: true, payload: env }),
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "stale");
});

test("end-to-end: rejects coverage when target line range is outside resource.allowedRanges", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const content = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";
    const { res } = await runApply({
        workdir,
        fileContent: content,
        envelopeContent: content,
        fullFile: false,
        range: { startLine: 1, endLine: 5 },
        edits: [{ oldText: "l7", newText: "L7" }],
        rpc: (env) => ({ ok: true, payload: env }),
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "coverage");
});

test("end-to-end: rejects when resolver returns missing-inspection error (status:rejected session)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const { res } = await runApply({
        workdir,
        fileContent: "alpha\nbeta\n",
        envelopeContent: "alpha\nbeta\n",
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: () => ({ ok: false, error: "rejected: unknown inspectionId" }),
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "session");
});

test("end-to-end: toolCallId carried through details on rejection", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const { res } = await runApply({
        workdir,
        fileContent: "alpha\nbeta\n",
        envelopeContent: "alpha\nbeta\n",
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: () => ({ ok: false, error: "rejected: unknown inspectionId" }),
    });
    const d = res.details as any;
    assert.equal(d.toolCallId, "tc1");
});

test("end-to-end: lifecycle checks expose evidence-pipeline check explicitly", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const { res } = await runApply({
        workdir,
        fileContent: "alpha\nbeta\n",
        envelopeContent: "alpha\nbeta\n",
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: () => ({ ok: false, error: "rejected: unknown inspectionId" }),
    });
    const d = res.details as unknown as { checks: { blocking: Array<{ id: string }>; completed: Array<{ id: string }>; advisory: Array<{ id: string }>; skipped: Array<{ id: string }>; timedOut: Array<{ id: string }> } };
    const allCheckIds: string[] = [
        ...d.checks.blocking.map((c: { id: string }) => c.id),
        ...d.checks.completed.map((c: { id: string }) => c.id),
        ...d.checks.advisory.map((c: { id: string }) => c.id),
        ...d.checks.skipped.map((c: { id: string }) => c.id),
        ...d.checks.timedOut.map((c: { id: string }) => c.id),
    ];
    assert.ok(
        allCheckIds.includes("evidence-pipeline"),
        `evidence-pipeline must appear in one of the check buckets (got: ${JSON.stringify(allCheckIds)})`,
    );
});

test("end-to-end: replaces via resolvePatchAuthorization, no parsing of rendered text", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    let rpcCalled = false;
    const file = join(workdir, "a.ts");
    const before = "alpha\nbeta\ngamma\n";
    writeFileSync(file, before, "utf8");
    const canonicalFile = realpathSync(file);
    const sessionFilePath = "/sessions/a.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [makeResource({ canonicalPath: canonicalFile, full: true, content: before })],
    });
    const resource = envelope.resources[0]!;
    const deps: PatchToolDeps = {
        getRpcClient: () => ({
            request: async () => {
                rpcCalled = true;
                return {
                    kind: "reply" as const,
                    schemaVersion: PROTOCOL_SCHEMA_VERSION,
                    requestId: "r1",
                    ok: true,
                    payload: envelope,
                };
            },
            dispose: () => {},
        }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const tool = createPatchTool(deps);
    const res = await tool.execute(
        "tc1",
        {
            path: "a.ts",
            edits: [{ oldText: "beta", newText: "BETA" }],
            evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: [resource.resourceId] },
            toolCallId: "tc1",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    assert.equal(rpcCalled, true, "rpc must be used (no parsing of rendered text)");
    const d = res.details as any;
    assert.equal(d.status.kind, "applied");
});

test("end-to-end: multi-file patch is rejected at validation (no multi-file atomic claim)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const file = join(workdir, "a.ts");
    writeFileSync(file, "alpha\nbeta\n", "utf8");
    const canonicalFile = realpathSync(file);
    const sessionFilePath = "/sessions/a.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [makeResource({ canonicalPath: canonicalFile, full: true, content: "alpha\nbeta\n" })],
    });
    const resource = envelope.resources[0]!;
    const deps: PatchToolDeps = {
        getRpcClient: () => ({
            request: async () => ({
                kind: "reply" as const,
                schemaVersion: PROTOCOL_SCHEMA_VERSION,
                requestId: "r1",
                ok: true,
                payload: envelope,
            }),
            dispose: () => {},
        }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const tool = createPatchTool(deps);
    const res = await tool.execute(
        "tc1",
        {
            path: "a.ts",
            edits: [
                { oldText: "alpha", newText: "ALPHA" },
                { oldText: "BETA", newText: "beta", path: "/some/other/file.ts" },
            ],
            evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: [resource.resourceId] },
            toolCallId: "tc1",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
});
