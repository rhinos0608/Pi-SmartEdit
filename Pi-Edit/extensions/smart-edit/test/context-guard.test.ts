import { describe, it } from "node:test";
import assert from "node:assert";
import { checkContextGuardSimilarity, CONTEXT_GUARD_SIMILARITY_THRESHOLD } from "../src/safety/context-guard";
import { textSimilarityRatio } from "../lib/edit-diff";

const block = [
  "function buildConfig() {",
  "  const retries = 3;",
  "  const timeoutMs = 1000;",
  "  const endpoint = \"https://example.com/api\";",
  "  const enabled = true;",
  "  return { retries, timeoutMs, endpoint, enabled };",
  "}",
].join("\n");

describe("context guard similarity", () => {
  it("allows exact oldText when context guard would otherwise be missing", () => {
    const result = checkContextGuardSimilarity(block, [{ oldText: block, newText: "" }]);

    assert.strictEqual(result.allowed, true);
    assert.match(result.notes[0], /100\.0% similarity/);
  });

  it("allows indentation-equivalent oldText above the default threshold", () => {
    const tabbed = block.replace(/^  /gm, "\t");
    const result = checkContextGuardSimilarity(tabbed, [{ oldText: block, newText: "" }]);

    assert.strictEqual(result.allowed, true);
  });

  it("rejects edits without comparable oldText", () => {
    const result = checkContextGuardSimilarity(block, [{ oldText: "", newText: "" }]);

    assert.strictEqual(result.allowed, false);
    assert.match(result.reason ?? "", /no oldText/);
  });

  it("allows near matches above the default threshold", () => {
    const expected = block.replace("https://example.com/api", "https://example.com/changed");

    assert.ok(textSimilarityRatio(expected, block) > CONTEXT_GUARD_SIMILARITY_THRESHOLD);
    assert.strictEqual(checkContextGuardSimilarity(block, [{ oldText: expected, newText: "" }]).allowed, true);
  });

  it("rejects oldText below the default threshold", () => {
    const expected = block.replace("https://example.com/api", "https://changed.example.org/api");

    assert.ok(textSimilarityRatio(expected, block) < CONTEXT_GUARD_SIMILARITY_THRESHOLD);
    assert.strictEqual(checkContextGuardSimilarity(block, [{ oldText: expected, newText: "" }]).allowed, false);
  });

  it("rejects matches below caller threshold", () => {
    const result = checkContextGuardSimilarity(
      block,
      [{ oldText: block, newText: "" }],
      [],
      CONTEXT_GUARD_SIMILARITY_THRESHOLD + 0.06,
    );

    assert.strictEqual(result.allowed, false);
    assert.match(result.reason ?? "", /below 101% threshold/);
  });
});
