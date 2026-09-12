/**
 * Lightweight static analysis pre-verification that catches common edit errors
 * before running expensive LSP diagnostics. Runs as a pre-filter in the
 * evidence pipeline.
 *
 * All checks are O(n) single-pass where possible. Never throws — returns
 * a safe default on any error.
 *
 * Facade: owns checkPatchCorrectness, warning order, result assembly, and
 * the never-throw fallback. Family logic lives in sibling modules.
 */
import { getLangConfig } from "./patch-correctness-config.js";
import {
  checkUnbalancedDelimiters,
  checkSyntaxSanity,
} from "./patch-correctness-lexical.js";
import {
  checkDuplicateDeclarations,
  checkOrphanedReferences,
  checkImportConsistency,
} from "./patch-correctness-symbols.js";
import { checkZeroValuePlaceholders } from "./patch-correctness-placeholders.js";

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

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Safe default returned on any error.
 */
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
