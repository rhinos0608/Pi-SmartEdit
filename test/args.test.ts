import { describe, test } from "node:test";
import assert from "node:assert";
import {
  prepareArguments,
  splitMultiFileEditInput,
} from "../src/args";

describe("prepareArguments", () => {
  test("infers top-level path from a single edit path", () => {
    const result = prepareArguments(
      {
        edits: [
          { path: "src/foo.ts", oldText: "old", newText: "new" },
        ],
      },
      false,
    );

    assert.strictEqual(result.path, "src/foo.ts");
    assert.deepStrictEqual(result.edits, [
      { path: "src/foo.ts", oldText: "old", newText: "new" },
    ]);
  });

  test("accepts duplicate top-level and edit paths when they match", () => {
    const result = prepareArguments(
      {
        path: "src/foo.ts",
        edits: [
          { path: "src/foo.ts", oldText: "old", newText: "new" },
        ],
      },
      false,
    );

    assert.strictEqual(result.path, "src/foo.ts");
  });

  test("infers path after parsing edits JSON string", () => {
    const result = prepareArguments(
      {
        edits: JSON.stringify([
          { path: "src/foo.ts", oldText: "old", newText: "new" },
        ]),
      },
      false,
    );

    assert.strictEqual(result.path, "src/foo.ts");
    assert.deepStrictEqual(result.edits, [
      { path: "src/foo.ts", oldText: "old", newText: "new" },
    ]);
  });

  test("keeps target and hashline metadata on edit objects", () => {
    const target = { name: "run", replaceBody: "function run() {}" };
    const hashline = {
      range: { pos: "1ab", end: "1ab" },
      content: ["updated"],
    };
    const result = prepareArguments({
      path: "src/foo.ts",
      edits: [
        { target },
        { hashline },
      ],
    }, true);

    assert.strictEqual(result.path, "src/foo.ts");
    assert.deepStrictEqual(result.edits, [{ target }, { hashline }]);
  });

  test("allows distinct edit paths for multi-file execution", () => {
    const input = {
      edits: [
        { path: "src/foo.ts", oldText: "old", newText: "new" },
        { path: "src/bar.ts", oldText: "before", newText: "after" },
        { path: "src/foo.ts", oldText: "x", newText: "y" },
      ],
    };

    const prepared = prepareArguments(input, false);
    const batches = splitMultiFileEditInput(prepared);

    assert.deepStrictEqual(batches, [
      {
        path: "src/foo.ts",
        edits: [
          { oldText: "old", newText: "new" },
          { oldText: "x", newText: "y" },
        ],
      },
      {
        path: "src/bar.ts",
        edits: [{ oldText: "before", newText: "after" }],
      },
    ]);
  });

  test("allows distinct paths from a JSON-string edits array", () => {
    const prepared = prepareArguments({
      edits: JSON.stringify([
        { path: "src/foo.ts", oldText: "old", newText: "new" },
        { path: "src/bar.ts", oldText: "before", newText: "after" },
      ]),
    }, false);

    assert.deepStrictEqual(splitMultiFileEditInput(prepared), [
      {
        path: "src/foo.ts",
        edits: [{ oldText: "old", newText: "new" }],
      },
      {
        path: "src/bar.ts",
        edits: [{ oldText: "before", newText: "after" }],
      },
    ]);
  });

  test("does not split single-file edit paths", () => {
    assert.strictEqual(splitMultiFileEditInput({
      edits: [
        { path: "src/foo.ts", oldText: "old", newText: "new" },
        { path: "src/foo.ts", oldText: "x", newText: "y" },
      ],
    }), null);
  });

  test("defers incomplete multi-file path validation to execution splitting", () => {
    const input = {
      edits: [
        { path: "src/foo.ts", oldText: "old", newText: "new" },
        { path: "src/bar.ts", oldText: "before", newText: "after" },
        { oldText: "x", newText: "y" },
      ],
    };

    const prepared = prepareArguments(input, false);
    assert.deepStrictEqual(prepared, input);
    assert.throws(
      () => splitMultiFileEditInput(prepared),
      /every edit must include path/,
    );
  });

  test("rejects conflict between top-level path and edit path", () => {
    assert.throws(
      () => prepareArguments(
        {
          path: "src/foo.ts",
          edits: [
            { path: "src/bar.ts", oldText: "old", newText: "new" },
          ],
        },
        false,
      ),
      /Top-level path conflicts/,
    );
  });

  test("normalizes legacy raw text formats without dropping their paths", () => {
    const prepared = prepareArguments({
      edits: "src/foo.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE",
    }, false);
    assert.deepStrictEqual(prepared.edits, [{ path: "src/foo.ts", oldText: "old", newText: "new" }]);
  });

  test("passes canonical raw patches through unchanged before path validation", () => {
    // A raw patch carries its path(s) inside the diff content, so a missing
    // top-level path is not an error at prepare time — validateEditRequest
    // and the patch adapter handle it.
    const raw = "--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b";
    assert.deepStrictEqual(prepareArguments({ raw }, false), { raw });
  });

  test("rejects legacy raw topology formats before filesystem access", () => {
    assert.throws(
      () => prepareArguments({
        edits: "*** Begin Atomic Patch\n*** Delete File: src/foo.ts\n*** End Atomic Patch",
      }, false),
      /requiring transaction support/i,
    );
  });
});
