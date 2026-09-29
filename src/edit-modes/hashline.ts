import { validateEditRequest, type EditOperation, type EditRequest } from "../edit-contract.js";
import type { EditModeSpec } from "./types.js";

function fail(error: string): { ok: false; error: string } {
    return { ok: false, error };
}

/**
 * Validate the hashline-only wire contract used when hashline mode is enabled.
 * The normal validator remains intentionally unchanged for classic mode and
 * stored-session compatibility; this stricter layer rejects every alternate
 * mutation dialect at runtime as well as hiding it from the agent schema.
 */
/** Gate the request-level variant: raw dialect and empty edits rejected. */
function gateHashlineVariant(value: EditRequest): string | null {
    if (value.raw !== undefined) {
        return "hashline edit mode accepts only `edits` with hashline metadata";
    }
    if (!value.edits || value.edits.length === 0) {
        return "hashline edit mode requires at least one hashline edit";
    }
    return null;
}

/** Check one edit carries hashline metadata with explicit content. */
function checkHashlineEditShape(edit: EditOperation, i: number): string | null {
    if (!edit.hashline) {
        return `edit.edits[${i}] must use hashline metadata while hashline edit mode is enabled`;
    }
    if (!Object.prototype.hasOwnProperty.call(edit.hashline, "content")) {
        return `edit.edits[${i}].hashline.content is required in hashline edit mode; use null explicitly to delete`;
    }
    return null;
}

/** Check :after/:before insertion suffix invariants for one edit. */
function checkInsertionSuffix(edit: EditOperation, i: number): string | null {
    const h = edit.hashline;
    if (!h) return null;
    const { pos, end } = h.range;
    const insertionSuffix = pos.endsWith(":after")
        ? ":after"
        : pos.endsWith(":before")
            ? ":before"
            : null;
    if (!insertionSuffix) return null;
    const base = pos.slice(0, -insertionSuffix.length);
    if (end !== base) {
        return `edit.edits[${i}].hashline.range.end must equal unsuffixed insertion anchor "${base}"`;
    }
    if (h.content === null) {
        return `edit.edits[${i}].hashline.content must be non-null for ${insertionSuffix} insertion`;
    }
    return null;
}

/** Check one edit exposes no dialect beyond path + hashline. */
function checkHashlineEditKeys(edit: EditOperation, i: number): string | null {
    const keys = Object.keys(edit as unknown as Record<string, unknown>);
    const unsupported = keys.find((key) => key !== "path" && key !== "hashline");
    if (unsupported) {
        return `edit.edits[${i}].${unsupported} is not supported while hashline edit mode is enabled`;
    }
    return null;
}

export function validateHashlineOnlyEditRequest(
    input: unknown,
): { ok: true; value: EditRequest } | { ok: false; error: string } {
    const validated = validateEditRequest(input);
    if (!validated.ok) return validated;

    const { value } = validated;
    const variantErr = gateHashlineVariant(value);
    if (variantErr) return fail(variantErr);

    // gateHashlineVariant returning null guarantees a non-empty edits array;
    // the fallback only satisfies the type checker and is unreachable.
    const edits = value.edits ?? [];
    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i] as EditOperation;
        const err = checkHashlineEditShape(edit, i)
            ?? checkInsertionSuffix(edit, i)
            ?? checkHashlineEditKeys(edit, i);
        if (err) return fail(err);
    }
    return validated;
}

/**
 * Hashline-only agent schema. Enabled only when hashline editing is active.
 * Unlike the normal schema, this intentionally exposes no oldText/newText,
 * raw patch, AST-target, lineRange, or refactor dialects.
 */
export const HASHLINE_EDIT_PARAMETERS = {
    type: "object",
    additionalProperties: false,
    properties: {
        path: {
            type: "string",
            minLength: 1,
            description: "Default target file path. May be omitted when every edit provides its own path.",
        },
        edits: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            description: "One or more hashline-only edits. This field must be a native JSON array of edit objects, never a JSON-encoded string and never a singleton object. All anchors must come from lines actually shown by a current read of the target file and must be copied as complete LINE+ID tokens; never combine a line number with a hash suffix from another row. Use tight ranges and separate nonadjacent changes.",
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    path: {
                        type: "string",
                        minLength: 1,
                        description: "Per-edit target file path. Overrides the top-level path.",
                    },
                    hashline: {
                        type: "object",
                        additionalProperties: false,
                        description: "Hashline mutation. Replace/delete shape: { range: { pos: \"112zc\", end: \"114aa\" }, content: replacement }. Insert shape: { range: { pos: \"112zc:after\", end: \"112zc\" }, content: inserted }. From read row \"112zc|const x = 1\", copy the complete token \"112zc\" before | as one unit. SmartEdit verifies token provenance against the retained read snapshot. Do not place pos/end directly under hashline.",
                        properties: {
                            range: {
                                type: "object",
                                additionalProperties: false,
                                description: "Source locator from the read snapshot. For replacement/deletion, pos/end are inclusive LINE+ID anchors. For insertion without replacing source text, append :after or :before to pos (for example \"42ab:after\") and set end to the unsuffixed base anchor \"42ab\". All anchors refer to the pre-edit file version.",
                                properties: {
                                    pos: {
                                        type: "string",
                                        minLength: 1,
                                        description: "Complete start LINE+ID anchor token from read output, e.g. \"112zc\". If the read row is \"112zc|const x = 1\", send only \"112zc\": no | and no source text. To insert without replacing a line, use \"112zc:after\" or \"112zc:before\" here.",
                                    },
                                    end: {
                                        type: "string",
                                        minLength: 1,
                                        description: "Complete end LINE+ID anchor token from read output, e.g. \"114aa\". Send only the token before |. For a one-line replacement repeat pos. For :after/:before insertion, use the unsuffixed base anchor here.",
                                    },
                                },
                                required: ["pos", "end"],
                            },
                            content: {
                                description: "Replacement content for the anchored range. Use a string or array of replacement lines. Use null explicitly to delete the range. Never put the source/old text here.",
                                oneOf: [
                                    { type: "array", items: { type: "string" } },
                                    { type: "string" },
                                    { type: "null" },
                                ],
                            },
                            symbol: {
                                type: "object",
                                additionalProperties: false,
                                description: "Optional symbol hint used only to scope safe fallback when anchors are stale.",
                                properties: {
                                    name: { type: "string", minLength: 1 },
                                    kind: { type: "string" },
                                    line: { type: "integer", minimum: 1 },
                                },
                                required: ["name"],
                            },
                        },
                        required: ["range", "content"],
                    },
                },
                required: ["hashline"],
            },
        },
    },
    required: ["edits"],
} as const;

export const HASHLINE_EDIT_DESCRIPTION = [
    "Apply hashline edits only, gated by workspace evidence.",
    "Read each target file first and copy complete LINE+ID anchors exactly from read output; only anchor lines actually shown by read, and read an elided/unseen target range before editing it.",
    "Keep ranges tight around changed lines; split nonadjacent changes into separate edit items instead of including unchanged keeper lines.",
    "The top-level edits field must be a native JSON array of edit objects, never a JSON-encoded string and never a singleton object. Each edit must use nested hashline.range plus hashline.content. Replace/delete example: { edits: [{ hashline: { range: { pos: \"112zc\", end: \"114aa\" }, content: replacement } }] }. Insert-after example: { edits: [{ hashline: { range: { pos: \"112zc:after\", end: \"112zc\" }, content: inserted } }] }.",
    "Copy only the LINE+ID token before the | separator from read output; never include the | or source text. Use :after or :before on pos for pure insertion instead of re-emitting keeper source lines. All anchors in one call refer to the same pre-edit file version.",
    "After a successful edit call, re-read before issuing another hashline edit against that file.",
    "Do not send oldText/newText, raw patches, lineRange, AST target operations, or refactor requests in hashline mode.",
].join(" ");

function prepareHashlineArguments(args: Record<string, unknown>): Record<string, unknown> {
    return args;
}

export const hashlineEditModeSpec: EditModeSpec = {
    id: "hashline",
    description: HASHLINE_EDIT_DESCRIPTION,
    parameters: HASHLINE_EDIT_PARAMETERS as unknown as Record<string, unknown>,
    validate: validateHashlineOnlyEditRequest,
    prepareArguments: prepareHashlineArguments,
};
