/**
 * Lightweight approval gating for SmartEdit.
 *
 * Checks file paths, edit content, and line ranges against
 * dangerous patterns to surface warnings. Never blocks edits —
 * all checks emit warnings as matchNotes.
 *
 * Approval level is controlled by the SMART_EDIT_APPROVAL_LEVEL
 * environment variable (never_prompt | prompt_on_dangerous | prompt_always).
 */

import type { EditItem } from "../../lib/types";
import { resolve } from "path";
import { realpath } from "fs/promises";

// ─── Types ─────────────────────────────────────────────────────────────

export type ApprovalLevel = "never_prompt" | "prompt_on_dangerous" | "prompt_always";

export interface ApprovalConfig {
  /** Approval level controlling when checks are active */
  level: ApprovalLevel;
  /** Glob-style patterns for dangerous file paths */
  dangerousPathPatterns: readonly string[];
  /** Regex patterns to search for in edit oldText/newText */
  dangerousSymbolPatterns: ReadonlyArray<{ name: string; regex: RegExp }>;
  /** First N lines of entry-point files are considered critical */
  criticalLineRange: number;
}

export interface SafetyCheckResult {
  /** True when no dangerous patterns were matched */
  safe: boolean;
  /** Human-readable warning messages */
  warnings: string[];
  /** Effective approval level used */
  level: ApprovalLevel;
}

// ─── Environment ───────────────────────────────────────────────────────

const APPROVAL_LEVEL_ENV_VAR = "SMART_EDIT_APPROVAL_LEVEL";

const VALID_LEVELS = new Set<ApprovalLevel>([
  "never_prompt",
  "prompt_on_dangerous",
  "prompt_always",
]);

function readApprovalLevelFromEnv(): ApprovalLevel {
  const raw = process.env[APPROVAL_LEVEL_ENV_VAR];
  if (!raw) return "never_prompt";
  const trimmed = raw.trim().toLowerCase() as ApprovalLevel;
  if (VALID_LEVELS.has(trimmed)) return trimmed;
  return "never_prompt";
}

// ─── Default patterns ──────────────────────────────────────────────────

/**
 * Glob-style patterns for file paths that are considered dangerous to edit.
 * Supports ** for recursive matching and * for single-segment wildcard.
 * Note: config* matches any path containing "config".
 */
export const DANGEROUS_PATH_PATTERNS: readonly string[] = [
  "**/main.ts",
  "**/main.js",
  "**/index.ts",
  "**/index.js",
  "**/config*",
  "**/*config*",
  "**/.env.*",
  "**/.env*",
  "**/__init__*",
  "**/Dockerfile*",
  "**/ci/**",
  "**/.github/**",
  "**/.gitlab-ci.yml",
  // More specific infra patterns before generic YAML
  "**/k8s/**",
  "**/kubernetes/**",
  "**/terraform/**",
  "**/tf/**",
  "**/*.yaml",
  "**/*.yml",
];

/**
 * Named regex patterns for dangerous symbols / code patterns in edit content.
 * Each entry has a human-readable name and the regex to match.
 */
export const DANGEROUS_SYMBOL_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "main() function", regex: /function\s+main\s*\(/ },
  { name: "init() function", regex: /function\s+init\s*\(/ },
  { name: "constructor method", regex: /constructor\s*\([^)]*\)\s*\{/ },
  { name: "process.env access", regex: /\bprocess\.env\b/ },
  { name: "Python __init__", regex: /def\s+__init__\s*\(/ },
  { name: "child_process require", regex: /require\(\s*['"]child_process['"]\s*\)/ },
  { name: "child_process import", regex: /import\s+.*\bfrom\s+['"]child_process['"]/ },
  { name: "fs.writeFile", regex: /\bfs\.writeFile\b/ },
  { name: "fs.appendFile", regex: /\bfs\.appendFile\b/ },
  { name: "fs promises write", regex: /\bfsPromises\.writeFile\b/ },
  { name: "server .listen()", regex: /\.listen\s*\(/ },
  { name: "route handler", regex: /(?:\b(?:app|router)\.|\.(?:app|router)\.)(?:get|post|put|delete|patch|use)\s*\(/ },
];

/** Pre-compiled regexes from DANGEROUS_PATH_PATTERNS for fast matching. */
const DANGEROUS_PATH_REGEXES: RegExp[] = DANGEROUS_PATH_PATTERNS.map(globToRegex);

// ─── Glob matching ─────────────────────────────────────────────────────

/**
 * Simple glob pattern to regex conversion.
 * Supports:
 *   **  — matches everything (including path separators)
 *   *   — matches within a single path segment
 *   ?   — matches a single character
 * All other characters are regex-escaped.
 *
 * Patterns are anchored to match the full file path.
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = "^";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*" && i + 1 < pattern.length && pattern[i + 1] === "*") {
      // ** — match everything
      if (i + 2 < pattern.length && pattern[i + 2] === "/") {
        // **/ — optional directory prefix
        regexStr += "(?:.+/)?";
        i += 3;
      } else if (i > 0 && i + 2 === pattern.length) {
        // trailing **
        regexStr += ".*";
        i += 2;
      } else {
        regexStr += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      // * — match within a path segment (no /)
      regexStr += "[^/]*";
      i++;
    } else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    } else if (ch === ".") {
      regexStr += "\\.";
      i++;
    } else {
      // Escape regex special characters
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }

  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Check if a file path matches any of the dangerous patterns.
 * Normalizes the path using path.resolve() before matching.
 */
export async function matchesDangerousPath(
  filePath: string,
  patterns: readonly string[] = DANGEROUS_PATH_PATTERNS,
  regexes: readonly RegExp[] = DANGEROUS_PATH_REGEXES,
): Promise<string | null> {
  const normalizedPath = resolve(filePath);
  const effectiveRegexes = patterns === DANGEROUS_PATH_PATTERNS ? regexes : patterns.map(globToRegex);
  for (let i = 0; i < effectiveRegexes.length; i++) {
    if (effectiveRegexes[i].test(normalizedPath)) {
      return patterns[i];
    }
  }
  return null;
}

// ─── Content scanning ──────────────────────────────────────────────────

interface SymbolMatch {
  name: string;
  editIndex: number;
}

/**
 * Scan all edits for dangerous symbol patterns.
 * Deduplicates so the same pattern across multiple edits is reported once.
 */
function scanEditsForDangerousSymbols(
  edits: readonly EditItem[],
  patterns: ReadonlyArray<{ name: string; regex: RegExp }> = DANGEROUS_SYMBOL_PATTERNS,
): SymbolMatch[] {
  const seen = new Set<string>();
  const results: SymbolMatch[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const textsToCheck: string[] = [];

    if (edit.oldText) textsToCheck.push(edit.oldText);
    if (edit.newText) textsToCheck.push(edit.newText);
    if ((edit as any).replaceBody) textsToCheck.push((edit as any).replaceBody);
    if ((edit as any).insertBefore) textsToCheck.push((edit as any).insertBefore);
    if ((edit as any).insertAfter) textsToCheck.push((edit as any).insertAfter);

    for (const text of textsToCheck) {
      for (const pattern of patterns) {
        if (seen.has(pattern.name)) continue; // already reported
        if (pattern.regex.test(text)) {
          seen.add(pattern.name);
          results.push({ name: pattern.name, editIndex: i });
          if (seen.size === patterns.length) return results;
        }
      }
    }
  }

  return results;
}

// ─── Default config ────────────────────────────────────────────────────

function defaultConfig(): ApprovalConfig {
  return {
    level: readApprovalLevelFromEnv(),
    dangerousPathPatterns: DANGEROUS_PATH_PATTERNS,
    dangerousSymbolPatterns: DANGEROUS_SYMBOL_PATTERNS,
    criticalLineRange: 30,
  };
}

// ─── Main entry point ──────────────────────────────────────────────────

/**
 * Check edit safety for a given file path and edit items.
 *
 * Three levels of checking:
 *   1. File path against dangerous path patterns
 *   2. Edit content against dangerous symbol patterns
 *   3. Edit span within critical first-N lines of entry points (optional)
 *
 * Returns a SafetyCheckResult with warnings (never throws for danger).
 */
export async function checkEditSafety(
  filePath: string,
  edits: readonly EditItem[],
  config?: Partial<ApprovalConfig>,
): Promise<SafetyCheckResult> {
  const cfg: ApprovalConfig = { ...defaultConfig(), ...config };

  if (cfg.level === "never_prompt") {
    return { safe: true, warnings: [], level: cfg.level };
  }

  const warnings: string[] = [];

  // ── 1. Check file path against dangerous patterns ─────────────
  // Resolve symlinks and normalize path before checking
  let resolvedPath = filePath;
  try {
    resolvedPath = await realpath(filePath);
  } catch {
    // Fall back to resolved path if realpath fails
    resolvedPath = resolve(filePath);
  }
  const matchedPath = await matchesDangerousPath(resolvedPath, cfg.dangerousPathPatterns);
  if (matchedPath) {
    warnings.push(
      `⚠️ Danger: editing "${filePath}" matches dangerous path pattern "${matchedPath}". ` +
      `Review this change carefully before proceeding.`,
    );
  }

  // ── 2. Check edit content against dangerous symbol patterns ───
  const symbolMatches = scanEditsForDangerousSymbols(edits, cfg.dangerousSymbolPatterns);
  if (symbolMatches.length > 0) {
    const patternsList = symbolMatches.map((m) => m.name).join(", ");
    warnings.push(
      `⚠️ Danger: edit content matches dangerous patterns: ${patternsList}. ` +
      `Review these changes carefully before proceeding.`,
    );
  }

  // ── 3. For prompt_always, emit a generic note on safe edits ───
  if (cfg.level === "prompt_always" && warnings.length === 0) {
    warnings.push(
      `ℹ️ Approval check: editing "${filePath}" — no dangerous patterns detected. Proceed with standard caution.`,
    );
  }

  return {
    safe: matchedPath === null && symbolMatches.length === 0,
    warnings,
    level: cfg.level,
  };
}