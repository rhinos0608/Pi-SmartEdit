/**
 * Admission-contract caps: oversized requests fail fast in the validator,
 * before locks/snapshots/hashing, with a reduction hint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    validateEditRequest,
    MAX_EDIT_ITEMS,
    MAX_FILES_TOUCHED,
    MAX_REQUEST_STRING_BYTES,
    MAX_REQUEST_TEXT_BYTES,
} from "../src/edit-contract.js";
import {
    validateTransferBatch,
    MAX_TRANSFER_ITEMS,
    MAX_TRANSFER_STRING_BYTES,
    MAX_TRANSFER_TEXT_BYTES,
} from "../src/transfer/tool.js";
import { truncateDiffText, MAX_RESULT_DIFF_BYTES, finalizeAppliedPatch } from "../src/mutation/final-result.js";
import { checkPlannedPreviewCaps } from "../src/patch/refactor-preview.js";

test("over-limit edits array rejected with reduction hint", () => {
    const edits = Array.from({ length: MAX_EDIT_ITEMS + 1 }, (_, i) => ({
        path: "/tmp/a.txt",
        oldText: `old${i}`,
        newText: `new${i}`,
    }));
    const r = validateEditRequest({ path: "/tmp/a.txt", edits });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /split the request into smaller batches/);
});

test("oversize raw rejected with reduction hint", () => {
    const r = validateEditRequest({ raw: "x".repeat(MAX_REQUEST_STRING_BYTES + 1) });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /split the patch into smaller raw requests/);
});

test("oversize single newText rejected with reduction hint", () => {
    const r = validateEditRequest({
        path: "/tmp/a.txt",
        edits: [{ oldText: "a", newText: "y".repeat(MAX_REQUEST_STRING_BYTES + 1) }],
    });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /split the edit into smaller items/);
});

test("transfer fan-out over limit rejected", () => {
    const transfers = Array.from({ length: MAX_TRANSFER_ITEMS + 1 }, (_, i) => ({
        op: "copy",
        from: `/tmp/f${i}.txt`,
        range: { pos: "h1", end: "h2" },
        to: "/tmp/out.txt",
    }));
    const r = validateTransferBatch({ transfers });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /split the request into smaller batches/);
});

test("diff over byte cap truncated with hint", () => {
    const big = "d".repeat(MAX_RESULT_DIFF_BYTES + 100);
    const out = truncateDiffText(big);
    assert.ok(Buffer.byteLength(out, "utf8") <= MAX_RESULT_DIFF_BYTES + 256);
    assert.match(out, /diff truncated/);
    assert.equal(truncateDiffText("small"), "small");
});

test("total 4MiB body cap trips across many small items", () => {
    const chunk = "z".repeat(100 * 1024); // 100KiB per item x 50 = ~5MiB
    const edits = Array.from({ length: 50 }, (_, i) => ({
        path: "/tmp/a.txt",
        oldText: `old${i}`,
        newText: chunk,
    }));
    const r = validateEditRequest({ path: "/tmp/a.txt", edits });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /over .* bytes total/);
});

test("file-count cap trips past 50 distinct files", () => {
    const edits = Array.from({ length: MAX_FILES_TOUCHED + 1 }, (_, i) => ({
        path: `/tmp/f${i}.txt`,
        oldText: "a",
        newText: "b",
    }));
    const r = validateEditRequest({ edits });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /files \(max/);
});

test("CJK/emoji bytes counted as UTF-8, not chars", () => {
    // "\u{1F600}" is 4 bytes in UTF-8; 300k chars = 1.2MiB > 1MiB cap.
    const r = validateEditRequest({
        path: "/tmp/a.txt",
        edits: [{ oldText: "a", newText: "\u{1F600}".repeat(300 * 1024) }],
    });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /bytes/);
});

test("omitted-field bypass closed: 1MiB description rejected", () => {
    const r = validateEditRequest({
        path: "/tmp/a.txt",
        edits: [{ oldText: "a", newText: "b", description: "d".repeat(MAX_REQUEST_STRING_BYTES + 1) }],
    });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /description/);
});

test("raw fan-out: 60 hunks across 51 files rejected", () => {
    let raw = "";
    for (let i = 0; i < 51; i++) {
        raw += `--- a/f${i}.txt\n+++ b/f${i}.txt\n@@ -1 +1 @@\n-old\n+new\n`;
    }
    const r = validateEditRequest({ raw });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /raw (expands|touches)|touches \d+ files/);
});

test("refactor bypass closed: oversized newName rejected", () => {
    const r = validateEditRequest({
        refactor: {
            kind: "rename-preview",
            path: "/tmp/a.ts",
            line: 1,
            character: 1,
            newName: "n".repeat(MAX_REQUEST_STRING_BYTES + 1),
        },
    });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /newName/);
});

test("staged preview caps: oversized planned output rejected", () => {
    const err = checkPlannedPreviewCaps({
        stagedFiles: [{ filePath: "/tmp/a.ts", newContent: "x".repeat(MAX_REQUEST_TEXT_BYTES + 1) }],
        diffString: "d",
    });
    assert.match(err ?? "", /over .* bytes total/);
    const many = Array.from({ length: 51 }, (_, i) => ({ filePath: `/tmp/f${i}.ts`, newContent: "x" }));
    assert.match(checkPlannedPreviewCaps({ stagedFiles: many, diffString: "d" }) ?? "", /files \(max/);
});

test("transfer byte caps: oversized description rejected", () => {
    const r = validateTransferBatch({
        transfers: [{
            op: "copy",
            from: "/tmp/a.txt",
            range: { pos: "h1", end: "h2" },
            to: "/tmp/b.txt",
            description: "d".repeat(MAX_TRANSFER_STRING_BYTES + 1),
        }],
    });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /bytes/);
});

test("raw JSON array of 101 edits rejected at admission", () => {
    const items = Array.from({ length: MAX_EDIT_ITEMS + 1 }, (_, i) => ({
        path: `/tmp/f${i}.txt`, oldText: `old${i}`, newText: `new${i}`,
    }));
    const res = validateEditRequest({ raw: JSON.stringify(items), toolCallId: "t-json-fanout" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /expands to 101 operations/);
});

test("raw Codex patch with 51 Add File hunks rejected at admission", () => {
    const parts = ["*** Begin Patch"];
    for (let i = 0; i < MAX_FILES_TOUCHED + 1; i++) parts.push(`*** Add File: f${i}.txt\ncontent ${i}`);
    parts.push("*** End Patch");
    const res = validateEditRequest({ raw: parts.join("\n"), toolCallId: "t-codex-fanout" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /touches 51 files/);
});

test("raw atomic patch with 51 adds rejected at admission", () => {
    const parts = ["*** Begin Atomic Patch"];
    for (let i = 0; i < MAX_FILES_TOUCHED + 1; i++) parts.push(`*** Add File: g${i}.txt\ncontent ${i}`);
    parts.push("*** End Atomic Patch");
    const res = validateEditRequest({ raw: parts.join("\n"), toolCallId: "t-atomic-fanout" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /touches 51 files/);
});

test("raw search/replace blocks over item cap rejected at admission", () => {
    const blocks = Array.from({ length: MAX_EDIT_ITEMS + 1 }, (_, i) =>
        `<<<<<<< SEARCH\nold${i}\n=======\nnew${i}\n>>>>>>> REPLACE`).join("\n");
    const res = validateEditRequest({ raw: blocks, path: "/tmp/sr.txt", toolCallId: "t-sr-fanout" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /expands to 101 operations/);
});

test("code-action-preview with 5MiB serialized diagnostics rejected at admission", () => {
    const big = "x".repeat(5 * 1024 * 1024);
    const res = validateEditRequest({
        toolCallId: "t-diag",
        refactor: { kind: "code-action-preview", path: "/tmp/a.ts", line: 1, character: 1, diagnostics: [{ message: big }] },
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /diagnostics/);
});

test("transfer batch touching 51 files rejected", () => {
    const transfers = Array.from({ length: 51 }, (_, i) => ({
        op: "copy", from: `/tmp/src${i}.txt`,
        range: { pos: "h1", end: "h2" }, to: "/tmp/shared-dest.txt",
    }));
    const res = validateTransferBatch({ transfers });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /touches 52 files/);
});

test("finalizeAppliedPatch truncates single-entry details.diffs[0].diff", async () => {
    const big = "y".repeat(MAX_RESULT_DIFF_BYTES + 100_000);
    const state = {
        checks: { blocking: [], completed: [], advisory: [], skipped: [], timedOut: [] },
        diagnostics: [], usedEvidence: [], invalidations: [],
        postEditEvidenceByPath: new Map(), repairsByPath: new Map(),
        finalizedFiles: [], appliedFiles: ["a.txt"], appliedCanonical: ["/tmp/a.txt"],
        appliedSummaries: ["1 edit"], displayDiffs: [{ path: "a.txt", diff: big }],
    };
    const res = await finalizeAppliedPatch({
        deps: {} as never, ctx: { cwd: "/tmp" }, toolCallId: "t-final",
        state: state as never, autoInspected: false,
        evidenceRefForDetails: { inspectionId: "", resourceIds: [] },
        tool: "edit", rollbackInfo: undefined,
    });
    assert.ok(res.details?.diffs?.length === 1);
    assert.match(res.details!.diffs![0].diff, /diff truncated/);
    assert.ok(Buffer.byteLength(res.details!.diffs![0].diff, "utf8") < Buffer.byteLength(big, "utf8"));
});

test("transfer total-bytes cap trips", () => {
    const chunk = "z".repeat(100 * 1024);
    const transfers = Array.from({ length: 50 }, (_, i) => ({
        op: "copy",
        from: `/tmp/f${i}.txt`,
        range: { pos: "h1", end: "h2" },
        to: "/tmp/out.txt",
        description: chunk,
    }));
    void MAX_TRANSFER_TEXT_BYTES;
    const r = validateTransferBatch({ transfers });
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /over .* bytes total/);
});
