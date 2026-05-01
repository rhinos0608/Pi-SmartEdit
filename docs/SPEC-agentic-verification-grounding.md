# Specification: Agentic Verification and Grounding for smart-edit

## Motivation

smart-edit currently validates edits with syntax checks, LSP diagnostics, and compiler/linter fallback. That catches many deterministic failures, but it does not answer three higher-level questions:

1. Did this change touch concurrency-sensitive behavior that needs schedule exploration or stress testing?
2. Is the changed behavior linked to any test or verification artifact?
3. Is there local history explaining why this code looks the way it does?

This spec defines a post-edit evidence pipeline that returns structured, advisory feedback to the agent.

---

## Goals

1. Detect concurrency-sensitive edits and run bounded, configured concurrency verification where possible.
2. Link changed semantic targets to tests or other verification artifacts.
3. Retrieve small, targeted historical context for edited AST nodes.
4. Return evidence as soft diagnostics in the existing smart-edit result.
5. Keep the edit operation safe: no unbounded commands, no automatic dependency installation, no hidden project mutation.

## Non-goals

- No generic proof of concurrency correctness.
- No mandatory test generation.
- No full requirements-management system.
- No external PR/comment API integration in v1.
- No hard blocking by default.

---

## User-facing behavior

After a successful edit, smart-edit may append notes such as:

```text
Note: ✓ LSP validated: no issues found.
⚠ Concurrency verification: edited async function `flushQueue`; no configured scheduler/interleaving tool found. Run `npm test -- flushQueue` or configure smartEdit.verification.concurrency.commands.
⚠ Traceability: changed `createOrder`, but no linked test was edited. Existing candidate test: src/service.test.ts.
ℹ History: `flushQueue` was last changed by abc1234 "fix race during shutdown". Re-run shutdown race coverage before finalizing.
```

Structured details should also be returned for tool consumers:

```typescript
interface EvidenceDetails {
  changes: ChangedTarget[];
  concurrency: ConcurrencyEvidence[];
  traceability: TraceabilityEvidence;
  history: HistoryEvidence[];
}
```

---

## Configuration

Add optional smart-edit configuration. The exact host API can be adapted to Pi's extension config mechanism.

```typescript
interface VerificationConfig {
  enabled?: boolean;                 // default true
  maxInlineMs?: number;              // default 5000
  maxBackgroundMs?: number;          // default 120000
  policy?: "off" | "warn" | "strict"; // default warn
  concurrency?: ConcurrencyConfig;
  traceability?: TraceabilityConfig;
  history?: HistoryConfig;
}

interface ConcurrencyConfig {
  enabled?: boolean;                 // default true
  runMode?: "off" | "inline" | "background"; // default inline
  commands?: VerificationCommand[];  // project-owned commands
  autoDetectKnownTools?: boolean;    // default true
}

interface VerificationCommand {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  languages?: string[];
  fileGlobs?: string[];
  timeoutMs?: number;
}

interface TraceabilityConfig {
  enabled?: boolean;                 // default true
  testGlobs?: string[];              // default common test patterns
  minCoveragePercent?: number;       // default 100 in strict, 0 in warn
  requireTestChangeForLogicChange?: boolean; // default false
}

interface HistoryConfig {
  enabled?: boolean;                 // default true when git exists
  maxCommits?: number;               // default 5
  maxChars?: number;                 // default 3000
  includeBlame?: boolean;            // default true
}
```

Security rule: arbitrary `VerificationCommand` entries run only if they come from repository/user configuration, never from model-provided edit arguments.

---

## Core data model

### Changed targets

A changed target is the semantic unit touched by an edit.

```typescript
interface ChangedTarget {
  path: string;
  languageId: string;
  kind: "function" | "method" | "class" | "module" | "unknown";
  name: string;
  lineRange: { startLine: number; endLine: number };
  byteRange: { startIndex: number; endIndex: number };
  editKind: "logic" | "test" | "docs" | "format" | "unknown";
  concurrencySignals: ConcurrencySignal[];
}

interface ConcurrencySignal {
  category: "async" | "thread" | "lock" | "atomic" | "channel" | "scheduler" | "name";
  token: string;
  line: number;
}
```

Build this from existing edit artifacts:

- `resultMatchSpans` in `index.ts` gives byte ranges actually changed.
- `findEnclosingSymbols` can resolve enclosing functions/classes.
- `detectLanguageFromExtension` already maps paths to language IDs.
- If AST resolution fails, fall back to changed line ranges and regex signals.

### Evidence result

```typescript
interface PostEditEvidenceResult {
  notes: string[];
  details: EvidenceDetails;
}

interface EvidenceDetails {
  changes: ChangedTarget[];
  concurrency: ConcurrencyEvidence[];
  traceability: TraceabilityEvidence;
  history: HistoryEvidence[];
}
```

---

## Feature lane A: Concurrency verification

### Triggering

Run the lane only when at least one changed target has a concurrency signal.

Default signal patterns:

| Language | Signals |
|----------|---------|
| TypeScript/JavaScript | `async`, `await`, `Promise.all`, `Promise.race`, `setTimeout`, `setImmediate`, `Worker`, `worker_threads`, `EventEmitter`, lock-like names |
| Java | `synchronized`, `volatile`, `Lock`, `ReentrantLock`, `Atomic*`, `CompletableFuture`, `Executor`, `Thread` |
| Rust | `Arc`, `Mutex`, `RwLock`, `Atomic*`, `thread::spawn`, `tokio::spawn`, `loom::model` |
| Go | `go`, `chan`, `select`, `sync.Mutex`, `sync.RWMutex`, `sync.WaitGroup`, `atomic` |
| Python | `async`, `await`, `asyncio`, `threading`, `multiprocessing`, `Lock`, `Queue` |

### Tool adapters

```typescript
interface VerificationTool {
  name: string;
  languages: string[];
  canRun(input: VerificationInput): Promise<boolean>;
  run(input: VerificationInput): Promise<VerificationToolResult>;
}

interface VerificationInput {
  cwd: string;
  filePath: string;
  languageId: string;
  changedTargets: ChangedTarget[];
  timeoutMs: number;
}

interface VerificationToolResult {
  tool: string;
  command: string[];
  status: "passed" | "failed" | "skipped" | "timeout";
  diagnostics: Array<{
    message: string;
    severity: 1 | 2 | 3 | 4;
    range?: { start: { line: number; character: number }; end: { line: number; character: number } };
    evidence?: string;
  }>;
}
```

Known adapters:

- `FrayTool` for JVM projects with Fray/Gradle/Maven configured.
- `JcstressTool` for JVM projects with a jcstress module or jar.
- `LoomTool` for Rust tests using `loom::model`.
- `GoRaceTool` for Go modules: bounded `go test -race` on the nearest package.
- `ConfiguredCommandTool` for project-specific TypeScript/JavaScript scheduler fuzzers.

If no adapter can run, return a warning rather than pretending the code is verified.

### Background mode

`runMode: "background"` may start a bounded process and return a `verificationRunId`. Because smart-edit currently returns once per edit call, background mode also needs a query surface.

Add a small read-only tool in a later phase:

```typescript
smart_edit_verification_status({ runId?: string }): VerificationRunStatus[]
```

MVP can run inline with a short timeout and defer background mode.

---

## Feature lane B: Traceability/test grounding

### Test detection

Default test globs:

- `**/*.test.*`
- `**/*.spec.*`
- `**/__tests__/**`
- `**/test/**`
- `**/tests/**`
- language-specific patterns such as `*_test.go`, `test_*.py`, `*.rs` under Rust integration test folders.

### Link strategies

For each non-test changed target:

1. Use LSP `textDocument/references` at the symbol location.
2. Filter references to test files.
3. Search test file names and test case names for the target name.
4. Check whether the current edit also changed a linked test file.
5. Attach verification commands already run by diagnostics/concurrency lanes.

```typescript
interface TraceabilityEvidence {
  coveragePercent: number;
  targets: TraceabilityTargetEvidence[];
}

interface TraceabilityTargetEvidence {
  target: ChangedTarget;
  linkedTests: string[];
  editedTests: string[];
  referencesChecked: number;
  status: "covered" | "candidate" | "missing" | "not-applicable";
  note: string;
}
```

### Policy

- `off`: do nothing.
- `warn`: append notes, never fail the edit.
- `strict`: return a soft error in details and an explicit warning note. Do not roll back the edit unless a future host-level policy supports hard failures.

Traceability should ignore docs-only and formatting-only changes where possible.

---

## Feature lane C: Historical context retrieval

### Retrieval sources

Use only local repository data in v1:

1. `git log -L :<symbol>:<path>` when the symbol is named and Git supports it.
2. `git log -L <start>,<end>:<path>` for line ranges.
3. `git blame -L <start>,<end> -- <path>` for current provenance.
4. `git log --max-count=N -- <path>` as fallback.
5. Nearby comments in the current target range.

If the project is not a Git repository, skip silently.

### Ranking

Prioritize commits that:

- touch the exact target range;
- are recent;
- contain maintenance words such as `fix`, `regression`, `race`, `deadlock`, `flaky`, `security`, `revert`, `compat`, `workaround`, `avoid`, `do not`;
- changed tests linked to the same target.

```typescript
interface HistoryEvidence {
  target: ChangedTarget;
  commits: Array<{
    hash: string;
    date: string;
    subject: string;
    author?: string;
    reason: string;
  }>;
  nearbyComments: string[];
  note: string;
}
```

### RAG-Reflect-inspired loop

smart-edit should not call an LLM inside the edit tool. Instead, it should provide the retrieval and rule-based reflection packet to the outer agent:

1. **Retrieve** local history for the changed target.
2. **Reason mechanically** with simple rules: flag likely bug-fix reversions or concurrency/security-sensitive history.
3. **Reflect** by emitting a warning when the current edit touches code with risky provenance.

This preserves the RAG-Reflect pattern without adding hidden model calls.

---

## Integration point

Add the evidence pipeline after current diagnostic aggregation in `index.ts`:

```text
atomicWrite
  → recordReadWithStat
  → conflictDetector.recordEdit
  → generateDiffString
  → validateSyntax
  → checkPostEditDiagnostics
  → compiler fallback
  → runPostEditEvidencePipeline
  → append notes and details
```

The pipeline must never write files. It may spawn bounded verification commands.

---

## Error handling

- Missing tools: `skipped`, advisory note.
- Command timeout: `timeout`, include command and timeout.
- Command failure: parse output into diagnostics when possible; otherwise include first safe output excerpt.
- LSP unavailable: traceability falls back to filename/name search.
- Git unavailable: history lane skipped.
- Large output: truncate to a bounded excerpt and preserve structured status.

---

## Acceptance criteria

1. Editing a normal deterministic function produces no concurrency warning.
2. Editing an async/lock/thread target emits a concurrency note if no tool is configured.
3. Configured verification commands run with timeout and return parsed pass/fail evidence.
4. Editing a function with linked tests reports candidate test files.
5. Editing logic without linked tests emits a traceability warning in `warn` mode.
6. Editing a symbol with relevant Git history reports a bounded history note.
7. All lanes are advisory by default and cannot corrupt the edit result.
8. Existing tests for edit matching, stale guards, conflicts, and diagnostics still pass.
