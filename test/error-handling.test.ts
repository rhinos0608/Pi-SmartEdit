/**
 * Tests for Smart Edit error handling edge cases:
 * - JSON string edits in prepareArguments
 * - formatEditError formatting
 * - validateInput edge cases
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  prepareArguments,
  formatEditError,
  validateInput,
} from "../.pi/extensions/smart-edit/index.ts";

// ─── formatEditError ─────────────────────────────────────────────────

describe("formatEditError", () => {
  it("creates error with message and hint", () => {
    const err = formatEditError("Something broke", "Try this instead.");
    assert(err instanceof Error);
    assert(err.message.includes("❌ Something broke"));
    assert(err.message.includes("Try this instead."));
  });

  it("creates error with message only (no hint)", () => {
    const err = formatEditError("Just a message");
    assert(err.message.includes("❌ Just a message"));
    assert(!err.message.includes("null"));
    assert(!err.message.includes("undefined"));
  });
});

// ─── prepareArguments ───────────────────────────────────────────────

describe("prepareArguments — JSON string edits", () => {
  it("passes through valid array edits", () => {
    const result = prepareArguments({
      path: "/test.ts",
      edits: [{ oldText: "foo", newText: "bar" }],
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 1);
    assert.strictEqual(result.edits[0].oldText, "foo");
  });

  it("parses valid JSON string edits", () => {
    const result = prepareArguments({
      path: "/test.ts",
      edits: '[{"oldText":"foo","newText":"bar"}]',
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 1);
    assert.strictEqual(result.edits[0].oldText, "foo");
    assert.strictEqual(result.edits[0].newText, "bar");
  });

  it("parses JSON string with multiple edits", () => {
    const result = prepareArguments({
      path: "/test.ts",
      edits:
        '[{"oldText":"a","newText":"b"},{"oldText":"c","newText":"d"}]',
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 2);
  });

  it("parses double-escaped JSON string (string in string)", () => {
    // Simulate where edits is a JSON string that itself contains
    // a JSON-encoded string (double escaping)
    const inner = JSON.stringify([
      { oldText: "foo", newText: "bar" },
    ]);
    // The edits value is a string containing: '[{"oldText":"foo","newText":"bar"}]'
    const doubleEscaped = JSON.stringify(inner);
    // Now doubleEscaped is: '"[{\\"oldText\\":\\"foo\\",\\"newText\\":\\"bar\\"}]"'
    // Which when JSON.parse'd once gives back the string, parse again gives the array
    const result = prepareArguments({
      path: "/test.ts",
      edits: doubleEscaped,
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 1);
    assert.strictEqual(result.edits[0].oldText, "foo");
  });

  it("handles empty string edits with actionable error", () => {
    assert.throws(
      () => prepareArguments({ path: "/test.ts", edits: "" }),
      (err: Error) => {
        assert(err.message.includes("empty string"));
        assert(err.message.includes("array of { oldText, newText }"));
        return true;
      },
    );
  });

  it("handles malformed JSON string edits with actionable error", () => {
    assert.throws(
      () => prepareArguments({ path: "/test.ts", edits: "[not valid json" }),
      (err: Error) => {
        assert(err.message.includes("not valid JSON"));
        assert(err.message.includes("[not valid json"));
        return true;
      },
    );
  });

  it("handles JSON string that parses to non-array", () => {
    assert.throws(
      () =>
        prepareArguments({
          path: "/test.ts",
          edits: '{"oldText":"foo","newText":"bar"}',
        }),
      (err: Error) => {
        assert(err.message.includes("not an array"));
        return true;
      },
    );
  });

  it("handles JSON string with non-object items", () => {
    assert.throws(
      () =>
        prepareArguments({
          path: "/test.ts",
          edits: '["string", 42]',
        }),
      (err: Error) => {
        assert(err.message.includes("edits[0]"));
        assert(err.message.includes("not an object"));
        return true;
      },
    );
  });

  it("handles JSON string with missing oldText field", () => {
    assert.throws(
      () =>
        prepareArguments({
          path: "/test.ts",
          edits: '[{"newText":"bar"}]',
        }),
      (err: Error) => {
        assert(err.message.includes("edits[0].oldText"));
        assert(err.message.includes("undefined"));
        return true;
      },
    );
  });

  it("handles JSON string with null item", () => {
    assert.throws(
      () =>
        prepareArguments({
          path: "/test.ts",
          edits: "[null]",
        }),
      (err: Error) => {
        assert(err.message.includes("edits[0]"));
        assert(err.message.includes("null"));
        return true;
      },
    );
  });

  it("passes through legacy single-edit format", () => {
    const result = prepareArguments({
      path: "/test.ts",
      oldText: "foo",
      newText: "bar",
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 1);
    assert.strictEqual(result.edits[0].oldText, "foo");
  });

  it("handles null/undefined input gracefully", () => {
    const result = prepareArguments(null as unknown as Record<string, unknown>);
    assert.strictEqual(result, null);
  });

  it("handles non-object input gracefully", () => {
    const result = prepareArguments("bad" as unknown as Record<string, unknown>);
    assert.strictEqual(result, "bad");
  });

  // ── Missing required fields ──────────────────────────────────

  it("throws actionable error when path is missing", () => {
    assert.throws(
      () => prepareArguments({ edits: [{ oldText: "foo", newText: "bar" }] }),
      (err: Error) => {
        assert(err.message.includes('❌'), "should have error prefix");
        assert(err.message.includes("missing"), "should say missing");
        assert(err.message.includes("path"), "should mention path");
        assert(err.message.includes("edits"), "should mention edits in hint");
        return true;
      },
    );
  });

  it("throws actionable error when edits is missing", () => {
    assert.throws(
      () => prepareArguments({ path: "/test.ts" }),
      (err: Error) => {
        assert(err.message.includes('❌'), "should have error prefix");
        assert(err.message.includes("missing"), "should say missing");
        assert(err.message.includes("edits"), "should mention edits");
        return true;
      },
    );
  });

  it("throws actionable error when edits is null", () => {
    assert.throws(
      () => prepareArguments({ path: "/test.ts", edits: null }),
      (err: Error) => {
        assert(err.message.includes("missing"), "should say missing");
        assert(err.message.includes("edits"), "should mention edits");
        return true;
      },
    );
  });

  it("throws actionable error when both path and edits are missing", () => {
    assert.throws(
      () => prepareArguments({}),
      (err: Error) => {
        assert(err.message.includes("missing"), "should say missing");
        assert(err.message.includes("path"), "should mention path");
        assert(err.message.includes("edits"), "should mention edits");
        return true;
      },
    );
  });

  it("throws actionable error when input is empty object", () => {
    assert.throws(
      () => prepareArguments({} as Record<string, unknown>),
      (err: Error) => {
        assert(err.message.includes("missing"), "should say missing");
        assert(err.message.includes("both"), "should say both");
        return true;
      },
    );
  });
});

// ─── validateInput ──────────────────────────────────────────────────

describe("validateInput", () => {
  it("passes valid input", () => {
    const result = validateInput({
      path: "/test.ts",
      edits: [{ oldText: "foo", newText: "bar" }],
    });
    assert.strictEqual(result.path, "/test.ts");
    assert.strictEqual(result.edits.length, 1);
  });

  it("throws for empty edits array", () => {
    assert.throws(
      () => validateInput({ path: "/test.ts", edits: [] }),
      (err: Error) => {
        assert(err.message.includes("at least one replacement"));
        return true;
      },
    );
  });

  it("throws for non-array edits", () => {
    assert.throws(
      () => validateInput({ path: "/test.ts", edits: "string" }),
      (err: Error) => {
        assert(err.message.includes("at least one replacement"));
        return true;
      },
    );
  });

  it("handles valid edits without error", () => {
    const result = validateInput({
      path: "/test.ts",
      edits: [{ oldText: "foo", newText: "bar" }],
    });
    assert.strictEqual(result.path, "/test.ts");
    assert.strictEqual(result.edits.length, 1);
  });
});

// ─── Schema compatibility: Type.Union accepts string edits ──────────

describe("prepareArguments — schema-level string acceptance", () => {
  it("parses complex JSON string edits (real-world edge case)", () => {
    // Simulates the real-world case where a model serializes the edits array
    // as a JSON string. The schema now accepts this via Type.Union.
    const jsonString = JSON.stringify([
      { oldText: "migration001,\n  migration002,\n  migration003", newText: "migration001,\n  migration002,\n  migration003,\n  migration004" },
    ]);
    const result = prepareArguments({
      path: "src/services/sqlite/migrations.ts",
      edits: jsonString,
    });
    assert(Array.isArray(result.edits), "edits should be an array after prepareArguments");
    assert.strictEqual(result.edits.length, 1, "should have one edit");
    assert.strictEqual(result.edits[0].oldText, "migration001,\n  migration002,\n  migration003");
    assert.strictEqual(result.edits[0].newText, "migration001,\n  migration002,\n  migration003,\n  migration004");
  });

  it("parses complex JSON string with multiple multiline edits", () => {
    // Models often send large multiline edits as a JSON string
    const edits = [
      {
        oldText: "function foo() {\n  return 1;\n}",
        newText: "function foo() {\n  return 42;\n}",
      },
      {
        oldText: "function bar() {\n  return 2;\n}",
        newText: "function bar() {\n  return 99;\n}",
      },
    ];
    const result = prepareArguments({
      path: "/test.ts",
      edits: JSON.stringify(edits),
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 2);
    assert.strictEqual(result.edits[0].oldText, edits[0].oldText);
    assert.strictEqual(result.edits[0].newText, edits[0].newText);
    assert.strictEqual(result.edits[1].oldText, edits[1].oldText);
    assert.strictEqual(result.edits[1].newText, edits[1].newText);
  });

  it("handles JSON string with replaceAll mixed in (stripped by prepareArguments)", () => {
    const jsonString = JSON.stringify([
      { oldText: "var x", newText: "let x", replaceAll: true },
      { oldText: "var y", newText: "let y", replaceAll: true },
    ]);
    const result = prepareArguments({
      path: "/test.ts",
      edits: jsonString,
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 2);
    // replaceAll should be stripped from the returned edits (side-channel)
    assert.strictEqual((result.edits[0] as Record<string, unknown>).replaceAll, undefined);
    assert.strictEqual((result.edits[1] as Record<string, unknown>).replaceAll, undefined);
  });
});

// ─── JSON string repair (tryRepairJSONString) ──────────────────────

describe("prepareArguments — JSON string repair", () => {
  it("repairs JSON with literal newlines inside string values", () => {
    // Literal newline in oldText value breaks JSON.parse but is recovered
    const raw = '[{"oldText": "line1\nline2", "newText": "replacement"}]';
    const result = prepareArguments({
      path: "/test.ts",
      edits: raw,
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 1);
    assert.strictEqual(result.edits[0].oldText, "line1\nline2");
    assert.strictEqual(result.edits[0].newText, "replacement");
  });

  it("repairs JSON with literal newlines in both oldText and newText", () => {
    const raw = (
      '[{"oldText": "function foo() {\n  return 1;\n}", ' +
      '"newText": "function foo() {\n  return 42;\n}"}]'
    );
    const result = prepareArguments({
      path: "/test.ts",
      edits: raw,
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 1);
    assert.strictEqual(result.edits[0].oldText, "function foo() {\n  return 1;\n}");
    assert.strictEqual(result.edits[0].newText, "function foo() {\n  return 42;\n}");
  });

  it("repairs JSON with multiple edits containing literal newlines", () => {
    const raw = (
      '[{"oldText": "a\nb", "newText": "x\ny"},' +
      '{"oldText": "c\nd", "newText": "z\nw"}]'
    );
    const result = prepareArguments({
      path: "/test.ts",
      edits: raw,
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 2);
    assert.strictEqual(result.edits[0].oldText, "a\nb");
    assert.strictEqual(result.edits[0].newText, "x\ny");
    assert.strictEqual(result.edits[1].oldText, "c\nd");
    assert.strictEqual(result.edits[1].newText, "z\nw");
  });

  it("repairs JSON with escaped quotes AND literal newlines", () => {
    // Models often escape quotes inside string values AND have literal
    // newlines in the same value.  The raw JSON has \" (escaped quote)
    // and literal newline chars that break JSON.parse until repaired.
    // In JS single-quoted strings: \\\" → \", \\n → \n, \n → newline
    const raw = (
      '[{"oldText": "import { API } from \\\"lib\\\";\\n' +
      '  doStuff();", ' +
      '"newText": "import { API } from \\\"lib\\\";\\n' +
      '  doMore();"}]'
    );
    const result = prepareArguments({
      path: "/test.ts",
      edits: raw,
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 1);
    assert(result.edits[0].oldText.includes('import { API } from "lib"'));
    assert(result.edits[0].oldText.includes("\n  doStuff();"));
    assert(result.edits[0].newText.includes("\n  doMore();"));
  });

  it("extracts partial edits from truncated JSON array", () => {
    // Truncated JSON array — first object is complete, second is cut off
    const raw = (
      '[{"oldText": "keep me", "newText": "replaced"},' +
      '{"oldText": "cut off'
    );
    const result = prepareArguments({
      path: "/test.ts",
      edits: raw,
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 1, "should extract the complete edit object");
    assert.strictEqual(result.edits[0].oldText, "keep me");
    assert.strictEqual(result.edits[0].newText, "replaced");
  });

  it("extracts multiple partial edits from deeply truncated JSON", () => {
    // Truncated with two complete objects
    const raw = (
      '[{"oldText": "a", "newText": "1"},' +
      '{"oldText": "b", "newText": "2"},' +
      '{"oldText": "c"'
    );
    const result = prepareArguments({
      path: "/test.ts",
      edits: raw,
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 2, "should extract 2 complete objects");
    assert.strictEqual(result.edits[0].oldText, "a");
    assert.strictEqual(result.edits[1].newText, "2");
  });

  it("extracts single partial edit with no trailing comma", () => {
    // No trailing comma before truncation — common in some pipelines
    const result = prepareArguments({
      path: "/test.ts",
      edits: '[{"oldText":"only one","newText":"done"}',
    });
    assert(Array.isArray(result.edits));
    assert.strictEqual(result.edits.length, 1);
    assert.strictEqual(result.edits[0].oldText, "only one");
  });

  it("throws actionable error when no recovery possible", () => {
    // Input that is clearly not JSON and has no structural hints
    assert.throws(
      () =>
        prepareArguments({
          path: "/test.ts",
          edits: "completely garbled not json at all",
        }),
      (err: Error) => {
        assert(err.message.includes("not an array"));
        assert(err.message.includes("not valid JSON"));
        assert(err.message.includes("Automatic repair"));
        return true;
      },
    );
  });

  it("still throws for truncated JSON with no complete objects", () => {
    // Starts with [ but has no complete { } objects
    assert.throws(
      () =>
        prepareArguments({
          path: "/test.ts",
          edits: '[{"oldText": "only",',
        }),
      (err: Error) => {
        assert(err.message.includes("not an array"));
        assert(err.message.includes("Automatic repair"));
        return true;
      },
    );
  });
});
