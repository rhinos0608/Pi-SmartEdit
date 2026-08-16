/**
 * Canonical edit contract tests.
 *
 * Verifies:
 *   - The registered `edit` tool advertises the canonical SmartEdit-owned
 *     schema (targeted edits plus target/lineRange/hashline and mutually
 *     exclusive `raw`) from one source.
 *   - The agent-visible schema omits `evidenceRef` (tool-owned authority).
 *   - `validateEditRequest` accepts current edit arrays and rich fields,
 *     rejects `raw`+`edits`, and does not require `evidenceRef`.
 *   - `normalizeLegacyEditRequest` preserves flat/resumed compatibility.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import smartEdit from "../src/index.js";
import {
    validateEditRequest,
    normalizeLegacyEditRequest,
} from "../src/edit-contract.js";

// ── Minimal mock capturing registration ─────────────────────────────

type ToolRegistration = {
    name: string;
    parameters?: Record<string, unknown>;
    prepareArguments?: (args: unknown) => unknown;
    [key: string]: unknown;
};

function createMockPI() {
    const _tools = new Map<string, ToolRegistration>();
    const _events = new Map<string, Set<(...a: unknown[]) => unknown>>();
    const bus = {
        subs: new Map<string, Set<(d: unknown) => void>>(),
        emit(channel: string, data: unknown) {
            const set = this.subs.get(channel);
            if (!set) return;
            for (const h of [...set]) h(data);
        },
        on(channel: string, handler: (d: unknown) => void) {
            if (!this.subs.has(channel)) this.subs.set(channel, new Set());
            this.subs.get(channel)!.add(handler);
            return () => { this.subs.get(channel)?.delete(handler); };
        },
    };
    return {
        _tools,
        _events,
        events: {
            emit: bus.emit.bind(bus),
            on: bus.on.bind(bus),
        },
        on(event: string, handler: (...a: unknown[]) => unknown) {
            if (!_events.has(event)) _events.set(event, new Set());
            _events.get(event)!.add(handler);
        },
        registerTool(tool: ToolRegistration) {
            _tools.set(tool.name, tool);
        },
    };
}

function init(pi: ReturnType<typeof createMockPI>): void {
    smartEdit(pi as never);
}

function registeredEditParams(): Record<string, unknown> {
    const pi = createMockPI();
    init(pi);
    const editTool = pi._tools.get("edit");
    assert.ok(editTool, "edit tool must be registered");
    assert.ok(editTool.parameters, "edit tool must expose parameters");
    return editTool.parameters;
}

// ── Registration-level schema parity ────────────────────────────────

test("registered edit schema advertises raw, target, lineRange, hashline and hides evidenceRef", () => {
    const params = registeredEditParams();
    const properties = params.properties as Record<string, unknown>;

    assert.ok(properties.raw, "schema must advertise mutually exclusive `raw` input");
    assert.ok(properties.edits, "schema must advertise `edits` array");

    const edits = properties.edits as { items?: { properties?: Record<string, unknown> } };
    const editProps = edits.items?.properties ?? {};
    assert.ok(editProps.target, "edit items must advertise `target`");
    assert.ok(editProps.lineRange, "edit items must advertise `lineRange`");
    assert.ok(editProps.hashline, "edit items must advertise `hashline`");

    assert.ok(!("evidenceRef" in properties), "agent-visible schema must not advertise `evidenceRef`");
});

test("registered edit schema advertises nested target fields", () => {
    const params = registeredEditParams();
    const properties = params.properties as Record<string, unknown>;
    const edits = properties.edits as { items?: { properties?: Record<string, unknown> } };
    const target = edits.items?.properties?.target as { properties?: Record<string, unknown> };
    assert.ok(target, "target must be advertised");
    const targetProps = target.properties ?? {};
    for (const field of ["name", "namePath", "kind", "line", "replaceBody", "insertBefore", "insertAfter", "description", "pattern", "replacement"]) {
        assert.ok(targetProps[field], `target must advertise nested field \`${field}\``);
    }
});

test("registered edit schema advertises nested lineRange and hashline fields", () => {
    const params = registeredEditParams();
    const properties = params.properties as Record<string, unknown>;
    const edits = properties.edits as { items?: { properties?: Record<string, unknown> } };
    const editProps = edits.items?.properties ?? {};

    const lineRange = editProps.lineRange as { properties?: Record<string, unknown> };
    assert.ok(lineRange.properties?.startLine, "lineRange must advertise startLine");
    assert.ok(lineRange.properties?.endLine, "lineRange must advertise endLine");

    const hashline = editProps.hashline as { properties?: Record<string, unknown> };
    const hashlineProps = hashline.properties ?? {};
    assert.ok(hashlineProps.range, "hashline must advertise range");
    const range = hashlineProps.range as { properties?: Record<string, unknown> };
    assert.ok(range.properties?.pos, "hashline.range must advertise pos");
    assert.ok(range.properties?.end, "hashline.range must advertise end");
    assert.ok(hashlineProps.content, "hashline must advertise content");
    assert.ok(hashlineProps.symbol, "hashline must advertise symbol");
});

test("registered edit schema advertises legacy anchor compatibility field", () => {
    const params = registeredEditParams();
    const properties = params.properties as Record<string, unknown>;
    const edits = properties.edits as { items?: { properties?: Record<string, unknown> } };
    const anchor = edits.items?.properties?.anchor as { properties?: Record<string, unknown> };
    assert.ok(anchor, "edit items must advertise legacy `anchor` compatibility field");
    const anchorProps = anchor.properties ?? {};
    assert.ok(anchorProps.symbolName, "anchor must advertise symbolName");
    assert.ok(anchorProps.symbolKind, "anchor must advertise symbolKind");
    assert.ok(anchorProps.symbolLine, "anchor must advertise symbolLine");
});

test("registered edit schema omits top-level oneOf for Anthropic input_schema compat", () => {
    const params = registeredEditParams();
    assert.ok(!("oneOf" in params), "top-level oneOf is rejected by the Anthropic API");
    assert.ok(!("anyOf" in params), "top-level anyOf is rejected by the Anthropic API");
    assert.ok(!("allOf" in params), "top-level allOf is rejected by the Anthropic API");
});

test("registered edit tool keeps prepareArguments compatibility shim", () => {
    const pi = createMockPI();
    init(pi);
    const editTool = pi._tools.get("edit")!;
    assert.equal(typeof editTool.prepareArguments, "function",
        "edit tool must keep prepareArguments for session resume compat");
});

// ── validateEditRequest ─────────────────────────────────────────────

test("validateEditRequest accepts current edits array", () => {
    const v = validateEditRequest({
        path: "a.ts",
        edits: [{ oldText: "x", newText: "y" }],
        toolCallId: "t",
    });
    assert.ok(v.ok, `current edits array must validate (got: ${v.ok ? "" : v.error})`);
});

test("validateEditRequest accepts rich fields (target, lineRange, hashline)", () => {
    const v = validateEditRequest({
        path: "a.ts",
        edits: [{
            oldText: "x",
            newText: "y",
            target: { name: "foo" },
            lineRange: { startLine: 1, endLine: 5 },
            hashline: { range: { pos: "1ab", end: "1ab" } },
        }],
        toolCallId: "t",
    });
    assert.ok(v.ok, `rich edit must validate (got: ${v.ok ? "" : v.error})`);
});

test("validateEditRequest rejects raw+edits as mutually exclusive", () => {
    const v = validateEditRequest({
        path: "a.ts",
        edits: [{ oldText: "x", newText: "y" }],
        raw: "--- a\n+++ b",
        toolCallId: "t",
    });
    assert.ok(!v.ok, "raw and edits must be mutually exclusive");
    assert.match(v.error, /mutually exclusive/);
});

test("validateEditRequest accepts raw alone", () => {
    const v = validateEditRequest({
        path: "a.ts",
        raw: "--- a\n+++ b",
        toolCallId: "t",
    });
    assert.ok(v.ok, `raw-only request must validate (got: ${v.ok ? "" : v.error})`);
});

test("validateEditRequest does not require evidenceRef (tool-owned authority)", () => {
    const v = validateEditRequest({
        path: "a.ts",
        edits: [{ oldText: "x", newText: "y" }],
        toolCallId: "t",
    });
    assert.ok(v.ok, "evidenceRef must be optional — authority is tool-owned");
});

test("validateEditRequest rejects malformed lineRange", () => {
    const v = validateEditRequest({
        path: "a.ts",
        edits: [{ oldText: "x", newText: "y", lineRange: { startLine: 5, endLine: 1 } }],
        toolCallId: "t",
    });
    assert.ok(!v.ok, "endLine < startLine must be rejected");
});

// ── normalizeLegacyEditRequest ──────────────────────────────────────

test("normalizeLegacyEditRequest converts flat oldText/newText to edits array", () => {
    const result = normalizeLegacyEditRequest({ path: "a.ts", oldText: "x", newText: "y" });
    assert.deepEqual(result.edits, [{ oldText: "x", newText: "y" }]);
    assert.equal(result.path, "a.ts");
});

test("normalizeLegacyEditRequest passes through edits-array calls unchanged", () => {
    const input = { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] };
    assert.equal(normalizeLegacyEditRequest(input), input);
});

test("normalizeLegacyEditRequest flat fields overwrite existing edits", () => {
    const result = normalizeLegacyEditRequest({
        path: "a.ts",
        oldText: "legacy",
        newText: "new",
        edits: [{ oldText: "existing", newText: "replacement" }],
    });
    const edits = result.edits as Array<{ oldText: string; newText: string }>;
    assert.equal(edits.length, 1, "flat oldText/newText is authoritative");
    assert.equal(edits[0].oldText, "legacy");
    assert.equal(edits[0].newText, "new");
});

test("normalizeLegacyEditRequest moves top-level replaceAll into generated item", () => {
    const result = normalizeLegacyEditRequest({
        path: "a.ts",
        oldText: "x",
        newText: "y",
        replaceAll: true,
    });
    assert.deepEqual(result.edits, [{ oldText: "x", newText: "y", replaceAll: true }]);
    assert.ok(!("replaceAll" in result), "top-level replaceAll must be moved into the item, not left ignored");
});

test("normalizeLegacyEditRequest removes stale top-level oldText/newText", () => {
    const result = normalizeLegacyEditRequest({ path: "a.ts", oldText: "x", newText: "y" });
    assert.ok(!("oldText" in result), "stale top-level oldText must be removed");
    assert.ok(!("newText" in result), "stale top-level newText must be removed");
    assert.deepEqual(result.edits, [{ oldText: "x", newText: "y" }]);
});

test("top-level replaceAll defaults only edit items that omit it", () => {
    const v = validateEditRequest({
        path: "a.ts",
        replaceAll: true,
        edits: [
            { oldText: "x", newText: "y" },
            { oldText: "a", newText: "b", replaceAll: false },
        ],
    });
    assert.ok(v.ok, `top-level replaceAll request must validate (got: ${v.ok ? "" : v.error})`);
    assert.equal(v.value.replaceAll, undefined, "compatibility field must be consumed");
    assert.deepEqual(v.value.edits?.map((edit) => edit.replaceAll), [true, false]);
});

// ── Malformed rich-field rejection ──────────────────────────────────

test("validateEditRequest rejects malformed target identifiers and types", () => {
    const cases: Array<{ target: Record<string, unknown>; match: RegExp }> = [
        { target: { name: 42 }, match: /target\.name must be a string/ },
        { target: { namePath: 42 }, match: /target\.namePath must be a string/ },
        { target: { kind: 42 }, match: /target\.kind must be a string/ },
        { target: { replaceBody: 42 }, match: /target\.replaceBody must be a string/ },
        { target: { pattern: 42 }, match: /target\.pattern must be a string/ },
        { target: { replacement: 42 }, match: /target\.replacement must be a string/ },
    ];
    for (const c of cases) {
        const v = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", target: c.target }] });
        assert.ok(!v.ok, `target ${JSON.stringify(c.target)} must be rejected`);
        assert.match(v.error, c.match);
    }
});

test("validateEditRequest rejects non-positive-integer target.line", () => {
    for (const line of [0, -1, 1.5, "3"]) {
        const v = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", target: { name: "f", line } }] });
        assert.ok(!v.ok, `target.line ${JSON.stringify(line)} must be rejected`);
        assert.match(v.error, /target\.line must be a positive integer/);
    }
});

test("validateEditRequest rejects target without identifier or structural pattern", () => {
    const v = validateEditRequest({
        path: "a.ts",
        edits: [{ oldText: "x", newText: "y", target: { replaceBody: "body" } }],
    });
    assert.ok(!v.ok, "symbolic target without identifier must be rejected");
    assert.match(v.error, /requires name, namePath, or line/);
});

test("validateEditRequest rejects more than one symbolic operation in target", () => {
    const v = validateEditRequest({
        path: "a.ts",
        edits: [{ oldText: "x", newText: "y", target: { name: "f", replaceBody: "a", insertBefore: "b" } }],
    });
    assert.ok(!v.ok, "multiple symbolic operations must be rejected");
    assert.match(v.error, /at most one of replaceBody, insertBefore, insertAfter/);
});

test("validateEditRequest rejects unpaired pattern/replacement in target", () => {
    const onlyPattern = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", target: { pattern: "a" } }] });
    assert.ok(!onlyPattern.ok, "pattern without replacement must be rejected");
    assert.match(onlyPattern.error, /pattern and replacement must be provided together/);

    const onlyReplacement = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", target: { replacement: "b" } }] });
    assert.ok(!onlyReplacement.ok, "replacement without pattern must be rejected");
    assert.match(onlyReplacement.error, /pattern and replacement must be provided together/);
});

test("validateEditRequest rejects malformed hashline range anchors", () => {
    const cases: Array<{ hashline: Record<string, unknown>; match: RegExp }> = [
        { hashline: {}, match: /hashline\.range must be an object/ },
        { hashline: { range: {} }, match: /hashline\.range\.pos must be a non-empty string/ },
        { hashline: { range: { pos: "1ab" } }, match: /hashline\.range\.end must be a non-empty string/ },
        { hashline: { range: { pos: "", end: "1ab" } }, match: /hashline\.range\.pos must be a non-empty string/ },
        { hashline: { range: { pos: "1ab", end: 42 } }, match: /hashline\.range\.end must be a non-empty string/ },
    ];
    for (const c of cases) {
        const v = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", hashline: c.hashline }] });
        assert.ok(!v.ok, `hashline ${JSON.stringify(c.hashline)} must be rejected`);
        assert.match(v.error, c.match);
    }
});

test("validateEditRequest rejects malformed hashline content type", () => {
    for (const content of [42, { a: 1 }, ["ok", 42]]) {
        const v = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", hashline: { range: { pos: "1ab", end: "1ab" }, content } }] });
        assert.ok(!v.ok, `hashline.content ${JSON.stringify(content)} must be rejected`);
        assert.match(v.error, /hashline\.content must be a string, array of strings, or null/);
    }
});

test("validateEditRequest rejects malformed hashline symbol shape", () => {
    const missingName = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", hashline: { range: { pos: "1ab", end: "1ab" }, symbol: { kind: "function" } } }] });
    assert.ok(!missingName.ok, "hashline.symbol.name must be required");
    assert.match(missingName.error, /hashline\.symbol\.name must be a non-empty string/);

    const badName = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", hashline: { range: { pos: "1ab", end: "1ab" }, symbol: { name: 42 } } }] });
    assert.ok(!badName.ok, "hashline.symbol.name must be a string");
    assert.match(badName.error, /hashline\.symbol\.name must be a non-empty string/);

    const badLine = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", hashline: { range: { pos: "1ab", end: "1ab" }, symbol: { name: "f", line: 0 } } }] });
    assert.ok(!badLine.ok, "hashline.symbol.line must be a positive integer");
    assert.match(badLine.error, /hashline\.symbol\.line must be a positive integer/);
});

test("validateEditRequest rejects unknown nested fields", () => {
    const badEdit = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", unexpected: true }] });
    assert.ok(!badEdit.ok);
    assert.match(badEdit.error, /unexpected is not supported/);

    const badTarget = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", target: { name: "f", unexpected: true } }] });
    assert.ok(!badTarget.ok);
    assert.match(badTarget.error, /target\.unexpected is not supported/);
});

test("validateEditRequest accepts valid legacy anchor and rejects malformed anchor", () => {
    const valid = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", anchor: { symbolName: "f", symbolKind: "function", symbolLine: 3 } }] });
    assert.ok(valid.ok, "valid legacy anchor must be accepted");

    const badName = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", anchor: { symbolName: 42 } }] });
    assert.ok(!badName.ok, "anchor.symbolName must be a string");
    assert.match(badName.error, /anchor\.symbolName must be a string/);

    const badLine = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x", newText: "y", anchor: { symbolLine: 0 } }] });
    assert.ok(!badLine.ok, "anchor.symbolLine must be a positive integer");
    assert.match(badLine.error, /anchor\.symbolLine must be a positive integer/);
});

test("validateEditRequest rejects unknown lineRange keys", () => {
    const v = validateEditRequest({
        path: "a.ts",
        edits: [{ oldText: "x", newText: "y", lineRange: { startLine: 1, endLine: 5, unexpected: true } }],
        toolCallId: "t",
    });
    assert.ok(!v.ok, "lineRange must reject unknown keys");
    assert.match(v.error, /lineRange\.unexpected is not supported/);
});

test("validateEditRequest rejects no-action / description-only edit items", () => {
    for (const edit of [{}, { description: "noop" }]) {
        const v = validateEditRequest({ path: "a.ts", edits: [edit], toolCallId: "t" });
        assert.ok(!v.ok, `edit ${JSON.stringify(edit)} must be rejected as not actionable`);
        assert.match(v.error, /requires an actionable operation/);
    }
});

test("validateEditRequest requires oldText and newText together for a text edit", () => {
    const onlyOld = validateEditRequest({ path: "a.ts", edits: [{ oldText: "x" }], toolCallId: "t" });
    assert.ok(!onlyOld.ok, "oldText without newText must be rejected");
    assert.match(onlyOld.error, /oldText and newText must be provided together/);

    const onlyNew = validateEditRequest({ path: "a.ts", edits: [{ newText: "y" }], toolCallId: "t" });
    assert.ok(!onlyNew.ok, "newText without oldText must be rejected");

    // A scoping-only target (no symbolic/structural op, no text pair) is not actionable.
    const nameOnly = validateEditRequest({ path: "a.ts", edits: [{ target: { name: "foo" } }], toolCallId: "t" });
    assert.ok(!nameOnly.ok, "name-only target without a text pair or symbolic op must be rejected");
    assert.match(nameOnly.error, /requires an actionable operation/);

    // Symbolic target alone is self-actionable.
    const symbolic = validateEditRequest({ path: "a.ts", edits: [{ target: { name: "foo", replaceBody: "bar" } }], toolCallId: "t" });
    assert.ok(symbolic.ok, "symbolic target must be self-actionable");
});
