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
