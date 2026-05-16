/**
 * Smart Edit — Improved edit tool extension for Pi Coding Agent.
 *
 * Overrides Pi's built-in edit tool with improved matching, fuzzy-match
 * safety, replaceAll support, stale-file detection, atomic writes, and
 * richer diagnostics.
 *
 * Installation: copy to ~/.pi/agent/extensions/smart-edit.ts
 *   or place in .pi/extensions/smart-edit/index.ts for project-local use.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { constants, statSync, readFileSync as fsReadFileSync } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { resolve, dirname } from "path";

import {
  applyEdits,
  detectLineEnding,
  generateDiffString,
  lineRangeToByteRange,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./lib/edit-diff";

import { createAstResolver, validateSyntax } from "./lib/ast-resolver";
import {
  createConflictDetector,
  defaultConflictConfig,
} from "./lib/conflict-detector";

import { buildSemanticContext } from "./src/lsp/semantic-context";
import type { SemanticContextInput, AstResolverLike } from "./src/lsp/semantic-context";
import { detectLanguageFromExtension } from "./src/lsp/language-id";
import { recordRead, checkStale, recordReadWithStat, recordReadSession, getSessionReads, checkEditAllowed, checkRangeCoverage, getSnapshot } from "./lib/read-cache";
import { buildHashlineAnchors, initHashline } from "./lib/hashline";
import type { HashlineEditInput } from "./lib/hashline-edit";

import { detectInputFormat } from "./src/formats/format-detector";
import { parseSearchReplace } from "./src/formats/search-replace";
import { parseUnifiedDiffToEditItems } from "./src/formats/unified-diff";
import { parseOpenAIPatch, openAIPatchToEditItem } from "./src/formats/openai-patch";
import { parseCodexPatch, codexHunkToEditItem } from "./src/formats/codex-patch";
import { StreamingPatchParser } from "./src/formats/streaming-patch-parser";

import { LSPManager } from "./src/lsp/lsp-manager";
import { checkPostEditDiagnostics } from "./src/lsp/diagnostics";
import { getCompilerForLanguage } from "./src/lsp/diagnostic-dispatcher";
import type { DiagnosticResult } from "./src/lsp/diagnostic-dispatcher";

import { runPostEditEvidencePipeline } from "./src/verification/post-edit-evidence";
import { defaultVerificationConfig } from "./src/verification/config";
import type { PostEditEvidenceResult } from "./src/verification/types";
import { recordBreakage, recordCoChange } from "./src/smartread-bridge";
import { getSmartEditRuntimeConfig } from "./src/edit-mode";
import { checkEditSafety } from "./src/safety/approval-gating";
import { saveUndoState } from "./src/undo/edit-history";
import { atomicWrite } from "./src/undo/atomic-write";

import type {
  EditAnchor,
  EditItem,
  EditInput,
  EditResult,
  LineRange,
  MatchSpan,
  SearchScope,
} from "./lib/types";

const smartEditRuntimeConfig = getSmartEditRuntimeConfig();

// ─── Schema (must match built-in edit schema exactly) ──────────────
// Extra properties like `replaceAll`, `anchor`, `lineRange` are stripped
// by prepareArguments before validation, then restored in execute().

const editItemSchema = Type.Object(
  {
    oldText: Type.Optional(Type.String()),
    newText: Type.Optional(Type.String()),
    replaceAll: Type.Optional(
      Type.Boolean({
        description:
          "When true, replaces every non-overlapping occurrence of oldText. " +
          "Useful for renaming variables or updating boilerplate patterns. " +
          "Default: false (requires unique match).",
      }),
    ),
    anchor: Type.Optional(
      Type.Object(
        {
          symbolName: Type.Optional(
            Type.String({
              description:
                "Name of the enclosing symbol to scope the edit within (e.g., function name, class name).",
            }),
          ),
          symbolKind: Type.Optional(
            Type.String({
              description:
                "Kind of symbol to filter by (e.g., 'function_declaration', 'class_declaration'). " +
                "If omitted, all symbol kinds with the matching name are considered.",
            }),
          ),
          symbolLine: Type.Optional(
            Type.Number({
              description:
                "1-based line number hint for where the symbol's name appears. " +
                "Used to disambiguate symbols with the same name.",
            }),
          ),
        },
        {
          description:
            "AST-based disambiguation hint. If provided, oldText is matched only within " +
            "the byte range of the described AST node (function body, class, etc.).",
        },
      ),
    ),
    lineRange: Type.Optional(
      Type.Object(
        {
          startLine: Type.Number({
            description: "1-based start line (inclusive). Refers to file as last read.",
          }),
          endLine: Type.Optional(
            Type.Number({
              description:
                "1-based end line (inclusive). Defaults to startLine if omitted.",
            }),
          ),
        },
        {
          description:
            "Line-range hint to narrow the search scope for oldText matching. " +
            "When provided, oldText is only searched within the specified lines. " +
            "If not found within the range, falls back to whole-file search.",
        },
      ),
    ),

    // ── Hashline-anchored edit variant ──────────────────────
    // Experimental schema: instead of oldText/newText, use anchor+content.
    // The anchor is a LINE+ID hash (e.g. "42ab") that the model sees in read output.
    // This eliminates the need for text reproduction and enables freshness checking.
    hashline: Type.Optional(
      Type.Object(
        {
          symbol: Type.Optional(
            Type.Object(
              {
                name: Type.String({
                  description:
                    "Name of the enclosing symbol (function, class, etc.) " +
                    "to disambiguate edits within identically-structured code blocks.",
                }),
                kind: Type.Optional(
                  Type.String({
                    description:
                      "Kind of symbol (e.g., 'function', 'method', 'class'). " +
                      "If omitted, all symbol kinds matching the name are considered.",
                  }),
                ),
                line: Type.Optional(
                  Type.Number({
                    description:
                      "1-based line number hint for where the symbol's name appears. " +
                      "Used to disambiguate symbols with the same name.",
                  }),
                ),
              },
              {
                description:
                  "AST symbol scoping hint. If provided, stale hashline anchors " +
                  "fall back to scoped fuzzy matching within the symbol's byte range " +
                  "instead of the full 4-tier pipeline.",
              },
            ),
          ),
          range: Type.Object(
            {
              pos: Type.String({
                description:
                  "Start anchor: LINE+HASH of the first line to edit (inclusive). " +
                  "E.g., '42ab' means line 42 with hash 'ab'. " +
                  "Use 'EOF' or 'end' to append, 'start' or 'BOF' to prepend. " +
                  "Append ':after' or ':before' for insert operations.",
              }),
              end: Type.String({
                description:
                  "End anchor: LINE+HASH of the last line to edit (inclusive). " +
                  "For single-line edits, same as pos. " +
                  "For insert after, use pos with ':after' and end=pos.",
              }),
            },
            {
              description:
                "Hashline-anchored range for precise, freshness-checked edits. " +
                "Anchors are computed on read and validated before applying. " +
                "If the file changed, the edit is rejected with corrected anchors. " +
                "Experimental: enabled only when SMART_EDIT_USE_HASHLINE_EDITING is on.",
            },
          ),
          content: Type.Optional(
            Type.Union([
              Type.Array(Type.String()),
              Type.String(),
            ], {
              description:
                "Replacement content. Prefer string[] where each element is one logical line. " +
                "A single multiline string is also accepted and hashline/read prefixes are stripped. " +
                "Use [] (empty array) to delete the targeted range. " +
                "Omit or use null to delete.",
            }),
          ),
        },
        {
          description:
            "Experimental edit format when hashline anchors are explicitly enabled. " +
            "References LINE+ID anchors from the read output instead of reproducing text. " +
            "Format: { hashline: { range: { pos: '42ab', end: '45cd' }, content: ['new lines'] } } " +
            "Anchors are shown in read output (e.g., '42ab|function hello() {'). " +
            "This format provides freshness checking and eliminates text reproduction errors. " +
            "Prefer oldText/newText by default; enable hashline editing only for experimental use.",
        },
      ),
    ),
  },
);

const editSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to the file to edit (relative or absolute)",
    }),
    edits: Type.Union([
      Type.Array(editItemSchema, {
        description:
          "One or more targeted edits using oldText/newText or experimental hashline-anchored format. " +
          "Each edit may reference LINE+ID anchors from the read output (e.g., '42ab|function hello() {'). " +
          "Edits are matched against the original file, not incrementally. " +
          "\nFormat: { hashline: { range: { pos: '42ab', end: '45cd' }, content: ['new lines'] } } " +
          "\n- Single-line edit: pos and end are the same anchor. " +
          "\n- Append to file: pos='EOF', end='EOF'. " +
          "\n- Prepend to file: pos='start', end='start'. " +
          "\n- Insert after anchor: pos='42ab:after', end='42ab'. " +
          "\n- Insert before anchor: pos='42ab:before', end='42ab'. " +
          "\nDo not include overlapping or nested edits — merge nearby changes into one edit.",
      }),
      Type.String({
        description:
          "JSON string of edits array. Accepted for compatibility with models " +
          "that serialize the array into a string somewhere in the tool-calling pipeline.",
      }),
    ]),
  },
);

const semanticContextSchema = Type.Object({
  path: Type.String({ description: "Path to the file to inspect semantically" }),
  lineRange: Type.Optional(Type.Object({
    startLine: Type.Number({ description: "1-based start line (inclusive)" }),
    endLine: Type.Optional(Type.Number({ description: "1-based end line (inclusive)" })),
  })),
  symbol: Type.Optional(Type.Object({
    name: Type.String({ description: "Symbol name (function, class, interface, etc.)" }),
    kind: Type.Optional(Type.String({ description: "Kind hint (e.g., 'function', 'class', 'interface')" })),
    line: Type.Optional(Type.Number({ description: "1-based line hint" })),
  })),
  maxTokens: Type.Optional(Type.Number({ default: 3000, description: "Maximum tokens in the response" })),
  maxDepth: Type.Optional(Type.Number({ default: 1, description: "Max depth for following references" })),
  includeReferences: Type.Optional(Type.Union([
    Type.Literal(false),
    Type.Literal("examples"),
    Type.Literal("all"),
  ], { default: "examples" })),
  includeImplementations: Type.Optional(Type.Boolean({ default: false })),
  includeTypeDefinitions: Type.Optional(Type.Boolean({ default: true })),
  includeHover: Type.Optional(Type.Boolean({ default: true })),
});

// ─── Error formatting (actionable client-facing errors) ─────────────

/**
 * Wrap an error with an actionable message instead of a raw data dump.
 *
 * Strips the "Received arguments:" noise that Pi's built-in validation
 * dumps and returns a concise, fix-oriented error.
 */
function formatEditError(message: string, hint?: string): Error {
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
  // Strategy 1: escape literal newlines inside quoted string values
  try {
    const repaired = raw.replace(
      /"(?:[^"\\\\]|\\.)*"/gs,
      (match) => {
        if (match.includes('\n') || match.includes('\r')) {
          return match.replace(/\r?\n/g, '\\n').replace(/\r/g, '\\r');
        }
        return match;
      },
    );
    if (repaired !== raw) {
      const result = JSON.parse(repaired) as Record<string, unknown>;
      if (result !== undefined) return result;
    }
  } catch {
    // fall through to next strategy
  }

  // Strategy 2: truncated JSON array — extract complete edit objects.
  // Only activate when the string actually contains object braces so we
  // don't accidentally treat random non-JSON text (e.g. "[not valid")
  // as a truncated array.
  try {
    if (/^\s*\[/.test(raw) && !/\]\s*$/.test(raw) && raw.includes('{') && raw.includes('}')) {
      return tryExtractPartialEdits(raw);
    }
  } catch {
    // fall through
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


// ─── Legacy input compatibility ─────────────────────────────────────

function prepareArguments(input: Record<string, unknown>): Record<string, unknown> {
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
      `edit must be called with two fields:
` +
      `  path: string   — path to the file to edit (relative or absolute)
` +
      `  edits: array   — one or more oldText/newText edit objects

` +
      `Example:
` +
      `  edit({
` +
      `    path: "src/foo.ts",
` +
      `    edits: [{ oldText: "old line", newText: "new line" }]
` +
      `  })`
    );
  }

  if (!args.path) {
    throw formatEditError(
      `Edit tool is missing the required "path" field.`,
      `You must specify which file to edit. Add a path string to your edit call:

` +
      `  {
` +
      `    path: "src/foo.ts",  // <-- add this — relative or absolute path
` +
      `    edits: [{ oldText: "...", newText: "..." }]
` +
      `  }`
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
        `Send edits as an oldText/newText array:\n` +
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
    // the input could be a search/replace block, unified diff, or OpenAI patch.
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
                if (hunk.kind === 'DeleteFile' && args.path) {
                  try {
                    fileOldContents = fsReadFileSync(hunk.path, 'utf-8');
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
          `edits must be an array of oldText/newText edit objects, or experimental hashline edit objects when enabled.\n` +
          `Format: { oldText: '...', newText: '...' } or { hashline: { range: { pos: '42ab', end: '45cd' }, content: ['lines'] } }\n` +
          `Raw value (${raw.length} chars) starts with:\n  ${snippet}\n\n` +
          `This typically happens when the JSON is improperly escaped or truncated.\n` +
          `Automatic repair was attempted but could not recover a valid edits array.\n` +
          `Fix: ensure edits is sent as a proper JSON array, not a string.`
        );
      }
    }

    // Validate each item is an object with required fields.
    // Hashline edits are optional/experimental and may be disabled at runtime.
    const parsedArr = parsed as unknown[];
    for (let i = 0; i < parsedArr.length; i++) {
      const item = parsedArr[i] as Record<string, unknown>;
      if (item === null || typeof item !== "object") {
        throw formatEditError(
          `edits[${i}] is ${item === null ? "null" : `a ${typeof item}`}, not an object.`,
          `Each element in edits must be an object with oldText/newText fields, or an experimental hashline field when enabled.`
        );
      }
      const isHashlineEdit = item.hashline && typeof item.hashline === "object" &&
        (item.hashline as Record<string, unknown>).range;
      if (!isHashlineEdit) {
        if (typeof item.oldText !== "string") {
          throw formatEditError(
            `edits[${i}].oldText is ${typeof item.oldText}, but must be a string.`,
            `oldText is the exact text to find in the file for replacement. ` +
            `Alternatively, use hashline format only when hashline editing is enabled: ` +
            `{ hashline: { range: { pos: '42ab', end: '45cd' }, content: [...] } }`
          );
        }
        if (typeof item.newText !== "string") {
          throw formatEditError(
            `edits[${i}].newText is ${typeof item.newText}, but must be a string.`,
            `newText is the replacement text to write in place of oldText. ` +
            `Alternatively, use hashline format with content array when experimental hashline editing is enabled.`
          );
        }
      }
    }

    if (!smartEditRuntimeConfig.useHashlineEditing) {
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
          "Hashline edits are disabled by default.",
          "Use oldText/newText edits for the normal fuzzy-matching path, or set SMART_EDIT_USE_HASHLINE_EDITING=1 to enable the experimental hashline path."
        );
      }
    }

    args.edits = parsed;


  }

  // Legacy single-edit format: { path, oldText, newText, edits?: [...] }
  const legacy = args as Record<string, unknown>;
  if (
    typeof legacy.oldText === "string" &&
    typeof legacy.newText === "string"
  ) {
    const edits: EditItem[] = Array.isArray(legacy.edits)
      ? [...(legacy.edits as EditItem[])]
      : [];
    edits.push({
      oldText: legacy.oldText,
      newText: legacy.newText,
    });
    const { oldText: _, newText: __, ...rest } = legacy;
    return { ...rest, edits };
  }

  // ── Edits missing check (after legacy normalization, which returns early) ──
  // By this point, edits is not a string (handled above) and not a legacy format
  // (returned early). If it's still missing, provide an actionable error.
  if (args.edits === undefined || args.edits === null) {
    throw formatEditError(
      `Edit tool is missing the required "edits" field.`,
      `You must specify which replacements to make. Add an edits array:

` +
      `  {
` +
      `    path: "${typeof args.path === "string" ? args.path : "..."}",
` +
      `    edits: [{ oldText: '...', newText: '...' }]  // <-- add this
` +
      `  }`
    );
  }

  // Strip replaceAll/anchor/lineRange from edits so built-in schema validation
  // passes. The values are restored in execute() before calling applyEdits().
  if (Array.isArray(args.edits)) {
    const flags: boolean[] = [];
    const anchors: (EditAnchor | undefined)[] = [];
    const ranges: (LineRange | undefined)[] = [];
    const hashlines: (Record<string, unknown> | undefined)[] = [];

    for (const edit of args.edits as Array<Record<string, unknown>>) {
      // replaceAll
      if (typeof edit.replaceAll === 'boolean') {
        flags.push(edit.replaceAll);
        delete edit.replaceAll;
      } else {
        flags.push(false);
      }

      // anchor
      if (edit.anchor && typeof edit.anchor === 'object') {
        anchors.push(edit.anchor as unknown as EditAnchor);
        delete edit.anchor;
      } else {
        anchors.push(undefined);
      }

      // lineRange
      if (edit.lineRange && typeof edit.lineRange === 'object') {
        ranges.push(edit.lineRange as unknown as LineRange);
        delete edit.lineRange;
      } else {
        ranges.push(undefined);
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
    const hasAnchors = anchors.some((a) => a);
    const hasRanges = ranges.some((r) => r);
    const hasHashlines = hashlines.some((h) => h);
    if (hasFlags || hasAnchors || hasRanges || hasHashlines) {
      const extraData = {
        replaceAllFlags: hasFlags ? flags : null,
        anchorData: hasAnchors ? anchors : null,
        lineRangeData: hasRanges ? ranges : null,
        hashlineData: hasHashlines ? hashlines : null,
      };
      if (typeof args.path === "string" && !args.path.includes("??smartEditExtra=")) {
        args.path = args.path + "??smartEditExtra=" + Buffer.from(JSON.stringify(extraData)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      }
    }
  }

  return args;
}

// ─── Validate input ─────────────────────────────────────────────────

function validateInput(
  input: Record<string, unknown>,
  allowHashlineEdits: boolean,
): EditInput {
  if (
    !Array.isArray(input.edits) ||
    (input.edits as EditItem[]).length === 0
  ) {
    throw formatEditError(
      "Edit tool input is invalid: edits must contain at least one edit.",
      "Make sure edits is an array of edit objects using oldText/newText, or experimental hashline format when enabled: " +
      "{ hashline: { range: { pos: '42ab', end: '45cd' }, content: ['lines'] } }."
    );
  }

  if (!allowHashlineEdits) {
    const edits = input.edits as Array<Record<string, unknown>>;
    if (edits.some((edit) => Boolean(edit?.hashline && typeof edit.hashline === "object" && (edit.hashline as Record<string, unknown>).range))) {
      throw formatEditError(
        "Hashline edits are disabled by default.",
        "Use oldText/newText edits for the normal fuzzy-matching path, or set SMART_EDIT_USE_HASHLINE_EDITING=1 to enable the experimental hashline path."
      );
    }
  }

  return {
    path: input.path as string,
    edits: input.edits as EditItem[],
  };
}

// ─── File mutation queue (prevents concurrent edits to same file) ──

const fileMutationQueues = new Map<string, Promise<void>>();

function getMutationKey(filePath: string): string {
  return resolve(filePath);
}

async function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = getMutationKey(filePath);
  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((resolveQueue) => {
    releaseNext = resolveQueue;
  });

  // Chain that waits for nextQueue even if currentQueue rejected — prevents
  // a single failed edit from deadlocking all future edits to this file.
  const chainedQueue = currentQueue.then(
    () => nextQueue,
    () => nextQueue,
  );
  fileMutationQueues.set(key, chainedQueue);

  // Wait for previous operations, but don't let their errors block us.
  await currentQueue.catch(() => {});

  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}

// ─── AST resolver and conflict detector instances (per-session) ────

/** AST resolver instance, created once per session. null if Tree-sitter unavailable. */
let astResolver: ReturnType<typeof createAstResolver> | null = null;

/** Conflict detector instance, created once per session. */
let conflictDetector: ReturnType<typeof createConflictDetector> | null = null;

/** LSP manager instance, created once per session. */
let lspManager: LSPManager | null = null;

/**
 * Resolve an edit's anchor/lineRange to a SearchScope for narrowing.
 * Called per-edit before matching.
 */
async function resolveAnchorToScope(
  edit: EditItem,
  content: string,
  filePath: string,
): Promise<SearchScope | null> {
  // Priority 1: AST anchor by symbol name
  if (edit.anchor?.symbolName && astResolver) {
    let parseResult: Awaited<ReturnType<typeof astResolver.parseFile>> = null;
    try {
      parseResult = await astResolver.parseFile(content, filePath);
      if (parseResult) {
        const targetNode = astResolver.findSymbolNode(
          parseResult.tree,
          edit.anchor,
        );
        if (targetNode) {
          const scope: SearchScope = {
            startIndex: targetNode.startIndex,
            endIndex: targetNode.endIndex,
            description: `${targetNode.type} "${edit.anchor.symbolName}"`,
            source: "anchor",
          };
          return scope;
        }
      }
    } catch {
      // AST resolution failed — fall through to lineRange
    } finally {
      if (parseResult) {
        astResolver?.disposeParseResult(parseResult);
      }
    }
  }

  // Priority 2: Line range
  if (edit.lineRange && edit.lineRange.startLine >= 1) {
    const range = lineRangeToByteRange(content, edit.lineRange);
    return {
      startIndex: range.startIndex,
      endIndex: range.endIndex,
      description: `lines ${edit.lineRange.startLine}–${edit.lineRange.endLine ?? edit.lineRange.startLine}`,
      source: "lineRange",
    };
  }

  return null;
}

// ─── Re-read helpers for failed edits ──────────────────────────────

/**
 * Find approximate line numbers for a text snippet in file content.
 * Returns the first line (1-based) where oldText appears, or null.
 */
function findTextLineRange(
  content: string,
  oldText: string,
): { startLine: number; endLine: number } | null {
  if (!oldText) return null;
  const lines = content.split('\n');
  const searchText = oldText.split('\n')[0]; // First line of oldText
  if (!searchText) return null;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(searchText)) {
      const startLine = i + 1; // 1-based
      const endLine = Math.min(startLine + oldText.split('\n').length - 1, lines.length);
      return { startLine, endLine };
    }
  }
  return null;
}

/**
 * Extract the target line number from a hashline anchor string.
 * Handles special anchors, numeric anchors, and :after/:before suffixes.
 * Used by the range coverage guard to validate hashline-only edits.
 */
function getHashlineAnchorLine(anchorStr: string, totalLines: number): number | null {
  const trimmed = anchorStr.trim();

  // Special anchors
  if (trimmed === "EOF" || trimmed === "end") return totalLines;
  if (trimmed === "start" || trimmed === "BOF") return 1;

  // Strip :after / :before suffix
  const base = trimmed.replace(/:after$|:before$/, "");

  // Extract leading number from LINE+HASH format
  const lineMatch = base.match(/^(\d+)/);
  if (lineMatch) {
    const ln = parseInt(lineMatch[1], 10);
    return ln >= 1 && ln <= totalLines ? ln : null;
  }

  return null;
}

/**
 * Compute the containing line range for a set of edits from their oldText.
 * Returns [startLine, endLine] (1-based) or null if oldText can't be located.
 *
 * Used by the range coverage guard to validate that edit targets fall within
 * lines that were actually read this session.
 */
function computeEditContainingRange(
  content: string,
  edits: EditItem[],
): [number, number] | null {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  const contentLines = content.split("\n");

  for (const edit of edits) {
    if (!edit.oldText) continue;
    const searchLine = edit.oldText.split("\n")[0];
    if (!searchLine) continue;

    for (let i = 0; i < contentLines.length; i++) {
      if (contentLines[i].includes(searchLine)) {
        const startLine = i + 1; // 1-based
        const endLine = Math.min(
          startLine + edit.oldText.split("\n").length - 1,
          contentLines.length,
        );
        if (startLine < minStart) minStart = startLine;
        if (endLine > maxEnd) maxEnd = endLine;
        break; // only first match per edit
      }
    }
  }

  if (minStart === Infinity || maxEnd === -Infinity) return null;
  return [minStart, maxEnd];
}

/**
 * Sort hashline edits bottom-up so higher lines apply first.
 *
 * This preserves line-number stability across a batch and prevents an
 * earlier stale edit from blocking later valid edits in the same file.
 */
export function sortHashlineEditsForApplication(
  edits: Array<{ editIdx: number; sortLine: number; hashline?: Record<string, unknown> }>,
): Array<{ editIdx: number; sortLine: number; hashline?: Record<string, unknown> }> {
  return [...edits].sort((a, b) => {
    const lineDelta = b.sortLine - a.sortLine;
    if (lineDelta !== 0) return lineDelta;
    return a.editIdx - b.editIdx;
  });
}

/**
 * Format a compact batch summary for partial hashline success.
 *
 * When some hashline edits succeed and others fail stale-anchor validation,
 * a single summary keeps the agent output readable while still surfacing
 * that some edits were skipped.
 */
export function formatHashlineBatchSummary(
  totalEdits: number,
  appliedEdits: number,
  failedEdits: Array<{ editIdx: number; message: string }>,
): string | null {
  if (totalEdits <= 0 || failedEdits.length === 0 || failedEdits.length === totalEdits) {
    return null;
  }

  const skipped = failedEdits
    .map((edit) => `#${edit.editIdx + 1}`)
    .join(", ");
  const editWord = failedEdits.length === 1 ? "edit" : "edits";

  return `Hashline batch: applied ${appliedEdits}/${totalEdits} edit(s); skipped stale ${editWord} ${skipped}.`;
}

/**
 * Read a range of lines from a file and return them as a string.
 * Returns the lines with their line numbers for context.
 */
function readLinesWithContext(
  lines: string[],
  startLine: number,
  endLine: number,
  contextLines: number = 5,
): string {
  const totalLines = lines.length;
  // Expand range to include context lines
  const ctxStart = Math.max(1, startLine - contextLines);
  const ctxEnd = Math.min(totalLines, endLine + contextLines);

  const result: string[] = [];
  for (let i = ctxStart - 1; i < ctxEnd; i++) {
    const lineNum = i + 1;
    const marker = (lineNum >= startLine && lineNum <= endLine) ? '>>>' : '   ';
    result.push(`${marker} ${lineNum.toString().padStart(4)}: ${lines[i]}`);
  }
  return result.join('\n');
}

/**
 * After a failed edit, re-read the file from disk and build an enhanced
 * error message that includes the current file content around the edit
 * location. Also updates the read cache with the fresh content.
 */
async function reReadAfterFailure(
  absolutePath: string,
  path: string,
  cwd: string,
  edits: EditItem[],
  error: Error,
): Promise<Error> {
  let currentContent: string;
  try {
    currentContent = (await fsReadFile(absolutePath)).toString('utf-8');
  } catch {
    // Can't re-read — return original error
    return error;
  }

  // Update the read cache with the fresh content so the user can retry
  const lines = currentContent.split('\n');
  const hashline = smartEditRuntimeConfig.useHashlineEditing
    ? await buildHashlineAnchors(lines)
    : undefined;
  recordRead(path, cwd, currentContent, false, hashline);
  // Also update session reads so range coverage doesn't reject the retry
  recordReadSession(path, cwd, 1, -1, lines.length, "reReadAfterFailure");

  // Build context snippets for each edit that failed
  const contextParts: string[] = [];
  for (const edit of edits) {
    if (!edit.oldText) continue;

    // Try to find where this oldText should be
    const lineRange = findTextLineRange(currentContent, edit.oldText);
    if (lineRange) {
      const context = readLinesWithContext(lines, lineRange.startLine, lineRange.endLine);
      contextParts.push(
        `Edit target (lines ${lineRange.startLine}–${lineRange.endLine}):\n${context}`
      );
    }
  }

  // If no line ranges found, show the whole file (up to first 100 lines)
  if (contextParts.length === 0) {
    const previewLines = lines.slice(0, 100);
    contextParts.push(
      `File preview (first ${previewLines.length} lines):\n` +
      previewLines.map((line, i) => `     ${(i + 1).toString().padStart(4)}: ${line}`).join('\n')
    );
  }

  const contextStr = contextParts.join('\n\n---\n\n');
  const enhancedMessage = `${error.message}\n\n📖 Current file content around edit location:\n\n${contextStr}`;

  return new Error(enhancedMessage);
}

// ─── Extension entry point ──────────────────────────────────────────

export default function smartEdit(pi: ExtensionAPI) {
  // ── Populate read cache on every successful read ──
  pi.on("tool_result", async (event, _ctx) => {
    if (
      event.toolName === "read" &&
      !event.isError &&
      event.content
    ) {
      try {
        // Determine if this is a partial read (user-specified offset/limit)
        const isOffsetLimitRead =
          event.input?.offset != null || event.input?.limit != null;

        // Build full content from result blocks
        const fullText = event.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text || "")
          .join("");

        const inputPath = (event.input as { path?: string } | undefined)?.path;
        if (fullText && inputPath) {
          if (isOffsetLimitRead) {
            // Offset/limit reads are intentionally partial — record as partial.
            // Hashline anchors are only computed in the experimental mode.
            const readOffset = (event.input as { offset?: number })?.offset ?? 1;
            const lines = fullText.split("\n");
            const hashline = smartEditRuntimeConfig.useHashlineEditing
              ? await buildHashlineAnchors(lines, readOffset)
              : undefined;
            recordRead(inputPath, process.cwd(), fullText, true, hashline, readOffset);

            // Track read range for coverage validation
            const explicitLimit = (event.input as { limit?: number })?.limit;

            // When no explicit limit is given (offset-only read), use -1 to mean
            // "through end of file" so range coverage can validate correctly.
            // Determine the actual total file line count from snapshot data if
            // available rather than relying on the returned output, which may be
            // truncated by Pi's output limit.
            if (explicitLimit === undefined) {
              let totalFileLines = lines.length + readOffset - 1;
              try {
                const snapshot = getSnapshot(inputPath, process.cwd());
                if (snapshot?.hashline?.formattedLines?.length) {
                  totalFileLines = snapshot.hashline.formattedLines.length;
                }
              } catch {
                // Fall back to computed value
              }
              recordReadSession(inputPath, process.cwd(), readOffset, -1, totalFileLines, "read");
            } else {
              recordReadSession(inputPath, process.cwd(), readOffset, explicitLimit, lines.length + readOffset - 1, "read");
            }
            return;
          }

          // Detect Pi's automatic output truncation: if the file on disk is
          // larger than the content returned, the read was truncated.
          // We record as partial so the stale check only verifies mtime.
          let isTruncated = false;
          try {
            const resolvedPath = resolve(process.cwd(), inputPath);
            const fileStat = statSync(resolvedPath);
            if (fileStat.size > fullText.length) {
              isTruncated = true;
            }
          } catch {
            // file may not exist or stat failed — record normally
          }

          // Build hashline anchors only in the experimental mode.
          const lines = fullText.split("\n");
          const hashline = smartEditRuntimeConfig.useHashlineEditing
            ? await buildHashlineAnchors(lines)
            : undefined;
          recordRead(inputPath, process.cwd(), fullText, isTruncated, hashline);

          // Track read range for coverage validation
          recordReadSession(inputPath, process.cwd(), 1, -1, lines.length, "read");
        }
      } catch {
        /* silently ignore cache population errors */
      }
    }

    // ── Track read_multiple_files results ──
    // Populates the snapshot cache for each file read, so edits are allowed.
    if (
      event.toolName === "read_multiple_files" &&
      !event.isError
    ) {
      try {
        const inputFiles = (event.input as { files?: Array<{ path: string; offset?: number; limit?: number }> } | undefined)?.files;
        if (inputFiles && inputFiles.length > 0) {
          for (const file of inputFiles) {
            try {
              const resolvedPath = resolve(process.cwd(), file.path);
              const content = (await fsReadFile(resolvedPath)).toString("utf-8");
              if (content) {
                const isPartial = file.offset != null || file.limit != null;
                const lines = content.split("\n");
                const hashline = smartEditRuntimeConfig.useHashlineEditing
                  ? await buildHashlineAnchors(lines)
                  : undefined;
                recordRead(file.path, process.cwd(), content, isPartial, hashline);

                // Track read range for coverage validation
                const readOffset = file.offset ?? 1;
                const readLimit = file.limit ?? -1;
                recordReadSession(file.path, process.cwd(), readOffset, readLimit, lines.length, "read_multiple_files");
              }
            } catch {
              // File may not exist or can't be read — skip silently
            }
          }
        }
      } catch {
        /* silently ignore cache population errors */
      }
    }

    // ── Track intent_read results ──
    // Populates the snapshot cache for each successfully-read file.
    // Uses event.details.files (which includes directory-resolved files)
    // rather than event.input.files for completeness.
    if (
      event.toolName === "intent_read" &&
      !event.isError
    ) {
      try {
        const detailFiles = (event.details as { files?: Array<{ path: string; ok: boolean; inclusion?: string }> } | undefined)?.files;
        if (detailFiles && detailFiles.length > 0) {
          for (const file of detailFiles) {
            if (!file.ok) continue;

            try {
              const resolvedPath = resolve(process.cwd(), file.path);
              const content = (await fsReadFile(resolvedPath)).toString("utf-8");
              if (content) {
                // Mark as partial if the file wasn't fully included in output
                // due to packing limits or truncation (omitted files are still
                // recorded so the edit stale-check knows they were seen).
                const isPartial = file.inclusion !== "full";
                const lines = content.split("\n");
                const hashline = smartEditRuntimeConfig.useHashlineEditing
                  ? await buildHashlineAnchors(lines)
                  : undefined;
                recordRead(file.path, process.cwd(), content, isPartial, hashline);

                // Track read range for coverage validation
                // intent_read reads full files, so offset=1, limit=-1 (full file)
                recordReadSession(file.path, process.cwd(), 1, -1, lines.length, "intent_read");
              }
            } catch {
              // File may not exist or can't be read — skip silently
            }
          }
        }
      } catch {
        /* silently ignore cache population errors */
      }
    }

    // ── Track writes so write-then-edit flow doesn't trigger stale-file guard ──
    const writePath = (event.input as { path?: string } | undefined)?.path;
    if (
      event.toolName === "write" &&
      !event.isError &&
      writePath
    ) {
      try {
        // Read the file from disk to get what was actually written
        const resolvedPath = resolve(process.cwd(), writePath);
        const content = (await fsReadFile(resolvedPath)).toString("utf-8");
        if (content) {
          recordRead(writePath, process.cwd(), content);

          // Track write as a read (write-then-edit flow bypasses stale guard)
          const lines = content.split("\n");
          recordReadSession(writePath, process.cwd(), 1, -1, lines.length, "write");
        }
      } catch {
        // File might not exist yet or can't be read — skip silently
      }
    }
  });

  // ── Initialize per-session state ──
  pi.on("session_start", async (_event, _ctx) => {
    // Create AST resolver (returns null if Tree-sitter unavailable)
    astResolver = createAstResolver();

    // Create conflict detector wired to the AST resolver
    conflictDetector = createConflictDetector(defaultConflictConfig, () => astResolver);

    // Create LSP manager for semantic intelligence
    lspManager = new LSPManager(process.cwd());

    // Clear conflict history on session start
    if (conflictDetector) {
      conflictDetector.clearAll();
    }
  });

  // ── Shutdown on session end ──
  pi.on("session_shutdown", async () => {
    await lspManager?.shutdown();
    lspManager = null;
  });

  // ── Register the improved edit tool ──
  // TypeScript cannot express the full structural variance of Pi's ExtensionAPI.
  // The cast to `unknown` + `as any` bypasses the inferred generic constraints
  // that are stricter than what Pi actually enforces at runtime.
  (pi.registerTool as (t: unknown) => void)(({
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using oldText/newText fuzzy matching by default. Experimental hashline-anchored edits are available only when explicitly enabled. " +
      "If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. " +
      "Do not include large unchanged regions just to connect distant changes.",

    promptSnippet:
      "Make precise file edits using oldText/newText fuzzy matching by default. Use experimental hashline anchors only when explicitly enabled.",

    promptGuidelines: [
      "Use oldText/newText edits as the default path. They keep the normal fuzzy-matching flow and work with the current LSP and AST helpers.",
      "Use hashline anchors only when SMART_EDIT_USE_HASHLINE_EDITING is enabled. Each line in the read output has a LINE+ID prefix (e.g., '42ab|function hello() {').",
      "Format hashline edits as: { hashline: { range: { pos: '42ab', end: '45cd' }, content: ['new line 1', 'new line 2'] } }. For single-line edits, pos and end are the same anchor. Use 'EOF' or 'end' to append, 'start' or 'BOF' to prepend. Append ':after' or ':before' to an anchor for insert operations.",
      "Use multiple edits in one call for independent changes to the same file. All edits are matched against the original file content, not incrementally.",
      "Do not emit overlapping edits — merge nearby changes into one edit. Keep content arrays concise — only include lines that change.",
      "Before editing code that depends on custom types, imported factories, interfaces, or unfamiliar symbols, call semantic_context for the target range instead of reading whole dependency files.",
    ],

    parameters: editSchema as unknown as Record<string, unknown>,
    renderShell: "self" as const,

    async execute(
      _toolCallId: string,
      input: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
      _ctx: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: EditResult["details"] }> {
      if (smartEditRuntimeConfig.useHashlineEditing) {
        await initHashline();
      }
      // Save original edits string for streaming (before prepareArguments converts it)
      const rawEditsString = typeof input.edits === "string" ? input.edits : undefined;

      input = prepareArguments(input) || input;

      // ── Streaming patch preview ───────────────────────────────
      // When onUpdate is provided and the edits were originally a codex_patch
      // string, feed the raw patch text through StreamingPatchParser before
      // processing. This gives the caller real-time progress on how many hunks
      // are being processed.
      if (onUpdate && rawEditsString) {
        try {
          const format = detectInputFormat(rawEditsString);
          if (format === "codex_patch") {
            const parser = new StreamingPatchParser(onUpdate);
            parser.pushDelta(rawEditsString);
            parser.finish();
          }
        } catch {
          // Streaming is advisory — silent degradation on failure
        }
      }

      let extraData: Record<string, unknown> | null = null;
      if (typeof input.path === "string") {
        const extraIdx = input.path.indexOf("??smartEditExtra=");
        if (extraIdx !== -1) {
          try {
            extraData = JSON.parse(Buffer.from(input.path.slice(extraIdx + 17).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")) as Record<string, unknown> | null;
          } catch {}
          input.path = input.path.slice(0, extraIdx);
        }
      }

      const { path, edits } = validateInput(input, smartEditRuntimeConfig.useHashlineEditing);

      // Resolve path
      const cwd = process.cwd();
      const absolutePath = resolve(cwd, path);

      // Check if aborted
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      // Wrap in mutation queue to serialize edits to the same file
      return withFileMutationQueue(absolutePath, async () => {
        let aborted = false;
        const onAbort = () => {
          aborted = true;
        };

        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
        }

        try {
          // Check file exists
          try {
            await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
          } catch {
            if (signal) signal.removeEventListener("abort", onAbort);
            throw new Error(`File not found or not writable: ${path}`);
          }

          if (aborted) throw new Error("Operation aborted");

          // ── Stale file check (checkStale handles its own APFS retry + zero-read) ──
          const staleError = await checkStale(path, cwd);
          if (staleError) {
            if (signal) signal.removeEventListener("abort", onAbort);
            throw new Error(staleError);
          }

          // Read the file
          const buffer = await fsReadFile(absolutePath);
          const rawContent = buffer.toString("utf-8");

          // ── Session read fallback ──
          // Edge case: snapshot exists (file was read) but session reads weren't
          // recorded. This can happen when:
          //   - The tool_result handler didn't fire for this read
          //   - A previous reReadAfterFailure populated the snapshot without session reads
          //   - The file was injected via --context or @mention
          // If we passed checkStale (snapshot exists) but have no session reads,
          // populate them from the fresh file content so range coverage can validate.
          // This is safe because checkStale already confirmed the file was read.
          const existingSessions = getSessionReads(path, cwd);
          if (existingSessions.length === 0 && getSnapshot(path, cwd)) {
            const rawLines = rawContent.split('\n');
            recordReadSession(path, cwd, 1, -1, rawLines.length, "edit_fallback");
          }

          // ── Range coverage check (P1: read-guard pattern) ──
          // Validate that edit targets fall within lines actually read this session.
          // This prevents edits to sections of a file the model hasn't seen.
          // Uses the edits' oldText to determine target lines.
          // ── Range coverage guard ──
          // Priority 1: Derive range from oldText (works for legacy edits)
          // Priority 2: Derive range from hashline anchors (works for hashline-only edits)
          let editLineRange = computeEditContainingRange(rawContent, edits);

          if (!editLineRange && extraData?.hashlineData) {
            const totalLines = rawContent.split('\n').length;
            let minStart = Infinity;
            let maxEnd = -Infinity;

            for (const h of (extraData.hashlineData as unknown[])) {
              if (!h) continue;
              const he = h as Record<string, unknown>;
              const range = he.range as { pos?: string; end?: string } | undefined;
              if (!range?.pos || !range?.end) continue;

              const startLine = getHashlineAnchorLine(range.pos, totalLines);
              const endLine = getHashlineAnchorLine(range.end, totalLines);
              if (startLine === null || endLine === null) continue;

              if (startLine < minStart) minStart = startLine;
              if (endLine > maxEnd) maxEnd = endLine;
            }

            if (minStart !== Infinity && maxEnd !== -Infinity) {
              editLineRange = [minStart, maxEnd];
            }
          }

          if (editLineRange) {
            const coverageResult = checkRangeCoverage(path, cwd, editLineRange[0], editLineRange[1]);
            if (!coverageResult.covered) {
              if (signal) signal.removeEventListener("abort", onAbort);
              throw new Error(coverageResult.reason);
            }
          }

          if (aborted) throw new Error("Operation aborted");

          // Strip BOM for matching
          const { bom, text: content } = stripBom(rawContent);
          const originalEnding = detectLineEnding(content);
          let normalizedContent = normalizeToLF(content);

          // ── Re-inject replaceAll/anchor/lineRange from extracted extra data ──
          const localFlags = extraData != null && !Array.isArray(extraData) ? (extraData as Record<string, unknown>).replaceAllFlags as unknown[] ?? null : null;
          const localAnchors = extraData != null && !Array.isArray(extraData) ? (extraData as Record<string, unknown>).anchorData as unknown[] ?? null : null;
          const localRanges = extraData != null && !Array.isArray(extraData) ? (extraData as Record<string, unknown>).lineRangeData as unknown[] ?? null : null;
          const localHashlines = extraData != null && !Array.isArray(extraData) ? (extraData as Record<string, unknown>).hashlineData as unknown[] ?? null : null;

          // Separate hashline edits from legacy edits
          const totalLines = rawContent.split("\n").length;
          const hashlineEdits: Array<{ editIdx: number; sortLine: number; hashline: Record<string, unknown> }> = [];
          const legacyEdits: Array<{ editIdx: number; edit: EditItem }> = [];

          for (let i = 0; i < edits.length; i++) {
            const rawEdit = edits[i] as unknown as Record<string, unknown>;
            if (localHashlines?.[i] || rawEdit.__hashline) {
              const hashline = (localHashlines?.[i] || rawEdit.__hashline) as Record<string, unknown>;
              const range = hashline.range as { pos?: string; end?: string } | undefined;
              const sortLine = Math.max(
                getHashlineAnchorLine(range?.pos ?? "", totalLines) ?? 0,
                getHashlineAnchorLine(range?.end ?? "", totalLines) ?? 0,
              );
              hashlineEdits.push({ editIdx: i, sortLine, hashline });
            } else {
              // Guard: hashline-only edit with no oldText can't go through legacy pipeline
              // This happens when the hashline side-channel (path-encoded extraData) fails to decode.
              if (typeof rawEdit.oldText !== "string") {
                throw new Error(
                  `edits[${i}] has no oldText and no recoverable hashline data. ` +
                  `This edit was sent as hashline format but the anchor data was lost during tool parameter processing. ` +
                  `Re-read the file and retry the edit.`
                );
              }
              // Restore replaceAll/anchor/lineRange
              if (localFlags?.[i]) (edits[i] as unknown as Record<string, unknown>).replaceAll = true;
              if (localAnchors?.[i]) (edits[i] as unknown as Record<string, unknown>).anchor = localAnchors[i];
              if (localRanges?.[i]) (edits[i] as unknown as Record<string, unknown>).lineRange = localRanges[i];
              legacyEdits.push({ editIdx: i, edit: edits[i] });
            }
          }

          // ── Save original content for diff generation (before any edits) ──
          const baseContent = normalizedContent;

          // ── Collect match notes and conflict warnings ──
          const matchNotes: string[] = [];
          const conflictWarnings: string[] = [];
          let resultMatchSpans: MatchSpan[] = [];
          let replacementCount = 0;

          // ── Soft hashline feedback ──
          // Only surfaced in experimental hashline mode.
          if (smartEditRuntimeConfig.useHashlineEditing && legacyEdits.length > 0) {
            const snapshot = getSnapshot(path, cwd);
            if (snapshot?.hashline?.anchors && snapshot.hashline.anchors.size > 0) {
              const needsLegacy = legacyEdits.some(
                ({ edit }) => edit.replaceAll || edit.anchor || edit.lineRange
              );
              if (!needsLegacy) {
                const anchorExamples: string[] = [];
                let count = 0;
                for (const [anchor] of snapshot.hashline.anchors) {
                  anchorExamples.push(anchor);
                  if (++count >= 3) break;
                }
                matchNotes.push(
                  `hint: hashline anchors are available for this file — prefer hashline format next time for freshness checking. ` +
                  `Example: { hashline: { range: { pos: '${anchorExamples[0] ?? '42ab'}', end: '${anchorExamples[1] ?? '45cd'}' }, content: ['lines'] } }`
                );
              }
            }
          }

          // ── Phase A: Apply hashline edits (if any) ──
          if (hashlineEdits.length > 0) {
            // Import hashline-edit functions at runtime to avoid circular deps
            const {
              applyHashlinePath,
            } = await import("./lib/hashline-edit.js");
            const { getSnapshot } = await import("./lib/read-cache.js");
            const { findText, findTextWithTelemetry, detectIndentation } = await import("./lib/edit-diff.js");

            // Get file snapshot from cache for oldText reconstruction
            const snapshot = getSnapshot(path, cwd);

            // Build adapter for AST scope resolution
            const resolveScopeFn = async (
              anchor: EditAnchor,
              content: string,
              _filePath: string,
            ) => {
              const scope = await resolveAnchorToScope(
                { oldText: "", newText: "", anchor } as EditItem,
                content,
                path,
              );
              if (!scope) return null;
              return scope;
            };

            // Wrap findText with telemetry for matching instrumentation
            const findTextWithT: typeof findText = (content, search, style, offset, scope) => {
              const { result, telemetry } = findTextWithTelemetry(content, search, style, offset, scope);
              // Only report telemetry when a fuzzy tier was used
              if (telemetry && telemetry.length > 0) {
                const successTiers = telemetry.filter((t: { success: boolean }) => t.success);
                if (successTiers.length > 0) {
                  const summary = successTiers
                    .map((t: { tier: string; durationMs: number }) => `${t.tier}: ${t.durationMs.toFixed(1)}ms`)
                    .join(", ");
                  matchNotes.push(`[match-telemetry] ${summary}`);
                }
              }
              return result;
            };

            const orderedHashlineEdits = sortHashlineEditsForApplication(hashlineEdits);

            const hashlineErrors: Array<{ editIdx: number; message: string }> = [];
            for (const { editIdx, hashline } of orderedHashlineEdits) {
              const rawEdit = hashline as Record<string, unknown>;

              const input: HashlineEditInput = {
                anchor: {
                  range: rawEdit.range as { pos: string; end: string },
                  ...(rawEdit.symbol
                    ? { symbol: rawEdit.symbol as { name: string; kind?: string; line?: number } }
                    : {}),
                },
                content: rawEdit.content as string[] | string | null | undefined,
              };

              try {
                const pathResult = await applyHashlinePath(
                  input,
                  normalizedContent,
                  snapshot,
                  resolveScopeFn,
                  findTextWithT as Parameters<typeof applyHashlinePath>[4],
                  detectIndentation,
                );

                if (pathResult.warnings.length > 0) {
                  matchNotes.push(...pathResult.warnings);
                }

                normalizedContent = pathResult.newContent;
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                hashlineErrors.push({ editIdx, message });
              }
            }

            const batchSummary = formatHashlineBatchSummary(
              orderedHashlineEdits.length,
              orderedHashlineEdits.length - hashlineErrors.length,
              hashlineErrors,
            );
            if (batchSummary) {
              matchNotes.push(batchSummary);
            }

            if (hashlineErrors.length > 0 && hashlineErrors.length === orderedHashlineEdits.length) {
              throw new Error(hashlineErrors.map((e) => e.message).join("\n\n"));
            }
          }

          // ── Phase B: Apply legacy edits (if any) ──
          if (legacyEdits.length > 0) {
            // Resolve anchors to search scopes
            const resolvedScopes: (SearchScope | undefined)[] = [];
            for (const { edit } of legacyEdits) {
              if (edit.anchor || edit.lineRange) {
                const scope = await resolveAnchorToScope(edit, normalizedContent, path);
                resolvedScopes.push(scope ?? undefined);
              } else {
                resolvedScopes.push(undefined);
              }
            }

            // Apply legacy edits with pre-apply hooks (conflict detection)
            const legacyResult = await applyEdits(
              normalizedContent,
              legacyEdits.map(e => e.edit),
              path,
              {
                searchScopes: resolvedScopes,
                onBeforeApply: conflictDetector
                  ? async (spans) => {
                      const realSpans = spans.map((s) => ({
                        startIndex: s.matchIndex,
                        endIndex: s.matchIndex + s.matchLength,
                      }));

                      // Capture baseline before checking delta conflicts
                      // This ensures we only report NEW conflicts since the
                      // last successful edit to this file.
                      if (conflictDetector) conflictDetector.captureBaseline(path);

                      const conflicts = conflictDetector
                        ? await conflictDetector.checkDeltaConflicts(path, normalizedContent, realSpans)
                        : [];

                      if (conflicts.length > 0) {
                        const conflictMessages = conflicts.map(
                          (c) => `  - "${c.previousSymbol.name}" (${c.previousSymbol.kind}): ${c.suggestion}`,
                        );
                        const warningMsg =
                          `⚠ Conflict detected with previous edit:\n` +
                          conflictMessages.join("\n") +
                          `\nConsider re-reading the file to get updated content.`;

                        if (defaultConflictConfig.onConflict === "error") {
                          throw new Error(warningMsg);
                        } else {
                          conflictWarnings.push(warningMsg);
                        }
                      }
                    }
                  : undefined,
              },
            );

            if (aborted) throw new Error("Operation aborted");

            normalizedContent = legacyResult.newContent;
            matchNotes.push(...(legacyResult.matchNotes || []));
            resultMatchSpans = legacyResult.matchSpans;
            replacementCount = legacyResult.replacementCount;
          }

          // ── Guard: no-op check ──
          if (baseContent === normalizedContent) {
            const msg = edits.length === 1
              ? `No changes made to ${path}. The replacement produced identical content.`
              : `No changes made to ${path}. The replacements produced identical content.`;
            throw new Error(msg);
          }

          if (aborted) throw new Error("Operation aborted");

          // Reconstruct with BOM and line endings
          const finalContent =
            bom + restoreLineEndings(normalizedContent, originalEnding);

          // ── Approval gating check (warnings only — never blocks) ──
          const safetyResult = checkEditSafety(path, edits);
          if (safetyResult.warnings.length > 0) {
            matchNotes.push(...safetyResult.warnings);
          }

          // ── Save undo state before write (non-blocking, fire-and-forget) ──
          saveUndoState(cwd, absolutePath, baseContent, edits.length).catch(() => {});

          // Atomic write
          await atomicWrite(absolutePath, finalContent);

          // ── Update read cache with our known content (avoid APFS VFS stale reads) ──
          //
          // After atomicWrite's rename(), both statSync and fsReadFile can return
          // stale data from the replaced APFS inode for a brief window due to VFS
          // caching. Using our in-memory finalContent for hashing guarantees the
          // snapshot hash reflects what was actually written. We retry fsStat until
          // the file size stabilizes to match what we wrote, then store the settled
          // metadata via recordReadWithStat (bypasses the statSync in recordRead).
          const expectedSize = Buffer.byteLength(finalContent);
          let settledMtimeMs = Date.now();
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              const st = await fsStat(absolutePath);
              if (st.size === expectedSize) {
                settledMtimeMs = st.mtimeMs;
                break;
              }
            } catch {
              /* retry */
            }
            await new Promise((r) => setTimeout(r, 20 * Math.pow(2, attempt)));
          }

          const postEditLines = normalizedContent.split("\n");
          const postEditHashline = smartEditRuntimeConfig.useHashlineEditing
            ? await buildHashlineAnchors(postEditLines)
            : undefined;
          recordReadWithStat(path, cwd, finalContent, settledMtimeMs, expectedSize, postEditHashline);

          if (aborted) throw new Error("Operation aborted");

          // Record successful edit for future conflict detection
          // (after atomicWrite, so no phantom record if write fails)
          if (conflictDetector && resultMatchSpans.length > 0) {
            await conflictDetector.recordEdit(
              path,
              normalizedContent,
              resultMatchSpans.map((s) => ({
                startIndex: s.matchIndex,
                endIndex: s.matchIndex + s.matchLength,
              })),
            );
          }

          // Generate diff (baseContent saved before any edits were applied)
          const diffResult = generateDiffString(baseContent, normalizedContent);

          // ── Post-edit AST validation ──
          // Check that the file still parses correctly after the edit.
          // If validation is enabled, surface a warning but don't block success.
          if (astResolver) {
            const syntaxResult = await validateSyntax(normalizedContent, path);
            if (!syntaxResult.valid) {
              matchNotes.push(syntaxResult.error);
            }
          }

          // Build success message — use actual match count, not edit object count
          const matchCount = replacementCount || edits.length;
          let text: string;
          if (matchCount > edits.length) {
            // replaceAll expanded one edit into multiple replacements
            text = `Successfully applied ${edits.length} edit(s), replacing ${matchCount} occurrence(s) in ${path}.`;
          } else {
            text = `Successfully replaced ${matchCount} block(s) in ${path}.`;
          }

          // ── Post-edit diagnostic check: LSP + compiler fallback ──
          // First check LSP diagnostics, then fall back to compilers if no results.
          // allDiagnostics is declared at this scope so the details section below
          // can emit structured diagnostics for context-optimizer integration.
          let allDiagnostics: Array<{
            message: string;
            severity: 1 | 2 | 3 | 4;
            range: { start: { line: number; character: number }; end: { line: number; character: number } };
            source?: string;
          }> = [];
          if (lspManager) {
            const languageId = detectLanguageFromExtension(path);
            if (languageId) {
              // Phase 1: LSP diagnostics
              const diagResult = await checkPostEditDiagnostics(
                absolutePath,
                normalizedContent,
                languageId,
                lspManager,
              );

              // Phase 2: Compiler fallback (runs if LSP found nothing)
              const compilerRunner = getCompilerForLanguage(languageId);
              let compilerResult: DiagnosticResult = { diagnostics: [], source: "none" };
              if (compilerRunner && diagResult.diagnostics.length === 0) {
                compilerResult = await compilerRunner(absolutePath, dirname(absolutePath));
              }

              // Aggregate results from both phases
              allDiagnostics = [...diagResult.diagnostics];
              if (compilerResult.diagnostics.length > 0) {
                allDiagnostics.push(...compilerResult.diagnostics);
              }

              // ── Record cross-file breakage edges (Smart-Edit → Pi-SmartRead bridge) ──
              // When diagnostics point to files OTHER than the one being edited,
              // these are empirically observed semantic coupling edges that no
              // static analysis captured. Record them so Pi-SmartRead's graph
              // expansion considers them on subsequent retrieval calls.
              if (allDiagnostics.length > 0) {
                try {
                  for (const d of allDiagnostics) {
                    if (d.severity === 1) {
                      // Check if the diagnostic has a filePath that differs from the edit target
                      const diagFilePath = (d as Record<string, unknown>).filePath as string | undefined;
                      if (diagFilePath && diagFilePath !== absolutePath && diagFilePath !== path) {
                        const contextMsg = d.message.slice(0, 120);
                        recordBreakage(cwd, path, diagFilePath, contextMsg, 0.9);
                      }
                    }
                  }
                } catch {
                  // Breakage recording is advisory — silently ignore failures
                }

                const errors = allDiagnostics.filter((d) => d.severity === 1);
                const warnings = allDiagnostics.filter((d) => d.severity === 2);
                const sources = new Set([diagResult.source, compilerResult.source].filter(s => s !== "none"));

                if (errors.length > 0) {
                  matchNotes.push(
                    `⚠ ${[...sources].join("+")} detected ${errors.length} error(s): ` +
                    errors.map((e) => `line ${e.range.start.line + 1}: ${e.message}`).join("; ")
                  );
                }
                if (warnings.length > 0) {
                  matchNotes.push(
                    `ℹ ${[...sources].join("+")} has ${warnings.length} warning(s): ` +
                    warnings.map((w) => w.message).join("; ")
                  );
                }
              } else if (diagResult.source !== "none") {
                // LSP is active and found no issues
                matchNotes.push("✓ LSP validated: no issues found");
              }
            }
          }

          // ── Post-edit evidence pipeline (traceability, history, concurrency) ──
          // Run the full evidence pipeline to gather historical context for changed
          // symbols and detect co-change patterns. Co-change edges are recorded to
          // Pi-SmartRead's mutation log for future graph expansion.
          if (resultMatchSpans.length > 0) {
            try {
              const evidence = await runPostEditEvidencePipeline({
                cwd,
                path: absolutePath,
                content: normalizedContent,
                languageId: detectLanguageFromExtension(path) ?? "unknown",
                matchSpans: resultMatchSpans.map((s) => ({
                  startIndex: s.matchIndex,
                  endIndex: s.matchIndex + s.matchLength,
                })),
                editedPaths: [absolutePath],
                lspManager,
              });

              // Record co-change edges from git history analysis
              // Each history entry tells us a file/symbol was changed alongside
              // other files in the same commits. This is a weak signal (0.6)
              // that decays with time, but accumulates across many edit sessions.
              for (const h of evidence.details.history) {
                if (h.commits.length > 0 && h.target.path) {
                  try {
                    recordCoChange(
                      cwd,
                      absolutePath,
                      h.target.path,
                      `recent history: ${h.commits[0].hash.slice(0, 8)} ${h.commits[0].subject.slice(0, 60)}`,
                      0.6,
                    );
                  } catch {
                    // Co-change recording is advisory
                  }
                }
              }
            } catch {
              // Evidence pipeline failure is advisory — don't block the edit result
            }
          }

          // Add match notes for transparency
          if (matchNotes.length > 0) {
            text += "\nNote: " + matchNotes.join(" ");
          }

          // Append conflict warnings
          if (conflictWarnings.length > 0) {
            text += "\n\n" + conflictWarnings.join("\n\n");
          }

          // Add conflict details to details output
          const details: {
            diff?: string;
            firstChangedLine?: number;
            matchNotes?: string[];
            conflictWarnings?: string[];
            mutatedPaths?: string[];
            diagnostics?: Array<{
              message: string;
              severity: 1 | 2 | 3 | 4;
              range: { start: { line: number; character: number }; end: { line: number; character: number } };
              source?: string;
              filePath?: string;
            }>;
          } = {
            diff: diffResult.diff,
            firstChangedLine: diffResult.firstChangedLine,
          };
          if (matchNotes.length > 0) {
            details.matchNotes = matchNotes;
          }
          if (conflictWarnings.length > 0) {
            details.conflictWarnings = conflictWarnings;
          }

          // Emit mutated path for context-optimizer integration.
          // This signals which files were actually changed so the context
          // optimizer can invalidate semantic cache entries without
          // re-parsing tool result text.
          details.mutatedPaths = [absolutePath];

          // Emit structured diagnostics for context-optimizer integration.
          // When diagnostics are available, the context optimizer's
          // tool_result_classifier consumes them as high-confidence
          // "current-failure" class content with exact file+line context,
          // rather than re-parsing from unstructured text.
          if (allDiagnostics && allDiagnostics.length > 0) {
            details.diagnostics = allDiagnostics.map((d) => ({
              message: d.message,
              severity: d.severity,
              range: d.range,
              source: d.source,
              filePath: (d as Record<string, unknown>).filePath as string | undefined,
            }));
          }

          return {
            content: [{ type: "text", text }],
            details,
          };
        } catch (error) {
          if (signal) signal.removeEventListener("abort", onAbort);

          if (!aborted) {
            const err = error instanceof Error ? error : new Error(String(error));

            // For edit-matching failures (stale file, oldText not found, etc.),
            // re-read the file from disk and include current content in the error.
            // This gives the user immediate context for retrying the edit.
            const isMatchFailure =
              err.message.includes("not found") ||
              err.message.includes("No matches") ||
              err.message.includes("has been modified") ||
              err.message.includes("not been read") ||
              err.message.includes("unique") ||
              err.message.includes("ambiguous");

            if (isMatchFailure) {
              const enhancedError = await reReadAfterFailure(
                absolutePath,
                path,
                cwd,
                edits,
                err,
              );
              throw enhancedError;
            }

            throw err;
          }
          throw new Error("Operation aborted");
        }
      });
    },

    // ── TUI rendering (delegates to same diff rendering as built-in) ──
    // renderCall and renderResult are optional; Pi's built-in rendering
    // provides sensible defaults for tools with text results.
  } as unknown));

  // ── Register the semantic_context retrieval tool ──
  (pi.registerTool as (t: unknown) => void)(({
    name: "semantic_context",
    label: "semantic_context",
    description: `Retrieve semantic context (type definitions, interfaces, implementations, and examples) for a code range without reading whole files.

Before editing code that depends on custom types, imported factories, interfaces, or unfamiliar symbols, call semantic_context for the target range instead of reading whole dependency files.

Examples:
  semantic_context({ path: "src/service.ts", lineRange: { startLine: 42, endLine: 78 }, maxTokens: 3000 })
  semantic_context({ path: "src/types.ts", symbol: { name: "CreateOrderInput" } })
  semantic_context({ path: "src/service.ts", lineRange: { startLine: 10, endLine: 30 }, includeReferences: "examples", includeTypeDefinitions: true, maxTokens: 1500 })`,

    promptSnippet: "Retrieve type definitions, implementations, and examples for symbols in a range.",

    parameters: semanticContextSchema as unknown as Record<string, unknown>,
    renderShell: "self" as const,

    async execute(
      _toolCallId: string,
      input: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
      _ctx: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
      const cwd = process.cwd();
      const path = input.path as string;
      const absolutePath = resolve(cwd, path);

      // Check if file has been read (Safety guard)
      const snapshot = getSnapshot(path, cwd);
      if (!snapshot) {
        return {
          content: [{
            type: "text",
            text: `Cannot retrieve semantic context for ${path} — this file has not been read in the current session. Read the file first, then retry semantic_context.`
          }]
        };
      }

      // Check if aborted
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      try {
        const result = await buildSemanticContext(input as unknown as SemanticContextInput, {
          cwd,
          lspManager,
          astResolver: astResolver as unknown as AstResolverLike | null,
          async readFile(p: string) {
            return (await fsReadFile(resolve(cwd, p))).toString("utf-8");
          },
          getSnapshot(p: string, c: string) {
            return getSnapshot(p, c);
          },
          recordRead(p: string, c: string, content: string, partial?: boolean) {
            recordRead(p, c, content, partial);
          },
          recordReadSession(p: string, c: string, lineRanges: Array<{ startLine: number; endLine: number }>) {
            // Map snippets back to session read ranges so the edit tool validates coverage
            for (const range of lineRanges) {
              recordReadSession(p, c, range.startLine, range.endLine - range.startLine + 1, 0, "semantic_context");
            }
          }
        });

        return {
          content: [{ type: "text", text: result.markdown }],
          details: result.details as unknown as Record<string, unknown>,
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return {
          content: [{ type: "text", text: `❌ Semantic context retrieval failed: ${err.message}` }]
        };
      }
    }
  } as unknown));
}

// ── Exports for testing ─────────────────────────────────────────────
// These are used by test/error-handling.test.ts only.
// At runtime, only the default export is consumed by Pi.
export {
  prepareArguments,
  formatEditError,
  validateInput,
};
