/** smartread-bridge reader-mirror guards. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { recordBreakage, recordCoChange, appendEvent } from "../src/context/smartread-bridge.js";

function makeRoot(): string {
    return mkdtempSync(join(tmpdir(), "bridge-"));
}

function readLines(root: string): string[] {
    const p = join(root, ".pi-smartread/graph-mutations.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

test("drops out-of-root paths", () => {
    const root = makeRoot();
    const err = recordBreakage(root, "../../etc/passwd", "src/a.ts");
    assert.notEqual(err, null);
    assert.deepEqual(readLines(root), []);
});

test("drops absolute out-of-root paths", () => {
    const root = makeRoot();
    const err = recordCoChange(root, "src/a.ts", "/etc/passwd");
    assert.notEqual(err, null);
    assert.deepEqual(readLines(root), []);
});

test("truncates context to 500 chars", () => {
    const root = makeRoot();
    const err = recordBreakage(root, "src/a.ts", "src/b.ts", "x".repeat(600));
    assert.equal(err, null);
    const lines = readLines(root);
    assert.equal(lines.length, 1);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.data.context.length, 500);
});

test("rejects out-of-range confidence", () => {
    const root = makeRoot();
    assert.notEqual(recordBreakage(root, "src/a.ts", "src/b.ts", "ctx", 2), null);
    assert.notEqual(recordBreakage(root, "src/a.ts", "src/b.ts", "ctx", -0.5), null);
    assert.deepEqual(readLines(root), []);
});

test("accepts boundary confidence 0 and 1", () => {
    const root = makeRoot();
    assert.equal(recordBreakage(root, "src/a.ts", "src/b.ts", "ctx", 0), null);
    assert.equal(recordBreakage(root, "src/a.ts", "src/b.ts", "ctx", 1), null);
    assert.equal(readLines(root).length, 2);
});

test("drops negative and far-future timestamps", () => {
    const root = makeRoot();
    const neg = appendEvent(root, {
        type: "breakage",
        data: { from: "src/a.ts", to: "src/b.ts" },
        timestamp: -1,
    });
    assert.notEqual(neg, null);
    const future = appendEvent(root, {
        type: "co_change",
        data: { from: "src/a.ts", to: "src/b.ts" },
        timestamp: Date.now() + 86400001,
    });
    assert.notEqual(future, null);
    assert.deepEqual(readLines(root), []);
});

test("accepts boundary timestamps 0 and now+86400000", () => {
    const root = makeRoot();
    const now = Date.now();
    assert.equal(appendEvent(root, { type: "breakage", data: { from: "src/a.ts", to: "src/b.ts" }, timestamp: 0 }), null);
    assert.equal(appendEvent(root, { type: "co_change", data: { from: "src/a.ts", to: "src/b.ts" }, timestamp: now + 86400000 }), null);
    assert.equal(readLines(root).length, 2);
});

test("rejects unknown source", () => {
    const root = makeRoot();
    const err = appendEvent(root, {
        type: "breakage",
        data: { from: "src/a.ts", to: "src/b.ts", source: "bogus" as never },
        timestamp: Date.now(),
    });
    assert.notEqual(err, null);
    assert.deepEqual(readLines(root), []);
});
