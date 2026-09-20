/**
 * Protocol-contract regression tests (provider v0.4.0, do NOT modify provider).
 * 1. Retry envelope inspectionId must vary per range and match provider recompute.
 * 2. resolve_evidence path must reject malformed envelopes.
 * 3. New-file synthetic resource must use parent-resolved canonical path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    sha256OfString,
} from "@rhinos0608/pi-workspace-protocol";
import { mintRetryEvidenceFromSelection } from "../src/extension/retry-evidence.js";
import { acquirePatchEnvelope, buildAutoInspectEnvelope } from "../src/patch/request-prep.js";
import { resolveTransferBatch } from "../src/transfer/resolve-batch.js";
import { freshChecks } from "../src/patch/result-builders.js";

test("retry envelope inspectionId differs per range and matches provider recompute", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "proto-retry-")));
    const file = join(workdir, "a.ts");
    const content = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
    writeFileSync(file, content, "utf8");
    const canonicalPath = realpathSync(file);
    const sha = sha256OfString(content);
    const state = {
        sessionFilePath: "/sessions/proto-retry.jsonl",
        canonicalWorkspaceRoot: workdir,
        priorAuthority: null,
    };
    const selA = [{ startLine: 1, endLine: 2 }];
    const selB = [{ startLine: 5, endLine: 6 }];
    const a = await mintRetryEvidenceFromSelection(selA, canonicalPath, sha, state);
    const b = await mintRetryEvidenceFromSelection(selB, canonicalPath, sha, state);
    assert.ok(a && b);
    // Id must differ per range (range suffix present).
    assert.notEqual(a.envelope.inspectionId, b.envelope.inspectionId);
    // Id must match provider recompute with one entry per range as {canonicalPath, range}.
    const sessionId = hashSessionFilePath(state.sessionFilePath);
    const expectedA = inspectionIdFor({
        sessionId,
        workspaceRoot: workdir,
        resources: selA.map((range) => ({ canonicalPath, range })),
    });
    assert.equal(a.envelope.inspectionId, expectedA);
});

test("resolve_evidence path rejects malformed envelope payload", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "proto-malformed-")));
    const file = join(workdir, "a.ts");
    writeFileSync(file, "alpha\nbeta\n", "utf8");
    const deps: Parameters<typeof acquirePatchEnvelope>[0]["deps"] = {
        getRpcClient: () => ({
            request: async () => ({
                kind: "reply" as const,
                schemaVersion: PROTOCOL_SCHEMA_VERSION,
                requestId: "r1",
                ok: true,
                // Well-formed session/root, but invalid per validateInspectionEnvelope
                // (empty resources in path mode): must still be rejected.
                payload: {
                    schemaVersion: PROTOCOL_SCHEMA_VERSION,
                    inspectionId: "b".repeat(64),
                    sessionId: hashSessionFilePath("/sessions/proto.jsonl"),
                    workspaceRoot: workdir,
                    canonicalWorkspaceRoot: workdir,
                    createdAt: new Date().toISOString(),
                    resources: [],
                    mode: "path",
                },
            }),
            dispose: () => {},
        }),
        getSessionFilePath: () => "/sessions/proto.jsonl",
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const res = await acquirePatchEnvelope({
        deps,
        groups: [{ absolutePath: file, rawPath: "a.ts", edits: [] }],
        sessionFilePath: "/sessions/proto.jsonl",
        canonicalRoot: workdir,
        requestEvidenceRef: { inspectionId: "a".repeat(64), resourceIds: ["r1"] },
        toolCallId: "tc-malformed",
        tool: "edit",
        checks: freshChecks(),
        diagnostics: [],
        usedEvidence: [],
        signal: undefined,
    });
    assert.equal(res.ok, false);
});

test("new-file synthetic resource uses parent-resolved canonical path", async () => {
    const realDir = realpathSync(mkdtempSync(join(tmpdir(), "proto-newfile-")));
    const linkDir = `${realDir}-link`;
    symlinkSync(realDir, linkDir);
    const unresolved = join(linkDir, "new.ts");
    const built = await buildAutoInspectEnvelope({
        sessionFilePath: "/sessions/proto-new.jsonl",
        canonicalRoot: realDir,
        groups: [{ absolutePath: unresolved, rawPath: "new.ts", edits: [{ oldText: "", newText: "hi" }] }],
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    // realpath is impossible pre-create (file does not exist), so the parent
    // dir is resolved and the basename joined — symlink-free and stable.
    const expected = join(realpathSync(realDir), basename(unresolved));
    assert.equal(built.envelope.resources[0]?.canonicalPath, expected);
    assert.equal(built.canonicalByGroup[0], expected);
    assert.ok(built.newFileCanonicals.has(expected));
});

test("mismatched-id envelope rejects (resolver-spoof guard)", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "proto-spoof-")));
    const file = join(workdir, "a.ts");
    writeFileSync(file, "alpha\nbeta\n", "utf8");
    const requestedId = "a".repeat(64);
    const otherId = "b".repeat(64);
    const deps: Parameters<typeof acquirePatchEnvelope>[0]["deps"] = {
        getRpcClient: () => ({
            request: async () => ({
                kind: "reply" as const,
                schemaVersion: PROTOCOL_SCHEMA_VERSION,
                requestId: "r1",
                ok: true,
                payload: {
                    schemaVersion: PROTOCOL_SCHEMA_VERSION,
                    inspectionId: otherId,
                    sessionId: hashSessionFilePath("/sessions/proto-spoof.jsonl"),
                    workspaceRoot: workdir,
                    canonicalWorkspaceRoot: workdir,
                    createdAt: new Date().toISOString(),
                    resources: [
                        {
                            resourceId: "c".repeat(64),
                            canonicalPath: realpathSync(file),
                            kind: "full",
                            coverage: "full-file",
                            allowedRanges: [{ startLine: 1, endLine: 2 }],
                            fullFileSha256: sha256OfString("alpha\nbeta\n"),
                            fresh: true,
                            byteLength: 11,
                            lineCount: 2,
                        },
                    ],
                    mode: "path",
                },
            }),
            dispose: () => {},
        }),
        getSessionFilePath: () => "/sessions/proto-spoof.jsonl",
        getCanonicalWorkspaceRoot: () => workdir,
    };
    const res = await acquirePatchEnvelope({
        deps,
        groups: [{ absolutePath: file, rawPath: "a.ts", edits: [] }],
        sessionFilePath: "/sessions/proto-spoof.jsonl",
        canonicalRoot: workdir,
        requestEvidenceRef: { inspectionId: requestedId, resourceIds: ["r1"] },
        toolCallId: "tc-spoof",
        tool: "edit",
        checks: freshChecks(),
        diagnostics: [],
        usedEvidence: [],
        signal: undefined,
    });
    assert.equal(res.ok, false);
});

test("transfer ENOENT dest resolves parent realpath under symlinked parent", () => {
    const realDir = realpathSync(mkdtempSync(join(tmpdir(), "proto-xfer-")));
    const linkDir = `${realDir}-link`;
    symlinkSync(realDir, linkDir);
    const srcFile = join(realDir, "src.ts");
    writeFileSync(srcFile, "hello\n", "utf8");
    const groups: Parameters<typeof resolveTransferBatch>[0]["groups"] = [];
    const res = resolveTransferBatch({
        transfers: [
            {
                op: "copy",
                from: srcFile,
                to: join(linkDir, "new.ts"),
                range: { pos: "1aa", end: "1ab" },
                after: undefined,
                description: undefined,
            },
        ],
        groups,
        ctx: { cwd: "/" },
        toolCallId: "tc-xfer",
        requestEvidenceRef: undefined,
        checks: freshChecks(),
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const expected = join(realpathSync(realDir), basename(join(linkDir, "new.ts")));
    assert.equal(res.resolvedTransfers[0]?.canonicalTo, expected);
    assert.equal(res.resolvedTransfers[0]?.toIsNewFile, true);
});
