/** Batch workspace-evidence ingestion (SmartRead compat). */
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

import { ingestWorkspaceEvidence } from "../src/extension/read-events.js";
import { createPriorAuthorityStore } from "../src/context/evidence-authority.js";

const SESSION = "/sessions/p.jsonl";
const ROOT = "/ws";
const PATH = "/ws/a.ts";
const CONTENT = "l1\nl2\nl3\n";

function makeEnvelope(): WorkspaceEvidenceEnvelope {
    const sessionId = hashSessionFilePath(SESSION);
    const resource: InspectedResource = {
        canonicalPath: PATH,
        resourceId: resourceIdFor({ canonicalPath: PATH, kind: "full" }),
        kind: "full",
        coverage: "full-file",
        allowedRanges: [{ startLine: 1, endLine: 3 }],
        fresh: true,
        fullFileSha256: createHash("sha256").update(CONTENT, "utf8").digest("hex"),
        byteLength: Buffer.byteLength(CONTENT, "utf8"),
        lineCount: 3,
    };
    const inspectionId = createHash("sha256")
        .update(`inspection|${sessionId}|${ROOT}\n${PATH}|full|1-3`, "utf8")
        .digest("hex");
    return {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: ROOT,
        canonicalWorkspaceRoot: ROOT,
        createdAt: new Date().toISOString(),
        resources: [resource],
    };
}

for (const toolName of ["read", "read_files", "read_multiple_files"]) {
    test(`ingestWorkspaceEvidence ingests ${toolName} envelope`, () => {
        const store = createPriorAuthorityStore({ sessionFilePath: SESSION, canonicalWorkspaceRoot: ROOT });
        ingestWorkspaceEvidence({ toolName, isError: false, details: { workspaceEvidence: makeEnvelope() } }, store);
        assert.notEqual(store.select(PATH), null);
    });
}

test("ingestWorkspaceEvidence ignores error results", () => {
    const store = createPriorAuthorityStore({ sessionFilePath: SESSION, canonicalWorkspaceRoot: ROOT });
    ingestWorkspaceEvidence({ toolName: "read_files", isError: true, details: { workspaceEvidence: makeEnvelope() } }, store);
    assert.equal(store.select(PATH), null);
});

test("ingestWorkspaceEvidence ingests intent_read envelope", () => {
    const store = createPriorAuthorityStore({ sessionFilePath: SESSION, canonicalWorkspaceRoot: ROOT });
    ingestWorkspaceEvidence({ toolName: "intent_read", isError: false, details: { workspaceEvidence: makeEnvelope() } }, store);
    assert.notEqual(store.select(PATH), null);
});

test("ingestWorkspaceEvidence ignores intent_read error results", () => {
    const store = createPriorAuthorityStore({ sessionFilePath: SESSION, canonicalWorkspaceRoot: ROOT });
    ingestWorkspaceEvidence({ toolName: "intent_read", isError: true, details: { workspaceEvidence: makeEnvelope() } }, store);
    assert.equal(store.select(PATH), null);
});

test("ingestWorkspaceEvidence ignores invalid/weak intent_read envelopes", () => {
    const base = makeEnvelope();
    const weak: WorkspaceEvidenceEnvelope = { ...base, resources: [{ ...base.resources[0]!, coverage: "search-match" }] };
    const store = createPriorAuthorityStore({ sessionFilePath: SESSION, canonicalWorkspaceRoot: ROOT });
    ingestWorkspaceEvidence({ toolName: "intent_read", isError: false, details: { workspaceEvidence: { bogus: true } } }, store);
    ingestWorkspaceEvidence({ toolName: "intent_read", isError: false, details: { workspaceEvidence: weak } }, store);
    assert.equal(store.select(PATH), null);
});
