import { describe, test } from "node:test";
import assert from "node:assert";
import { prepareArguments } from "../src/args";

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

  test("preserves top-level replaceAll for execute via side-channel", () => {
    const result = prepareArguments(
      {
        path: "src/foo.ts",
        replaceAll: true,
        edits: [
          { oldText: "old", newText: "new" },
          { oldText: "x", newText: "y" },
        ],
      },
      false,
    );

    assert.match(String(result.path), /^src\/foo\.ts\?\?smartEditExtra=/);
    const encoded = String(result.path).split("??smartEditExtra=")[1];
    const extraData = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    assert.deepStrictEqual(extraData.replaceAllFlags, [true, true]);
  });

  test("lets per-edit replaceAll override top-level replaceAll", () => {
    const result = prepareArguments(
      {
        path: "src/foo.ts",
        replaceAll: true,
        edits: [
          { oldText: "old", newText: "new", replaceAll: false },
          { oldText: "x", newText: "y" },
        ],
      },
      false,
    );

    const encoded = String(result.path).split("??smartEditExtra=")[1];
    const extraData = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    assert.deepStrictEqual(extraData.replaceAllFlags, [false, true]);
  });

  test("rejects conflicting edit paths", () => {
    assert.throws(
      () => prepareArguments(
        {
          edits: [
            { path: "src/foo.ts", oldText: "old", newText: "new" },
            { path: "src/bar.ts", oldText: "old", newText: "new" },
          ],
        },
        false,
      ),
      /edits must target one file/,
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
});
