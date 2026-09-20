import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransferTool, validateTransferBatch } from "../src/transfer/tool.js";

function stubDeps(): never {
    return {
        getRpcClient: () => { throw new Error("must not be called"); },
        getSessionFilePath: () => "/session.md",
        getCanonicalWorkspaceRoot: () => "/repo",
    } as never;
}

test("validateTransferBatch accepts a copy batch", () => {
    const v = validateTransferBatch({
        transfers: [{ op: "copy", from: "a.ts", range: { pos: "h1", end: "h2" }, to: "b.ts", after: "start" }],
    });
    assert.ok(v.ok);
    if (v.ok) assert.equal(v.value.transfers[0].op, "copy");
});

test("validateTransferBatch rejects empty transfers", () => {
    const v = validateTransferBatch({ transfers: [] });
    assert.ok(!v.ok);
});

test("validateTransferBatch rejects unknown keys and bad ops", () => {
    assert.ok(!validateTransferBatch({ transfers: [{ op: "move", from: "a", range: { pos: "x", end: "y" }, to: "b", path: "c" }] }).ok);
    assert.ok(!validateTransferBatch({ bogus: 1 }).ok);
});

test("transfer execute rejects invalid shape without touching deps", async () => {
    const tool = createTransferTool(stubDeps());
    assert.equal(tool.name, "transfer");
    const result = await tool.execute("t1", { transfers: [] }, undefined, undefined, { cwd: "/repo" });
    assert.match(result.content[0].text, /invalid transfer request/);
});

test("transfer terminal coverage reject carries transfer identity", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "xfer-tool-")));
    writeFileSync(join(workdir, "a.ts"), "one\ntwo\n", "utf8");
    writeFileSync(join(workdir, "b.ts"), "uno\ndos\n", "utf8");
    const deps = {
        getRpcClient: () => { throw new Error("must not be called"); },
        getSessionFilePath: () => "/sessions/xfer-tool.jsonl",
        getCanonicalWorkspaceRoot: () => workdir,
    } as never;
    const tool = createTransferTool(deps);
    const res = await tool.execute("t-reject", {
        transfers: [{ op: "copy", from: "a.ts", range: { pos: "x", end: "x" }, to: "b.ts", after: "start" }],
    }, undefined, undefined, { cwd: workdir });
    const d = res.details as unknown as { status: { kind: string }; tool: string };
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.tool, "transfer");
});
