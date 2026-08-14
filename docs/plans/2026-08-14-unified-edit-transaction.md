# Unified Edit Transaction Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every advertised SmartEdit capability agent-invocable through one `edit` tool and one failure-atomic transaction lifecycle.

**Approach:** Keep existing parsers, matchers, AST/hashline engines, diagnostics, and safety modules. Add one canonical tool contract, normalize every input mode into staged mutations against immutable snapshots, then authorize, verify, commit, rollback, persist undo, and publish evidence through one coordinator. Implement as serial vertical slices with one writer; current uncommitted changes remain user-owned and must be preserved.

**Riskiest assumption:** Pi tool-result events reliably expose validated `details.workspaceEvidence` for prior SmartRead reads/inspections. If runtime tests disprove this, keep the same `PriorAuthorityStore` interface and populate it from existing read-session tracking plus evidence RPC; do not return caller control over `evidenceRef`.

## Decisions to review

- **One public mutation tool:** keep `edit`; do not add a parallel rich-patch tool. Late change would duplicate agent guidance and safety behavior.
- **Tool-owned evidence policy B:** agent-visible schema omits `evidenceRef`. Latest strong prior authority for a canonical path is reused; prior line-range authority is never widened by omission. Full-file auto-inspection occurs only when no strong prior authority exists.
- **Outside-workspace paths allowed:** SmartEdit canonicalizes targets but does not enforce workspace containment. Container/runtime policy owns filesystem confinement. Add a regression test so future security cleanup does not silently change product behavior.
- **Approval remains advisory:** wire `checkEditSafety`; never wire `assertEditableFile` without separate approval.
- **Atomicity claim:** failure-atomic for handled process failures, with explicit rollback outcome. Do not claim power-loss or instantaneous cross-file filesystem atomicity.
- **No dependency or protocol bump:** rich edit request schema is SmartEdit-owned. Pi-Workspace-Protocol remains evidence/lifecycle transport. Add SmartEdit-local optional result fields where v3 lacks multi-file detail.
- **Compatibility:** flat `oldText`/`newText`, current edit arrays, legacy path metadata, `anchor`, `lineRange`, `target`, hashline objects, and raw formats remain accepted through adapters.

## Known unknowns

- **Tool-result evidence availability:** default to validated envelope tracking. Pivot only if extension integration test shows missing evidence details; fallback stays internal and tool-owned.
- **Mixed-operation overlap:** default reject any intersecting non-zero spans and ambiguous same-position operations. Same-position inserts use request order. Add composition only when a concrete supported use case fails.
- **Repair scope:** default accept repaired content only when resulting changed ranges remain authorized. Otherwise retain original staged candidate and report skipped repair; never widen authority.
- **Cross-file compiler visibility:** existing advisory compiler behavior remains. Configured blocking verifiers run through the coordinator contract; no temporary workspace mirror unless tests prove required.

## Global constraints

- Preserve current dirty worktree; no reset, restore, checkout, broad formatting, or unrelated cleanup.
- Reuse `src/undo/atomic-write.ts`; do not create another atomic-write implementation.
- Replacement text remains slice-based; never pass user-controlled replacement strings to `String.replace(string, replacement)`.
- Hashline anchor reconstruction retains completeness checks.
- No new dependency.
- No commit, push, release, or sister-repository mutation without explicit approval.
- One writer in active worktree. Read-only reviewers may run in parallel after each milestone.
- Baseline evidence on 2026-08-14: `test/patch.test.ts` 31/31 passed, `test/extension-init.test.ts` 9/9 passed, `npx tsc --noEmit` exited 0; `npm run lint` failed at `src/patch.ts:906` because of `as any`.

---

## File ownership map

- `src/edit-contract.ts` — sole agent request schema, runtime validator, compatibility normalization.
- `src/evidence-authority.ts` — per-session latest-strong authority tracking and selection.
- `src/edit-planner.ts` — convert validated operations/raw formats into immutable-snapshot resolved mutations.
- `src/edit-transaction.ts` — multi-path locks, snapshots, staging, commit, rollback, and transaction result.
- `src/patch.ts` — thin Pi tool adapter and lifecycle/result assembly.
- `src/index.ts` — extension registration, session dependencies, SmartRead evidence ingestion, AST/LSP lifecycle.
- Existing capability modules remain specialized engines; they do not write files.
- `src/undo/atomic-write.ts` — mode-preserving update and no-clobber create primitives.
- `src/undo/edit-history.ts` — successful transaction undo records with before/after hashes and modes.
- `src/mutation-queue.ts` — deterministic multi-path serialization that never releases while work continues.
- `test/edit-contract.test.ts`, `test/evidence-authority.test.ts`, `test/edit-planner.test.ts`, `test/edit-transaction.test.ts`, `test/edit-tool-capabilities.test.ts` — public behavior tests.

### Task 1: Canonical contract reaches registered tool

**Outcome:** Registered `edit` schema advertises targeted edits and mutually exclusive `raw` input from one source; current exact-text calls and resumed flat calls remain valid.

**Files:**
- Create: `src/edit-contract.ts`, `test/edit-contract.test.ts`
- Modify: `src/index.ts`, `src/patch.ts`, `src/args.ts`, `src/core/types.ts`, `test/extension-init.test.ts`
- Replace: `src/patch.ts`'s `PATCH_PARAMS_DOC` as registration source; do not leave parallel request schemas.

**Interfaces:**
- Consumes: current patch request shape and `prepareArguments` compatibility behavior.
- Produces: `EditRequest`, `EditOperation`, `EDIT_PARAMETERS`, `validateEditRequest`, `normalizeLegacyEditRequest`.

**Checks:**
- Red signal: `npx tsx --test test/edit-contract.test.ts test/extension-init.test.ts` fails because registered schema lacks `raw`, `target`, `lineRange`, and `hashline`.
- Green signal: same command passes; schema and validator reject `raw`+`edits`, accept current edit arrays, and hide/ignore agent-supplied `evidenceRef` without breaking stored calls.

- [ ] Write one registration-level test capturing `pi.registerTool` parameters and validating current text call plus one rich field.
- [ ] Implement minimal canonical contract and switch registration/runtime validation to it.
- [ ] Add raw/edit exclusivity and remaining compatibility cases incrementally.
- [ ] Remove dead `editItemSchema` only after registration tests prove parity.
- [ ] Run focused checks and `npx tsc --noEmit`.

### Task 2: Tool-owned prior authority

**Outcome:** Latest strong prior authority controls each path; omission cannot widen line-range coverage; absent prior authority triggers internal full-file inspection.

**Files:**
- Create: `src/evidence-authority.ts`, `test/evidence-authority.test.ts`
- Modify: `src/index.ts`, `src/patch.ts`, `test/patch.test.ts`

**Interfaces:**
- Consumes: validated `WorkspaceEvidenceEnvelope`, session ID, canonical workspace root, resource timestamps/arrival sequence.
- Produces: `PriorAuthorityStore.record(envelope)`, `select(canonicalPath)`, and a `PatchToolDeps.getPriorAuthority` dependency.

**Checks:**
- Red signal: prior line-range envelope followed by evidence-less out-of-range edit currently applies through synthetic full-file authority.
- Green signal: out-of-range edit rejects unchanged file; in-range edit applies; stale prior authority rejects without auto-inspection; no prior strong authority auto-inspects; outside-workspace target remains allowed.

- [ ] Add an extension integration probe that emits a representative SmartRead `tool_result` with `details.workspaceEvidence`, then proves `src/index.ts` records it. If real runtime shape differs, pivot behind `PriorAuthorityStore`; do not weaken policy.
- [ ] Add authority-store unit tests: latest strong wins, newer line-range supersedes older full-file, weak evidence does not authorize, session/root mismatch ignored.
- [ ] Ingest validated SmartRead envelopes from tool-result details in `src/index.ts`.
- [ ] Select prior authority before building synthetic evidence; never use agent-supplied authority.
- [ ] When newer line-range authority supersedes older full-file authority, return an actionable diagnostic requiring a fresh full-file read to widen authority again.
- [ ] Consolidate duplicated authorization into one path-aware helper used by tests and execute flow.
- [ ] Require freshness hash for any selected prior line-range authority; reject missing hash rather than silently skipping freshness.
- [ ] Run authority and patch tests.

### Task 3: Fuzzy text, AST scope, line range, and closest diagnostics

**Outcome:** Registered tool routes text edits through existing `applyEdits`, including configured fuzzy tiers, `replaceAll`, AST target scope, line-range scope/intersection, literal replacement text, conflict metadata, and closest-match errors.

**Files:**
- Create: `src/edit-planner.ts`, `test/edit-planner.test.ts`
- Modify: `src/anchor-resolution.ts`, `src/core/types.ts`, `src/patch.ts`, `src/context-guard-check.ts`
- Reuse: `src/core/edit-diff.ts`, `src/core/conflict-detector.ts`

**Interfaces:**
- Consumes: validated text operations, immutable file content, AST resolver, runtime fuzzy config.
- Produces: per-path staged content, actual `MatchSpan[]`, affected preimage line ranges, match notes, capabilities used.

**Checks:**
- Red signal: registration-level similarity match and scoped duplicate match fail through current exact `indexOf` path.
- Green signal: public execute call reaches fuzzy match, closest diagnostic, AST target, line range, combined scope, replaceAll, and literal `$` replacement behavior.

- [ ] Add one fuzzy tracer test through public tool execute; route plain text through `applyEdits`.
- [ ] Add line-range and AST-target tests; implement scope intersection without whole-file fallback when authority is narrower.
- [ ] Add closest-match and ambiguity diagnostics tests.
- [ ] Add overlap/conflict tests against immutable snapshot.
- [ ] Preserve actual resolved spans for later authorization and verification.
- [ ] Route writes through existing `src/patch.ts` commit path during this capability slice; failure-atomicity arrives in Task 7. Do not create a temporary transaction engine.
- [ ] Run planner, patch, legacy edit-diff, context-guard, and conflict tests.

### Task 4: Symbolic and structural operations

**Outcome:** `replaceBody`, `insertBefore`, `insertAfter`, and ast-grep operations execute through registered tool and return resolved spans without direct writes.

**Files:**
- Modify: `src/edit-planner.ts`, `src/symbolic-edits.ts`, `src/astgrep-anchor.ts`, `test/edit-planner.test.ts`
- Create/modify: `test/edit-tool-capabilities.test.ts`

**Interfaces:**
- Consumes: symbol/structural operations and immutable snapshot.
- Produces: same resolved-mutation contract as text operations.

**Checks:**
- Red signal: registered tool rejects or strips symbol/ast-grep fields.
- Green signal: public calls modify intended symbol/pattern; unresolved/ambiguous targets fail before writes; mixed operations reject overlaps; same-position inserts preserve request order.

- [ ] Add symbolic replace tracer, then before/after insert cases.
- [ ] Adapt symbolic engine output to resolved mutations rather than independent filesystem lifecycle.
- [ ] Add structural operation tracer and unavailable-engine diagnostic.
- [ ] Add mixed-operation ordering and overlap tests.
- [ ] Route writes through existing `src/patch.ts` commit path during this capability slice; failure-atomicity arrives in Task 7.
- [ ] Run symbolic, AST, capability, planner, and patch tests.

### Task 5: Hashline operations

**Outcome:** Hashline edits, stale-anchor rebase, AST-scoped fallback, full fuzzy fallback, and mismatch diagnostics execute through registered tool while preserving authority bounds.

**Files:**
- Modify: `src/edit-planner.ts`, `src/core/hashline-edit.ts`, `src/hashline-batching.ts`, `src/patch.ts`, `test/edit-tool-capabilities.test.ts`

**Interfaces:**
- Consumes: hashline operation, read snapshot anchors, immutable current content, optional symbol scope.
- Produces: resolved mutations/spans, fallback tier notes, corrected-anchor diagnostics.

**Checks:**
- Red signal: registered tool rejects hashline-only operation.
- Green signal: fast path, rebase, scoped fallback, full fuzzy fallback, and mismatch rejection are reachable through public execute; final changed ranges remain inside selected authority.

- [ ] Add public hashline fast-path tracer.
- [ ] Adapt existing hashline results into staged mutation contract without reimplementing anchor logic.
- [ ] Add fallback/mismatch public-path tests.
- [ ] Add repair/coverage regression proving fallback cannot escape prior line-range authority.
- [ ] Route writes through existing `src/patch.ts` commit path during this capability slice; failure-atomicity arrives in Task 7.
- [ ] Run hashline suites, capability tests, and patch tests.

### Task 6: Raw format normalization

**Outcome:** JSON strings, search/replace blocks, unified diff, OpenAI patch, Codex patch, Atomic Patch envelopes, forgiving JSON, and streaming progress normalize into transaction intents; no raw parser writes files.

**Files:**
- Modify: `src/edit-contract.ts`, `src/edit-planner.ts`, `src/args.ts`, `src/formats/atomic-patch.ts`, `src/patch.ts`, `test/edit-tool-capabilities.test.ts`
- Reuse: remaining `src/formats/*` parsers.

**Interfaces:**
- Consumes: `raw` string plus optional default path.
- Produces: text/add/delete/rename intents using same planner and transaction lifecycle.

**Checks:**
- Red signal: public raw call fails schema validation.
- Green signal: one public test per advertised format reaches staging; malformed input reports parser diagnostics; Atomic Patch add/delete/update/rename produces intents and performs no parser-side write.

- [ ] Add one search/replace raw tracer; wire format detection and conversion.
- [ ] Add formats incrementally, one red/green case each.
- [ ] Split Atomic Patch parsing from its legacy executor; retain executor only as compatibility wrapper delegating to coordinator until callers are migrated.
- [ ] Verify streaming updates do not affect final semantics.
- [ ] Route writes through existing `src/patch.ts` commit path during this capability slice; failure-atomicity arrives in Task 7.
- [ ] Run format, atomic-patch, streaming, contract, and capability tests.

### Task 7: Failure-atomic multi-file transaction

**Outcome:** All paths stage before first write; handled write/verify failure rolls back prior changes and reports exact rollback outcome. Updates preserve modes, and raced new-file creation is never overwritten.

**Files:**
- Create: `src/edit-transaction.ts`, `test/edit-transaction.test.ts`
- Modify: `src/mutation-queue.ts`, `src/undo/atomic-write.ts`, `src/patch.ts`, `test/patch.test.ts`

**Interfaces:**
- Consumes: per-path staged plan, snapshots, verification callbacks, abort signal.
- Produces: applied or failed transaction with diffs, actual changed resources, and `{attempted, ok, restored, failed}` rollback details.

**Checks:**
- Red signal: existing mid-batch failure leaves earlier file modified; raced creator can be overwritten.
- Green signal: injected failure at each commit/verify position restores content, modes, existence, and rename topology; create race returns conflict without overwrite; two overlapping calls never lose a write.

- [ ] Add update-only two-file rollback tracer before changing commit path.
- [ ] Add sorted multi-path locking that holds until worker truly finishes; do not reuse timeout behavior that releases while work continues.
- [ ] Capture every snapshot and finish every stage/check before first write.
- [ ] Extend atomic-write module with no-clobber create primitive using same-directory temporary data.
- [ ] Add delete/rename backup and reverse rollback for raw file operations.
- [ ] Recheck fingerprints immediately before commit and before destructive rollback.
- [ ] Keep cancellation deferred until commit/rollback completes.
- [ ] Run transaction, atomic-write, mutation, patch, and capability tests.

### Task 8: Undo with content and mode integrity

**Outcome:** Successful transaction persists undo records that restore only when current content matches transaction `afterSha`, including create/delete/rename and original modes.

**Files:**
- Modify: `src/undo/edit-history.ts`, `src/edit-transaction.ts`, `test/edit-history.test.ts`, `test/edit-transaction.test.ts`

**Interfaces:**
- Consumes: successful transaction snapshots and final hashes.
- Produces: versioned transaction undo record; backward reader for existing entries.

**Checks:**
- Red signal: current restore compares edited content to pre-edit hash and rejects normal undo.
- Green signal: update undo restores bytes+mode; changed-after-edit refuses overwrite; create undo deletes only matching file; delete/rename restore topology; failed/rolled-back transaction creates no successful undo record.

- [ ] Add normal update-undo red test.
- [ ] Version stored format with `beforeSha`, `afterSha`, mode, existence, operation, transaction ID.
- [ ] Keep legacy entries readable where safe; never guess missing `afterSha` for destructive restore.
- [ ] Persist only after final transaction success.
- [ ] Run undo and transaction tests.

### Task 9: Verification, repair, diagnostics, and SmartRead bridge

**Outcome:** Existing structural, LSP/compiler, scoped diagnostics, verification evidence, repair, conflict, anchor-delta, undo, and SmartRead bridge modules run in defined transaction phases and appear in result details.

**Files:**
- Modify: `src/edit-transaction.ts`, `src/patch.ts`, `src/index.ts`, `src/verification/repair-loop.ts`, `src/verification/post-edit-evidence.ts`, `src/smartread-bridge.ts`, `test/verification/repair-loop.test.ts`, `test/verification/post-edit-evidence.test.ts`, `test/edit-tool-capabilities.test.ts`
- Ownership: `src/patch.ts`/coordinator emits bridge events after final transaction outcome; `src/index.ts` only injects bridge dependencies.

**Interfaces:**
- Precommit: approval advisory, structural checks, configured blocking/advisory verifiers, scoped repair with reauthorization.
- Post-provisional commit while locked: filesystem-dependent blocking checks; failure triggers rollback.
- Final success: advisory LSP/compiler/scoped diagnostics, traceability/history/concurrency evidence, SmartRead invalidation and bridge events.

**Checks:**
- Red signal: public edit result lacks advertised pipeline evidence and repair cannot return usable repaired content.
- Green signal: capability test observes each configured lane; blocking verifier rolls back all files; advisory failure does not; repair outside authority is skipped/rejected; bridge events publish only for final success.

- [ ] Add one public pipeline tracer with injected checks.
- [ ] Replace the approval-gating `as any` call with a typed operation adapter and remove the residual deleted-atomicWrite comment; this milestone must clear the known lint error.
- [ ] Return repaired candidate content from repair loop and re-plan/re-authorize its diff.
- [ ] Wire LSP/compiler fallback and scoped diagnostics per path.
- [ ] Run post-edit evidence once per successful transaction with all edited paths.
- [ ] Publish invalidations/co-change/breakage only after final state is known.
- [ ] Run verification, LSP, diagnostics, bridge, transaction, and capability tests.

### Task 10: Result contract, parity gate, and documentation

**Outcome:** Result truthfully reports transaction/rollback, per-path authority/evidence/diffs, capabilities used, and compatibility fields; README claims match end-to-end tests.

**Files:**
- Modify: `src/patch.ts`, `src/core/types.ts`, `test/patch.test.ts`, `test/edit-tool-capabilities.test.ts`, `README.md`, relevant `docs/spec-*.md`, `package.json`

**Interfaces:**
- Produces SmartEdit-local optional fields: transaction metadata, authority-by-path, post-edit evidence-by-path, capabilities used.
- Retains v3 `PatchDetails.postEditEvidence` for single-file/backward compatibility.

**Checks:**
- Red signal: multi-file result exposes only last file post-edit evidence and README capability claims lack public-path tests.
- Green signal: result arrays cover every path; rollback result matches disk; every README capability maps to named end-to-end test.

- [ ] Add per-path result tests for success, prewrite rejection, rollback success, and rollback failure.
- [ ] Remove no-op/inconsistent `finalize` path or make one finalizer own all result assembly.
- [ ] Update README flow, evidence policy B, outside-workspace policy, and failure-atomic limitation.
- [ ] Correct package author/repository metadata only from verified project values; leave unknown values unchanged.
- [ ] Run focused result/docs checks.

## Final verification and review

- [ ] Run `npx tsx --test test/edit-contract.test.ts test/evidence-authority.test.ts test/edit-planner.test.ts test/edit-transaction.test.ts test/edit-tool-capabilities.test.ts`.
- [ ] Run `npx tsx --test test/patch.test.ts test/extension-init.test.ts test/atomic-write.test.ts test/edit-history.test.ts test/symbolic-edits.test.ts test/hashline-edit.test.ts test/hashline-scoping.test.ts test/formats.test.ts test/atomic-patch.test.ts`.
- [ ] Run `npm run test:v`.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npm run lint`.
- [ ] Run `npm test`.
- [ ] Run `git diff --check`.
- [ ] Review full diff against every locked decision and current user-owned baseline.
- [ ] Launch fresh read-only reviewers for correctness/rollback, capability parity, evidence policy, and simplicity. Verify every accepted finding with focused test before fixing.
- [ ] Report any check that could not run as unverified; do not claim crash atomicity, workspace confinement, or protocol migration.
