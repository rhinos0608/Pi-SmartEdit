/**
 * Default configuration and merge helpers for the verification pipeline.
 *
 * Defaults are conservative:
 * - Warnings only (no hard failures).
 * - No external commands unless explicitly configured.
 * - Short timeouts for inline operations.
 * - Traceability and history enabled with safe defaults.
 */

import type {
  VerificationConfig,
  ConcurrencyConfig,
  TraceabilityConfig,
  HistoryConfig,
} from "./types";

/**
 * Provide a default VerificationConfig with safe, conservative values.
 * External commands are intentionally empty — users must opt in.
 */
export function defaultVerificationConfig(): VerificationConfig {
  return {
    enabled: true,
    maxInlineMs: 5_000,
    maxBackgroundMs: 120_000,
    policy: "warn",
    concurrency: defaultConcurrencyConfig(),
    traceability: defaultTraceabilityConfig(),
    history: defaultHistoryConfig(),
  };
}

export function defaultConcurrencyConfig(): ConcurrencyConfig {
  return {
    enabled: true,
    runMode: "inline",
    commands: [],
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
