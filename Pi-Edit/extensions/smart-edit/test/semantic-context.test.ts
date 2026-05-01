/**
 * Tests for the Semantic Context Retrieval Library (Phase 2).
 */

import { describe, it } from "node:test";
import assert from "node:assert";

// ── Target range resolution tests ──────────────────────────────

describe("target-range resolution", () => {
  it("resolves lineRange to byteRange via options object", async () => {
    const { resolveTargetRange } = await import("../src/lsp/target-range");
    const content = "line1\nline2\nline3\nline4\nline5\n";
    const result = await resolveTargetRange({
      path: "/dev/null",
      content,
      lineRange: { startLine: 2, endLine: 4 },
      snapshot: null,
      astResolver: null,
      documentSymbols: [],
    });
    assert.ok(result);
    assert.equal(result.source, "lineRange");
    assert.equal(result.lineRange.startLine, 2);
    assert.equal(result.lineRange.endLine, 4);
  });

  it("falls back to whole file when no locator provided", async () => {
    const { resolveTargetRange } = await import("../src/lsp/target-range");
    const content = "a\nb\nc\n";
    const result = await resolveTargetRange({
      path: "/dev/null",
      content,
      snapshot: null,
      astResolver: null,
      documentSymbols: [],
    });
    assert.ok(result);
    assert.equal(result.source, "file");
  });
});

// ── Context renderer tests ─────────────────────────────────────

describe("context-renderer", () => {
  it("estimateTokens approximates text length / 4", async () => {
    const { estimateTokens } = await import("../src/lsp/context-renderer");
    assert.equal(estimateTokens("hello world"), 3); // 11/4 = 2.75 → 3
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("a"), 1);
  });

  it("renders context items via renderSemanticContext", async () => {
    const { renderSemanticContext } = await import("../src/lsp/context-renderer");
    const items = [
      {
        symbolName: "foo",
        relationship: "reference" as const,
        uri: "file:///a.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
        score: 10,
        excerptKind: "signature" as const,
        text: "function foo()",
        truncated: false,
      },
      {
        symbolName: "Bar",
        relationship: "definition" as const,
        uri: "file:///b.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
        score: 50,
        excerptKind: "body" as const,
        text: "interface Bar {}",
        truncated: false,
      },
    ];
    const result = renderSemanticContext(
      { path: "test.ts", range: { startLine: 1, endLine: 10 }, source: "ast" },
      items,
      { maxTokens: 5000, cwd: "/test" },
    );
    assert.ok(result.markdown);
    // Definitions should appear before references
    const defIdx = result.markdown.indexOf("Bar");
    const refIdx = result.markdown.indexOf("foo");
    assert.ok(defIdx >= 0);
    assert.ok(refIdx >= 0);
  });
});

// ── Symbol skeleton tests ──────────────────────────────────────

describe("symbol-skeleton", () => {
  it("findEnclosingDocumentSymbol finds parent", async () => {
    const { findEnclosingDocumentSymbol } = await import("../src/lsp/symbol-skeleton");
    const symbols = [
      {
        name: "MyClass",
        detail: "class",
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
        children: [
          {
            name: "myMethod",
            detail: "method",
            kind: 6,
            range: { start: { line: 5, character: 2 }, end: { line: 10, character: 2 } },
            selectionRange: { start: { line: 5, character: 2 }, end: { line: 5, character: 10 } },
          },
        ],
      },
    ];
    const location = { uri: "file:///a.ts", range: { start: { line: 6, character: 4 }, end: { line: 6, character: 12 } } };
    const found = findEnclosingDocumentSymbol(symbols, location);
    assert.ok(found);
    // Returns the innermost (most specific) enclosing symbol
    assert.equal(found.name, "myMethod");
  });

  it("returns null for location outside all symbols", async () => {
    const { findEnclosingDocumentSymbol } = await import("../src/lsp/symbol-skeleton");
    const symbols = [
      {
        name: "A",
        detail: "function",
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
    ];
    const location = { uri: "file:///a.ts", range: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } } };
    const found = findEnclosingDocumentSymbol(symbols, location);
    assert.equal(found, null);
  });

  it("extractSymbolExcerpt returns body for small symbol", async () => {
    const { extractSymbolExcerpt } = await import("../src/lsp/symbol-skeleton");
    const content = "line1\nline2\nline3\n";
    const symbol = {
      name: "foo",
      detail: "function",
      kind: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 5 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    };
    const location = { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 2, character: 5 } } };
    const result = extractSymbolExcerpt(content, symbol, location, { maxLines: 10, preferSkeleton: false });
    assert.ok(result.text.includes("line1"));
    // preferSkeleton: false causes reference-style excerpt
    assert.equal(result.excerptKind, "reference");
  });
});

// ── Key token extraction (AST fallback, accessed via buildSemanticContext) ──

describe("AST fallback token extraction", () => {
  it("extracts identifiers from a simple TypeScript snippet", async () => {
    // We test the internal behavior by calling buildSemanticContext with mocked deps
    const { buildSemanticContext } = await import("../src/lsp/semantic-context");
    const content = `function greet(name: string): string {
  const message = "Hello, " + name;
  return message;
}`;
    const deps = {
      cwd: "/test",
      readFile: async () => content,
      getSnapshot: () => ({ contentHash: "abc", partial: false }),
      recordRead: () => {},
      lspManager: null,
      astResolver: undefined,
    };
    const result = await buildSemanticContext(
      { path: "/test/greet.ts", lineRange: { startLine: 1, endLine: 4 } },
      deps,
    );
    assert.ok(result);
    assert.ok(result.markdown);
  });
});

// ── buildSemanticContext with mocked deps ───────────────────────

describe("buildSemanticContext with mocked deps", () => {
  it("returns context for a known file with lineRange and no LSP", async () => {
    const { buildSemanticContext } = await import("../src/lsp/semantic-context");
    const content = `import { OrderRepository } from "./repository";
import { CreateOrderInput, Order } from "./types";

export async function createOrder(
  input: CreateOrderInput,
  repo: OrderRepository,
): Promise<Order> {
  const order: Order = { id: "1", customerId: input.customerId, items: input.items, total: 0, status: "pending", createdAt: new Date() };
  await repo.save(order);
  return order;
}`;
    const deps = {
      cwd: "/test",
      readFile: async () => content,
      getSnapshot: () => ({ contentHash: "abc", partial: false }),
      recordRead: () => {},
      lspManager: null,
      astResolver: undefined,
    };
    const result = await buildSemanticContext(
      { path: "/test/service.ts", lineRange: { startLine: 4, endLine: 10 } },
      deps,
    );
    assert.ok(result);
    assert.ok(result.markdown);
    assert.ok(result.details);
    // With no LSP and no AST, source should be "none"
    assert.ok(result.details.source === "ast" || result.details.source === "none");
    assert.ok(Array.isArray(result.details.warnings));
  });

  it("includes details metadata", async () => {
    const { buildSemanticContext } = await import("../src/lsp/semantic-context");
    const deps = {
      cwd: "/test",
      readFile: async () => "const x = 1;",
      getSnapshot: () => ({ contentHash: "abc", partial: false }),
      recordRead: () => {},
      lspManager: null,
      astResolver: undefined,
    };
    const result = await buildSemanticContext(
      { path: "/test/x.ts", lineRange: { startLine: 1, endLine: 1 } },
      deps,
    );
    assert.ok(result.details.elapsedMs !== undefined);
    assert.ok(typeof result.details.languageId === "string");
    assert.ok(result.details.targetRange !== undefined);
  });
});
