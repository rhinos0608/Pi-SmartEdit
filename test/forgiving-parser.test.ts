/**
 * Tests for the forgiving parser — SmallCode-inspired JSON repair.
 */
import { describe, test } from "node:test";
import assert from "node:assert";
import {
  repairJson,
  repairToolCallJson,
  editDistance,
  findFuzzyKey,
} from "../src/formats/forgiving-parser";

// ─── Edit Distance Tests ─────────────────────────────────────────────

describe("editDistance", () => {
  test("identical strings", () => {
    assert.strictEqual(editDistance("hello", "hello"), 0);
  });

  test("single substitution", () => {
    assert.strictEqual(editDistance("hello", "hallo"), 1);
  });

  test("single deletion", () => {
    assert.strictEqual(editDistance("hello", "helo"), 1);
  });

  test("single insertion", () => {
    assert.strictEqual(editDistance("hello", "helloo"), 1);
  });

  test("completely different", () => {
    assert.strictEqual(editDistance("abc", "xyz"), 3);
  });

  test("empty strings", () => {
    assert.strictEqual(editDistance("", ""), 0);
    assert.strictEqual(editDistance("abc", ""), 3);
    assert.strictEqual(editDistance("", "abc"), 3);
  });
});

// ─── Fuzzy Key Matching Tests ────────────────────────────────────────

describe("findFuzzyKey", () => {
  test("exact match", () => {
    const keys = new Set(["path", "edits", "oldText"]);
    assert.strictEqual(findFuzzyKey(keys, "path"), "path");
  });

  test("normalized match (underscores)", () => {
    const keys = new Set(["old_text", "new_text", "path"]);
    assert.strictEqual(findFuzzyKey(keys, "oldText"), "old_text");
  });

  test("normalized match (hyphens)", () => {
    const keys = new Set(["old-text", "new-text", "path"]);
    assert.strictEqual(findFuzzyKey(keys, "oldtext"), "old-text");
  });

  test("substring match", () => {
    const keys = new Set(["file_path", "file_name"]);
    assert.strictEqual(findFuzzyKey(keys, "path"), "file_path");
  });

  test("Levenshtein ≤ 2", () => {
    const keys = new Set(["edits", "content", "path"]);
    assert.strictEqual(findFuzzyKey(keys, "edt"), "edits");  // distance 2 (inserting 'i' and 's')
  });

  test("no match when too far", () => {
    const keys = new Set(["path", "edits"]);
    assert.strictEqual(findFuzzyKey(keys, "xyzabc"), null);  // distance > 2
  });

  test("empty keys set", () => {
    assert.strictEqual(findFuzzyKey(new Set(), "path"), null);
  });
});

// ─── repairJson Tests ────────────────────────────────────────────────

describe("repairJson", () => {
  test("strategy 0: as-is valid JSON", () => {
    const result = repairJson('{"path": "file.ts", "edits": [{"oldText": "a", "newText": "b"}]}');
    assert.ok(result.value !== undefined);
    assert.strictEqual(result.strategy, 0);
    const val = result.value as Record<string, unknown>;
    assert.strictEqual(val.path, "file.ts");
    assert.strictEqual(Array.isArray(val.edits), true);
  });

  test("strategy 2: trailing comma before }", () => {
    const result = repairJson('{"path": "file.ts", "edits": [{"oldText": "a", "newText": "b",},]}');
    assert.ok(result.value !== undefined);
    assert.strictEqual(result.strategy, 2);
  });

  test("strategy 2: trailing comma before ]", () => {
    const result = repairJson('{"path": "file.ts", "edits": [{"oldText": "a", "newText": "b"},]}');
    assert.ok(result.value !== undefined);
    assert.strictEqual(result.strategy, 2);
  });

  test("strategy 4: strip markdown code fences", () => {
    const input = '```json\n{"path": "src/foo.ts", "edits": [{"oldText": "a", "newText": "b"}]}\n```';
    const result = repairJson(input);
    assert.ok(result.value !== undefined);
    assert.strictEqual(result.strategy, 4);
  });

  test("strategy 4: strip markdown without language tag", () => {
    const input = '```\n{"path": "src/foo.ts"}\n```';
    const result = repairJson(input);
    assert.ok(result.value !== undefined);
    assert.strictEqual(result.strategy, 4);
  });

  test("strategy 5: extract {...} from noisy text", () => {
    const input = 'Here is the config: {"path": "file.ts", "edits": [{"oldText": "a", "newText": "b"}]} end';
    const result = repairJson(input);
    assert.ok(result.value !== undefined);
    assert.strictEqual(result.strategy, 5);
  });

  test("strategy 5: extract [...] from noisy text", () => {
    const input = 'edits: [{"oldText": "a", "newText": "b"}] done';
    const result = repairJson(input);
    assert.ok(result.value !== undefined);
    assert.strictEqual(result.strategy, 5);
    assert.ok(Array.isArray(result.value));
  });

  test("strategy 6: literal newlines in string values", () => {
    const input = '{"path": "file.ts", "edits": [{"oldText": "line1\nline2", "newText": "new\nline"}]}';
    const result = repairJson(input);
    assert.ok(result.value !== undefined);
    assert.strictEqual(result.strategy, 6);
    // After repair, JSON parse converts escaped \n to actual newline characters.
    // The test input has literal newlines that get escaped to \n in JSON,
    // then JSON.parse converts \n back to actual newlines.
    const val = result.value as Record<string, unknown>;
    const edits = val.edits as Array<Record<string, string>>;
    assert.ok(edits[0].oldText.includes("\n"));
  });

  test("strategy 7: unbalanced braces — missing closing }", () => {
    const input = '{"path": "file.ts", "edits": [{"oldText": "a", "newText": "b"}';
    // Missing one closing } for the outer object
    const result = repairJson(input);
    assert.ok(result.value !== undefined);
    assert.strictEqual(result.strategy, 7);
  });

  test("unrepairable input returns undefined", () => {
    const result = repairJson("this is not json at all");
    assert.strictEqual(result.value, undefined);
    assert.strictEqual(result.strategy, -1);
  });

  test("empty string", () => {
    const result = repairJson("");
    assert.strictEqual(result.value, undefined);
    assert.strictEqual(result.strategy, -1);
  });
});

// ─── Fuzzy Key Renaming Tests ────────────────────────────────────────

describe("repairJson with known schema", () => {
  const editSchema = {
    edit: ["path", "edits", "oldText", "newText", "replaceAll", "anchor", "lineRange", "hashline"],
  };

  test("renames 'old_text' to 'oldText' via fuzzy match", () => {
    const input = '{"path": "file.ts", "edits": [{"old_text": "a", "new_text": "b"}]}';
    const result = repairJson(input, editSchema);
    assert.ok(result.value !== undefined);
    assert.strictEqual(result.fuzzyKeysApplied, true);
    assert.ok(Object.keys(result.fuzzyRenames).length > 0);

    const val = result.value as Record<string, unknown>;
    const edits = val.edits as Array<Record<string, unknown>>;
    assert.strictEqual(edits[0].oldText, "a");
    assert.strictEqual(edits[0].newText, "b");
    assert.strictEqual(edits[0].old_text, undefined);
  });

  test("'fliePath' IS renamed to 'path' (substring match, normalized 'fliepath' contains 'path')", () => {
    const input = '{"fliePath": "file.ts", "edits": [{"oldText": "a", "newText": "b"}]}';
    const result = repairJson(input, editSchema);
    assert.ok(result.value !== undefined);
    // findFuzzyKey checks substring: "fliepath".includes("path") is true, so rename happens
    assert.strictEqual(result.fuzzyKeysApplied, true);
    const val = result.value as Record<string, unknown>;
    // After renaming, fliePath should become path
    assert.strictEqual(val.path, "file.ts");
    assert.strictEqual((val as Record<string, unknown>).fliePath, undefined);
  });

  test("does not rename when all schema keys are present", () => {
    const input = '{"path": "file.ts", "edits": [{"oldText": "a", "newText": "b"}]}';
    const result = repairJson(input, editSchema);
    assert.ok(result.value !== undefined);
    assert.strictEqual(result.fuzzyKeysApplied, false);
  });
});

// ─── repairToolCallJson Tests ────────────────────────────────────────

describe("repairToolCallJson", () => {
  test("parses valid JSON array of edits", () => {
    const result = repairToolCallJson('[{"oldText": "a", "newText": "b"}]');
    assert.ok(result !== undefined);
    assert.strictEqual(result!.length, 1);
    const edit = result![0] as Record<string, string>;
    assert.strictEqual(edit.oldText, "a");
    assert.strictEqual(edit.newText, "b");
  });

  test("wraps single object in array", () => {
    const result = repairToolCallJson('{"oldText": "a", "newText": "b"}');
    assert.ok(result !== undefined);
    assert.strictEqual(result!.length, 1);
  });

  test("returns undefined for non-edit JSON", () => {
    const result = repairToolCallJson('"hello"');
    assert.strictEqual(result, undefined);
  });

  test("returns undefined for unparseable input", () => {
    const result = repairToolCallJson("not json");
    assert.strictEqual(result, undefined);
  });

  test("empty string", () => {
    const result = repairToolCallJson("");
    assert.strictEqual(result, undefined);
  });
});
