# Agent Reference: Pi-SmartEdit Sister Repos

Pi-SmartEdit is the Pi coding agent's `edit`/`write` extension. It relies on two local sister codebases for serialized workspace-evidence contracts and read-state coordination.

## `/Users/rhinesharar/Pi-Workspace-Protocol`

- **Package:** `@rhinos0608/pi-workspace-protocol` (pinned in `package.json` as `github:rhinos0608/Pi-Workspace-Protocol#v0.3.0`).
- **Purpose:** Versioned TypeScript contracts, SHA-256/id helpers, runtime validators, and an event-bus RPC layer for the SmartRead/SmartEdit inspect+patch protocol.
- **What Pi-SmartEdit consumes:**
  - `src/index.ts` imports `createRpcClient` and `RPC_CHANNELS`.
  - `src/patch.ts` imports validators/types: `PROTOCOL_SCHEMA_VERSION`, `hashSessionFilePath`, `inspectionIdFor`, `resourceIdFor`, `sha256OfString`, `validatePatchRequest`, `WorkspaceEvidenceEnvelope`, `InspectedResource`, `LineRange`, `PatchDetails`, `EvidenceRef`, `CheckRecord`, `ResourceInvalidation`, `PostEditEvidence`, `RpcMethod`.
  - `createPatchTool` receives `PatchToolDeps.getRpcClient`, which `src/index.ts` wires as `() => createRpcClient({ bus, channel: RPC_CHANNELS.inspectPatch, timeoutMs: 2000 })`.
  - `patch.ts` calls `rpc.request("resolve_evidence", ...)` to fetch a `WorkspaceEvidenceEnvelope`, then validates `sessionId` via `hashSessionFilePath`, `canonicalWorkspaceRoot`, resource coverage (`full-file`/`line-range`), and `fullFileSha256` freshness.

## `/Users/rhinesharar/Pi-SmartRead`

- **Package:** `pi-read-many` (GitHub: `rhinos0608/Pi-SmartRead`).
- **Purpose:** Code-intelligence extension providing `read`, `read_files`, `read_multiple_files`, `search`, `repo_map`, `symbol`, `graph_mutate`, plus read tracking/hygiene and the RPC resolver that answers `resolve_evidence`.
- **What Pi-SmartEdit consumes:**
  - `src/index.ts` subscribes to `tool_result` for `read`, `read_files`, `read_multiple_files`, and `intent_read`, then calls `recordRead`/`recordReadSession` from `src/core/read-cache.ts` so edits are allowed only against seen/read files.
  - `src/index.ts` also records `write` tool results as reads (`recordRead` + `recordReadSession`) to support write-then-edit flows.
  - `src/smartread-bridge.ts` exports `recordBreakage` and `recordCoChange`, which append JSONL mutation events to `.pi-smartread/graph-mutations.jsonl` for Pi-SmartRead's context graph.
  - `src/patch.ts` queries Pi-SmartRead's resolver over `RPC_CHANNELS.inspectPatch` for evidence authorization.

## Coordination note

`@rhinos0608/pi-workspace-protocol` has no independent versioning gate beyond the git tag pin in `package.json`. Changes to shared types (`WorkspaceEvidenceEnvelope`, `InspectedResource`, `EvidenceRef`, etc.) must be version-bumped and accompanied by compatible consumer updates in both Pi-SmartEdit and Pi-SmartRead.

## Operational Contracts and Invariants

### Risk warnings are WARN-ONLY / ADVISORY — never blocks edits
`src/safety/approval-gating.ts:checkEditSafety` is wired into the patch pipeline (`src/patch.ts:966` for topology-only delete, `src/patch.ts:1238` for text/topology groups) and emits advisory warnings into `checks.advisory` with outcome `"pass"` and check id `risk-warning`. It was accidentally lost in the refactor that removed the legacy edit tool (git-confirmed regression at `a7548f6`). It was restored in the most recent review cycle.

**Do NOT wire `assertEditableFile`** (the blocking companion function in the same file). That would silently start blocking edits — a product-scope decision requiring explicit approval, not a routine bug fix.

Default `SMART_EDIT_APPROVAL_LEVEL` is `prompt_on_dangerous` (not `never_prompt` as docs previously stated — corrected). The env/type names are kept for compatibility; the behavior is advisory risk warnings only, never a blocking approval gate.

### atomicWrite — single source of truth
`src/patch.ts` imports `atomicWrite` from `src/undo/atomic-write.ts` (which preserves file mode bits, handles EXDEV cross-device fallback, and uses security-restrictive 0o600 on temp files). Do not re-create a local `atomicWrite` implementation — mode-bit loss on patch writes is a real risk for scripts with execute permission.

### String.replace() with user-controlled replacement text is banned in edit paths
`String.prototype.replace(string, replacement)` interprets `$-patterns` (`$&`, `` $` ``, `$'`, `$$`) in the replacement string. Slice-based or split/join replacement is required. Fixed in `src/patch.ts:814-818` (slice-based). The `edit-diff.ts` pipeline uses slice-based replacement throughout — keep it that way.

### reconstructOldText completeness validation
`src/core/hashline-edit.ts:1329-1330` validates that every line in the anchor range has a corresponding entry before returning reconstructed text. If the anchor coverage is incomplete, return `null` (fuzzy fallback). Identical pattern at line 1357 in `reconstructOldTextByLine`. New anchor-reconstruction functions must follow the same completeness-check pattern.

### Evidence contract (shared with Pi-Workspace-Protocol, Pi-SmartRead)
Pi-SmartEdit is the **consumer** side of the workspace-evidence contract. `src/patch.ts` requests `resolve_evidence` over `RPC_CHANNELS.inspectPatch`, then validates:
- `sessionId` via `hashSessionFilePath`
- `canonicalWorkspaceRoot` match
- Resource coverage (`full-file` → strong; `line-range` → strong for covered range; `search-match` / `metadata-only` → weak, requires re-read)
- `fullFileSha256` freshness against current file content (for `full-file` coverage only)

The `canonicalPath` in received envelopes MUST be a true `realpathSync` result (Pi-Workspace-Protocol's contract — symlinks resolved). If Pi-SmartRead sends a non-canonical path, SHA-256 freshness checks will fail or authorize edits against the wrong file.

### Workspace/cwd scope is an evidence-export boundary, NOT a mutation gate — regression precedent
A prior session, while implementing evidence-coverage generation, added a `currentCanonicalWorkspaceRoot` containment check inside evidence-minting code (`buildMutationEvidence` in `src/index.ts`). That check was legitimate for its stated purpose — only mint/export evidence that belongs to this session's workspace root. But the same session, and `authorizeResource`/`canonicalizeContainedPath` gates it introduced in `src/patch.ts`, drifted into rejecting *mutations* (edits/writes) whose target path was outside the canonical cwd. That is a different, unrequested policy: it silently broke legitimate cross-repo/cross-folder edit workflows, with no user request or flagged decision. A later session found and removed the hard mutation-path containment gates, keeping only the evidence-provenance check (`sessionId`/`canonicalWorkspaceRoot` equality in `src/evidence-authority.ts` and `WorkspaceEvidenceEnvelope` validation), and added regression coverage proving an out-of-workspace target can still be edited when valid evidence exists.

**Rule for future sessions:** workspace/cwd scoping may gate what evidence is trusted or exported. It must never silently become a gate on which file paths can be mutated — that is a distinct, product-level policy decision. Do not introduce new hard-rejection boundaries (path containment, mutation scope restrictions, or similar) as a side effect of implementing an adjacent feature (e.g. "add evidence coverage"). If a change could plausibly restrict what the tool is willing to do — not just what it trusts — flag it explicitly to the user or ask before merging it in, even if it feels like a natural/defensive addition to the requested feature.

**Epistemic rule:** when asked to justify or explain past reasoning, verifying against the *current* code is not evidence about whether an *earlier* interpretation, decision, or implementation was correct — especially when the current code was corrected by a later session/patch. Distinguish clearly between "the code is right now" and "my earlier reasoning/change was right"; check git history/diffs to answer the second question, and say so explicitly when history hasn't actually been checked yet.
