/**
 * Changed target builder.
 *
 * Given the file content, language ID, and edit match spans, resolves
 * the enclosing AST symbol(s) for each span and produces an array of
 * `ChangedTarget` objects that represent the semantic units touched
 * by the edit.
 *
 * When tree-sitter parsing is unavailable or fails, falls back to
 * line-range-based unknown targets so the evidence pipeline still
 * has something to work with (e.g., traceability by filename).
 */

import type { ParseResult } from "../core/ast-resolver";
import { createAstResolver, disposeParseResult } from "../core/ast-resolver";
import type { ChangedTarget } from "./types";
import { byteOffsetToLine } from "./byte-offset";
import { simpleGlobMatch } from "./glob-match";

// ─── Symbol kind mapping ────────────────────────────────────────────

/**
 * Map tree-sitter node type strings to our public kind enum.
 * This keeps the pipeline's public API stable when grammars change.
 */
const KIND_MAP: Record<string, ChangedTarget["kind"]> = {
  // TypeScript / JavaScript
  function_declaration: "function",
  function_expression: "function",
  arrow_function: "function",
  method_definition: "method",

  // Python
  function_definition: "function",

  // Rust
  function_item: "function",

  // Go
  method_declaration: "method",

  // Ruby
  method: "function",
  singleton_method: "function",

  // Class-like
  class_declaration: "class",
  class_expression: "class",
  class_definition: "class",
  class_specifier: "class",
  struct_specifier: "class",
  struct_item: "class",
  enum_item: "class",
  interface_declaration: "class",
  trait_item: "class",

  // Module-like
  mod_item: "module",
  module: "class", // Ruby module mapped to class for our purposes
};

function mapKind(nodeType: string): ChangedTarget["kind"] {
  return KIND_MAP[nodeType] ?? "unknown";
}

/**
 * Determine the edit kind based on the file path and content.
 */
function classifyEditKind(
  path: string,
  testGlobs: string[],
): ChangedTarget["editKind"] {
  // Docs
  const docsExts = new Set([".md", ".markdown", ".txt", ".rst", ".asciidoc"]);
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (docsExts.has(ext)) return "docs";

  // Test files
  for (const glob of testGlobs) {
    if (simpleGlobMatch(glob, path)) {
      return "test";
    }
  }

  return "logic";
}


// ─── Default test globs (same as TraceabilityConfig defaults) ───────

const DEFAULT_TEST_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
];

// ─── Public API ─────────────────────────────────────────────────────

export interface BuildChangedTargetsInput {
  /** Absolute file path */
  path: string;
  /** Post-edit file content (LF-normalized, BOM-stripped) */
  content: string;
  /** Language ID as returned by detectLanguageFromExtension */
  languageId: string;
  /** Byte ranges of actual changes from edit match spans */
  matchSpans: Array<{ startIndex: number; endIndex: number }>;
  /** Test glob patterns (defaults used when not provided) */
  testGlobs?: string[];
}

/**
 * Build an array of ChangedTargets from the edit's match spans.
 *
 * Deduplicates by path + name + lineRange so multiple spans inside
 * the same function produce a single target.
 */
export async function buildChangedTargets(
  input: BuildChangedTargetsInput,
): Promise<ChangedTarget[]> {
  const { path, content, languageId, matchSpans } = input;
  const testGlobs = input.testGlobs ?? DEFAULT_TEST_GLOBS;
  const targets: ChangedTarget[] = [];
  const seen = new Set<string>();

  if (matchSpans.length === 0) {
    return targets;
  }

  // Normalise match spans so startIndex < endIndex
  const spans = matchSpans.map((s) => ({
    startIndex: Math.min(s.startIndex, s.endIndex),
    endIndex: Math.max(s.startIndex, s.endIndex),
  }));

  // Try AST resolution
  const resolver = createAstResolver();
  let parseResult: ParseResult | null = null;

  try {
    parseResult = await resolver.parseFile(content, path);

    if (parseResult && !parseResult.hasErrors) {
      const tree = parseResult.tree;

      for (const span of spans) {
        const symbols = resolver.findEnclosingSymbols(
          tree,
          span.startIndex,
          span.endIndex,
        );

        // Pick the innermost enclosing symbol (first in the response array)
        const innermost = symbols.length > 0 ? symbols[0] : null;

        if (innermost) {
          const key = `${path}:${innermost.name}:${innermost.startByte}`;
          if (seen.has(key)) continue;
          seen.add(key);

          targets.push({
            path,
            languageId,
            kind: mapKind(innermost.kind),
            name: innermost.name,
            lineRange: {
              startLine: innermost.lineStart,
              endLine: innermost.lineEnd,
            },
            byteRange: {
              startIndex: innermost.startByte,
              endIndex: innermost.endByte,
            },
            editKind: classifyEditKind(path, testGlobs),
            concurrencySignals: [], // populated by Phase 3
          });
        } else {
          // Span is inside a file but not inside a known symbol
          const startLine = byteOffsetToLine(content, span.startIndex);
          const endLine = byteOffsetToLine(content, span.endIndex);
          const key = `anon:${path}:${startLine}`;
          if (seen.has(key)) continue;
          seen.add(key);

          targets.push({
            path,
            languageId,
            kind: "unknown",
            name: `<range ${startLine}:${endLine}>`,
            lineRange: { startLine, endLine },
            byteRange: { startIndex: span.startIndex, endIndex: span.endIndex },
            editKind: classifyEditKind(path, testGlobs),
            concurrencySignals: [],
          });
        }
      }
    } else {
      // AST parse failed or unavailable — fallback per-span
      for (const span of spans) {
        const startLine = byteOffsetToLine(content, span.startIndex);
        const endLine = byteOffsetToLine(content, span.endIndex);
        const key = `fallback:${path}:${startLine}`;
        if (seen.has(key)) continue;
        seen.add(key);

        targets.push({
          path,
          languageId,
          kind: "unknown",
          name: `<range ${startLine}:${endLine}>`,
          lineRange: { startLine, endLine },
          byteRange: { startIndex: span.startIndex, endIndex: span.endIndex },
          editKind: classifyEditKind(path, testGlobs),
          concurrencySignals: [],
        });
      }
    }
  } finally {
    if (parseResult) {
      disposeParseResult(parseResult);
    }
  }

  return targets;
}

