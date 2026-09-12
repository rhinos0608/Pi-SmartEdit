/**
 * Transfer regression suite (TDD red phase — every test below MUST fail
 * against the current implementation; green-phase work makes them pass).
 *
 * Oracle freeze notes (binding for this suite):
 * - Generic `applyHashlineEdits` global idempotence is UNCHANGED: literal
 *   duplicate inserts still suppress via `noopEdits`. Multiplicity
 *   preservation belongs to the transfer literal planner/applier layer
 *   (`applyTransferLiteral`), not to the generic hashline path.
 * - Caller-description/provenance combining belongs to the full-request
 *   transfer description helper (`buildTransferDescription`), not to the
 *   bare `buildTransferInsertEdit` builder string.
 * - Supplied-`after` on a new-file destination is a resolver/planner
 *   rejection (`planTransfer` with a new-file destination + `after`),
 *   not a 4th helper arg on `buildTransferInsertEdit`.
 *
 * Covers: CRLF/BOM source handling in resolveSourceRange, literal-duplicate
 * copy/move multiplicity vs hashline no-op suppression, transfer-to-start and
 * transfer-to-EOF sentinels in buildTransferInsertEdit, replaceAll mixed with
 * a transfer op, caller-description/provenance combining, supplied-after on a
 * new-file destination (must reject with a transfer-specific error), and
 * multiple transfers targeting the same newly-created destination.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

import {
    resolveSourceRange,
    buildTransferInsertEdit,
    buildTransferDeleteEdit,
    planTransfer,
} from "../src/transfer-edit.js";
import * as transferEdit from "../src/transfer-edit.js";
import { validateEditRequest } from "../src/edit-contract.js";
import { computeLineHashSync, initHashline } from "../src/core/hashline.js";
import { applyHashlineEdits } from "../src/core/hashline-edit.js";

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

function lineAnchor(lineNum: number, text: string): string {
    return `${lineNum}${computeLineHashSync(lineNum, text)}`;
}

function srcRange(): { pos: string; end: string } {
    const anchor = lineAnchor(1, "alpha");
    return { pos: anchor, end: anchor };
}

/** Pin a future transfer-layer entry point. Fails red while green-phase
 *  work has not exported it yet — the assertion message names the missing
 *  contract so the failure reason stays explicit. */
function transferEntry(name: string): (...args: unknown[]) => unknown {
    const fn = (transferEdit as unknown as Record<string, unknown>)[name];
    assert.equal(typeof fn, "function", `transfer literal layer missing: ${name} is not exported from transfer-edit.js`);
    return fn as (...args: unknown[]) => unknown;
}

test("transfer-regression: CRLF copy source resolves to LF lines", () => {
    const content = ["alpha", "beta", "gamma"].join("\r\n");
    const pos = lineAnchor(2, "beta");
    const end = lineAnchor(3, "gamma");
    const result = resolveSourceRange(content, pos, end);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.deepEqual(result.value.lines, ["beta", "gamma"]);
    }
});

test("transfer-regression: BOM copy source resolves without the BOM byte", () => {
    const content = "﻿alpha\nbeta";
    const { pos, end } = srcRange();
    const result = resolveSourceRange(content, pos, end);
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.deepEqual(result.value.lines, ["alpha"]);
    }
});

test("transfer-regression: literal duplicate copy preserves multiplicity (no no-op suppression)", () => {
    // Oracle freeze: generic hashline idempotence is unchanged — a literal
    // duplicate through the generic path still suppresses.
    const generic = applyHashlineEdits("top\ndup", [
        { op: "append_at", pos: { line: 1, hash: "|" }, lines: ["dup"] },
    ]);
    assert.notEqual(generic.noopEdits, undefined);
    // Multiplicity preservation belongs to the transfer literal applier.
    const applyTransferLiteral = transferEntry("applyTransferLiteral");
    const result = applyTransferLiteral("top\ndup", ["dup"]) as { lines: string; noopEdits?: unknown };
    assert.equal(result.noopEdits, undefined);
    assert.equal(result.lines, "top\ndup\ndup");
});

test("transfer-regression: literal duplicate move preserves multiplicity at dest and deletes source", () => {
    const { pos, end } = srcRange();
    const del = buildTransferDeleteEdit({ pos, end }, "move from a.ts:1ab-1ab");
    assert.equal(del.hashline?.content, null);
    // Oracle freeze: generic hashline idempotence is unchanged.
    const generic = applyHashlineEdits("head\ndup", [
        { op: "append_at", pos: { line: 1, hash: "|" }, lines: ["dup"] },
    ]);
    assert.notEqual(generic.noopEdits, undefined);
    // Complete move: the generated source deletion removes the source line.
    const source = "alpha\nbeta";
    const resolved = resolveSourceRange(source, pos, end);
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
        const applyTransferDeleteLiteral = transferEntry("applyTransferDeleteLiteral");
        const afterDelete = applyTransferDeleteLiteral(source, resolved.value.startLine, resolved.value.endLine) as { lines: string };
        assert.equal(afterDelete.lines, "beta");
    }
    // Destination multiplicity belongs to the transfer literal applier.
    const applyTransferLiteral = transferEntry("applyTransferLiteral");
    const result = applyTransferLiteral("head\ndup", ["dup"]) as { lines: string; noopEdits?: unknown };
    assert.equal(result.noopEdits, undefined);
    assert.equal(result.lines, "head\ndup\ndup");
});

test("transfer-regression: transfer-to-start sentinel builds a prepend_file range", () => {
    const item = buildTransferInsertEdit("start", ["one"], "copy from a.ts:1ab-1ab");
    assert.deepEqual(item.hashline?.range, { pos: "start", end: "start" });
});

test("transfer-regression: transfer-to-EOF sentinel builds an append_file range", () => {
    const item = buildTransferInsertEdit("EOF", ["one"], "copy from a.ts:1ab-1ab");
    assert.deepEqual(item.hashline?.range, { pos: "EOF", end: "EOF" });
});

test("transfer-regression: replaceAll mixed with a transfer op must reject", () => {
    const result = validateEditRequest({
        path: "b.ts",
        edits: [
            {
                op: "copy",
                from: "a.ts",
                to: "b.ts",
                range: { pos: "1ab", end: "1ab" },
                replaceAll: true,
            },
        ],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.match(result.error, /transfer|replaceAll|mutually exclusive/i);
    }
});

test("transfer-regression: caller description is combined with transfer provenance", () => {
    // Oracle freeze: combining lives in the full-request transfer description
    // helper, not in the bare builder string.
    const buildTransferDescription = transferEntry("buildTransferDescription");
    const anchor = lineAnchor(1, "alpha");
    const request = { op: "copy", from: "a.ts", range: { pos: anchor, end: anchor } };
    const generated = buildTransferDescription(request) as string;
    assert.match(generated, /copy from a\.ts/);
    const combined = buildTransferDescription({ ...request, description: "my reason" }) as string;
    assert.match(combined, /my reason/);
    assert.match(combined, /copy from a\.ts/);
});

test("transfer-regression: supplied after on a new-file destination must reject with a transfer-specific error", () => {
    // Oracle freeze: the resolver/planner rejects a new-file destination
    // coexisting with `after` — green phase owns this check, not a 4th
    // helper arg on buildTransferInsertEdit.
    const planTransfer = transferEntry("planTransfer");
    const anchor = lineAnchor(1, "alpha");
    assert.throws(
        () =>
            planTransfer({
                op: "copy",
                from: "a.ts",
                range: { pos: anchor, end: anchor },
                to: "new-file.ts",
                after: "10ab",
                toIsNewFile: true,
            }),
        /transfer.*after/i,
    );
});

test("transfer-regression: copy-after-self (adjacent) is not a planning conflict — touching-span gate is move-only", () => {
    // P1-2: patch.ts same-file touching-span rejection applies to move only,
    // so a copy whose after anchor lands inside its own source span must pass
    // planning. Helpers own no span gate: plan + resolve + insert all succeed.
    const lines = ["aaa", "bbb", "ccc"];
    const content = lines.join("\n");
    const pos = lineAnchor(1, "aaa");
    const end = lineAnchor(2, "bbb");
    const after = lineAnchor(1, "aaa");
    const plan = planTransfer({ op: "copy", from: "f.ts", range: { pos, end }, to: "f.ts", after, toIsNewFile: false });
    assert.equal(plan.op, "copy");
    const resolved = resolveSourceRange(content, pos, end);
    assert.equal(resolved.ok, true);
    const item = buildTransferInsertEdit(after, ["aaa", "bbb"], "copy from f.ts");
    assert.match(String(item.hashline?.range.pos), /:after$/);
});

test("transfer-regression: multiple transfers to the same new destination both land in order", () => {
    const first = buildTransferInsertEdit(undefined, ["shared"], "copy from a.ts:1ab-1ab");
    const second = buildTransferInsertEdit(undefined, ["shared"], "copy from a.ts:1ab-1ab");
    assert.deepEqual(first.hashline?.range, { pos: "EOF", end: "EOF" });
    assert.deepEqual(second.hashline?.range, { pos: "EOF", end: "EOF" });
    // Oracle freeze: generic hashline idempotence is unchanged — duplicate
    // append_file still suppresses through the generic path.
    const generic = applyHashlineEdits("", [
        { op: "append_file", lines: ["shared"] },
        { op: "append_file", lines: ["shared"] },
    ]);
    assert.notEqual(generic.noopEdits, undefined);
    // Ordered multi-transfer landing belongs to the transfer literal applier:
    // each transfer applies to the destination state left by the previous one.
    const applyTransferLiteral = transferEntry("applyTransferLiteral");
    const firstLanding = applyTransferLiteral("", ["shared"]) as { lines: string; noopEdits?: unknown };
    assert.equal(firstLanding.noopEdits, undefined);
    const secondLanding = applyTransferLiteral(firstLanding.lines, ["shared"]) as { lines: string; noopEdits?: unknown };
    assert.equal(secondLanding.noopEdits, undefined);
    assert.equal(secondLanding.lines, "shared\nshared");
});
