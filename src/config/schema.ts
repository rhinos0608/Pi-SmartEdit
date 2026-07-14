/**
 * Central configuration schema for SmartEdit.
 *
 * All env-var-driven configuration is read and typed here.
 * Consumers import the resolved config object rather than reading
 * process.env directly.
 *
 * Supported env vars:
 *   SMART_EDIT_APPROVAL_LEVEL        — never_prompt | prompt_on_dangerous | prompt_always
 *   SMART_EDIT_EDIT_AUTOGEN          — allow editing auto-generated files (1|true|yes|on)
 *   SMART_EDIT_USE_HASHLINE_EDITING  — opt-in to hashline-based editing (1|true|yes|on)
 *   SMART_EDIT_HASHLINE_EXPERIMENTAL — alias for USE_HASHLINE_EDITING
 *   SMART_EDIT_FUZZY_MATCHING        — enable similarity rescue (default: true)
 *   SMART_EDIT_VERIFICATION_COMMANDS — JSON array of verification commands
 *   SMART_EDIT_REPAIR_ENABLED        — enable repair loop (default: true)
 *   SMART_EDIT_REPAIR_MAX_RETRIES    — max retry attempts (default: 3, capped: 50)
 *   JDT_LS_JAR                       — path to JDT-LS jar for Java LSP
 */

// ─── Types ───────────────────────────────────────────────────────────────

/** Approval level controlling when safety gates are active. */
export type ApprovalLevel = "never_prompt" | "prompt_on_dangerous" | "prompt_always";

/** Fully resolved SmartEdit configuration. */
export interface SmartEditConfig {
  /** Approval level for edit safety checks. */
  approvalLevel: ApprovalLevel;

  /** Allow editing files that appear auto-generated. */
  editAutogen: boolean;

  /** Opt-in to hashline-based editing (experimental). */
  useHashlineEditing: boolean;

  /** Enable similarity-based fuzzy matching. */
  allowFuzzyMatching: boolean;

  /** JSON string of external verification commands. */
  verificationCommands: string;

  /** Enable the edit repair loop. */
  repairEnabled: boolean;

  /** Maximum retry attempts for the repair loop (0-50). */
  repairMaxRetries: number;

  /** Path to JDT-LS jar for Java language support. */
  jdtLsJar: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Parse a boolean-like env var value.
 * Accepts "1", "true", "yes", "on" (case-insensitive).
 */
export function parseBooleanEnv(val: string | undefined): boolean {
  if (val == null) return false;
  return ["1", "true", "yes", "on"].includes(val.trim().toLowerCase());
}

// ─── Loader ──────────────────────────────────────────────────────────────

const VALID_LEVELS = new Set<ApprovalLevel>([
  "never_prompt",
  "prompt_on_dangerous",
  "prompt_always",
]);

/**
 * Read all env vars and return a fully resolved SmartEditConfig.
 *
 * @param env - Environment map (defaults to process.env).
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): SmartEditConfig {
  // ── approvalLevel ───────────────────────────────────────
  let approvalLevel: ApprovalLevel = "prompt_on_dangerous";
  const levelRaw = env["SMART_EDIT_APPROVAL_LEVEL"];
  if (levelRaw != null) {
    const trimmed = levelRaw.trim().toLowerCase();
    if (VALID_LEVELS.has(trimmed as ApprovalLevel)) {
      approvalLevel = trimmed as ApprovalLevel;
    }
  }

  // ── editAutogen ─────────────────────────────────────────
  const editAutogen = parseBooleanEnv(env["SMART_EDIT_EDIT_AUTOGEN"]);

  // ── useHashlineEditing (two possible env var names) ─────
  let useHashlineEditing = false;
  const hashlineDirect = env["SMART_EDIT_USE_HASHLINE_EDITING"];
  const hashlineAlias = env["SMART_EDIT_HASHLINE_EXPERIMENTAL"];
  if (hashlineDirect != null) {
    useHashlineEditing = parseBooleanEnv(hashlineDirect);
  } else if (hashlineAlias != null) {
    useHashlineEditing = parseBooleanEnv(hashlineAlias);
  }

  // ── allowFuzzyMatching ──────────────────────────────────
  const fuzzyRaw = env["SMART_EDIT_FUZZY_MATCHING"];
  const allowFuzzyMatching = fuzzyRaw != null ? parseBooleanEnv(fuzzyRaw) : true;

  // ── verificationCommands ────────────────────────────────
  const verificationCommands = env["SMART_EDIT_VERIFICATION_COMMANDS"] ?? "";

  // ── repairEnabled ───────────────────────────────────────
  const repairRaw = env["SMART_EDIT_REPAIR_ENABLED"];
  const repairEnabled = repairRaw != null ? parseBooleanEnv(repairRaw) : true;

  // ── repairMaxRetries ───────────────────────────────────
  let repairMaxRetries = 3;
  const retryRaw = env["SMART_EDIT_REPAIR_MAX_RETRIES"];
  if (retryRaw != null) {
    const parsed = parseInt(retryRaw.trim(), 10);
    if (!isNaN(parsed) && parsed >= 0) {
      repairMaxRetries = Math.min(parsed, 50);
    }
  }

  // ── jdtLsJar ────────────────────────────────────────────
  const jdtLsJar = env["JDT_LS_JAR"] ?? "";

  return {
    approvalLevel,
    editAutogen,
    useHashlineEditing,
    allowFuzzyMatching,
    verificationCommands,
    repairEnabled,
    repairMaxRetries,
    jdtLsJar,
  };
}
