/**
 * Shared constants for the fake-logic detector.
 *
 * Extracted verbatim from fake-logic.ts (values unchanged).
 * No check logic lives here.
 */

export const MAX_FILE_BYTES = 1_000_000;
export const DEFAULT_MAX_FINDINGS = 10;

export const FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "method_definition",
  "arrow_function",
  "function_definition",
]);

export const LOOP_NODE_TYPES = new Set([
  "if_statement",
  "while_statement",
  "ternary_expression",
  "conditional_expression",
]);

export const CATCH_NODE_TYPES = new Set([
  "catch_clause",
  "except_clause",
]);

export const BODY_TYPES = new Set([
  "statement_block",
  "block",
]);

export const COMMENT_TYPES = new Set([
  "comment",
  "line_comment",
  "block_comment",
]);
