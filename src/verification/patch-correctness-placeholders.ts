/**
 * Zero-value placeholder detection for patch correctness.
 *
 * Detects operations that compute to 0: 9/10 times, `return 0` or
 * `= 0` in new/changed code is a stub placeholder.
 */
import type { LangConfig } from "./patch-correctness-config.js";
import type { PatchCheck } from "./patch-correctness-lexical.js";

/**
 * Detect zero-value placeholders — operations that compute to 0.
 * 9/10 times, `return 0` or `= 0` in new/changed code is a stub placeholder.
 *
 * Checks:
 *  - New `return 0` statements where old code returned non-zero
 *  - New `= 0` assignments where old code had non-zero value
 *  - Functions that now return 0 but previously returned something else
 */
export function checkZeroValuePlaceholders(
  oldContent: string,
  newContent: string,
  _config: LangConfig,
): PatchCheck {
  void _config;
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
