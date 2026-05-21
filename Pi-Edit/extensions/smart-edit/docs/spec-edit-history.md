# Edit History / Undo System — Implementation

> **Status**: Implemented (May 2026)
> **Files**: `src/undo/edit-history.ts`, `src/undo/atomic-write.ts`
> **Tests**: `test/edit-history.test.ts`

## 1. Overview

SmartEdit's `atomicWrite` replaces file content with no rollback mechanism.
Codex's `SharedTurnDiffTracker` showed the value of per-edit undo, so SmartEdit
adopted a lightweight, file-based undo system that captures pre-edit state before every write.

### Goals

- Capture pre-edit content for every `atomicWrite` call
- Provide programmatic undo via `restoreUndoState(path)`
- Auto-cleanup stale undo data when the session ends
- Zero impact on the hot path (async fire-and-forget save)
- No new tool registration — undo is an inline rollback mechanism

---

## 2. Data Model

### `UndoEntry` interface (stored as JSON)

```typescript
interface UndoEntry {
  /** Absolute file path that was edited */
  path: string;

  /** Pre-edit content, base64-encoded to avoid newline issues in JSON */
  originalContent: string;

  /** ISO-8601 timestamp of when the edit was applied */
  timestamp: string;

  /** How many edit items were in the batch (for display) */
  editCount: number;

  /** SHA-256 truncated hash (16 hex chars) of the pre-edit content, for verification */
  snapshotHash: string;

  /** Top-level symbols that were changed, if AST data is available */
  changedSymbols: string[];
}
```

### `DecodedUndoEntry` interface

```typescript
interface DecodedUndoEntry extends Omit<UndoEntry, "originalContent"> {
  /** Decoded pre-edit content */
  originalContent: string;
}
```

### Metadata fields rationale

| Field | Purpose |
|---|---|
| `path` | Identifies which file to restore. |
| `originalContent` | Base64 to survive JSON serialization of any binary/text content. |
| `timestamp` | Enables time-ordered history, cleanup of old entries. |
| `editCount` | UI-friendly number of changes in this batch. |
| `snapshotHash` | Verifies that the stored content matches what was actually on disk. |
| `changedSymbols` | Enables future search by symbol, and conflict detection against undo. |

---

## 3. Storage

### Directory: `.smart-edit-undo/`

All undo data lives in a single directory at the project root (resolved via `process.cwd()`).

### File naming

```
.smart-edit-undo/<hash>-<timestampISO>.json
```

- `<hash>` = first 16 hex chars of the pre-edit content SHA-256 hash (file-unique within a session)
- `<timestampISO>` = sortable ISO-8601 without colons (e.g. `2026-05-16T14-30-00-000Z`)

Example:
```
.smart-edit-undo/a1b2c3d4e5f6a7b8-2026-05-16T14-30-00-000Z.json
```

### Storage guarantees

- **No crash on write failure**: undo save is fire-and-forget, never blocks the edit.
- **No unbounded growth**: `clearUndoHistory()` removes all files in `.smart-edit-undo/`.
- **Portable**: plain JSON files, no binary format, no native dependencies.
- **Git-ignorable**: projects should add `.smart-edit-undo/` to `.gitignore`.

---

## 4. API

### Module: `src/undo/edit-history.ts`

#### `saveUndoState(cwd, path, content, editCount, changedSymbols?): Promise<void>`

1. Compute `contentHash = fastHash(content)` (first 16 hex chars of SHA-256).
2. Base64-encode content: `Buffer.from(content, "utf-8").toString("base64")`.
3. Build `UndoEntry` object.
4. Write JSON to `.smart-edit-undo/<hash>-<timestamp>.json`.
5. Swallow all errors silently (non-blocking).

**Call site**: `index.ts` — immediately before `await atomicWrite(...)`.

#### `restoreUndoState(path): Promise<boolean>`

1. List `.smart-edit-undo/` directory.
2. Find the most recent entry where `entry.path === path`.
3. Decode `originalContent` from base64.
4. Write decoded content back to `path` via `atomicWrite`.
5. Delete the undo file after restore.
6. Return `true` on success, `false` if no entry found.

**Call site**: Not called from `index.ts` — intended as a utility function that could be exposed to a future undo tool or used internally.

#### `getUndoHistory(path?, cwd?): Promise<UndoEntry[]>`

1. List `.smart-edit-undo/` directory.
2. Parse each JSON file.
3. If `path` is provided, filter entries where `entry.path === path`.
4. Sort by `timestamp` descending.
5. Return parsed entries.

#### `clearUndoHistory(cwd?): Promise<void>`

1. List `.smart-edit-undo/` directory.
2. Delete all files.
3. Remove empty directory.

---

## 5. Integration with `index.ts`

### Insertion point before `atomicWrite`

Current flow in `execute()`:

```
// ── Approval gating check (warnings only — never blocks) ──
checkEditSafety(path, edits)

// ── Save undo state before write (non-blocking, fire-and-forget) ──
saveUndoState(cwd, absolutePath, baseContent, edits.length).catch(() => {})

// Atomic write
await atomicWrite(absolutePath, finalContent);

// ── Update read cache ──
recordReadWithStat(absolutePath, cwd, finalContent, ...)
```

Where:
- `baseContent` is the pre-edit content (LF-normalized, no BOM).
- `edits.length` is the number of edit items in the batch.

### Changed symbols derivation

After the edit matching phase, the `resultMatchSpans` contain byte offsets for each successful match. Currently `changedSymbols` is mostly left empty — the AST resolver is not run for this purpose in the hot path. Future work could populate it.

---

## 6. Cleanup

### Session-end cleanup

The extension's `session_shutdown` event handler calls `lspManager?.shutdown()`. Undo data persists across sessions by design — undo files are small (one per edit batch, typically <100 files per session).

### Explicit cleanup

`clearUndoHistory()` can be called at any time to wipe undo state.

### No TTL-based auto-expiry

Undo files are small (one per edit batch). TTL logic is unnecessary at this scale.

---

## 7. Interaction with Mutation Queue

The mutation queue (`withFileMutationQueue`) serializes edits to the same file.

### Save-then-write ordering

```
withFileMutationQueue(absolutePath, async () => {
  // ... read content, compute diff, match edits ...

  // (1) Save undo — captures baseContent BEFORE write
  saveUndoState(...)

  // (2) Atomic write
  await atomicWrite(...)

  // (3) Post-write: read cache, AST validation, diagnostics
})
```

- The undo save captures the state as it was right before the write.
- Since the mutation queue guarantees serial execution, step (1) always sees the file as it was after the previous edit in the queue.
- No race condition between save and write.

### Multiple edits to the same file

Each batch creates one undo entry. If two consecutive `edit()` calls target the same file, each produces its own undo entry. `restoreUndoState(path)` restores the most recent entry, effectively a single-step undo.

### Restore and the mutation queue

`restoreUndoState()` uses `atomicWrite` internally, so the restored file goes through the same atomic write path. However, `restoreUndoState()` is NOT called inside `withFileMutationQueue` — it's a standalone operation that replaces file content directly. The undo entry is deleted after successful restore to prevent double-undo of the same state.

---

## 8. Test Plan

See `test/edit-history.test.ts` for:

| Test | What it verifies |
|---|---|
| Save and restore | `saveUndoState` + `restoreUndoState` round-trips content correctly |
| Base64 encoding survival | Content with newlines, unicode, and null bytes survives JSON |
| `getUndoHistory` filtering | Returns correct entries filtered by path |
| `clearUndoHistory` | Removes all undo files and directory |
| No-op restore | `restoreUndoState` for nonexistent path returns `false` |
| Multiple saves, latest | `restoreUndoState` returns the most recent entry for a path |
| Error tolerance | Save failure doesn't throw |
| Snapshot hash verification | Hash in entry matches `fastHash` of content |

---

## 9. File Inventory

| File | Purpose |
|---|---|
| `src/undo/edit-history.ts` | Core undo module |
| `src/undo/atomic-write.ts` | Temp-file write + rename |
| `test/edit-history.test.ts` | Tests for undo module |
| `index.ts` | Integration: `saveUndoState()` call before `atomicWrite` |
