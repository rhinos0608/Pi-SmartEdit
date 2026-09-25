import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHashlineAnchors,
  initHashline,
} from "../src/hashline/hashline.js";
import {
  handleSingleReadResult,
  parseDisplayedHashlineRows,
} from "../src/extension/read-events.js";
import { getSnapshot } from "../src/context/read-cache.js";
import { planTextEdits } from "../src/core/edit-planner.js";
import { fastHash } from "../src/core/types.js";

function pine(path: string, formattedLines: string[]): string {
  return [
    `@${path}`,
    "<<'PINE_TEST'",
    ...formattedLines,
    "PINE_TEST",
  ].join("\n");
}

test("parseDisplayedHashlineRows ignores SmartRead envelope text", async () => {
  await initHashline();
  const raw = "alpha\nbeta\ngamma\n";
  const built = await buildHashlineAnchors(raw.split("\n"));
  const rendered = pine("/tmp/a.ts", built.formattedLines);

  const parsed = parseDisplayedHashlineRows(rendered, raw);
  assert.ok(parsed);
  assert.deepEqual(
    [...parsed.hashline.anchors.keys()],
    [...built.anchors.keys()],
  );
  assert.deepEqual(parsed.hashline.formattedLines, built.formattedLines);
  assert.equal(parsed.lineNumbers.length, raw.split("\n").length);
});

test("single read caches exact displayed anchors and raw bytes", async () => {
  await initHashline();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smartedit-read-hashline-")));
  const path = join(root, "a.ts");
  const raw = [
    "export function formatUserName(name: string): string {",
    "  return name.toLowerCase();",
    "}",
    "",
    "export function formatProjectName(name: string): string {",
    "  return name.toLowerCase();",
    "}",
    "",
  ].join("\n");
  writeFileSync(path, raw, "utf8");
  const built = await buildHashlineAnchors(raw.split("\n"));
  const rendered = pine(path, built.formattedLines);

  const handled = await handleSingleReadResult({
    toolName: "read",
    isError: false,
    input: { path: "a.ts" },
    content: [{ type: "text", text: rendered }],
  }, root);
  assert.equal(handled, true);

  const snapshot = getSnapshot("a.ts", root);
  assert.ok(snapshot?.hashline);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.contentHash, fastHash(raw));
  assert.deepEqual(
    [...snapshot.hashline.anchors.keys()],
    [...built.anchors.keys()],
  );

  const target = built.formattedLines[5]!.split("|", 1)[0]!;
  const planned = await planTextEdits({
    content: raw,
    edits: [{
      hashline: {
        range: { pos: target, end: target },
        content: ["  return name.toUpperCase();"],
      },
    }],
    filePath: path,
    astResolver: null,
    getSnapshot: () => snapshot,
  });
  assert.equal(
    planned.newContent,
    raw.replace(
      "export function formatProjectName(name: string): string {\n  return name.toLowerCase();",
      "export function formatProjectName(name: string): string {\n  return name.toUpperCase();",
    ),
  );
});

test("partial read provenance contains only displayed hashline rows", async () => {
  await initHashline();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smartedit-read-partial-")));
  const path = join(root, "a.ts");
  const raw = "one\ntwo\nthree\nfour\nfive";
  writeFileSync(path, raw, "utf8");

  const full = await buildHashlineAnchors(raw.split("\n"));
  const visible = await buildHashlineAnchors(["three", "four"], 3);
  const rendered = pine(path, visible.formattedLines);

  await handleSingleReadResult({
    toolName: "read",
    isError: false,
    input: { path: "a.ts", offset: 3, limit: 2 },
    content: [{ type: "text", text: rendered }],
  }, root);

  const snapshot = getSnapshot("a.ts", root);
  assert.ok(snapshot?.hashline);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.contentHash, fastHash(raw));
  assert.deepEqual(
    [...snapshot.hashline.anchors.keys()],
    [...visible.anchors.keys()],
  );

  const unseen = full.formattedLines[0]!.split("|", 1)[0]!;
  assert.equal(snapshot.hashline.anchors.has(unseen), false);
});
