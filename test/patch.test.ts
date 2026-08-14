/**
 * Patch tool tests — additive single-file patch with workspace-evidence
 * authorization, mutation-queue freshness check, and lifecycle result.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    resourceIdFor,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
    type PatchDetails,
} from "@rhinos0608/pi-workspace-protocol";

import {
    resolvePatchAuthorization,
    createPatchTool,
    type PatchToolDeps,
    type VerificationCheck,
} from "../src/patch.js";
import { createPriorAuthorityStore } from "../src/evidence-authority.js";

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
    checks?: VerificationCheck[];
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
        ...(opts.checks ? { getVerificationChecks: () => opts.checks! } : {}),
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

test("end-to-end: multi-file patch with per-edit paths (v3)", async () => {
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
    // v3: multi-file is allowed. Second edit targets non-existent file with no evidence → fails.
    assert.equal(d.status.kind, "failed");
});

// ── Review-fix regression tests (B1-B4) ──────────────────────────────

test("end-to-end: auto-inspect fallback is reachable when evidenceRef is omitted entirely (not just empty)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const file = join(workdir, "a.ts");
    writeFileSync(file, "alpha\nbeta\n", "utf8");
    const sessionFilePath = "/sessions/a.jsonl";
    const deps: PatchToolDeps = {
        getRpcClient: () => ({
            request: async () => {
                throw new Error("rpc must not be called when evidenceRef is omitted");
            },
            dispose: () => {},
        }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const tool = createPatchTool(deps);
    // No evidenceRef field at all in params — schema-conforming auto-inspect call.
    const res = await tool.execute(
        "tc1",
        {
            path: "a.ts",
            edits: [{ oldText: "beta", newText: "BETA" }],
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "applied");
    const final = readFileSync(realpathSync(file), "utf8");
    assert.equal(final, "alpha\nBETA\n");
});

test("end-to-end: toolCallId is not required in the wire payload (Pi supplies it as the execute() argument)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const file = join(workdir, "a.ts");
    writeFileSync(file, "alpha\nbeta\n", "utf8");
    const sessionFilePath = "/sessions/a.jsonl";
    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => { throw new Error("unused"); }, dispose: () => {} }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const tool = createPatchTool(deps);
    // Schema-conforming params per PATCH_PARAMS_DOC: no toolCallId field.
    const res = await tool.execute(
        "tc-from-harness",
        { path: "a.ts", edits: [{ oldText: "beta", newText: "BETA" }] },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "applied");
    assert.equal(d.toolCallId, "tc-from-harness");
});

test("end-to-end: successful multi-file patch returns renderable diffs for every file", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    const file1 = join(workdir, "a.ts");
    const file2 = join(workdir, "b.ts");
    writeFileSync(file1, "alpha\nbeta\n", "utf8");
    writeFileSync(file2, "gamma\ndelta\n", "utf8");

    const deps: PatchToolDeps = {
        getRpcClient: () => { throw new Error("auto-inspect must not use RPC"); },
        getSessionFilePath: () => "/sessions/a.jsonl",
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const res = await createPatchTool(deps).execute(
        "tc-diffs",
        { edits: [
            { path: "a.ts", oldText: "alpha", newText: "ALPHA" },
            { path: "b.ts", oldText: "gamma", newText: "GAMMA" },
        ] },
        undefined,
        undefined,
        makeCtx(workdir),
    );

    const details = res.details as PatchDetails & {
        diff?: string;
        diffs?: Array<{ path: string; diff: string }>;
    };
    assert.equal(details.status.kind, "applied");
    assert.equal(details.diffs?.length, 2);
    assert.deepEqual(details.diffs?.map((entry) => entry.path), ["a.ts", "b.ts"]);
    assert.match(details.diffs?.[0]?.diff ?? "", /-1 alpha/);
    assert.match(details.diffs?.[0]?.diff ?? "", /\+1 ALPHA/);
    assert.match(details.diff ?? "", /a\.ts/);
    assert.match(details.diff ?? "", /b\.ts/);
});

test("end-to-end: multi-file pre-write failure restores earlier staged writes", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const file1 = join(workdir, "a.ts");
    const file2 = join(workdir, "b.ts");
    writeFileSync(file1, "alpha\nbeta\n", "utf8");
    writeFileSync(file2, "gamma\ndelta\n", "utf8");
    const canonical1 = realpathSync(file1);
    const canonical2 = realpathSync(file2);
    const sessionFilePath = "/sessions/a.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [
            makeResource({ canonicalPath: canonical1, full: true, content: "alpha\nbeta\n" }),
            makeResource({ canonicalPath: canonical2, full: true, content: "gamma\ndelta\n" }),
        ],
    });
    const [r1, r2] = envelope.resources;
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
            edits: [
                { oldText: "alpha", newText: "ALPHA", path: "a.ts" },
                // b.ts oldText doesn't exist -> group 2 fails at write-target-derivation
                { oldText: "NOPE-NOT-PRESENT", newText: "x", path: "b.ts" },
            ],
            evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: [r1!.resourceId, r2!.resourceId] },
            toolCallId: "tc1",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "failed");
    assert.equal(readFileSync(canonical1, "utf8"), "alpha\nbeta\n");
    assert.equal(d.changedResources.length, 0);
});

test("end-to-end: query-mode-style evidence (search-match coverage, no sha) is rejected by patch even with a matching path", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const file = join(workdir, "a.ts");
    writeFileSync(file, "alpha\nbeta\n", "utf8");
    const canonicalFile = realpathSync(file);
    const sessionFilePath = "/sessions/a.jsonl";
    const weakResource: InspectedResource = {
        resourceId: resourceIdFor({ canonicalPath: canonicalFile, kind: "range", range: { startLine: 1, endLine: 1 } }),
        canonicalPath: canonicalFile,
        kind: "range",
        coverage: "search-match",
        allowedRanges: [{ startLine: 1, endLine: 1 }],
        fresh: false,
    };
    const envelope = makeEnvelope({ sessionFilePath, canonicalRoot: workdir, resources: [weakResource] });
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
    // Rewrite the file after "inspection" — if freshness were the only gate,
    // this whole-file rewrite would be undetectable since there is no sha.
    writeFileSync(file, "totally\nREWRITTEN\ncontent\nnow\n", "utf8");
    const res = await tool.execute(
        "tc1",
        {
            path: "a.ts",
            edits: [{ oldText: "totally", newText: "changed" }],
            evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: [weakResource.resourceId] },
            toolCallId: "tc1",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "coverage");
    // File must be unmodified — patch must not have applied.
    assert.equal(readFileSync(canonicalFile, "utf8"), "totally\nREWRITTEN\ncontent\nnow\n");
});

test("end-to-end: metadata-only coverage is also rejected", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const file = join(workdir, "a.ts");
    writeFileSync(file, "alpha\nbeta\n", "utf8");
    const canonicalFile = realpathSync(file);
    const sessionFilePath = "/sessions/a.jsonl";
    const weakResource: InspectedResource = {
        resourceId: resourceIdFor({ canonicalPath: canonicalFile, kind: "range", range: { startLine: 1, endLine: 1 } }),
        canonicalPath: canonicalFile,
        kind: "range",
        coverage: "metadata-only",
        allowedRanges: [{ startLine: 1, endLine: 1 }],
        fresh: false,
    };
    const envelope = makeEnvelope({ sessionFilePath, canonicalRoot: workdir, resources: [weakResource] });
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
            edits: [{ oldText: "alpha", newText: "changed" }],
            evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: [weakResource.resourceId] },
            toolCallId: "tc1",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "coverage");
});

test("end-to-end: a failing blocking verification check prevents the write", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nbeta\n";
    const { res, canonicalFile } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: (env) => ({ ok: true, payload: env }),
        checks: [{ id: "typecheck", kind: "blocking", run: async () => ({ outcome: "fail", detail: "type error" }) }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "approval");
    // File must be unmodified.
    assert.equal(readFileSync(canonicalFile, "utf8"), before);
});

test("resolvePatchAuthorization: rejects weak coverage even when a resourceId matches", () => {
    const sessionFilePath = "/sessions/a.jsonl";
    const canonicalPath = "/ws/a.ts";
    const weakResource: InspectedResource = {
        resourceId: resourceIdFor({ canonicalPath, kind: "range", range: { startLine: 1, endLine: 1 } }),
        canonicalPath,
        kind: "range",
        coverage: "search-match",
        allowedRanges: [{ startLine: 1, endLine: 1 }],
        fresh: false,
    };
    const envelope = makeEnvelope({ sessionFilePath, canonicalRoot: "/ws", resources: [weakResource] });
    const auth = resolvePatchAuthorization({
        envelope,
        sessionFilePath,
        canonicalWorkspaceRoot: "/ws",
        requestedResourceIds: [weakResource.resourceId],
        targetLineRange: { startLine: 1, endLine: 1 },
    });
    assert.equal(auth.ok, false);
});

// ─── Fix #1: replaceAll bypasses line-range authorization ──────────────

test("end-to-end: replaceAll coverage is enforced per-occurrence under line-range", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-replaceall-")));
    mkdirSync(workdir, { recursive: true });
    const before = "foo\nbar\nfoo\nqux\nfoo\n";
    // allowedRanges only covers line 3. The first and third "foo" occurrences
    // are on lines 1 and 5, outside the allowed range. With replaceAll the
    // per-occurrence coverage check should reject the entire batch.
    const { res } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: false,
        range: { startLine: 3, endLine: 3 },
        edits: [{ oldText: "foo", newText: "FOO", replaceAll: true }],
        rpc: (env) => ({ ok: true, payload: env }),
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "coverage");
    assert.ok(
        String(d.diagnostics ?? "").includes("occurrence"),
        "diagnostics should mention occurrences outside allowed range",
    );
});

test("end-to-end: replaceAll succeeds when every occurrence is inside allowedRanges", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-replaceall-ok-")));
    mkdirSync(workdir, { recursive: true });
    const before = "foo\nbar\nfoo\nqux\nfoo\n";
    // Allow the full file's range — every "foo" occurrence is within.
    const { res, canonicalFile } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: false,
        range: { startLine: 1, endLine: 5 },
        edits: [{ oldText: "foo", newText: "FOO", replaceAll: true }],
        rpc: (env) => ({ ok: true, payload: env }),
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied");
    assert.equal(readFileSync(canonicalFile, "utf8"), "FOO\nbar\nFOO\nqux\nFOO\n");
});

// ─── Fix #2: Auto-inspect new-file creation ───────────────────────────

test("end-to-end: missing file with empty oldText is treated as new-file creation", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-newfile-")));
    mkdirSync(workdir, { recursive: true });
    const newFile = join(workdir, "fresh.ts");
    assert.equal(existsSync(newFile), false, "fixture: new file should not exist yet");
    const sessionFilePath = "/sessions/new.jsonl";
    const deps: PatchToolDeps = {
        getRpcClient: () => ({
            request: async () => ({
                kind: "reply" as const,
                schemaVersion: PROTOCOL_SCHEMA_VERSION,
                requestId: "r1",
                ok: true,
                payload: {},
            }),
            dispose: () => {},
        }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const tool = createPatchTool(deps);
    const res = await tool.execute(
        "tc-newfile",
        {
            path: "fresh.ts",
            edits: [{ oldText: "", newText: "export const created = true;\n" }],
            toolCallId: "tc-newfile",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${JSON.stringify(d.status)}`);
    assert.ok(existsSync(newFile), "new file should have been created on disk");
    assert.equal(readFileSync(newFile, "utf8"), "export const created = true;\n");
    assert.equal(d.changedResources.length, 1);
    assert.equal(d.changedResources[0].canonicalPath, newFile);
    unlinkSync(newFile);
});

test("end-to-end: missing file with non-empty oldText returns actionable error", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-missing-")));
    mkdirSync(workdir, { recursive: true });
    const sessionFilePath = "/sessions/missing.jsonl";
    const deps: PatchToolDeps = {
        getRpcClient: () => ({
            request: async () => ({
                kind: "reply" as const,
                schemaVersion: PROTOCOL_SCHEMA_VERSION,
                requestId: "r1",
                ok: true,
                payload: {},
            }),
            dispose: () => {},
        }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const tool = createPatchTool(deps);
    const res = await tool.execute(
        "tc-missing",
        {
            path: "does-not-exist.ts",
            edits: [{ oldText: "anything", newText: "new" }],
            toolCallId: "tc-missing",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "failed");
    assert.equal(d.status.phase, "stage");
    const errStr = JSON.stringify(d);
    assert.ok(errStr.includes("does-not-exist.ts"), "error should include path");
    assert.ok(
        errStr.includes("write tool") || errStr.includes("oldText"),
        "error should suggest a fix",
    );
});

// ─── Fix #3: post-write invalidation is recorded even if a later stage fails ──

test("end-to-end: post-write invalidation is recorded when the write succeeds", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-postwrite-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nbeta\n";
    const { res, canonicalFile } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: (env) => ({ ok: true, payload: env }),
        checks: [{ id: "lint", kind: "advisory", run: async () => ({ outcome: "pass" as const }) }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied");
    assert.equal(d.changedResources.length, 1, "changedResources must record the write");
    assert.equal(d.changedResources[0].canonicalPath, canonicalFile);
    assert.equal(readFileSync(canonicalFile, "utf8"), "alpha\nBETA\n");
});

// ─── Fix #4: blocking verifier that throws (not a timeout) blocks the write ──

test("end-to-end: blocking verifier that throws blocks the write (fail, not timeout)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-throw-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nbeta\n";
    const { res, canonicalFile } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: (env) => ({ ok: true, payload: env }),
        checks: [
            {
                id: "crash",
                kind: "blocking",
                run: async () => {
                    throw new Error("verifier exploded");
                },
            },
        ],
    });
    const d = res.details as any;
    // The blocking verifier threw — the write gate rejects it as "approval".
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "approval");
    // File must not have been changed.
    assert.equal(readFileSync(canonicalFile, "utf8"), before);
    // The thrown check must be in blocking + fail.
    const checks = d.checks as { blocking: Array<{ id: string; outcome: string }> };
    const blockingCrash = checks.blocking.find((c) => c.id.startsWith("crash:"));
    assert.ok(blockingCrash, "crash check should appear in blocking");
    assert.equal(blockingCrash.outcome, "fail", "thrown error should be classified as fail");
});

test("end-to-end: post-write verifier failure restores the file", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-post-verify-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nbeta\n";
    let calls = 0;
    const { res, canonicalFile } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: (env) => ({ ok: true, payload: env }),
        checks: [{
            id: "post-write",
            kind: "blocking",
            phase: "postwrite",
            run: async ({ content }) => {
                calls += 1;
                return { outcome: content.includes("BETA") ? "fail" : "pass", detail: "post-write failure" };
            },
        }],
    });
    const details = res.details as { status: { kind: string; phase?: string } };
    assert.equal(details.status.kind, "failed", "post-write verifier failure is a failed result");
    assert.equal(details.status.phase, "verify", "postwrite verifier failure is a post-write failure");
    assert.equal(readFileSync(canonicalFile, "utf8"), before, "post-write verifier failure must restore the file");
    assert.equal(calls, 1, "postwrite-phase verifier must run exactly once (post-write only)");
});

// ─── Fix #5: pre-write error classification ──────────────────────────

test("end-to-end: missing oldText/newText returns rejected at contract validation", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-shape-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nbeta\n";
    const { res, canonicalFile } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: true,
        edits: [{ description: "noop" } as any],
        rpc: (env) => ({ ok: true, payload: env }),
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected", "no-action/description-only edits are rejected by validateEditOperation");
    assert.equal(d.status.reason, "session", "invalid patch shape is classified as a session-level rejection");
    assert.match(res.content?.[0]?.text ?? "", /actionable operation/);
    assert.equal(readFileSync(canonicalFile, "utf8"), before);
});

test("end-to-end: oldText not found returns failed/stage (truthful pre-write stage)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-notfound-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nbeta\n";
    const { res, canonicalFile } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: true,
        edits: [{ oldText: "DOES NOT EXIST", newText: "replacement" }],
        rpc: (env) => ({ ok: true, payload: env }),
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "failed");
    assert.equal(d.status.phase, "stage", "oldText not found is a pre-write error");
    assert.match(
        res.content[0]?.text ?? "",
        /re-inspect the file and retry/i,
        "stale exact-match failures should tell the caller how to recover",
    );
    assert.equal(readFileSync(canonicalFile, "utf8"), before);
});

// ─── Fix #6: SHA TOCTOU re-check before write ─────────────────────────

test("end-to-end: SHA changed between initial check and write is rejected as stale", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-stale-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nbeta\n";
    const newFile = join(workdir, "x.ts");
    writeFileSync(newFile, before, "utf8");
    const canonicalFile = realpathSync(newFile);
    const sessionFilePath = "/sessions/t.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [
            makeResource({
                canonicalPath: canonicalFile,
                full: true,
                content: before,
            }),
        ],
    });
    const resource = envelope.resources[0]!;
    // Simulate a concurrent writer by mutating the file when the RPC request
    // fires (which is the moment patch resolves the envelope). This races the
    // pre-write re-SHA guard.
    const deps: PatchToolDeps = {
        getRpcClient: () => ({
            request: async () => {
                writeFileSync(canonicalFile, "alpha\nbeta\nGAMMA\n", "utf8");
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
        "tc-stale",
        {
            path: "x.ts",
            edits: [{ oldText: "beta", newText: "BETA" }],
            evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: [resource.resourceId] },
            toolCallId: "tc-stale",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "stale");
    // File must not have been overwritten by the patch — only by the simulated writer.
    assert.equal(readFileSync(canonicalFile, "utf8"), "alpha\nbeta\nGAMMA\n");
});

// ─── Approval gating wiring (advisory, non-blocking) ─────────────────

test("approval-gating: dangerous edit content adds advisory check, does not block", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-approval-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nfunction main() {}\nbeta\n";
    const { res } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: true,
        edits: [{ oldText: "function main() {}", newText: "function main() { return 42; }" }],
        rpc: (env) => ({ ok: true, payload: env }),
    });
    const d = res.details as unknown as { status: { kind: string }; checks: { advisory: Array<{ id: string; detail?: string }> } };
    // Must still apply (non-blocking)
    assert.equal(d.status.kind, "applied", "dangerous edit must still apply — approval gating is advisory");
    // Advisory checks must include approval-gating
    const approvalChecks = d.checks.advisory.filter((c) => c.id === "approval-gating");
    assert.ok(approvalChecks.length >= 1, "should have at least one approval-gating advisory check");
    const detail = approvalChecks[0].detail ?? "";
    assert.ok(
        detail.includes("main") || detail.includes("dangerous"),
        `approval-gating advisory detail should mention dangerous pattern (got: ${detail})`,
    );
});

test("approval-gating: safe edit has no approval-gating advisory checks", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-safe-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nbeta\ngamma\n";
    const { res } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: (env) => ({ ok: true, payload: env }),
    });
    const d = res.details as unknown as { status: { kind: string }; checks: { advisory: Array<{ id: string }> } };
    assert.equal(d.status.kind, "applied");
    const approvalChecks = d.checks.advisory.filter((c) => c.id === "approval-gating");
    assert.equal(approvalChecks.length, 0, "safe edits should not produce approval-gating checks");
});

// ─── Tool-owned prior authority (evidence policy B) ───────────────────

async function runApplyWithPrior(opts: {
    workdir: string;
    fileContent: string;
    buildPrior: (canonicalFile: string) => InspectedResource[];
    edits: Array<{ oldText: string; newText: string }>;
    evidenceRef?: { inspectionId: string; resourceIds: string[] };
    rpcShouldThrow?: boolean;
    mutateBeforeExecute?: (canonicalFile: string) => void;
}) {
    const file = join(opts.workdir, "a.ts");
    writeFileSync(file, opts.fileContent, "utf8");
    const canonicalFile = realpathSync(file);
    const sessionFilePath = "/sessions/prior.jsonl";
    const store = createPriorAuthorityStore({ sessionFilePath, canonicalWorkspaceRoot: opts.workdir });
    const resources = opts.buildPrior(canonicalFile);
    if (resources.length > 0) {
        store.record(makeEnvelope({ sessionFilePath, canonicalRoot: opts.workdir, resources }));
    }
    opts.mutateBeforeExecute?.(canonicalFile);
    const deps: PatchToolDeps = {
        getRpcClient: () => {
            if (opts.rpcShouldThrow) throw new Error("rpc must not be called when prior authority covers all groups");
            return {
                request: async () => ({
                    kind: "reply" as const,
                    schemaVersion: PROTOCOL_SCHEMA_VERSION,
                    requestId: "r1",
                    ok: true,
                    payload: makeEnvelope({ sessionFilePath, canonicalRoot: opts.workdir, resources }),
                }),
                dispose: () => {},
            };
        },
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => opts.workdir,
        getPriorAuthority: () => store,
    };
    const tool = createPatchTool(deps);
    const res = await tool.execute(
        "tc-prior",
        {
            path: "a.ts",
            edits: opts.edits,
            ...(opts.evidenceRef ? { evidenceRef: opts.evidenceRef } : {}),
            toolCallId: "tc-prior",
        },
        undefined,
        undefined,
        makeCtx(opts.workdir),
    );
    return { res, canonicalFile };
}

function lineRangeResource(canonicalFile: string, range: { startLine: number; endLine: number }, content: string): InspectedResource {
    return {
        resourceId: resourceIdFor({ canonicalPath: canonicalFile, kind: "range", range }),
        canonicalPath: canonicalFile,
        kind: "range",
        coverage: "line-range",
        allowedRanges: [range],
        fullFileSha256: sha256(content),
        fresh: true,
        lineCount: range.endLine - range.startLine + 1,
    };
}

test("prior authority: line-range + omitted ref out-of-range rejects unchanged file (no widening)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-prior-out-")));
    mkdirSync(workdir, { recursive: true });
    const content = "l1\nl2\nl3\nl4\nl5\n";
    const { res, canonicalFile } = await runApplyWithPrior({
        workdir,
        fileContent: content,
        buildPrior: (cf) => [lineRangeResource(cf, { startLine: 1, endLine: 2 }, content)],
        edits: [{ oldText: "l4", newText: "L4" }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "coverage");
    assert.ok(
        String(d.diagnostics ?? "").includes("fresh full-file read"),
        "diagnostics should say a fresh full-file read is required to widen authority",
    );
    assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
});

test("prior authority: in-range edit applies under line-range authority", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-prior-in-")));
    mkdirSync(workdir, { recursive: true });
    const content = "l1\nl2\nl3\nl4\nl5\n";
    const { res, canonicalFile } = await runApplyWithPrior({
        workdir,
        fileContent: content,
        buildPrior: (cf) => [lineRangeResource(cf, { startLine: 1, endLine: 2 }, content)],
        edits: [{ oldText: "l1", newText: "L1" }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied");
    assert.equal(readFileSync(canonicalFile, "utf8"), "L1\nl2\nl3\nl4\nl5\n");
});

test("prior authority: stale prior rejects without widening (no auto-inspect fallback)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-prior-stale-")));
    mkdirSync(workdir, { recursive: true });
    const content = "alpha\nbeta\n";
    const { res, canonicalFile } = await runApplyWithPrior({
        workdir,
        fileContent: content,
        buildPrior: (cf) => [lineRangeResource(cf, { startLine: 1, endLine: 2 }, content)],
        edits: [{ oldText: "beta", newText: "BETA" }],
        mutateBeforeExecute: (cf) => {
            writeFileSync(cf, "alpha\nbeta\nGAMMA\n", "utf8");
        },
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "stale");
    assert.equal(readFileSync(canonicalFile, "utf8"), "alpha\nbeta\nGAMMA\n", "file must not be widened/edited");
});

test("prior authority: missing fullFileSha256 on prior line-range rejects", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-prior-nosha-")));
    mkdirSync(workdir, { recursive: true });
    const content = "alpha\nbeta\n";
    const { res, canonicalFile } = await runApplyWithPrior({
        workdir,
        fileContent: content,
        buildPrior: (cf) => [{
            resourceId: resourceIdFor({ canonicalPath: cf, kind: "range", range: { startLine: 1, endLine: 2 } }),
            canonicalPath: cf,
            kind: "range",
            coverage: "line-range",
            allowedRanges: [{ startLine: 1, endLine: 2 }],
            fresh: true,
            // no fullFileSha256
        }],
        edits: [{ oldText: "beta", newText: "BETA" }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "coverage");
    assert.ok(
        String(d.diagnostics ?? "").includes("missing fullFileSha256"),
        "diagnostics should mention missing fullFileSha256",
    );
    assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
});

test("prior authority: no strong prior grant falls back to auto-inspection", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-prior-none-")));
    mkdirSync(workdir, { recursive: true });
    const content = "alpha\nbeta\n";
    const { res, canonicalFile } = await runApplyWithPrior({
        workdir,
        fileContent: content,
        buildPrior: () => [],
        edits: [{ oldText: "beta", newText: "BETA" }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied");
    assert.equal(readFileSync(canonicalFile, "utf8"), "alpha\nBETA\n");
});

test("prior authority: weak evidence does not authorize but counts as no strong grant (auto-inspects)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-prior-weak-")));
    mkdirSync(workdir, { recursive: true });
    const content = "alpha\nbeta\n";
    const { res, canonicalFile } = await runApplyWithPrior({
        workdir,
        fileContent: content,
        buildPrior: (cf) => [{
            resourceId: resourceIdFor({ canonicalPath: cf, kind: "range", range: { startLine: 1, endLine: 1 } }),
            canonicalPath: cf,
            kind: "range",
            coverage: "search-match",
            allowedRanges: [{ startLine: 1, endLine: 1 }],
            fresh: false,
        }],
        edits: [{ oldText: "beta", newText: "BETA" }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", "weak evidence must not block auto-inspection fallback");
    assert.equal(readFileSync(canonicalFile, "utf8"), "alpha\nBETA\n");
});

test("prior authority: later full-file read widens authority again", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-prior-widen-")));
    mkdirSync(workdir, { recursive: true });
    const content = "l1\nl2\nl3\nl4\nl5\n";
    const { res, canonicalFile } = await runApplyWithPrior({
        workdir,
        fileContent: content,
        buildPrior: (cf) => [
            lineRangeResource(cf, { startLine: 1, endLine: 2 }, content),
            makeResource({ canonicalPath: cf, full: true, content }),
        ],
        edits: [{ oldText: "l4", newText: "L4" }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", "later full-file authority must widen coverage");
    assert.equal(readFileSync(canonicalFile, "utf8"), "l1\nl2\nl3\nL4\nl5\n");
});

test("prior authority: outside-workspace target remains allowed (auto-inspect)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-prior-outside-")));
    mkdirSync(workdir, { recursive: true });
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "patch-prior-outside-target-")));
    const outsideFile = join(outsideDir, "x.ts");
    writeFileSync(outsideFile, "alpha\nbeta\n", "utf8");
    const sessionFilePath = "/sessions/prior.jsonl";
    const store = createPriorAuthorityStore({ sessionFilePath, canonicalWorkspaceRoot: workdir });
    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => { throw new Error("unused"); }, dispose: () => {} }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
        getPriorAuthority: () => store,
    };
    const res = await createPatchTool(deps).execute(
        "tc-outside",
        { path: outsideFile, edits: [{ oldText: "beta", newText: "BETA" }], toolCallId: "tc-outside" },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", "outside-workspace target must remain allowed");
    assert.equal(readFileSync(outsideFile, "utf8"), "alpha\nBETA\n");
});

test("prior authority: caller evidenceRef does not override a selected prior grant", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-prior-ref-")));
    mkdirSync(workdir, { recursive: true });
    const content = "l1\nl2\nl3\nl4\nl5\n";
    const { res, canonicalFile } = await runApplyWithPrior({
        workdir,
        fileContent: content,
        buildPrior: (cf) => [lineRangeResource(cf, { startLine: 1, endLine: 2 }, content)],
        edits: [{ oldText: "l4", newText: "L4" }],
        // A full-file evidenceRef would authorize line 4, but the prior line-range
        // grant must win and RPC must not be consulted.
        evidenceRef: { inspectionId: "full-file-inspection", resourceIds: ["full-file-resource"] },
        rpcShouldThrow: true,
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "coverage");
    assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
});

test("topology delete failure returns failed/write (not an uncaught throw) and rolls back", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-topo-del-")));
    mkdirSync(workdir, { recursive: true });
    const sessionFilePath = "/sessions/topo.jsonl";
    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => { throw new Error("unused"); }, dispose: () => {} }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const res = await createPatchTool(deps).execute(
        "tc-topo",
        { raw: "*** Begin Atomic Patch\n*** Delete File: missing.ts\n*** End Atomic Patch\n", toolCallId: "tc-topo" } as any,
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "failed");
    assert.equal(d.status.phase, "write", "topology failure must be a write-phase failure");
    assert.equal(existsSync(join(workdir, "missing.ts")), false);
});
