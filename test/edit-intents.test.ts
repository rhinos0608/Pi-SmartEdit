import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRawEdit } from "../src/edit-intents.js";

describe("raw edit normalization", () => {
  it("normalizes JSON, forgiving JSON, and search/replace", () => {
    assert.equal(normalizeRawEdit('[{"oldText":"a","newText":"b"}]', "x.ts").intents[0].kind, "text");
    assert.equal(normalizeRawEdit('[{"oldText":"a","newText":"b",}]', "x.ts").intents.length, 1);
    assert.deepEqual(normalizeRawEdit("x.ts\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE").intents[0], { kind: "text", operation: { path: "x.ts", oldText: "a", newText: "b" } });
  });

  it("preserves per-file paths and parses update syntaxes", () => {
    const unified = normalizeRawEdit("--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b");
    assert.equal((unified.intents[0] as any).operation.path, "one.ts");
    const openai = normalizeRawEdit("*** Begin Patch\n*** Update File: two.ts\n@@\n-a\n+b\n*** End Patch");
    assert.equal((openai.intents[0] as any).operation.path, "two.ts");
    const codex = normalizeRawEdit("*** Begin Patch\n*** Update File: three.ts\n@@\n-a\n+b\n*** End Patch");
    assert.equal((codex.intents[0] as any).operation.path, "three.ts");
  });

  it("keeps Atomic topology lossless and reports malformed input", () => {
    const raw = "*** Begin Atomic Patch\n*** Add File: new.ts\n+hello\n*** Delete File: old.ts\n*** Rename File: old.ts -> moved.ts\n*** End Atomic Patch";
    const result = normalizeRawEdit(raw);
    assert.deepEqual(result.intents.map((i) => i.kind), ["add", "delete", "rename"]);
    const malformed = normalizeRawEdit("not json");
    assert.ok(malformed.diagnostics.length > 0);
  });

  it("adds a trailing newline to added-file content unless a no-newline marker is present", () => {
    // Normal added file: last added line carries the newline the diff implies.
    assert.deepEqual(
      normalizeRawEdit("--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new").intents,
      [{ kind: "add", path: "new.ts", content: "new\n" }],
    );
    // `\ No newline at end of file` marker → content keeps no trailing newline.
    assert.deepEqual(
      normalizeRawEdit("--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n\\ No newline at end of file").intents,
      [{ kind: "add", path: "new.ts", content: "new" }],
    );
  });

  it("preserves topology and operation ordering across patch dialects", () => {
    assert.deepEqual(
      normalizeRawEdit("*** Begin Patch\n*** Delete File: old.ts\n*** End Patch").intents,
      [{ kind: "delete", path: "old.ts" }],
    );
    assert.deepEqual(
      normalizeRawEdit("*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@ old\n-old\n+new\n*** End Patch").intents.map((intent) => intent.kind),
      ["text", "rename"],
    );
    assert.deepEqual(
      normalizeRawEdit("*** Begin Atomic Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-old\n+new\n*** End Atomic Patch").intents.map((intent) => intent.kind),
      ["text", "rename"],
    );
  });

  it("preserves bare empty hunk lines on both sides of a unified diff", () => {
    // A bare removed empty line (`-`) survives in oldText; a bare added empty
    // line (`+`) survives in newText, so both sides keep their blank line.
    const removed = normalizeRawEdit(
      "--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,2 @@\n a\n-\n b",
    ).intents[0];
    assert.equal(removed.kind, "text");
    assert.deepEqual((removed as { operation: { oldText: string; newText: string } }).operation, {
      path: "a.ts", oldText: "a\n\nb", newText: "a\nb",
    });
    const added = normalizeRawEdit(
      "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n a\n+\n b",
    ).intents[0];
    assert.deepEqual((added as { operation: { oldText: string; newText: string } }).operation, {
      path: "a.ts", oldText: "a\nb", newText: "a\n\nb",
    });
  });
});
