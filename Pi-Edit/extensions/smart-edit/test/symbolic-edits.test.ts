import { describe, it, before } from "node:test";
import assert from "node:assert";
import { createAstResolver, clearParseCache } from "../lib/ast-resolver.js";
import { applySymbolicEdits, buildSymbolicEditGuidance, resolveSymbolicEditLineRange, isSymbolicEdit } from "../src/symbolic-edits.js";

describe("symbolic edits", () => {
  before(() => {
    // Clear parse cache to ensure fresh parses between tests
    clearParseCache();
  });
  it("replaces a named symbol definition", async () => {
    const content = "function keep() { return 1; }\nfunction target() { return 1; }\n";
    const result = await applySymbolicEdits({
      content,
      filePath: "example.ts",
      astResolver: createAstResolver(),
      edits: [{
        editIdx: 0,
        symbol: { name: "target" },
        replaceBody: "function target() { return 2; }",
      }],
    });

    assert.strictEqual(result.newContent, "function keep() { return 1; }\nfunction target() { return 2; }\n");
    assert.strictEqual(result.matchSpans.length, 1);
    assert.strictEqual(result.applied[0].operation, "replaceBody");
  });

  it("inserts before and after a symbol without shifting later targets", async () => {
    const content = "function alpha() { return 1; }\nfunction beta() { return 2; }\n";
    const result = await applySymbolicEdits({
      content,
      filePath: "example.ts",
      astResolver: createAstResolver(),
      edits: [
        { editIdx: 0, symbol: { name: "alpha" }, insertBefore: "const before = true;\n" },
        { editIdx: 1, symbol: { name: "beta" }, insertAfter: "\nconst after = true;" },
      ],
    });

    assert.strictEqual(
      result.newContent,
      "const before = true;\nfunction alpha() { return 1; }\nfunction beta() { return 2; }\nconst after = true;\n",
    );
  });

  it("resolves line range for read coverage checks", async () => {
    const content = "function keep() { return 1; }\nfunction target() {\n  return 1;\n}\n";
    const range = await resolveSymbolicEditLineRange({
      content,
      filePath: "example.ts",
      astResolver: createAstResolver(),
      edit: { symbol: { name: "target" }, replaceBody: "function target() { return 2; }" },
    });

    assert.deepStrictEqual(range, [2, 4]);
  });

  it("warns when text edits cover most of a symbol", async () => {
    const content = "function keep() { return 1; }\nfunction target() { return 1; }\n";
    const startIndex = content.indexOf("function target");
    const endIndex = content.indexOf("\n", startIndex);
    const notes = await buildSymbolicEditGuidance({
      content,
      filePath: "example.ts",
      astResolver: createAstResolver(),
      spans: [{ startIndex, endIndex }],
      threshold: 0.8,
    });

    assert.strictEqual(notes.length, 1);
    assert.match(notes[0], /Symbol edit preferred/);
    assert.match(notes[0], /target/);
  });

  it("isSymbolicEdit rejects symbol with no name or namePath", () => {
    assert.strictEqual(isSymbolicEdit({ symbol: {} as any }), false);
    assert.strictEqual(isSymbolicEdit({ symbol: { name: 123 } as any }), false);
    assert.strictEqual(isSymbolicEdit({ symbol: { name: "foo" } as any }), true);
    assert.strictEqual(isSymbolicEdit({ symbol: { namePath: ["a", "b"] } as any }), true);
    assert.strictEqual(isSymbolicEdit({ symbol: { namePath: [] } as any }), false);
    assert.strictEqual(isSymbolicEdit({ symbol: { namePath: ["a", 123] } as any }), false);
  });

  it("applySymbolicEdits throws when both name and namePath are absent", async () => {
    await assert.rejects(
      applySymbolicEdits({
        content: "function target() { return 1; }\n",
        filePath: "example.ts",
        astResolver: createAstResolver(),
        edits: [{ editIdx: 0, symbol: {} as any, replaceBody: "function target() { return 2; }" }],
      }),
      /symbol\.name or symbol\.namePath/,
    );
  });

  it("applySymbolicEdits throws when multiple operations are provided", async () => {
    await assert.rejects(
      applySymbolicEdits({
        content: "function target() { return 1; }\n",
        filePath: "example.ts",
        astResolver: createAstResolver(),
        edits: [{
          editIdx: 0,
          symbol: { name: "target" },
          replaceBody: "function target() { return 2; }",
          insertBefore: "// before",
        }],
      }),
      /exactly one of replaceBody, insertBefore, or insertAfter/,
    );
  });

  it("applySymbolicEdits throws when astResolver is null", async () => {
    await assert.rejects(
      applySymbolicEdits({
        content: "function target() { return 1; }\n",
        filePath: "example.ts",
        astResolver: null,
        edits: [{ editIdx: 0, symbol: { name: "target" }, replaceBody: "function target() { return 2; }" }],
      }),
      /AST support/,
    );
  });

  it("applySymbolicEdits throws when symbol does not exist in content", async () => {
    await assert.rejects(
      applySymbolicEdits({
        content: "function keep() { return 1; }\n",
        filePath: "example.ts",
        astResolver: createAstResolver(),
        edits: [{ editIdx: 0, symbol: { name: "nonexistent" }, replaceBody: "function target() { return 2; }" }],
      }),
      /Could not resolve symbol edit/,
    );
  });

  it("resolveSymbolicEditLineRange returns null for nonexistent symbol", async () => {
    const range = await resolveSymbolicEditLineRange({
      content: "function keep() { return 1; }\n",
      filePath: "example.ts",
      astResolver: createAstResolver(),
      edit: { symbol: { name: "nonexistent" }, replaceBody: "function target() { return 2; }" },
    });
    assert.strictEqual(range, null);
  });

  it("buildSymbolicEditGuidance returns empty array when astResolver is null", async () => {
    const notes = await buildSymbolicEditGuidance({
      content: "function target() { return 1; }\n",
      filePath: "example.ts",
      astResolver: null,
      spans: [{ startIndex: 0, endIndex: 10 }],
    });
    assert.deepStrictEqual(notes, []);
  });

  it("buildSymbolicEditGuidance returns empty array for unparseable content", async () => {
    const content = "function target() { return ";
    const notes = await buildSymbolicEditGuidance({
      content,
      filePath: "example.ts",
      astResolver: createAstResolver(),
      spans: [{ startIndex: 0, endIndex: content.length }],
    });
    assert.deepStrictEqual(notes, []);
  });
});
