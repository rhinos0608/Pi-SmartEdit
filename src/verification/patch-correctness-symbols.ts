/**
 * Declaration / reference / import checks for patch correctness.
 *
 * Owns declaration counting, reference heuristics, import extraction,
 * call extraction, and the three checks built on them.
 */
import { KNOWN_GLOBALS_TS } from "./patch-correctness-config.js";
import type { LangConfig } from "./patch-correctness-config.js";
import type { PatchCheck } from "./patch-correctness-lexical.js";

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
export function checkOrphanedReferences(
  oldContent: string,
  newContent: string,
  config: LangConfig,
  changedSymbols?: string[],
): PatchCheck {
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
export function checkImportConsistency(
  oldContent: string,
  newContent: string,
  languageId: string,
  config: LangConfig,
): PatchCheck {
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
  const declared = countDeclarations(newContent, config);

  const missing: string[] = [];
  for (const call of addedCalls) {
    if (call.length < 2) continue; // skip single-char names (variables, loop vars)
    if (/^[A-Z][A-Z_0-9]+$/.test(call)) continue; // skip constants
    if (call === call.toLowerCase() && call.length <= 2) continue; // skip very short lowercase names (i, j, k, x, y)
    if (knownGlobals.has(call)) continue;
    if (declared.has(call)) continue; // defined locally — not a missing import

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
 * Extract declared symbol names from content using language-specific patterns.
 */
export function countDeclarations(content: string, config: LangConfig): Map<string, number> {
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

/**
 * Extract import identifiers from content.
 * Returns a set of imported names (the local binding name).
 */
export function extractImports(content: string, languageId: string): Set<string> {
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
      const re = /\bimport\s+['"].*?['"]\s*(?:as\s+(\w+))?/g;
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
export function extractFunctionCalls(content: string, _languageId: string): Set<string> {
  void _languageId;
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
export function extractMemberCallBase(content: string, callName: string): string | null {
  const escaped = callName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(\\w+)\\.${escaped}\\s*\\(`, "g");
  const match = re.exec(content);
  if (match) {
    return match[1];
  }
  return null;
}
