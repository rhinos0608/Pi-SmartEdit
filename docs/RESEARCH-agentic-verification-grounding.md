# Research: Agentic Verification and Grounding Patterns

## Scope

This document summarizes three research patterns that are relevant to smart-edit's post-edit pipeline:

1. **Concurrency-specific verification** — controlled schedule exploration for race-condition fixes.
2. **Traceability and test-artifact grounding** — linking changed behavior to executable evidence.
3. **RAG-augmented historical context** — retrieving prior maintenance context for targeted code edits.

The common theme is simple: agent output should be judged by verifiable evidence, not by a plausible explanation after the edit.

---

## Current smart-edit baseline

smart-edit already has several pieces that make these patterns feasible:

- AST-aware edit targeting via `lib/ast-resolver.ts` and `src/lsp/target-range.ts`.
- Hashline and stale-read safeguards via `lib/read-cache.ts` and `lib/hashline-edit.ts`.
- Post-edit syntax validation in `index.ts`.
- Post-edit LSP diagnostics through `src/lsp/diagnostics.ts`.
- Compiler/linter fallback through `src/lsp/diagnostic-dispatcher.ts` for TypeScript, Python, Rust, Go, and Ruby.
- LSP semantic navigation in `src/lsp/semantic-nav.ts`, including document symbols and references.

The gaps are not in editing. They are in **evidence selection**: smart-edit can report compiler errors, but it does not yet decide when a code change needs concurrency-specific checks, corresponding tests, or historical context.

---

## 1. Concurrency-specific verification

### Sources reviewed

- PASTA Lab, **"Spaghetti Bench: Evaluating AI Agents on Concurrency Bug Fixes"**, February 13, 2026.  
  <https://pastalab.org/spaghetti-bench/blog.html>
- `cmu-pasta/spaghetti-bench`, benchmark implementation.  
  <https://github.com/cmu-pasta/spaghetti-bench>
- `cmu-pasta/fray`, Fray controlled concurrency testing framework.  
  <https://github.com/cmu-pasta/fray>
- Li et al., **"Fray: An Efficient General-Purpose Concurrency Testing Platform for the JVM"**, arXiv:2501.12618.  
  <https://arxiv.org/abs/2501.12618>
- `tokio-rs/loom`, Rust concurrency permutation testing.  
  <https://github.com/tokio-rs/loom>
- `openjdk/jcstress`, Java concurrency stress harness.  
  <https://github.com/openjdk/jcstress>

### Key findings

Spaghetti Bench evaluates coding agents on 39 Java concurrency bugs: 28 smaller SCTBench tasks and 11 real Apache Kafka bugs. The authors report that normal unit tests are a poor oracle for these cases because a test can pass simply because the failing thread interleaving did not occur. Their final verification uses Fray, and agents are compared with and without access to Fray during repair.

Fray materially improves easy benchmark results. Reported Pass@1 improvements include GPT-5.2 from 95.7% to 100.0%, Gemini 3.0 Pro from 67.9% to 90.7%, and Claude Opus 4.5 from 92.9% to 99.3%. On harder Kafka bugs, absolute success remains low, although GPT-5.2 improves from 21.8% to 43.6%. This is the important nuance: concurrency tooling improves verification and iteration, but it does not replace architectural diagnosis.

Fray itself performs controlled concurrency testing for JVM programs. It explores thread interleavings without replacing normal concurrency primitives and supports deterministic replay. Its README describes support for probabilistic concurrency testing, partial-order sampling, JUnit integration, Gradle/Maven setup, and debugger support.

Other ecosystems have adjacent tools:

- Rust `loom` runs tests many times under permuted schedules and a C11-style memory model.
- OpenJDK `jcstress` stress-tests JVM, library, and hardware concurrency behavior, but many tests are probabilistic and need time.
- Go has `go test -race`, useful for data-race detection but not a full interleaving explorer.
- JavaScript/TypeScript has async race problems, but no universal Fray-equivalent runtime tool. Project-specific scheduler fuzzers or deterministic fake timers are safer than pretending a generic command exists.

### Implications for smart-edit

smart-edit should not run expensive concurrency tools after every edit. It should trigger a concurrency lane only when the changed AST target is likely concurrency-sensitive.

Good trigger signals include:

- `async` functions, `await`, `Promise.all`, `Promise.race`, timers, worker threads, event emitters.
- Java `synchronized`, `volatile`, `Lock`, `ReentrantLock`, `Atomic*`, `CompletableFuture`, executor APIs.
- Rust `Arc`, `Mutex`, `RwLock`, `Atomic*`, `tokio::spawn`, `thread::spawn`, `loom::model`.
- Go `go` statements, channels, `sync.Mutex`, `sync.RWMutex`, `sync/atomic`, `WaitGroup`.
- Names containing `lock`, `mutex`, `race`, `atomic`, `concurrent`, `parallel`, `thread`, `queue`, or `scheduler`.

The diagnostic result should be evidence-first:

- tool invoked,
- command run,
- timeout,
- failing seed or replay token if available,
- violated assertion/deadlock/race details,
- whether no suitable tool was configured.

A warning that says "changed concurrency-sensitive code; no interleaving test configured" is more valuable than silently reporting "LSP passed".

---

## 2. Traceability and test-artifact grounding

### Sources reviewed

- Jung-Hua Liu, **"Governed Agentic Software Engineering: Integrating Specification Artifacts and Procedural Workflows"**, March 28, 2026.  
  <https://medium.com/@gwrx2005/governed-agentic-software-engineering-integrating-specification-artifacts-and-procedural-workflows-19cfaac896a1>
- Wang et al., **"Scaling Human-AI Coding Collaboration Requires a Governable Consensus Layer"**, arXiv:2604.17883.  
  <https://arxiv.org/abs/2604.17883>
- Kuang et al., **"REAgent: Requirement-Driven LLM Agents for Software Issue Resolution"**, arXiv:2604.06861.  
  <https://arxiv.org/abs/2604.06861>
- Ceka et al., **"Understanding Software Engineering Agents Through the Lens of Traceability"**, arXiv:2506.08311.  
  <https://arxiv.org/abs/2506.08311>
- Chen et al., **"Rethinking the Value of Agent-Generated Tests for LLM-Based Software Engineering Agents"**, arXiv:2602.07900.  
  <https://arxiv.org/html/2602.07900v1>

Source-quality note: the exact "Governed Agentic Software Engineering" item found online is a Medium article, not a peer-reviewed paper. It is still useful as a synthesis of artifact-guided workflow practices. The arXiv sources above provide stronger research support for traceability, requirement structure, and evidence-linked validation.

### Key findings

The governed workflow article argues for durable specification artifacts, procedural workflows, and lightweight trace links: proposal → requirements/scenarios → tasks → tests → code changes. Its practical point is relevant to smart-edit: when an agent changes behavior, reviewers need to know what requirement the change satisfies and what evidence validates it.

The Agentic Consensus paper makes a stronger architectural claim. It proposes a typed consensus layer that mediates between human intent, executable artifacts, and evidence. The paper's useful principle for smart-edit is that tests and traces should link to structural claims; otherwise test results are disconnected observations.

REAgent supports the same direction from issue-resolution experiments. It treats issue descriptions as low-quality requirements, constructs structured issue-oriented requirements, refines ambiguous requirements, and reports a 17.40% average improvement in resolved issues over baselines. That suggests agents benefit when requirements are explicit before patch generation.

The traceability paper studies SWE-agent execution traces and identifies bug localization, patch generation, and reproduction test generation as core components of successful agent behavior. It argues for understanding intermediate workflow traces, not only final patches.

The agent-generated tests paper adds a caution. It finds that current agent-written tests are often observational feedback channels dominated by print statements rather than formal assertions, and changing test-writing volume does not necessarily improve final outcomes. Therefore smart-edit should not simply demand "any test changed." It should ask whether changed behavior has a plausible linked test or verification artifact.

### Implications for smart-edit

smart-edit can enforce lightweight traceability without becoming a full requirements-management system.

For each semantic edit, it can compute:

- changed targets: function, method, class, or exported symbol;
- linked tests: test files referencing the target, nearby test names, or tests edited in the same call;
- verification evidence: commands run and diagnostics returned;
- traceability coverage: percentage of changed targets with at least one linked test or explicit verification artifact.

The initial policy should be **soft warning by default**, not hard blocking. A good warning is:

> Traceability warning: edited `createOrder` in `src/service.ts`, but no linked test file or test reference was changed. Existing references found in `service.test.ts`. Consider updating or running a targeted test.

This nudges the agent toward evidence while preserving legitimate refactors, docs-only edits, and emergency changes.

---

## 3. RAG-augmented historical context

### Sources reviewed

- Shanto, Asaduzzaman, and Ngom, **"RAG-Reflect: Agentic Retrieval-Augmented Generation with Reflections for Comment-Driven Code Maintenance on Stack Overflow"**, arXiv:2604.22217, submitted April 24, 2026.  
  <https://arxiv.org/abs/2604.22217>

### Key findings

RAG-Reflect targets Valid Comment–Edit Prediction: deciding whether a user comment directly triggered a later code edit. Its architecture has a one-time interpretation phase that derives validation rules from a knowledge base, then a runtime pipeline:

1. retrieve similar historical examples,
2. reason about the current comment/edit pair,
3. reflect on the decision using pre-established rules.

The paper reports Precision 0.81, Recall 0.74, and F1 0.78 for valid cases on the SOUP benchmark. Its ablation study shows that retrieval and reflection contribute different strengths: RAG-only valid F1 is 0.60, reflection-only valid F1 is 0.73, and full RAG-Reflect valid F1 is 0.78.

The key design insight is not "add embeddings everywhere." It is the loop: retrieve similar maintenance history, reason against the current change, then apply explicit validation rules before deciding.

### Implications for smart-edit

smart-edit already knows the target AST node for many edits. That makes historical retrieval cheap and precise.

Useful historical signals include:

- `git log -L :symbol:path` or line-range history for the edited function/class;
- recent commit messages touching the same file;
- `git blame` for the target range;
- commit messages containing maintenance cues like `race`, `deadlock`, `regression`, `compat`, `security`, `do not`, `avoid`, `revert`, `flaky`, or `workaround`;
- nearby comments that mention constraints or prior bugs.

The first version should not try to summarize entire repository history. It should retrieve a small, local packet and return it as evidence:

> Historical context: `processQueue` was changed in 2026-03-12 commit `abc123` "fix race during shutdown". Current edit touches the same lock acquisition block. Verify the shutdown race test before finalizing.

This can prevent agents from accidentally reverting undocumented bug fixes. It also supports the traceability lane by treating commit history as provenance evidence.

---

## Cross-cutting design lessons

1. **Diagnostics should be evidence packets.** Return commands, references, tests, historical commits, and failure details.
2. **Use soft warnings first.** Hard blocking should be opt-in because test discovery and history retrieval can produce false positives.
3. **Trigger narrowly.** Expensive checks should run only for relevant AST targets or configured projects.
4. **Keep tools configurable.** Concurrency testing is ecosystem-specific. smart-edit should provide adapters and config, not invent one universal tool.
5. **Separate verification from narration.** The agent can still explain its reasoning, but smart-edit should supply grounded artifacts that reviewers can inspect.

---

## Recommended product direction

Add a **post-edit evidence pipeline** after the existing syntax/LSP/compiler diagnostics:

```text
Edit applied
  → AST syntax validation
  → LSP diagnostics
  → compiler/linter fallback
  → evidence pipeline
       → concurrency-sensitive change detection
       → traceability/test link analysis
       → historical context retrieval
  → advisory notes + structured details
```

This keeps smart-edit's edit path stable while making its feedback more useful for agentic engineering workflows.
