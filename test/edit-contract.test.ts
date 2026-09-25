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
 *   - `normalizeFlatEditRequest` preserves flat/resumed compatibility.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import smartEdit from "../src/index.js";
import {
    validateEditRequest,
    validateHashlineOnlyEditRequest,
    normalizeFlatEditRequest,
    getEditParameters,
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
    assert.match(String((range.properties?.pos as { description?: string }).description), /LINE\+ID.*112zc/);
    assert.match(String((range.properties?.end as { description?: string }).description), /LINE\+ID.*single-line/);
    assert.ok(hashlineProps.content, "hashline must advertise content");
    assert.match(String((hashlineProps.content as { description?: string }).description), /Replacement content.*null.*delete.*not source\/old text/i);
    assert.ok(hashlineProps.symbol, "hashline must advertise symbol");
});

test("hashline mode exposes only the hashline edit protocol", () => {
    const params = getEditParameters(true) as unknown as {
        required?: string[];
        properties?: Record<string, unknown>;
    };
    assert.deepEqual(params.required, ["edits"]);
    const props = params.properties ?? {};
    assert.ok(props.path);
    assert.ok(props.edits);
    assert.ok(!("raw" in props), "hashline schema must hide raw patches");
    assert.ok(!("refactor" in props), "hashline schema must hide refactors");

    const edits = props.edits as {
        items?: {
            required?: string[];
            properties?: Record<string, unknown>;
        };
    };
    assert.deepEqual(edits.items?.required, ["hashline"]);
    const itemProps = edits.items?.properties ?? {};
    assert.deepEqual(Object.keys(itemProps).sort(), ["hashline", "path"]);
    assert.ok(!("oldText" in itemProps));
    assert.ok(!("newText" in itemProps));
    assert.ok(!("lineRange" in itemProps));
    assert.ok(!("target" in itemProps));

    const hashline = itemProps.hashline as {
        required?: string[];
        properties?: Record<string, unknown>;
    };
    assert.deepEqual(hashline.required, ["range", "content"]);
    const content = hashline.properties?.content as { description?: string };
    assert.match(String(content.description), /replacement content.*null explicitly.*delete.*never put the source\/old text/i);
    const range = hashline.properties?.range as { description?: string; properties?: Record<string, unknown> };
    assert.match(String(range.description), /:after.*:before.*unsuffixed base anchor/i);
    assert.match(String((range.properties?.pos as { description?: string }).description), /insert.*:after.*:before/i);
});

test("normal mode keeps the existing full edit schema", () => {
    const params = getEditParameters(false) as unknown as { properties?: Record<string, unknown> };
    const props = params.properties ?? {};
    assert.ok(props.raw);
    assert.ok(props.refactor);
    const edits = props.edits as { items?: { properties?: Record<string, unknown> } };
    const itemProps = edits.items?.properties ?? {};
    assert.ok(itemProps.oldText);
    assert.ok(itemProps.newText);
    assert.ok(itemProps.target);
    assert.ok(itemProps.lineRange);
    assert.ok(itemProps.hashline);
});

test("extension registration switches to the hashline-only schema when enabled", () => {
    const priorDirect = process.env.SMART_EDIT_USE_HASHLINE_EDITING;
    const priorAlias = process.env.SMART_EDIT_HASHLINE_EXPERIMENTAL;
    try {
        process.env.SMART_EDIT_USE_HASHLINE_EDITING = "1";
        delete process.env.SMART_EDIT_HASHLINE_EXPERIMENTAL;
        const params = registeredEditParams();
        const props = params.properties as Record<string, unknown>;
        assert.ok(props.edits);
        assert.ok(!props.raw);
        assert.ok(!props.refactor);
        const edits = props.edits as { items?: { properties?: Record<string, unknown> } };
        assert.deepEqual(Object.keys(edits.items?.properties ?? {}).sort(), ["hashline", "path"]);
    } finally {
        if (priorDirect === undefined) delete process.env.SMART_EDIT_USE_HASHLINE_EDITING;
        else process.env.SMART_EDIT_USE_HASHLINE_EDITING = priorDirect;
        if (priorAlias === undefined) delete process.env.SMART_EDIT_HASHLINE_EXPERIMENTAL;
        else process.env.SMART_EDIT_HASHLINE_EXPERIMENTAL = priorAlias;
    }
});

test("hashline-only runtime validator rejects alternate edit dialects", () => {
    const classic = validateHashlineOnlyEditRequest({
        path: "a.ts",
        edits: [{ oldText: "x", newText: "y" }],
    });
    assert.ok(!classic.ok);
    assert.match(classic.error, /must use hashline metadata/);

    const mixed = validateHashlineOnlyEditRequest({
        path: "a.ts",
        edits: [{
            oldText: "x",
            newText: "y",
            hashline: { range: { pos: "1ab", end: "1ab" }, content: "z" },
        }],
    });
    assert.ok(!mixed.ok);
    assert.match(mixed.error, /oldText.*not supported/);

    const missingContent = validateHashlineOnlyEditRequest({
        path: "a.ts",
        edits: [{ hashline: { range: { pos: "1ab", end: "1ab" } } }],
    });
    assert.ok(!missingContent.ok);
    assert.match(missingContent.error, /content is required.*null explicitly to delete/);

    const raw = validateHashlineOnlyEditRequest({ raw: "*** Begin Patch" });
    assert.ok(!raw.ok);
    assert.match(raw.error, /accepts only.*hashline metadata/);
});

test("hashline-only runtime validator accepts explicit replacement, deletion, and gap insertion", () => {
    const replacement = validateHashlineOnlyEditRequest({
        path: "a.ts",
        edits: [{
            hashline: { range: { pos: "1ab", end: "2cd" }, content: ["x", "y"] },
        }],
    });
    assert.ok(replacement.ok);

    const deletion = validateHashlineOnlyEditRequest({
        path: "a.ts",
        edits: [{
            hashline: { range: { pos: "1ab", end: "1ab" }, content: null },
        }],
    });
    assert.ok(deletion.ok);

    const insertion = validateHashlineOnlyEditRequest({
        path: "a.ts",
        edits: [{
            hashline: { range: { pos: "1ab:after", end: "1ab" }, content: ["new line"] },
        }],
    });
    assert.ok(insertion.ok);

    const wrongInsertionEnd = validateHashlineOnlyEditRequest({
        path: "a.ts",
        edits: [{
            hashline: { range: { pos: "1ab:after", end: "2cd" }, content: ["new line"] },
        }],
    });
    assert.ok(!wrongInsertionEnd.ok);
    assert.match(wrongInsertionEnd.error, /end must equal unsuffixed insertion anchor/);

    const nullInsertion = validateHashlineOnlyEditRequest({
        path: "a.ts",
        edits: [{
            hashline: { range: { pos: "1ab:before", end: "1ab" }, content: null },
        }],
    });
    assert.ok(!nullInsertion.ok);
    assert.match(nullInsertion.error, /content must be non-null.*insertion/);
});

test("registered edit schema omits top-level oneOf for Anthropic input_schema compat", () => {
    const params = registeredEditParams();
    assert.ok(!("oneOf" in params), "top-level oneOf is rejected by the Anthropic API");
    assert.ok(!("anyOf" in params), "top-level anyOf is rejected by the Anthropic API");
    assert.ok(!("allOf" in params), "top-level allOf is rejected by the Anthropic API");
});

test("registered edit schema keeps refactor subschema flat (provider compat, discrimination in validator)", () => {
    const params = registeredEditParams();
    const properties = params.properties as Record<string, unknown>;
    const refactor = properties.refactor as Record<string, unknown>;
    assert.ok(refactor, "schema must advertise `refactor`");
    assert.ok(!("oneOf" in refactor), "refactor subschema must stay flat: no oneOf");
    assert.ok(!("anyOf" in refactor), "refactor subschema must stay flat: no anyOf");
    assert.ok(!("allOf" in refactor), "refactor subschema must stay flat: no allOf");
    const kind = (refactor.properties as Record<string, { enum?: string[] }>).kind;
    assert.deepEqual(kind.enum, ["rename-preview", "apply-refactor-preview", "organize-imports-preview", "formatting-preview", "code-action-preview"]);
});

test("validateEditRequest rejects fields irrelevant to the refactor kind", () => {
    const v = validateEditRequest({ refactor: { kind: "rename-preview", path: "a.ts", line: 1, character: 1, newName: "b", previewId: "x" } });
    assert.ok(!v.ok, "previewId is irrelevant to rename-preview and must be rejected");
    assert.match(v.error, /previewId.*rename-preview|not supported/);
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

// ── normalizeFlatEditRequest ─────────────────────────────

test("normalizeFlatEditRequest converts flat oldText/newText to edits array", () => {
    const result = normalizeFlatEditRequest({ path: "a.ts", oldText: "x", newText: "y" });
    assert.deepEqual(result.edits, [{ oldText: "x", newText: "y" }]);
    assert.equal(result.path, "a.ts");
});

test("normalizeFlatEditRequest passes through edits-array calls unchanged", () => {
    const input = { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] };
    assert.equal(normalizeFlatEditRequest(input), input);
});

test("normalizeFlatEditRequest flat fields overwrite existing edits", () => {
    const result = normalizeFlatEditRequest({
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

test("normalizeFlatEditRequest removes stale top-level oldText/newText", () => {
    const result = normalizeFlatEditRequest({ path: "a.ts", oldText: "x", newText: "y" });
    assert.ok(!("oldText" in result), "stale top-level oldText must be removed");
    assert.ok(!("newText" in result), "stale top-level newText must be removed");
    assert.deepEqual(result.edits, [{ oldText: "x", newText: "y" }]);
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

// ── Transfer-shaped payloads belong to the transfer tool ───────────────
// Stage 4 hard-cut: `edit` rejects every transfer field (op/from/range/to/
// after) as unsupported input and steers to the first-class transfer tool.

test("validateEditRequest rejects a transfer-shaped edit op", () => {
    const v = validateEditRequest({
        path: "unused.ts",
        edits: [{ op: "copy", from: "a.ts", range: { pos: "5aa", end: "6bb" }, to: "b.ts", after: "18cd" }],
        toolCallId: "t",
    });
    assert.ok(!v.ok, "transfer-shaped edit must be rejected");
    assert.match(v.error, /transfer tool/);
});

test("validateEditRequest rejects each transfer field without op", () => {
    for (const field of ["from", "range", "to", "after"] as const) {
        const edit: Record<string, unknown> = field === "range"
            ? { [field]: { pos: "5aa", end: "6bb" } }
            : { [field]: "x" };
        const v = validateEditRequest({ path: "unused.ts", edits: [edit], toolCallId: "t" });
        assert.ok(!v.ok, `transfer field ${field} without op must be rejected`);
        assert.match(v.error, /transfer tool/);
    }
});

test("validateEditRequest rejects an invalid op value as unsupported input", () => {
    const v = validateEditRequest({
        path: "unused.ts",
        edits: [{ op: "duplicate", from: "a.ts", range: { pos: "5aa", end: "6bb" }, to: "b.ts", after: "18cd" }],
        toolCallId: "t",
    });
    assert.ok(!v.ok, "invalid op value must be rejected");
    assert.match(v.error, /transfer tool/);
});

test("registered edit schema hides op/from/range/to/after and has no transfer anyOf branch", () => {
    const params = registeredEditParams();
    const properties = params.properties as Record<string, unknown>;
    const edits = properties.edits as { items?: { properties?: Record<string, unknown>; anyOf?: Array<{ required?: string[] }> } };
    const editProps = edits.items?.properties ?? {};

    for (const key of ["op", "from", "range", "to", "after"]) {
        assert.ok(!(key in editProps), `edit items must not advertise \`${key}\``);
    }
    const anyOf = edits.items?.anyOf ?? [];
    const transferBranch = anyOf.find((branch) =>
        branch.required && ["op", "from", "range", "to"].every((k) => branch.required!.includes(k)));
    assert.ok(!transferBranch, "schema must not include a transfer anyOf branch");
});
