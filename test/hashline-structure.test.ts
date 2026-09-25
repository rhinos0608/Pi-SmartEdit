import test from "node:test";
import assert from "node:assert/strict";

import { buildHashlineAnchors, computeLineHashSync, initHashline } from "../src/hashline/hashline.js";
import { verifyHashlineStructuralRecovery } from "../src/hashline/hashline-structure.js";
import type { AstResolverLike } from "../src/anchor/anchor-resolution.js";
import type { FileSnapshot, SymbolRef } from "../src/core/types.js";
import type { HashlineEditOp } from "../src/hashline/hashline-anchor.js";

type FakeTree = { content: string };

function fakeResolver(): AstResolverLike {
  return {
    async parseFile(content) {
      return {
        parser: { delete() {} },
        tree: { content } as never,
        language: ".ts",
        hasErrors: false,
        content,
      } as never;
    },
    findSymbolNode() { return null; },
    findEnclosingSymbols(tree, startByte): SymbolRef[] {
      const content = (tree as unknown as FakeTree).content;
      const alphaStart = Buffer.byteLength(content.slice(0, content.indexOf("function alpha")), "utf8");
      const betaIndex = content.indexOf("function beta");
      const betaStart = betaIndex < 0 ? Number.POSITIVE_INFINITY : Buffer.byteLength(content.slice(0, betaIndex), "utf8");
      const name = startByte >= betaStart ? "beta" : startByte >= alphaStart ? "alpha" : "";
      return name ? [{
        name,
        kind: "function_declaration",
        lineStart: 1,
        lineEnd: 4,
        startByte: name === "alpha" ? alphaStart : betaStart,
        endByte: content.length,
      }] : [];
    },
    disposeParseResult() {},
  };
}

async function snapshotFor(content: string): Promise<FileSnapshot> {
  return {
    path: "/tmp/structural-recovery.ts",
    mtimeMs: 1,
    size: Buffer.byteLength(content),
    contentHash: "snapshot",
    readAt: 1,
    readOffset: 1,
    partial: false,
    hashline: await buildHashlineAnchors(content.split("\n")),
  };
}

function replaceLine(line: number, text: string): HashlineEditOp {
  const hash = computeLineHashSync(line, text);
  return {
    op: "replace_range",
    pos: { line, hash },
    end: { line, hash },
    lines: ["  return 9;"],
  };
}

test("structural recovery accepts a line shift inside the same enclosing symbol", async () => {
  await initHashline();
  const source = [
    "function alpha() {",
    "  const marker = 1;",
    "  const after = 2;",
    "}",
    "",
    "function beta() {",
    "  const marker = 1;",
    "  const after = 2;",
    "}",
  ].join("\n");
  const snapshot = await snapshotFor(source);
  const current = "// inserted\n" + source;
  const result = await verifyHashlineStructuralRecovery({
    original: replaceLine(2, "  const marker = 1;"),
    recovered: replaceLine(3, "  const marker = 1;"),
    currentContent: current,
    snapshot,
    filePath: snapshot.path,
    astResolver: fakeResolver(),
  });
  assert.equal(result.checked, true);
  assert.equal(result.ok, true);
  if (result.checked && result.ok) assert.match(result.fingerprint, /alpha/);
});

test("structural recovery rejects identical-looking text under a different symbol", async () => {
  await initHashline();
  const source = [
    "function alpha() {",
    "  const marker = 1;",
    "  const after = 2;",
    "}",
    "",
    "function beta() {",
    "  const marker = 1;",
    "  const after = 2;",
    "}",
  ].join("\n");
  const snapshot = await snapshotFor(source);
  const result = await verifyHashlineStructuralRecovery({
    original: replaceLine(2, "  const marker = 1;"),
    recovered: replaceLine(7, "  const marker = 1;"),
    currentContent: source,
    snapshot,
    filePath: snapshot.path,
    astResolver: fakeResolver(),
  });
  assert.equal(result.checked, true);
  assert.equal(result.ok, false);
  if (result.checked && !result.ok) {
    assert.match(result.sourceFingerprint, /alpha/);
    assert.match(result.currentFingerprint, /beta/);
  }
});
