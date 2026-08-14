/**
 * PriorAuthorityStore unit tests — tool-owned evidence policy B.
 *
 * Verifies: latest strong wins by arrival order, newer line-range supersedes
 * older full-file, later full-file widens again, weak evidence does not
 * authorize, session/root mismatch ignored, invalid envelope ignored, clear().
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

import { createPriorAuthorityStore } from "../src/evidence-authority.js";

function sha256(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

function makeResource(opts: {
    canonicalPath: string;
    coverage: InspectedResource["coverage"];
    content?: string;
    range?: { startLine: number; endLine: number };
}): InspectedResource {
    const base = {
        canonicalPath: opts.canonicalPath,
        allowedRanges: opts.range ? [opts.range] : [{ startLine: 1, endLine: 1 }],
        fresh: opts.coverage === "full-file" || opts.coverage === "line-range",
    };
    if (opts.coverage === "full-file") {
        const content = opts.content ?? "";
        const totalLines = content.split("\n").length;
        return {
            ...base,
            resourceId: resourceIdFor({ canonicalPath: opts.canonicalPath, kind: "full" }),
            kind: "full",
            coverage: "full-file",
            allowedRanges: [{ startLine: 1, endLine: totalLines }],
            fullFileSha256: sha256(content),
            byteLength: Buffer.byteLength(content, "utf8"),
            lineCount: totalLines,
        };
    }
    if (opts.coverage === "line-range") {
        const range = opts.range ?? { startLine: 1, endLine: 1 };
        return {
            ...base,
            resourceId: resourceIdFor({
                canonicalPath: opts.canonicalPath,
                kind: "range",
                range,
            }),
            kind: "range",
            coverage: "line-range",
            allowedRanges: [range],
            fullFileSha256: opts.content ? sha256(opts.content) : undefined,
            lineCount: range.endLine - range.startLine + 1,
        };
    }
    // weak coverage
    return {
        ...base,
        resourceId: resourceIdFor({
            canonicalPath: opts.canonicalPath,
            kind: "range",
            range: { startLine: 1, endLine: 1 },
        }),
        kind: "range",
        coverage: opts.coverage,
        fresh: false,
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

const SESSION = "/sessions/p.jsonl";
const ROOT = "/ws";

function makeStore() {
    return createPriorAuthorityStore({ sessionFilePath: SESSION, canonicalWorkspaceRoot: ROOT });
}

test("record: latest strong wins by arrival order (newer line-range supersedes older full-file)", () => {
    const store = makeStore();
    const path = "/ws/a.ts";
    store.record(makeEnvelope({
        sessionFilePath: SESSION,
        canonicalRoot: ROOT,
        resources: [makeResource({ canonicalPath: path, coverage: "full-file", content: "l1\nl2\nl3\nl4\nl5\n" })],
    }));
    store.record(makeEnvelope({
        sessionFilePath: SESSION,
        canonicalRoot: ROOT,
        resources: [makeResource({ canonicalPath: path, coverage: "line-range", range: { startLine: 1, endLine: 2 } })],
    }));
    const selected = store.select(path);
    assert.ok(selected, "must select a resource");
    assert.equal(selected!.coverage, "line-range", "newer line-range must supersede older full-file");
});

test("record: later full-file read widens authority again", () => {
    const store = makeStore();
    const path = "/ws/a.ts";
    store.record(makeEnvelope({
        sessionFilePath: SESSION,
        canonicalRoot: ROOT,
        resources: [makeResource({ canonicalPath: path, coverage: "line-range", range: { startLine: 1, endLine: 2 } })],
    }));
    store.record(makeEnvelope({
        sessionFilePath: SESSION,
        canonicalRoot: ROOT,
        resources: [makeResource({ canonicalPath: path, coverage: "full-file", content: "l1\nl2\nl3\nl4\nl5\n" })],
    }));
    const selected = store.select(path);
    assert.ok(selected, "must select a resource");
    assert.equal(selected!.coverage, "full-file", "later full-file must widen authority again");
});

test("record: weak evidence does not authorize (counts as no strong grant)", () => {
    const store = makeStore();
    const path = "/ws/a.ts";
    store.record(makeEnvelope({
        sessionFilePath: SESSION,
        canonicalRoot: ROOT,
        resources: [makeResource({ canonicalPath: path, coverage: "search-match" })],
    }));
    assert.equal(store.select(path), null, "weak evidence must not authorize");
});

test("record: only full-file and line-range coverage are on the allowlist (future values ignored)", () => {
    const store = makeStore();
    const path = "/ws/a.ts";
    // An as-yet-unknown coverage value must be treated as weak and ignored,
    // not implicitly authorized.
    const unknown = makeResource({ canonicalPath: path, coverage: "snippet" as InspectedResource["coverage"] });
    store.record(makeEnvelope({
        sessionFilePath: SESSION,
        canonicalRoot: ROOT,
        resources: [unknown],
    }));
    assert.equal(store.select(path), null, "unknown coverage must be ignored by the allowlist");
});

test("record: session mismatch ignored", () => {
    const store = makeStore();
    const path = "/ws/a.ts";
    store.record(makeEnvelope({
        sessionFilePath: "/sessions/other.jsonl",
        canonicalRoot: ROOT,
        resources: [makeResource({ canonicalPath: path, coverage: "full-file", content: "x\n" })],
    }));
    assert.equal(store.select(path), null, "session mismatch must be ignored");
});

test("record: workspace root mismatch ignored", () => {
    const store = makeStore();
    const path = "/ws/a.ts";
    store.record(makeEnvelope({
        sessionFilePath: SESSION,
        canonicalRoot: "/other-root",
        resources: [makeResource({ canonicalPath: path, coverage: "full-file", content: "x\n" })],
    }));
    assert.equal(store.select(path), null, "root mismatch must be ignored");
});

test("record: invalid envelope ignored", () => {
    const store = makeStore();
    store.record({ not: "an envelope" });
    assert.equal(store.select("/ws/a.ts"), null, "invalid envelope must be ignored");
});

test("record: distinct canonical paths indexed independently", () => {
    const store = makeStore();
    store.record(makeEnvelope({
        sessionFilePath: SESSION,
        canonicalRoot: ROOT,
        resources: [
            makeResource({ canonicalPath: "/ws/a.ts", coverage: "full-file", content: "a\n" }),
            makeResource({ canonicalPath: "/ws/b.ts", coverage: "line-range", range: { startLine: 1, endLine: 1 } }),
        ],
    }));
    assert.equal(store.select("/ws/a.ts")!.coverage, "full-file");
    assert.equal(store.select("/ws/b.ts")!.coverage, "line-range");
    assert.equal(store.select("/ws/c.ts"), null);
});

test("record: snapshots validated resources against later mutation", () => {
    const store = makeStore();
    const path = "/ws/a.ts";
    const resource = makeResource({
        canonicalPath: path,
        coverage: "line-range",
        range: { startLine: 1, endLine: 2 },
        content: "l1\nl2\n",
    });
    store.record(makeEnvelope({
        sessionFilePath: SESSION,
        canonicalRoot: ROOT,
        resources: [resource],
    }));

    (resource.allowedRanges as Array<{ startLine: number; endLine: number }>)[0]!.endLine = 99;
    assert.deepEqual(store.select(path)?.allowedRanges, [{ startLine: 1, endLine: 2 }]);
});

test("clear: empties the store", () => {
    const store = makeStore();
    store.record(makeEnvelope({
        sessionFilePath: SESSION,
        canonicalRoot: ROOT,
        resources: [makeResource({ canonicalPath: "/ws/a.ts", coverage: "full-file", content: "x\n" })],
    }));
    assert.ok(store.select("/ws/a.ts"));
    store.clear();
    assert.equal(store.select("/ws/a.ts"), null);
});
