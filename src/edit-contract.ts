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
import type { EditTarget, HashlineEditMetadata, LineRange } from "./core/types.js";
import { normalizeRawEdit } from "./formats/edit-intents.js";

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
    /** Hashline-anchored edit metadata. Addresses source lines by stable
     *  anchor, with optional symbol scope for fallback. */
    hashline?: HashlineEditMetadata;
}

/** Rename preview: all fields required. */
export interface RenamePreviewRefactor {
    kind: "rename-preview";
    path: string;
    /** 1-based positions */
    line: number;
    /** 1-based positions */
    character: number;
    newName: string;
}

/** Apply a stored preview: only the preview id is relevant. */
export interface ApplyRefactorPreviewRefactor {
    kind: "apply-refactor-preview";
    previewId: string;
}

/** Organize-imports preview: path only. */
export interface OrganizeImportsPreviewRefactor {
    kind: "organize-imports-preview";
    path: string;
}

/** Formatting preview: path plus optional format options. */
export interface FormattingPreviewRefactor {
    kind: "formatting-preview";
    path: string;
    tabSize?: number;
    insertSpaces?: boolean;
}

/** Code-action preview: position plus optional range/diagnostics filters. */
export interface CodeActionPreviewRefactor {
    kind: "code-action-preview";
    path: string;
    /** 1-based positions */
    line: number;
    /** 1-based positions */
    character: number;
    /** 1-based positions */
    endLine?: number;
    /** 1-based positions */
    endCharacter?: number;
    diagnostics?: unknown;
    only?: unknown;
}

/**
 * Kind-discriminated refactor request. Each variant carries only the
 * fields relevant to its kind; per-kind requirements are enforced by
 * `validateEditRequest` at validation time so handlers receive narrowed
 * variants and never re-check required fields at runtime.
 */
export type RefactorRequest =
    | RenamePreviewRefactor
    | ApplyRefactorPreviewRefactor
    | OrganizeImportsPreviewRefactor
    | FormattingPreviewRefactor
    | CodeActionPreviewRefactor;

/** All wire keys accepted inside `edit.refactor` (union of per-kind keys). */
const REFACTOR_KEYS = new Set([
    "kind", "path", "line", "character", "newName", "previewId",
    "tabSize", "insertSpaces", "endLine", "endCharacter", "diagnostics", "only",
]);

/** Per-kind relevant keys (excluding `kind` itself). */
const REFACTOR_KEYS_BY_KIND: Record<string, ReadonlySet<string>> = {
    "rename-preview": new Set(["path", "line", "character", "newName"]),
    "apply-refactor-preview": new Set(["previewId"]),
    "organize-imports-preview": new Set(["path"]),
    "formatting-preview": new Set(["path", "tabSize", "insertSpaces"]),
    "code-action-preview": new Set(["path", "line", "character", "endLine", "endCharacter", "diagnostics", "only"]),
};

function requirePath(r: Record<string, unknown>, kind: string): string | null {
    if (typeof r.path !== "string" || r.path.length === 0)
        return `edit.refactor.path is required for "${kind}": provide a non-empty file path`;
    return null;
}

function requirePosField(r: Record<string, unknown>, kind: string, field: "line" | "character"): string | null {
    const v = r[field];
    if (v === undefined)
        return `edit.refactor.${field} is required for "${kind}" (>=1, 1-based)`;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
        return `edit.refactor.${field} must be a positive integer (>=1, 1-based)`;
    return null;
}

function checkOptionalPosField(r: Record<string, unknown>, field: "endLine" | "endCharacter"): string | null {
    const v = r[field];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 1))
        return `edit.refactor.${field} must be a positive integer (>=1, 1-based) if present`;
    return null;
}

function validateRenamePreviewRefactor(r: Record<string, unknown>): string | null {
    return requirePath(r, "rename-preview")
        ?? requirePosField(r, "rename-preview", "line")
        ?? requirePosField(r, "rename-preview", "character")
        ?? ((typeof r.newName !== "string" || r.newName.length === 0)
            ? `edit.refactor.newName is required for "rename-preview": provide a non-empty replacement name`
            : null);
}

function validateApplyRefactorPreviewRefactor(r: Record<string, unknown>): string | null {
    if (typeof r.previewId !== "string" || r.previewId.length === 0)
        return `edit.refactor.previewId is required for "apply-refactor-preview": provide the preview id returned by a preview call`;
    return null;
}

function validateOrganizeImportsPreviewRefactor(r: Record<string, unknown>): string | null {
    return requirePath(r, "organize-imports-preview");
}

function validateFormattingPreviewRefactor(r: Record<string, unknown>): string | null {
    const pathErr = requirePath(r, "formatting-preview");
    if (pathErr) return pathErr;
    if (r.tabSize !== undefined && !isPositiveInteger(r.tabSize))
        return "edit.refactor.tabSize must be a positive integer if present";
    if (r.insertSpaces !== undefined && typeof r.insertSpaces !== "boolean")
        return "edit.refactor.insertSpaces must be a boolean if present";
    return null;
}

function validateCodeActionPreviewRefactor(r: Record<string, unknown>): string | null {
    return requirePath(r, "code-action-preview")
        ?? requirePosField(r, "code-action-preview", "line")
        ?? requirePosField(r, "code-action-preview", "character")
        ?? checkOptionalPosField(r, "endLine")
        ?? checkOptionalPosField(r, "endCharacter")
        ?? ((r.diagnostics !== undefined && !Array.isArray(r.diagnostics))
            ? "edit.refactor.diagnostics must be an array if present"
            : null)
        ?? ((r.only !== undefined && (!Array.isArray(r.only) || !(r.only as unknown[]).every((o) => typeof o === "string")))
            ? "edit.refactor.only must be an array of strings if present"
            : null);
}

/**
 * Kind-discriminated refactor validation. Rejects unknown keys, then
 * rejects keys irrelevant to the variant kind, then enforces the
 * per-kind required fields and field types with precise errors.
 */
function checkRefactorKind(kind: unknown): string | null {
    const allowedKinds = new Set(Object.keys(REFACTOR_KEYS_BY_KIND));
    if (typeof kind !== "string" || !allowedKinds.has(kind))
        return "edit.refactor.kind must be \"rename-preview\", \"apply-refactor-preview\", \"organize-imports-preview\", \"formatting-preview\" or \"code-action-preview\"";
    return null;
}

function checkRefactorIrrelevantKeys(r: Record<string, unknown>, kind: string): string | null {
    const allowed = REFACTOR_KEYS_BY_KIND[kind as string] ?? new Set<string>(["kind"]);
    const irrelevant = Object.keys(r).find((key) => key !== "kind" && !allowed.has(key)) ?? null;
    if (irrelevant) return `edit.refactor.${irrelevant} is not supported for kind "${kind}"`;
    return null;
}

function validateRefactorByKind(kind: string, r: Record<string, unknown>): string | null {
    switch (kind as string) {
        case "rename-preview": return validateRenamePreviewRefactor(r);
        case "apply-refactor-preview": return validateApplyRefactorPreviewRefactor(r);
        case "organize-imports-preview": return validateOrganizeImportsPreviewRefactor(r);
        case "formatting-preview": return validateFormattingPreviewRefactor(r);
        default: return validateCodeActionPreviewRefactor(r);
    }
}

function validateRefactor(r: Record<string, unknown>): string | null {
    const unknown = firstUnknownKey(r, REFACTOR_KEYS);
    if (unknown) return `edit.refactor.${unknown} is not supported`;
    const kindErr = checkRefactorKind(r.kind);
    if (kindErr) return kindErr;
    const irrelevantErr = checkRefactorIrrelevantKeys(r, r.kind as string);
    if (irrelevantErr) return irrelevantErr;
    return validateRefactorByKind(r.kind as string, r);
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

function targetHasIdentifier(name: unknown, namePath: unknown, line: unknown): boolean {
    const hasName = typeof name === "string" && name.length > 0;
    const hasNamePath = typeof namePath === "string" && namePath.length > 0;
    const hasLine = line !== undefined;
    return hasName || hasNamePath || hasLine;
}

function checkTargetSymbolicOpsExclusive(
    replaceBody: unknown,
    insertBefore: unknown,
    insertAfter: unknown,
    i: number,
): string | null {
    const symbolicOps = [replaceBody, insertBefore, insertAfter].filter((v) => v !== undefined);
    if (symbolicOps.length > 1)
        return `edit.edits[${i}].target: at most one of replaceBody, insertBefore, insertAfter may be provided`;
    return null;
}

function checkTargetPatternPair(pattern: unknown, replacement: unknown, i: number): string | null {
    const hasPattern = pattern !== undefined;
    const hasReplacement = replacement !== undefined;
    if (hasPattern !== hasReplacement)
        return `edit.edits[${i}].target: pattern and replacement must be provided together`;
    return null;
}

function checkTargetIdentifierRequirement(t: Record<string, unknown>, hasPattern: boolean, i: number): string | null {
    if (!hasPattern && !targetHasIdentifier(t.name, t.namePath, t.line))
        return `edit.edits[${i}].target requires name, namePath, or line`;
    return null;
}

function checkTargetStringFields(t: Record<string, unknown>, i: number): string | null {
    const { name, namePath, kind, replaceBody, insertBefore, insertAfter, description, pattern, replacement } = t;
    for (const [key, value] of Object.entries({
        name, namePath, kind, replaceBody, insertBefore, insertAfter, description, pattern, replacement,
    })) {
        if (value !== undefined && typeof value !== "string")
            return `edit.edits[${i}].target.${key} must be a string if present`;
    }
    return null;
}

function checkTargetLine(line: unknown, i: number): string | null {
    if (line !== undefined && !isPositiveInteger(line))
        return `edit.edits[${i}].target.line must be a positive integer if present`;
    return null;
}

function validateTarget(t: Record<string, unknown>, i: number): string | null {
    const unknown = firstUnknownKey(t, new Set([
        "name", "namePath", "kind", "line", "replaceBody", "insertBefore",
        "insertAfter", "description", "pattern", "replacement",
    ]));
    if (unknown) return `edit.edits[${i}].target.${unknown} is not supported`;
    const { line, replaceBody, insertBefore, insertAfter, pattern, replacement } = t;
    return checkTargetStringFields(t, i)
        ?? checkTargetLine(line, i)
        ?? checkTargetPatternPair(pattern, replacement, i)
        ?? checkTargetSymbolicOpsExclusive(replaceBody, insertBefore, insertAfter, i)
        ?? checkTargetIdentifierRequirement(t, pattern !== undefined, i);
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

function isValidHashlineContent(content: unknown): boolean {
    if (Array.isArray(content)) return content.every((c) => typeof c === "string");
    return typeof content === "string" || content === null;
}

function checkHashlineSymbol(symbol: Record<string, unknown>, i: number): string | null {
    const unknownSymbolKey = firstUnknownKey(symbol, new Set(["name", "kind", "line"]));
    if (unknownSymbolKey) return `edit.edits[${i}].hashline.symbol.${unknownSymbolKey} is not supported`;
    const { name, kind, line } = symbol;
    if (typeof name !== "string" || name.length === 0)
        return `edit.edits[${i}].hashline.symbol.name must be a non-empty string`;
    if (kind !== undefined && typeof kind !== "string")
        return `edit.edits[${i}].hashline.symbol.kind must be a string if present`;
    if (line !== undefined && !isPositiveInteger(line))
        return `edit.edits[${i}].hashline.symbol.line must be a positive integer if present`;
    return null;
}

function checkHashlineRange(h: Record<string, unknown>, i: number): string | null {
    const { range } = h;
    if (!isPlainObject(range))
        return `edit.edits[${i}].hashline.range must be an object`;
    return validatePosEndRange(range, i, "hashline.range");
}

function checkHashlineContent(content: unknown, i: number): string | null {
    if (content !== undefined && !isValidHashlineContent(content))
        return `edit.edits[${i}].hashline.content must be a string, array of strings, or null`;
    return null;
}

function checkHashlineSymbolField(symbol: unknown, i: number): string | null {
    if (symbol === undefined) return null;
    if (!isPlainObject(symbol))
        return `edit.edits[${i}].hashline.symbol must be an object if present`;
    return checkHashlineSymbol(symbol, i);
}

function validateHashline(h: Record<string, unknown>, i: number): string | null {
    const unknown = firstUnknownKey(h, new Set(["range", "content", "symbol"]));
    if (unknown) return `edit.edits[${i}].hashline.${unknown} is not supported`;
    const { content, symbol } = h;
    return checkHashlineRange(h, i)
        ?? checkHashlineContent(content, i)
        ?? checkHashlineSymbolField(symbol, i);
}

function isNonEmptyString(v: unknown): v is string {
    return typeof v === "string" && v.length > 0;
}

function isMissingNonEmptyString(v: unknown): boolean {
    return typeof v !== "string" || v.length === 0;
}

function checkScalarPath(e: Record<string, unknown>, i: number): string | null {
    const { path } = e;
    if (path !== undefined && isMissingNonEmptyString(path))
        return `edit.edits[${i}].path must be a non-empty string if present`;
    return null;
}

function checkScalarOldText(e: Record<string, unknown>, i: number): string | null {
    if (e.oldText !== undefined && typeof e.oldText !== "string")
        return `edit.edits[${i}].oldText must be a string if present`;
    return null;
}

function checkScalarNewText(e: Record<string, unknown>, i: number): string | null {
    if (e.newText !== undefined && typeof e.newText !== "string")
        return `edit.edits[${i}].newText must be a string if present`;
    return null;
}

function checkScalarDescription(e: Record<string, unknown>, i: number): string | null {
    if (e.description !== undefined && typeof e.description !== "string")
        return `edit.edits[${i}].description must be a string if present`;
    return null;
}

function checkScalarReplaceAll(e: Record<string, unknown>, i: number): string | null {
    if (e.replaceAll !== undefined && typeof e.replaceAll !== "boolean")
        return `edit.edits[${i}].replaceAll must be a boolean if present`;
    return null;
}

function checkEditScalarFields(e: Record<string, unknown>, i: number): string | null {
    return checkScalarPath(e, i)
        ?? checkScalarOldText(e, i)
        ?? checkScalarNewText(e, i)
        ?? checkScalarDescription(e, i)
        ?? checkScalarReplaceAll(e, i);
}

function isValidEndLine(endLine: unknown, startLine: number): boolean {
    return typeof endLine === "number" && Number.isInteger(endLine) && endLine >= startLine;
}

function checkLineRangeField(lineRange: Record<string, unknown>, i: number): string | null {
    const unknownRangeKey = firstUnknownKey(lineRange, new Set(["startLine", "endLine"]));
    if (unknownRangeKey) return `edit.edits[${i}].lineRange.${unknownRangeKey} is not supported`;
    const { startLine, endLine } = lineRange;
    if (!isPositiveInteger(startLine))
        return `edit.edits[${i}].lineRange.startLine must be a positive integer`;
    if (!isValidEndLine(endLine, startLine as number))
        return `edit.edits[${i}].lineRange.endLine must be an integer >= startLine`;
    return null;
}

function checkTargetField(e: Record<string, unknown>, i: number): string | null {
    const { target } = e;
    if (target === undefined) return null;
    if (!isPlainObject(target))
        return `edit.edits[${i}].target must be an object if present`;
    return validateTarget(target, i);
}

function checkLineRangeObject(e: Record<string, unknown>, i: number): string | null {
    const { lineRange } = e;
    if (lineRange === undefined) return null;
    if (!isPlainObject(lineRange))
        return `edit.edits[${i}].lineRange must be an object if present`;
    return checkLineRangeField(lineRange, i);
}

function checkHashlineField(e: Record<string, unknown>, i: number): string | null {
    const { hashline } = e;
    if (hashline === undefined) return null;
    if (!isPlainObject(hashline))
        return `edit.edits[${i}].hashline must be an object if present`;
    return validateHashline(hashline, i);
}

function checkAnchoredEditFields(e: Record<string, unknown>, i: number): string | null {
    return checkTargetField(e, i)
        ?? checkLineRangeObject(e, i)
        ?? checkHashlineField(e, i);
}

function hasTextPair(oldText: unknown, newText: unknown): boolean {
    return typeof oldText === "string" && typeof newText === "string";
}

function asTargetRecord(target: unknown): Record<string, unknown> | undefined {
    if (target !== undefined && isPlainObject(target))
        return target as Record<string, unknown>;
    return undefined;
}

function isSelfActionableTarget(target: unknown): boolean {
    const targetObj = asTargetRecord(target);
    return !!targetObj
        && (targetHasSymbolicOp(targetObj) || targetHasStructuralOp(targetObj));
}

function isSelfActionableHashline(hashline: unknown): boolean {
    return hashline !== undefined && isPlainObject(hashline);
}

function checkHalfTextPair(oldText: unknown, newText: unknown, i: number): string | null {
    if ((oldText !== undefined) !== (newText !== undefined))
        return `edit.edits[${i}] oldText and newText must be provided together for a text edit`;
    return null;
}

function checkActionableBoundary(e: Record<string, unknown>, i: number): string | null {
    const { oldText, newText, target, hashline } = e;
    if (hasTextPair(oldText, newText)) return null;
    if (isSelfActionableTarget(target) || isSelfActionableHashline(hashline)) return null;
    return checkHalfTextPair(oldText, newText, i)
        ?? `edit.edits[${i}] requires an actionable operation: provide both oldText and newText, or a symbolic/structural target or hashline`;
}

function validateEditOperation(e: Record<string, unknown>, i: number): string | null {
    const unknown = firstUnknownKey(e, new Set([
        "path", "oldText", "newText", "description", "replaceAll", "target",
        "lineRange", "hashline",
    ]));
    if (unknown) {
        if (TRANSFER_KEYS.has(unknown))
            return `edit.edits[${i}].${unknown} is not supported: transfer operations (copy/move) belong to the transfer tool, not edit`;
        return `edit.edits[${i}].${unknown} is not supported`;
    }
    const scalarErr = checkEditScalarFields(e, i);
    if (scalarErr) return scalarErr;
    const anchoredErr = checkAnchoredEditFields(e, i);
    if (anchoredErr) return anchoredErr;

    // Actionable-operation boundary: a text edit needs both oldText and newText;
    // otherwise the item must be self-actionable via a symbolic/structural target
    // or hashline. A description-only or empty item is rejected with a precise
    // error naming the missing requirement. A scoping-only target (identifier
    // without a symbolic/structural op and without oldText/newText) is not
    // actionable on its own.
    return checkActionableBoundary(e, i);
}

/**
 * Runtime validator for the canonical edit request.
 *
 * Accepts current edit arrays (with rich fields) and `raw` alone; rejects
 * `raw`+`edits` as mutually exclusive. `evidenceRef` is optional and never
 * required — authority is tool-owned.
 */
function checkRequestVariantExclusivity(hasEdits: boolean, hasRaw: boolean, hasRefactor: boolean): string | null {
    const variantCount = (hasEdits ? 1 : 0) + (hasRaw ? 1 : 0) + (hasRefactor ? 1 : 0);
    if (variantCount > 1)
        return "edit.edits, edit.raw, and edit.refactor are mutually exclusive; provide exactly one";
    if (variantCount === 0)
        return "edit requires either edits (array), raw (string), or refactor";
    return null;
}

function targetHasSymbolicOp(targetObj: Record<string, unknown>): boolean {
    return targetObj.replaceBody !== undefined
        || targetObj.insertBefore !== undefined
        || targetObj.insertAfter !== undefined;
}

function targetHasStructuralOp(targetObj: Record<string, unknown>): boolean {
    return typeof targetObj.pattern === "string"
        && typeof targetObj.replacement === "string";
}

/** Transfer-shaped keys belong to the transfer tool; edit rejects them. */
const TRANSFER_KEYS: ReadonlySet<string> = new Set(["op", "from", "range", "to", "after"]);

function checkSingleEditItem(editList: unknown[], i: number): string | null {
    const e = editList[i];
    if (!isPlainObject(e)) return `edit.edits[${i}] must be an object`;
    return validateEditOperation(e, i);
}

function validateEditItems(editList: unknown[]): string | null {
    for (let i = 0; i < editList.length; i++) {
        const err = checkSingleEditItem(editList, i);
        if (err) return err;
    }
    return null;
}

function editsNeedTopLevelPath(editList: unknown[]): boolean {
    return editList.some((item) => (item as Record<string, unknown>).path === undefined);
}

function checkEditsList(edits: unknown, path: unknown): string | null {
    if (!Array.isArray(edits) || edits.length === 0)
        return "edit.edits must be a non-empty array";
    const editList = edits as unknown[];
    const itemsErr = validateEditItems(editList);
    if (itemsErr) return itemsErr;
    if (path === undefined && editsNeedTopLevelPath(editList))
        return "edit.path is required unless every edit provides its own path";
    return null;
}

function checkTopLevelScalars(path: unknown, toolCallId: unknown): { ok: false; error: string } | null {
    return checkTopLevelPath(path) ?? checkTopLevelToolCallId(toolCallId);
}

function checkTopLevelPath(path: unknown): { ok: false; error: string } | null {
    if (path !== undefined && isMissingNonEmptyString(path))
        return fail("edit.path, if present, must be a non-empty string");
    return null;
}

function checkTopLevelToolCallId(toolCallId: unknown): { ok: false; error: string } | null {
    if (toolCallId !== undefined && isMissingNonEmptyString(toolCallId))
        return fail("edit.toolCallId must be a non-empty string");
    return null;
}

/** Admission caps: enforced early in the validator, before locks/snapshots/hashing.
 *  Counts mirror LSP WorkspaceEdit limits (50 files / 5000 edits); the
 *  per-request 100-item cap is stricter and governs. */
export const MAX_EDIT_ITEMS = 100;
export const MAX_FILES_TOUCHED = 50;
export const MAX_TOTAL_EDITS = 5000;
/** Max bytes of request body text (sum of oldText+newText+replaceBody+pattern+replacement+raw). */
export const MAX_REQUEST_TEXT_BYTES = 4 * 1024 * 1024;
/** Max bytes for any single request string field. */
export const MAX_REQUEST_STRING_BYTES = 1 * 1024 * 1024;

function checkRawField(raw: unknown): { ok: false; error: string } | null {
    if (isMissingNonEmptyString(raw))
        return fail("edit.raw must be a non-empty string");
    return null;
}

function checkRawVariant(hasRaw: boolean, raw: unknown): { ok: false; error: string } | null {
    if (!hasRaw) return null;
    return checkRawField(raw);
}

function checkEditsVariant(hasEdits: boolean, edits: unknown, path: unknown): { ok: false; error: string } | null {
    if (!hasEdits) return null;
    const editsErr = checkEditsList(edits, path);
    if (editsErr) return fail(editsErr);
    return null;
}

function accountCappedString(field: string, value: string, total: { bytes: number }): string | null {
    const n = Buffer.byteLength(value, "utf8");
    if (n > MAX_REQUEST_STRING_BYTES)
        return `${field} is ${n} bytes (max ${MAX_REQUEST_STRING_BYTES}): split the edit into smaller items and retry`;
    total.bytes += n;
    if (total.bytes > MAX_REQUEST_TEXT_BYTES)
        return `edit request text is over ${MAX_REQUEST_TEXT_BYTES} bytes total: split the request into smaller batches and retry`;
    return null;
}

/** All accepted string fields of one edit item, for byte accounting. */
function editItemStrings(e: Record<string, unknown>, i: number): Array<[string, unknown]> {
    const t = (e.target ?? {}) as Record<string, unknown>;
    const h = (e.hashline ?? {}) as Record<string, unknown>;
    const hr = (h.range ?? {}) as Record<string, unknown>;
    const hs = (h.symbol ?? {}) as Record<string, unknown>;
    return [
        [`edit.edits[${i}].path`, e.path],
        [`edit.edits[${i}].oldText`, e.oldText],
        [`edit.edits[${i}].newText`, e.newText],
        [`edit.edits[${i}].description`, e.description],
        [`edit.edits[${i}].target.name`, t.name],
        [`edit.edits[${i}].target.namePath`, t.namePath],
        [`edit.edits[${i}].target.kind`, t.kind],
        [`edit.edits[${i}].target.replaceBody`, t.replaceBody],
        [`edit.edits[${i}].target.insertBefore`, t.insertBefore],
        [`edit.edits[${i}].target.insertAfter`, t.insertAfter],
        [`edit.edits[${i}].target.description`, t.description],
        [`edit.edits[${i}].target.pattern`, t.pattern],
        [`edit.edits[${i}].target.replacement`, t.replacement],
        [`edit.edits[${i}].hashline.range.pos`, hr.pos],
        [`edit.edits[${i}].hashline.range.end`, hr.end],
        [`edit.edits[${i}].hashline.symbol.name`, hs.name],
        [`edit.edits[${i}].hashline.symbol.kind`, hs.kind],
    ];
}

function checkRefactorAdmissionCaps(refactor: unknown): string | null {
    if (!isPlainObject(refactor)) return null;
    const total = { bytes: 0 };
    const strings: Array<[string, unknown]> = [
        ["edit.refactor.path", (refactor as Record<string, unknown>).path],
        ["edit.refactor.newName", (refactor as Record<string, unknown>).newName],
        ["edit.refactor.previewId", (refactor as Record<string, unknown>).previewId],
    ];
    for (const [field, value] of strings) {
        if (typeof value !== "string") continue;
        const err = accountCappedString(field, value, total);
        if (err) return err;
    }
    // diagnostics is an array of unknown-shaped objects; account serialized bytes.
    const diagnostics = (refactor as Record<string, unknown>).diagnostics;
    if (diagnostics !== undefined) {
        let serialized: string;
        try { serialized = JSON.stringify(diagnostics) ?? ""; }
        catch { serialized = String(diagnostics); }
        const err = accountCappedString("edit.refactor.diagnostics", serialized, total);
        if (err) return err;
    }
    // only is a string array; account each element.
    for (const key of ["only"] as const) {
        const arr = (refactor as Record<string, unknown>)[key];
        if (!Array.isArray(arr)) continue;
        for (let j = 0; j < arr.length; j++) {
            if (typeof arr[j] !== "string") continue;
            const err = accountCappedString(`edit.refactor.${key}[${j}]`, arr[j] as string, total);
            if (err) return err;
        }
    }
    return null;
}

/** Raw fan-out count via a single normalization pass.
 *  Counts every supported raw format (JSON, search/replace, unified diff,
 *  Codex/OpenAI patch, atomic envelope); unparseable raw throws so the
 *  caller falls through to per-format validation downstream. */
function countRawIntents(raw: string, defaultPath?: string): { intents: number; files: number } {
    const normalized = normalizeRawEdit(raw, defaultPath);
    if (normalized.intents.length === 0) throw new Error(normalized.diagnostics[0] ?? "raw parsed into zero operations");
    const files = new Set<string>();
    for (const intent of normalized.intents) {
        if (intent.kind === "text") { if (intent.operation.path) files.add(intent.operation.path); }
        else if (intent.kind === "rename") { files.add(intent.oldPath); files.add(intent.newPath); }
        else files.add(intent.path);
    }
    return { intents: normalized.intents.length, files: files.size };
}

function checkAdmissionCaps(normalized: Record<string, unknown>): string | null {
    // Early admission gate: counts + body-text bytes, before per-item
    // validation (and far before locks/snapshots/hashing). Counts mirror LSP
    // WorkspaceEdit limits (50 files / 5000 edits); the 100-item cap governs.
    const { edits, raw, path, refactor } = normalized;
    if (typeof raw === "string") {
        const rawBytes = Buffer.byteLength(raw, "utf8");
        if (rawBytes > MAX_REQUEST_STRING_BYTES)
            return `edit.raw is ${rawBytes} bytes (max ${MAX_REQUEST_STRING_BYTES}): split the patch into smaller raw requests and retry`;
        if (rawBytes > MAX_REQUEST_TEXT_BYTES)
            return `edit request text is over ${MAX_REQUEST_TEXT_BYTES} bytes total: split the request into smaller batches and retry`;
        // Fan-out guard: a compact raw string can expand into many files/ops
        // during normalization. Count intents best-effort; unparseable raw
        // falls through to per-format validation downstream.
        try {
            const { intents, files } = countRawIntents(raw, typeof path === "string" ? path : undefined);
            if (intents > MAX_EDIT_ITEMS)
                return `edit.raw expands to ${intents} operations (max ${MAX_EDIT_ITEMS}): split the patch into smaller raw requests and retry`;
            if (intents > MAX_TOTAL_EDITS)
                return `edit.raw expands to ${intents} operations (max ${MAX_TOTAL_EDITS} total): split the patch into smaller raw requests and retry`;
            if (files > MAX_FILES_TOUCHED)
                return `edit.raw touches ${files} files (max ${MAX_FILES_TOUCHED}): split the patch into smaller raw requests and retry`;
        } catch { /* fall through to format validation */ }
        return null;
    }
    const refactorErr = checkRefactorAdmissionCaps(refactor);
    if (refactorErr) return refactorErr;
    if (!Array.isArray(edits)) return null;
    if (edits.length > MAX_EDIT_ITEMS)
        return `edit.edits has ${edits.length} items (max ${MAX_EDIT_ITEMS}): split the request into smaller batches and retry`;
    if (edits.length > MAX_TOTAL_EDITS)
        return `edit.edits has ${edits.length} items (max ${MAX_TOTAL_EDITS} total): split the request into smaller batches and retry`;
    const files = new Set<string>();
    const topPath = typeof path === "string" ? path : null;
    if (typeof path === "string") {
        const n = Buffer.byteLength(path, "utf8");
        if (n > MAX_REQUEST_STRING_BYTES)
            return `edit.path is ${n} bytes (max ${MAX_REQUEST_STRING_BYTES}): split the request into smaller batches and retry`;
    }
    const total = { bytes: typeof path === "string" ? Buffer.byteLength(path, "utf8") : 0 };
    for (let i = 0; i < edits.length; i++) {
        const e = edits[i] as Record<string, unknown>;
        if (!e || typeof e !== "object") continue;
        const p = typeof e.path === "string" ? e.path : topPath;
        if (p) files.add(p);
        for (const [field, value] of editItemStrings(e, i)) {
            if (typeof value !== "string") continue;
            const err = accountCappedString(field, value, total);
            if (err) return err;
        }
        // hashline.content may be a string or array of strings.
        const h = (e.hashline ?? {}) as Record<string, unknown>;
        const content = (h as Record<string, unknown>).content;
        const contents = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
        for (let j = 0; j < contents.length; j++) {
            if (typeof contents[j] !== "string") continue;
            const err = accountCappedString(`edit.edits[${i}].hashline.content${Array.isArray(content) ? `[${j}]` : ""}`, contents[j] as string, total);
            if (err) return err;
        }
    }
    if (files.size > MAX_FILES_TOUCHED)
        return `edit touches ${files.size} files (max ${MAX_FILES_TOUCHED}): split the request into smaller batches and retry`;
    return null;
}

function checkRequestTopLevel(input: unknown): { normalized: Record<string, unknown> } | { ok: false; error: string } {
    if (!isPlainObject(input)) return fail("edit request must be an object");
    const normalized = normalizeFlatEditRequest(input);
    const unknown = firstUnknownKey(normalized, new Set([
        "path", "edits", "raw", "toolCallId", "evidenceRef", "refactor",
    ]));
    if (unknown) return fail(`edit.${unknown} is not supported`);
    return { normalized };
}

function checkRefactorRequest(refactor: unknown, normalized: Record<string, unknown>): { ok: true; value: EditRequest } | { ok: false; error: string } | null {
    if (refactor === undefined) return null;
    if (!isPlainObject(refactor)) return fail("edit.refactor must be an object");
    const err = validateRefactor(refactor as Record<string, unknown>);
    if (err) return fail(err);
    return ok(normalized as EditRequest);
}

function checkEvidenceField(evidenceRef: unknown): { ok: false; error: string } | null {
    // evidenceRef is optional (tool-owned authority). If present, validate its
    // shape so stored calls with a malformed ref fail cleanly rather than crash.
    if (evidenceRef === undefined) return null;
    const er = validateEvidenceRef(evidenceRef);
    if (!er.ok) return er;
    return null;
}

export function validateEditRequest(
    input: unknown,
): { ok: true; value: EditRequest } | { ok: false; error: string } {
    const top = checkRequestTopLevel(input);
    if (!("normalized" in top)) return top;
    const { normalized } = top;
    const capsErr = checkAdmissionCaps(normalized);
    if (capsErr) return fail(capsErr);
    const { path, edits, raw, toolCallId, evidenceRef, refactor } = normalized;

    const scalarsErr = checkTopLevelScalars(path, toolCallId);
    if (scalarsErr) return scalarsErr;

    const hasEdits = edits !== undefined;
    const hasRaw = raw !== undefined;
    const hasRefactor = refactor !== undefined;
    const variantErr = checkRequestVariantExclusivity(hasEdits, hasRaw, hasRefactor);
    if (variantErr) return fail(variantErr);
    const refactorResult = checkRefactorRequest(refactor, normalized);
    if (refactorResult) return refactorResult;
    const rawErr = checkRawVariant(hasRaw, raw);
    if (rawErr) return rawErr;

    const editsResult = checkEditsVariant(hasEdits, edits, path);
    if (editsResult) return editsResult;

    const evidenceErr = checkEvidenceField(evidenceRef);
    if (evidenceErr) return evidenceErr;

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
            minItems: 1,
            maxItems: 100,
            description: "One or more targeted edits that transform or generate content. Mutually exclusive with `raw`. When existing content should be preserved and relocated/reused, prefer transfer.",
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
                        description: "Hashline-anchored edit metadata. Addresses source lines by stable anchor, with optional symbol scope for fallback.",
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
            description: "Raw patch text in a supported diff/patch format.",
        },
        refactor: {
            type: "object",
            additionalProperties: false,
            description: "Refactor preview/apply variant. Mutually exclusive with edits/raw.",
            properties: {
                kind: { type: "string", enum: ["rename-preview", "apply-refactor-preview", "organize-imports-preview", "formatting-preview", "code-action-preview"] },
                path: { type: "string" },
                line: { type: "integer", minimum: 1 },
                character: { type: "integer", minimum: 1 },
                newName: { type: "string" },
                previewId: { type: "string" },
                tabSize: { type: "integer", minimum: 1 },
                insertSpaces: { type: "boolean" },
                endLine: { type: "integer", minimum: 1 },
                endCharacter: { type: "integer", minimum: 1 },
                diagnostics: { type: "array", items: { type: "object" } },
                only: { type: "array", items: { type: "string" } },
            },
            required: ["kind"],
        },
    },
} as const;
