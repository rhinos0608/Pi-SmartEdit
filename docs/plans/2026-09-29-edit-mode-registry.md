# Edit mode registry, mode-aware read output, refactor → LSP

Status: approved design (2026-09-29), plan not yet executed.

## Goal

The agent sees exactly one edit dialect, chosen by operator config. Read output
matches that dialect. LSP refactors move out of `edit` into the SmartRead `LSP`
tool, which gains one explicit mutating operation backed by SmartEdit's
mutation kernel.

## Decisions (approved)

| Decision | Choice |
|---|---|
| Edit modes | `text` and `hashline` only. No standalone AST mode; AST symbol lookup survives only as an optional `scope` on text edits. |
| Config | Single operator env var `PI_EDIT_MODE=text\|hashline`, resolved in Pi-Workspace-Protocol so SmartEdit and SmartRead agree. Legacy `SMART_EDIT_USE_HASHLINE_EDITING` / `SMART_EDIT_HASHLINE_EXPERIMENTAL` still honoured when `PI_EDIT_MODE` is unset. |
| Default | `text` (unchanged). Flipping to `hashline` per `docs/hashline-benchmark-tracking.md` is a separate one-line follow-up. |
| Removed from agent-facing `edit` | `raw`, `refactor`, `lineRange`, `target` symbolic ops (`replaceBody`/`insertBefore`/`insertAfter`), ast-grep `pattern`/`replacement`. |
| Refactor home | Option A: `LSP` tool proposals get a `proposalId` when SmartEdit is loaded; new `applyProposal { proposalId }` operation applies it through SmartEdit over event-bus RPC. |

Non-goals: deleting the now-unreachable internal planners/format parsers
(`src/formats/*`, symbolic/structural planning, `lineRange` scoping). They stay
reachable from the exported `args.ts` API; dead-code removal is a follow-up
after this lands. `args.ts` (`prepareArguments`, exported from `src/index.ts`)
keeps its signature — it is public API and is not used by the registered tool.

## Stage map and ownership

```
Stage 0  commit Pi-SmartRead WIP (worker, in flight)
Stage 1  Pi-Workspace-Protocol v0.7.0  ──►  tag push needs owner approval
Stage 2  Pi-SmartEdit mode registry     ─┐ parallel (different repos)
Stage 3  Pi-SmartRead mode-aware render ─┘
Stage 4  refactor → LSP (touches SmartEdit + SmartRead; after 2 and 3)
Stage 5  cross-package verification
```

One writer per repo at a time.

---

## Stage 1 — Pi-Workspace-Protocol (v0.6.0 → v0.7.0)

Files:
- `src/edit-mode.ts` (new) — `EditMode = "text" | "hashline"`, `EDIT_MODE_ENV = "PI_EDIT_MODE"`,
  `resolveEditMode(env): { mode: EditMode; source: "env" | "legacy" | "default"; warning?: string }`.
  - `PI_EDIT_MODE` trimmed/lowercased; valid → that mode.
  - Invalid value → `text` with `warning` naming the bad value (never throw at extension load).
  - Unset → legacy booleans (`1|true|yes|on`, direct var wins over alias) → `hashline`/`text`.
  - Otherwise `text`, source `default`.
- `src/types.ts` — add `RPC_CHANNELS.workspaceEdit` and two methods to `RpcMethod`:
  `stage_workspace_edit`, `apply_staged_edit`. Payload DTOs:
  - Stage request: `{ workspaceEdit: unknown; source: { operation: string; serverDescriptorId?: string }; sessionFilePath: string; cwd: string }`
  - Stage reply: `{ ok: true; proposalId: string; files: string[]; diff: string } | { ok: false; reason: string }`
  - Apply request: `{ proposalId: string; toolCallId: string; sessionFilePath: string; cwd: string }`
  - Apply reply: `{ ok: boolean; status: "applied" | "rejected" | "failed"; text: string; diagnostics: string[]; changedFiles: string[] }`
- `src/contract.ts` — extend the `request.rpc` allowlist (currently a hard-coded `||` chain at the
  `validateEventMessage` request branch) and add `validateStageWorkspaceEditRequest` /
  `validateApplyStagedEditRequest`.
- `src/index.ts` — export `edit-mode.js`.
- `PROTOCOL_SCHEMA_VERSION` stays `5`: the change is additive; older peers reject the unknown
  method, which SmartRead surfaces as "unavailable".

Checks: `npm run typecheck && npm test` in Pi-Workspace-Protocol; new tests in
`test/edit-mode.test.ts` (all resolution branches incl. invalid value and legacy alias precedence) and
contract tests for both new request validators (accept valid, reject missing/mistyped fields).

Release: bump `package.json` to `0.7.0`, commit, tag `v0.7.0`. **Pushing the tag is outward-facing —
ask the owner first.** Consumers then change `#v0.6.0` → `#v0.7.0` in their `package.json`.

## Stage 2 — Pi-SmartEdit mode registry

Files:
- `src/edit-modes/types.ts` (new) — `EditModeSpec { id: EditMode; parameters; description: string;
  validate(input: unknown): { ok: true; value: EditRequest } | { ok: false; error: string };
  prepareArguments(args: Record<string, unknown>): Record<string, unknown> }`.
- `src/edit-modes/text.ts` (new)
  - Schema: `path?`, `edits[{ path?, oldText, newText, replaceAll?, description?, scope? }]`,
    `scope = { name?, namePath?, line? }` (at least one), `additionalProperties: false`, `required: ["edits"]`.
  - `validate`: run shared `validateEditRequest`, then reject any `raw`, `refactor`, `hashline`,
    `lineRange`, `target` key with "not supported in text edit mode"; map `scope` → internal `target`
    (identifier-only, which the planner already treats as search scoping).
  - `prepareArguments`: `normalizeFlatEditRequest` (resumed sessions), then strip read display
    prefixes `^\d+\|` from `oldText` only when **every** line carries one and the numbers are
    consecutive (guards real content that starts with `12|`).
  - Description: rewritten, short; no mention of other dialects.
- `src/edit-modes/hashline.ts` (new) — moves `HASHLINE_EDIT_PARAMETERS` and
  `validateHashlineOnlyEditRequest` from `src/edit-contract.ts`, and the hashline description array
  from `src/patch.ts` (`createPatchTool`). `prepareArguments` = identity (current behaviour).
- `src/edit-modes/index.ts` (new) — `getEditModeSpec(mode)`, `getActiveEditMode()` memoised from config.
- `src/config/schema.ts` — `SmartEditConfig.editMode: EditMode` from `resolveEditMode(env)`;
  keep `useHashlineEditing` as a derived field (`editMode === "hashline"`) for existing internal readers
  (`read-events.ts`, `multi-file-hints.ts`, `args.ts`). `src/config/edit-mode.ts` follows. Surface
  `warning` once via the existing diagnostics path at registration.
- `src/patch/types.ts` — `PatchToolDeps.useHashlineEditing` → `editMode: EditModeSpec`.
- `src/patch.ts` — `createPatchTool` takes `description`/`parameters` from `deps.editMode`.
- `src/patch/execute.ts` — `dispatchValidatedRequest` uses `deps.editMode.validate`; refactor branch deleted.
- `src/extension/register-edit.ts` — build the spec once; `prepareArguments` delegates to
  `spec.prepareArguments` after `omitAgentEvidenceRef`.
- `src/edit-contract.ts` — delete `EDIT_PARAMETERS`, `HASHLINE_EDIT_PARAMETERS`, `getEditParameters`,
  `validateHashlineOnlyEditRequest`, and the `refactor` types/validators/admission caps. `raw` stays in
  the shared internal validator for now (only `args.ts` reaches it) but no agent schema exposes it.
- `benchmark/compare.ts` — set `PI_EDIT_MODE` instead of the two legacy vars.
- `README.md` env table, `docs/hashline-spec.md` status line — document `PI_EDIT_MODE`.

Tests (write first; add every new file to the explicit list in `package.json` `scripts.test`):
- `test/edit-modes.test.ts`: text schema exposes exactly `{path, edits}` and item keys
  `{path, oldText, newText, replaceAll, description, scope}`; hashline schema unchanged; each mode's
  validator rejects the other mode's fields; text `scope` maps to `target`; display-prefix stripping
  strips consecutive `N|` blocks and leaves partial/non-consecutive ones alone.
- Update `test/edit-contract.test.ts`, `test/extension-init.test.ts` (currently assert `refactor` in the schema),
  `test/edit-mode.test.ts`, `test/admission-caps.test.ts` (refactor cases).
- `test/patch-refactor.test.ts`, `test/refactor-contract.test.ts`: validation cases are deleted with the contract;
  handler cases move to Stage 4's RPC server tests.

Checks: `npm run typecheck && npm run lint && npm test && git diff --check`.

## Stage 3 — Pi-SmartRead mode-aware read output

Single choke point: `prefixLinesWithAnchors` in `src/utils.ts`, called from
`applyTextEnrichment` (`src/read/hook-enrich.ts`) and `formatContentBlock` (`src/utils.ts`).

- Resolve mode once at activation via `resolveEditMode(process.env)` and store it on the activation
  state; thread it to both call sites (no `process.env` reads in render code).
- `prefixLinesForEditMode(body, startLine, mode)`: hashline → current `formatHashLine`; text → `${n}|${line}`.
  Text mode must not require `ensureHashlineReady()`.
- `stripHashlineAnchors` and the `alreadyAnchored` regex already accept both `N|` and `Nab|`; add tests
  that pin that.
- Tests (vitest): text mode renders `N|` with correct start offsets for partial reads; hashline mode output is
  byte-identical to today; batch/read-many and intent-read paths follow the mode.

Cross-check in SmartEdit (belongs to Stage 5): `src/extension/read-events.ts` records read authority from
text-mode `N|` output correctly (full and offset/limit reads) — add a case to `test/read-events-hashline.test.ts`
or a new `test/read-events-text.test.ts`.

Checks: `npm run typecheck && npm run lint && npm test` in Pi-SmartRead.

## Stage 4 — refactor → LSP (option A)

SmartEdit (server):
- `src/extension/register-workspace-edit-rpc.ts` (new) — `createRpcServer` on `RPC_CHANNELS.workspaceEdit`,
  registered next to the edit tool with the same session-bound `PatchToolDeps`.
  - `stage_workspace_edit` → existing `checkWorkspaceEditEncoding` + `planAndStorePreview` path in
    `src/patch/refactor-preview.ts`; returns `proposalId` (= preview id), files, bounded diff.
  - `apply_staged_edit` → existing `handleApplyRefactorPreview` checks (session binding, staleness,
    authorization) and the mutation kernel.
- Because the mutation is reported under the `lsp` tool name, SmartEdit's `tool_result`-keyed hooks will
  not fire for it. The RPC apply handler must itself run what the edit path relies on: mutation-loop guard
  observation, final-success lanes (`runFinalSuccessLanes`), read-cache refresh/invalidation, undo record.
  This is the largest regression risk; test it explicitly.
- Delete `handleRefactorRequest` dispatch and the `refactor`-kind handlers that only served the edit tool;
  keep the planning/cache/apply helpers.

SmartRead (client + agent surface):
- `src/lsp/lsp-strict-contract.ts` — add `applyProposal` to `STRICT_LSP_OPERATIONS`, `FIELD_MATRIX`
  (`["proposalId"]`), `REQUIRED_FIELDS`; add `proposalId` to the strict request type.
- `src/lsp/lsp-tool.ts` — schema gains `proposalId`; after `rename`, `resolveCodeAction`,
  `formatDocument`/`formatRange`/`formatOnType` (not `codeActions` lists — staging every entry would cost one
  RPC and one cached proposal per action per call; `resolveCodeAction` is the selection step and stages): if the SmartEdit RPC answers,
  stage the WorkspaceEdit and include `proposalId` + diff summary in the result. If it does not (SmartEdit
  absent, older protocol, timeout) the result is today's read-only proposal, unchanged.
  `applyProposal` → `apply_staged_edit`; returns SmartEdit's text/status; `unavailable` envelope when no server.
- Tool description: replace "Rename/format/codeAction results are proposals, never mutations" with
  "…are proposals; `applyProposal` is the only mutating operation and applies a staged proposal through SmartEdit".
  Also update SmartRead runtime guidance that repeats the old sentence (`src/runtime/tool-guidance.ts`; grep for it).
- Apply RPC uses its own timeout (`WORKSPACE_EDIT_APPLY_TIMEOUT_MS = 120s`), not the 2s staging
  timeout: apply commits the write and then runs the full post-edit lanes, like the edit tool.
  Once an apply request is sent, a missing/invalid reply reports `status: "unknown"` ("re-read before
  retrying") — `unavailable` is reserved for nothing-sent (no bus/session). A proposalId proves
  SmartEdit answered at stage time, so post-send silence must never read as absence.
- Staging is fail-closed on encoding: a non-utf-16 negotiated `positionEncoding` skips staging and
  keeps the read-only result. Only `rename`/`resolveCodeAction`/formatting stage; `codeActions`
  lists are staged via `resolveCodeAction` (one RPC + cached proposal per action per call is not worth it).

Tests:
- SmartEdit: RPC server stage→apply round trip against a temp file with read authority; stale file between
  stage and apply → rejected, file untouched; unknown/foreign-session proposalId → rejected; after apply, undo record
  exists and read cache reflects new content.
- SmartRead: contract accepts `applyProposal {proposalId}` and rejects foreign fields; rename result carries
  `proposalId` with a mock bus server and omits it with no server; `applyProposal` with no server → `unavailable`.

## Stage 5 — cross-package verification

- All three repos: typecheck, lint, tests, `git diff --check`.
- Live smoke in one Pi session per mode (`PI_EDIT_MODE=text`, then `hashline`): read a file → confirm prefix
  format; make one edit; LSP `rename` on a TS symbol → `applyProposal` → confirm files changed and a follow-up
  `edit` is accepted without re-read errors.
- Optional: one benchmark pass (`benchmark/compare.ts`, both modes) to confirm the text-mode schema change did
  not regress exactness vs the ledger.

## Risks

1. Mutation through a non-`edit` tool name bypasses tool_result hooks (Stage 4) — mitigated by running those
   steps inside the RPC handler and testing them.
2. Text-mode `N|` stripping could eat real content — mitigated by all-lines + consecutive-number rule.
3. Protocol tag coordination — both consumers must bump together; mismatched versions degrade to
   "unavailable" rather than failing.
4. Resumed sessions with stored `raw`/`refactor` edit calls now fail validation with a clear message.
