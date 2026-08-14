/**
 * Renderer tests for the `edit` tool call display.
 *
 * getEditDisplayPaths / renderEditCall previously fell back to "missing path"
 * for raw patch calls (args.raw present, args.path and args.edits absent)
 * because the renderer only ever looked at top-level `path` and `edits`
 * fields. A valid raw unified-diff (or other supported raw format) call can
 * legitimately omit both — the path(s) live inside the raw diff content
 * itself. These tests confirm the renderer now extracts real path(s) from
 * `args.raw` instead of showing "missing path".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@mariozechner/pi-coding-agent";

import { getEditDisplayPaths, renderEditCall } from "../src/index.js";

// Minimal Theme stub: renderEditCall only calls .fg(color, text) and
// .bold(text), both of which are pure string formatters here.
const stubTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function renderedText(args: unknown): string {
  const component = renderEditCall(args, stubTheme);
  return component.render(200).join("\n");
}

test("getEditDisplayPaths: edits array still resolves paths as before", () => {
  assert.deepEqual(
    getEditDisplayPaths({ path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }),
    ["a.ts"],
  );
});

test("getEditDisplayPaths: raw unified diff yields the path from diff headers", () => {
  const raw = "--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b";
  assert.deepEqual(getEditDisplayPaths({ raw }), ["one.ts"]);
});

test("getEditDisplayPaths: raw call with no edits/path/raw content still yields nothing", () => {
  assert.deepEqual(getEditDisplayPaths({}), []);
});

test("getEditDisplayPaths: raw multi-file unified diff yields all touched paths", () => {
  const raw = [
    "--- a/one.ts",
    "+++ b/one.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "--- a/two.ts",
    "+++ b/two.ts",
    "@@ -1 +1 @@",
    "-c",
    "+d",
  ].join("\n");
  const paths = getEditDisplayPaths({ raw });
  assert.deepEqual([...paths].sort(), ["one.ts", "two.ts"]);
});

test("renderEditCall: raw diff call renders the real path, not 'missing path'", () => {
  const raw = "--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b";
  const text = renderedText({ raw });
  assert.ok(text.includes("one.ts"), `expected rendered call to include "one.ts", got: ${text}`);
  assert.ok(!text.includes("missing path"), `rendered call should not fall back to "missing path", got: ${text}`);
});

test("renderEditCall: still falls back to 'missing path' when raw content can't be parsed into any path", () => {
  const text = renderedText({ raw: "not a recognizable patch format at all" });
  assert.ok(text.includes("missing path"), `expected fallback for unparsable raw content, got: ${text}`);
});
