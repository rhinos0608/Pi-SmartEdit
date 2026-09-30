import { isPlainObject, isPositiveInteger, normalizeFlatEditRequest, validateEditRequest, type EditRequest } from "../edit-contract.js";
import type { EditModeSpec } from "./types.js";

export const TEXT_EDIT_PARAMETERS = {
    type: "object",
    additionalProperties: false,
    properties: {
        path: { type: "string", description: "Default target file path. May be omitted when every edit provides its own path." },
        edits: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            description: "One or more text edits, applied atomically. Each edit replaces exact oldText with newText.",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    path: { type: "string", description: "Per-edit target file path. Overrides the top-level path." },
                    oldText: { type: "string", description: "Exact text to find for replacement." },
                    newText: { type: "string", description: "Replacement text." },
                    description: { type: "string", description: "Optional label echoed in diagnostics for self-reference." },
                    replaceAll: { type: "boolean", description: "Replace every non-overlapping occurrence." },
                    scope: {
                        type: "object",
                        additionalProperties: false,
                        description: "Optional symbol scope narrowing where oldText is searched. Provide at least one of name, namePath, line.",
                        properties: {
                            name: { type: "string", description: "Symbol name to scope the search (e.g., function name)." },
                            namePath: { type: "string", description: "Qualified symbol path (e.g., 'MyClass.myMethod')." },
                            line: { type: "integer", minimum: 1, description: "1-based line hint for disambiguation." },
                        },
                    },
                },
                required: ["oldText", "newText"],
            },
        },
    },
    required: ["edits"],
} as const;

export const TEXT_EDIT_DESCRIPTION =
    "Apply text edits to files gated by workspace evidence. Existing files require prior strong read authority; new files may use empty-file semantics. Provide a `path` and a list of `edits` with `oldText`/`newText`; each edit may carry its own `path`. Copy `oldText` from read output without any line-number prefixes. Freshness and coverage are validated automatically; returns a discriminated lifecycle result (applied | rejected | failed). Use patch to transform or generate content; when existing content should be preserved and relocated/reused, prefer transfer.";

const TEXT_ITEM_UNSUPPORTED_KEYS = new Set(["hashline", "lineRange", "target"]);

function asScopeRecord(scope: unknown, i: number): { record: Record<string, unknown> } | { error: string } {
    if (!isPlainObject(scope)) {
        return { error: `edit.edits[${i}].scope must be an object if present` };
    }
    const s = scope as Record<string, unknown>;
    const unknown = Object.keys(s).find((key) => key !== "name" && key !== "namePath" && key !== "line");
    if (unknown) return { error: `edit.edits[${i}].scope.${unknown} is not supported` };
    return { record: s };
}

function checkScopeStringField(s: Record<string, unknown>, i: number, key: "name" | "namePath"): string | null {
    const value = s[key];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
        return `edit.edits[${i}].scope.${key} must be a non-empty string if present`;
    }
    return null;
}

function checkScopeLineField(s: Record<string, unknown>, i: number): string | null {
    const line = s.line;
    if (line !== undefined && !isPositiveInteger(line)) {
        return `edit.edits[${i}].scope.line must be a positive integer if present`;
    }
    return null;
}

function pickDefinedScopeFields(s: Record<string, unknown>): Record<string, unknown> {
    const target: Record<string, unknown> = {};
    for (const key of ["name", "namePath", "line"] as const) {
        if (s[key] !== undefined) target[key] = s[key];
    }
    return target;
}

function checkScope(scope: unknown, i: number): { target: Record<string, unknown> } | { error: string } {
    const shaped = asScopeRecord(scope, i);
    if ("error" in shaped) return shaped;
    return checkScopeFields(shaped.record, i);
}

function checkScopeFields(s: Record<string, unknown>, i: number): { target: Record<string, unknown> } | { error: string } {
    const fieldErr = checkScopeStringField(s, i, "name")
        ?? checkScopeStringField(s, i, "namePath")
        ?? checkScopeLineField(s, i);
    if (fieldErr) return { error: fieldErr };
    const target = pickDefinedScopeFields(s);
    if (Object.keys(target).length === 0) {
        return { error: `edit.edits[${i}].scope requires name, namePath, or line` };
    }
    return { target };
}

function mapOneEditScope(item: unknown, i: number, items: unknown[], targets: Map<number, Record<string, unknown>>): string | null {
    if (!isPlainObject(item)) {
        items.push(item);
        return null;
    }
    const edit = item as Record<string, unknown>;
    if (edit.scope === undefined) {
        items.push(edit);
        return null;
    }
    const mapped = checkScope(edit.scope, i);
    if ("error" in mapped) return mapped.error;
    const { scope: _dropped, ...rest } = edit;
    items.push(rest);
    targets.set(i, mapped.target);
    return null;
}

function mapEditScopes(top: Record<string, unknown>): { sanitized: Record<string, unknown>; targets: Map<number, Record<string, unknown>> } | { error: string } {
    const targets = new Map<number, Record<string, unknown>>();
    if (!Array.isArray(top.edits)) return { sanitized: top, targets };
    const items: unknown[] = [];
    for (let i = 0; i < (top.edits as unknown[]).length; i++) {
        const err = mapOneEditScope((top.edits as unknown[])[i], i, items, targets);
        if (err) return { error: err };
    }
    return { sanitized: { ...top, edits: items }, targets };
}

function checkOneValidatedItem(edit: unknown, i: number, targets: Map<number, Record<string, unknown>>): string | null {
    const record = edit as Record<string, unknown>;
    const unsupported = Object.keys(record).find((key) => TEXT_ITEM_UNSUPPORTED_KEYS.has(key));
    if (unsupported) {
        return `edit.edits[${i}].${unsupported} is not supported in text edit mode`;
    }
    const mapped = targets.get(i);
    if (mapped) record.target = mapped;
    return null;
}

function checkValidatedTextItems(edits: EditRequest["edits"], targets: Map<number, Record<string, unknown>>): string | null {
    if (!edits) return null;
    for (let i = 0; i < edits.length; i++) {
        const err = checkOneValidatedItem(edits[i], i, targets);
        if (err) return err;
    }
    return null;
}

function checkTopLevelDialect(top: Record<string, unknown>): string | null {
    if (top.raw !== undefined) return "edit.raw is not supported in text edit mode";
    if (top.refactor !== undefined) return "edit.refactor is not supported in text edit mode";
    return null;
}

function validateTextEditRequest(input: unknown): { ok: true; value: EditRequest } | { ok: false; error: string } {
    if (!isPlainObject(input)) {
        return validateEditRequest(input);
    }
    const top = input as Record<string, unknown>;
    const dialectErr = checkTopLevelDialect(top);
    if (dialectErr) return { ok: false, error: dialectErr };
    // Map agent-facing `scope` to the internal identifier-only `target`
    // (which the planner treats as search scoping) before shared validation,
    // which does not know the `scope` key. Items are copied so caller input
    // is never mutated.
    const mapped = mapEditScopes(top);
    if ("error" in mapped) return { ok: false, error: mapped.error };
    const v = validateEditRequest(mapped.sanitized);
    if (!v.ok) return v;
    const unsupported = checkValidatedTextItems(v.value.edits, mapped.targets);
    if (unsupported) return { ok: false, error: unsupported };
    return v;
}

const DISPLAY_PREFIX_RE = /^(\d+)\|(.*)$/;

function parsePrefixedLine(line: string, expected: number | null): { n: number; text: string } | null {
    const match = DISPLAY_PREFIX_RE.exec(line);
    if (!match) return null;
    const n = Number(match[1]);
    if (!Number.isSafeInteger(n)) return null;
    if (expected !== null && n !== expected) return null;
    return { n, text: match[2] ?? "" };
}

function stripDisplayPrefixes(oldText: string): string {
    const lines = oldText.split("\n");
    // A trailing newline produces one empty final segment; it carries no prefix.
    const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
    const body = trailingNewline ? lines.slice(0, -1) : lines;
    // One N|-shaped line is indistinguishable from genuine content ("1|x");
    // only a run of consecutive numbered lines is treated as copied read output.
    if (body.length < 2) return oldText;
    const stripped: string[] = [];
    let expected: number | null = null;
    for (const line of body) {
        const parsed = parsePrefixedLine(line, expected);
        if (!parsed) return oldText;
        expected = parsed.n + 1;
        stripped.push(parsed.text);
    }
    if (expected === null) return oldText;
    const result = stripped.join("\n");
    return trailingNewline ? result + "\n" : result;
}

function stripItemPrefixes(item: unknown): void {
    if (!isPlainObject(item)) return;
    if (typeof item.oldText === "string") {
        item.oldText = stripDisplayPrefixes(item.oldText);
    }
}

function prepareTextArguments(args: Record<string, unknown>): Record<string, unknown> {
    const normalized = normalizeFlatEditRequest(args);
    const edits = normalized.edits;
    if (!Array.isArray(edits)) return normalized;
    for (const item of edits) stripItemPrefixes(item);
    return normalized;
}

export const textEditModeSpec: EditModeSpec = {
    id: "text",
    description: TEXT_EDIT_DESCRIPTION,
    parameters: TEXT_EDIT_PARAMETERS as unknown as Record<string, unknown>,
    validate: validateTextEditRequest,
    prepareArguments: prepareTextArguments,
};
