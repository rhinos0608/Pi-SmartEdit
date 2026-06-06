/**
 * Auto-validation hook for write/edit tool outputs.
 *
 * SmallCode-inspired pipeline:
 *   1. Structural check (placeholders, truncation, unbalanced braces)
 *   2. Compile/lint via diagnostic dispatcher
 *   3. Feed errors back as structured result
 *   4. Track retry counts per file
 *   5. When retries exhausted → signal decomposition
 *
 * The hook is advisory: validation failures produce notes in the result
 * but never block the write/edit from succeeding (the file is already on disk).
 * The consumer (model) receives the diagnostics and decides whether to retry.
 */

import { resolve, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { diffLines } from "diff";
import { detectLanguageFromExtension } from "../lsp/language-id";
import { getCompilerForLanguage } from "../lsp/diagnostic-dispatcher";
import type { Diagnostic, DiagnosticResult } from "../lsp/diagnostic-dispatcher";
import type Parser from "web-tree-sitter";

// ─── Types ───────────────────────────────────────────────────────────

export interface FormatEquivalenceResult {
  equivalent: boolean; // true if formatted matches original (ignoring whitespace-only diffs)
  diff?: string; // compact diff if not equivalent
  indentScore: number; // 0-1 normalized indentation divergence
  error?: string; // error if formatter failed
  formatted?: string; // auto-formatted content for comparison
}

export interface StructuralCheckResult {
  passed: boolean;
  errors: string[];
}

export interface ValidationResult {
  /** Whether all checks passed */
  passed: boolean;
  /** Structural issues (placeholders, truncation, unbalanced braces) */
  structural: StructuralCheckResult;
  /** Compiler/linter diagnostics */
  diagnostics: Diagnostic[];
  /** Source of diagnostics (e.g., "tsc", "pyright", "none") */
  diagnosticSource: string;
  /** Retry count for this file in the current session */
  retryCount: number;
  /** Whether max retries have been exhausted */
  shouldDecompose: boolean;
  /** Human-readable summary for the model */
  summary: string;
  /** Format equivalence check result */
  formatEquivalence?: FormatEquivalenceResult;
}

export interface AutoValidateOptions {
  /** Working directory */
  cwd?: string;
  /** Max retries before decomposition signal */
  maxRetries?: number;
  /** Whether to run the full pipeline (default: true) */
  enabled?: boolean;
  /** Optional previous parse tree for incremental syntax validation */
  oldTree?: Parser.Tree | null;
  /** Optional previous content matching the oldTree */
  oldContent?: string;
}

// ─── Per-session retry tracking ──────────────────────────────────────

interface RetryEntry {
  count: number;
  lastUpdate: number;
}

const retryCounts = new Map<string, RetryEntry>();
const RETRY_COUNTS_MAX = 200;

function evictStaleRetryCounts(): void {
  if (retryCounts.size <= RETRY_COUNTS_MAX) return;
  const entries = [...retryCounts.entries()];
  entries.sort((a, b) => a[1].lastUpdate - b[1].lastUpdate);
  const toRemove = entries.slice(0, retryCounts.size - RETRY_COUNTS_MAX);
  for (const [key] of toRemove) {
    retryCounts.delete(key);
  }
}

function getRetryKey(cwd: string, filePath: string): string {
  return resolve(cwd, filePath);
}

export function incrementRetryCount(cwd: string, filePath: string): number {
  const key = getRetryKey(cwd, filePath);
  const entry = retryCounts.get(key);
  const count = (entry?.count ?? 0) + 1;
  retryCounts.set(key, { count, lastUpdate: Date.now() });
  evictStaleRetryCounts();
  return count;
}

function getRetryCount(cwd: string, filePath: string): number {
  return retryCounts.get(getRetryKey(cwd, filePath))?.count ?? 0;
}

/**
 * Reset retry counters — called on session start.
 */
export function resetRetryCounts(): void {
  retryCounts.clear();
}

// ─── Structural checks ───────────────────────────────────────────────

const PLACEHOLDERS = [
  "// TODO",
  "// ...",
  "/* ... */",
  "// TODO:",
  "// FIXME: (placeholder)",
  "// implement later",
  "pass  # placeholder",
  "raise NotImplementedError",
  "# TODO",
  "# ...",
  "// stub",
  "/* stub */",
];

const TRUNCATION_MARKERS = [
  "// ... rest of",
  "// ... remaining",
  "# ... more",
  "# ... rest",
  "// truncated",
  "/* truncated */",
];

/**
 * Check for structural issues: placeholders, truncation, unbalanced braces.
 */
export function checkStructural(content: string, _filePath: string): StructuralCheckResult {
  const errors: string[] = [];

  // Check for placeholders
  for (const p of PLACEHOLDERS) {
    if (content.includes(p)) {
      errors.push(`Contains placeholder: "${p}"`);
    }
  }

  // Check for truncation markers
  for (const marker of TRUNCATION_MARKERS) {
    if (content.includes(marker)) {
      errors.push(`Appears truncated: "${marker}"`);
    }
  }

  // Check balanced braces (C-style languages, JSON)
  // NOTE: This counts all { and } in the file, including those inside string
  // literals and comments. Braces within strings like '{"key": "val"}' will
  // be counted and may produce false positives. This is advisory only — the
  // check is not sound for all languages and content patterns.
  const openBraces = (content.match(/\{/g) || []).length;
  const closeBraces = (content.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    errors.push(`Unbalanced braces: ${openBraces} open, ${closeBraces} close`);
  }

  // Check balanced brackets (same limitation — counts all [ ] including in strings)
  const openBrackets = (content.match(/\[/g) || []).length;
  const closeBrackets = (content.match(/\]/g) || []).length;
  if (openBrackets !== closeBrackets) {
    errors.push(`Unbalanced brackets: ${openBrackets} open, ${closeBrackets} close`);
  }

  return { passed: errors.length === 0, errors };
}

// ─── Format-equivalence verification ───────────────────────────────

/**
 * Detect available formatter by checking for config files in cwd.
 * Returns the formatter command string or null if none found.
 */
export function detectFormatter(cwd: string, filePath: string): string | null {
  // Get the directory containing the file
  const dir = dirname(resolve(cwd, filePath));

  // Check for Biome config
  if (existsSync(resolve(dir, 'biome.json'))) {
    return 'bunx biome format';
  }

  // Check for Prettier config files
  const prettierConfigs = [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.js',
    '.prettierrc.yaml',
    '.prettierrc.toml',
    'prettier.config.js',
    'prettier.config.mjs',
    'prettier.config.cjs',
  ];

  for (const config of prettierConfigs) {
    if (existsSync(resolve(dir, config))) {
      return 'npx prettier --write';
    }
  }

  return null;
}

/**
 * Compute indentation score between original and formatted content.
 * Returns 0.0-1.0 where 0 = no indent differences, 1 = all lines differ.
 */
export function computeIndentScore(original: string, formatted: string): number {
  const originalLines = original.split('\n');
  const formattedLines = formatted.split('\n');

  let differingIndentCount = 0;
  const maxLines = Math.max(originalLines.length, formattedLines.length);

  for (let i = 0; i < maxLines; i++) {
    const originalLine = originalLines[i] ?? '';
    const formattedLine = formattedLines[i] ?? '';

    // Compute indentation (leading whitespace) for each line
    const originalIndent = originalLine.match(/^(\s*)/)?.[1] ?? '';
    const formattedIndent = formattedLine.match(/^(\s*)/)?.[1] ?? '';

    if (originalIndent !== formattedIndent) {
      differingIndentCount++;
    }
  }

  if (maxLines === 0) return 0;
  return differingIndentCount / maxLines;
}

/**
 * Generate a compact diff showing only changed regions.
 * Uses 3 lines of context around changes.
 */
export function generateEquivalenceDiff(original: string, formatted: string): string {
  const changes = diffLines(original, formatted);
  const lines: string[] = [];

  for (const part of changes) {
    if (part.added) {
      for (const line of part.value.split('\n')) {
        if (line !== '') {
          lines.push(`+${line}`);
        }
      }
    } else if (part.removed) {
      for (const line of part.value.split('\n')) {
        if (line !== '') {
          lines.push(`-${line}`);
        }
      }
    }
  }

  // Limit output to first 50 changed lines to avoid bloat
  const output = lines.slice(0, 50);
  if (lines.length > 50) {
    output.push(`... [${lines.length - 50} more changes]`);
  }

  return output.join('\n');
}

/**
 * Run format equivalence check on content.
 * Auto-formats the content and compares against original.
 */
export async function runFormatEquivalenceCheck(
  content: string,
  filePath: string,
  cwd: string,
): Promise<FormatEquivalenceResult> {
  const formatter = detectFormatter(cwd, filePath);

  if (!formatter) {
    return { equivalent: true, indentScore: 0 };
  }

  // Create a temporary file for formatting (preserve extension for formatter detection)
  const ext = filePath.slice(filePath.lastIndexOf('.')) || '.ts';
  const tmpPath = resolve(cwd, `.smart-edit-tmp-${Date.now()}${ext}`);

  try {
    // Write content to temp file
    writeFileSync(tmpPath, content, 'utf-8');

    // Run formatter based on detected type
    let formattedContent: string;

    if (formatter === 'bunx biome format') {
      const result = await runFormatterCommand(['bunx', 'biome', 'format', tmpPath], cwd);
      if (result.error) {
        return { equivalent: true, indentScore: 0, error: result.error };
      }
      // Read the formatted file
      formattedContent = readFileSync(tmpPath, 'utf-8');
    } else {
      // Prettier
      const result = await runFormatterCommand(
        ['npx', 'prettier', '--write', tmpPath],
        cwd,
      );
      if (result.error) {
        return { equivalent: true, indentScore: 0, error: result.error };
      }
      // Read the formatted file
      formattedContent = readFileSync(tmpPath, 'utf-8');
    }

    // Compute indent score
    const indentScore = computeIndentScore(content, formattedContent);

    // Check if they're equivalent (only whitespace differences)
    const diff = generateEquivalenceDiff(content, formattedContent);
    const equivalent = diff.trim() === '' || !hasNonWhitespaceChanges(content, formattedContent);

    return {
      equivalent,
      indentScore,
      diff: equivalent ? undefined : diff,
      formatted: formattedContent,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { equivalent: true, indentScore: 0, error };
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Run a formatter command and return the result.
 */
async function runFormatterCommand(
  args: string[],
  cwd: string,
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stderr = '';

    if (child.stderr) {
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (data: string) => {
        stderr += data;
      });
    }

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr.trim() || `Exit code: ${code}` });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ success: false, error: 'Formatter timed out' });
    }, 30_000);
  });
}

/**
 * Check if there are non-whitespace changes between two strings.
 */
function hasNonWhitespaceChanges(original: string, formatted: string): boolean {
  const changes = diffLines(original, formatted);

  for (const part of changes) {
    if (part.added || part.removed) {
      // Check if the change contains non-whitespace characters
      const testContent = part.value.replace(/\s/g, '');
      if (testContent.length > 0) {
        return true;
      }
    }
  }

  return false;
}

// ─── Auto-validation pipeline ────────────────────────────────────────

/**
 * Run the full auto-validation pipeline after a write/edit.
 *
 * This is designed to be called from the write tool's result handler
 * and from the edit tool's post-edit diagnostics section.
 *
 * Returns a ValidationResult with structured diagnostics suitable for
 * feeding back to the model as part of the tool result.
 */
export async function runAutoValidation(
  filePath: string,
  content: string,
  options: AutoValidateOptions = {},
): Promise<ValidationResult> {
  const {
    cwd = process.cwd(),
    maxRetries = 3,
    enabled = true,
    oldTree,
    oldContent,
  } = options;

  if (!enabled) {
    return {
      passed: true,
      structural: { passed: true, errors: [] },
      diagnostics: [],
      diagnosticSource: "disabled",
      retryCount: 0,
      shouldDecompose: false,
      summary: "",
      formatEquivalence: { equivalent: true, indentScore: 0 },
    };
  }

  // Get initial retry count before running validation
  const currentCount = getRetryCount(cwd, filePath);
  const absolutePath = resolve(cwd, filePath);

  // Run the structural check (may return errors)
  const structural = checkStructural(content, absolutePath);

  // Run incremental syntax validation if old tree is available
  let syntaxError: string | null = null;
  if (oldTree && oldContent) {
    try {
      // Dynamic import to avoid circular dependency
      const { validateSyntax } = await import("../../lib/ast-resolver.js");
      const syntaxResult = await validateSyntax(content, filePath, oldTree, oldContent);
      if (!syntaxResult.valid) {
        syntaxError = syntaxResult.error;
      }
    } catch {
      // Syntax validation failed — continue with other checks
    }
  }

  // Run compiler/linter diagnostics
  let diagnostics: Diagnostic[] = [];
  let diagnosticSource = "none";

  // Run format equivalence check
  let formatEquivalence: FormatEquivalenceResult = {
    equivalent: true,
    indentScore: 0,
  };
  try {
    formatEquivalence = await runFormatEquivalenceCheck(content, absolutePath, cwd);
  } catch {
    // Format check failed — skip silently
  }

  const languageId = detectLanguageFromExtension(filePath);
  if (languageId) {
    const compilerRunner = getCompilerForLanguage(languageId);
    if (compilerRunner) {
      try {
        const result: DiagnosticResult = await compilerRunner(absolutePath, cwd);
        diagnostics = result.diagnostics;
        diagnosticSource = result.source;
      } catch {
        // Compiler not available or failed — skip silently
      }
    }
  }

  // Determine if validation passed
  const hasStructuralErrors = !structural.passed;
  const hasSyntaxErrors = syntaxError !== null;
  const hasFormatErrors = !formatEquivalence.equivalent;
  const hasCompilerErrors = diagnostics.filter((d) => d.severity === 1).length > 0;
  const passed = !hasStructuralErrors && !hasSyntaxErrors && !hasCompilerErrors;

  // Only increment retry count on actual failure (matches index.ts pattern)
  const retryCount = passed
    ? currentCount
    : incrementRetryCount(cwd, filePath);

  const shouldDecompose = retryCount >= maxRetries;

  // Build summary
  const parts: string[] = [];
  if (hasStructuralErrors) {
    parts.push(`Structural: ${structural.errors.join("; ")}`);
  }
  if (hasSyntaxErrors && syntaxError) {
    parts.push(`Syntax: ${syntaxError}`);
  }
  if (hasFormatErrors) {
    parts.push(
      `Format: indentation divergence ${(formatEquivalence.indentScore * 100).toFixed(0)}%`,
    );
  }
  if (diagnostics.length > 0 && diagnosticSource !== "none") {
    const errors = diagnostics.filter((d) => d.severity === 1);
    const warnings = diagnostics.filter((d) => d.severity === 2);
    if (errors.length > 0) {
      parts.push(`${diagnosticSource}: ${errors.length} error(s)`);
    }
    if (warnings.length > 0) {
      parts.push(`${diagnosticSource}: ${warnings.length} warning(s)`);
    }
  }
  if (shouldDecompose) {
    parts.push(`Max retries (${maxRetries}) reached — consider decomposing the task`);
  }

  const summary = passed
    ? `✓ Auto-validation passed`
    : `⚠ Auto-validation: ${parts.join("; ")}`;

  return {
    passed,
    structural,
    diagnostics,
    diagnosticSource,
    retryCount,
    shouldDecompose,
    summary,
    formatEquivalence,
  };
}

/**
 * Format validation diagnostics into a model-friendly message.
 * Used to feed errors back so the model can retry with corrections.
 */
export function formatValidationFeedback(result: ValidationResult): string | null {
  const parts: string[] = [];

  if (!result.structural.passed) {
    parts.push("Structural issues:");
    for (const err of result.structural.errors) {
      parts.push(`  • ${err}`);
    }
  }

  const errors = result.diagnostics.filter((d) => d.severity === 1);
  if (errors.length > 0) {
    parts.push(`\n${result.diagnosticSource} errors (${errors.length}):`);
    for (const diag of errors.slice(0, 10)) {
      const line = diag.range?.start?.line;
      const lineStr = line !== undefined ? `line ${line + 1}` : "";
      parts.push(`  • ${lineStr}: ${diag.message}`.trim());
    }
    if (errors.length > 10) {
      parts.push(`  ... and ${errors.length - 10} more errors`);
    }
  }

  const warnings = result.diagnostics.filter((d) => d.severity === 2);
  if (warnings.length > 0) {
    parts.push(`\n${result.diagnosticSource} warnings (${warnings.length}):`);
    for (const diag of warnings.slice(0, 5)) {
      parts.push(`  • ${diag.message}`);
    }
  }

  if (result.shouldDecompose) {
    parts.push("\n⚠ Max retries reached. The task may be too complex for a single edit.");
    parts.push("Consider breaking it into smaller steps:");
    parts.push("  1. Write one function/section at a time");
    parts.push("  2. Validate each section independently");
    parts.push("  3. Combine only after all sections pass validation");
  }

  if (parts.length === 0) return null;
  return parts.join("\n");
}

/**
 * Generate a decomposition suggestion when max retries are hit.
 * SmallCode pattern: decompose complex tasks into atomic steps.
 */
export function suggestDecomposition(
  originalTask: string,
  diagnostics: Diagnostic[],
): string {
  const errorMessages = diagnostics
    .filter((d) => d.severity === 1)
    .slice(0, 5)
    .map((d) => `  • ${d.message}`)
    .join("\n");

  return [
    `The task "${originalTask}" failed validation after multiple retries.`,
    "",
    "**Decomposition suggestion:**",
    "Break this into smaller, independently-validatable steps:",
    "",
    "1. Extract one function/component at a time into a separate file",
    "2. Fix errors one at a time, validating after each fix",
    "3. Rewrite the entire file section-by-section rather than patching",
    "",
    errorMessages ? `Top errors:\n${errorMessages}` : "",
    "",
    "**Recommended approach:**",
    "- Read the file fully to understand its structure",
    "- Write a corrected version of just the problematic section",
    "- Run validation on the rewritten section before integrating",
  ].filter(Boolean).join("\n");
}
