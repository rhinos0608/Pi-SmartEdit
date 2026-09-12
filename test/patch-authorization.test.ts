/**
 * Characterization tests for src/patch-authorization.ts.
 * Mirrors the authorization rules in src/patch.ts exactly:
 * sessionId / canonicalWorkspaceRoot / resource-ID / coverage /
 * fullFileSha256. No cwd containment anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
    authorizeResource,
    checkResourceCoverage,
    validateResourceAuthority,
    findResourceForCanonicalPath,
    isValidFullFileSha256,
    SHA256_RE,
} from "../src/patch-authorization.js";

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
        mode: "path",
    };
}

// ── resolvePatchAuthorization ─────────────────────────────────────

test("resolvePatchAuthorization: matches session and resourceIds", () => {
    const content = "alpha\nbeta\ngamma\ndelta\n";
    const sessionFilePath = "/sessions/p.jsonl";
    const envelope = makeEnvelope({
        sessionFilePath,
        canonicalRoot: "/ws",
        resources: [makeResource({ canonicalPath: "/ws/a.ts", full: true, content })],
    });
    const auth = resolvePatchAuthorization({
        envelope,
        sessionFilePath,
        canonicalWorkspaceRoot: "/ws",
        requestedResourceIds: [envelope.resources[0]!.resourceId],
    });
    assert.equal(auth.ok, true);
    if (auth.ok) {
        assert.equal(auth.resource.canonicalPath, "/ws/a.ts");
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

test("resolvePatchAuthorization: rejects workspace mismatch", () => {
    const env = makeEnvelope({
        sessionFilePath: "/sessions/a.jsonl",
        canonicalRoot: "/ws",
        resources: [makeResource({ canonicalPath: "/ws/a.ts", full: true, content: "x\n" })],
    });
    const auth = resolvePatchAuthorization({
        envelope: env,
        sessionFilePath: "/sessions/a.jsonl",
        canonicalWorkspaceRoot: "/other",
        requestedResourceIds: [env.resources[0]!.resourceId],
    });
    assert.equal(auth.ok, false);
    if (!auth.ok) assert.match(auth.reason, /workspace/i);
});

test("resolvePatchAuthorization: rejects missing resourceIds", () => {
    const env = makeEnvelope({
        sessionFilePath: "/sessions/a.jsonl",
        canonicalRoot: "/ws",
        resources: [makeResource({ canonicalPath: "/ws/a.ts", full: true, content: "x\n" })],
    });
    const auth = resolvePatchAuthorization({
        envelope: env,
        sessionFilePath: "/sessions/a.jsonl",
        canonicalWorkspaceRoot: "/ws",
        requestedResourceIds: [],
    });
    assert.equal(auth.ok, false);
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

test("resolvePatchAuthorization: rejects target line range outside allowedRanges", () => {
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

// ── checkResourceCoverage ─────────────────────────────────────────

test("checkResourceCoverage: full-file authorizes any range", () => {
    const r = makeResource({ canonicalPath: "/ws/a.ts", full: true, content: "a\nb\n" });
    assert.equal(checkResourceCoverage(r, [{ startLine: 99, endLine: 100 }]), null);
});

test("checkResourceCoverage: line-range authorizes covered range only", () => {
    const r = makeResource({
        canonicalPath: "/ws/a.ts",
        full: false,
        content: "l1\nl2\nl3\nl4\n",
        range: { startLine: 2, endLine: 3 },
    });
    assert.equal(checkResourceCoverage(r, [{ startLine: 2, endLine: 3 }]), null);
    const err = checkResourceCoverage(r, [{ startLine: 3, endLine: 4 }]);
    assert.match(err ?? "", /coverage/i);
});

test("checkResourceCoverage: search-match and metadata-only are weak", () => {
    for (const coverage of ["search-match", "metadata-only"] as const) {
        const r: InspectedResource = {
            resourceId: "r",
            canonicalPath: "/ws/a.ts",
            kind: "range",
            coverage,
            allowedRanges: [{ startLine: 1, endLine: 10 }],
            fresh: false,
        };
        const err = checkResourceCoverage(r, [{ startLine: 1, endLine: 1 }]);
        assert.match(err ?? "", /weak evidence/);
    }
});

// ── validateResourceAuthority (SHA shape + requireFull) ───────────

test("validateResourceAuthority: rejects malformed fullFileSha256", () => {
    const r = makeResource({ canonicalPath: "/ws/a.ts", full: true, content: "a\n" });
    const bad: InspectedResource = { ...r, fullFileSha256: "not-a-sha" };
    const err = validateResourceAuthority(bad, [], false);
    assert.match(err ?? "", /fullFileSha256/);
    const missing: InspectedResource = { ...r, fullFileSha256: undefined };
    assert.match(validateResourceAuthority(missing, [], false) ?? "", /fullFileSha256/);
});

test("validateResourceAuthority: requireFull rejects line-range", () => {
    const r = makeResource({
        canonicalPath: "/ws/a.ts",
        full: false,
        content: "l1\nl2\n",
        range: { startLine: 1, endLine: 2 },
    });
    const err = validateResourceAuthority(r, [], true);
    assert.match(err ?? "", /full-file evidence required/);
});

test("validateResourceAuthority: valid full-file passes", () => {
    const r = makeResource({ canonicalPath: "/ws/a.ts", full: true, content: "a\n" });
    assert.equal(validateResourceAuthority(r, [], false), null);
});

// ── authorizeResource (selection) ─────────────────────────────────

test("authorizeResource: selects only requested ids; unlisted path twin never authorizes", () => {
    const a = makeResource({ canonicalPath: "/ws/a.ts", full: true, content: "a\n" });
    const twin: InspectedResource = {
        ...makeResource({ canonicalPath: "/ws/a.ts", full: true, content: "evil\n" }),
        resourceId: "unlisted-twin",
    };
    const ok = authorizeResource({
        resources: [a, twin],
        canonicalPath: "/ws/a.ts",
        canonicalWorkspaceRoot: "/ws",
        requestedResourceIds: [a.resourceId],
        targetRanges: [],
    });
    assert.equal(ok.ok, true);
    const missing = authorizeResource({
        resources: [a],
        canonicalPath: "/ws/a.ts",
        canonicalWorkspaceRoot: "/ws",
        requestedResourceIds: ["does-not-exist"],
        targetRanges: [],
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.reason, /missing resource/);
});

// ── findResourceForCanonicalPath ──────────────────────────────────

test("findResourceForCanonicalPath: restricted to requested ids", () => {
    const a = makeResource({ canonicalPath: "/ws/a.ts", full: true, content: "a\n" });
    const b = makeResource({ canonicalPath: "/ws/b.ts", full: true, content: "b\n" });
    const env = makeEnvelope({ sessionFilePath: "/s.jsonl", canonicalRoot: "/ws", resources: [a, b] });
    assert.equal(findResourceForCanonicalPath(env, "/ws/b.ts", [b.resourceId])?.resourceId, b.resourceId);
    assert.equal(findResourceForCanonicalPath(env, "/ws/b.ts", [a.resourceId]), null);
    assert.equal(findResourceForCanonicalPath(env, "/ws/missing.ts", [a.resourceId, b.resourceId]), null);
});

// ── SHA shape ─────────────────────────────────────────────────────

test("isValidFullFileSha256: accepts 64 hex, rejects rest", () => {
    assert.equal(isValidFullFileSha256(sha256("x")), true);
    assert.equal(isValidFullFileSha256("not-a-sha"), false);
    assert.equal(isValidFullFileSha256(undefined), false);
    assert.equal(SHA256_RE.test(sha256("y")), true);
});
