/**
 * Lightweight static analysis pre-verification that catches common edit errors
 * before running expensive LSP diagnostics. Runs as a pre-filter in the
 * evidence pipeline.
 *
 * All checks are O(n) single-pass where possible. Never throws — returns
 * a safe default on any error.
 */

// ─── Delimiter configuration ─────────────────────────────────────────

interface DelimiterPair {
  readonly open: string;
  readonly close: string;
}

/**
 * Standard bracket/brace delimiter pairs used by most languages.
 * Additional language-specific pairs (begin/end etc.) are handled
 * separately via count checks rather than character-level matching.
 */
const STANDARD_DELIMITERS: readonly DelimiterPair[] = [
  { open: "{", close: "}" },
  { open: "[", close: "]" },
  { open: "(", close: ")" },
];

/**
 * Language keyword-marker pairs (e.g., begin/end in Ruby/Pascal).
 * Each pair is counted by word-boundary word match.
 */
interface KeywordPair {
  readonly open: string;
  readonly close: string;
}

const RUBY_KEYWORD_PAIRS: readonly KeywordPair[] = [
  { open: "begin", close: "end" },
  { open: "do", close: "end" },
  { open: "case", close: "end" },
];

const PASCAL_KEYWORD_PAIRS: readonly KeywordPair[] = [
  { open: "begin", close: "end" },
];

// ─── Known globals (never flag as missing imports) ────────────────────

const KNOWN_GLOBALS_TS = new Set([
  // Built-in objects
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "Promise",
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "URIError", "EvalError", "AggregateError",
  // DOM / platform
  "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "fetch", "Request", "Response", "Headers", "URL", "URLSearchParams",
  "JSON", "Math", "Infinity", "NaN", "undefined", "null", "globalThis",
  "Buffer", "process", "__dirname", "__filename", "module", "exports",
  "require", "describe", "it", "test", "expect", "beforeEach", "afterEach",
  "before", "after", "assert",
]);

// ─── Symbol declaration patterns by language family ──────────────────

interface LangConfig {
  /** Function/callable declaration patterns (capture group 1 = name) */
  declarationPatterns: string[];
  /** Block-comment open token */
  blockCommentOpen?: string;
  /** Block-comment close token */
  blockCommentClose?: string;
  /** Line comment prefix */
  lineComment?: string;
  /** Whether the language requires semicolons (relevant for syntaxSanity) */
  requiresSemicolons: boolean;
  /** Semicolons allowed but optional (JS/TS — don't flag missing) */
  semicolonsOptional: boolean;
  /** Delimiter keyword pairs (begin/end etc.) */
  keywordPairs: readonly KeywordPair[];
}

function getLangConfig(languageId: string): LangConfig {
  const lang = languageId.toLowerCase();
  switch (lang) {
    case "typescript":
    case "tsx":
      return {
        declarationPatterns: [
          // function foo, const|let|var foo, class Foo, interface Foo, type Foo, enum Foo
          /\b(?:function|const|let|var|class|interface|type|enum)\s+(\w+)\b/.source,
          // abstract class, export function, export default class, etc.
          /\b(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+(\w+)\b/.source,
          // export function foo
          /\bexport\s+(?:function|const|let|var)\s+(\w+)\b/.source,
          // import { foo } from → not a declaration per se, but surfaces named bindings
          // Arrow function const|let foo = (...) => ...
          /\b(?:const|let|var)\s+(\w+)\s*[:=]/.source,
          // method shorthand in class/object: foo(...) { ... }
          /^\s*(\w+)\s*\([^)]*\)\s*[{:]/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: [],
      };
    case "javascript":
    case "jsx":
      return {
        declarationPatterns: [
          /\b(?:function|const|let|var|class)\s+(\w+)\b/.source,
          /\bexport\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)\b/.source,
          /\b(?:const|let|var)\s+(\w+)\s*[:=]/.source,
          /^\s*(\w+)\s*\([^)]*\)\s*[{:]/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: [],
      };
    case "python":
      return {
        declarationPatterns: [
          /\bdef\s+(\w+)\b/.source,
          /\bclass\s+(\w+)\b/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: [],
      };
    case "go":
      return {
        declarationPatterns: [
          /\bfunc\s+(\w+)\b/.source,
          /\btype\s+(\w+)\s/.source,
          /\b(?:const|var)\s+(\w+)\s/.source,
          /\bstruct\s+(\w+)\s/.source,
          /\binterface\s+(\w+)\s/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: [],
      };
    case "rust":
      return {
        declarationPatterns: [
          /\bfn\s+(\w+)\b/.source,
          /\bstruct\s+(\w+)\b/.source,
          /\benum\s+(\w+)\b/.source,
          /\btrait\s+(\w+)\b/.source,
          /\btype\s+(\w+)\b/.source,
          /\bconst\s+(\w+)\b/.source,
          /\bu?impl\s/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: [],
      };
    case "ruby":
      return {
        declarationPatterns: [
          /\bdef\s+(\w+)\b/.source,
          /\bclass\s+(\w+)\b/.source,
          /\bmodule\s+(\w+)\b/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: RUBY_KEYWORD_PAIRS,
      };
    case "pascal":
      return {
        declarationPatterns: [
          /\b(?:procedure|function)\s+(\w+)\b/.source,
          /\bclass\s+(\w+)\b/.source,
        ],
        requiresSemicolons: false,
        semicolonsOptional: true,
        keywordPairs: PASCAL_KEYWORD_PAIRS,
      };
    default:
      // C-family fallback: C, C++, C#, Java, Kotlin, Dart, Swift, etc.
      return {
        declarationPatterns: [
          /\b(?:function|class|struct|enum|interface|trait)\s+(\w+)\b/.source,
          // Type-like: int foo, String foo, Foo foo,
          /\b(?:\w+\s+)+(\w+)\s*\([^)]*\)\s*[{:]/.source,
        ],
        requiresSemicolons: true,
        semicolonsOptional: false,
        keywordPairs: [],
      };
  }
}

// ─── Exported types ──────────────────────────────────────────────────

export interface PatchCorrectnessResult {
  passed: boolean;
  warnings: string[];
  checks: {
    unbalancedDelimiters: { passed: boolean; details: string };
    duplicateDeclarations: { passed: boolean; details: string };
    orphanedReferences: { passed: boolean; details: string };
    importConsistency: { passed: boolean; details: string };
    syntaxSanity: { passed: boolean; details: string };
    zeroValuePlaceholders: { passed: boolean; details: string };
  };
}

// ─── Public entry point ──────────────────────────────────────────────

/**
 * Run all patch correctness checks on an edit.
 *
 * Safe to call at any point — never throws. On error, returns a
 * passed=true result so the edit pipeline is not blocked.
 *
 * @param oldContent Pre-edit file content
 * @param newContent Post-edit file content
 * @param languageId Language identifier for language-specific checks
 * @param changedSymbols Names of symbols changed by the edit (from AST resolution)
 * @returns PatchCorrectnessResult with pass/fail and warnings
 */
export function checkPatchCorrectness(
  oldContent: string,
  newContent: string,
  languageId: string,
  changedSymbols?: string[],
): PatchCorrectnessResult {
  try {
    const config = getLangConfig(languageId);
    const warnings: string[] = [];

    const checkUnbalanced = checkUnbalancedDelimiters(oldContent, newContent, config);
    const checkDuplicate = checkDuplicateDeclarations(oldContent, newContent, config, changedSymbols);
    const checkOrphaned = checkOrphanedReferences(oldContent, newContent, config, changedSymbols);
    const checkImports = checkImportConsistency(oldContent, newContent, languageId, config);
    const checkSyntax = checkSyntaxSanity(newContent, config);
    const checkZeroValues = checkZeroValuePlaceholders(oldContent, newContent, config);

    const checks = {
      unbalancedDelimiters: checkUnbalanced,
      duplicateDeclarations: checkDuplicate,
      orphanedReferences: checkOrphaned,
      importConsistency: checkImports,
      syntaxSanity: checkSyntax,
      zeroValuePlaceholders: checkZeroValues,
    };

    for (const [name, result] of Object.entries(checks)) {
      if (!result.passed) {
        warnings.push(`[${name}] ${result.details}`);
      }
    }

    return {
      passed: warnings.length === 0,
      warnings,
      checks,
    };
  } catch {
    // Never throw — return safe default on any error
    return safePass();
  }
}

// ─── Individual checks ───────────────────────────────────────────────

/**
 * 1. Unbalanced delimiters: count braces, brackets, parens in old vs new.
 *    If the delta between old and new differs for open vs close, flag it.
 */
function checkUnbalancedDelimiters(
  oldContent: string,
  newContent: string,
  config: LangConfig,
): { passed: boolean; details: string } {
  const issues: string[] = [];

  // Character-based delimiters
  for (const pair of STANDARD_DELIMITERS) {
    const oldOpen = countChar(oldContent, pair.open);
    const oldClose = countChar(oldContent, pair.close);
    const newOpen = countChar(newContent, pair.open);
    const newClose = countChar(newContent, pair.close);

    const deltaOpen = newOpen - oldOpen;
    const deltaClose = newClose - oldClose;

    if (deltaOpen !== deltaClose) {
      const label = pair.open + pair.close;
      issues.push(
        `${label}: edit adds ${deltaOpen} opening and ${deltaClose} closing (unbalanced by ${Math.abs(deltaOpen - deltaClose)})`,
      );
    }
  }

  // Keyword-based delimiters (begin/end etc.)
  for (const pair of config.keywordPairs) {
    const oldOpen = countWord(oldContent, pair.open);
    const oldClose = countWord(oldContent, pair.close);
    const newOpen = countWord(newContent, pair.open);
    const newClose = countWord(newContent, pair.close);

    const deltaOpen = newOpen - oldOpen;
    const deltaClose = newClose - oldClose;

    if (deltaOpen !== deltaClose) {
      issues.push(
        `${pair.open}/${pair.close}: edit adds ${deltaOpen} "${pair.open}" and ${deltaClose} "${pair.close}" (unbalanced by ${Math.abs(deltaOpen - deltaClose)})`,
      );
    }
  }

  if (issues.length > 0) {
    return { passed: false, details: issues.join("; ") };
  }
  return { passed: true, details: "All delimiters balanced" };
}

/**
 * 2. Duplicate declarations: check if the edit introduces a symbol name
 *    that already exists in the file.
 */
function checkDuplicateDeclarations(
  oldContent: string,
  newContent: string,
  config: LangConfig,
  changedSymbols?: string[],
): { passed: boolean; details: string } {
  const oldDecls = countDeclarations(oldContent, config);
  const newDecls = countDeclarations(newContent, config);

  // Names whose declaration count increased (potential duplicates)
  const addedDecls = new Set<string>();
  for (const [name, newCount] of newDecls) {
    const oldCount = oldDecls.get(name) ?? 0;
    if (newCount > oldCount) {
      addedDecls.add(name);
    }
  }

  if (addedDecls.size === 0) {
    return { passed: true, details: "No new declarations introduced" };
  }

  // Constrain to changedSymbols when available
  const candidates = changedSymbols && changedSymbols.length > 0
    ? [...addedDecls].filter((s) => changedSymbols.includes(s))
    : [...addedDecls];

  // For each name whose declaration count increased, check if it
  // already existed in old content (potential duplicate).
  const duplicates: string[] = [];
  for (const name of candidates) {
    const oldCount = oldDecls.get(name) ?? 0;
    if (oldCount > 0 && (newDecls.get(name) ?? 0) > oldCount) {
      duplicates.push(name);
    }
  }

  if (duplicates.length > 0) {
    return {
      passed: false,
      details: `New declarations may duplicate existing ones: ${duplicates.join(", ")}`,
    };
  }
  return { passed: true, details: "No duplicate declarations detected" };
}

/**
 * 3. Orphaned references: check if the edit removes a symbol declaration
 *    but the symbol is still referenced elsewhere in the file.
 */
function checkOrphanedReferences(
  oldContent: string,
  newContent: string,
  config: LangConfig,
  changedSymbols?: string[],
): { passed: boolean; details: string } {
  const oldDecls = countDeclarations(oldContent, config);
  const newDecls = countDeclarations(newContent, config);

  // Symbols removed by the edit
  const removedDecls: string[] = [];
  for (const [name, oldCount] of oldDecls) {
    const newCount = newDecls.get(name) ?? 0;
    if (newCount < oldCount) {
      removedDecls.push(name);
    }
  }

  if (removedDecls.length === 0) {
    return { passed: true, details: "No declarations removed" };
  }

  // For each removed symbol, check if it's still referenced in new content
  const orphans: string[] = [];
  for (const name of removedDecls) {
    if (symbolIsReferenced(newContent, name)) {
      orphans.push(name);
    }
  }

  // Constrain to changedSymbols when available
  const filteredOrphans = changedSymbols && changedSymbols.length > 0
    ? orphans.filter((s) => changedSymbols.includes(s))
    : orphans;

  if (filteredOrphans.length > 0) {
    return {
      passed: false,
      details: `Removed symbol(s) still referenced: ${filteredOrphans.join(", ")}`,
    };
  }
  return { passed: true, details: "No orphaned references detected" };
}

/**
 * 4. Import consistency: if the edit adds new API calls, check whether
 *    corresponding imports exist.
 */
function checkImportConsistency(
  oldContent: string,
  newContent: string,
  languageId: string,
  config: LangConfig,
): { passed: boolean; details: string } {
  // Only meaningful for languages with explicit import systems
  const lang = languageId.toLowerCase();
  if (!["typescript", "tsx", "javascript", "jsx", "python", "go", "rust", "java", "kotlin", "dart"].includes(lang)) {
    return { passed: true, details: "Import consistency not applicable for this language" };
  }

  const imports = extractImports(newContent, lang);
  const oldCalls = extractFunctionCalls(oldContent, lang);
  const newCalls = extractFunctionCalls(newContent, lang);

  // Find new call-like identifiers added by the edit
  const addedCalls = new Set<string>();
  for (const call of newCalls) {
    if (!oldCalls.has(call)) {
      addedCalls.add(call);
    }
  }

  if (addedCalls.size === 0) {
    return { passed: true, details: "No new API calls to verify" };
  }

  const knownGlobals = lang === "typescript" || lang === "tsx" || lang === "javascript" || lang === "jsx"
    ? KNOWN_GLOBALS_TS
    : new Set<string>();

  const missing: string[] = [];
  for (const call of addedCalls) {
    if (call.length < 2) continue; // skip single-char names (variables, loop vars)
    if (/^[A-Z][A-Z_0-9]+$/.test(call)) continue; // skip constants
    if (call === call.toLowerCase() && call.length <= 2) continue; // skip very short lowercase names (i, j, k, x, y)
    if (knownGlobals.has(call)) continue;

    // Check if this call might be a member expression (e.g., foo.bar())
    // where `call` is `bar` and the base identifier `foo` is imported.
    const memberBase = extractMemberCallBase(newContent, call);
    if (memberBase) {
      if (imports.has(memberBase) || knownGlobals.has(memberBase)) {
        continue; // covered by the base identifier's import
      }
    }

    if (!imports.has(call)) {
      missing.push(call);
    }
  }

  if (missing.length > 0) {
    return {
      passed: false,
      details: `Potential missing imports: ${missing.join(", ")}. Verify these identifiers are either imported, defined locally, or are globals.`,
    };
  }
  return { passed: true, details: "All referenced identifiers appear to have corresponding imports" };
}

/**
 * 5. Syntax sanity: detect obvious syntax errors like unclosed strings,
 *    template literals, or (for semicolon-required languages) missing
 *    semicolons on non-block statements.
 */
function checkSyntaxSanity(
  content: string,
  config: LangConfig,
): { passed: boolean; details: string } {
  const issues: string[] = [];

  // ── Unclosed string literals ──
  const unclosed = findUnclosedStrings(content);
  if (unclosed.length > 0) {
    issues.push(`Unclosed string literals: ${unclosed.join(", ")}`);
  }

  // ── Unclosed template literals (JS/TS) ──
  const backtickCount = countChar(content, "`");
  if (backtickCount % 2 !== 0) {
    issues.push("Unclosed template literal (backtick)");
  }

  // ── Missing semicolons (for languages that require them) ──
  if (config.requiresSemicolons) {
    const missing = findMissingSemicolons(content);
    if (missing > 0) {
      issues.push(`Possibly missing semicolons on ${missing} statement(s)`);
    }
  }

  if (issues.length > 0) {
    return { passed: false, details: issues.join("; ") };
  }
  return { passed: true, details: "No obvious syntax errors detected" };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Safe default returned on any error.
 */
/**
 * Detect zero-value placeholders — operations that compute to 0.
 * 9/10 times, `return 0` or `= 0` in new/changed code is a stub placeholder.
 *
 * Checks:
 *  - New `return 0` statements where old code returned non-zero
 *  - New `= 0` assignments where old code had non-zero value
 *  - Functions that now return 0 but previously returned something else
 */
function checkZeroValuePlaceholders(
  oldContent: string,
  newContent: string,
  _config: LangConfig,
): { passed: boolean; details: string } {
  if (!oldContent) {
    return { passed: true, details: "No old content to compare" };
  }

  const issues: string[] = [];

  // Extract return statements: "return <value>"
  // Matches: return 0xFF, return -1, return 0, return 42
  // Hex must come first in alternation to avoid \d+ matching the leading 0
  const returnRe = /\breturn\s+(0x[0-9a-fA-F]+|-?\d+)\s*;?/g;
  const anyReturnRe = /\breturn\b/g;
  const oldReturns = new Map<string, number>();
  let m: RegExpExecArray | null;
  let oldHasAnyReturn = false;
  while ((m = returnRe.exec(oldContent)) !== null) {
    const val = m[1];
    oldReturns.set(val, (oldReturns.get(val) ?? 0) + 1);
  }
  anyReturnRe.lastIndex = 0;
  oldHasAnyReturn = anyReturnRe.test(oldContent);

  const newReturns = new Map<string, number>();
  returnRe.lastIndex = 0;
  while ((m = returnRe.exec(newContent)) !== null) {
    const val = m[1];
    newReturns.set(val, (newReturns.get(val) ?? 0) + 1);
  }

  // Check for new return 0 where old had non-zero returns.
  // Also triggers if old had expression returns (e.g., "return a + b") —
  // stubbing an expression-returning function to return 0 is a placeholder.
  const oldHadNonZero = [...oldReturns.keys()].some(k => k !== "0" && k !== "0x0");
  const oldHadExpressionReturns = oldReturns.size === 0 && oldHasAnyReturn;
  const newReturnZeroCount = newReturns.get("0") ?? 0;
  const oldReturnZeroCount = oldReturns.get("0") ?? 0;
  const deltaReturnZero = newReturnZeroCount - oldReturnZeroCount;

  if (deltaReturnZero > 0 && (oldHadNonZero || oldHadExpressionReturns)) {
    const reason = oldHadExpressionReturns
      ? "old code had expression returns"
      : "old code returned non-zero";
    issues.push(
      `${deltaReturnZero} new return 0 statement(s) where ${reason} — likely placeholder`,
    );
  }

  // Check for new = 0 assignments where old had non-zero
  const assignRe = /\b(\w+)\s*=\s*(-?\d+)\s*;?/g;
  const oldAssigns = new Map<string, string>();
  while ((m = assignRe.exec(oldContent)) !== null) {
    oldAssigns.set(m[1], m[2]);
  }

  assignRe.lastIndex = 0;
  while ((m = assignRe.exec(newContent)) !== null) {
    const varName = m[1];
    const newVal = m[2];
    const oldVal = oldAssigns.get(varName);
    if (newVal === "0" && oldVal !== undefined && oldVal !== "0") {
      issues.push(
        `Variable "${varName}" changed from ${oldVal} to 0 — likely placeholder`,
      );
    }
  }

  if (issues.length > 0) {
    return { passed: false, details: issues.join("; ") };
  }

  return { passed: true, details: "No zero-value placeholders detected" };
}

function safePass(): PatchCorrectnessResult {
  return {
    passed: true,
    warnings: [],
    checks: {
      unbalancedDelimiters: { passed: true, details: "Check skipped due to error" },
      duplicateDeclarations: { passed: true, details: "Check skipped due to error" },
      orphanedReferences: { passed: true, details: "Check skipped due to error" },
      importConsistency: { passed: true, details: "Check skipped due to error" },
      syntaxSanity: { passed: true, details: "Check skipped due to error" },
      zeroValuePlaceholders: { passed: true, details: "Check skipped due to error" },
    },
  };
}

/**
 * Count occurrences of a character in a string (O(n) single-pass).
 */
function countChar(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) count++;
  }
  return count;
}

/**
 * Count occurrences of a word bounded by non-word characters (O(n)).
 */
function countWord(s: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word boundary: the word must be preceded/followed by non-word chars or string edges
  const re = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "g");
  const matches = s.match(re);
  return matches ? matches.length : 0;
}

/**
 * Extract declared symbol names from content using language-specific patterns.
 */
function countDeclarations(content: string, config: LangConfig): Map<string, number> {
  const counts = new Map<string, number>();

  for (const rawPattern of config.declarationPatterns) {
    const re = new RegExp(rawPattern, "gm");
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const name = match[1];
      if (name && /^\w+$/.test(name) && name.length > 0) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }

  return counts;
}

/**
 * Check whether a symbol name appears in a non-declaration context
 * (simple heuristic: not preceded by function/class/const/let/var/type).
 */
function symbolIsReferenced(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match: identifier-name followed by ( or . or , or ; or = or whitespace
  // but NOT preceded by function/class/const/let/var/type/interface
  const re = new RegExp(
    `(?<!\\bfunction\\s)(?<!\\bconst\\s)(?<!\\blet\\s)(?<!\\bvar\\s)(?<!\\bclass\\s)(?<!\\binterface\\s)(?<!\\btype\\s)(?<!\\benum\\s)(?<!\\bdef\\s)(?<!\\bfn\\s)\\b${escaped}\\b(?=\\s*[\\(\\[\\.,;:=)}\\]])`,
    "g",
  );
  return re.test(content);
}

/**
 * Extract import identifiers from content.
 * Returns a set of imported names (the local binding name).
 */
function extractImports(content: string, languageId: string): Set<string> {
  const imports = new Set<string>();

  switch (languageId) {
    case "typescript":
    case "tsx":
    case "javascript":
    case "jsx": {
      // import foo from 'bar' → foo
      let re = /import\s+(\w+)\s+from\s+/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        imports.add(match[1]);
      }

      // import { foo, bar as baz } from → foo, baz
      re = /import\s*\{\s*([^}]+)\s*\}\s*from\s+/g;
      while ((match = re.exec(content)) !== null) {
        const names = match[1].split(",");
        for (const n of names) {
          const trimmed = n.trim();
          // Handle "foo as bar" → bar is the local name
          const parts = trimmed.split(/\s+as\s+/i);
          imports.add(parts[parts.length - 1].trim());
        }
      }

      // import * as foo from → foo
      re = /import\s*\*\s*as\s+(\w+)\s+from\s+/g;
      while ((match = re.exec(content)) !== null) {
        imports.add(match[1]);
      }

      // const foo = require('bar') → foo
      re = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(/g;
      while ((match = re.exec(content)) !== null) {
        imports.add(match[1]);
      }

      // import('bar') → no local binding — skip
      break;
    }
    case "python": {
      // import foo → foo
      let re = /^import\s+(\w+)/gm;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        imports.add(match[1]);
      }

      // from foo import bar, baz → bar, baz
      re = /from\s+\S+\s+import\s+([^#\n]+)/gm;
      while ((match = re.exec(content)) !== null) {
        const names = match[1].split(",");
        for (const n of names) {
          const trimmed = n.trim().split(/\s+as\s+/);
          imports.add(trimmed[trimmed.length - 1].trim());
        }
      }

      // import foo.bar.baz → just "foo" (module prefix)
      re = /^import\s+(\w+)(?:\.\w+)*/gm;
      while ((match = re.exec(content)) !== null) {
        imports.add(match[1]);
      }
      break;
    }
    case "go": {
      // import "foo" — no local name (package name used)
      // import foo "bar" → foo
      const re = /import\s+(\w+)\s+"/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        imports.add(match[1]);
      }
      break;
    }
    case "rust": {
      // use foo::bar::baz → baz
      // use foo::bar as baz → baz
      const re = /\buse\s+(?:\S+::)*(\w+)\s*(?:as\s+(\w+))?/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        imports.add(match[2] || match[1]);
      }
      break;
    }
    case "java":
    case "kotlin": {
      // import foo.bar.Baz → Baz
      const re = /\bimport\s+(?:\w+\.)+(\w+)\s*;/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        imports.add(match[1]);
      }
      break;
    }
    case "dart": {
      // import 'package:foo/bar.dart' → no local name
      // import 'foo.dart' as bar → bar
      const re = /\bimport\s+['\"].*?['\"]\s*(?:as\s+(\w+))?/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        if (match[1]) imports.add(match[1]);
      }
      break;
    }
  }

  return imports;
}

/**
 * Extract function-call-like identifiers from content.
 * Returns a set of names that appear to be called as functions/constructors.
 */
function extractFunctionCalls(content: string, _languageId: string): Set<string> {
  const calls = new Set<string>();

  // Match: identifier( — a function or constructor call
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    // Skip language keywords that can be followed by (
    if (/^(if|while|for|switch|catch|return|yield|typeof|instanceof|void|delete|import|export|throw)\b/.test(name)) {
      continue;
    }
    calls.add(name);
  }

  return calls;
}

/**
 * Extract the base identifier of a member expression call.
 * For content like `fs.readFileSync('x')` with callName `readFileSync`,
 * returns `"fs"`. Returns null if the call is not a member expression.
 */
function extractMemberCallBase(content: string, callName: string): string | null {
  const escaped = callName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(\\w+)\\.${escaped}\\s*\\(`, "g");
  const match = re.exec(content);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * Find unclosed string literals. Returns list of string types that appear
 * unclosed (single-quote, double-quote).
 *
 * Handles escaped quotes and multi-line strings. Uses a simple single-pass
 * state machine.
 */
function findUnclosedStrings(content: string): string[] {
  const unclosed: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < content.length) {
    const ch = content[i];
    const prev = i > 0 ? content[i - 1] : "";

    // Skip escaped characters
    if (prev === "\\" && (ch === "'" || ch === '"' || ch === "\\")) {
      i++;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    }

    i++;
  }

  if (inSingle) unclosed.push("single-quoted (')");
  if (inDouble) unclosed.push("double-quoted (\")");

  return unclosed;
}

/**
 * Count statements that may be missing semicolons.
 * Uses a rough heuristic: non-empty, non-comment lines that end with
 * a statement-ending character or identifier but not a semicolon,
 * brace, or other non-semicolon-requiring token.
 *
 * Returns an approximate count of potentially missing semicolons.
 * Will not flag: for/while/if/switch/function/class declarations,
 * blocks, comments, blank lines.
 */
function findMissingSemicolons(content: string): number {
  const lines = content.split("\n");
  let count = 0;

  const BLOCK_END_RE = /[{};]$/;
  const DECL_KEYWORD_RE = /\b(if|for|while|switch|catch|function|class|else|try|finally|do)\s*[({:]?\s*$/;
  const COMMENT_OR_BLANK_RE = /^\s*(\/\/|#|\/\*|\*|$)/;
  const OPEN_BLOCK_RE = /\{\s*$/;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip blank lines, comments, and lines ending with block markers
    if (COMMENT_OR_BLANK_RE.test(trimmed)) continue;
    if (BLOCK_END_RE.test(trimmed)) continue;
    if (DECL_KEYWORD_RE.test(trimmed)) continue;
    if (OPEN_BLOCK_RE.test(trimmed)) continue;
    if (trimmed.endsWith(",") || trimmed.endsWith(":")) continue;

    // If the line has a statement-looking pattern (assignment, return, call, expression)
    // and doesn't end with a semicolon, it might be missing one.
    const STATEMENT_RE = /\b(?:return|throw|break|continue|yield)\b/;
    const ASSIGNMENT_RE = /\w\s*=/;
    const EXPRESSION_CALL_RE = /\w+\s*\(/;

    if (
      (STATEMENT_RE.test(trimmed) || ASSIGNMENT_RE.test(trimmed) || EXPRESSION_CALL_RE.test(trimmed)) &&
      !trimmed.endsWith(";")
    ) {
      count++;
    }
  }

  return count;
}
