/**
 * Delimiter-balance and syntax-sanity checks for patch correctness.
 *
 * Owns character/word counting, unclosed-string detection, missing-
 * semicolon heuristics, and the two checks built on them.
 */
import { STANDARD_DELIMITERS } from "./patch-correctness-config.js";
import type { LangConfig } from "./patch-correctness-config.js";

export interface PatchCheck {
  passed: boolean;
  details: string;
}

/**
 * 1. Unbalanced delimiters: count braces, brackets, parens in old vs new.
 *    If the delta between old and new differs for open vs close, flag it.
 */
export function checkUnbalancedDelimiters(
  oldContent: string,
  newContent: string,
  config: LangConfig,
): PatchCheck {
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
 * 5. Syntax sanity: detect obvious syntax errors like unclosed strings,
 *    template literals, or (for semicolon-required languages) missing
 *    semicolons on non-block statements.
 */
export function checkSyntaxSanity(
  content: string,
  config: LangConfig,
): PatchCheck {
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

/**
 * Count occurrences of a character in a string (O(n) single-pass).
 */
export function countChar(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) count++;
  }
  return count;
}

/**
 * Count occurrences of a word bounded by non-word characters (O(n)).
 */
export function countWord(s: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word boundary: the word must be preceded/followed by non-word chars or string edges
  const re = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "g");
  const matches = s.match(re);
  return matches ? matches.length : 0;
}

/**
 * Find unclosed string literals. Returns list of string types that appear
 * unclosed (single-quote, double-quote).
 *
 * Handles escaped quotes and multi-line strings. Uses a simple single-pass
 * state machine.
 */
export function findUnclosedStrings(content: string): string[] {
  const unclosed: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < content.length) {
    const ch = content[i];

    // Inside a literal, a backslash escapes the next character: consume
    // both together so an escaped backslash cannot suppress the quote.
    if ((inSingle || inDouble) && ch === "\\") {
      i += 2;
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
  if (inDouble) unclosed.push('double-quoted (")');

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
export function findMissingSemicolons(content: string): number {
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

    // Skip continued statements: lines ending with an operator or an open
    // paren are part of a multiline expression, not missing a semicolon.
    if (/[+\-*/%&|^?:<>=.]$/.test(trimmed) || trimmed.endsWith("(")) continue;
    // If the line has a statement-looking pattern (assignment, return, call, expression)
    // and doesn't end with a semicolon, it might be missing one.
    const STATEMENT_RE = /\b(?:return|throw|break|continue|yield)\b/;
    const ASSIGNMENT_RE = /\w\s*=(?![=>])/;
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
