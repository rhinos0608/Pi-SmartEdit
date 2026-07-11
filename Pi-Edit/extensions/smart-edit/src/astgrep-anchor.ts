/**
 * Module: astgrep-anchor
 *
 * Provides ast-grep pattern matching as an alternative to tree-sitter queries
 * for symbolic edits. Wraps @ast-grep/napi with graceful fallback.
 *
 * Key design: all exported functions are async and never throw. If @ast-grep/napi
 * is unavailable (missing platform binary, build error), every function returns
 * null or an empty array. Pattern conversion to tree-sitter queries is attempted
 * as a best-effort fallback.
 */

// ─── Public Types ─────────────────────────────────────────────────

export interface AstGrepMatch {
  /** 1-based start line (inclusive). */
  startLine: number;
  /** 1-based end line (inclusive). */
  endLine: number;
  /** Byte offset of match start in the source. */
  startByte: number;
  /** Byte offset of match end in the source. */
  endByte: number;
  /** The exact text of the match. */
  matchedText: string;
}

export interface AstGrepReplaceResult {
  /** Source content with all matches replaced. */
  newContent: string;
  /** Number of replacements made. */
  matchCount: number;
}

// ─── Internal State ──────────────────────────────────────────────

// @ast-grep/napi is a native addon loaded dynamically.  All its types are
// unknown at compile time, so `any` is required.
/* eslint-disable @typescript-eslint/no-explicit-any */
let moduleRef: any = null;
let initError: string | null = null;

/** Exported boolean — set after first initialization attempt. */
export let ASTGREP_AVAILABLE = false;

// ─── Language ID Mapping ─────────────────────────────────────────

/**
 * Maps Pi-SmartEdit language IDs to @ast-grep/napi Lang enum names.
 * ast-grep uses PascalCase language names (e.g. "TypeScript", "Python").
 * The Lang enum values are accessed via `mod.Lang["TypeScript"]`.
 */
const LANG_MAP: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  tsx: "TSX",
  jsx: "JSX",
  python: "Python",
  json: "Json",
  css: "Css",
  html: "Html",
  markdown: "Markdown",
  yaml: "Yaml",
  sql: "Sql",
  rust: "Rust",
  go: "Go",
  java: "Java",
  ruby: "Ruby",
  php: "Php",
  c: "C",
  cpp: "Cpp",
  csharp: "CSharp",
  bash: "Bash",
  shell: "Bash",
  swift: "Swift",
  kotlin: "Kotlin",
};

/**
 * Resolve a language ID to the ast-grep Lang enum value.
 * Returns null if the language is not supported.
 */
function resolveLang(languageId: string): string | null {
  const langName = LANG_MAP[languageId.toLowerCase()];
  return langName ?? null;
}

// ─── Module Initialization ───────────────────────────────────────

/**
 * Dynamically import @ast-grep/napi on first call.
 * Returns null if the module cannot be loaded or if a previous attempt failed.
 * Never throws.
 */
async function ensureAstGrep(): Promise<any> {
  if (moduleRef) return moduleRef;
  if (initError !== null) return null;

  try {
    moduleRef = await import("@ast-grep/napi");
    ASTGREP_AVAILABLE = true;
    return moduleRef;
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err);
    ASTGREP_AVAILABLE = false;
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Extract meta-variable names from an ast-grep pattern.
 * Returns e.g. ["X", "Y"] for pattern "const $X = $Y".
 * Multi-node captures ($$$ARGS) are excluded — they aren't suitable
 * for simple text substitution.
 */
function extractMetaVarNames(pattern: string): string[] {
  const names: string[] = [];

  // Collect multi-node wildcard names ($$$NAME) for exclusion.
  // These are not suitable for simple text substitution.
  const multiNames = new Set<string>();
  const multiRe = /\$\$\$(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = multiRe.exec(pattern)) !== null) {
    multiNames.add(m[1]);
  }

  // Collect single-node captures ($NAME), excluding names that belong
  // to $$$ multi-wildcards.  Use a lookbehind to match $ that is NOT
  // preceded by another $, so that "$$$NAME" is not double-counted.
  const singleRe = /(?<!\$)\$(\w+)/g;
  while ((m = singleRe.exec(pattern)) !== null) {
    if (!multiNames.has(m[1]) && !names.includes(m[1])) {
      names.push(m[1]);
    }
  }

  return names;
}

/**
 * Escape a string for use in a RegExp constructor.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Public Functions ────────────────────────────────────────────

/**
 * Check whether ast-grep napi loaded successfully.
 * Can be called any number of times; the first call triggers the dynamic import.
 * Never throws.
 */
export async function isAstGrepAvailable(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const mod = await ensureAstGrep();
  return mod !== null;
}

/**
 * Find all matches of `pattern` in `content` using ast-grep.
 *
 * Parses content with ast-grep's `parse()`, uses `root.findAll(pattern)` to
 * locate all matches, and returns line/byte ranges for each match.
 *
 * Returns an empty array on any error or if ast-grep is unavailable.
 * Never throws.
 */
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-plus-operands, @typescript-eslint/no-unsafe-assignment */
export async function findWithPattern(
  content: string,
  languageId: string,
  pattern: string,
): Promise<AstGrepMatch[]> {
  const mod = await ensureAstGrep();
  if (!mod) return [];

  const langName = resolveLang(languageId);
  if (!langName) return [];

  try {
    // Lang enum value is accessed via mod.Lang["TypeScript"] etc.
    const lang = mod.Lang?.[langName] ?? langName;

    // sgRoot is an SgRoot instance
    const sgRoot = mod.parse(lang, content);
    // root() returns the root SgNode
    const rootNode = sgRoot.root();

    // findAll returns SgNode[] matching the pattern
    const nodes: any[] = rootNode.findAll(pattern) ?? [];

    return nodes.map((node: any) => {
      // range() returns {start: {line, column, index}, end: {line, column, index}}
      const rng = node.range();
      // index is the byte offset within the source
      const startByte: number = rng?.start?.index ?? 0;
      const endByte: number = rng?.end?.index ?? 0;
      // line is 0-based; convert to 1-based
      const startLine: number = (rng?.start?.line ?? 0) + 1;
      const endLine: number = (rng?.end?.line ?? 0) + 1;
      const matchedText: string = node.text?.() ?? "";
      return { startLine, endLine, startByte, endByte, matchedText };
    });
  } catch {
    return [];
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-plus-operands */

/**
 * Apply a pattern-based replacement using ast-grep.
 *
 * Locates all matches of `pattern` in the parsed content, resolves capture
 * names in the replacement string with the actual captured text via
 * `node.getMatch()`, and returns the modified content.
 *
 * Returns null on any error or if ast-grep is unavailable.
 * When no matches are found, returns `{ newContent: content, matchCount: 0 }`.
 * Never throws.
 */
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
export async function replaceWithPattern(
  content: string,
  languageId: string,
  pattern: string,
  replacement: string,
): Promise<AstGrepReplaceResult | null> {
  const mod = await ensureAstGrep();
  if (!mod) return null;

  const langName = resolveLang(languageId);
  if (!langName) return null;

  try {
    const lang = mod.Lang?.[langName] ?? langName;
    const sgRoot = mod.parse(lang, content);
    const rootNode = sgRoot.root();

    const nodes: any[] = rootNode.findAll(pattern) ?? [];
    if (nodes.length === 0) {
      return { newContent: content, matchCount: 0 };
    }

    // Extract capture names from the pattern for substitution
    const metaVarNames = extractMetaVarNames(pattern);

    // Build edits with meta-variables resolved to captured values.
    // ast-grep v0.42.1 replace() creates an edit with literal replacement text
    // (it does not resolve meta-variables), so we manually substitute captures
    // using node.getMatch().
    type Edit = { start: number; end: number; text: string };
    const edits: Edit[] = [];

    for (const node of nodes) {
      const rng = node.range();
      const start: number = rng?.start?.index ?? 0;
      const end: number = rng?.end?.index ?? 0;

      // Resolve $NAME captures in the replacement template
      let resolved = replacement;
      for (const name of metaVarNames) {
        const captured = node.getMatch(name);
        const capturedText: string = captured?.text?.() ?? `$${name}`;
        // Replace all occurrences of $name (word boundary at end)
        const escapedName = escapeRegex(name);
        resolved = resolved.replace(
          new RegExp(`\\$${escapedName}(?![a-zA-Z0-9_])`, "g"),
          capturedText,
        );
      }

      edits.push({ start, end, text: resolved });
    }

    // Apply edits in reverse byte order to preserve positions
    const chars = content.split("");
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      chars.splice(edit.start, edit.end - edit.start, edit.text);
    }

    return { newContent: chars.join(""), matchCount: nodes.length };
  } catch {
    return null;
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-call */

/**
 * Best-effort conversion of an ast-grep pattern to a tree-sitter query.
 *
 * Converts ast-grep meta-variable syntax to tree-sitter query capture syntax:
 *   - `$NAME` → capture `@name`
 *   - `$$$ARGS` → ellipsis `...`
 *
 * Returns null for patterns that contain structural constructs (brackets,
 * braces, pipes) that cannot be reliably converted via simple string
 * substitution.
 *
 * This is a fallback for when @ast-grep/napi is unavailable. The caller may
 * pass the result to tree-sitter's query API where the pattern uses S-expression
 * syntax with ast-grep-style capture names.
 * Never throws.
 */
export function astGrepPatternToTreeSitterQuery(pattern: string): string | null {
  if (!pattern) return null;

  // Reject patterns with structural constructs that simple string
  // substitution cannot safely convert: character classes, alternation,
  // repetition quantifiers.
  if (/[[\]{}|]/.test(pattern)) return null;

  try {
    let result = pattern;

    // $$$ multi-node wildcard → tree-sitter ellipsis (...).
    // Must replace before single $ to avoid partial matches of "$$$".
    result = result.replace(/\$\$\$(\w+)/g, "...");

    // $NAME single-node capture → @name
    result = result.replace(/\$(\w+)/g, "@$1");

    return result;
  } catch {
    return null;
  }
}
