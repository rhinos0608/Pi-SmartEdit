import { relative, isAbsolute, resolve } from "path";
import { Buffer } from "buffer";
import type { EditItem, EditInput } from "./core/types";
import { isSymbolicEdit } from "./symbolic-edits.js";
import { HASHLINE_CONTENT_SEPARATOR } from "./core/hashline";
import { detectInputFormat } from "./formats/format-detector.js";
import { repairJson } from "./formats/forgiving-parser.js";
import { normalizeLegacyEditRequest } from "./edit-contract.js";
import { normalizeRawEdit } from "./edit-intents.js";

// ─── Hashline display prefix stripping ───────────────────────────────

export const HASHLINE_PREFIX_RE = new RegExp(`^\\d+[a-z]{2}\\${HASHLINE_CONTENT_SEPARATOR}`);

export function stripHashlineDisplayPrefixes(content: string, useHashlineEditing: boolean): { text: string; stripped: boolean } {
  if (!useHashlineEditing) return { text: content, stripped: false };
  if (!content || !content.includes(HASHLINE_CONTENT_SEPARATOR)) return { text: content, stripped: false };
  const lines = content.split('\n');
  let anyStripped = false;
  const strippedLines = lines.map((line) => {
    if (HASHLINE_PREFIX_RE.test(line)) { anyStripped = true; return line.replace(HASHLINE_PREFIX_RE, ''); }
    return line;
  });
  return { text: strippedLines.join('\n'), stripped: anyStripped };
}

// ─── Error formatting (actionable client-facing errors) ─────────────

/**
 * Wrap an error with an actionable message instead of a raw data dump.
 *
 * Strips the "Received arguments:" noise that Pi's built-in validation
 * dumps and returns a concise, fix-oriented error.
 */
export function formatEditError(message: string, hint?: string): Error {
  let text = `❌ ${message}`;
  if (hint) {
    text += `\n\n${hint}`;
  }
  return new Error(text);
}

// ─── JSON string repair (truncated / unescaped newlines) ────────────

/**
 * Attempt to repair a malformed JSON string that may have:
 * - Literal newlines inside string values (most common — tool pipelines
 *   sometimes serialise arrays into strings without escaping newlines)
 * - Truncation (incomplete JSON array from a clipped tool-call pipeline)
 * - Improper escaping
 *
 * Returns the parsed result if any strategy succeeds, or undefined.
 */
function tryRepairJSONString(raw: string): unknown {
  // Strategy: truncated JSON array — extract complete edit objects before
  // forgiving parser extracts a single inner object.
  try {
    if (/^\s*\[/.test(raw) && !/\]\s*$/.test(raw) && raw.includes('{') && raw.includes('}')) {
      const partial = tryExtractPartialEdits(raw);
      if (partial.length > 0) return partial;
    }
  } catch {
    // fall through
  }

  // Delegate to the forgiving parser (SmallCode-inspired 7-strategy pipeline).
  // The forgiving parser handles: as-is, trailing comma, wrap braces, strip
  // markdown fences, extract {...} block, literal newline escape, and
  // unbalanced brace fix — all with fuzzy key matching built in.
  const forgivingResult = repairJson(raw, {
    edit: ["path", "edits", "oldText", "newText", "replaceAll", "target"],
  });
  if (forgivingResult.value !== undefined) {
    return forgivingResult.value;
  }

  return undefined;
}

/**
 * Extract complete edit objects from a truncated JSON array string.
 * Walks character-by-character tracking brace depth and string state,
 * collecting every complete top-level { … } object it can find.
 */
function tryExtractPartialEdits(raw: string): unknown[] {
  const results: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const objStr = raw.slice(start, i + 1);
        try {
          const parsed = JSON.parse(objStr) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            results.push(parsed);
          }
        } catch {
          // skip unparseable fragment
        }
        start = -1;
      }
    }
  }

  return results;
}

const LEGACY_EXTRA_MARKER = "??smartEditExtra=";

export interface LegacyEditMetadata {
  replaceAllFlags?: boolean[] | null;
  targetData?: Array<Record<string, unknown> | null> | null;
  hashlineData?: Array<Record<string, unknown> | null> | null;
}

export interface ResolvedEditMetadata {
  replaceAllFlags: boolean[];
  targetData: Array<Record<string, unknown> | undefined>;
  hashlineData: Array<Record<string, unknown> | undefined>;
}

export function decodeLegacyPathMetadata(path: string): {
  path: string;
  metadata: LegacyEditMetadata | null;
} {
  const markerIndex = path.indexOf(LEGACY_EXTRA_MARKER);
  if (markerIndex === -1) return { path, metadata: null };

  const cleanPath = path.slice(0, markerIndex);
  try {
    const decoded = JSON.parse(
      Buffer.from(path.slice(markerIndex + LEGACY_EXTRA_MARKER.length), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return { path, metadata: null };
    }

    const replaceAllFlags = decoded.replaceAllFlags;
    const targetData = decoded.targetData;
    const hashlineData = decoded.hashlineData;
    const validFlags = replaceAllFlags == null ||
      (Array.isArray(replaceAllFlags) && replaceAllFlags.every((flag) => typeof flag === "boolean"));
    const validObjects = (value: unknown) => value == null ||
      (Array.isArray(value) && value.every((item) => item == null ||
        (typeof item === "object" && !Array.isArray(item))));
    if (!validFlags || !validObjects(targetData) || !validObjects(hashlineData)) {
      return { path, metadata: null };
    }

    return {
      path: cleanPath,
      metadata: {
        replaceAllFlags: replaceAllFlags as boolean[] | null | undefined,
        targetData: targetData as Array<Record<string, unknown> | null> | null | undefined,
        hashlineData: hashlineData as Array<Record<string, unknown> | null> | null | undefined,
      },
    };
  } catch {
    return { path, metadata: null };
  }
}

export function resolveEditMetadata(
  edits: Array<Record<string, unknown>>,
  legacy: LegacyEditMetadata | null = null,
): ResolvedEditMetadata {
  return {
    replaceAllFlags: edits.map((edit, index) =>
      typeof edit.replaceAll === "boolean"
        ? edit.replaceAll
        : legacy?.replaceAllFlags?.[index] === true,
    ),
    targetData: edits.map((edit, index) =>
      edit.target && typeof edit.target === "object" && !Array.isArray(edit.target)
        ? edit.target as Record<string, unknown>
        : legacy?.targetData?.[index] ?? undefined,
    ),
    hashlineData: edits.map((edit, index) =>
      edit.hashline && typeof edit.hashline === "object" && !Array.isArray(edit.hashline)
        ? edit.hashline as Record<string, unknown>
        : legacy?.hashlineData?.[index] ?? undefined,
    ),
  };
}

export function splitMultiFileEditInput(
  input: Record<string, unknown>,
): Record<string, unknown>[] | null {
  if (!Array.isArray(input.edits)) return null;

  const edits = input.edits as Array<Record<string, unknown>>;
  const distinctPaths = new Map<string, string>();
  for (const edit of edits) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
    if (typeof edit.path === "string" && edit.path.length > 0) {
      distinctPaths.set(resolve(edit.path), edit.path);
    }
  }

  if (distinctPaths.size <= 1) return null;

  const missingPathIndex = edits.findIndex(
    (edit) => !edit || typeof edit !== "object" || Array.isArray(edit) ||
      typeof edit.path !== "string" || edit.path.length === 0,
  );
  if (missingPathIndex !== -1) {
    throw formatEditError(
      "Multi-file edit input is invalid: every edit must include path.",
      `edits[${missingPathIndex}] has no path. Add path to each edit in a multi-file call.`,
    );
  }

  const batches = new Map<string, { path: string; edits: Record<string, unknown>[] }>();
  for (const edit of edits) {
    const path = edit.path as string;
    const resolvedPath = resolve(path);
    let batch = batches.get(resolvedPath);
    if (!batch) {
      batch = { path, edits: [] };
      batches.set(resolvedPath, batch);
    }
    const { path: _path, ...fileEdit } = edit;
    batch.edits.push(fileEdit);
  }

  const sharedInput = { ...input };
  delete sharedInput.path;
  delete sharedInput.edits;

  return [...batches.values()].map((batch) => ({
    ...sharedInput,
    path: batch.path,
    edits: batch.edits,
  }));
}

type EditPathMode = "none" | "single" | "multiple";

function inferPathFromEditItems(args: Record<string, unknown>): EditPathMode {
  if (!Array.isArray(args.edits)) return "none";

  const editPaths = args.edits
    .map((edit) => edit && typeof edit === "object" && !Array.isArray(edit) ? (edit as Record<string, unknown>).path : undefined)
    .filter((path): path is string => typeof path === "string" && path.length > 0);

  if (editPaths.length === 0) return "none";

  const uniqueByResolvedPath = new Map<string, string>();
  for (const path of editPaths) {
    uniqueByResolvedPath.set(resolve(path), path);
  }

  if (uniqueByResolvedPath.size > 1) return "multiple";

  const inferredPath = uniqueByResolvedPath.values().next().value as string;
  if (typeof args.path === "string" && resolve(args.path) !== resolve(inferredPath)) {
    throw formatEditError(
      "Top-level path conflicts with edits[].path.",
      `path is ${JSON.stringify(args.path)}, but edits[].path is ${JSON.stringify(inferredPath)}.`,
    );
  }

  if (typeof args.path !== "string" || args.path.length === 0) {
    args.path = inferredPath;
  }
  return "single";
}

// ─── Legacy input compatibility ─────────────────────────────────────

export function prepareArguments(input: Record<string, unknown>, useHashlineEditing: boolean): Record<string, unknown> {
  if (!input || typeof input !== "object") return input;

  const args = { ...input } as Record<string, unknown>;

  // Canonical raw patch calls carry their path(s) inside the patch content
  // (e.g. `--- a/path` / `+++ b/path` headers), so a missing top-level path
  // is not an error. Return them unchanged: validation and normalization
  // happen in validateEditRequest and the patch adapter.
  if (typeof args.raw === "string" && args.raw.length > 0) {
    return args;
  }

  // ── Early validation for missing required fields ────────────
  // The built-in schema validation rejects these with a terse generic error
  // like "must have required properties path". We catch them here with
  // descriptive, actionable messages before schema validation runs.
  // IMPORTANT: This must come BEFORE legacy format normalization (which
  // converts {path, oldText, newText} to {path, edits: [...]}) but the
  // edits-missing check must come AFTER that normalization, since legacy
  // calls don't have an edits field.

  if (!args.path && !args.edits) {
    throw formatEditError(
      `Edit tool is missing both required fields: path and edits.`,
      `edit must be called with two fields:\n` +
      `  path: string   — path to the file to edit (relative or absolute)\n` +
      `  edits: array   — one or more oldText/newText edit objects\n` +
      `               OR edits: string — raw text in a supported format:\n` +
      `                 • search/replace (<<<<<<< SEARCH blocks)\n` +
      `                 • unified diff (--- a/ +++ b/ with @@ hunks)\n` +
      `                 • OpenAI patch (*** Begin Patch)\n` +
      `                 • Codex patch (*** Begin Patch with Add/Delete/Move)\n` +
      `                 • Atomic Patch (*** Begin Atomic Patch, multi-file)\n\n` +
      `Example:\n` +
      `  edit({\n` +
      `    path: "src/foo.ts",\n` +
      `    edits: [{ oldText: "old line", newText: "new line" }]\n` +
      `  })`
    );
  }

  // Some models send edits as a JSON string instead of an array.
  // This happens when the model serializes the array into a string
  // somewhere in the tool-calling pipeline.
  if (typeof args.edits === "string") {
    const raw = (args.edits as string).trim();

    // Empty string: immediate actionable error
    if (!raw) {
      throw formatEditError(
        `edits was received as an empty string.`,
        `Send edits as an oldText/newText array or use hashline edits:\n` +
        `  edits: [{ oldText: "...", newText: "..." }]`
      );
    }

    // Legacy raw-format strings use the same pure normalization as the
    // registered tool. File-topology intents cannot be safely represented by
    // this pre-Task-7 adapter, so reject them rather than reading or mutating
    // files while parsing.
    if (detectInputFormat(raw) !== "raw_edits") {
      const normalized = normalizeRawEdit(raw, typeof args.path === "string" ? args.path : undefined);
      if (normalized.diagnostics.length > 0 || normalized.intents.length === 0) {
        throw formatEditError(
          `Failed to parse raw edit input: ${[...normalized.diagnostics, ...normalized.warnings].join("; ")}`,
          "Ensure the raw patch contains at least one valid text update.",
        );
      }
      const topology = normalized.intents.filter((intent) => intent.kind !== "text");
      if (topology.length > 0) {
        const operations = topology.map((intent) =>
          intent.kind === "rename"
            ? `rename ${intent.oldPath} -> ${intent.newPath}`
            : `${intent.kind} ${intent.path}`,
        );
        throw formatEditError(
          `Raw edit contains ${operations.join(", ")} requiring transaction support; no files were changed.`,
          "Use text-only updates until failure-atomic add/delete/rename support is available.",
        );
      }
      return prepareArguments({
        ...args,
        edits: normalized.intents.map((intent) => {
          if (intent.kind !== "text") throw new Error("unreachable non-text raw intent");
          return intent.operation;
        }),
      }, useHashlineEditing);
    }

    // Attempt first parse, then try recovery strategies for common
    // edge cases (literal newlines in string values, truncation, etc.)
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // First parse failed — try repair strategies before falling through
      // to the non-array diagnostic below.
      parsed = tryRepairJSONString(raw);
    }

    // Double-escaped JSON: if first parse returned a string (JSON array encoded
    // as a string), try one more level of JSON.parse to unwrap it.
    if (typeof parsed === "string") {
      let secondParse: unknown;
      try {
        secondParse = JSON.parse(parsed);
      } catch {
        // Second parse also failed — handled below
      }
      if (secondParse !== undefined) {
        parsed = secondParse;
      }
    }

    // Validate parsed result is an array — clear diagnostic with snippet.
    // Non-raw_edits formats (search/replace, unified diff, OpenAI/Codex patch,
    // Atomic Patch) are normalized to raw edits earlier via
    // detectInputFormat → normalizeRawEdit and return before this point, so
    // only the raw_edits path is reachable here.
    if (!Array.isArray(parsed)) {
      const snippet = raw.length > 120
        ? raw.slice(0, 80) + "..." + raw.slice(-30)
        : raw;
      let typeDesc: string;
      if (parsed === undefined) {
        typeDesc = "(unparseable — not valid JSON)";
      } else if (typeof parsed === "string") {
        typeDesc = `a string ("${parsed.slice(0, 60)}${parsed.length > 60 ? "..." : ""}")`;
      } else {
        typeDesc = typeof parsed;
      }
      throw formatEditError(
        `edits was received as a JSON string but parsed into ${typeDesc}, not an array.`,
        `edits must be an array of edit objects with oldText/newText fields.\n` +
        `Raw value (${raw.length} chars) starts with:\n  ${snippet}\n\n` +
        `This typically happens when the JSON is improperly escaped or truncated.\n` +
        `Automatic repair was attempted but could not recover a valid edits array.\n` +
        `Fix: ensure edits is sent as a proper JSON array, not a string.`
      );
    }

    // Validate each item is an object with required fields.
    const parsedArr = parsed as unknown[];
    for (let i = 0; i < parsedArr.length; i++) {
      const item = parsedArr[i] as Record<string, unknown>;
      if (item === null || typeof item !== "object") {
        throw formatEditError(
          `edits[${i}] is ${item === null ? "null" : `a ${typeof item}`}, not an object.`,
          `Each element in edits must be an object with oldText/newText fields.`
        );
      }
      const isHashlineEdit = item.hashline && typeof item.hashline === "object" &&
        (item.hashline as Record<string, unknown>).range;
      const isSymbolEdit = isSymbolicEdit(item);
      if (isSymbolEdit) {
        const t = item.target as Record<string, unknown> | undefined;
        const operationCount = [t?.replaceBody, t?.insertBefore, t?.insertAfter]
          .filter((value) => typeof value === "string")
          .length;
        if (operationCount !== 1) {
          throw formatEditError(
            `edits[${i}] is a target edit but does not provide exactly one symbolic operation.`,
            `Use { target: { name: "myFunction" }, replaceBody: "..." } or insertBefore/insertAfter.`
          );
        }
        // Early check: symbol edits need at least one identifier (name, namePath, or line)
        const hasName = typeof t?.name === "string" && t.name.length > 0;
        const hasNamePath = typeof t?.namePath === "string" && t.namePath.length > 0;
        const hasLine = typeof t?.line === "number" && Number.isInteger(t.line) && t.line >= 1;
        if (!hasName && !hasNamePath && !hasLine) {
          const gotLine = t?.line != null;
          const hint = gotLine
            ? `target.line must be a positive integer (1-based). Got: ${JSON.stringify(t?.line)}`
            : `Provide at least one identifier in target:\n` +
              `  target.name     — symbol name (e.g. "handleRequest")\n` +
              `  target.namePath — qualified path (e.g. "MyClass.handleRequest")\n` +
              `  target.line     — 1-based line number containing the symbol\n\n` +
              `Example:\n` +
              `  { target: { name: "handleRequest", kind: "method_definition" }, replaceBody: "..." }`;
          throw formatEditError(
            `edits[${i}] is a symbol edit but has no valid identifier.`,
            hint
          );
        }
      }
      if (!isHashlineEdit && !isSymbolEdit) {
        if (typeof item.oldText !== "string") {
          throw formatEditError(
            `edits[${i}].oldText is ${typeof item.oldText}, but must be a string.`,
            `oldText is the exact text to find in the file for replacement. ` +
            `Alternatively, use symbol edits.`
          );
        }
        if (typeof item.newText !== "string") {
          throw formatEditError(
            `edits[${i}].newText is ${typeof item.newText}, but must be a string.`,
            `newText is the replacement text to write in place of oldText. ` +
            `Alternatively, use symbol edits.`
          );
        }
      }
    }

    if (!useHashlineEditing) {
      const hasHashlineEdits = parsedArr.some((item) => {
        const edit = item as Record<string, unknown>;
        return Boolean(
          edit?.hashline &&
          typeof edit.hashline === "object" &&
          (edit.hashline as Record<string, unknown>).range,
        );
      });
      if (hasHashlineEdits) {
        throw formatEditError(
          "Hashline edits are disabled."
        );
      }
    }

    args.edits = parsed;
  }

  const editPathMode = inferPathFromEditItems(args);

  if (editPathMode === "multiple") {
    return args;
  }

  if (!args.path) {
    throw formatEditError(
      `Edit tool is missing the required "path" field.`,
      `You must specify which file to edit. Add a path string to your edit call:\n\n` +
      `  {\n` +
      `    path: "src/foo.ts",  // <-- add this — relative or absolute path\n` +
      `    edits: [{ oldText: "...", newText: "..." }]\n` +
      `  }\n\n` +
      `Or put path on every edit (required when edits target multiple files):\n` +
      `  {\n` +
      `    edits: [{ path: "src/foo.ts", oldText: "...", newText: "..." }]\n` +
      `  }`
    );
  }

  // Legacy single-edit format: { path, oldText, newText, edits?: [...] }
  const legacy = args as Record<string, unknown>;
  if (
    typeof legacy.oldText === "string" &&
    typeof legacy.newText === "string"
  ) {
    const { text: oldText } = stripHashlineDisplayPrefixes(legacy.oldText as string, useHashlineEditing);
    const { text: newText } = stripHashlineDisplayPrefixes(legacy.newText as string, useHashlineEditing);
    // Canonical flat->edits conversion (flat fields are authoritative).
    return normalizeLegacyEditRequest({ ...legacy, oldText, newText });
  }

  // ── Edits missing check (after legacy normalization, which returns early) ──
  // By this point, edits is not a string (handled above) and not a legacy format
  // (returned early). If it's still missing, provide an actionable error.
  if (args.edits === undefined || args.edits === null) {
    throw formatEditError(
      `Edit tool is missing the required "edits" field.`,
      `You must specify which replacements to make. Add an edits array:\n\n` +
      `  {\n` +
      `    path: "${typeof args.path === "string" ? args.path : "..."}",\n` +
      `    edits: [{ oldText: '...', newText: '...' }]  // <-- add this\n` +
      `  }`
    );
  }

  // Normalize edit metadata without moving it out of the validated edit object.
  // Legacy anchor/symbol shapes remain accepted and are converted to target.
  if (Array.isArray(args.edits)) {
    const topLevelReplaceAll = args.replaceAll === true;
    const clonedEdits = (args.edits as Array<Record<string, unknown>>).map((edit) => ({ ...edit }));
    args.edits = clonedEdits;

    for (const edit of clonedEdits) {
      if (typeof edit.oldText === "string") {
        edit.oldText = stripHashlineDisplayPrefixes(edit.oldText, useHashlineEditing).text;
      }
      if (typeof edit.newText === "string") {
        edit.newText = stripHashlineDisplayPrefixes(edit.newText, useHashlineEditing).text;
      }

      let target = edit.target && typeof edit.target === "object" && !Array.isArray(edit.target)
        ? { ...(edit.target as Record<string, unknown>) }
        : undefined;

      if (edit.anchor && typeof edit.anchor === "object" && !Array.isArray(edit.anchor)) {
        const anchor = edit.anchor as Record<string, unknown>;
        target = {
          ...target,
          name: anchor.symbolName ?? target?.name,
          kind: anchor.symbolKind ?? target?.kind,
          line: anchor.symbolLine ?? target?.line,
        };
        delete edit.anchor;
      }

      if (edit.symbol && typeof edit.symbol === "object" && !Array.isArray(edit.symbol)) {
        const symbol = edit.symbol as Record<string, unknown>;
        target = {
          ...target,
          name: symbol.name ?? target?.name,
          namePath: symbol.namePath ?? target?.namePath,
          kind: symbol.kind ?? target?.kind,
          line: symbol.line ?? target?.line,
        };
        delete edit.symbol;
      }

      for (const operation of ["replaceBody", "insertBefore", "insertAfter"] as const) {
        if (edit[operation] !== undefined) {
          target = { ...target, [operation]: edit[operation] };
          delete edit[operation];
        }
      }

      if (target && Object.values(target).some((value) => value !== undefined)) {
        edit.target = target;
      }
      if (typeof edit.replaceAll !== "boolean" && topLevelReplaceAll) {
        edit.replaceAll = true;
      }
    }
  }

  return args;
}

// ─── Validate input ─────────────────────────────────────────────────

export function validateInput(
  input: Record<string, unknown>,
  allowHashlineEdits: boolean,
): EditInput {
  if (
    !Array.isArray(input.edits) ||
    (input.edits as EditItem[]).length === 0
  ) {
    throw formatEditError(
      "Edit tool input is invalid: edits must contain at least one edit.",
      "Make sure edits is an array of edit objects with oldText/newText fields."
    );
  }

  if (!allowHashlineEdits) {
    const edits = input.edits as Array<Record<string, unknown>>;
    if (edits.some((edit) => Boolean(edit?.hashline && typeof edit.hashline === "object" && (edit.hashline as Record<string, unknown>).range))) {
      throw formatEditError(
        "Hashline edits are disabled."
      );
    }
  }

  return {
    path: input.path as string,
    edits: input.edits as EditItem[],
  };
}
