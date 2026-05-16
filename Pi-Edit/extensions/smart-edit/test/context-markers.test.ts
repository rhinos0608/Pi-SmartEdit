/**
 * Unit tests for context marker system (src/formats/context-markers.ts).
 *
 * Covers: wrapInContextMarker, isMarkedFragment, parseMarkerMetadata, stripMarkers,
 * attribute encoding/decoding, edge cases (empty body, no markers, path encoding).
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  wrapInContextMarker,
  isMarkedFragment,
  parseMarkerMetadata,
  stripMarkers,
} from "../src/formats/context-markers.js";

describe("wrapInContextMarker", () => {
  it("wraps body in open and close tags", () => {
    const result = wrapInContextMarker("some context", { type: "semantic_context" });
    assert.ok(result.startsWith("<smartedit:context "));
    assert.ok(result.endsWith("</smartedit:context>"));
    assert.ok(result.includes("some context"));
  });

  it("includes type attribute", () => {
    const result = wrapInContextMarker("body", { type: "semantic_context" });
    assert.ok(result.includes('type="semantic_context"'));
  });

  it("includes optional path attribute with percent-encoding", () => {
    const result = wrapInContextMarker("body", {
      type: "semantic_context",
      path: "src/service.ts",
    });
    assert.ok(result.includes('path="src%2Fservice.ts"'));
  });

  it("includes optional range attribute", () => {
    const result = wrapInContextMarker("body", {
      type: "semantic_context",
      range: "42-78",
    });
    assert.ok(result.includes('range="42-78"'));
  });

  it("includes optional source attribute", () => {
    const result = wrapInContextMarker("body", {
      type: "semantic_context",
      source: "lsp",
    });
    assert.ok(result.includes('source="lsp"'));
  });

  it("includes optional tokens attribute", () => {
    const result = wrapInContextMarker("body", {
      type: "semantic_context",
      tokens: 1240,
    });
    assert.ok(result.includes('tokens="1240"'));
  });

  it("includes optional language attribute", () => {
    const result = wrapInContextMarker("body", {
      type: "semantic_context",
      language: "typescript",
    });
    assert.ok(result.includes('language="typescript"'));
  });

  it("does not encode path when no path is provided", () => {
    const result = wrapInContextMarker("body", { type: "test" });
    assert.ok(!result.includes('path='));
  });

  it("escapes special characters in attribute values", () => {
    const result = wrapInContextMarker("body", {
      type: 'weird"type',
    });
    // The double-quote should be escaped as &quot;
    assert.ok(result.includes("&quot;"));
  });
});

describe("isMarkedFragment", () => {
  it("returns true for text with a smartedit:context marker", () => {
    const text = wrapInContextMarker("hello", { type: "test" });
    assert.ok(isMarkedFragment(text));
  });

  it("returns false for plain text", () => {
    assert.ok(!isMarkedFragment("just some normal text"));
  });

  it("returns false for text with only open tag", () => {
    assert.ok(!isMarkedFragment("<smartedit:context type=\"test\">no close"));
  });

  it("returns false for text with only close tag", () => {
    assert.ok(!isMarkedFragment("no open</smartedit:context>"));
  });

  it("returns false for empty string", () => {
    assert.ok(!isMarkedFragment(""));
  });
});

describe("parseMarkerMetadata", () => {
  it("returns empty array for text without markers", () => {
    assert.deepStrictEqual(parseMarkerMetadata("no markers here"), []);
  });

  it("returns empty array for empty string", () => {
    assert.deepStrictEqual(parseMarkerMetadata(""), []);
  });

  it("parses a single fragment with all attributes", () => {
    const body = "some type definition content";
    const text = wrapInContextMarker(body, {
      type: "semantic_context",
      path: "src/foo.ts",
      range: "10-30",
      source: "lsp",
      tokens: 500,
      language: "typescript",
    });

    const fragments = parseMarkerMetadata(text);
    assert.strictEqual(fragments.length, 1);
    assert.strictEqual(fragments[0].body, body);
    assert.strictEqual(fragments[0].attrs.type, "semantic_context");
    assert.strictEqual(fragments[0].attrs.path, "src/foo.ts");
    assert.strictEqual(fragments[0].attrs.range, "10-30");
    assert.strictEqual(fragments[0].attrs.source, "lsp");
    assert.strictEqual(fragments[0].attrs.tokens, 500);
    assert.strictEqual(fragments[0].attrs.language, "typescript");
  });

  it("parses multiple adjacent fragments", () => {
    const f1 = wrapInContextMarker("first", { type: "a" });
    const f2 = wrapInContextMarker("second", { type: "b" });
    const text = `${f1}\n${f2}`;

    const fragments = parseMarkerMetadata(text);
    assert.strictEqual(fragments.length, 2);
    assert.strictEqual(fragments[0].body, "first");
    assert.strictEqual(fragments[0].attrs.type, "a");
    assert.strictEqual(fragments[1].body, "second");
    assert.strictEqual(fragments[1].attrs.type, "b");
  });

  it("parses a fragment with minimal attributes (type only)", () => {
    const text = wrapInContextMarker("body", { type: "semantic_context" });
    const fragments = parseMarkerMetadata(text);
    assert.strictEqual(fragments.length, 1);
    assert.strictEqual(fragments[0].attrs.type, "semantic_context");
    assert.strictEqual(fragments[0].attrs.path, undefined);
    assert.strictEqual(fragments[0].attrs.range, undefined);
  });

  it("returns correct startIndex and endIndex", () => {
    const text = wrapInContextMarker("body", { type: "test" });
    const fragments = parseMarkerMetadata(text);
    assert.strictEqual(fragments.length, 1);
    assert.strictEqual(fragments[0].startIndex, 0);
    assert.strictEqual(fragments[0].endIndex, text.length);
  });

  it("correctly handles text before the marker", () => {
    const text = `prefix text\n${wrapInContextMarker("body", { type: "test" })}\nsuffix text`;
    const fragments = parseMarkerMetadata(text);
    assert.strictEqual(fragments.length, 1);
    assert.strictEqual(fragments[0].body, "body");
    assert.ok(fragments[0].startIndex > 0);
  });
});

describe("stripMarkers", () => {
  it("returns body content without markers", () => {
    const text = wrapInContextMarker("hello world", { type: "test" });
    assert.strictEqual(stripMarkers(text), "hello world");
  });

  it("returns original text when no markers present", () => {
    assert.strictEqual(stripMarkers("plain text"), "plain text");
  });

  it("returns body content with surrounding text preserved", () => {
    const fragment = wrapInContextMarker("injected", { type: "test" });
    const text = `before\n${fragment}\nafter`;
    const stripped = stripMarkers(text);
    assert.ok(stripped.includes("before"));
    assert.ok(stripped.includes("injected"));
    assert.ok(stripped.includes("after"));
  });

  it("preserves body from multiple fragments", () => {
    const f1 = wrapInContextMarker("first", { type: "a" });
    const f2 = wrapInContextMarker("second", { type: "b" });
    const text = `prefix\n${f1}\n\n${f2}\nsuffix`;
    const stripped = stripMarkers(text);
    assert.ok(stripped.includes("first"));
    assert.ok(stripped.includes("second"));
    assert.ok(stripped.includes("prefix"));
    assert.ok(stripped.includes("suffix"));
  });

  it("returns empty string when only markers and empty bodies", () => {
    const text = wrapInContextMarker("", { type: "test" });
    assert.strictEqual(stripMarkers(text), "");
  });
});

describe("round-trip: wrap → parse → strip", () => {
  it("survives round-trip for semantic_context usage", () => {
    const originalBody = [
      "### Semantic context for `src/service.ts:42-78`",
      "",
      "#### Definitions",
      "- **CreateOrderInput** (`src/types.ts:1:0`)",
      "  ```ts",
      "  interface CreateOrderInput {",
      '    customerId: string;',
      "  }",
      "  ```",
    ].join("\n");

    const attrs = {
      type: "semantic_context" as const,
      path: "src/service.ts",
      range: "42-78",
      source: "lsp" as const,
      tokens: 1240,
      language: "typescript" as const,
    };

    const wrapped = wrapInContextMarker(originalBody, attrs);

    // isMarkedFragment detects it
    assert.ok(isMarkedFragment(wrapped));

    // parseMarkerMetadata extracts everything
    const fragments = parseMarkerMetadata(wrapped);
    assert.strictEqual(fragments.length, 1);
    assert.strictEqual(fragments[0].attrs.type, "semantic_context");
    assert.strictEqual(fragments[0].attrs.path, "src/service.ts");
    assert.strictEqual(fragments[0].attrs.source, "lsp");

    // stripMarkers recovers the original body
    const stripped = stripMarkers(wrapped);
    assert.strictEqual(stripped, originalBody);
  });
});
