import assert from "assert";
import { describe, it } from "node:test";

import {
  getSmartEditRuntimeConfig,
  parseBooleanEnv,
} from "../src/edit-mode.js";
import { resolveEditPath } from "../src/index.js";

describe("edit path resolution", () => {
  it("resolves parent-directory paths instead of rejecting them", () => {
    assert.strictEqual(
      resolveEditPath("/repo/workspace", "../outside.txt"),
      "/repo/outside.txt",
    );
  });
});

describe("edit mode config", () => {
  it("defaults to oldText/newText matching with fuzzy rescue enabled", () => {
    assert.deepStrictEqual(getSmartEditRuntimeConfig({}), {
      useHashlineEditing: false,
      allowFuzzyMatching: true,
    });
  });

  it("allows fuzzy matching to be explicitly disabled", () => {
    assert.strictEqual(
      getSmartEditRuntimeConfig({ SMART_EDIT_FUZZY_MATCHING: "false" }).allowFuzzyMatching,
      false,
    );
    assert.strictEqual(
      getSmartEditRuntimeConfig({ SMART_EDIT_FUZZY_MATCHING: "0" }).allowFuzzyMatching,
      false,
    );
  });

  it("enables hashline editing when the env flag is truthy", () => {
    assert.deepStrictEqual(
      getSmartEditRuntimeConfig({ SMART_EDIT_USE_HASHLINE_EDITING: "true" }),
      { useHashlineEditing: true, allowFuzzyMatching: true },
    );
    assert.deepStrictEqual(
      getSmartEditRuntimeConfig({ SMART_EDIT_HASHLINE_EXPERIMENTAL: "1" }),
      { useHashlineEditing: true, allowFuzzyMatching: true },
    );
  });

  it("parses boolean env values consistently", () => {
    assert.strictEqual(parseBooleanEnv("1"), true);
    assert.strictEqual(parseBooleanEnv("yes"), true);
    assert.strictEqual(parseBooleanEnv("on"), true);
    assert.strictEqual(parseBooleanEnv("0"), false);
    assert.strictEqual(parseBooleanEnv("off"), false);

    // Edge cases
    assert.strictEqual(parseBooleanEnv(""), false);
    assert.strictEqual(parseBooleanEnv("  "), false);
    assert.strictEqual(parseBooleanEnv("TRUE"), true);
    assert.strictEqual(parseBooleanEnv("Yes"), true);
    assert.strictEqual(parseBooleanEnv("maybe"), false);
  });
});
