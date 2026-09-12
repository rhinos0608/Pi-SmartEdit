import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adaptNewTextIndentation,
  countOccurrences,
  countSimilarityOccurrences,
  detectCommentStyle,
  detectIndentation,
  findAllMatches,
  findClosestMatch,
  findText,
  findTextWithTelemetry,
  isDominantFuzzyMatch,
  materializeDotdotdots,
  normalizeForFuzzyMatch,
  preserveQuoteStyle,
  stripCommentPrefixes,
  textSimilarityRatio,
} from "../src/core/edit-match.js";
import { MatchTier } from "../src/core/types.js";
import type { TierTelemetry } from "../src/core/edit-match.js";

const SPACE4 = { char: " " as const, width: 4 };

describe("edit-match tier order", () => {
  it("exact match wins first with numericFuzz 0", () => {
    const content = "const a = 1;\nconst b = 2;\n";
    const r = findText(content, "const b = 2;", SPACE4);
    assert.equal(r.found, true);
    assert.equal(r.tier, MatchTier.EXACT);
    assert.equal(r.numericFuzz, 0);
    assert.equal(r.index, content.indexOf("const b = 2;"));
    assert.equal(r.matchLength, "const b = 2;".length);
  });

  it("indentation tier rescues width differences with numericFuzz 1", () => {
    const content = "function f() {\n    return 1;\n}\n";
    const r = findText(content, "function f() {\n  return 1;\n}", SPACE4);
    assert.equal(r.found, true);
    assert.equal(r.tier, MatchTier.INDENTATION);
    assert.equal(r.numericFuzz, 1);
  });

  it("unicode tier maps smart quotes back to original coordinates", () => {
    const content = "const s = \u201chello\u201d;\n";
    const r = findText(content, 'const s = "hello";', SPACE4);
    assert.equal(r.found, true);
    assert.equal(r.tier, MatchTier.UNICODE);
    assert.equal(r.numericFuzz, 2);
    assert.equal(r.matchedText, content.slice(0, r.matchLength));
    assert.equal(r.index, 0);
  });

  it("comment-prefix tier strips // with numericFuzz 2.5", () => {
    const lines = [
      "// first comment line here",
      "// second comment line here",
      "// third comment line here",
    ];
    const content = lines.join("\n") + "\n";
    const oldText = lines.map((l) => l.slice(2)).join("\n");
    const r = findText(content, oldText, SPACE4);
    assert.equal(r.found, true);
    assert.equal(r.tier, MatchTier.COMMENT_PREFIX);
    assert.equal(r.numericFuzz, 2.5);
  });

  it("similarity tier rescues near-matches, disabled by allowFuzzy=false", () => {
    const content = [
      "function helloWorld() {",
      "  const x = 1;",
      "  console.log(\"hello\");",
      "  return x;",
      "}",
    ].join("\n");
    const near = content.replace("helloWorld", "hulloWorld");
    const hit = findText(content, near, SPACE4);
    assert.equal(hit.found, true);
    assert.equal(hit.tier, MatchTier.SIMILARITY);
    assert.equal(hit.numericFuzz, 3);
    const miss = findText(content, near, SPACE4, 0, undefined, false);
    assert.equal(miss.found, false);
    assert.equal(miss.numericFuzz, -1);
  });

  it("stripped-indent tier rescues scope-shifted blocks with numericFuzz 5", () => {
    const content = [
      "function outer() {",
      "    function inner() {",
      "        const valueOne = computeFirst();",
      "        const valueTwo = computeSecond();",
      "        return valueOne + valueTwo;",
      "    }",
      "}",
    ].join("\n");
    const oldText = [
      "function inner() {",
      "const valueOne = computeFirst();",
      "const valueTwo = computeSecond();",
      "return valueOne + valueTwo;",
      "}",
    ].join("\n");
    const r = findText(content, oldText, SPACE4);
    assert.equal(r.found, true);
    assert.equal(r.tier, MatchTier.RELATIVE_INDENT);
    assert.equal(r.numericFuzz, 5);
  });

  it("telemetry reports all six tiers in order on a miss", () => {
    const { result, telemetry } = findTextWithTelemetry(
      "aaa\nbbb\nccc\n",
      "zzz-not-present\n",
      SPACE4,
    );
    assert.equal(result.found, false);
    assert.deepEqual(
      telemetry.map((t: TierTelemetry) => t.tier),
      [
        MatchTier.EXACT,
        MatchTier.INDENTATION,
        MatchTier.UNICODE,
        MatchTier.COMMENT_PREFIX,
        MatchTier.SIMILARITY,
        MatchTier.RELATIVE_INDENT,
      ],
    );
    assert.ok(telemetry.every((t: TierTelemetry) => !t.success));
  });

  it("telemetry stops at the winning tier", () => {
    const { telemetry } = findTextWithTelemetry("abc", "abc", SPACE4);
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0].tier, MatchTier.EXACT);
    assert.equal(telemetry[0].success, true);
  });
});

describe("edit-match bulk + ambiguity counters", () => {
  it("findAllMatches returns every non-overlapping occurrence", () => {
    const content = "let v = 1;\nlet v = 1;\n";
    const style = detectIndentation(content);
    const all = findAllMatches(content, "let v = 1;", style, MatchTier.EXACT);
    assert.equal(all.length, 2);
    assert.equal(all[0].index, 0);
  });

  it("countOccurrences counts exact repeats", () => {
    assert.equal(countOccurrences("ab\nab\nab\n", "ab"), 3);
    assert.equal(countOccurrences("ab\n", "zz"), 0);
  });

  it("countSimilarityOccurrences flags duplicated near-match windows", () => {
    const block = ["const alpha = 1;", "const beta = 2;", "return alpha;"].join("\n");
    const content = [block, block].join("\n");
    const { count, bestScore, secondBestScore } = countSimilarityOccurrences(content, block);
    assert.ok(count >= 2);
    assert.ok(bestScore >= 0.85);
    assert.ok(secondBestScore >= 0.85);
  });

  it("isDominantFuzzyMatch needs 97% best and 8% delta", () => {
    assert.equal(isDominantFuzzyMatch(0.98, 0.85), true);
    assert.equal(isDominantFuzzyMatch(0.96, 0.5), false);
    assert.equal(isDominantFuzzyMatch(0.99, 0.95), false);
  });
});

describe("edit-match diagnostics", () => {
  it("findClosestMatch points at the near-miss line with a hint", () => {
    const content = "function hello() {\n  return 1;\n}\n";
    const diag = findClosestMatch(content, "function hello() {\n  return 2;\n}");
    assert.ok(diag !== null);
    assert.equal(diag.lineStart, 1);
    assert.ok(diag.similarity >= 0.3);
    assert.ok(diag.hint.length > 0);
  });

  it("findClosestMatch returns null for empty or unrelated input", () => {
    assert.equal(findClosestMatch("", "x"), null);
    assert.equal(findClosestMatch("abc", ""), null);
    assert.equal(findClosestMatch("aaaa", "zzzz qqqq wwww"), null);
  });

  it("textSimilarityRatio is 1 for identical text", () => {
    assert.equal(textSimilarityRatio("hello", "hello"), 1);
    assert.ok(textSimilarityRatio("hello", "world") < 1);
  });
});

describe("edit-match normalization + adaptation", () => {
  it("normalizeForFuzzyMatch preserves line count", () => {
    const out = normalizeForFuzzyMatch("a  \nb\u2019c\n");
    assert.equal(out.split("\n").length, 3);
    assert.equal(out, "a\nb'c\n");
  });

  it("detectIndentation distinguishes tabs from spaces", () => {
    assert.equal(detectIndentation("\tx\n\ty\n").char, "\t");
    const two = detectIndentation("if (x) {\n  go();\n}\n");
    assert.deepEqual(two, { char: " ", width: 2 });
  });

  it("adaptNewTextIndentation converts model indent to file style", () => {
    const out = adaptNewTextIndentation(
      "if (x) {\n  go();\n}",
      "if (x) {\n  go();\n}",
      SPACE4,
      "if (x) {\n    go();\n}",
    );
    assert.ok(out.includes("    go();"));
  });

  it("preserveQuoteStyle skips code files but converts prose", () => {
    const file = "const s = \u201chello\u201d;\n";
    const ascii = 'const s = "hello";';
    assert.equal(preserveQuoteStyle(ascii, file, 0, file.length, "a.ts"), ascii);
    const converted = preserveQuoteStyle("say 'hi' loudly", "\u2018hi\u2019", 0, 4, "doc.md");
    assert.ok(converted.includes("\u2018"));
  });

  it("comment style detection needs a consistent prefix", () => {
    assert.deepEqual(detectCommentStyle("// a\n// b\n// c\n")?.prefix, "//");
    assert.equal(detectCommentStyle("plain\ntext\n"), null);
    assert.equal(
      stripCommentPrefixes("// a\n  // b\n", "//"),
      " a\n   b\n",
    );
  });

  it("materializeDotdotdots returns null without ellipses", () => {
    assert.equal(
      materializeDotdotdots("aaa", "bbb", "aaa"),
      null,
    );
  });

  it("materializeDotdotdots spans file text between unique segments", () => {
    const content = "head one\nmiddle gap here\ntail nine\n";
    const m = materializeDotdotdots("head one\n...\ntail nine\n", "head one\n...\ntail nine!\n", content);
    assert.ok(m !== null);
    assert.equal(m.materializedOld, content);
    assert.ok(m.materializedNew.endsWith("tail nine!\n"));
  });

  it("$ patterns pass through matching untouched", () => {
    const content = "price is $& total\n";
    const r = findText(content, "price is $& total", SPACE4);
    assert.equal(r.found, true);
    assert.equal(r.matchedText, "price is $& total");
  });
});
