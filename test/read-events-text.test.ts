import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleSingleReadResult } from "../src/extension/read-events.js";
import { getSnapshot } from "../src/context/read-cache.js";
import { fastHash } from "../src/core/types.js";

function textRows(lines: string[], start = 1): string {
    return lines.map((line, i) => `${start + i}|${line}`).join("\n");
}

test("full text-mode N| read records complete authority", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "smartedit-read-text-")));
    const path = join(root, "a.ts");
    const raw = "alpha\nbeta\ngamma";
    writeFileSync(path, raw, "utf8");
    const rendered = textRows(raw.split("\n"));

    const handled = await handleSingleReadResult({
        toolName: "read",
        isError: false,
        input: { path: "a.ts" },
        content: [{ type: "text", text: rendered }],
    }, root);
    assert.equal(handled, true);

    const snapshot = getSnapshot("a.ts", root);
    assert.ok(snapshot, "snapshot must exist after text-mode read");
    assert.equal(snapshot.partial, false);
    assert.equal(snapshot.contentHash, fastHash(raw));
});

test("offset/limit text-mode N| read records partial authority from the offset", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "smartedit-read-text-partial-")));
    const path = join(root, "a.ts");
    const raw = "one\ntwo\nthree\nfour\nfive";
    writeFileSync(path, raw, "utf8");
    const rendered = textRows(["three", "four"], 3);

    await handleSingleReadResult({
        toolName: "read",
        isError: false,
        input: { path: "a.ts", offset: 3, limit: 2 },
        content: [{ type: "text", text: rendered }],
    }, root);

    const snapshot = getSnapshot("a.ts", root);
    assert.ok(snapshot, "snapshot must exist after partial text-mode read");
    assert.equal(snapshot.partial, true);
    assert.equal(snapshot.contentHash, fastHash(raw));
});
