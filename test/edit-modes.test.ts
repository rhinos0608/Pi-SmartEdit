import { test } from "node:test";
import assert from "node:assert/strict";

import { getEditModeSpec, getActiveEditMode } from "../src/edit-modes/index.js";
import { TEXT_EDIT_PARAMETERS } from "../src/edit-modes/text.js";
import { HASHLINE_EDIT_PARAMETERS } from "../src/edit-modes/hashline.js";

test("text schema exposes exactly {path, edits} with scoped item keys", () => {
    const params = TEXT_EDIT_PARAMETERS as unknown as {
        properties: Record<string, unknown>;
        required: string[];
    };
    assert.deepEqual(Object.keys(params.properties).sort(), ["edits", "path"]);
    assert.deepEqual(params.required, ["edits"]);
    const edits = params.properties.edits as { items: { properties: Record<string, unknown> } };
    assert.deepEqual(Object.keys(edits.items.properties).sort(), [
        "description",
        "newText",
        "oldText",
        "path",
        "replaceAll",
        "scope",
    ]);
});

test("hashline schema unchanged: only {path, edits} with {path, hashline} items", () => {
    const params = HASHLINE_EDIT_PARAMETERS as unknown as {
        properties: Record<string, unknown>;
        required: string[];
    };
    assert.deepEqual(Object.keys(params.properties).sort(), ["edits", "path"]);
    assert.deepEqual(params.required, ["edits"]);
    const edits = params.properties.edits as {
        items: { properties: Record<string, unknown>; required: string[] };
    };
    assert.deepEqual(Object.keys(edits.items.properties).sort(), ["hashline", "path"]);
    assert.deepEqual(edits.items.required, ["hashline"]);
});

test("text validator rejects raw, refactor, hashline, lineRange, target keys", () => {
    const spec = getEditModeSpec("text");
    for (const bad of ["raw", "refactor", "hashline", "lineRange", "target"] as const) {
        const edit: Record<string, unknown> =
            bad === "hashline"
                ? { oldText: "x", newText: "y", hashline: { range: { pos: "1ab", end: "1ab" } } }
                : bad === "lineRange"
                    ? { oldText: "x", newText: "y", lineRange: { startLine: 1, endLine: 1 } }
                    : bad === "target"
                        ? { oldText: "x", newText: "y", target: { name: "f" } }
                        : bad === "raw"
                            ? {}
                            : {};
        const input =
            bad === "raw"
                ? { path: "a.ts", raw: "--- a\n+++ b" }
                : bad === "refactor"
                    ? { refactor: { kind: "rename-preview", path: "a.ts", line: 1, character: 1, newName: "b" } }
                    : { path: "a.ts", edits: [edit] };
        const v = spec.validate(input);
        assert.ok(!v.ok, `${bad} must be rejected in text mode`);
        assert.match(v.error, /not supported in text edit mode/);
    }
});

test("hashline validator rejects text-mode fields", () => {
    const spec = getEditModeSpec("hashline");
    const v = spec.validate({ path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });
    assert.ok(!v.ok);
    assert.match(v.error, /must use hashline metadata/);
});

test("text scope maps to internal target", () => {
    const spec = getEditModeSpec("text");
    const v = spec.validate({
        path: "a.ts",
        edits: [{ oldText: "x", newText: "y", scope: { name: "foo" } }],
    });
    assert.ok(v.ok, `scoped edit must validate (got: ${v.ok ? "" : v.error})`);
    const edit = v.value.edits![0] as unknown as Record<string, unknown>;
    assert.deepEqual(edit.target, { name: "foo" });
    assert.ok(!("scope" in edit), "scope must be mapped, not passed through");
});

test("text prepareArguments strips consecutive N| blocks, leaves partial ones", () => {
    const spec = getEditModeSpec("text");
    const stripped = spec.prepareArguments({
        path: "a.ts",
        edits: [{ oldText: "12|alpha\n13|beta\n", newText: "x" }],
    }) as { edits: Array<{ oldText: string }> };
    assert.equal(stripped.edits[0]!.oldText, "alpha\nbeta\n");

    const partial = spec.prepareArguments({
        path: "a.ts",
        edits: [{ oldText: "12|alpha\nplain\n", newText: "x" }],
    }) as { edits: Array<{ oldText: string }> };
    assert.equal(partial.edits[0]!.oldText, "12|alpha\nplain\n");

    const nonConsecutive = spec.prepareArguments({
        path: "a.ts",
        edits: [{ oldText: "12|alpha\n15|beta\n", newText: "x" }],
    }) as { edits: Array<{ oldText: string }> };
    assert.equal(nonConsecutive.edits[0]!.oldText, "12|alpha\n15|beta\n");

    // A single N|-shaped line may be genuine content; stripping it could
    // redirect the match to different text, so it is left untouched.
    for (const oldText of ["1|x", "1|x\n"]) {
        const single = spec.prepareArguments({
            path: "a.ts",
            edits: [{ oldText, newText: "y" }],
        }) as { edits: Array<{ oldText: string }> };
        assert.equal(single.edits[0]!.oldText, oldText);
    }
});

test("hashline prepareArguments is identity", () => {
    const spec = getEditModeSpec("hashline");
    const input = { path: "a.ts", edits: [{ hashline: { range: { pos: "1ab", end: "1ab" }, content: "x" } }] };
    assert.equal(spec.prepareArguments(input), input);
});

test("getActiveEditMode resolves text by default, hashline via PI_EDIT_MODE", () => {
    assert.equal(getActiveEditMode({}).id, "text");
    assert.equal(getActiveEditMode({ PI_EDIT_MODE: "hashline" }).id, "hashline");
    assert.equal(getActiveEditMode({ SMART_EDIT_USE_HASHLINE_EDITING: "1" }).id, "hashline");
});
