/**
 * Patch tool tests — additive single-file patch with workspace-evidence
 * authorization, mutation-queue freshness check, and lifecycle result.
 */
import { test, before } from "node:test";
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
import { computeLineHashSync, initHashline } from "../src/core/hashline.js";
import { getUndoHistory } from "../src/undo/edit-history.js";

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

// ── Transfer (copy/move) test helpers ────────────────────────────────

let hashlineInitialized = false;
async function ensureHashline(): Promise<void> {
    if (!hashlineInitialized) {
        await initHashline();
        hashlineInitialized = true;
    }
}
before(async () => {
    await ensureHashline();
});

/** Hashline anchor for `text` at its current 1-based `lineNum` in the file. */
function anchorFor(lineNum: number, text: string): string {
    return `${lineNum}${computeLineHashSync(lineNum, text)}`;
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

    // Create a file OUTSIDE the workspace to prove cross-folder edits work.
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "patch-outside-")));
    const outsideFile = join(outsideDir, "c.ts");
    writeFileSync(outsideFile, "gamma\ndelta\n", "utf8");
    const canonicalOutside = realpathSync(outsideFile);

    const sessionFilePath = "/sessions/a.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [
            makeResource({ canonicalPath: canonicalFile, full: true, content: "alpha\nbeta\n" }),
            makeResource({ canonicalPath: canonicalOutside, full: true, content: "gamma\ndelta\n" }),
        ],
    });
    const resA = envelope.resources[0]!;
    const resC = envelope.resources[1]!;
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
                { oldText: "gamma", newText: "GAMMA", path: canonicalOutside },
            ],
            evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: [resA.resourceId, resC.resourceId] },
            toolCallId: "tc1",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    // Both edits apply: cross-folder editing is allowed.
    assert.equal(d.status.kind, "applied");
    assert.match(readFileSync(canonicalOutside, "utf8"), /^GAMMA\n/);
    assert.match(readFileSync(file, "utf8"), /^ALPHA\n/);
});

// ── Review-fix regression tests (B1-B4) ──────────────────────────────

test("end-to-end: omitted evidence rejects existing-file edit", async () => {
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
    // No evidenceRef field: existing-file edits require prior authority.
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
    assert.equal(d.status.kind, "rejected");
    assert.equal(readFileSync(realpathSync(file), "utf8"), "alpha\nbeta\n");
});

test("end-to-end: toolCallId is not required in the wire payload (Pi supplies it as the execute() argument)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-")));
    mkdirSync(workdir, { recursive: true });
    const file = join(workdir, "a.ts");
    writeFileSync(file, "alpha\nbeta\n", "utf8");
    const sessionFilePath = "/sessions/a.jsonl";
    const resource = makeResource({ canonicalPath: realpathSync(file), full: true, content: "alpha\nbeta\n" });
    const envelope = makeEnvelope({ sessionFilePath, canonicalRoot: workdir, resources: [resource] });
    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => ({ kind: "reply" as const, schemaVersion: PROTOCOL_SCHEMA_VERSION, requestId: "r1", ok: true, payload: envelope }), dispose: () => {} }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const tool = createPatchTool(deps);
    // Schema-conforming params per PATCH_PARAMS_DOC: no toolCallId field.
    const res = await tool.execute(
        "tc-from-harness",
        { path: "a.ts", edits: [{ oldText: "beta", newText: "BETA" }], evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: [resource.resourceId] } },
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

    const sessionFilePath = "/sessions/a.jsonl";
    const resources = [
        makeResource({ canonicalPath: realpathSync(file1), full: true, content: "alpha\nbeta\n" }),
        makeResource({ canonicalPath: realpathSync(file2), full: true, content: "gamma\ndelta\n" }),
    ];
    const envelope = makeEnvelope({ sessionFilePath, canonicalRoot: workdir, resources });
    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => ({ kind: "reply" as const, schemaVersion: PROTOCOL_SCHEMA_VERSION, requestId: "r1", ok: true, payload: envelope }), dispose: () => {} }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const res = await createPatchTool(deps).execute(
        "tc-diffs",
        { edits: [
            { path: "a.ts", oldText: "alpha", newText: "ALPHA" },
            { path: "b.ts", oldText: "gamma", newText: "GAMMA" },
        ], evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: resources.map((r) => r.resourceId) } },
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
    assert.equal(d.status.kind, "applied", "dangerous edit must still apply — risk warnings are advisory");
    // Advisory checks must include risk-warning
    const riskChecks = d.checks.advisory.filter((c) => c.id === "risk-warning");
    assert.ok(riskChecks.length >= 1, "should have at least one risk-warning advisory check");
    const detail = riskChecks[0].detail ?? "";
    assert.ok(
        detail.includes("main") || detail.includes("dangerous"),
        `risk-warning advisory detail should mention dangerous pattern (got: ${detail})`,
    );
});

test("approval-gating: safe edit has no risk-warning advisory checks", async () => {
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
    const riskChecks = d.checks.advisory.filter((c) => c.id === "risk-warning");
    assert.equal(riskChecks.length, 0, "safe edits should not produce risk-warning checks");
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
        String(d.diagnostics ?? "").includes("missing a valid fullFileSha256 snapshot SHA-256"),
        "diagnostics should mention missing fullFileSha256",
    );
    assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
});

test("prior authority: no strong prior grant rejects", async () => {
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
    assert.equal(d.status.kind, "rejected");
    assert.equal(readFileSync(canonicalFile, "utf8"), content);
});

test("prior authority: weak evidence rejects", async () => {
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
    assert.equal(d.status.kind, "rejected");
    assert.equal(readFileSync(canonicalFile, "utf8"), content);
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

test("prior authority: outside-workspace target still requires authority", async () => {
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
    // No authority for the outside file → rejected for coverage, not containment.
    assert.equal(d.status.kind, "rejected");
    assert.equal(readFileSync(outsideFile, "utf8"), "alpha\nbeta\n");
});

test("regression: cross-folder edits apply when evidence exists", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-crossfolder-")));
    mkdirSync(workdir, { recursive: true });
    const file = join(workdir, "a.ts");
    writeFileSync(file, "alpha\nbeta\n", "utf8");
    const canonicalFile = realpathSync(file);

    // File outside workspace
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "patch-crossfolder-ext-")));
    const outsideFile = join(outsideDir, "z.ts");
    writeFileSync(outsideFile, "omega\nzeta\n", "utf8");
    const canonicalOutside = realpathSync(outsideFile);

    const sessionFilePath = "/sessions/cross.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [
            makeResource({ canonicalPath: canonicalFile, full: true, content: "alpha\nbeta\n" }),
            makeResource({ canonicalPath: canonicalOutside, full: true, content: "omega\nzeta\n" }),
        ],
    });
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
    // Edit both files in one call — the outside file uses an absolute path.
    const res = await tool.execute(
        "tc-cross",
        {
            path: "a.ts",
            edits: [
                { oldText: "alpha", newText: "ALPHA" },
                { oldText: "omega", newText: "OMEGA", path: canonicalOutside },
            ],
            evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: envelope.resources.map(r => r.resourceId) },
            toolCallId: "tc-cross",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${d.status.kind}: ${d.status.reason ?? ""}`);
    assert.match(readFileSync(file, "utf8"), /ALPHA/);
    assert.match(readFileSync(outsideFile, "utf8"), /OMEGA/);
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

test("risk-warning: topology-only add runs path warnings and scans add-file content", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-topo-add-")));
    mkdirSync(workdir, { recursive: true });
    const sessionFilePath = "/sessions/topo-add.jsonl";
    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => { throw new Error("unused"); }, dispose: () => {} }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const res = await createPatchTool(deps).execute(
        "tc-topo-add",
        { raw: "*** Begin Atomic Patch\n*** Add File: main.ts\nfunction main() { return 1; }\n*** End Atomic Patch\n", toolCallId: "tc-topo-add" } as any,
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", "add must apply — risk warnings are advisory");
    assert.equal(existsSync(join(workdir, "main.ts")), true, "add file should be created");
    const advisory = (d.checks as { advisory?: Array<{ id: string; detail?: string }> } | undefined)?.advisory ?? [];
    const riskChecks = advisory.filter((c) => c.id === "risk-warning");
    assert.ok(riskChecks.length >= 1, "topology-only add should emit risk-warning checks");
    const detail = riskChecks.map((c) => c.detail ?? "").join("\n");
    assert.ok(detail.includes("main.ts"), "path risk warning should mention main.ts");
    assert.ok(detail.includes("main() function"), "add-file content should be scanned for dangerous symbols");
});

test("risk-warning: topology-only delete runs path risk warnings", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-topo-del-warn-")));
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, "main.ts"), "x\n", "utf8");
    const sessionFilePath = "/sessions/topo-del-warn.jsonl";
    const canonicalFile = realpathSync(join(workdir, "main.ts"));
    const resource = makeResource({ canonicalPath: canonicalFile, full: true, content: "x\n" });
    const envelope = makeEnvelope({ sessionFilePath, canonicalRoot: workdir, resources: [resource] });
    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => ({ kind: "reply" as const, schemaVersion: PROTOCOL_SCHEMA_VERSION, requestId: "r1", ok: true, payload: envelope }), dispose: () => {} }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const res = await createPatchTool(deps).execute(
        "tc-topo-del-warn",
        { raw: "*** Begin Atomic Patch\n*** Delete File: main.ts\n*** End Atomic Patch\n", evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: [resource.resourceId] }, toolCallId: "tc-topo-del-warn" } as any,
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", "delete must apply — risk warnings are advisory");
    assert.equal(existsSync(join(workdir, "main.ts")), false, "delete should remove the file");
    const advisory = (d.checks as { advisory?: Array<{ id: string; detail?: string }> } | undefined)?.advisory ?? [];
    const riskChecks = advisory.filter((c) => c.id === "risk-warning");
    assert.ok(riskChecks.length >= 1, "topology-only delete should emit risk-warning checks");
    const detail = riskChecks.map((c) => c.detail ?? "").join("\n");
    assert.ok(detail.includes("main.ts"), "path risk warning should mention main.ts");
});

// ─── Bug 3: EditTransaction.begin() failure must return a typed result ────

test("Bug 3 regression: EditTransaction.begin() failure returns a typed failed result, not an uncaught rejection", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-begin-fail-")));
    mkdirSync(workdir, { recursive: true });
    // A directory (not a file) at the target path makes EditTransaction.begin's
    // internal snapshot() throw EISDIR (stat succeeds, then readFile fails with
    // a non-ENOENT error) — exactly the "snapshot failure inside begin" case
    // called out by the bug report, and reachable without waiting out a real
    // lock timeout.
    const dirPath = join(workdir, "not-a-file");
    mkdirSync(dirPath);
    const canonicalDir = realpathSync(dirPath);
    const sessionFilePath = "/sessions/begin-fail.jsonl";

    // A strong prior authority for the target skips auto-inspect and RPC
    // entirely, so execution reaches EditTransaction.begin() without ever
    // reading the directory's content first (which would otherwise fail
    // earlier, during auto-inspect, and never reach begin() at all).
    const store = createPriorAuthorityStore({ sessionFilePath, canonicalWorkspaceRoot: workdir });
    store.record(makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [makeResource({ canonicalPath: canonicalDir, full: true, content: "" })],
    }));

    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => { throw new Error("rpc must not be called: prior authority covers the only group"); }, dispose: () => {} }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
        getPriorAuthority: () => store,
    };
    const tool = createPatchTool(deps);

    // Must resolve normally (not reject) even though begin() throws internally.
    const res = await tool.execute(
        "tc-begin-fail",
        { path: "not-a-file", edits: [{ oldText: "x", newText: "y" }], toolCallId: "tc-begin-fail" },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "failed", `expected a typed failed result, got ${JSON.stringify(d.status)}`);
    assert.equal(d.status.phase, "stage");
});

// ─── Bug 4: verifier timeout semantics ─────────────────────────────────

test("Bug 4a regression: a blocking verifier that times out blocks the write (timeout is not silently ignored)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-blocking-timeout-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nbeta\n";
    const { res, canonicalFile } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: (env) => ({ ok: true, payload: env }),
        checks: [{
            id: "hangs",
            kind: "blocking",
            run: () => new Promise(() => { /* never resolves */ }),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected", `expected the timeout to block the write, got ${JSON.stringify(d.status)}`);
    assert.equal(d.status.reason, "approval");
    assert.equal(readFileSync(canonicalFile, "utf8"), before, "file must remain unmodified");
    const checks = d.checks as { blocking: Array<{ id: string; outcome: string }>; timedOut: Array<{ id: string; outcome: string }> };
    const blockingTimeout = checks.blocking.find((c) => c.id.startsWith("hangs:"));
    assert.ok(blockingTimeout, "a timed-out blocking verifier must be visible to the gate in checks.blocking");
    assert.equal(blockingTimeout.outcome, "timeout");
    const timedOutRecord = checks.timedOut.find((c) => c.id.startsWith("hangs:"));
    assert.ok(timedOutRecord, "the timeout must also remain visible in checks.timedOut for observability");
});

test("Bug 4b regression: a hung post-write verifier times out and is treated as a failure instead of hanging forever", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-postwrite-timeout-")));
    mkdirSync(workdir, { recursive: true });
    const before = "alpha\nbeta\n";
    const { res, canonicalFile } = await runApply({
        workdir,
        fileContent: before,
        envelopeContent: before,
        fullFile: true,
        edits: [{ oldText: "beta", newText: "BETA" }],
        rpc: (env) => ({ ok: true, payload: env }),
        checks: [{
            id: "hangs-post",
            kind: "blocking",
            phase: "postwrite",
            run: () => new Promise(() => { /* never resolves; must not hold the transaction lock forever */ }),
        }],
    });
    const details = res.details as { status: { kind: string; phase?: string } };
    assert.equal(details.status.kind, "failed", `expected the hung post-write verifier to time out as a failure, got ${JSON.stringify(details.status)}`);
    assert.equal(details.status.phase, "verify");
    assert.equal(readFileSync(canonicalFile, "utf8"), before, "hung post-write verifier must not hold the write; file must be restored");
});

// ─── Transfer (copy/move) edits: end-to-end ────────────────────────────

/** Execute an edit request via auto-inspect (no evidenceRef); full-file authority
 *  is synthesized live from each touched file's current on-disk content. */
async function execAutoInspect(
    workdir: string,
    body: { path?: string; edits: unknown[] },
    checks?: VerificationCheck[],
) {
    const sessionFilePath = "/sessions/transfer.jsonl";
    const paths = new Set<string>();
    if (body.path) paths.add(body.path);
    for (const edit of body.edits) {
        if (!edit || typeof edit !== "object") continue;
        const value = edit as Record<string, unknown>;
        for (const key of ["path", "from", "to"]) if (typeof value[key] === "string") paths.add(value[key] as string);
    }
    const resources = [...paths].flatMap((path) => {
        const absolute = join(workdir, path);
        if (!existsSync(absolute)) return [];
        const canonical = realpathSync(absolute);
        return [makeResource({ canonicalPath: canonical, full: true, content: readFileSync(canonical, "utf8") })];
    });
    const store = createPriorAuthorityStore({ sessionFilePath, canonicalWorkspaceRoot: workdir });
    if (resources.length) store.record(makeEnvelope({ sessionFilePath, canonicalRoot: workdir, resources }));
    const deps: PatchToolDeps = {
        getRpcClient: () => ({
            request: async () => { throw new Error("prior authority must not use RPC"); },
            dispose: () => {},
        }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
        getPriorAuthority: () => store,
        ...(checks ? { getVerificationChecks: () => checks } : {}),
    };
    const tool = createPatchTool(deps);
    return tool.execute("tc1", { ...body, toolCallId: "tc1" }, undefined, undefined, makeCtx(workdir));
}

/** Execute an edit request against an explicit multi-resource envelope over RPC
 *  (needed whenever a `copy` transfer's source resource must be supplied
 *  explicitly, since `copy` never becomes a real EditGroup and so is never
 *  covered by auto-inspect). */
async function execWithEnvelope(
    workdir: string,
    envelope: WorkspaceEvidenceEnvelope,
    body: { path?: string; edits: unknown[] },
) {
    const sessionFilePath = "/sessions/transfer.jsonl";
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
    return tool.execute(
        "tc1",
        {
            ...body,
            evidenceRef: { inspectionId: envelope.inspectionId, resourceIds: envelope.resources.map((r) => r.resourceId) },
            toolCallId: "tc1",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
}

test("transfer: same-file copy leaves the source intact and inserts a copy elsewhere", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const content = "alpha\nbeta\ngamma\ndelta\n";
    const file = join(workdir, "a.ts");
    writeFileSync(file, content, "utf8");
    const lines = content.split("\n");

    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [{
            op: "copy", from: "a.ts",
            range: { pos: anchorFor(2, lines[1]!), end: anchorFor(2, lines[1]!) },
            to: "a.ts", after: anchorFor(4, lines[3]!),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${JSON.stringify(d.status)}`);
    assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\ngamma\ndelta\nbeta\n");
});

test("transfer: same-file move relocates the range and removes it from the source position", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const content = "alpha\nbeta\ngamma\ndelta\n";
    const file = join(workdir, "a.ts");
    writeFileSync(file, content, "utf8");
    const lines = content.split("\n");

    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [{
            op: "move", from: "a.ts",
            range: { pos: anchorFor(2, lines[1]!), end: anchorFor(2, lines[1]!) },
            to: "a.ts", after: anchorFor(4, lines[3]!),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${JSON.stringify(d.status)}`);
    assert.equal(readFileSync(file, "utf8"), "alpha\ngamma\ndelta\nbeta\n");
});

test("transfer: cross-file copy leaves the source file unchanged and adds the text to the destination", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\n";
    const dstContent = "uno\ndos\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "b.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    writeFileSync(dstFile, dstContent, "utf8");
    const srcCanonical = realpathSync(srcFile);
    const dstCanonical = realpathSync(dstFile);
    const srcLines = srcContent.split("\n");
    const dstLines = dstContent.split("\n");

    const sessionFilePath = "/sessions/transfer.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [
            makeResource({ canonicalPath: srcCanonical, full: true, content: srcContent }),
            makeResource({ canonicalPath: dstCanonical, full: true, content: dstContent }),
        ],
    });

    const res = await execWithEnvelope(workdir, envelope, {
        path: "a.ts",
        edits: [{
            op: "copy", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "b.ts", after: anchorFor(2, dstLines[1]!),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${JSON.stringify(d.status)}`);
    assert.equal(readFileSync(srcFile, "utf8"), srcContent, "copy source must be unchanged");
    assert.equal(readFileSync(dstFile, "utf8"), "uno\ndos\ntwo\n");
});

test("transfer: cross-file move removes the range from the source and adds it to the destination", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\n";
    const dstContent = "uno\ndos\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "b.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    writeFileSync(dstFile, dstContent, "utf8");
    const srcLines = srcContent.split("\n");
    const dstLines = dstContent.split("\n");

    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [{
            op: "move", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "b.ts", after: anchorFor(2, dstLines[1]!),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${JSON.stringify(d.status)}`);
    assert.equal(readFileSync(srcFile, "utf8"), "one\nthree\n");
    assert.equal(readFileSync(dstFile, "utf8"), "uno\ndos\ntwo\n");
});

test("transfer: rejects when the copy source is stale (on-disk content diverged from the attested resource)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContentAtRead = "one\ntwo\nthree\n";
    const dstContent = "uno\ndos\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "b.ts");
    writeFileSync(srcFile, srcContentAtRead, "utf8");
    writeFileSync(dstFile, dstContent, "utf8");
    const srcCanonical = realpathSync(srcFile);
    const dstCanonical = realpathSync(dstFile);
    const srcLines = srcContentAtRead.split("\n");
    const dstLines = dstContent.split("\n");

    const sessionFilePath = "/sessions/transfer.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [
            makeResource({ canonicalPath: srcCanonical, full: true, content: srcContentAtRead }),
            makeResource({ canonicalPath: dstCanonical, full: true, content: dstContent }),
        ],
    });

    // Source file mutates on disk after the attested read (line 3 changes;
    // the transfer's own anchor at line 2 still resolves exactly, so the
    // staleness gate — not anchor resolution — is what must catch this).
    writeFileSync(srcFile, "one\ntwo\nTHREE-CHANGED\n", "utf8");

    const res = await execWithEnvelope(workdir, envelope, {
        path: "a.ts",
        edits: [{
            op: "copy", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "b.ts", after: anchorFor(2, dstLines[1]!),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected", `expected rejected, got ${JSON.stringify(d.status)}`);
    assert.equal(d.status.reason, "stale");
    assert.equal(readFileSync(dstFile, "utf8"), dstContent, "destination must be unmodified");
});

test("transfer: rejects when the destination file is stale (on-disk content diverged from the attested resource)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\n";
    const dstContentAtRead = "uno\ndos\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "b.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    writeFileSync(dstFile, dstContentAtRead, "utf8");
    const srcCanonical = realpathSync(srcFile);
    const dstCanonical = realpathSync(dstFile);
    const srcLines = srcContent.split("\n");
    const dstLines = dstContentAtRead.split("\n");

    const sessionFilePath = "/sessions/transfer.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [
            makeResource({ canonicalPath: srcCanonical, full: true, content: srcContent }),
            makeResource({ canonicalPath: dstCanonical, full: true, content: dstContentAtRead }),
        ],
    });

    // Destination file mutates on disk after the attested read.
    writeFileSync(dstFile, "uno\nDOS-CHANGED\n", "utf8");

    const res = await execWithEnvelope(workdir, envelope, {
        path: "a.ts",
        edits: [{
            op: "copy", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "b.ts", after: anchorFor(2, dstLines[1]!),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "stale");
    assert.equal(readFileSync(srcFile, "utf8"), srcContent, "source must be unmodified");
});

test("transfer: rejects a copy whose resolved source range is outside a line-range resource's coverage", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\nfour\nfive\n";
    const dstContent = "uno\ndos\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "b.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    writeFileSync(dstFile, dstContent, "utf8");
    const srcCanonical = realpathSync(srcFile);
    const dstCanonical = realpathSync(dstFile);
    const srcLines = srcContent.split("\n");
    const dstLines = dstContent.split("\n");

    const sessionFilePath = "/sessions/transfer.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [
            // Only lines 1-2 of the source were read; the transfer targets line 4.
            makeResource({ canonicalPath: srcCanonical, full: false, content: srcContent, range: { startLine: 1, endLine: 2 } }),
            makeResource({ canonicalPath: dstCanonical, full: true, content: dstContent }),
        ],
    });

    const res = await execWithEnvelope(workdir, envelope, {
        path: "a.ts",
        edits: [{
            op: "copy", from: "a.ts",
            range: { pos: anchorFor(4, srcLines[3]!), end: anchorFor(4, srcLines[3]!) },
            to: "b.ts", after: anchorFor(2, dstLines[1]!),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "coverage");
    assert.equal(readFileSync(dstFile, "utf8"), dstContent, "destination must be unmodified");
});

test("transfer: rejects a copy whose source is a prior line-range authority missing fullFileSha256", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-prior-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\nfour\nfive\n";
    const dstContent = "uno\ndos\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "b.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    writeFileSync(dstFile, dstContent, "utf8");
    const srcCanonical = realpathSync(srcFile);
    const dstCanonical = realpathSync(dstFile);
    const srcLines = srcContent.split("\n");
    const dstLines = dstContent.split("\n");

    const sessionFilePath = "/sessions/prior-copy.jsonl";
    const store = createPriorAuthorityStore({ sessionFilePath, canonicalWorkspaceRoot: workdir });
    // Source: prior line-range authority that deliberately omits fullFileSha256
    // (the under-attested case every other authorization path rejects).
    const srcRange = { startLine: 1, endLine: 2 };
    const srcResource: InspectedResource = {
        resourceId: resourceIdFor({ canonicalPath: srcCanonical, kind: "range", range: srcRange }),
        canonicalPath: srcCanonical,
        kind: "range",
        coverage: "line-range",
        allowedRanges: [srcRange],
        fresh: true,
        lineCount: 2,
    };
    const dstResource = makeResource({ canonicalPath: dstCanonical, full: true, content: dstContent });
    store.record(makeEnvelope({ sessionFilePath, canonicalRoot: workdir, resources: [srcResource, dstResource] }));

    const deps: PatchToolDeps = {
        getRpcClient: () => ({
            request: async () => ({
                kind: "reply" as const,
                schemaVersion: PROTOCOL_SCHEMA_VERSION,
                requestId: "r1",
                ok: true,
                payload: makeEnvelope({ sessionFilePath, canonicalRoot: workdir, resources: [srcResource, dstResource] }),
            }),
            dispose: () => {},
        }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
        getPriorAuthority: () => store,
    };
    const tool = createPatchTool(deps);
    const res = await tool.execute(
        "tc-prior-copy",
        {
            path: "a.ts",
            edits: [{
                op: "copy", from: "a.ts",
                range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
                to: "b.ts", after: anchorFor(2, dstLines[1]!),
            }],
            toolCallId: "tc-prior-copy",
        },
        undefined,
        undefined,
        makeCtx(workdir),
    );
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected", `expected rejected, got ${JSON.stringify(d.status)}`);
    assert.equal(d.status.reason, "coverage");
    assert.ok(
        String(d.diagnostics ?? "").match(/fullFileSha256|missing sha/i),
        `diagnostics should mention the missing sha (got: ${JSON.stringify(d.diagnostics)})`,
    );
    assert.equal(readFileSync(srcFile, "utf8"), srcContent, "source must be unmodified");
    assert.equal(readFileSync(dstFile, "utf8"), dstContent, "destination must be unmodified");
});

test("transfer: rejects a source anchor that has drifted beyond the +/-5 rebase window", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    // "target" no longer appears anywhere in the file — the anchor's hash
    // cannot be found within the rebase window at all.
    const content = ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n") + "\n";
    const file = join(workdir, "a.ts");
    writeFileSync(file, content, "utf8");
    const staleAnchor = `2${computeLineHashSync(2, "target-no-longer-present")}`;

    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [{
            op: "copy", from: "a.ts",
            range: { pos: staleAnchor, end: staleAnchor },
            to: "a.ts", after: anchorFor(8, "eight"),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "failed", `expected failed, got ${JSON.stringify(d.status)}`);
    assert.ok(
        String(d.diagnostics ?? "").match(/re-read|stale|ambiguous/i),
        `diagnostics should include a corrective re-read message (got: ${JSON.stringify(d.diagnostics)})`,
    );
    assert.equal(readFileSync(file, "utf8"), content, "file must be unchanged");
});

test("transfer: rejects an ambiguous source anchor (duplicate hash within the rebase window)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const dupLines = ["const x = 1;", "const x = 1;", "unrelated", "padding", "padding", "padding"];
    const content = dupLines.join("\n") + "\n";
    const file = join(workdir, "a.ts");
    writeFileSync(file, content, "utf8");
    // Anchor claims line 3 ("unrelated") but carries line 1's hash — line 3
    // doesn't match exactly, and the hash is found at both lines 1 and 2
    // within the window, so rebase is ambiguous.
    const ambiguousAnchor = `3${computeLineHashSync(1, dupLines[0]!)}`;

    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [{
            op: "copy", from: "a.ts",
            range: { pos: ambiguousAnchor, end: ambiguousAnchor },
            to: "a.ts", after: anchorFor(6, "padding"),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "failed", `expected failed, got ${JSON.stringify(d.status)}`);
    assert.ok(
        String(d.diagnostics ?? "").match(/re-read|stale|ambiguous/i),
        `diagnostics should include a corrective re-read message (got: ${JSON.stringify(d.diagnostics)})`,
    );
    assert.equal(readFileSync(file, "utf8"), content, "file must be unchanged");
});

test("transfer: rejects a same-file move whose `after` anchor lands inside the source range being deleted", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const content = "alpha\nbeta\ngamma\ndelta\n";
    const file = join(workdir, "a.ts");
    writeFileSync(file, content, "utf8");
    const lines = content.split("\n");

    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [{
            op: "move", from: "a.ts",
            // Source range spans lines 2-3 ("beta", "gamma").
            range: { pos: anchorFor(2, lines[1]!), end: anchorFor(3, lines[2]!) },
            // `after` targets a point strictly inside that same span.
            to: "a.ts", after: anchorFor(2, lines[1]!),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "failed", `expected failed, got ${JSON.stringify(d.status)}`);
    assert.ok(
        String(d.diagnostics ?? "").match(/ambiguous/i),
        `diagnostics should reflect the existing ambiguous-insert-boundary check (got: ${JSON.stringify(d.diagnostics)})`,
    );
    assert.equal(readFileSync(file, "utf8"), content, "file must be unchanged");
});

test("transfer: rejects a copy whose destination `after` anchor lands inside a separate text edit's replaced span in the same batch", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const content = "alpha\nbeta\ngamma\ndelta\n";
    const file = join(workdir, "a.ts");
    writeFileSync(file, content, "utf8");
    const lines = content.split("\n");

    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [
            // Independent text edit replacing lines 2-3 ("beta", "gamma").
            { oldText: "beta\ngamma", newText: "BETA\nGAMMA" },
            // Copy whose destination `after` anchor lands inside that replaced span.
            {
                op: "copy", from: "a.ts",
                range: { pos: anchorFor(4, lines[3]!), end: anchorFor(4, lines[3]!) },
                to: "a.ts", after: anchorFor(2, lines[1]!),
            },
        ],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "failed", `expected failed, got ${JSON.stringify(d.status)}`);
    assert.ok(
        String(d.diagnostics ?? "").match(/ambiguous/i),
        `diagnostics should reflect the ambiguous-insert-boundary check (got: ${JSON.stringify(d.diagnostics)})`,
    );
    assert.equal(readFileSync(file, "utf8"), content, "file must be unchanged");
});

test("transfer: cross-file move rolls back BOTH files when a blocking verifier fails for the source path", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\n";
    const dstContent = "uno\ndos\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "b.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    writeFileSync(dstFile, dstContent, "utf8");
    const srcCanonical = realpathSync(srcFile);
    const srcLines = srcContent.split("\n");
    const dstLines = dstContent.split("\n");

    // Destination is written to disk first (its EditGroup is reserved before
    // the source's during transfer resolution), then the source group's
    // blocking check fails — verifying rollback restores both files.
    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [{
            op: "move", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "b.ts", after: anchorFor(2, dstLines[1]!),
        }],
    }, [{
        id: "source-guard",
        kind: "blocking",
        run: async (ctx: { path: string }) => ({
            outcome: ctx.path === srcCanonical ? "fail" : "pass",
        }),
    }]);
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected", `expected rejected, got ${JSON.stringify(d.status)}`);
    assert.equal(readFileSync(srcFile, "utf8"), srcContent, "source must be restored");
    assert.equal(readFileSync(dstFile, "utf8"), dstContent, "destination must be restored");
});

test("transfer: a successful cross-file move writes undo records for both touched files", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\n";
    const dstContent = "uno\ndos\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "b.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    writeFileSync(dstFile, dstContent, "utf8");
    const srcCanonical = realpathSync(srcFile);
    const dstCanonical = realpathSync(dstFile);
    const srcLines = srcContent.split("\n");
    const dstLines = dstContent.split("\n");

    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [{
            op: "move", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "b.ts", after: anchorFor(2, dstLines[1]!),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${JSON.stringify(d.status)}`);

    const history = await getUndoHistory(workdir);
    const touchedPaths = new Set(history.map((entry) => entry.path));
    assert.ok(touchedPaths.has(srcCanonical), "undo history must include the source file");
    assert.ok(touchedPaths.has(dstCanonical), "undo history must include the destination file");
});

test("transfer: cross-file move from a CRLF source into an LF destination adopts each file's own line ending", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\r\ntwo\r\nthree\r\n";
    const dstContent = "uno\ndos\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "b.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    writeFileSync(dstFile, dstContent, "utf8");
    const srcLines = srcContent.split(/\r\n/).filter((_, i, arr) => i < arr.length - 1 || arr[i] !== "");
    const dstLines = dstContent.split("\n");

    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [{
            op: "move", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "b.ts", after: anchorFor(2, dstLines[1]!),
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${JSON.stringify(d.status)}`);
    assert.equal(readFileSync(srcFile, "utf8"), "one\r\nthree\r\n", "source must keep its own CRLF convention");
    const dstFinal = readFileSync(dstFile, "utf8");
    assert.equal(dstFinal, "uno\ndos\ntwo\n", "destination must adopt its own LF convention, not the source's CRLF");
    assert.ok(!dstFinal.includes("\r"), "transferred text must not carry the source's CR byte into an LF destination");
});

test("transfer: a transfer op and a normal oldText/newText edit to a third file apply together in one call", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\n";
    const dstContent = "uno\ndos\n";
    const thirdContent = "foo\nbar\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "b.ts");
    const thirdFile = join(workdir, "c.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    writeFileSync(dstFile, dstContent, "utf8");
    writeFileSync(thirdFile, thirdContent, "utf8");
    const srcLines = srcContent.split("\n");
    const dstLines = dstContent.split("\n");

    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [
            {
                op: "move", from: "a.ts",
                range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
                to: "b.ts", after: anchorFor(2, dstLines[1]!),
            },
            { path: "c.ts", oldText: "bar", newText: "BAR" },
        ],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${JSON.stringify(d.status)}`);
    assert.equal(readFileSync(srcFile, "utf8"), "one\nthree\n");
    assert.equal(readFileSync(dstFile, "utf8"), "uno\ndos\ntwo\n");
    assert.equal(readFileSync(thirdFile, "utf8"), "foo\nBAR\n");
});

test("transfer: cross-file copy into a brand-new destination file creates it with exactly the transferred content", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "new.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    const srcCanonical = realpathSync(srcFile);
    const srcLines = srcContent.split("\n");

    // `copy`'s source is never covered by auto-inspect (it never becomes a
    // real EditGroup), so it needs a prior authority record instead —
    // exactly as it would after the model previously read the source file.
    const sessionFilePath = "/sessions/transfer.jsonl";
    const store = createPriorAuthorityStore({ sessionFilePath, canonicalWorkspaceRoot: workdir });
    store.record(makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [makeResource({ canonicalPath: srcCanonical, full: true, content: srcContent })],
    }));
    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => { throw new Error("auto-inspect must not use RPC"); }, dispose: () => {} }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
        getPriorAuthority: () => store,
    };
    const res = await createPatchTool(deps).execute("tc1", {
        path: "a.ts",
        edits: [{
            op: "copy", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "new.ts",
        }],
        toolCallId: "tc1",
    }, undefined, undefined, makeCtx(workdir));
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${JSON.stringify(d.status)}`);
    assert.equal(readFileSync(srcFile, "utf8"), srcContent, "copy source must be unchanged");
    assert.equal(readFileSync(dstFile, "utf8"), "two");
});

test("transfer: cross-file move into a brand-new destination file creates it with the range's content and removes it from the source", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "new.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    const srcLines = srcContent.split("\n");

    const res = await execAutoInspect(workdir, {
        path: "a.ts",
        edits: [{
            op: "move", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "new.ts",
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${JSON.stringify(d.status)}`);
    assert.equal(readFileSync(srcFile, "utf8"), "one\nthree\n");
    assert.equal(readFileSync(dstFile, "utf8"), "two");
});

test("transfer: rejects when destination already exists and `after` is omitted", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\n";
    const dstContent = "uno\ndos\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "b.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    writeFileSync(dstFile, dstContent, "utf8");
    const srcCanonical = realpathSync(srcFile);
    const dstCanonical = realpathSync(dstFile);
    const srcLines = srcContent.split("\n");

    const sessionFilePath = "/sessions/transfer.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [
            makeResource({ canonicalPath: srcCanonical, full: true, content: srcContent }),
            makeResource({ canonicalPath: dstCanonical, full: true, content: dstContent }),
        ],
    });

    const res = await execWithEnvelope(workdir, envelope, {
        path: "a.ts",
        edits: [{
            op: "copy", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "b.ts",
        }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected", `expected rejected, got ${JSON.stringify(d.status)}`);
    assert.match(res.content[0]!.text, /`after` is required/);
    assert.equal(readFileSync(dstFile, "utf8"), dstContent, "destination must be unmodified");
});

test("transfer: an `after` anchor is tolerated (and ignored) when `to` is a brand-new file", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "patch-xfer-")));
    mkdirSync(workdir, { recursive: true });
    const srcContent = "one\ntwo\nthree\n";
    const srcFile = join(workdir, "a.ts");
    const dstFile = join(workdir, "new.ts");
    writeFileSync(srcFile, srcContent, "utf8");
    const srcCanonical = realpathSync(srcFile);
    const srcLines = srcContent.split("\n");

    const sessionFilePath = "/sessions/transfer.jsonl";
    const store = createPriorAuthorityStore({ sessionFilePath, canonicalWorkspaceRoot: workdir });
    store.record(makeEnvelope({
        sessionFilePath,
        canonicalRoot: workdir,
        resources: [makeResource({ canonicalPath: srcCanonical, full: true, content: srcContent })],
    }));
    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => { throw new Error("auto-inspect must not use RPC"); }, dispose: () => {} }),
        getSessionFilePath: () => sessionFilePath,
        getCanonicalWorkspaceRoot: () => workdir,
        getPriorAuthority: () => store,
    };
    const res = await createPatchTool(deps).execute("tc1", {
        path: "a.ts",
        edits: [{
            op: "copy", from: "a.ts",
            range: { pos: anchorFor(2, srcLines[1]!), end: anchorFor(2, srcLines[1]!) },
            to: "new.ts", after: anchorFor(2, srcLines[1]!),
        }],
        toolCallId: "tc1",
    }, undefined, undefined, makeCtx(workdir));
    const d = res.details as any;
    assert.equal(d.status.kind, "applied", `expected applied, got ${JSON.stringify(d.status)}`);
    assert.equal(readFileSync(dstFile, "utf8"), "two");
});
