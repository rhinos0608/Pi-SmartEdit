/**
 * Declaration / reference / import checks for patch correctness.
 *
 * Owns declaration counting, reference heuristics, import extraction,
 * call extraction, and the three checks built on them.
 */
import { KNOWN_GLOBALS_TS } from "./patch-correctness-config.js";
import type { LangConfig } from "./patch-correctness-config.js";
import type { PatchCheck } from "./patch-correctness-lexical.js";

/** Names whose declaration count grew between old and new content. */
function findIncreasedDeclarationNames(
  oldDecls: Map<string, number>,
  newDecls: Map<string, number>,
): Set<string> {
  const added = new Set<string>();
  for (const [name, newCount] of newDecls) {
    if (newCount > (oldDecls.get(name) ?? 0)) {
      added.add(name);
    }
  }
  return added;
}

/** Constrain candidate names to changedSymbols when provided. */
function constrainToChangedSymbols(names: Iterable<string>, changedSymbols?: string[]): string[] {
  const list = [...names];
  if (changedSymbols && changedSymbols.length > 0) {
    return list.filter((s) => changedSymbols.includes(s));
  }
  return list;
}

/** Of the candidates, keep names that already existed before the edit. */
function findPreExistingDuplicates(
  oldDecls: Map<string, number>,
  newDecls: Map<string, number>,
  candidates: string[],
): string[] {
  const duplicates: string[] = [];
  for (const name of candidates) {
    const oldCount = oldDecls.get(name) ?? 0;
    if (oldCount > 0 && (newDecls.get(name) ?? 0) > oldCount) {
      duplicates.push(name);
    }
  }
  return duplicates;
}

/**
 * 2. Duplicate declarations: check if the edit introduces a symbol name
 *    that already exists in the file.
 */
export function checkDuplicateDeclarations(
  oldContent: string,
  newContent: string,
  config: LangConfig,
  changedSymbols?: string[],
): PatchCheck {
  const oldDecls = countDeclarations(oldContent, config);
  const newDecls = countDeclarations(newContent, config);

  // Names whose declaration count increased (potential duplicates)
  const addedDecls = findIncreasedDeclarationNames(oldDecls, newDecls);

  if (addedDecls.size === 0) {
    return { passed: true, details: "No new declarations introduced" };
  }

  // Constrain to changedSymbols when available
  const candidates = constrainToChangedSymbols(addedDecls, changedSymbols);

  // For each name whose declaration count increased, check if it
  // already existed in old content (potential duplicate).
  const duplicates = findPreExistingDuplicates(oldDecls, newDecls, candidates);

  if (duplicates.length > 0) {
    return {
      passed: false,
      details: `New declarations may duplicate existing ones: ${duplicates.join(", ")}`,
    };
  }
  return { passed: true, details: "No duplicate declarations detected" };
}

/** Symbols whose declaration count shrank between old and new content. */
function findRemovedDeclarationNames(
  oldDecls: Map<string, number>,
  newDecls: Map<string, number>,
): string[] {
  const removed: string[] = [];
  for (const [name, oldCount] of oldDecls) {
    if ((newDecls.get(name) ?? 0) < oldCount) {
      removed.push(name);
    }
  }
  return removed;
}

/** Keep names still referenced in the given content. */
function findStillReferenced(names: string[], content: string): string[] {
  const orphans: string[] = [];
  for (const name of names) {
    if (symbolIsReferenced(content, name)) {
      orphans.push(name);
    }
  }
  return orphans;
}

/**
 * 3. Orphaned references: check if the edit removes a symbol declaration
 *    but the symbol is still referenced elsewhere in the file.
 */
export function checkOrphanedReferences(
  oldContent: string,
  newContent: string,
  config: LangConfig,
  changedSymbols?: string[],
): PatchCheck {
  const oldDecls = countDeclarations(oldContent, config);
  const newDecls = countDeclarations(newContent, config);

  // Symbols removed by the edit
  const removedDecls = findRemovedDeclarationNames(oldDecls, newDecls);

  if (removedDecls.length === 0) {
    return { passed: true, details: "No declarations removed" };
  }

  // For each removed symbol, check if it's still referenced in new content
  const orphans = findStillReferenced(removedDecls, newContent);

  // Constrain to changedSymbols when available
  const filteredOrphans = constrainToChangedSymbols(orphans, changedSymbols);

  if (filteredOrphans.length > 0) {
    return {
      passed: false,
      details: `Removed symbol(s) still referenced: ${filteredOrphans.join(", ")}`,
    };
  }
  return { passed: true, details: "No orphaned references detected" };
}

const IMPORT_CHECKABLE_LANGUAGES = new Set([
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "dart",
]);

function isImportCheckableLanguage(languageId: string): boolean {
  return IMPORT_CHECKABLE_LANGUAGES.has(languageId.toLowerCase());
}

function isTsLike(languageId: string): boolean {
  return (
    languageId === "typescript" ||
    languageId === "tsx" ||
    languageId === "javascript" ||
    languageId === "jsx"
  );
}

/** Call-like identifiers present in newCalls but absent from oldCalls. */
function findAddedCalls(oldCalls: Set<string>, newCalls: Set<string>): Set<string> {
  const added = new Set<string>();
  for (const call of newCalls) {
    if (!oldCalls.has(call)) {
      added.add(call);
    }
  }
  return added;
}

function resolveKnownGlobals(lang: string): Set<string> {
  return isTsLike(lang) ? KNOWN_GLOBALS_TS : new Set<string>();
}

const RUNTIME_DECLARATION_PATTERNS = [
  /\bfunction\s+(\w+)\b/g,
  /\b(?:const|let|var)\s+(\w+)\s*[:=]/g,
  /\bclass\s+(\w+)\b/g,
  /\benum\s+(\w+)\b/g,
  /\bexport\s+(?:default\s+)?(?:function|class|const|let|var|enum)\s+(\w+)\b/g,
];

function collectTypeOnlyNames(content: string): Set<string> {
  const typeNames = new Set<string>();
  for (const m of content.matchAll(/\b(?:interface|type)\s+(\w+)\b/g)) {
    if (m[1]) typeNames.add(m[1]);
  }
  return typeNames;
}

function collectRuntimeBindingNames(content: string): Set<string> {
  const runtimeNames = new Set<string>();
  for (const pattern of RUNTIME_DECLARATION_PATTERNS) {
    for (const m of content.matchAll(new RegExp(pattern.source, pattern.flags))) {
      if (m[1]) runtimeNames.add(m[1]);
    }
  }
  return runtimeNames;
}

// Type-only bindings are not runtime callables: `interface Foo` / `type Foo`
// must not suppress a missing import for a new `Foo()` call. Drop them
// unless the same name also has a runtime binding (function/const/class…).
function stripTypeOnlyDeclarations(
  declared: Map<string, number>,
  content: string,
  lang: string,
): void {
  if (lang !== "typescript" && lang !== "tsx") {
    return;
  }
  const typeNames = collectTypeOnlyNames(content);
  if (typeNames.size === 0) {
    return;
  }
  const runtimeNames = collectRuntimeBindingNames(content);
  for (const name of typeNames) {
    if (!runtimeNames.has(name)) declared.delete(name);
  }
}

function isSkippableCallName(
  call: string,
  knownGlobals: Set<string>,
  declared: Map<string, number>,
): boolean {
  if (call.length < 2) return true; // skip single-char names (variables, loop vars)
  if (/^[A-Z][A-Z_0-9]+$/.test(call)) return true; // skip constants
  if (call === call.toLowerCase() && call.length <= 2) return true; // skip very short lowercase names (i, j, k, x, y)
  if (knownGlobals.has(call)) return true;
  if (declared.has(call)) return true; // defined locally — not a missing import
  return false;
}

// Check if this call might be a member expression (e.g., foo.bar())
// where `call` is `bar` and the base identifier `foo` is imported.
function isCoveredByMemberBaseImport(
  content: string,
  call: string,
  imports: Set<string>,
  knownGlobals: Set<string>,
): boolean {
  const memberBase = extractMemberCallBase(content, call);
  if (!memberBase) {
    return false;
  }
  return imports.has(memberBase) || knownGlobals.has(memberBase);
}

interface MissingImportContext {
  content: string;
  addedCalls: Set<string>;
  imports: Set<string>;
  knownGlobals: Set<string>;
  declared: Map<string, number>;
}

function findMissingImports(ctx: MissingImportContext): string[] {
  const missing: string[] = [];
  for (const call of ctx.addedCalls) {
    if (isSkippableCallName(call, ctx.knownGlobals, ctx.declared)) continue;
    if (isCoveredByMemberBaseImport(ctx.content, call, ctx.imports, ctx.knownGlobals)) {
      continue; // covered by the base identifier's import
    }
    if (!ctx.imports.has(call)) {
      missing.push(call);
    }
  }
  return missing;
}

/**
 * 4. Import consistency: if the edit adds new API calls, check whether
 *    corresponding imports exist.
 */
export function checkImportConsistency(
  oldContent: string,
  newContent: string,
  languageId: string,
  config: LangConfig,
): PatchCheck {
  // Only meaningful for languages with explicit import systems
  const lang = languageId.toLowerCase();
  if (!isImportCheckableLanguage(languageId)) {
    return { passed: true, details: "Import consistency not applicable for this language" };
  }

  const imports = extractImports(newContent, lang);
  const oldCalls = extractFunctionCalls(oldContent, lang);
  const newCalls = extractFunctionCalls(newContent, lang);

  // Find new call-like identifiers added by the edit
  const addedCalls = findAddedCalls(oldCalls, newCalls);

  if (addedCalls.size === 0) {
    return { passed: true, details: "No new API calls to verify" };
  }

  const knownGlobals = resolveKnownGlobals(lang);
  const declared = countDeclarations(newContent, config);
  stripTypeOnlyDeclarations(declared, newContent, lang);

  const missing = findMissingImports({
    content: newContent,
    addedCalls,
    imports,
    knownGlobals,
    declared,
  });

  if (missing.length > 0) {
    return {
      passed: false,
      details: `Potential missing imports: ${missing.join(", ")}. Verify these identifiers are either imported, defined locally, or are globals.`,
    };
  }
  return { passed: true, details: "All referenced identifiers appear to have corresponding imports" };
}

/** A regex match is a countable declaration name. */
function extractDeclarationName(match: RegExpExecArray): string | null {
  const name = match[1];
  if (name && /^\w+$/.test(name) && name.length > 0) {
    return name;
  }
  return null;
}

/**
 * Extract declared symbol names from content using language-specific patterns.
 */
export function countDeclarations(content: string, config: LangConfig): Map<string, number> {
  const counts = new Map<string, number>();

  for (const rawPattern of config.declarationPatterns) {
    const re = new RegExp(rawPattern, "gm");
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const name = extractDeclarationName(match);
      if (name) {
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
export function symbolIsReferenced(content: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match: identifier-name followed by ( or . or , or ; or = or whitespace
  // but NOT preceded by function/class/const/let/var/type/interface
  const re = new RegExp(
    `(?<!\\bfunction\\s)(?<!\\bconst\\s)(?<!\\blet\\s)(?<!\\bvar\\s)(?<!\\bclass\\s)(?<!\\binterface\\s)(?<!\\btype\\s)(?<!\\benum\\s)(?<!\\bdef\\s)(?<!\\bfn\\s)\\b${escaped}\\b(?=\\s*[\\(\\[\\.,;:=)}\\]])`,
    "g",
  );
  return re.test(content);
}

/** Run a global regex over content, collecting one binding per match. */
function collectImportMatches(
  content: string,
  pattern: RegExp,
  pick: (match: RegExpExecArray) => string | undefined,
  imports: Set<string>,
): void {
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const name = pick(match);
    if (name) imports.add(name);
  }
}

/** Split a `{ a, b as c }`-style list into local binding names. */
function addBraceImportList(rawList: string | undefined, imports: Set<string>): void {
  if (!rawList) return;
  for (const n of rawList.split(",")) {
    const trimmed = n.trim();
    if (!trimmed) continue;
    // Handle "foo as bar" → bar is the local name
    const parts = trimmed.split(/\s+as\s+/i);
    imports.add(parts[parts.length - 1].trim());
  }
}

function extractJsImports(content: string, imports: Set<string>): void {
  // import foo from 'bar' → foo
  collectImportMatches(content, /import\s+(\w+)\s+from\s+/g, (m) => m[1], imports);

  // import { foo, bar as baz } from → foo, baz
  collectImportMatches(
    content,
    /import\s*\{\s*([^}]+)\s*\}\s*from\s+/g,
    (m) => {
      addBraceImportList(m[1], imports);
      return undefined;
    },
    imports,
  );

  // import * as foo from → foo
  collectImportMatches(content, /import\s*\*\s*as\s+(\w+)\s+from\s+/g, (m) => m[1], imports);

  // const foo = require('bar') → foo
  collectImportMatches(
    content,
    /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(/g,
    (m) => m[1],
    imports,
  );

  // import('bar') → no local binding — skip
}

function extractPythonImports(content: string, imports: Set<string>): void {
  // import foo → foo
  collectImportMatches(content, /^import\s+(\w+)/gm, (m) => m[1], imports);

  // from foo import bar, baz → bar, baz
  collectImportMatches(
    content,
    /from\s+\S+\s+import\s+([^#\n]+)/gm,
    (m) => {
      addBraceImportList(m[1], imports);
      return undefined;
    },
    imports,
  );

  // import foo.bar.baz → just "foo" (module prefix)
  collectImportMatches(content, /^import\s+(\w+)(?:\.\w+)*/gm, (m) => m[1], imports);
}

function extractGoImports(content: string, imports: Set<string>): void {
  // import "foo" — no local name (package name used)
  // import foo "bar" → foo
  collectImportMatches(content, /import\s+(\w+)\s+"/g, (m) => m[1], imports);
}

function extractRustImports(content: string, imports: Set<string>): void {
  // use foo::bar::baz → baz
  // use foo::bar as baz → baz
  collectImportMatches(
    content,
    /\buse\s+(?:\S+::)*(\w+)\s*(?:as\s+(\w+))?/g,
    (m) => m[2] || m[1],
    imports,
  );
}

function extractJavaImports(content: string, imports: Set<string>): void {
  // import foo.bar.Baz → Baz
  collectImportMatches(content, /\bimport\s+(?:\w+\.)+(\w+)\s*;/g, (m) => m[1], imports);
}

function extractDartImports(content: string, imports: Set<string>): void {
  // import 'package:foo/bar.dart' → no local name
  // import 'foo.dart' as bar → bar
  collectImportMatches(
    content,
    /\bimport\s+['"].*?['"]\s*(?:as\s+(\w+))?/g,
    (m) => m[1],
    imports,
  );
}

type ImportExtractor = (content: string, imports: Set<string>) => void;

const IMPORT_EXTRACTORS: Record<string, ImportExtractor> = {
  typescript: extractJsImports,
  tsx: extractJsImports,
  javascript: extractJsImports,
  jsx: extractJsImports,
  python: extractPythonImports,
  go: extractGoImports,
  rust: extractRustImports,
  java: extractJavaImports,
  kotlin: extractJavaImports,
  dart: extractDartImports,
};

/**
 * Extract import identifiers from content.
 * Returns a set of imported names (the local binding name).
 */
export function extractImports(content: string, languageId: string): Set<string> {
  const imports = new Set<string>();
  IMPORT_EXTRACTORS[languageId]?.(content, imports);
  return imports;
}

/** Keywords that can precede `(` but are not function calls. */
const NON_CALL_KEYWORDS = /^(if|while|for|switch|catch|return|yield|typeof|instanceof|void|delete|import|export|throw)\b/;

/**
 * Extract function-call-like identifiers from content.
 * Returns a set of names that appear to be called as functions/constructors.
 */
export function extractFunctionCalls(content: string, _languageId: string): Set<string> {
  void _languageId;
  const calls = new Set<string>();

  // Match: identifier( — a function or constructor call
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    // Skip language keywords that can be followed by (
    if (NON_CALL_KEYWORDS.test(name)) {
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
export function extractMemberCallBase(content: string, callName: string): string | null {
  const escaped = callName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(\\w+)\\.${escaped}\\s*\\(`, "g");
  const match = re.exec(content);
  if (match) {
    return match[1];
  }
  return null;
}
