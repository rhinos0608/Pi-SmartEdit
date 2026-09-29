import assert from "assert";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import {
    getSmartEditRuntimeConfig,
    parseBooleanEnv,
} from "../src/config/edit-mode.js";
import { loadConfig } from "../src/config/schema.js";
import { resolveEditPath } from "../src/index.js";

describe("edit path resolution", () => {
    it("resolves parent-directory paths instead of rejecting them", () => {
        assert.strictEqual(
            resolveEditPath("/repo/workspace", "../outside.txt"),
            resolve("/repo/workspace", "../outside.txt"),
        );
    });
});

describe("edit mode config", () => {
    it("defaults to the text dialect with fuzzy rescue enabled", () => {
        assert.deepStrictEqual(getSmartEditRuntimeConfig({}), {
            useHashlineEditing: false,
            allowFuzzyMatching: true,
        });
        assert.equal(loadConfig({}).editMode, "text");
        assert.equal(loadConfig({}).editModeWarning, undefined);
    });

    it("selects hashline via PI_EDIT_MODE", () => {
        assert.equal(loadConfig({ PI_EDIT_MODE: "hashline" }).editMode, "hashline");
        assert.deepStrictEqual(getSmartEditRuntimeConfig({ PI_EDIT_MODE: "hashline" }), {
            useHashlineEditing: true,
            allowFuzzyMatching: true,
        });
    });

    it("PI_EDIT_MODE wins over legacy flags", () => {
        assert.equal(
            loadConfig({ PI_EDIT_MODE: "text", SMART_EDIT_USE_HASHLINE_EDITING: "1" }).editMode,
            "text",
        );
    });

    it("honours legacy flags when PI_EDIT_MODE is unset", () => {
        assert.deepStrictEqual(
            getSmartEditRuntimeConfig({ SMART_EDIT_USE_HASHLINE_EDITING: "true" }),
            { useHashlineEditing: true, allowFuzzyMatching: true },
        );
        assert.deepStrictEqual(
            getSmartEditRuntimeConfig({ SMART_EDIT_HASHLINE_EXPERIMENTAL: "1" }),
            { useHashlineEditing: true, allowFuzzyMatching: true },
        );
    });

    it("invalid PI_EDIT_MODE falls back to text with a warning naming the value", () => {
        const config = loadConfig({ PI_EDIT_MODE: "bogus" });
        assert.equal(config.editMode, "text");
        assert.match(config.editModeWarning ?? "", /bogus/);
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
