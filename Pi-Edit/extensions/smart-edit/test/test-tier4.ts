/**
 * Tier 4 similarity-matching tests.
 *
 * These import findText and detectIndentation from edit-diff.ts
 * rather than reimplementing similarity logic inline.
 */

import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { findText, detectIndentation } from "../lib/edit-diff";
import { MatchTier } from "../lib/types";

describe("Tier 4 similarity matching", () => {
  test("findText falls back to similarity tier when exact/indent/unicode all fail", () => {
    const content = `function helloWorld() {
  const x = 1;
  console.log("hello");
  return x;
}

function goodbyeWorld() {
  const y = 2;
  console.log("goodbye");
  return y;
}
`;
    // Slightly modified oldText (typo in function name, rest similar)
    const oldText = `function hulloWorld() {
  const x = 1;
  console.log("hello");
  return x;
}`;
    const style = detectIndentation(content);
    const result = findText(content, oldText, style);
    assert.ok(result.found, "should find a similarity match");
    assert.equal(result.tier, MatchTier.SIMILARITY);
    assert.ok(result.matchLength > 0);
    assert.ok(result.index >= 0);
  });

  test("findText returns no match when text is too dissimilar", () => {
    const content = "foo bar baz qux\nline two\nline three";
    const oldText = "completely unrelated content\nthat doesn't match";
    const style = detectIndentation(content);
    const result = findText(content, oldText, style);
    assert.equal(result.found, false);
  });

  test("detectIndentation returns tab style for tab-indented files", () => {
    const content = "first\n\tindent1\n\t\tindent2\n";
    const style = detectIndentation(content);
    assert.equal(style.char, "\t");
    assert.equal(style.width, 4);
  });

  test("detectIndentation infers 2-space style", () => {
    const content = "first\n  indent1\n    indent2\n";
    const style = detectIndentation(content);
    assert.equal(style.char, " ");
    assert.equal(style.width, 2);
  });

  test("detectIndentation infers 4-space style", () => {
    const content = "first\n    indent1\n        indent2\n";
    const style = detectIndentation(content);
    assert.equal(style.char, " ");
    assert.equal(style.width, 4);
  });
});
