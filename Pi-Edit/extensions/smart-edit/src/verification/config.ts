/**
 * Default configuration and merge helpers for the verification pipeline.
 *
 * Defaults are conservative:
 * - Warnings only (no hard failures).
 * - No external commands unless explicitly configured via SMART_EDIT_VERIFICATION_COMMANDS.
 * - Short timeouts for inline operations.
 * - Traceability and history enabled with safe defaults.
 */

import type {
  VerificationConfig,
  ConcurrencyConfig,
  TraceabilityConfig,
  HistoryConfig,
  RepairConfig,
  VerificationCommand,
} from "./types";

/**
 * Provide a default VerificationConfig with safe, conservative values.
 * Repair loop is on by default (opt out via SMART_EDIT_REPAIR_ENABLED=0).
 * External commands are read from SMART_EDIT_VERIFICATION_COMMANDS (JSON).
 */
export function defaultVerificationConfig(
  env?: Record<string, string | undefined>,
): VerificationConfig {
  return {
    enabled: true,
    maxInlineMs: 5_000,
    maxBackgroundMs: 120_000,
    policy: "warn",
    concurrency: defaultConcurrencyConfig(env),
    traceability: defaultTraceabilityConfig(),
    history: defaultHistoryConfig(),
    repair: defaultRepairConfig(env),
  };
}

export function defaultConcurrencyConfig(
  env?: Record<string, string | undefined>,
): ConcurrencyConfig {
  let commands: VerificationCommand[] = [];
  const raw = (env ?? process.env)[VALIDATION_COMMANDS_ENV_VAR];
  if (raw != null && raw.trim().length > 0) {
    try {
      commands = JSON.parse(raw) as VerificationCommand[];
    } catch {
      // silently ignore malformed JSON — fall back to empty
    }
  }

  return {
    enabled: true,
    runMode: "inline",
    commands,
    autoDetectKnownTools: true,
  };
}

export function defaultTraceabilityConfig(): TraceabilityConfig {
  return {
    enabled: true,
    testGlobs: [
      "**/*.test.*",
      "**/*.spec.*",
      "**/__tests__/**",
      "**/test/**",
      "**/tests/**",
    ],
    minCoveragePercent: 0, // 0 in warn mode
    requireTestChangeForLogicChange: false,
  };
}

export function defaultHistoryConfig(): HistoryConfig {
  return {
    enabled: true,
    maxCommits: 5,
    maxChars: 3_000,
    includeBlame: true,
  };
}

const REPAIR_ENABLED_ENV_VAR = "SMART_EDIT_REPAIR_ENABLED";


const REPAIR_MAX_RETRIES_ENV_VAR = "SMART_EDIT_REPAIR_MAX_RETRIES";

const VALIDATION_COMMANDS_ENV_VAR = "SMART_EDIT_VERIFICATION_COMMANDS";

/**
 * Read an env var as a boolean. Returns true for "1", "true", "yes", "on".
 */
function parseBooleanEnv(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}


export function defaultRepairConfig(
  env?: Record<string, string | undefined>,
): RepairConfig {
  let enabled = true;
  const raw = (env ?? process.env)[REPAIR_ENABLED_ENV_VAR];
  if (raw != null) {
    enabled = parseBooleanEnv(raw);
  }

  let maxRetries = 3;
  const retryRaw = (env ?? process.env)[REPAIR_MAX_RETRIES_ENV_VAR];
  if (retryRaw != null) {
    const parsed = parseInt(retryRaw.trim(), 10);
    if (!isNaN(parsed) && parsed >= 0) maxRetries = parsed;
  }

  return {
    enabled,
    maxRetries,
    autoRepair: true,
    notifyOnRetry: true,
  };
}

/**
 * Deep-merge a partial config over the defaults.
 * Only defined fields from `partial` override the corresponding defaults.
 * Undefined fields keep their default values.
 */
export function mergeVerificationConfig(
  base: VerificationConfig,
  partial?: Partial<VerificationConfig>,
): VerificationConfig {
  if (!partial) return base;

  return {
    ...base,
    ...partial,
    // Nested merges for sub-configs
    concurrency: partial.concurrency
      ? mergeConcurrencyConfig(base.concurrency, partial.concurrency)
      : base.concurrency,
    traceability: partial.traceability
      ? mergeTraceabilityConfig(base.traceability, partial.traceability)
      : base.traceability,
    history: partial.history
      ? mergeHistoryConfig(base.history, partial.history)
      : base.history,
    repair: partial.repair
      ? mergeRepairConfig(base.repair, partial.repair)
      : base.repair,
  };
}

export function mergeConcurrencyConfig(
  base: ConcurrencyConfig,
  partial?: Partial<ConcurrencyConfig>,
): ConcurrencyConfig {
  if (!partial) return base;
  return {
    ...base,
    ...partial,
    commands: partial.commands ?? base.commands,
    // commands is not deep-merged — partial overrides entirely when present
  };
}

export function mergeTraceabilityConfig(
  base: TraceabilityConfig,
  partial?: Partial<TraceabilityConfig>,
): TraceabilityConfig {
  if (!partial) return base;
  return {
    ...base,
    ...partial,
    testGlobs: partial.testGlobs ?? base.testGlobs,
  };
}

export function mergeHistoryConfig(
  base: HistoryConfig,
  partial?: Partial<HistoryConfig>,
): HistoryConfig {
  if (!partial) return base;
  return { ...base, ...partial };
}

export function mergeRepairConfig(
  base: RepairConfig,
  partial?: Partial<RepairConfig>,
): RepairConfig {
  if (!partial) return base;
  return { ...base, ...partial };
}

/**
 * Apply config policy to determine whether a status should be visible.
 * In "off" mode, all lanes are suppressed. In "warn" mode, everything
 * is advisory. In "strict" mode, some warnings become errors.
 */
export function isVerificationActive(
  config: VerificationConfig,
): boolean {
  return config.enabled && config.policy !== "off";
}
