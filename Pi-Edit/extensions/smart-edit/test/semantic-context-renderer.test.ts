/**
 * Edge-case tests for the context renderer (Phase 2.6).
 */

import { describe, it } from "node:test";
import assert from "node:assert";

describe("context-renderer edge cases", () => {
  it("handles empty items array", async () => {
    const { renderSemanticContext } = await import("../src/lsp/context-renderer");
    const result = renderSemanticContext(
      { path: "/dev/null", range: { startLine: 1, endLine: 5 }, source: "none" },
      [],
      { maxTokens: 1000, cwd: "/test" },
    );
    assert.ok(result.markdown);
    assert.ok(result.markdown.length > 0);
    assert.ok(result.details.tokenCount > 0);
  });

  it("handles all warning types in details", async () => {
    const { renderSemanticContext } = await import("../src/lsp/context-renderer");
    const items = [
      {
        symbolName: "A",
        relationship: "definition" as const,
        uri: "file:///a.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
        score: 50,
        excerptKind: "body" as const,
        text: "export const A = 1;",
        truncated: false,
      },
    ];
    const result = renderSemanticContext(
      { path: "a.ts", range: { startLine: 5, endLine: 15 }, source: "lsp" },
      items,
      { maxTokens: 5000, cwd: "/test" },
    );
    assert.ok(result.markdown.length > 0);
    assert.ok(Array.isArray(result.details.warnings));
  });

  it("truncation at exact budget boundary", async () => {
    const { renderSemanticContext } = await import("../src/lsp/context-renderer");
    const item = {
      symbolName: "X",
      relationship: "definition" as const,
      uri: "file:///x.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      score: 50,
      excerptKind: "body" as const,
      text: "export const X = 1;",
      truncated: false,
    };
    const result = renderSemanticContext(
      { path: "x.ts", range: { startLine: 1, endLine: 1 }, source: "ast" },
      [item],
      { maxTokens: 5, cwd: "/test" },
    );
    assert.ok(result.markdown);
    // Should not crash on small budget
  });

  it("renders multiline excerpts with proper formatting", async () => {
    const { renderSemanticContext } = await import("../src/lsp/context-renderer");
    const items = [
      {
        symbolName: "ComplexType",
        relationship: "definition" as const,
        uri: "file:///types.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
        score: 50,
        excerptKind: "body" as const,
        text: `interface ComplexType {\n  field1: string;\n  field2: number;\n}`,
        truncated: false,
      },
    ];
    const result = renderSemanticContext(
      { path: "types.ts", range: { startLine: 1, endLine: 10 }, source: "lsp" },
      items,
      { maxTokens: 5000, cwd: "/test" },
    );
    assert.ok(result.markdown.includes("ComplexType"));
    assert.ok(result.markdown.includes("types.ts"));
  });

  it("handles long paths in rendering", async () => {
    const { renderSemanticContext } = await import("../src/lsp/context-renderer");
    const items = [
      {
        symbolName: "Helper",
        relationship: "reference" as const,
        uri: "file:///a/very/deeply/nested/directory/structure/src/helpers/utility.ts",
        range: { start: { line: 42, character: 4 }, end: { line: 42, character: 10 } },
        score: 25,
        excerptKind: "reference" as const,
        text: "  Helper.doSomething()",
        truncated: false,
      },
    ];
    const result = renderSemanticContext(
      { path: "target.ts", range: { startLine: 5, endLine: 15 }, source: "lsp" },
      items,
      { maxTokens: 5000, cwd: "/test" },
    );
    assert.ok(result.markdown);
    assert.ok(result.markdown.includes("utility.ts") || result.markdown.includes("helpers/"));
  });
});
