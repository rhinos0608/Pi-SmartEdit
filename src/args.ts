import { relative, isAbsolute, resolve } from "path";
import type { EditItem, EditInput } from "./core/types";
import { isSymbolicEdit } from "./ast/symbolic-edits.js";
import { HASHLINE_CONTENT_SEPARATOR } from "./hashline/hashline";
import { detectInputFormat } from "./formats/format-detector.js";
import { repairJson } from "./formats/forgiving-parser.js";
import { normalizeFlatEditRequest } from "./edit-contract.js";
import { normalizeRawEdit } from "./formats/edit-intents.js";

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

function looksLikeTruncatedJsonArray(raw: string): boolean {
  return /^\s*\[/.test(raw) && !/\]\s*$/.test(raw) && raw.includes('{') && raw.includes('}');
}

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
    if (looksLikeTruncatedJsonArray(raw)) {
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

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHashlineEditObject(edit: unknown): boolean {
  if (!edit || typeof edit !== "object") return false;
  const hashline = (edit as Record<string, unknown>).hashline;
  if (!hashline || typeof hashline !== "object") return false;
  return Boolean((hashline as Record<string, unknown>).range);
}

function tryPushCompleteJsonObject(raw: string, start: number, end: number, results: unknown[]): void {
  const objStr = raw.slice(start, end + 1);
  try {
    const parsed: unknown = JSON.parse(objStr);
    if (isPlainObjectRecord(parsed)) {
      results.push(parsed);
    }
  } catch {
    // skip unparseable fragment
  }
}

interface PartialScanState {
  depth: number;
  start: number;
  inString: boolean;
  escaped: boolean;
}

function updatePartialScanOnBrace(ch: string, index: number, raw: string, state: PartialScanState, results: unknown[]): void {
  if (ch === '{') {
    if (state.depth === 0) state.start = index;
    state.depth++;
    return;
  }
  if (ch === '}') {
    state.depth--;
    if (state.depth === 0 && state.start >= 0) {
      tryPushCompleteJsonObject(raw, state.start, index, results);
      state.start = -1;
    }
  }
}

function updatePartialScanOnChar(ch: string, index: number, raw: string, state: PartialScanState, results: unknown[]): void {
  if (state.inString) {
    if (state.escaped) {
      state.escaped = false;
      return;
    }
    if (ch === '\\') {
      state.escaped = true;
      return;
    }
    if (ch === '"') state.inString = false;
    return;
  }
  if (ch === '"') {
    state.inString = true;
    return;
  }
  updatePartialScanOnBrace(ch, index, raw, state, results);
}

/**
 * Extract complete edit objects from a truncated JSON array string.
 * Walks character-by-character tracking brace depth and string state,
 * collecting every complete top-level { … } object it can find.
 */
function tryExtractPartialEdits(raw: string): unknown[] {
  const results: unknown[] = [];
  const state: PartialScanState = { depth: 0, start: -1, inString: false, escaped: false };
  for (let i = 0; i < raw.length; i++) {
    updatePartialScanOnChar(raw[i], i, raw, state, results);
  }
  return results;
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

// ─── prepareArguments helpers (pure, typed; no behavior change) ──────────

function throwMissingPathAndEdits(): never {
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

function throwEmptyEditsString(): never {
  throw formatEditError(
    `edits was received as an empty string.`,
    `Send edits as an oldText/newText array or use hashline edits:\n` +
    `  edits: [{ oldText: "...", newText: "..." }]`
  );
}

function throwMissingPathError(): never {
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

function throwMissingEditsError(path: unknown): never {
  throw formatEditError(
    `Edit tool is missing the required "edits" field.`,
    `You must specify which replacements to make. Add an edits array:\n\n` +
    `  {\n` +
    `    path: "${typeof path === "string" ? path : "..."}",\n` +
    `    edits: [{ oldText: '...', newText: '...' }]  // <-- add this\n` +
    `  }`
  );
}

function isRawEditsFormat(raw: string): boolean {
  return detectInputFormat(raw) === "raw_edits";
}

type RawEditNormalization = ReturnType<typeof normalizeRawEdit>;
type NonTextIntent = Exclude<RawEditNormalization["intents"][number], { kind: "text" }>;

function assertRawTextUpdatePresent(normalized: RawEditNormalization): void {
  if (normalized.diagnostics.length > 0 || normalized.intents.length === 0) {
    throw formatEditError(
      `Failed to parse raw edit input: ${[...normalized.diagnostics, ...normalized.warnings].join("; ")}`,
      "Ensure the raw patch contains at least one valid text update.",
    );
  }
}

function describeTopologyOperation(intent: NonTextIntent): string {
  if (intent.kind === "rename") return `rename ${intent.oldPath} -> ${intent.newPath}`;
  return `${intent.kind} ${intent.path}`;
}

function assertNoTopologyIntents(normalized: RawEditNormalization): void {
  const topology = normalized.intents.filter((intent): intent is NonTextIntent => intent.kind !== "text");
  if (topology.length === 0) return;
  const operations = topology.map(describeTopologyOperation);
  throw formatEditError(
    `Raw edit contains ${operations.join(", ")} requiring transaction support; no files were changed.`,
    "Use text-only updates until failure-atomic add/delete/rename support is available.",
  );
}

function normalizeNonRawEditsString(raw: string, args: Record<string, unknown>, useHashlineEditing: boolean): Record<string, unknown> {
  const normalized = normalizeRawEdit(raw, typeof args.path === "string" ? args.path : undefined);
  assertRawTextUpdatePresent(normalized);
  assertNoTopologyIntents(normalized);
  return prepareArguments({
    ...args,
    edits: normalized.intents.map((intent) => {
      if (intent.kind !== "text") throw new Error("unreachable non-text raw intent");
      return intent.operation;
    }),
  }, useHashlineEditing);
}

function parseEditsStringValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // First parse failed — try repair strategies before falling through
    // to the non-array diagnostic below.
    return tryRepairJSONString(raw);
  }
}

function unwrapDoubleEscapedJson(parsed: unknown): unknown {
  if (typeof parsed !== "string") return parsed;
  try {
    const secondParse: unknown = JSON.parse(parsed);
    if (secondParse !== undefined) return secondParse;
  } catch {
    // Second parse also failed — handled below
  }
  return parsed;
}

function describeParsedEditsType(parsed: unknown): string {
  if (parsed === undefined) return "(unparseable — not valid JSON)";
  if (typeof parsed === "string") return `a string ("${parsed.slice(0, 60)}${parsed.length > 60 ? "..." : ""}")`;
  return typeof parsed;
}

function buildEditsSnippet(raw: string): string {
  return raw.length > 120 ? raw.slice(0, 80) + "..." + raw.slice(-30) : raw;
}

function throwNonArrayEditsError(parsed: unknown, raw: string): never {
  const snippet = buildEditsSnippet(raw);
  const typeDesc = describeParsedEditsType(parsed);
  throw formatEditError(
    `edits was received as a JSON string but parsed into ${typeDesc}, not an array.`,
    `edits must be an array of edit objects with oldText/newText fields.\n` +
    `Raw value (${raw.length} chars) starts with:\n  ${snippet}\n\n` +
    `This typically happens when the JSON is improperly escaped or truncated.\n` +
    `Automatic repair was attempted but could not recover a valid edits array.\n` +
    `Fix: ensure edits is sent as a proper JSON array, not a string.`
  );
}

function assertParsedEditsArray(parsed: unknown, raw: string): asserts parsed is unknown[] {
  if (!Array.isArray(parsed)) throwNonArrayEditsError(parsed, raw);
}

function hasSymbolName(t: Record<string, unknown> | undefined): boolean {
  return typeof t?.name === "string" && t.name.length > 0;
}

function hasSymbolNamePath(t: Record<string, unknown> | undefined): boolean {
  return typeof t?.namePath === "string" && t.namePath.length > 0;
}

function hasSymbolLine(t: Record<string, unknown> | undefined): boolean {
  return typeof t?.line === "number" && Number.isInteger(t.line) && t.line >= 1;
}

function hasSymbolEditIdentifier(t: Record<string, unknown> | undefined): boolean {
  return hasSymbolName(t) || hasSymbolNamePath(t) || hasSymbolLine(t);
}

function symbolIdentifierHint(t: Record<string, unknown> | undefined): string {
  if (t?.line != null) {
    return `target.line must be a positive integer (1-based). Got: ${JSON.stringify(t?.line)}`;
  }
  return `Provide at least one identifier in target:\n` +
    `  target.name     — symbol name (e.g. "handleRequest")\n` +
    `  target.namePath — qualified path (e.g. "MyClass.handleRequest")\n` +
    `  target.line     — 1-based line number containing the symbol\n\n` +
    `Example:\n` +
    `  { target: { name: "handleRequest", kind: "method_definition" }, replaceBody: "..." }`;
}

function validateSymbolEditTarget(item: Record<string, unknown>, index: number): void {
  const t = item.target as Record<string, unknown> | undefined;
  const operationCount = [t?.replaceBody, t?.insertBefore, t?.insertAfter]
    .filter((value) => typeof value === "string")
    .length;
  if (operationCount !== 1) {
    throw formatEditError(
      `edits[${index}] is a target edit but does not provide exactly one symbolic operation.`,
      `Use { target: { name: "myFunction" }, replaceBody: "..." } or insertBefore/insertAfter.`
    );
  }
  // Early check: symbol edits need at least one identifier (name, namePath, or line)
  if (!hasSymbolEditIdentifier(t)) {
    throw formatEditError(
      `edits[${index}] is a symbol edit but has no valid identifier.`,
      symbolIdentifierHint(t)
    );
  }
}

function validateTextEditFields(item: Record<string, unknown>, index: number): void {
  if (typeof item.oldText !== "string") {
    throw formatEditError(
      `edits[${index}].oldText is ${typeof item.oldText}, but must be a string.`,
      `oldText is the exact text to find in the file for replacement. ` +
      `Alternatively, use symbol edits.`
    );
  }
  if (typeof item.newText !== "string") {
    throw formatEditError(
      `edits[${index}].newText is ${typeof item.newText}, but must be a string.`,
      `newText is the replacement text to write in place of oldText. ` +
      `Alternatively, use symbol edits.`
    );
  }
}

function validateSingleParsedEditItem(item: unknown, index: number): void {
  if (item === null || typeof item !== "object") {
    throw formatEditError(
      `edits[${index}] is ${item === null ? "null" : `a ${typeof item}`}, not an object.`,
      `Each element in edits must be an object with oldText/newText fields.`
    );
  }
  const record = item as Record<string, unknown>;
  const isHashlineEdit = isHashlineEditObject(record);
  const isSymbolEdit = isSymbolicEdit(record);
  if (isSymbolEdit) validateSymbolEditTarget(record, index);
  if (!isHashlineEdit && !isSymbolEdit) validateTextEditFields(record, index);
}

function validateParsedEditItems(parsedArr: unknown[]): void {
  for (let i = 0; i < parsedArr.length; i++) {
    validateSingleParsedEditItem(parsedArr[i], i);
  }
}

function assertStringEditsHashlineAllowed(parsedArr: unknown[], useHashlineEditing: boolean): void {
  if (useHashlineEditing) return;
  if (parsedArr.some(isHashlineEditObject)) {
    throw formatEditError(
      "Hashline edits are disabled."
    );
  }
}

function parseAndValidateStringEdits(raw: string, useHashlineEditing: boolean): unknown[] {
  const parsed = unwrapDoubleEscapedJson(parseEditsStringValue(raw));
  assertParsedEditsArray(parsed, raw);
  validateParsedEditItems(parsed);
  assertStringEditsHashlineAllowed(parsed, useHashlineEditing);
  return parsed;
}

function resolveStringEditsBranch(args: Record<string, unknown>, useHashlineEditing: boolean): Record<string, unknown> | null {
  const raw = (args.edits as string).trim();
  // Empty string: immediate actionable error
  if (!raw) throwEmptyEditsString();
  // Non-canonical raw-format strings (not the `raw_edits` shape) go through
  // the same pure normalization as the registered tool. File-topology intents
  // cannot be safely represented by this string-based adapter, so reject them
  // rather than reading or mutating files while parsing.
  if (!isRawEditsFormat(raw)) {
    return normalizeNonRawEditsString(raw, args, useHashlineEditing);
  }
  args.edits = parseAndValidateStringEdits(raw, useHashlineEditing);
  return null;
}

function tryApplyFlatShorthand(args: Record<string, unknown>, useHashlineEditing: boolean): Record<string, unknown> | null {
  if (typeof args.oldText !== "string" || typeof args.newText !== "string") return null;
  const { text: oldText } = stripHashlineDisplayPrefixes(args.oldText, useHashlineEditing);
  const { text: newText } = stripHashlineDisplayPrefixes(args.newText, useHashlineEditing);
  // Canonical flat->edits conversion (flat fields are authoritative).
  return normalizeFlatEditRequest({ ...args, oldText, newText });
}

function stripHashlinePrefixesFromEdits(args: Record<string, unknown>, useHashlineEditing: boolean): void {
  if (!Array.isArray(args.edits)) return;
  // Normalize edit metadata without moving it out of the validated edit object.
  const clonedEdits = (args.edits as Array<Record<string, unknown>>).map((edit) => ({ ...edit }));
  args.edits = clonedEdits;
  for (const edit of clonedEdits) {
    if (typeof edit.oldText === "string") {
      edit.oldText = stripHashlineDisplayPrefixes(edit.oldText, useHashlineEditing).text;
    }
    if (typeof edit.newText === "string") {
      edit.newText = stripHashlineDisplayPrefixes(edit.newText, useHashlineEditing).text;
    }
  }
}

// ─── Resumed-session / flat-input compatibility ─────────────────────────────────────

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
  // IMPORTANT: This must come BEFORE flat-shorthand normalization (which
  // converts {path, oldText, newText} to {path, edits: [...]}) but the
  // edits-missing check must come AFTER that normalization, since flat
  // calls don't have an edits field.

  if (!args.path && !args.edits) {
    throwMissingPathAndEdits();
  }

  // Some models send edits as a JSON string instead of an array.
  // This happens when the model serializes the array into a string
  // somewhere in the tool-calling pipeline.
  if (typeof args.edits === "string") {
    const earlyReturn = resolveStringEditsBranch(args, useHashlineEditing);
    if (earlyReturn) return earlyReturn;
  }

  const editPathMode = inferPathFromEditItems(args);

  if (editPathMode === "multiple") {
    return args;
  }

  if (!args.path) {
    throwMissingPathError();
  }

  // Flat single-edit shorthand: { path, oldText, newText, edits?: [...] }.
  // Still sent by resumed sessions with stored calls predating the edits array.
  const flatNormalized = tryApplyFlatShorthand(args, useHashlineEditing);
  if (flatNormalized) return flatNormalized;

  // ── Edits missing check (after flat-shorthand normalization, which returns early) ──
  // By this point, edits is not a string (handled above) and not the flat
  // shorthand (returned early). If it's still missing, provide an actionable error.
  if (args.edits === undefined || args.edits === null) {
    throwMissingEditsError(args.path);
  }

  stripHashlinePrefixesFromEdits(args, useHashlineEditing);

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
    if (edits.some(isHashlineEditObject)) {
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
