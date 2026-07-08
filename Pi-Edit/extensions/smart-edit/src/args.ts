import { readFileSync } from "fs";
import { relative, isAbsolute, resolve } from "path";
import { Buffer } from "buffer";
import type { EditItem, EditInput } from "./core/types";
import { isSymbolicEdit } from "./symbolic-edits.js";
import { HASHLINE_CONTENT_SEPARATOR } from "./core/hashline";
import { detectInputFormat } from "./formats/format-detector.js";
import { parseSearchReplace } from "./formats/search-replace.js";
import { parseUnifiedDiffToEditItems } from "./formats/unified-diff.js";
import { parseOpenAIPatch, openAIPatchToEditItem } from "./formats/openai-patch.js";
import { parseCodexPatch, codexHunkToEditItem } from "./formats/codex-patch.js";
import { parseAtomicPatchEnvelope } from "./formats/atomic-patch.js";
import { repairJson } from "./formats/forgiving-parser.js";

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

function inferPathFromEditItems(args: Record<string, unknown>): void {
  if (!Array.isArray(args.edits)) return;

  const editPaths = args.edits
    .map((edit) => edit && typeof edit === "object" && !Array.isArray(edit) ? (edit as Record<string, unknown>).path : undefined)
    .filter((path): path is string => typeof path === "string" && path.length > 0);

  if (editPaths.length === 0) return;

  const uniqueByResolvedPath = new Map<string, string>();
  for (const path of editPaths) {
    uniqueByResolvedPath.set(resolve(path), path);
  }

  if (uniqueByResolvedPath.size > 1) {
    throw formatEditError(
      "Nested edit paths are ambiguous: edits must target one file.",
      `Received paths: ${[...uniqueByResolvedPath.values()].join(", ")}\n` +
        "Use one edit call per file, or use Atomic Patch for multi-file edits.",
    );
  }

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
}

// ─── Legacy input compatibility ─────────────────────────────────────

export function prepareArguments(input: Record<string, unknown>, useHashlineEditing: boolean): Record<string, unknown> {
  if (!input || typeof input !== "object") return input;

  const args = { ...input } as Record<string, unknown>;

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
    // If it's not a valid JSON array, try multi-format detection first since
    // the input could be a search/replace block, unified diff, OpenAI/Codex patch, or Atomic Patch.
    if (!Array.isArray(parsed)) {
      const format = detectInputFormat(raw);

      if (format !== 'raw_edits') {
        try {
          let parsedEdits: Array<{ path?: string; oldText: string; newText: string }> = [];

          switch (format) {
            case 'search_replace': {
              const blocks = parseSearchReplace(raw);
              parsedEdits = blocks.map(block => ({
                path: block.path,
                oldText: block.oldText,
                newText: block.newText,
              }));
              break;
            }
            case 'unified_diff': {
              parsedEdits = parseUnifiedDiffToEditItems(raw);
              break;
            }
            case 'openai_patch': {
              const patches = parseOpenAIPatch(raw);
              parsedEdits = patches.map(patch => openAIPatchToEditItem(patch));
              break;
            }
            case 'codex_patch': {
              const codexResult = parseCodexPatch(raw, 'lenient');
              // Convert each hunk to EditItem-compatible format
              for (const hunk of codexResult.hunks) {
                // Read file old contents for DeleteFile operations
                let fileOldContents: string | undefined;
                if (hunk.kind === 'DeleteFile' && hunk.path) {
                  try {
                    fileOldContents = readFileSync(hunk.path, 'utf-8');
                  } catch {
                    // File doesn't exist — nothing to delete, skip silently
                    continue;
                  }
                }
                const items = codexHunkToEditItem(hunk, fileOldContents);
                parsedEdits.push(...items);
              }
              break;
            }
            case 'atomic_patch': {
              // Atomic patches are handled via enqueueAtomicPatch in the edit flow
              // For now, extract path hints from the envelope for multi-file support
              const { envelope } = parseAtomicPatchEnvelope(raw);

              // Collect unique paths from the envelope
              const paths = new Set<string>();
              for (const op of envelope.operations) {
                if (op.kind === 'AddFile' || op.kind === 'DeleteFile' || op.kind === 'UpdateFile') {
                  paths.add(op.path);
                }
                if (op.kind === 'UpdateFile' && op.movePath) {
                  paths.add(op.movePath);
                }
                if (op.kind === 'RenameFile') {
                  paths.add(op.oldPath);
                  paths.add(op.newPath);
                }
              }

              // If no path hint from args, use first path from envelope
              if (paths.size > 0 && !args.path) {
                args.path = Array.from(paths)[0];
              }

              // Extract first UpdateFile's patches as edit items
              for (const op of envelope.operations) {
                if (op.kind === 'UpdateFile') {
                  for (const patch of op.patches) {
                    parsedEdits.push({
                      path: op.movePath ?? op.path,
                      oldText: patch.oldText,
                      newText: patch.newText,
                    });
                  }
                }
              }
              break;
            }
          }

          if (parsedEdits.length > 0) {
            // If a parsed format contained a path hint and none was provided, use it
            const pathHint = parsedEdits.find(e => e.path)?.path;
            if (pathHint && !args.path) {
              args.path = pathHint;
            }

            parsed = parsedEdits.map(e => ({
              oldText: e.oldText,
              newText: e.newText,
            })) as unknown[];
          } else {
            throw formatEditError(
              `edits was received as a ${format} string but parsed into zero edits.`,
              `Ensure the ${format} block contains at least one valid oldText/newText pair.`
            );
          }
        } catch (formatError) {
          if (formatError instanceof Error && formatError.message.startsWith('❌')) {
            throw formatError;
          }
          throw formatEditError(
            `Failed to parse ${format} format input: ${(formatError as Error).message}`,
          );
        }
      } else {
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

  inferPathFromEditItems(args);

  if (!args.path) {
    throw formatEditError(
      `Edit tool is missing the required "path" field.`,
      `You must specify which file to edit. Add a path string to your edit call:\n\n` +
      `  {\n` +
      `    path: "src/foo.ts",  // <-- add this — relative or absolute path\n` +
      `    edits: [{ oldText: "...", newText: "..." }]\n` +
      `  }\n\n` +
      `Or put path on each edit when all edits target the same file:\n` +
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
    const edits: EditItem[] = Array.isArray(legacy.edits)
      ? [...(legacy.edits as EditItem[])]
      : [];
    edits.push({ oldText, newText });
    const { oldText: _, newText: __, ...rest } = legacy;
    return { ...rest, edits };
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

  // Strip replaceAll/target/lineRange from edits so built-in schema validation
  // passes. The values are restored in execute() before calling applyEdits().
  // For backwards compat, we convert old-style anchor/symbol to new target shape.
  if (Array.isArray(args.edits)) {
    const topLevelReplaceAll = args.replaceAll === true;
    const flags: boolean[] = [];
    const targets: (Record<string, unknown> | undefined)[] = [];
    const hashlines: (Record<string, unknown> | undefined)[] = [];
    const editNotes: string[] = [];

    // Deep-clone edits before mutation to avoid mutating caller's input
    const clonedEdits = (args.edits as Array<Record<string, unknown>>).map(e => ({ ...e }));
    args.edits = clonedEdits;

    for (const edit of clonedEdits) {
      if (edit.oldText && typeof edit.oldText === "string") {
        const { text, stripped } = stripHashlineDisplayPrefixes(edit.oldText, useHashlineEditing);
        if (stripped) { edit.oldText = text; editNotes.push("Auto-stripped hashline display prefixes from edit content."); }
      }
      if (edit.newText && typeof edit.newText === "string") {
        const { text, stripped } = stripHashlineDisplayPrefixes(edit.newText, useHashlineEditing);
        if (stripped) edit.newText = text;
      }
      // ── Backwards compat: convert old-style anchor/symbol to target ──
      let target: Record<string, unknown> | undefined;

      // Convert old anchor { symbolName, symbolKind, symbolLine } to target
      if (edit.anchor && typeof edit.anchor === 'object') {
        const anchor = edit.anchor as Record<string, unknown>;
        target = {
          name: anchor.symbolName,
          kind: anchor.symbolKind,
          line: anchor.symbolLine,
        };
        delete edit.anchor;
      }

      // Convert old symbol + operation to target
      if (edit.symbol && typeof edit.symbol === 'object') {
        const symbol = edit.symbol as Record<string, unknown>;
        if (!target) target = {};
        target.name = symbol.name ?? target.name;
        target.namePath = symbol.namePath ?? target.namePath;
        target.kind = symbol.kind ?? target.kind;
        target.line = symbol.line ?? target.line;
        delete edit.symbol;
      }

      // Move operation fields into target if present
      if (edit.replaceBody !== undefined) {
        if (!target) target = {};
        target.replaceBody = edit.replaceBody;
        delete edit.replaceBody;
      }
      if (edit.insertBefore !== undefined) {
        if (!target) target = {};
        target.insertBefore = edit.insertBefore;
        delete edit.insertBefore;
      }
      if (edit.insertAfter !== undefined) {
        if (!target) target = {};
        target.insertAfter = edit.insertAfter;
        delete edit.insertAfter;
      }

      // replaceAll
      if (typeof edit.replaceAll === 'boolean') {
        flags.push(edit.replaceAll);
        delete edit.replaceAll;
      } else {
        flags.push(topLevelReplaceAll);
      }

      // target (new unified form, or converted from old-style)
      if (target && Object.keys(target).length > 0) {
        targets.push(target);
      } else {
        targets.push(undefined);
      }

      // hashline
      if (edit.hashline && typeof edit.hashline === 'object') {
        hashlines.push(edit.hashline as Record<string, unknown>);
        delete edit.hashline;
      } else {
        hashlines.push(undefined);
      }
    }

    const hasFlags = flags.some((f) => f);
    const hasTargets = targets.some((t) => t);
    const hasHashlines = hashlines.some((h) => h);
    const hasEditNotes = editNotes.length > 0;
    if (hasFlags || hasTargets || hasHashlines || hasEditNotes) {
      const extraData = {
        replaceAllFlags: hasFlags ? flags : null,
        targetData: hasTargets ? targets : null,
        hashlineData: hasHashlines ? hashlines : null,
        editNotes: hasEditNotes ? [...new Set(editNotes)] : null,
      };
      if (typeof args.path === "string" && !args.path.includes("??smartEditExtra=")) {
        args.path = args.path + "??smartEditExtra=" + Buffer.from(JSON.stringify(extraData)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
