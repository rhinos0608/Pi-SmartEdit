/**
 * Edit Repair Loop — Lint-Fix pattern inspired by Aider.
 *
 * Orchestrates retry of an edit when validation fails:
 *   1. Run auto-validation
 *   2. If passed → return success
 *   3. If failed → format feedback, record attempt, optionally auto-repair
 *   4. Retry up to maxRetries with configurable delay
 *   5. On exhaustion → signal decomposition suggestion
 *
 * Also provides:
 * - `autoRepair()`: high-level function for attempting automatic fixes
 * - `registerRepairHook()`: callback registration for model feedback
 * - Wired into the evidence pipeline as an optional phase
 *
 * Non-critical: repair failures produce notes but never block the pipeline.
 */

import { resolve } from "path";
import type { Diagnostic } from "../lsp/diagnostic-dispatcher";
import {
  runAutoValidation,
  formatValidationFeedback,
  checkStructural,
  type ValidationResult,
} from "./auto-validate";
import { detectIndentation, normalizeIndentation } from "../../lib/edit-diff";

// ─── Public Types ───────────────────────────────────────────────────

export interface RepairAttempt {
  attempt: number;
  timestamp: string;
  diagnostics: Diagnostic[];
  structuralErrors: string[];
  feedbackMessage: string | null;
  passed: boolean;
}

export interface RepairLoopOptions {
  /** Max retry attempts before declaring failure (default: 3) */
  maxRetries?: number;
  /** Delay between retries in milliseconds (default: 0) */
  retryDelayMs?: number;
}

export interface RepairLoopResult {
  /** Whether the final validation passed */
  passed: boolean;
  /** All repair attempts made */
  attempts: RepairAttempt[];
  /** The final validation result */
  finalValidation: ValidationResult | null;
  /** Digest of what went wrong for logging/UI */
  summary: string;
}

/** Callback type for repair hook notifications */
export type RepairHook = (
  attempt: RepairAttempt,
  context: {
    filePath: string;
    originalContent: string;
    repairedContent: string | null;
  },
) => void | Promise<void>;

// ─── Module State ───────────────────────────────────────────────────

const registeredHooks: RepairHook[] = [];

// ─── Core API ──────────────────────────────────────────────────────

/**
 * Run the full repair loop for a file edit.
 *
 * Orchestrates: validate → on-fail record attempt + notify hooks →
 * wait → retry → repeat until pass or exhaustion.
 *
 * @param filePath  Absolute or cwd-relative path to the file
 * @param content   The post-edit file content to validate
 * @param options   Repair loop configuration
 * @param cwd       Working directory (default: process.cwd())
 */
export async function runRepairLoop(
  filePath: string,
  content: string,
  options: RepairLoopOptions = {},
  cwd: string = process.cwd(),
): Promise<RepairLoopResult> {
  const {
    maxRetries = 3,
    retryDelayMs = 0,
  } = options;

  const attempts: RepairAttempt[] = [];
  let currentContent = content;
  let finalValidation: ValidationResult | null = null;
  let passed = false;
  let repairedContent: string | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // ── Run validation ──
    finalValidation = await runAutoValidation(filePath, currentContent, {
      cwd,
      maxRetries,
      enabled: true,
    });

    passed = finalValidation.passed;
    repairedContent = null;

    // ── On failure, attempt auto-repair ──
    if (!passed) {
      const repairResult = await autoRepair(content, currentContent, filePath, options, cwd);
      if (repairResult.repaired && repairResult.validation?.passed) {
        currentContent = repairResult.content;
        repairedContent = repairResult.content;
        passed = true;
      }
    }

    const feedbackMessage = formatValidationFeedback(finalValidation);
    const structuralErrors = finalValidation.structural.errors;
    const timestamp = new Date().toISOString();

    const repairAttempt: RepairAttempt = {
      attempt,
      timestamp,
      diagnostics: finalValidation.diagnostics,
      structuralErrors,
      feedbackMessage,
      passed,
    };

    attempts.push(repairAttempt);

    if (passed) {
      // Clean run — stop early
      break;
    }

    // ── Notify registered hooks ──
    await notifyHooks(repairAttempt, {
      filePath: resolve(cwd, filePath),
      originalContent: content,
      repairedContent,
    });

    // ── Wait before retry (skip on last attempt) ──
    if (attempt < maxRetries && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  // Build summary
  const errorCount = attempts.filter((a) => !a.passed).length;
  const summary = passed
    ? `✓ Repair loop succeeded in ${attempts.length} attempt(s)`
    : `✗ Repair loop failed after ${errorCount} attempt(s). ${finalValidation?.shouldDecompose ? "Max retries reached — consider decomposing the task." : ""}`;

  return {
    passed,
    attempts,
    finalValidation,
    summary,
  };
}

/**
 * Register a callback that fires after each repair attempt.
 * Used by the model/system to receive repair feedback for retry.
 *
 * @param fn  The hook callback
 * @returns   A function to unregister the hook
 */
export function registerRepairHook(fn: RepairHook): () => void {
  registeredHooks.push(fn);
  return () => {
    const idx = registeredHooks.indexOf(fn);
    if (idx !== -1) registeredHooks.splice(idx, 1);
  };
}

// ─── Auto-Repair Strategies ────────────────────────────────────────

/**
 * High-level function that validates content and attempts automatic
 * repairs when validation fails.
 *
 * Repair strategies applied in order:
 *   1. Fix unbalanced braces / brackets
 *   2. Normalize indentation to match file style
 *   3. Strip trailing whitespace from modified lines
 *   4. Remove duplicate blank lines
 *
 * @param originalContent   The baseline content (used for diff detection)
 * @param newContent        The content to validate and potentially repair
 * @param filePath          Path to the file (for language detection)
 * @param options           Repair options (maxRetries, etc.)
 * @param cwd               Working directory
 * @returns                 The repaired content, or original newContent if repair didn't help
 */
export async function autoRepair(
  originalContent: string,
  newContent: string,
  filePath: string,
  options: RepairLoopOptions = {},
  cwd: string = process.cwd(),
): Promise<{
  content: string;
  repaired: boolean;
  repairNote: string;
  validation: ValidationResult | null;
}> {
  // First, validate as-is
  const initialValidation = await runAutoValidation(filePath, newContent, {
    cwd,
    maxRetries: options.maxRetries ?? 3,
    enabled: true,
  });

  if (initialValidation.passed) {
    return {
      content: newContent,
      repaired: false,
      repairNote: "Content passed validation without repair",
      validation: initialValidation,
    };
  }

  // Attempt auto-repair strategies
  let repairedContent = newContent;
  const appliedStrategies: string[] = [];

  // Strategy 1: Fix unbalanced braces (skip if file has template literals — backticks in strings cause false counts)
  const hasTemplateLiterals = repairedContent.includes("`");
  if (!hasTemplateLiterals) {
    const bracesFixed = fixUnbalancedBraces(repairedContent);
    if (bracesFixed !== repairedContent) {
      repairedContent = bracesFixed;
      appliedStrategies.push("fix-unbalanced-braces");
    }

    // Strategy 2: Fix unbalanced brackets (same template-literal guard)
    const bracketsFixed = fixUnbalancedBrackets(repairedContent);
    if (bracketsFixed !== repairedContent) {
      repairedContent = bracketsFixed;
      appliedStrategies.push("fix-unbalanced-brackets");
    }
  }

  // Strategy 3: Normalize indentation to match file style
  const indentNormalized = normalizeContentIndentation(
    repairedContent,
    detectIndentation(repairedContent),
  );
  if (indentNormalized !== repairedContent) {
    repairedContent = indentNormalized;
    appliedStrategies.push("normalize-indentation");
  }

  // Strategy 4: Strip trailing whitespace
  const trailingFixed = stripTrailingWhitespace(repairedContent);
  if (trailingFixed !== repairedContent) {
    repairedContent = trailingFixed;
    appliedStrategies.push("strip-trailing-whitespace");
  }

  // Strategy 5: Remove duplicate blank lines
  const blankLinesFixed = removeDuplicateBlankLines(repairedContent);
  if (blankLinesFixed !== repairedContent) {
    repairedContent = blankLinesFixed;
    appliedStrategies.push("remove-duplicate-blank-lines");
  }

  // Re-validate the repaired content
  const postRepairValidation = await runAutoValidation(filePath, repairedContent, {
    cwd,
    maxRetries: 1, // No retries for post-repair validation
    enabled: true,
  });

  const repaired = appliedStrategies.length > 0;
  const repairNote = repaired
    ? `Applied strategies: ${appliedStrategies.join(", ")}. Result: ${postRepairValidation.passed ? "PASSED" : "STILL FAILING"}`
    : "No repair strategies could be applied";

  return {
    content: postRepairValidation.passed ? repairedContent : newContent,
    repaired,
    repairNote,
    validation: postRepairValidation,
  };
}

// ─── Auto-Repair Strategy Implementations ─────────────────────────

/**
 * Fix unbalanced braces by adding or removing closing braces.
 * This is a heuristic — counts all { and } and balances the difference.
 * Works best for function/class bodies, not string literals.
 */
function fixUnbalancedBraces(content: string): string {
  const openCount = (content.match(/\{/g) || []).length;
  const closeCount = (content.match(/\}/g) || []).length;
  const diff = openCount - closeCount;

  if (diff === 0) return content;

  const lines = content.split("\n");

  if (diff > 0) {
    // More opens than closes — need to add closing braces
    // Find the last non-empty line and append closing braces
    let insertPos = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().length > 0) {
        insertPos = i + 1;
        break;
      }
    }
    const bracesToAdd = "}".repeat(diff);
    lines.splice(insertPos, 0, bracesToAdd);
  } else if (diff < 0) {
    // More closes than opens — remove excess closing braces from the end
    const toRemove = Math.abs(diff);
    for (let i = 0; i < toRemove; i++) {
      const lastNonEmptyIdx = findLastNonEmptyLineIdx(lines);
      if (lastNonEmptyIdx === -1) break;
      const line = lines[lastNonEmptyIdx];
      const trimmed = line.trimEnd();
      if (trimmed.endsWith("}")) {
        lines[lastNonEmptyIdx] = trimmed.slice(0, -1);
        if (trimmed.length !== line.length) {
          // Preserve trailing whitespace after removal
          const trailing = line.slice(trimmed.length);
          lines[lastNonEmptyIdx] = trimmed.slice(0, -1) + trailing;
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Fix unbalanced brackets by adding or removing closing brackets.
 */
function fixUnbalancedBrackets(content: string): string {
  const openCount = (content.match(/\[/g) || []).length;
  const closeCount = (content.match(/\]/g) || []).length;
  const diff = openCount - closeCount;

  if (diff === 0) return content;

  const lines = content.split("\n");

  if (diff > 0) {
    // More opens than closes — append closing brackets
    let insertPos = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().length > 0) {
        insertPos = i + 1;
        break;
      }
    }
    const bracketsToAdd = "]".repeat(diff);
    lines.splice(insertPos, 0, bracketsToAdd);
  }

  // diff < 0: more closes than opens — heuristic removal from end
  return lines.join("\n");
}

/**
 * Normalize all leading indentation in the content to match the
 * detected file style.
 */
function normalizeContentIndentation(
  content: string,
  fileStyle: { char: "\t" | " "; width: number },
): string {
  return normalizeIndentation(content, fileStyle);
}

/**
 * Strip trailing whitespace from all lines.
 */
function stripTrailingWhitespace(content: string): string {
  return content
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

/**
 * Collapse multiple consecutive blank lines into a single blank line.
 */
function removeDuplicateBlankLines(content: string): string {
  return content
    .split("\n")
    .reduce<string[]>((acc, line) => {
      const last = acc[acc.length - 1];
      if (line.trim() === "" && last?.trim() === "") {
        // Skip duplicate blank line
        return acc;
      }
      acc.push(line);
      return acc;
    }, [])
    .join("\n");
}

// ─── Helpers ───────────────────────────────────────────────────────

/** Notify all registered hooks — fire-and-forget, errors are swallowed */
async function notifyHooks(
  attempt: RepairAttempt,
  context: {
    filePath: string;
    originalContent: string;
    repairedContent: string | null;
  },
): Promise<void> {
  for (const hook of registeredHooks) {
    try {
      const result = hook(attempt, context);
      if (result instanceof Promise) {
        result.catch(() => {
          // Swallow hook errors — repair loop should never fail due to hooks
        });
      }
    } catch {
      // Sync hook errors are also swallowed
    }
  }
}

/** Sleep utility */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Find the index of the last non-empty line in an array */
function findLastNonEmptyLineIdx(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      return i;
    }
  }
  return -1;
}

/**
 * Suggest decomposition when max retries are exhausted.
 * Integrates with the auto-validate suggestion.
 */
export function suggestDecompositionFromRepair(
  attempts: RepairAttempt[],
  filePath: string,
): string {
  const lastAttempt = attempts[attempts.length - 1];
  if (!lastAttempt) {
    return "Repair loop completed with no attempts.";
  }

  const lines: string[] = [
    `## Repair Loop Exhausted for ${filePath}`,
    "",
    `The repair loop attempted ${attempts.length} fix(es) but validation still failed.`,
    "",
    "### Last Attempt Diagnostics:",
    lastAttempt.feedbackMessage || "(no feedback available)",
    "",
    "### Decomposition Suggestion",
    "",
    "Consider breaking this into smaller steps:",
    "1. Write one function/section at a time",
    "2. Validate each section independently",
    "3. Combine only after all sections pass validation",
    "",
    "### Common Fixes",
    "- Check for unbalanced braces/brackets",
    "- Verify indentation matches file style (tabs vs spaces)",
    "- Ensure all imports are present",
    "- Run a linter to catch style issues",
  ];

  return lines.join("\n");
}