import { normalizeFlatEditRequest, validateEditRequest, type EditRequest } from "../edit-contract.js";
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

function checkScope(scope: unknown, i: number): { target: Record<string, unknown> } | { error: string } {
    if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
        return { error: `edit.edits[${i}].scope must be an object if present` };
    }
    const s = scope as Record<string, unknown>;
    const unknown = Object.keys(s).find((key) => key !== "name" && key !== "namePath" && key !== "line");
    if (unknown) return { error: `edit.edits[${i}].scope.${unknown} is not supported` };
    const { name, namePath, line } = s;
    if (name !== undefined && (typeof name !== "string" || name.length === 0)) {
        return { error: `edit.edits[${i}].scope.name must be a non-empty string if present` };
    }
    if (namePath !== undefined && (typeof namePath !== "string" || namePath.length === 0)) {
        return { error: `edit.edits[${i}].scope.namePath must be a non-empty string if present` };
    }
    if (line !== undefined && (typeof line !== "number" || !Number.isInteger(line) || line < 1)) {
        return { error: `edit.edits[${i}].scope.line must be a positive integer if present` };
    }
    if (name === undefined && namePath === undefined && line === undefined) {
        return { error: `edit.edits[${i}].scope requires name, namePath, or line` };
    }
    const target: Record<string, unknown> = {};
    if (name !== undefined) target.name = name;
    if (namePath !== undefined) target.namePath = namePath;
    if (line !== undefined) target.line = line;
    return { target };
}

function validateTextEditRequest(input: unknown): { ok: true; value: EditRequest } | { ok: false; error: string } {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return validateEditRequest(input);
    }
    const top = input as Record<string, unknown>;
    if (top.raw !== undefined) return { ok: false, error: "edit.raw is not supported in text edit mode" };
    if (top.refactor !== undefined) return { ok: false, error: "edit.refactor is not supported in text edit mode" };
    // Map agent-facing `scope` to the internal identifier-only `target`
    // (which the planner treats as search scoping) before shared validation,
    // which does not know the `scope` key. Items are copied so caller input
    // is never mutated.
    const mappedTargets = new Map<number, Record<string, unknown>>();
    let sanitized: Record<string, unknown> = top;
    if (Array.isArray(top.edits)) {
        const items: unknown[] = [];
        for (let i = 0; i < (top.edits as unknown[]).length; i++) {
            const item: unknown = (top.edits as unknown[])[i];
            if (typeof item !== "object" || item === null || Array.isArray(item)) {
                items.push(item);
                continue;
            }
            const edit = item as Record<string, unknown>;
            if (edit.scope === undefined) {
                items.push(edit);
                continue;
            }
            const mapped = checkScope(edit.scope, i);
            if ("error" in mapped) return { ok: false, error: mapped.error };
            const { scope: _dropped, ...rest } = edit;
            items.push(rest);
            mappedTargets.set(i, mapped.target);
        }
        sanitized = { ...top, edits: items };
    }
    const v = validateEditRequest(sanitized);
    if (!v.ok) return v;
    const edits = v.value.edits;
    if (edits) {
        for (let i = 0; i < edits.length; i++) {
            const edit = edits[i] as unknown as Record<string, unknown>;
            const unsupported = Object.keys(edit).find((key) => TEXT_ITEM_UNSUPPORTED_KEYS.has(key));
            if (unsupported) {
                return { ok: false, error: `edit.edits[${i}].${unsupported} is not supported in text edit mode` };
            }
            const mapped = mappedTargets.get(i);
            if (mapped) edit.target = mapped;
        }
    }
    return v;
}

const DISPLAY_PREFIX_RE = /^(\d+)\|(.*)$/;

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
        const match = DISPLAY_PREFIX_RE.exec(line);
        if (!match) return oldText;
        const n = Number(match[1]);
        if (!Number.isSafeInteger(n)) return oldText;
        if (expected !== null && n !== expected) return oldText;
        expected = n + 1;
        stripped.push(match[2] ?? "");
    }
    if (expected === null) return oldText;
    const result = stripped.join("\n");
    return trailingNewline ? result + "\n" : result;
}

function prepareTextArguments(args: Record<string, unknown>): Record<string, unknown> {
    const normalized = normalizeFlatEditRequest(args);
    const edits = normalized.edits;
    if (!Array.isArray(edits)) return normalized;
    for (const item of edits) {
        if (typeof item !== "object" || item === null) continue;
        const edit = item as Record<string, unknown>;
        if (typeof edit.oldText === "string") {
            edit.oldText = stripDisplayPrefixes(edit.oldText);
        }
    }
    return normalized;
}

export const textEditModeSpec: EditModeSpec = {
    id: "text",
    description: TEXT_EDIT_DESCRIPTION,
    parameters: TEXT_EDIT_PARAMETERS as unknown as Record<string, unknown>,
    validate: validateTextEditRequest,
    prepareArguments: prepareTextArguments,
};
