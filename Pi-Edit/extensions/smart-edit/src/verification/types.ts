/**
 * Shared types for the smart-edit post-edit evidence pipeline.
 *
 * Defines data structures for concurrency verification, traceability
 * analysis, and historical context retrieval — all layered on top of
 * the existing LSP/compiler diagnostic pipeline.
 *
 * All types are plain data interfaces with no runtime dependencies on
 * tree-sitter, LSP, or other heavy modules. This keeps the types file
 * importable by test utilities and config without side effects.
 */

/**
 * A semantic target that was changed by an edit.
 * Built from edit match spans + AST resolution.
 */
export interface ChangedTarget {
  /** Absolute file path */
  path: string;
  /** Language ID ("typescript", "go", "rust", etc.) */
  languageId: string;
  /** Syntactic kind of the target */
  kind: "function" | "method" | "class" | "module" | "unknown";
  /** Display name (function name, class name, or "unknown") */
  name: string;
  /** 1-based line range of the enclosing symbol */
  lineRange: { startLine: number; endLine: number };
  /** Byte range of the enclosing symbol in the post-edit content */
  byteRange: { startIndex: number; endIndex: number };
  /** Classification of the kind of change made */
  editKind: "logic" | "test" | "docs" | "format" | "unknown";
  /** Concurrency-related signals detected in the changed range */
  concurrencySignals: ConcurrencySignal[];
}

/**
 * A concurrency-related signal detected in source code.
 */
export interface ConcurrencySignal {
  /** Which category of concurrency construct was detected */
  category:
    | "async"
    | "thread"
    | "lock"
    | "atomic"
    | "channel"
    | "scheduler"
    | "name";
  /** The specific token or name matched (e.g. "async", "Mutex", "go") */
  token: string;
  /** 1-based line number where the signal was found */
  line: number;
}

// ─── Configuration ──────────────────────────────────────────────────

export interface VerificationConfig {
  /** Master switch — disable the entire evidence pipeline */
  enabled: boolean;
  /** Max wall-clock time for inline verification commands (ms) */
  maxInlineMs: number;
  /** Max wall-clock time for background verification commands (ms) */
  maxBackgroundMs: number;
  /** Policy level — controls whether notes become errors */
  policy: "off" | "warn" | "strict";
  /** Concurrency verification lane config */
  concurrency: ConcurrencyConfig;
  /** Traceability/test-linkage lane config */
  traceability: TraceabilityConfig;
  /** Historical context retrieval config */
  history: HistoryConfig;
}

export interface ConcurrencyConfig {
  /** Enable concurrency signal detection and tool dispatch */
  enabled: boolean;
  /** How to run verification tools */
  runMode: "off" | "inline" | "background";
  /** Project-specific commands to use as concurrency verification tools */
  commands: VerificationCommand[];
  /** Auto-detect known ecosystem tools (Fray, loom, go test -race, etc.) */
  autoDetectKnownTools: boolean;
}

export interface VerificationCommand {
  /** Display name for the tool */
  name: string;
  /** Executable command (no shell wrapper) */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Working directory (defaults to project root) */
  cwd?: string;
  /** Only run for these language IDs */
  languages?: string[];
  /** Only run if the edited file matches these globs */
  fileGlobs?: string[];
  /** Per-invocation timeout */
  timeoutMs?: number;
}

export interface TraceabilityConfig {
  /** Enable traceability analysis */
  enabled: boolean;
  /** Glob patterns for test file discovery */
  testGlobs: string[];
  /** Minimum acceptable coverage (100 in strict, 0 in warn) */
  minCoveragePercent: number;
  /** Emit warning when logic change has no linked test change */
  requireTestChangeForLogicChange: boolean;
}

export interface HistoryConfig {
  /** Enable historical context retrieval */
  enabled: boolean;
  /** Max commits to return per target */
  maxCommits: number;
  /** Max total characters of history output */
  maxChars: number;
  /** Include git blame annotations */
  includeBlame: boolean;
}

// ─── Evidence results ───────────────────────────────────────────────

export interface ConcurrencyEvidence {
  /** The changed target that triggered this check */
  target: ChangedTarget;
  /** Name of the verification tool that ran (or why it was skipped) */
  tool: string;
  /** The command that was executed (or would have been) */
  command: string[];
  /** Outcome of the verification */
  status: "passed" | "failed" | "skipped" | "timeout";
  /** Parsed diagnostics from the tool output */
  diagnostics: Array<{
    message: string;
    severity: 1 | 2 | 3 | 4;
    range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    evidence?: string;
  }>;
  /** Human-readable note about this evidence item */
  note: string;
}

export interface TraceabilityTargetEvidence {
  /** The changed target being analyzed */
  target: ChangedTarget;
  /** Test files discovered that reference this target */
  linkedTests: string[];
  /** Test files among linked tests that were also edited */
  editedTests: string[];
  /** How many LSP reference results were checked */
  referencesChecked: number;
  /** Coverage status for this target */
  status:
    | "covered"
    | "candidate"
    | "missing"
    | "not-applicable";
  /** Human-readable note */
  note: string;
}

export interface TraceabilityEvidence {
  /** Percentage of applicable targets with "covered" status */
  coveragePercent: number;
  /** Per-target traceability results */
  targets: TraceabilityTargetEvidence[];
}

export interface HistoryEvidence {
  /** The changed target the history was retrieved for */
  target: ChangedTarget;
  /** Relevant commits targeting this symbol, most recent first */
  commits: Array<{
    hash: string;
    date: string;
    subject: string;
    author?: string;
    reason: string;
  }>;
  /** Nearby comments that may encode context */
  nearbyComments: string[];
  /** Human-readable note */
  note: string;
}

export interface PostEditEvidenceResult {
  /** Formatted human-readable notes (advisory, appended to matchNotes) */
  notes: string[];
  /** Structured machine-readable details */
  details: {
    /** All changed targets identified */
    changes: ChangedTarget[];
    /** Concurrency verification results (empty if no lane ran) */
    concurrency: ConcurrencyEvidence[];
    /** Traceability analysis (null if skipped) */
    traceability: TraceabilityEvidence | null;
    /** Historical context per target */
    history: HistoryEvidence[];
  };
}
