# Implementation Plan: Agentic Verification and Grounding

Repo path: `<project-root>/Pi-Edit/extensions/smart-edit`

This plan adds a post-edit evidence pipeline on top of the existing syntax, LSP, and compiler diagnostics.

---

## Phase 0: Keep the edit path stable

Do not create a second edit pipeline. Integrate only after the existing write and diagnostics path in `index.ts`.

Current safe sequence to preserve:

```text
read/checkStale
  → applyEdits
  → atomicWrite
  → recordReadWithStat
  → conflictDetector.recordEdit
  → validateSyntax
  → LSP diagnostics
  → compiler fallback
```

Add evidence checks after compiler fallback. They must not mutate project files.

---

## Phase 1: Shared evidence types

Create `src/verification/types.ts`.

```typescript
import type { Diagnostic } from "../lsp/diagnostic-dispatcher";

export interface ChangedTarget {
  path: string;
  languageId: string;
  kind: "function" | "method" | "class" | "module" | "unknown";
  name: string;
  lineRange: { startLine: number; endLine: number };
  byteRange: { startIndex: number; endIndex: number };
  editKind: "logic" | "test" | "docs" | "format" | "unknown";
  concurrencySignals: ConcurrencySignal[];
}

export interface ConcurrencySignal {
  category: "async" | "thread" | "lock" | "atomic" | "channel" | "scheduler" | "name";
  token: string;
  line: number;
}

export interface VerificationConfig {
  enabled: boolean;
  maxInlineMs: number;
  maxBackgroundMs: number;
  policy: "off" | "warn" | "strict";
  concurrency: ConcurrencyConfig;
  traceability: TraceabilityConfig;
  history: HistoryConfig;
}

export interface ConcurrencyConfig {
  enabled: boolean;
  runMode: "off" | "inline" | "background";
  commands: VerificationCommand[];
  autoDetectKnownTools: boolean;
}

export interface VerificationCommand {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  languages?: string[];
  fileGlobs?: string[];
  timeoutMs?: number;
}

export interface TraceabilityConfig {
  enabled: boolean;
  testGlobs: string[];
  minCoveragePercent: number;
  requireTestChangeForLogicChange: boolean;
}

export interface HistoryConfig {
  enabled: boolean;
  maxCommits: number;
  maxChars: number;
  includeBlame: boolean;
}

export interface ConcurrencyEvidence {
  target: ChangedTarget;
  tool: string;
  command: string[];
  status: "passed" | "failed" | "skipped" | "timeout";
  diagnostics: Diagnostic[];
  note: string;
}

export interface TraceabilityEvidence {
  coveragePercent: number;
  targets: TraceabilityTargetEvidence[];
}

export interface TraceabilityTargetEvidence {
  target: ChangedTarget;
  linkedTests: string[];
  editedTests: string[];
  referencesChecked: number;
  status: "covered" | "candidate" | "missing" | "not-applicable";
  note: string;
}

export interface HistoryEvidence {
  target: ChangedTarget;
  commits: Array<{ hash: string; date: string; subject: string; author?: string; reason: string }>;
  nearbyComments: string[];
  note: string;
}

export interface PostEditEvidenceResult {
  notes: string[];
  details: {
    changes: ChangedTarget[];
    concurrency: ConcurrencyEvidence[];
    traceability: TraceabilityEvidence | null;
    history: HistoryEvidence[];
  };
}
```

Add `src/verification/config.ts` with `defaultVerificationConfig()` and a merge helper. Keep defaults conservative:

- enabled: true
- policy: warn
- concurrency runMode: inline
- maxInlineMs: 5000
- no arbitrary commands unless configured

---

## Phase 2: Build changed targets

Create `src/verification/change-targets.ts`.

Inputs:

```typescript
interface BuildChangedTargetsInput {
  path: string;
  content: string;
  languageId: string;
  matchSpans: Array<{ startIndex: number; endIndex: number }>;
}
```

Algorithm:

1. Parse file with `createAstResolver()` if grammar exists.
2. For each match span, call `findEnclosingSymbols()` and choose the smallest enclosing function/method/class.
3. Convert byte offsets to line ranges.
4. Classify edit kind:
   - test if path matches test globs;
   - docs if extension is Markdown or only comments changed in future phase;
   - format if normalized AST/text target appears unchanged in future phase;
   - otherwise logic.
5. Attach concurrency signals from Phase 3.
6. Deduplicate by `path + name + lineRange`.

Fallback: if AST parsing fails, create one `unknown` target per changed line range.

Tests:

- function edit resolves function target;
- class method edit resolves method target;
- AST failure returns unknown target;
- duplicate spans inside same function collapse to one target.

---

## Phase 3: Concurrency signal detector

Create `src/verification/concurrency-detector.ts`.

Use a two-layer detector:

1. Token/AST text scan inside the changed target range.
2. Name scan on symbol names and file names.

Keep this deterministic and cheap.

```typescript
export function detectConcurrencySignals(
  content: string,
  target: Pick<ChangedTarget, "name" | "lineRange" | "languageId">,
): ConcurrencySignal[];
```

Signal tables:

- TypeScript/JavaScript: `async`, `await`, `Promise.all`, `Promise.race`, `setTimeout`, `setImmediate`, `Worker`, `EventEmitter`.
- Java: `synchronized`, `volatile`, `Lock`, `ReentrantLock`, `Atomic`, `CompletableFuture`, `Executor`, `Thread`.
- Rust: `Arc`, `Mutex`, `RwLock`, `Atomic`, `thread::spawn`, `tokio::spawn`, `loom::model`.
- Go: `go `, `chan`, `select`, `sync.Mutex`, `sync.RWMutex`, `WaitGroup`, `atomic`.
- Python: `async`, `await`, `asyncio`, `threading`, `multiprocessing`, `Lock`, `Queue`.
- Names: `lock`, `mutex`, `race`, `atomic`, `thread`, `concurrent`, `parallel`, `queue`, `scheduler`.

Tests should prove no warning for normal functions and warning for each supported language pattern.

---

## Phase 4: Verification command runner

Create `src/verification/command-runner.ts`.

Do not reuse unbounded shell execution. Use `spawn` with args and timeout, similar to `safeSpawnAsync()` in `src/lsp/diagnostic-dispatcher.ts`.

```typescript
export interface CommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut: boolean;
}

export async function runBoundedCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputChars: number },
): Promise<CommandResult>;
```

Rules:

- No `shell: true`.
- Truncate stdout/stderr to `maxOutputChars`.
- Kill on timeout.
- Return failures as evidence, not thrown exceptions.

Tests:

- successful command;
- non-zero command;
- timeout;
- output truncation.

---

## Phase 5: Concurrency verification tools

Create `src/verification/concurrency-tools.ts`.

Implement this interface:

```typescript
interface VerificationTool {
  name: string;
  languages: string[];
  canRun(input: VerificationInput): Promise<boolean>;
  run(input: VerificationInput): Promise<ConcurrencyEvidence[]>;
}
```

MVP adapters:

1. **ConfiguredCommandTool**
   - Reads `VerificationCommand[]` from config.
   - Matches by language and optional file globs.
   - Runs the command with bounded timeout.
   - Maps non-zero exit to failed evidence.

2. **GoRaceTool**
   - Detect nearest `go.mod` or package directory.
   - Runs `go test -race` for the nearest package only.
   - Timeout default: 30s.

3. **RustLoomTool**
   - Only runs if the target range or project references `loom::model`.
   - Runs configured command if available; otherwise emit skipped note with suggested command.
   - Avoid inventing a cargo invocation that may not match the project.

4. **JvmFrayTool**
   - Detect Fray config conservatively: Gradle/Maven files plus Fray dependency/plugin or `@FrayTest`/`@ConcurrencyTest`.
   - If exact command is not obvious, emit skipped note with setup hint.
   - Prefer project-configured command for real execution.

5. **JcstressTool**
   - Detect jcstress module/jar.
   - Use project-configured command in MVP.

TypeScript/JavaScript should use `ConfiguredCommandTool` only in MVP.

---

## Phase 6: Traceability analyzer

Create `src/verification/traceability.ts`.

Inputs:

```typescript
interface AnalyzeTraceabilityInput {
  cwd: string;
  path: string;
  content: string;
  changedTargets: ChangedTarget[];
  editedPaths: string[];
  lspManager: LSPManager | null;
  config: TraceabilityConfig;
}
```

Algorithm per non-test logic target:

1. If target is docs/test/format, mark `not-applicable`.
2. Find candidate tests:
   - edited paths that match test globs;
   - LSP references in test files, if LSP is available;
   - filename/name search fallback under test globs.
3. Mark status:
   - `covered`: linked test exists and was edited or verification ran;
   - `candidate`: linked test exists but was not edited;
   - `missing`: no linked test found;
   - `not-applicable`: non-logic change.
4. Compute coverage percent over applicable targets.
5. Return notes only for `candidate` and `missing` in warn mode.

Implementation detail: avoid adding a glob dependency in v1. Use a small recursive file walker with ignored directories: `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `target`.

Tests:

- target linked by `*.test.ts` reference is candidate;
- same edit also modifies test file is covered;
- no test produces missing;
- docs/test edits are not applicable;
- LSP unavailable still uses fallback search.

---

## Phase 7: Historical context retriever

Create `src/verification/history-context.ts`.

Inputs:

```typescript
interface RetrieveHistoryInput {
  cwd: string;
  changedTargets: ChangedTarget[];
  config: HistoryConfig;
}
```

Helpers:

- `isGitRepository(cwd): Promise<boolean>` using `git rev-parse --show-toplevel`.
- `runGit(args, cwd, timeoutMs): Promise<CommandResult>` using the bounded runner.
- `getLineHistory(target)` with `git log -L start,end:path --max-count=N`.
- `getBlame(target)` with `git blame -L start,end -- path`.

Ranking:

- Parse commit hashes and subjects.
- Score higher for exact line history and risky words: `race`, `deadlock`, `flaky`, `regression`, `security`, `revert`, `workaround`, `compat`, `avoid`, `do not`, `fix`.
- Truncate to `maxCommits` and `maxChars`.

Notes:

- Skip silently when not in Git.
- Do not fetch network data.
- Do not include full diffs by default.

Tests can initialize a temporary Git repo, create two commits touching a function, then assert history evidence includes the relevant subject.

---

## Phase 8: Orchestrator

Create `src/verification/post-edit-evidence.ts`.

```typescript
export async function runPostEditEvidencePipeline(input: {
  cwd: string;
  path: string;
  content: string;
  languageId: string;
  matchSpans: Array<{ startIndex: number; endIndex: number }>;
  editedPaths: string[];
  lspManager: LSPManager | null;
  config: VerificationConfig;
}): Promise<PostEditEvidenceResult>;
```

Flow:

1. Return empty result if disabled.
2. Build changed targets.
3. Run concurrency lane if any target has signals.
4. Run traceability lane.
5. Run history lane.
6. Format notes.
7. Return details.

Keep each lane failure isolated:

```typescript
try {
  // lane
} catch (error) {
  notes.push(`ℹ evidence lane failed: ${error instanceof Error ? error.message : String(error)}`);
}
```

Do not let evidence failures turn a successful edit into a failed edit.

---

## Phase 9: Wire into `index.ts`

At the end of the existing post-edit diagnostics block, call the orchestrator.

Required local data already exists near the integration point:

- `cwd`
- `path`
- `absolutePath`
- `normalizedContent`
- `languageId`
- `resultMatchSpans`
- `lspManager`
- `matchNotes`
- `details`

Pseudo-patch:

```typescript
import { runPostEditEvidencePipeline } from "./src/verification/post-edit-evidence";
import { defaultVerificationConfig } from "./src/verification/config";

// after LSP/compiler diagnostics
const evidenceResult = await runPostEditEvidencePipeline({
  cwd,
  path: absolutePath,
  content: normalizedContent,
  languageId,
  matchSpans: resultMatchSpans.map((span) => ({
    startIndex: span.matchIndex,
    endIndex: span.matchIndex + span.matchLength,
  })),
  editedPaths: [absolutePath],
  lspManager,
  config: defaultVerificationConfig(),
});

matchNotes.push(...evidenceResult.notes);
```

Extend details:

```typescript
const details: {
  diff?: string;
  firstChangedLine?: number;
  matchNotes?: string[];
  conflictWarnings?: string[];
  evidence?: EvidenceDetails;
} = { ... };

if (evidenceResult.details.changes.length > 0) {
  details.evidence = evidenceResult.details;
}
```

If the current edit call can apply edits to multiple paths through format parsing, collect all edited paths and pass them into traceability. If not available yet, start with `[absolutePath]`.

---

## Phase 10: Optional background verification status

Only implement after inline MVP works.

Create:

- `src/verification/background-runner.ts`
- registered tool `smart_edit_verification_status`

Runtime model:

```typescript
interface VerificationRunStatus {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "passed" | "failed" | "timeout";
  command: string[];
  diagnostics: Diagnostic[];
}
```

Constraints:

- Maximum one or small fixed number of concurrent verification runs.
- Kill on timeout.
- Clear old runs from memory.
- Never run model-provided arbitrary commands.

---

## Test plan

Run narrow tests first, then full suite.

New tests:

```bash
npx tsx --test test/verification/concurrency-detector.test.ts
npx tsx --test test/verification/change-targets.test.ts
npx tsx --test test/verification/command-runner.test.ts
npx tsx --test test/verification/traceability.test.ts
npx tsx --test test/verification/history-context.test.ts
npx tsx --test test/verification/post-edit-evidence.test.ts
```

Existing suite:

```bash
cd Pi-Edit/extensions/smart-edit
npm test
```

Manual smoke cases:

1. Edit a simple TypeScript function: no concurrency note.
2. Edit an `async` function: concurrency warning appears if no command configured.
3. Edit a function referenced by `*.test.ts`: traceability reports candidate test.
4. Edit function in temporary Git repo with prior `fix race` commit: history note appears.
5. Configure a tiny verification command that exits 1: evidence reports failed command without failing the edit.

---

## Rollout order

1. Types/config.
2. Changed target builder.
3. Concurrency detector with skipped warnings only.
4. Traceability analyzer.
5. History retriever.
6. Configured command runner.
7. Ecosystem-specific adapters.
8. Optional background status tool.

This order delivers useful warnings before running any new external command.

---

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| False-positive traceability warnings | Soft warnings by default, ignore docs/test edits, include candidate tests instead of demanding changes. |
| Expensive verification commands | Short inline timeout, bounded output, configured commands only. |
| Arbitrary command execution | Never accept commands from edit input; only repository/user config. |
| Tool-specific parsing complexity | Start with command status and output excerpt, then add parsers incrementally. |
| Git history noise | Limit to edited symbol/range, rank risky commits, truncate aggressively. |
| Edit success becomes flaky | Evidence lane failures produce notes only; they do not roll back edits. |

---

## Done criteria

- Evidence details are present in successful edit results when relevant.
- Concurrency-sensitive edits produce actionable notes.
- Traceability coverage is computed for changed logic targets.
- Local Git history is retrieved for targeted symbols/ranges.
- No evidence lane can corrupt files or bypass stale-read/atomic-write safeguards.
- `npm test` passes from `Pi-Edit/extensions/smart-edit`.
