/**
 * Post-edit authority narrowing — TDD tracer for the full-file mint widening defect.
 *
 * Defect: after a line-range-authorized edit succeeds, buildMutationEvidence mints
 * coverage full-file over the whole file and handleEditSuccessResult records it into
 * PriorAuthorityStore, so the next edit anywhere in the file passes without the model
 * reading those lines. The mint exists so edit→edit survives the stale-SHA guard, but
 * it conflates knowing the new SHA with model observability.
 *
 * Contract under test: on edit success the minted authority keeps
 * allowedRanges = prior ranges transformed through the edit mapping UNION the
 * model-visible postimage changed ranges (diff hunks surfaced to the model); the
 * fresh full-file SHA advances (stale guard passes) without broadening coverage.
 * Prior full-file stays full-file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { mkdirSync } from "node:fs";

import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    resourceIdFor,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
} from "@rhinos0608/pi-workspace-protocol";

import { createPatchTool, type PatchToolDeps } from "../src/patch.js";
import { createPriorAuthorityStore } from "../src/context/evidence-authority.js";
import {
    handleEditSuccessResult,
    parsePostEditDiff,
    narrowPostEditRanges,
} from "../src/extension/post-lanes.js";
import { createSessionState, buildMutationEvidence } from "../src/extension/session.js";

function sha256(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
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

function lineRangeResource(
    canonicalFile: string,
    range: { startLine: number; endLine: number },
    content: string,
): InspectedResource {
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

function fullFileResource(canonicalFile: string, content: string): InspectedResource {
    return {
        resourceId: resourceIdFor({ canonicalPath: canonicalFile, kind: "full" }),
        canonicalPath: canonicalFile,
        kind: "full",
        coverage: "full-file",
        allowedRanges: [{ startLine: 1, endLine: content.split("\n").length }],
        fullFileSha256: sha256(content),
        fresh: true,
        lineCount: content.split("\n").length,
    };
}

const SESSION_FILE = "/sessions/narrow.jsonl";

function lines(n: number): string {
    return Array.from({ length: n }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n") + "\n";
}

async function setup(contentFiles: Record<string, string>, priors: (cf: (rel: string) => string) => InspectedResource[]) {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "narrow-")));
    for (const [rel, content] of Object.entries(contentFiles)) {
        const target = join(workdir, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
    }
    const cf = (rel: string) => realpathSync(join(workdir, rel));
    const store = createPriorAuthorityStore({ sessionFilePath: SESSION_FILE, canonicalWorkspaceRoot: workdir });
    const priorResources = priors(cf);
    if (priorResources.length) store.record(makeEnvelope({ sessionFilePath: SESSION_FILE, canonicalRoot: workdir, resources: priorResources }));

    const session = createSessionState();
    session.currentSessionFilePath = SESSION_FILE;
    session.currentCanonicalWorkspaceRoot = workdir;
    session.currentCwd = workdir;
    session.priorAuthorityStore = store;

    const deps: PatchToolDeps = {
        getRpcClient: () => ({ request: async () => { throw new Error("unused"); }, dispose: () => {} }),
        getSessionFilePath: () => SESSION_FILE,
        getCanonicalWorkspaceRoot: () => workdir,
        getPriorAuthority: () => store,
        getAstResolver: () => null,
        getStructuralResolver: () => null,
        getSnapshot: () => null,
        runRepair: undefined,
        runFinalSuccessLanes: undefined,
    };
    const tool = createPatchTool(deps);
    const runEdit = (rel: string, edits: unknown[]) =>
        tool.execute("tc", { path: rel, edits }, undefined, undefined, { cwd: workdir });
    const mintAfterSuccess = async (res: { content: unknown; details: unknown }) => {
        const out = await handleEditSuccessResult(
            { toolName: "edit", isError: false, content: (res as { content: unknown }).content, details: res.details },
            workdir,
            (paths: string[], hints?: unknown) =>
                (buildMutationEvidence as (s: typeof session, p: string[], h?: unknown) => ReturnType<typeof buildMutationEvidence>)(
                    session, paths, hints,
                ),
            store,
        );
        return out;
    };
    return { workdir, cf, store, session, runEdit, mintAfterSuccess };
}

test("narrow: in-range edit applies, then out-of-range edit still rejects (no widening)", async () => {
    const content = lines(20);
    const t = await setup({ "a.ts": content }, (cf) => [lineRangeResource(cf("a.ts"), { startLine: 5, endLine: 8 }, content)]);

    const edit1 = await t.runEdit("a.ts", [{ oldText: "const v6 = 6;", newText: "const v6 = 600;" }]);
    assert.equal((edit1.details as { status: { kind: string } }).status.kind, "applied", "in-range edit must apply");

    await t.mintAfterSuccess(edit1);

    const after = t.store.select(t.cf("a.ts"));
    assert.ok(after, "mint must record authority");
    assert.equal(after!.coverage, "line-range", "post-edit mint must NOT widen line-range to full-file");
    assert.equal(after!.fullFileSha256, sha256(readFileSync(t.cf("a.ts"), "utf8")), "fresh SHA must advance past the stale guard");

    const edit2 = await t.runEdit("a.ts", [{ oldText: "const v15 = 15;", newText: "const v15 = 1500;" }]);
    const d2 = edit2.details as unknown as { status: { kind: string; reason?: string } };
    assert.equal(d2.status.kind, "rejected", "out-of-range second edit must still reject");
    assert.equal(d2.status.reason, "coverage");
    assert.match(readFileSync(t.cf("a.ts"), "utf8"), /const v15 = 15;/, "file must be unchanged by rejected edit");
});

test("narrow: prior full-file stays full-file after edit", async () => {
    const content = lines(10);
    const t = await setup({ "a.ts": content }, (cf) => [fullFileResource(cf("a.ts"), content)]);

    const edit1 = await t.runEdit("a.ts", [{ oldText: "const v3 = 3;", newText: "const v3 = 300;" }]);
    assert.equal((edit1.details as { status: { kind: string } }).status.kind, "applied");
    await t.mintAfterSuccess(edit1);

    const after = t.store.select(t.cf("a.ts"));
    assert.ok(after);
    assert.equal(after!.coverage, "full-file", "prior full-file must stay full-file");

    const edit2 = await t.runEdit("a.ts", [{ oldText: "const v9 = 9;", newText: "const v9 = 900;" }]);
    assert.equal((edit2.details as { status: { kind: string } }).status.kind, "applied", "full-file authority still edits anywhere");
});

test("narrow: replaceAll multi-span keeps all changed spans, rejects elsewhere", async () => {
    const content = "foo one\nmid a\nfoo two\nmid b\ntail z\n";
    const t = await setup({ "a.ts": content }, (cf) => [lineRangeResource(cf("a.ts"), { startLine: 1, endLine: 3 }, content)]);

    const edit1 = await t.runEdit("a.ts", [{ oldText: "foo", newText: "FOO", replaceAll: true }]);
    assert.equal((edit1.details as { status: { kind: string } }).status.kind, "applied", "replaceAll spans inside authority must apply");
    await t.mintAfterSuccess(edit1);

    const after = t.store.select(t.cf("a.ts"));
    assert.ok(after);
    assert.equal(after!.coverage, "line-range");
    const txt = readFileSync(t.cf("a.ts"), "utf8");
    assert.match(txt, /FOO one/);
    assert.match(txt, /FOO two/);

    const edit2 = await t.runEdit("a.ts", [{ oldText: "tail z", newText: "tail Z" }]);
    const d2 = edit2.details as unknown as { status: { kind: string; reason?: string } };
    assert.equal(d2.status.kind, "rejected", "span outside every changed/prior range must reject");
    assert.equal(d2.status.reason, "coverage");
});

test("narrow: noop no-diff keeps prior authority untouched", async () => {
    const content = lines(10);
    const t = await setup({ "a.ts": content }, (cf) => [lineRangeResource(cf("a.ts"), { startLine: 2, endLine: 3 }, content)]);
    const before = t.store.select(t.cf("a.ts"));

    const out = await handleEditSuccessResult(
        { toolName: "edit", isError: false, content: [], details: { status: { kind: "applied" }, diffs: [] } },
        t.workdir,
        (paths: string[]) => buildMutationEvidence(t.session, paths),
        t.store,
    );
    assert.equal(out, undefined, "empty diffs must mint nothing");
    assert.deepEqual(t.store.select(t.cf("a.ts")), before, "prior authority must be untouched");
});

test("narrow: multi-file edits narrow each file independently", async () => {
    const a = lines(12);
    const b = lines(12);
    const t = await setup({ "a.ts": a, "b.ts": b }, (cf) => [
        lineRangeResource(cf("a.ts"), { startLine: 2, endLine: 4 }, a),
        lineRangeResource(cf("b.ts"), { startLine: 7, endLine: 9 }, b),
    ]);

    const edit1 = await t.runEdit("a.ts", [{ oldText: "const v3 = 3;", newText: "const v3 = 300;" }]);
    assert.equal((edit1.details as { status: { kind: string } }).status.kind, "applied");
    await t.mintAfterSuccess(edit1);

    const afterA = t.store.select(t.cf("a.ts"));
    assert.ok(afterA);
    assert.equal(afterA!.coverage, "line-range", "edited file must stay narrowed");

    // b.ts untouched by the edit: its prior authority must be intact.
    const afterB = t.store.select(t.cf("b.ts"));
    assert.ok(afterB);
    assert.deepEqual(afterB!.allowedRanges, [{ startLine: 7, endLine: 9 }], "unedited file keeps prior ranges");

    const editB = await t.runEdit("b.ts", [{ oldText: "const v8 = 8;", newText: "const v8 = 800;" }]);
    assert.equal((editB.details as { status: { kind: string } }).status.kind, "applied", "in-range edit on second file applies");
});

test("narrow-unit: insertion shifts later prior ranges forward and grants inserted lines", () => {
    const diff = "    ...\n  5 const v5 = 5;\n  6 const v6 = 6;\n+ 7 const extra = 1;\n+ 8 const extra2 = 2;\n  7 const v7 = 7;\n  8 const v8 = 8;\n    ...\n";
    const hint = parsePostEditDiff(diff);
    assert.deepEqual(hint.changedRanges, [{ startLine: 7, endLine: 8 }]);
    // Prior [10,12] sits after the 2-line insertion at old line 7 → shifts to [12,14].
    // Union with the model-visible inserted lines [7,8].
    assert.deepEqual(narrowPostEditRanges([{ startLine: 10, endLine: 12 }], hint, 22), [
        { startLine: 7, endLine: 8 },
        { startLine: 12, endLine: 14 },
    ]);
});

test("narrow-unit: pure deletion drops authority over deleted lines only", () => {
    const diff = "    ...\n  5 const v5 = 5;\n- 6 const v6 = 6;\n  7 const v7 = 7;\n    ...\n";
    const hint = parsePostEditDiff(diff);
    assert.deepEqual(hint.changedRanges, []);
    // Prior exactly on the deleted line collapses to nothing.
    assert.deepEqual(narrowPostEditRanges([{ startLine: 6, endLine: 6 }], hint, 19), []);
    // Prior spanning the deletion maps onto the junction, clamped to survivors.
    assert.deepEqual(narrowPostEditRanges([{ startLine: 5, endLine: 8 }], hint, 19), [
        { startLine: 5, endLine: 7 },
    ]);
});

test("narrow-unit: substitution keeps prior window on the changed lines", () => {
    const diff = "    ...\n  5 const v5 = 5;\n- 6 const v6 = 6;\n+ 6 const v6 = 600;\n  7 const v7 = 7;\n    ...\n";
    const hint = parsePostEditDiff(diff);
    assert.deepEqual(hint.changedRanges, [{ startLine: 6, endLine: 6 }]);
    assert.deepEqual(narrowPostEditRanges([{ startLine: 5, endLine: 8 }], hint, 20), [
        { startLine: 5, endLine: 8 },
    ]);
});
