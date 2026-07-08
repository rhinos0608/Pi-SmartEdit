/**
 * Error class hierarchy for SmartEdit.
 *
 * All SmartEdit-specific errors extend SmartEditError, enabling
 * reliable `instanceof` classification instead of fragile substring
 * matching against error messages.
 *
 * Error codes are informational strings for logging/debugging.
 */

// ─── Base ──────────────────────────────────────────────────────────────

export class SmartEditError extends Error {
  constructor(
    message: string,
    /** Informational error code for logging/debugging (e.g. "NOT_FOUND", "STALE") */
    public readonly code: string,
  ) {
    super(message);
    this.name = "SmartEditError";
  }
}

// ─── Match failures ─────────────────────────────────────────────────────

/**
 * Thrown when a text match fails: oldText not found, ambiguous matches,
 * stale file, or out-of-range coverage.
 */
export class MatchError extends SmartEditError {
  constructor(
    message: string,
    code: string,
    /** Index of the edit that failed, when applicable */
    public readonly editIndex?: number,
  ) {
    super(message, code);
    this.name = "MatchError";
  }
}

// ─── Parse failures ─────────────────────────────────────────────────────

/**
 * Thrown when a structured edit format cannot be parsed (search-replace,
 * unified diff, codex patch, atomic patch, etc.).
 */
export class ParseError extends SmartEditError {
  constructor(
    message: string,
    code: string,
    /** Line number where parsing failed, when applicable */
    public readonly line?: number,
  ) {
    super(message, code);
    this.name = "ParseError";
  }
}

// ─── Validation failures ────────────────────────────────────────────────

/**
 * Thrown when input validation fails (missing fields, wrong types, etc.).
 */
export class ValidationError extends SmartEditError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = "ValidationError";
  }
}

// ─── Approval/rejection failures ────────────────────────────────────────

/**
 * Thrown when an edit is rejected by the approval gate
 * (dangerous path, auto-generated file, etc.).
 */
export class ApprovalError extends SmartEditError {
  constructor(message: string, code: string) {
    super(message, code);
    this.name = "ApprovalError";
  }
}
