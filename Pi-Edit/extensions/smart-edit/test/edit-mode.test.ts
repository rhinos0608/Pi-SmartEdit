import assert from "assert";
import { describe, it } from "node:test";

import {
  getSmartEditRuntimeConfig,
  parseBooleanEnv,
} from "../src/edit-mode.js";

describe("edit mode config", () => {
  it("defaults to the oldText/newText path", () => {
    assert.deepStrictEqual(getSmartEditRuntimeConfig({}), {
      useHashlineEditing: false,
    });
  });

  it("enables hashline editing when the env flag is truthy", () => {
    assert.deepStrictEqual(
      getSmartEditRuntimeConfig({ SMART_EDIT_USE_HASHLINE_EDITING: "true" }),
      { useHashlineEditing: true },
    );
    assert.deepStrictEqual(
      getSmartEditRuntimeConfig({ SMART_EDIT_HASHLINE_EXPERIMENTAL: "1" }),
      { useHashlineEditing: true },
    );
  });

  it("parses boolean env values consistently", () => {
    assert.strictEqual(parseBooleanEnv("1"), true);
    assert.strictEqual(parseBooleanEnv("yes"), true);
    assert.strictEqual(parseBooleanEnv("on"), true);
    assert.strictEqual(parseBooleanEnv("0"), false);
    assert.strictEqual(parseBooleanEnv("off"), false);
  });
});
