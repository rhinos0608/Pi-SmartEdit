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
 *   PI_EDIT_MODE                       — text | hashline (operator edit dialect; resolved in protocol)
 *   SMART_EDIT_USE_HASHLINE_EDITING  — legacy opt-in to hashline-based editing (1|true|yes|on)
 *   SMART_EDIT_HASHLINE_EXPERIMENTAL — legacy alias for USE_HASHLINE_EDITING
 *   SMART_EDIT_FUZZY_MATCHING        — enable similarity rescue (default: true)
 *   SMART_EDIT_VERIFICATION_COMMANDS — JSON array of verification commands
 *   SMART_EDIT_REPAIR_ENABLED        — enable repair loop (default: true)
 *   SMART_EDIT_REPAIR_MAX_RETRIES    — max retry attempts (default: 3, capped: 50)
 *   SMART_EDIT_FAKE_LOGIC_ENABLED    — detect fake-logic placeholders (default: true)
 *   SMART_EDIT_LINT_ENABLED          — detect lint artifact placeholders (default: true)
 *   JDT_LS_JAR                       — path to JDT-LS jar for Java LSP
 */

import { resolveEditMode, type EditMode } from "@rhinos0608/pi-workspace-protocol";

// ─── Types ───────────────────────────────────────────────────────────────

/** Approval level controlling when safety gates are active. */
export type ApprovalLevel = "never_prompt" | "prompt_on_dangerous" | "prompt_always";

/** Fully resolved SmartEdit configuration. */
export interface SmartEditConfig {
  /** Approval level for edit safety checks. */
  approvalLevel: ApprovalLevel;

  /** Allow editing files that appear auto-generated. */
  editAutogen: boolean;

  /** Active edit dialect (operator config; defaults to text). */
  editMode: EditMode;

  /** Resolution warning (e.g. invalid PI_EDIT_MODE value), if any. */
  editModeWarning: string | undefined;

  /** Derived: editMode === "hashline". Kept for existing internal readers. */
  useHashlineEditing: boolean;

  /** Enable similarity-based fuzzy matching. */
  allowFuzzyMatching: boolean;

  /** JSON string of external verification commands. */
  verificationCommands: string;

  /** Enable the edit repair loop. */
  repairEnabled: boolean;

  /** Maximum retry attempts for the repair loop (0-50). */
  repairMaxRetries: number;

  /** Detect fake-logic placeholders in generated code. */
  fakeLogicEnabled: boolean;

  /** Detect lint / eslint artifact placeholders in generated code. */
  lintEnabled: boolean;

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

  // ── editMode (single operator config, resolved in protocol) ─
  const resolved = resolveEditMode(env);
  const editMode = resolved.mode;
  const editModeWarning = resolved.warning;

  // ── useHashlineEditing (derived for existing internal readers) ─
  const useHashlineEditing = editMode === "hashline";

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

  // ── fakeLogicEnabled ────────────────────────────────────
  const fakeLogicRaw = env["SMART_EDIT_FAKE_LOGIC_ENABLED"];
  const fakeLogicEnabled = fakeLogicRaw != null ? parseBooleanEnv(fakeLogicRaw) : true;

  // ── lintEnabled ─────────────────────────────────────────
  const lintRaw = env["SMART_EDIT_LINT_ENABLED"];
  const lintEnabled = lintRaw != null ? parseBooleanEnv(lintRaw) : true;

  // ── jdtLsJar ────────────────────────────────────────────
  const jdtLsJar = env["JDT_LS_JAR"] ?? "";

  return {
    approvalLevel,
    editAutogen,
    editMode,
    editModeWarning,
    useHashlineEditing,
    allowFuzzyMatching,
    verificationCommands,
    repairEnabled,
    repairMaxRetries,
    fakeLogicEnabled,
    lintEnabled,
    jdtLsJar,
  };
}
