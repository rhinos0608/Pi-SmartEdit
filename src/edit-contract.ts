/**
 * Canonical SmartEdit-owned edit request contract.
 *
 * This is the single source of truth for the agent-visible `edit` tool
 * schema and the runtime request validator. It accepts current targeted
 * edits (path/oldText/newText/description/replaceAll) plus rich fields
 * (target/lineRange/hashline) and a mutually exclusive `raw` input.
 *
 * Authority policy: the agent-visible schema omits `evidenceRef` and the
 * validator does not require it — authority is tool-owned. The runtime
 * patch adapter may still read a caller-supplied `evidenceRef` for
 * backward compatibility with stored calls, but it is never part of the
 * advertised contract.
 */
import { validateEvidenceRef } from "@rhinos0608/pi-workspace-protocol";
import type { EditTarget, HashlineEditMetadata, LineRange, TransferRange } from "./core/types.js";

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
    /** AST target: scopes text search or drives symbolic and structural operations.
     *  Symbol operations use replaceBody / insertBefore / insertAfter on the
     *  matched AST node. Structural operations use ast-grep `pattern`/`replacement`
     *  for template-based transforms. */
    target?: EditTarget;
    /** 1-based line-range scope for this edit. */
    lineRange?: LineRange;
    /** Experimental hashline edit metadata. Enable with
     *  `SMART_EDIT_USE_HASHLINE_EDITING` or its experimental alias. */
    hashline?: HashlineEditMetadata;
    /** Transfer (copy/move) operation: relocate an existing observed range by
     *  reference. Mutually exclusive with every other edit field. */
    op?: "copy" | "move";
    from?: string;
    range?: TransferRange;
    to?: string;
    after?: string;
}

/** Canonical edit request accepted by the registered `edit` tool. */
export interface RefactorRequest {
    kind: "rename-preview" | "apply-refactor-preview";
    path?: string;
    line?: number;
    character?: number;
    newName?: string;
    previewId?: string;
}

export interface EditRequest {
    /** Default target file path. May be omitted when every edit provides its own. */
    path?: string;
    /** One or more targeted edits. Mutually exclusive with `raw`. */
    edits?: EditOperation[];
    /** Raw patch text in a supported format. Mutually exclusive with `edits`. */
    raw?: string;
    refactor?: RefactorRequest;
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

function validatePosEndRange(range: Record<string, unknown>, i: number, field: string): string | null {
    const unknownRangeKey = firstUnknownKey(range, new Set(["pos", "end"]));
    if (unknownRangeKey) return `edit.edits[${i}].${field}.${unknownRangeKey} is not supported`;
    const { pos, end } = range;
    if (typeof pos !== "string" || pos.length === 0)
        return `edit.edits[${i}].${field}.pos must be a non-empty string`;
    if (typeof end !== "string" || end.length === 0)
        return `edit.edits[${i}].${field}.end must be a non-empty string`;
    return null;
}

function validateHashline(h: Record<string, unknown>, i: number): string | null {
    const unknown = firstUnknownKey(h, new Set(["range", "content", "symbol"]));
    if (unknown) return `edit.edits[${i}].hashline.${unknown} is not supported`;
    const { range, content, symbol } = h;
    if (!isPlainObject(range))
        return `edit.edits[${i}].hashline.range must be an object`;
    const rangeErr = validatePosEndRange(range, i, "hashline.range");
    if (rangeErr) return rangeErr;
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
        "lineRange", "hashline", "op", "from", "range", "to", "after",
    ]));
    if (unknown) return `edit.edits[${i}].${unknown} is not supported`;
    const { path, oldText, newText, description, replaceAll, target, lineRange, hashline, op, from, range, to, after } = e;
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

    // Transfer (copy/move) op: self-contained and mutually exclusive with
    // every other edit shape. A valid transfer op is unconditionally
    // actionable, so it returns early rather than falling into the
    // oldText/newText/symbolic/structural/hashline actionable-boundary check.
    if (op !== undefined) {
        if (op !== "copy" && op !== "move")
            return `edit.edits[${i}].op must be "copy" or "move"`;
        if (path !== undefined || oldText !== undefined || newText !== undefined
            || target !== undefined || lineRange !== undefined || hashline !== undefined)
            return `edit.edits[${i}]: op is mutually exclusive with path, oldText, newText, target, lineRange, and hashline`;
        if (typeof from !== "string" || from.length === 0)
            return `edit.edits[${i}].from must be a non-empty string`;
        if (typeof to !== "string" || to.length === 0)
            return `edit.edits[${i}].to must be a non-empty string`;
        if (after !== undefined && (typeof after !== "string" || after.length === 0))
            return `edit.edits[${i}].after must be a non-empty string if present`;
        if (!isPlainObject(range))
            return `edit.edits[${i}].range must be an object`;
        const rangeErr = validatePosEndRange(range, i, "range");
        if (rangeErr) return rangeErr;
        return null;
    }

    // Actionable-operation boundary: a text edit needs both oldText and newText;
    // otherwise the item must be self-actionable via a symbolic/structural target
    // or hashline. A description-only or empty item is rejected with a precise
    // error naming the missing requirement. A scoping-only target (identifier
    // without a symbolic/structural op and without oldText/newText) is not
    // actionable on its own.
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
    const normalized = normalizeFlatEditRequest(input);
    const unknown = firstUnknownKey(normalized, new Set([
        "path", "edits", "raw", "toolCallId", "evidenceRef", "refactor",
    ]));
    if (unknown) return fail(`edit.${unknown} is not supported`);
    const { path, edits, raw, toolCallId, evidenceRef, refactor } = normalized;

    if (path !== undefined && (typeof path !== "string" || path.length === 0))
        return fail("edit.path, if present, must be a non-empty string");
    if (toolCallId !== undefined && (typeof toolCallId !== "string" || toolCallId.length === 0))
        return fail("edit.toolCallId must be a non-empty string");

    const hasEdits = edits !== undefined;
    const hasRaw = raw !== undefined;
    const hasRefactor = refactor !== undefined;
    const variantCount = (hasEdits ? 1 : 0) + (hasRaw ? 1 : 0) + (hasRefactor ? 1 : 0);
    if (variantCount > 1)
        return fail("edit.edits, edit.raw, and edit.refactor are mutually exclusive; provide exactly one");
    if (variantCount === 0)
        return fail("edit requires either edits (array), raw (string), or refactor");
    if (hasRefactor) {
        if (!isPlainObject(refactor)) return fail("edit.refactor must be an object");
        const r = refactor as Record<string, unknown>;
        const rk = firstUnknownKey(r, new Set(["kind", "path", "line", "character", "newName", "previewId"]));
        if (rk) return fail(`edit.refactor.${rk} is not supported`);
        if (r.kind !== "rename-preview" && r.kind !== "apply-refactor-preview") return fail("edit.refactor.kind must be \"rename-preview\" or \"apply-refactor-preview\"");
        if (r.kind === "rename-preview") {
            if (typeof r.path !== "string" || r.path.length === 0) return fail("edit.refactor.path required for rename-preview");
            if (typeof r.newName !== "string" || r.newName.length === 0) return fail("edit.refactor.newName required for rename-preview");
            if (typeof r.line !== "number" || !Number.isInteger(r.line) || r.line < 0) return fail("edit.refactor.line must be a non-negative integer");
            if (typeof r.character !== "number" || !Number.isInteger(r.character) || r.character < 0) return fail("edit.refactor.character must be a non-negative integer");
        } else {
            if (typeof r.previewId !== "string" || r.previewId.length === 0) return fail("edit.refactor.previewId required for apply-refactor-preview");
        }
        return ok(normalized as EditRequest);
    }
    if (hasRaw && (typeof raw !== "string" || raw.length === 0))
        return fail("edit.raw must be a non-empty string");

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
 * Normalize a flat `{path, oldText, newText}` request (the single-edit
 * shorthand still sent by resumed sessions with stored calls) into the
 * canonical `edits` array shape. Flat fields are authoritative and overwrite
 * any existing `edits`. Non-flat requests pass through unchanged.
 *
 * Stale top-level `oldText`/`newText` are removed from the result.
 */
export function normalizeFlatEditRequest(args: Record<string, unknown>): Record<string, unknown> {
    if (!args || typeof args !== "object") return args ?? {};
    const input = args as { oldText?: unknown; newText?: unknown };
    if (typeof input.oldText === "string" && typeof input.newText === "string") {
        const { oldText, newText, ...rest } = args;
        return { ...rest, edits: [{ oldText, newText }] };
    }
    return args;
}

/**
 * Agent-visible JSON schema for the registered `edit` tool. Omits
 * `evidenceRef` (tool-owned authority) and advertises mutually exclusive
 * `raw` plus rich edit fields. Nested objects are fully enumerated with
 * `additionalProperties: false`. `edits`/`raw` exclusivity is enforced by
 * `validateEditRequest`; the schema omits a top-level `oneOf` because the
 * Anthropic API rejects `oneOf`/`allOf`/`anyOf` at the input_schema root.
 */
export const EDIT_PARAMETERS = {
    type: "object",
    additionalProperties: false,
    properties: {
        path: { type: "string", description: "Default target file path. May be omitted when every edit provides its own path." },
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
                    target: {
                        type: "object",
                        additionalProperties: false,
                        description: "AST target: scopes text search or drives symbolic and structural operations. Symbol operations (replaceBody/insertBefore/insertAfter) act on the matched AST node; structural operations (pattern/replacement) use ast-grep transforms.",
                        properties: {
                            name: { type: "string", description: "Symbol name to target (e.g., function name, class name)." },
                            namePath: { type: "string", description: "Qualified symbol path; final component matched by AST name (e.g., 'MyClass.myMethod')." },
                            kind: { type: "string", description: "AST node kind hint (e.g., 'function_declaration')." },
                            line: { type: "integer", minimum: 1, description: "1-based line hint for disambiguation (e.g., 12)." },
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
                        description: "Experimental hashline edit metadata. Enable SMART_EDIT_USE_HASHLINE_EDITING or its experimental alias.",
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
                    op: {
                        type: "string",
                        enum: ["copy", "move"],
                        description:
                            "Relocate existing observed text by reference instead of reproducing it in newText: `copy` leaves the source intact, `move` deletes it after transfer, and `after` is required when `to` exists (omitted when creating a new file). Example: {\"op\":\"copy\",\"from\":\"a.ts\",\"range\":{\"pos\":\"10ab\",\"end\":\"12cd\"},\"to\":\"a.ts\",\"after\":\"40ef\"}",
                    },
                    from: { type: "string", description: "Source file path for a transfer op." },
                    range: {
                        type: "object",
                        additionalProperties: false,
                        description: "Transfer op source anchor range in `from`, pre-edit coordinates from the last read.",
                        properties: {
                            pos: { type: "string", minLength: 1, description: "Start hashline anchor of the source span." },
                            end: { type: "string", minLength: 1, description: "End hashline anchor of the source span." },
                        },
                        required: ["pos", "end"],
                    },
                    to: { type: "string", description: "Destination file path for a transfer op." },
                    after: { type: "string", minLength: 1, description: "Destination hashline anchor to insert after. Omit when `to` is a new file." },
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
                    { required: ["op", "from", "range", "to"] },
                ],
            },
        },
        raw: {
            type: "string",
            description: "Raw patch text in a supported diff/patch format.",
        },
        refactor: {
            type: "object",
            additionalProperties: false,
            description: "Refactor preview/apply variant. Mutually exclusive with edits/raw.",
            properties: {
                kind: { type: "string", enum: ["rename-preview", "apply-refactor-preview"] },
                path: { type: "string" },
                line: { type: "integer", minimum: 0 },
                character: { type: "integer", minimum: 0 },
                newName: { type: "string" },
                previewId: { type: "string" },
            },
            required: ["kind"],
        },
    },
} as const;
