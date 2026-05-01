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
import { constants, statSync } from "fs";
import { access as fsAccess, readFile as fsReadFile, unlink as fsUnlink, stat as fsStat, chmod as fsChmod, rename as fsRename, writeFile as fsWriteFile } from "fs/promises";
import { resolve, dirname, basename } from "path";
import { randomBytes } from "crypto";

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

import { recordRead, checkStale, recordReadWithStat } from "./lib/read-cache";
import { buildHashlineAnchors } from "./lib/hashline";
import type { HashlineEditInput } from "./lib/hashline-edit";

import { detectInputFormat } from "./src/formats/format-detector";
import { parseSearchReplace } from "./src/formats/search-replace";
import { parseUnifiedDiffToEditItems } from "./src/formats/unified-diff";
import { parseOpenAIPatch, openAIPatchToEditItem } from "./src/formats/openai-patch";

import { LSPManager } from "./src/lsp/lsp-manager";
import { checkPostEditDiagnostics } from "./src/lsp/diagnostics";

import type {
  EditAnchor,
  EditItem,
  EditInput,
  EditResult,
  LineRange,
  SearchScope,
} from "./lib/types";

// Symbol key for carrying replaceAll/anchor/lineRange data through
// schema validation without module-level side channels.
// The data is stored directly on the input object (scoped per-call)
// so concurrent calls cannot corrupt each other's state.
const kExtraEditData = Symbol('smartEditExtra');

interface ExtraEditData {
  replaceAllFlags: boolean[] | null;
  anchorData: (EditAnchor | undefined)[] | null;
  lineRangeData: (LineRange | undefined)[] | null;
}

// ─── Schema (must match built-in edit schema exactly) ──────────────
// Extra properties like `replaceAll`, `anchor`, `lineRange` are stripped
// by prepareArguments before validation, then restored in execute().

const editItemSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        "Exact text for one targeted replacement. Use replaceAll: true to replace every occurrence. " +
        "When replaceAll is false (default), oldText must match a unique, non-overlapping region.",
    }),
    newText: Type.String({
      description: "Replacement text for this targeted edit.",
    }),
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
    // Alternative schema: instead of oldText/newText, use anchor+content.
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
                "If the file changed, the edit is rejected with corrected anchors.",
            },
          ),
          content: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "Replacement lines as string[]. Each element is one logical line. " +
                "Use [] (empty array) to delete the targeted range. " +
                "Omit or use null to delete.",
            }),
          ),
        },
        {
          description:
            "Hashline-anchored edit: references LINE+ID anchors instead of reproducing text. " +
            "Format: { hashline: { range: { pos: '42ab', end: '45cd' }, content: ['new lines'] } } " +
            "Anchors are shown in read output (e.g., '42ab|function hello() {'). " +
            "This format is faster and more reliable than oldText reproduction.",
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
          "One or more targeted replacements. Each edit is matched against the original file, " +
          "not incrementally (all edits use the pre-edit file state). " +
          "\n- For unique text: emit edits with oldText/newText only. " +
          "\n- For repeated text: add replaceAll: true to replace every occurrence. " +
          "\n- For scoped edits: add anchor (AST symbol) or lineRange to narrow the search. " +
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
      const result = JSON.parse(repaired);
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
          const parsed = JSON.parse(objStr);
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
      `  edits: array   — one or more { oldText, newText } replacement objects

` +
      `Example:
` +
      `  edit({
` +
      `    path: "src/foo.ts",
` +
      `    edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }]
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
        `Send edits as an array of { oldText, newText } objects:\n` +
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
          `edits must be an array of { oldText, newText } objects.\n` +
          `Raw value (${raw.length} chars) starts with:\n  ${snippet}\n\n` +
          `This typically happens when the JSON is improperly escaped or truncated.\n` +
          `Automatic repair was attempted but could not recover a valid edits array.\n` +
          `Fix: ensure edits is sent as a proper JSON array, not a string.`
        );
      }
    }

    // Validate each item is an object with required fields
    const parsedArr = parsed as unknown[];
    for (let i = 0; i < parsedArr.length; i++) {
      const item = parsedArr[i] as Record<string, unknown>;
      if (item === null || typeof item !== "object") {
        throw formatEditError(
          `edits[${i}] is ${item === null ? "null" : `a ${typeof item}`}, not an object.`,
          `Each element in edits must be an object with oldText and newText string fields.`
        );
      }
      if (typeof item.oldText !== "string") {
        throw formatEditError(
          `edits[${i}].oldText is ${typeof item.oldText}, but must be a string.`,
          `oldText is the exact text to find in the file for replacement.`
        );
      }
      if (typeof item.newText !== "string") {
        throw formatEditError(
          `edits[${i}].newText is ${typeof item.newText}, but must be a string.`,
          `newText is the replacement text to write in place of oldText.`
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
      `    edits: [{ oldText: "...", newText: "..." }]  // <-- add this
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

      // hashline (extract and preserve for later routing)
      if (edit.hashline && typeof edit.hashline === 'object') {
        // Mark this edit as hashline format; restore in execute() for routing
        (edit as any).__hashline = edit.hashline;
        delete edit.hashline;
        // No extra array entries — arrays stay 1:1 with edits
      }
    }

    const hasFlags = flags.some((f) => f);
    const hasAnchors = anchors.some((a) => a);
    const hasRanges = ranges.some((r) => r);
    if (hasFlags || hasAnchors || hasRanges) {
      (args as any)[kExtraEditData] = {
        replaceAllFlags: hasFlags ? flags : null,
        anchorData: hasAnchors ? anchors : null,
        lineRangeData: hasRanges ? ranges : null,
      } as ExtraEditData;
    }
  }

  return args;
}

// ─── Validate input ─────────────────────────────────────────────────

function validateInput(input: Record<string, unknown>): EditInput {
  if (
    !Array.isArray(input.edits) ||
    (input.edits as EditItem[]).length === 0
  ) {
    throw formatEditError(
      "Edit tool input is invalid: edits must contain at least one replacement.",
      "Make sure edits is an array of { oldText, newText } objects, " +
      "each with the exact text from the file as oldText."
    );
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

// ─── Atomic write ───────────────────────────────────────────────────

/**
 * Write content to a file atomically:
 * 1. Write to a temp file in the same directory
 * 2. Preserve original mode bits
 * 3. Rename temp over original
 *
 * Falls back to direct write on cross-device rename errors.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const tmpName = `.${base}.smart_edit_tmp_${randomBytes(6).toString("hex")}`;
  const tmpPath = resolve(dir, tmpName);

  try {
    // Get original mode bits if they exist
    let mode: number | undefined;
    try {
      const stat = await fsStat(filePath);
      mode = stat.mode;
    } catch {
      // file doesn't exist yet — no mode to preserve
    }

    // Write to temp
    await fsWriteFile(tmpPath, content, "utf-8");

    // Restore mode
    if (mode !== undefined) {
      await fsChmod(tmpPath, mode);
    }

    // Atomic rename
    await fsRename(tmpPath, filePath);
  } catch (err) {
    // Clean up temp on failure
    try {
      await fsUnlink(tmpPath);
    } catch {
      /* ignore cleanup errors */
    }

    // If rename failed (e.g., cross-device), fall back to direct write
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "EXDEV"
    ) {
      await fsWriteFile(filePath, content, "utf-8");
      return;
    }

    throw err;
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
 * Detect the LSP language ID from a file path extension.
 * Returns null for unsupported file types.
 */
function detectLanguageFromExtension(filePath: string): string | null {
  const ext = filePath.toLowerCase();
  if (ext.endsWith(".ts") || ext.endsWith(".mts") || ext.endsWith(".cts")) return "typescript";
  if (ext.endsWith(".tsx")) return "typescriptreact";
  if (ext.endsWith(".js") || ext.endsWith(".mjs") || ext.endsWith(".cjs")) return "javascript";
  if (ext.endsWith(".jsx")) return "javascriptreact";
  return null;
}

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
            // Offset/limit reads are intentionally partial — record as partial
            // Also compute hashline anchors for offset/limit reads
          const lines = fullText.split("\n");
          const hashline = await buildHashlineAnchors(lines);
          recordRead(inputPath, process.cwd(), fullText, true, hashline);
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

          // Build hashline anchors for the full file text
          const lines = fullText.split("\n");
          const hashline = await buildHashlineAnchors(lines);
          recordRead(inputPath, process.cwd(), fullText, isTruncated, hashline);
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
                const hashline = await buildHashlineAnchors(lines);
                recordRead(file.path, process.cwd(), content, isPartial, hashline);
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
                const hashline = await buildHashlineAnchors(lines);
                recordRead(file.path, process.cwd(), content, isPartial, hashline);
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
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",

    promptSnippet:
      "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",

    promptGuidelines: [
      "Use edit for precise file modifications. Copy exact snippets from the latest file read as oldText.",
      "Use multiple edits in one call for independent changes to the same file.",
      "All edits are matched against the original file content, not after earlier edits. Do not emit overlapping edits — merge nearby changes into one edit.",
      "Keep oldText minimal but unique. Include enough surrounding context to uniquely identify the region.",
      "The tool tolerates minor indentation and Unicode differences, but exact snippets are always safer.",
    ],

    parameters: editSchema as any,
    renderShell: "self" as const,

    async execute(
      _toolCallId: string,
      input: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
      _ctx: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: EditResult["details"] }> {
      input = prepareArguments(input) || input;
      const { path, edits } = validateInput(input);

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

          // ── Stale file check with retry (handles macOS APFS mtime granularity) ──
          const MAX_RETRIES = 3;
          const INITIAL_DELAY_MS = 50;
          let staleError: string | null = null;

          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            staleError = await checkStale(path, cwd);
            if (!staleError) break;

            if (attempt < MAX_RETRIES - 1) {
              // Wait with exponential backoff before retry
              await new Promise(
                (r) => setTimeout(r, INITIAL_DELAY_MS * Math.pow(2, attempt))
              );
            }
          }

          if (staleError) {
            if (signal) signal.removeEventListener("abort", onAbort);
            throw new Error(staleError);
          }

          // Read the file
          const buffer = await fsReadFile(absolutePath);
          const rawContent = buffer.toString("utf-8");

          if (aborted) throw new Error("Operation aborted");

          // Strip BOM for matching
          const { bom, text: content } = stripBom(rawContent);
          const originalEnding = detectLineEnding(content);
          const normalizedContent = normalizeToLF(content);

          // ── Re-inject replaceAll/anchor/lineRange from Symbol-keyed extra data ──
          const extraData = (input as any)[kExtraEditData] as ExtraEditData | undefined;
          delete (input as any)[kExtraEditData];
          const localFlags = extraData?.replaceAllFlags ?? null;
          const localAnchors = extraData?.anchorData ?? null;
          const localRanges = extraData?.lineRangeData ?? null;

          // Separate hashline edits from legacy edits
          const hashlineEdits: Array<{ editIdx: number; hashline: Record<string, unknown> }> = [];
          const legacyEdits: Array<{ editIdx: number; edit: EditItem }> = [];

          for (let i = 0; i < edits.length; i++) {
            const rawEdit = edits[i] as unknown as Record<string, unknown>;
            if (rawEdit.__hashline) {
              hashlineEdits.push({ editIdx: i, hashline: rawEdit.__hashline as Record<string, unknown> });
            } else {
              // Restore replaceAll/anchor/lineRange
              if (localFlags?.[i]) (edits[i] as unknown as Record<string, unknown>).replaceAll = true;
              if (localAnchors?.[i]) (edits[i] as unknown as Record<string, unknown>).anchor = localAnchors[i];
              if (localRanges?.[i]) (edits[i] as unknown as Record<string, unknown>).lineRange = localRanges[i];
              legacyEdits.push({ editIdx: i, edit: edits[i] });
            }
          }

          // If there are hashline edits, handle them first with the hashline pipeline
          if (hashlineEdits.length > 0) {
            // Import hashline-edit functions at runtime to avoid circular deps
            const {
              resolveHashlineEdits,
              validateHashlineEdits,
              applyHashlineEdits,
              tryRebaseAll,
              HashlineMismatchError,
              detectEditFormat,
              applyHashlinePath,
              parseSymbolAnchor,
            } = await import("./lib/hashline-edit.js");
            const { getSnapshot } = await import("./lib/read-cache.js");
            const { findText, detectIndentation } = await import("./lib/edit-diff.js");

            // Get file snapshot from cache for oldText reconstruction
            const snapshot = getSnapshot(path, cwd);

            // Build adapter functions for applyHashlinePath
            // resolveScopeFn: convert SearchScope | null to the simpler {startIndex,endIndex,description} | null
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
              return {
                startIndex: scope.startIndex,
                endIndex: scope.endIndex,
                description: scope.description,
              };
            };

            // Process each hashline edit using the routing pipeline
            const hashlineResults: Array<{
              editIdx: number;
              result: string;
              diff?: string;
              firstChangedLine?: number;
              warning?: string;
              tier?: string;
            }> = [];

            for (const { editIdx, hashline } of hashlineEdits) {
              const rawEdit = hashline as {
                anchor?: HashlineEditInput["anchor"];
                content?: string[] | null;
              };

              const input: HashlineEditInput = {
                anchor: rawEdit.anchor as HashlineEditInput["anchor"],
                content: rawEdit.content as string[] | null | undefined,
              };

              // Use the main routing function — handles all fallback tiers
              const pathResult = await applyHashlinePath(
                input,
                normalizedContent,
                snapshot,
                resolveScopeFn,
                findText,
                detectIndentation,
              );

              // Collect result
              hashlineResults.push({
                editIdx,
                result: pathResult.newContent,
                firstChangedLine: pathResult.firstChangedLine,
                warning: pathResult.warnings[0],
                tier: pathResult.tier,
              });

              // Update normalizedContent for subsequent edits in the same batch
              normalizedContent = pathResult.newContent;
            }

            // Apply remaining legacy edits after all hashline edits
            // (hashline edits already updated normalizedContent in place)
            // For simplicity, apply legacy edits on top of the hashline result
            // This ensures the final file reflects all edits in sequence.
            // NOTE: This is a simplification. In production, we'd want to
            // interleave hashline and legacy edits in correct order.

            // For now: use the hashline result as the base for any legacy edits
            if (legacyEdits.length > 0) {
              // Apply legacy edits on top of hashline result
              const scopes: (SearchScope | undefined)[] = [];
              for (const { edit } of legacyEdits) {
                if (edit.anchor || edit.lineRange) {
                  const scope = await resolveAnchorToScope(edit, normalizedContent, path);
                  scopes.push(scope ?? undefined);
                } else {
                  scopes.push(undefined);
                }
              }

              const legacyResult = await applyEdits(
                normalizedContent,
                legacyEdits.map(e => e.edit),
                path,
                { searchScopes: scopes },
              );

              // Merge results
              const allMatchSpans = legacyResult.matchSpans;
              const diffResult = generateDiffString(normalizedContent, legacyResult.newContent);

              // Build success message
              const totalEdits = edits.length;
              const text = `Successfully replaced ${allMatchSpans.length} block(s) in ${path}.`;

              return {
                content: [{ type: "text", text }],
                details: {
                  diff: diffResult.diff,
                  firstChangedLine: diffResult.firstChangedLine,
                },
              };
            } else {
              // No legacy edits — return hashline result directly
              const finalContent = hashlineResults[hashlineResults.length - 1]?.result ?? normalizedContent;
              const allWarnings = hashlineResults.map(r => r.warning).filter(Boolean);
              const allTiers = hashlineResults.map(r => r.tier).filter(Boolean) as string[];

              // Count fallback tier usage for the success message
              const directCount = allTiers.filter(t => t === "hashline-direct").length;
              const rebasedCount = allTiers.filter(t => t === "hashline-rebased").length;
              const scopedCount = allTiers.filter(t => t === "scoped-fallback").length;
              const fuzzyCount = allTiers.filter(t => t === "full-fuzzy-fallback").length;

              const diffResult = generateDiffString(normalizedContent.split("\n").join("\n"), finalContent);

              const matchCount = hashlineResults.length;
              const hasFallback = rebasedCount > 0 || scopedCount > 0 || fuzzyCount > 0;
              let text: string;

              if (hasFallback) {
                const parts: string[] = [];
                if (directCount > 0) parts.push(`${directCount} direct`);
                if (rebasedCount > 0) parts.push(`${rebasedCount} rebased`);
                if (scopedCount > 0) parts.push(`${scopedCount} scoped`);
                if (fuzzyCount > 0) parts.push(`${fuzzyCount} fuzzy-fallback`);
                text = `Successfully applied ${matchCount} hashline edit(s) in ${path} (${parts.join(", ")}).`;
              } else {
                text = `Successfully replaced ${matchCount} block(s) in ${path} via hashline anchors.`;
              }

              if (allWarnings.length > 0) {
                text += "\nNote: " + allWarnings.join("; ");
              }

              return {
                content: [{ type: "text", text }],
                details: {
                  diff: diffResult.diff,
                  firstChangedLine: diffResult.firstChangedLine,
                },
              };
            }
          }

          // ── Resolve anchors to search scopes ──
          // Do this before applyEdits so the scopes can be passed explicitly.
          const resolvedScopes: (SearchScope | undefined)[] = [];
          for (const edit of edits) {
            if (edit.anchor || edit.lineRange) {
              const scope = await resolveAnchorToScope(edit, normalizedContent, path);
              resolvedScopes.push(scope ?? undefined);
            } else {
              resolvedScopes.push(undefined);
            }
          }

          // ── Conflict warnings collector for warn mode ──
          const conflictWarnings: string[] = [];

          // Apply edits with pre-apply hooks and anchor scopes
          const result = await applyEdits(
            normalizedContent,
            edits,
            path,
            {
              searchScopes: resolvedScopes,
              onBeforeApply: conflictDetector
                ? async (spans) => {
                    // Check conflicts with real MatchSpans
                    const realSpans = spans.map((s) => ({
                      startIndex: s.matchIndex,
                      endIndex: s.matchIndex + s.matchLength,
                    }));

                    const conflicts = await conflictDetector!.checkConflicts(
                      path,
                      normalizedContent,
                      realSpans,
                    );

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
                        // Collect warning — emit in output below
                        conflictWarnings.push(warningMsg);
                      }
                    }
                  }
                : undefined,
            },
          );

          if (aborted) throw new Error("Operation aborted");

          // Reconstruct with BOM and line endings
          const finalContent =
            bom + restoreLineEndings(result.newContent, originalEnding);

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
          recordReadWithStat(path, cwd, finalContent, settledMtimeMs, expectedSize);

          if (aborted) throw new Error("Operation aborted");

          // Record successful edit for future conflict detection
          // (after atomicWrite, so no phantom record if write fails)
          if (conflictDetector) {
            await conflictDetector.recordEdit(
              path,
              normalizedContent,
              result.matchSpans.map((s) => ({
                startIndex: s.matchIndex,
                endIndex: s.matchIndex + s.matchLength,
              })),
            );
          }

          // Generate diff
          const diffResult = generateDiffString(result.baseContent, result.newContent);

          // ── Post-edit AST validation ──
          // Check that the file still parses correctly after the edit.
          // If validation is enabled, surface a warning but don't block success.
          if (astResolver) {
            const syntaxResult = await validateSyntax(result.newContent, path);
            if (!syntaxResult.valid) {
              result.matchNotes.push(syntaxResult.error);
            }
          }

          // Build success message — use actual match count, not edit object count
          const matchCount = result.replacementCount;
          let text: string;
          if (matchCount > edits.length) {
            // replaceAll expanded one edit into multiple replacements
            text = `Successfully applied ${edits.length} edit(s), replacing ${matchCount} occurrence(s) in ${path}.`;
          } else {
            text = `Successfully replaced ${matchCount} block(s) in ${path}.`;
          }

          // ── Post-edit LSP diagnostics (non-blocking) ──
          if (lspManager) {
            const languageId = detectLanguageFromExtension(path);
            if (languageId) {
              const diagResult = await checkPostEditDiagnostics(
                absolutePath,
                result.newContent,
                languageId,
                lspManager,
              );
              if (diagResult.source === "lsp" && diagResult.diagnostics.length > 0) {
                const errors = diagResult.diagnostics.filter((d) => d.severity === 1);
                const warnings = diagResult.diagnostics.filter((d) => d.severity === 2);

                if (errors.length > 0) {
                  result.matchNotes.push(
                    `⚠ LSP detected ${errors.length} error(s) after edit: ` +
                    errors.map((e) => `line ${e.range.start.line + 1}: ${e.message}`).join("; ")
                  );
                }
                if (warnings.length > 0) {
                  result.matchNotes.push(
                    `ℹ LSP has ${warnings.length} warning(s): ` +
                    warnings.map((w) => w.message).join("; ")
                  );
                }
              }
            }
          }

          // Add match notes for transparency
          if (result.matchNotes.length > 0) {
            text += "\nNote: " + result.matchNotes.join(" ");
          }

          // Append conflict warnings
          if (conflictWarnings.length > 0) {
            text += "\n\n" + conflictWarnings.join("\n\n");
          }

          // Add conflict details to details output
          const details: { diff?: string; firstChangedLine?: number; matchNotes?: string[]; conflictWarnings?: string[] } = {
            diff: diffResult.diff,
            firstChangedLine: diffResult.firstChangedLine,
          };
          if (result.matchNotes.length > 0) {
            details.matchNotes = result.matchNotes;
          }
          if (conflictWarnings.length > 0) {
            details.conflictWarnings = conflictWarnings;
          }

          return {
            content: [{ type: "text", text }],
            details,
          };
        } catch (error) {
          if (signal) signal.removeEventListener("abort", onAbort);

          if (!aborted) {
            throw error instanceof Error ? error : new Error(String(error));
          }
          throw new Error("Operation aborted");
        }
      });
    },

    // ── TUI rendering (delegates to same diff rendering as built-in) ──
    // renderCall and renderResult are optional; Pi's built-in rendering
    // provides sensible defaults for tools with text results.
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
