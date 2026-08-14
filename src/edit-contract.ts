/**
 * Canonical SmartEdit-owned edit request contract.
 *
 * This is the single source of truth for the agent-visible `edit` tool
 * schema and the runtime request validator. It accepts current targeted
 * edits (path/oldText/newText/description/replaceAll) plus rich fields
 * (target/lineRange/hashline), a legacy `anchor` compatibility field, and
 * a mutually exclusive `raw` input.
 *
 * Authority policy: the agent-visible schema omits `evidenceRef` and the
 * validator does not require it — authority is tool-owned. The runtime
 * patch adapter may still read a caller-supplied `evidenceRef` for
 * backward compatibility with stored calls, but it is never part of the
 * advertised contract.
 */
import { validateEvidenceRef } from "@rhinos0608/pi-workspace-protocol";
import type { EditTarget, HashlineEditMetadata, LineRange } from "./core/types.js";

/** One targeted edit operation. */
export interface EditOperation {
    /** Per-edit target file path. Overrides the top-level `path`. */
    path?: string;
    /** Exact text to find for replacement. */
    oldText?: string;
    /** Replacement text. */
    newText?: string;
    /** Optional label echoed in diagnostics for self-reference. */
    description?: string;
    /** Replace every non-overlapping occurrence. */
    replaceAll?: boolean;
    /** Legacy compatibility anchor (symbolName/symbolKind/symbolLine). */
    anchor?: { symbolName?: string; symbolKind?: string; symbolLine?: number };
    /** AST symbol target; scopes text search or drives symbolic operations. */
    target?: EditTarget;
    /** 1-based line-range scope for this edit. */
    lineRange?: LineRange;
    /** Freshness-checked hashline edit metadata. */
    hashline?: HashlineEditMetadata;
}

/** Canonical edit request accepted by the registered `edit` tool. */
export interface EditRequest {
    /** Default target file path. May be omitted when every edit provides its own. */
    path?: string;
    /** Compatibility default for edit items that omit `replaceAll`. */
    replaceAll?: boolean;
    /** One or more targeted edits. Mutually exclusive with `raw`. */
    edits?: EditOperation[];
    /** Raw patch text in a supported format. Mutually exclusive with `edits`. */
    raw?: string;
    /** Injected by the runtime; not part of the agent-visible schema. */
    toolCallId?: string;
    /** Optional evidence reference for stored-call compatibility. Validated when
     *  present; never required (authority is tool-owned) and never advertised in
     *  the agent-visible schema. */
    evidenceRef?: { inspectionId: string; resourceIds: string[] };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(error: string): { ok: false; error: string } {
    return { ok: false, error };
}

function ok(value: EditRequest): { ok: true; value: EditRequest } {
    return { ok: true, value };
}

function isPositiveInteger(v: unknown): boolean {
    return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function firstUnknownKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
    return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

function validateAnchor(a: Record<string, unknown>, i: number): string | null {
    const unknown = firstUnknownKey(a, new Set(["symbolName", "symbolKind", "symbolLine"]));
    if (unknown) return `edit.edits[${i}].anchor.${unknown} is not supported`;
    const { symbolName, symbolKind, symbolLine } = a;
    if (symbolName !== undefined && typeof symbolName !== "string")
        return `edit.edits[${i}].anchor.symbolName must be a string if present`;
    if (symbolKind !== undefined && typeof symbolKind !== "string")
        return `edit.edits[${i}].anchor.symbolKind must be a string if present`;
    if (symbolLine !== undefined && !isPositiveInteger(symbolLine))
        return `edit.edits[${i}].anchor.symbolLine must be a positive integer if present`;
    return null;
}

function validateTarget(t: Record<string, unknown>, i: number): string | null {
    const unknown = firstUnknownKey(t, new Set([
        "name", "namePath", "kind", "line", "replaceBody", "insertBefore",
        "insertAfter", "description", "pattern", "replacement",
    ]));
    if (unknown) return `edit.edits[${i}].target.${unknown} is not supported`;
    const { name, namePath, kind, line, replaceBody, insertBefore, insertAfter, description, pattern, replacement } = t;
    for (const [key, value] of Object.entries({
        name, namePath, kind, replaceBody, insertBefore, insertAfter, description, pattern, replacement,
    })) {
        if (value !== undefined && typeof value !== "string")
            return `edit.edits[${i}].target.${key} must be a string if present`;
    }
    if (line !== undefined && !isPositiveInteger(line))
        return `edit.edits[${i}].target.line must be a positive integer if present`;
    const symbolicOps = [replaceBody, insertBefore, insertAfter].filter((v) => v !== undefined);
    if (symbolicOps.length > 1)
        return `edit.edits[${i}].target: at most one of replaceBody, insertBefore, insertAfter may be provided`;
    const hasPattern = pattern !== undefined;
    const hasReplacement = replacement !== undefined;
    if (hasPattern !== hasReplacement)
        return `edit.edits[${i}].target: pattern and replacement must be provided together`;
    const hasIdentifier = (typeof name === "string" && name.length > 0)
        || (typeof namePath === "string" && namePath.length > 0)
        || line !== undefined;
    if (!hasPattern && !hasIdentifier)
        return `edit.edits[${i}].target requires name, namePath, or line`;
    return null;
}

function validateHashline(h: Record<string, unknown>, i: number): string | null {
    const unknown = firstUnknownKey(h, new Set(["range", "content", "symbol"]));
    if (unknown) return `edit.edits[${i}].hashline.${unknown} is not supported`;
    const { range, content, symbol } = h;
    if (!isPlainObject(range))
        return `edit.edits[${i}].hashline.range must be an object`;
    const unknownRangeKey = firstUnknownKey(range, new Set(["pos", "end"]));
    if (unknownRangeKey) return `edit.edits[${i}].hashline.range.${unknownRangeKey} is not supported`;
    const { pos, end } = range;
    if (typeof pos !== "string" || pos.length === 0)
        return `edit.edits[${i}].hashline.range.pos must be a non-empty string`;
    if (typeof end !== "string" || end.length === 0)
        return `edit.edits[${i}].hashline.range.end must be a non-empty string`;
    if (content !== undefined) {
        const validContent = Array.isArray(content)
            ? content.every((c) => typeof c === "string")
            : typeof content === "string" || content === null;
        if (!validContent)
            return `edit.edits[${i}].hashline.content must be a string, array of strings, or null`;
    }
    if (symbol !== undefined) {
        if (!isPlainObject(symbol))
            return `edit.edits[${i}].hashline.symbol must be an object if present`;
        const unknownSymbolKey = firstUnknownKey(symbol, new Set(["name", "kind", "line"]));
        if (unknownSymbolKey) return `edit.edits[${i}].hashline.symbol.${unknownSymbolKey} is not supported`;
        const { name, kind, line } = symbol;
        if (typeof name !== "string" || name.length === 0)
            return `edit.edits[${i}].hashline.symbol.name must be a non-empty string`;
        if (kind !== undefined && typeof kind !== "string")
            return `edit.edits[${i}].hashline.symbol.kind must be a string if present`;
        if (line !== undefined && !isPositiveInteger(line))
            return `edit.edits[${i}].hashline.symbol.line must be a positive integer if present`;
    }
    return null;
}

function validateEditOperation(e: Record<string, unknown>, i: number): string | null {
    const unknown = firstUnknownKey(e, new Set([
        "path", "oldText", "newText", "description", "replaceAll", "target",
        "lineRange", "hashline", "anchor",
    ]));
    if (unknown) return `edit.edits[${i}].${unknown} is not supported`;
    const { path, oldText, newText, description, replaceAll, target, lineRange, hashline, anchor } = e;
    if (path !== undefined && (typeof path !== "string" || path.length === 0))
        return `edit.edits[${i}].path must be a non-empty string if present`;
    if (oldText !== undefined && typeof oldText !== "string")
        return `edit.edits[${i}].oldText must be a string if present`;
    if (newText !== undefined && typeof newText !== "string")
        return `edit.edits[${i}].newText must be a string if present`;
    if (description !== undefined && typeof description !== "string")
        return `edit.edits[${i}].description must be a string if present`;
    if (replaceAll !== undefined && typeof replaceAll !== "boolean")
        return `edit.edits[${i}].replaceAll must be a boolean if present`;
    if (anchor !== undefined) {
        if (!isPlainObject(anchor))
            return `edit.edits[${i}].anchor must be an object if present`;
        const err = validateAnchor(anchor, i);
        if (err) return err;
    }
    if (target !== undefined) {
        if (!isPlainObject(target))
            return `edit.edits[${i}].target must be an object if present`;
        const err = validateTarget(target, i);
        if (err) return err;
    }
    if (lineRange !== undefined) {
        if (!isPlainObject(lineRange))
            return `edit.edits[${i}].lineRange must be an object if present`;
        const unknownRangeKey = firstUnknownKey(lineRange, new Set(["startLine", "endLine"]));
        if (unknownRangeKey) return `edit.edits[${i}].lineRange.${unknownRangeKey} is not supported`;
        const { startLine, endLine } = lineRange;
        if (!isPositiveInteger(startLine))
            return `edit.edits[${i}].lineRange.startLine must be a positive integer`;
        if (typeof endLine !== "number" || !Number.isInteger(endLine) || endLine < (startLine as number))
            return `edit.edits[${i}].lineRange.endLine must be an integer >= startLine`;
    }
    if (hashline !== undefined) {
        if (!isPlainObject(hashline))
            return `edit.edits[${i}].hashline must be an object if present`;
        const err = validateHashline(hashline, i);
        if (err) return err;
    }

    // Actionable-operation boundary: a text edit needs both oldText and newText;
    // otherwise the item must be self-actionable via a symbolic/structural target
    // or hashline. A description-only or empty item is rejected with a precise
    // error naming the missing requirement. A scoping-only target or legacy anchor
    // (identifier without a symbolic/structural op and without oldText/newText) is
    // not actionable on its own.
    const hasText = typeof oldText === "string" && typeof newText === "string";
    const targetObj = (target !== undefined && isPlainObject(target))
        ? (target as Record<string, unknown>)
        : undefined;
    const hasSymbolic = !!targetObj
        && (targetObj.replaceBody !== undefined
            || targetObj.insertBefore !== undefined
            || targetObj.insertAfter !== undefined);
    const hasStructural = !!targetObj
        && typeof targetObj.pattern === "string"
        && typeof targetObj.replacement === "string";
    const hasSelfActionable = hasSymbolic
        || hasStructural
        || (hashline !== undefined && isPlainObject(hashline));
    if (hasText || hasSelfActionable) return null;
    if ((oldText !== undefined) !== (newText !== undefined))
        return `edit.edits[${i}] oldText and newText must be provided together for a text edit`;
    return `edit.edits[${i}] requires an actionable operation: provide both oldText and newText, or a symbolic/structural target or hashline`;
}

/**
 * Runtime validator for the canonical edit request.
 *
 * Accepts current edit arrays (with rich fields) and `raw` alone; rejects
 * `raw`+`edits` as mutually exclusive. `evidenceRef` is optional and never
 * required — authority is tool-owned.
 */
export function validateEditRequest(
    input: unknown,
): { ok: true; value: EditRequest } | { ok: false; error: string } {
    if (!isPlainObject(input)) return fail("edit request must be an object");
    const normalized = normalizeLegacyEditRequest(input);
    const unknown = firstUnknownKey(normalized, new Set([
        "path", "replaceAll", "edits", "raw", "toolCallId", "evidenceRef",
    ]));
    if (unknown) return fail(`edit.${unknown} is not supported`);
    const { path, replaceAll, edits, raw, toolCallId, evidenceRef } = normalized;

    if (path !== undefined && (typeof path !== "string" || path.length === 0))
        return fail("edit.path, if present, must be a non-empty string");
    if (toolCallId !== undefined && (typeof toolCallId !== "string" || toolCallId.length === 0))
        return fail("edit.toolCallId must be a non-empty string");
    if (replaceAll !== undefined && typeof replaceAll !== "boolean")
        return fail("edit.replaceAll must be a boolean if present");

    const hasEdits = edits !== undefined;
    const hasRaw = raw !== undefined;
    if (hasEdits && hasRaw)
        return fail("edit.raw and edit.edits are mutually exclusive; provide exactly one");
    if (!hasEdits && !hasRaw)
        return fail("edit requires either edits (array) or raw (string)");
    if (hasRaw && (typeof raw !== "string" || raw.length === 0))
        return fail("edit.raw must be a non-empty string");
    if (hasRaw && replaceAll !== undefined)
        return fail("edit.replaceAll is only valid with edits");

    if (hasEdits) {
        if (!Array.isArray(edits) || edits.length === 0)
            return fail("edit.edits must be a non-empty array");
        const editList = edits as unknown[];
        let everyEditHasPath = true;
        for (let i = 0; i < editList.length; i++) {
            const e = editList[i];
            if (!isPlainObject(e)) return fail(`edit.edits[${i}] must be an object`);
            const err = validateEditOperation(e, i);
            if (err) return fail(err);
            if (e.path === undefined) everyEditHasPath = false;
        }
        if (path === undefined && !everyEditHasPath)
            return fail("edit.path is required unless every edit provides its own path");
    }

    // evidenceRef is optional (tool-owned authority). If present, validate its
    // shape so stored calls with a malformed ref fail cleanly rather than crash.
    if (evidenceRef !== undefined) {
        const er = validateEvidenceRef(evidenceRef);
        if (!er.ok) return er;
    }

    return ok(normalized as EditRequest);
}

/**
 * Normalize a legacy flat `{path, oldText, newText}` request into the
 * canonical `edits` array shape. Flat fields are authoritative and overwrite
 * any existing `edits`. Non-flat requests pass through unchanged.
 *
 * The generated item carries the flat `oldText`/`newText` and, when present,
 * the top-level `replaceAll` (moved into the item). Stale top-level
 * `oldText`/`newText`/`replaceAll` are removed from the result.
 */
export function normalizeLegacyEditRequest(args: Record<string, unknown>): Record<string, unknown> {
    if (!args || typeof args !== "object") return args ?? {};
    const input = args as { oldText?: unknown; newText?: unknown };
    if (typeof input.oldText === "string" && typeof input.newText === "string") {
        const { oldText, newText, replaceAll, ...rest } = args;
        const item: Record<string, unknown> = { oldText, newText };
        if (replaceAll !== undefined) item.replaceAll = replaceAll;
        return { ...rest, edits: [item] };
    }
    if (Array.isArray(args.edits) && typeof args.replaceAll === "boolean") {
        const { replaceAll, ...rest } = args;
        return {
            ...rest,
            edits: args.edits.map((edit) => {
                if (!isPlainObject(edit) || edit.replaceAll !== undefined) return edit;
                return { ...edit, replaceAll };
            }),
        };
    }
    return args;
}

/**
 * Agent-visible JSON schema for the registered `edit` tool. Omits
 * `evidenceRef` (tool-owned authority) and advertises mutually exclusive
 * `raw` plus rich edit fields. Nested objects are fully enumerated with
 * `additionalProperties: false`; `edits`/`raw` exclusivity is expressed with
 * `oneOf`.
 */
export const EDIT_PARAMETERS = {
    description:
        "Apply edits gated by workspace evidence. Provide a `path` and a list of `edits`, or a `raw` patch string in a supported format (mutually exclusive). Each edit may carry its own `path` to override the top-level default. File inspection, workspace binding, and SHA-256 freshness are handled by the edit tool.",
    type: "object",
    additionalProperties: false,
    properties: {
        path: { type: "string", description: "Default target file path. May be omitted when every edit provides its own path." },
        replaceAll: {
            type: "boolean",
            description: "Compatibility: when true, applies to every edit whose item does not set its own `replaceAll`.",
        },
        edits: {
            type: "array",
            description: "One or more targeted edits. Mutually exclusive with `raw`.",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    path: { type: "string", description: "Per-edit target file path. Overrides the top-level path." },
                    oldText: { type: "string" },
                    newText: { type: "string" },
                    description: { type: "string" },
                    replaceAll: { type: "boolean" },
                    anchor: {
                        type: "object",
                        additionalProperties: false,
                        description: "Legacy compatibility anchor; converted to `target` at execution time.",
                        properties: {
                            symbolName: { type: "string" },
                            symbolKind: { type: "string" },
                            symbolLine: { type: "integer", minimum: 1 },
                        },
                    },
                    target: {
                        type: "object",
                        additionalProperties: false,
                        description: "AST symbol target; scopes text search or drives symbolic operations.",
                        properties: {
                            name: { type: "string", description: "Symbol name to target (e.g., function name, class name)." },
                            namePath: { type: "string", description: "Qualified symbol path; the final component is matched by AST name (e.g., 'MyClass.myMethod')." },
                            kind: { type: "string", description: "AST node kind hint (e.g., 'function_declaration', 'class_declaration')." },
                            line: { type: "integer", minimum: 1, description: "1-based line hint for disambiguation when multiple symbols share a name." },
                            replaceBody: { type: "string", description: "Replace the entire AST symbol definition with this text." },
                            insertBefore: { type: "string", description: "Insert this text immediately before the AST symbol definition." },
                            insertAfter: { type: "string", description: "Insert this text immediately after the AST symbol definition." },
                            description: { type: "string", description: "Optional target label for diagnostics." },
                            pattern: { type: "string", description: "ast-grep structural pattern." },
                            replacement: { type: "string", description: "Replacement for ast-grep pattern matches." },
                        },
                    },
                    lineRange: {
                        type: "object",
                        additionalProperties: false,
                        description: "1-based line-range scope for this edit.",
                        properties: {
                            startLine: { type: "integer", minimum: 1 },
                            endLine: { type: "integer", minimum: 1 },
                        },
                        required: ["startLine", "endLine"],
                    },
                    hashline: {
                        type: "object",
                        additionalProperties: false,
                        description: "Freshness-checked hashline edit metadata.",
                        properties: {
                            range: {
                                type: "object",
                                additionalProperties: false,
                                description: "Hashline anchor range.",
                                properties: {
                                    pos: { type: "string", minLength: 1, description: "Start hashline anchor." },
                                    end: { type: "string", minLength: 1, description: "End hashline anchor." },
                                },
                                required: ["pos", "end"],
                            },
                            content: {
                                oneOf: [
                                    { type: "array", items: { type: "string" } },
                                    { type: "string" },
                                    { type: "null" },
                                ],
                            },
                            symbol: {
                                type: "object",
                                additionalProperties: false,
                                description: "Optional symbol scope for hashline fallback.",
                                properties: {
                                    name: { type: "string", minLength: 1 },
                                    kind: { type: "string" },
                                    line: { type: "integer", minimum: 1 },
                                },
                                required: ["name"],
                            },
                        },
                        required: ["range"],
                    },
                },
                // An edit item must be actionable: a text pair (oldText+newText) or
                // a self-actionable target (symbolic op or structural pattern+replacement)
                // or hashline. A scoping-only target/identifier without oldText/newText
                // and without a symbolic/structural op is not actionable on its own.
                anyOf: [
                    { required: ["oldText", "newText"] },
                    {
                        required: ["target"],
                        properties: {
                            target: {
                                anyOf: [
                                    { required: ["replaceBody"] },
                                    { required: ["insertBefore"] },
                                    { required: ["insertAfter"] },
                                    { required: ["pattern", "replacement"] },
                                ],
                            },
                        },
                    },
                    { required: ["hashline"] },
                ],
            },
        },
        raw: {
            type: "string",
            description: "Raw patch text in a supported format (search/replace, unified diff, OpenAI/Codex patch, Atomic Patch). Mutually exclusive with `edits`.",
        },
    },
    oneOf: [
        { required: ["edits"] },
        { required: ["raw"] },
    ],
} as const;
