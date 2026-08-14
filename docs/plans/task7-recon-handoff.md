# Task 7 Recon: Failure-Atomic Multi-File Transaction

> Read-only recon for `docs/plans/2026-08-14-unified-edit-transaction.md` Task 7.
> Scope: current write/race/rollback behavior, test seams, smallest transaction module contract.

---

## 1. Current Write Path (`src/patch.ts`)

### Sequential per-file loop, no cross-file rollback

`createPatchTool().execute()` (lines 447–1108) processes `groups` in order:

1. **Resolve canonical path** (line 683–703): `realpathSync` or skip for new files.
2. **Select authority** (line 709–746): prior authority store or envelope resource.
3. **Read + SHA** (line 749–774): `safeReadUtf8` + `sha256OfString`.
4. **Stage via planner** (line 845–874): `planTextEdits()` returns `newContent` (no writes).
5. **Authorize resolved spans** (line 876–893): `checkResourceCoverage` against `preimageLineRanges`.
6. **Run verifiers** (line 896–929): blocking/advisory checks, 5s timeout.
7. **Blocking gate** (line 931–943): failed blocking check → reject before write.
8. **Pre-write re-read SHA** (line 946–974): TOCTOU guard, rejects stale.
9. **Advisory approval gating** (line 976–990): `checkEditSafety` → warnings only.
10. **Atomic write** (line 992–1006): `mkdirp` + `atomicWriteFile(canonicalTarget, newContent)`.
11. **Record invalidation** (line 1008–1019): immediately after write.
12. **Post-write verify** (line 1022–1048): re-read + SHA mismatch check.

**Critical gap (lines 10–13, docstring):**  
> "If a later file in the batch fails, files already written earlier in the batch remain on disk as written."

There is **no rollback**. If file 2 of 3 fails at stage/write/verify, files 1 stays modified.

### Pre-write re-read guard (Fix #6, line 946–974)
SHA re-check between plan and write prevents concurrent-writer stale injection. This is the only race protection.

---

## 2. `src/undo/atomic-write.ts` (139 lines)

**Single-file atomic write:** temp file → mode copy → rename.  
- Temp file: `.{base}.smart_edit_tmp_{hex}` in same directory (line 44).
- Mode preservation: stat existing → apply after rename (lines 52–88).
- EXDEV fallback: write to target-filesystem temp → rename (lines 100–134).
- Cleanup: unlink temp on failure (lines 94–98).

**No-clobber create:** `atomicCreate` — temp file + `link(2)`, `EEXIST` on a concurrent creator. Used for create flows; `patch.ts` `write()`/`create()` route new files through it.

**Mode from source:** `modeSource` option copies mode from another file (lines 52–59).

**Tests** (`test/atomic-write.test.ts`, 134 lines): write, mode preservation, modeSource, no-partial-reads, cleanup-on-failure, overwrite, empty, unicode, large. No no-clobber test.

---

## 3. `src/mutation-queue.ts` (66 lines)

Per-file promise chain with 60s timeout.  
- `withFileMutationQueue(filePath, fn)` chains on previous promise (line 31).
- Timeout races the edit (line 45–58); loser is abandoned (fire-and-forget).
- **Releases while work continues** on timeout (line 42–44 comment).
- Chain is error-tolerant: rejects don't deadlock (line 30–34).

**Test seam:** No dedicated test file. Referenced in `test/patch.test.ts` comment (line 3) but not imported. Used by `src/patch.ts` **not at all** — `patch.ts` does not wrap its loop in `withFileMutationQueue`. The queue is used by the older `src/index.ts` write path.

**Gap:** Multi-file batch has no serialization at all — two concurrent edit calls on the same file can race because patch.ts doesn't use the mutation queue.

---

## 4. `src/undo/edit-history.ts` (311 lines)

- `saveUndoState(cwd, path, content, editCount, changedSymbols)` — fire-and-forget, never throws (line 94–128).
- Stores base64-encoded pre-edit content in `.smart-edit-undo/`.
- `restoreUndoState(cwd, filePath, options)` — reads most recent matching entry, compares `snapshotHash`, restores via `atomicWrite` (line 141–222).
- `getUndoHistory(cwd, filePath?)` — lists all entries.
- `clearUndoHistory(cwd)` — removes all.

**Not wired into patch.ts:** `saveUndoState` is called from `src/formats/atomic-patch.ts` (line 674) but **NOT** from `src/patch.ts`. Patch writes have no undo records today.

---

## 5. Edit Intents (`src/edit-intents.ts`)

```typescript
export type EditIntent =
  | { kind: "text"; operation: EditOperation }
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "rename"; oldPath: string; newPath: string };
```

Parsed by `normalizeRawEdit(raw, defaultPath)` from all supported formats.  
**Currently blocked in patch.ts (lines 507–525):** topology intents (add/delete/rename) from raw patches are rejected with "requires failure-atomic transaction support" and no files changed. Text-only intents proceed through normal lifecycle.

---

## 6. Existing Rollback in `src/formats/atomic-patch.ts`

This is the **only** existing rollback implementation (lines 681–755):
- Saves undo state for affected files **before** applying (line 666–678).
- Applies operations sequentially with retry (line 694–706).
- On failure: rolls back all previously applied operations via `rollbackSingleOperation` (line 727–742).
- `rollbackSingleOperation` (line 850): delete created files, restore backed-up content, undo renames.
- **Not connected to `patch.ts` pipeline** — this is a legacy standalone executor.

**Weakness:** Rollback itself is best-effort (line 739–741, empty catch). No pre-rollback fingerprint recheck.

---

## 7. `src/patch.ts` Topology Intent Gap (lines 507–525)

```typescript
const topologyIntents = normalized.intents.filter((intent) => intent.kind !== "text");
if (topologyIntents.length > 0) {
    // ... returns "failed: raw patch requires transaction support"
}
```

This is the explicit placeholder for Task 7. The `EditIntent` type already carries add/delete/rename — the parser produces them — but the executor rejects them.

---

## 8. Key Dependencies/Exports

| Module | Exports consumed by patch.ts |
|--------|------------------------------|
| `src/edit-contract.ts` | `EDIT_PARAMETERS`, `validateEditRequest`, `EditOperation` |
| `src/edit-intents.ts` | `normalizeRawEdit` |
| `src/edit-planner.ts` | `planTextEdits`, `PlannedTextEdits`, `StructuralResolver` |
| `src/undo/atomic-write.ts` | `atomicWrite` (imported as `atomicWriteFile`) |
| `src/safety/approval-gating.ts` | `checkEditSafety` |
| `src/evidence-authority.ts` | `PriorAuthorityStore` |
| `src/core/edit-diff.ts` | `generateDiffString` |
| `pi-workspace-protocol` | `WorkspaceEvidenceEnvelope`, `InspectedResource`, validators |

---

## 9. Smallest Transaction Module Contract

### What `src/edit-transaction.ts` needs to do

```
interface TransactionPlan {
  paths: SortedPathEntry[];
}

interface SortedPathEntry {
  absolutePath: string;
  operation: "update" | "create" | "delete" | "rename";
  // update: staged newContent + beforeContent + beforeSha
  // create: content + parentDir
  // delete: beforeContent + beforeSha + beforeMode
  // rename: oldPath + newPath
  beforeContent?: string;
  beforeSha?: string;
  beforeMode?: number;
  afterContent?: string;
  afterSha?: string;
  afterMode?: number;
}

interface TransactionResult {
  ok: boolean;
  applied: string[];
  rollback: { attempted: string[]; ok: string[]; failed: string[] };
}
```

### Contract: stage → lock → verify → commit → (rollback)

1. **Stage all paths** before first write. For each path:
   - **update**: read content + stat mode → `planTextEdits` → capture `newContent`
   - **create**: verify no-clobber (stat fails = ok)
   - **delete**: read content + stat mode → backup
   - **rename**: stat old → backup → verify new doesn't exist
2. **Lock sorted paths** (alphabetical by absolute path). Hold through commit+rollback. Use a new module-level `Map<string, Promise<void>>` with sorted acquisition (not mutation-queue's per-file chain, which releases on timeout).
3. **Re-verify fingerprints** immediately before each write (existing Fix #6 pattern).
4. **Commit** in order: `atomicWrite` for update, `atomicCreate` (no-clobber) for create, `unlink` for delete, `rename` for rename.
5. **On failure**: rollback in reverse order using saved content/existence state.
6. **Post-rollback fingerprint** recheck.

### Mode preservation / no-clobber

- **update**: `atomicWrite(path, newContent, { mode: beforeMode })` preserves mode.
- **create**: `atomicCreate(path, content)` — the no-clobber primitive. Uses a temp file + `link(2)`; `link` fails with `EEXIST` on a concurrent creator, so no explicit `existsSync` guard is needed.
- **delete**: `unlink(path)`. Backup: already read content + mode.
- **rename**: `rename(oldPath, newPath)`. Backup: stat oldPath + verify newPath doesn't exist.

---

## 10. Tricky Ownership / Evidence / Verification Phases

### Evidence authorization per path
Each path needs its own `InspectedResource` from either prior authority or envelope. Current code does this per-group in the for-loop. Transaction module must stage authority selection **before** any write.

### Verification checks per path
Blocking/advisory verifiers run per-path with `{ path, content, toolCallId }`. Must run during stage phase (before commit) so failures trigger rejection, not rollback.

### Approval gating
`checkEditSafety` runs before write. Advisory only. Must run during stage.

### SHA freshness (TOCTOU)
Two SHA checks: (1) initial read SHA matches evidence, (2) pre-write re-read SHA matches initial. Both must happen per-path in stage+commit phases.

### Post-edit invalidation
`invalidations.push(...)` records each write's before/after SHA. Must record after each successful commit for correct `changedResources` reporting even on mid-batch failure.

### Post-write verify
Re-read + SHA check after atomicWrite. Part of commit phase.

---

## 11. Test Seams

### Existing tests that constrain Task 7

| Test | File:Line | What it proves |
|------|-----------|----------------|
| Mid-batch failure reports earlier writes | `test/patch.test.ts:578` | File 1 stays modified on disk when file 2 fails. **Must change** to rollback behavior. |
| Post-write invalidation recorded | `test/patch.test.ts:911` | `changedResources` reflects actual writes. |
| SHA re-read before write | `test/patch.test.ts:1012` | Concurrent writer detected. |
| Blocking verifier blocks write | `test/patch.test.ts:737` | Pre-write gate. |
| Auto-inspect new-file creation | `test/patch.test.ts:827` | Empty oldText creates file. |
| replaceAll coverage per-occurrence | `test/patch.test.ts:781` | Line-range enforced per-span. |
| Prior authority out-of-range rejects | `test/patch.test.ts:1185` | Authority not widened. |

### Red/green tests for Task 7

**RED (should fail before implementation):**
1. Two-file update where file 2 write fails → file 1 should be restored (currently stays modified).
2. Create file 1 + delete file 2 where delete fails → file 1 create should be rolled back.
3. Rename file A→B where B write fails → A should be restored to original location.
4. New-file creation race: concurrent call creates same file → second gets conflict, not overwrite.

**GREEN (should pass after implementation):**
1. Two-file update: both succeed → `changedResources` has 2 entries, both files modified.
2. Two-file update: file 2 write fails → file 1 restored to original content, `rollback.ok` has file 1 path.
3. Create + update: create succeeds, update fails → created file removed.
4. Sorted locking: concurrent calls on overlapping paths → one waits, no interleaving.
5. Mode preserved after rollback: chmod 755 file, edit, fail, rollback → file still 755.
6. Topology intents from raw patch: add/delete/rename execute through transaction lifecycle.
7. Pre-commit fingerprint recheck: inject concurrent modification during stage → reject as stale.

---

## 12. Confirmed Gaps (no speculation)

| Gap | Severity | Location |
|-----|----------|----------|
| No cross-file rollback on mid-batch failure | **Blocker** | `src/patch.ts` (docstring lines 10–13) |
| `patch.ts` does not use `withFileMutationQueue` | **Medium** | `src/patch.ts` — concurrent edits on same file can race |
| Topology intents (add/delete/rename) rejected with placeholder error | **Planned** | `src/patch.ts:507–525` |
| `saveUndoState` not wired into patch writes | **Medium** | `src/patch.ts` vs `src/undo/edit-history.ts` |
| `atomicWrite` has no explicit no-clobber guard for create | **Low** | `src/undo/atomic-write.ts` — works by accident (no existing file) |
| `mutation-queue` has no dedicated tests | **Low** | No `test/mutation-queue.test.ts` |
| Existing `atomic-patch.ts` rollback is legacy/disconnected | **Info** | `src/formats/atomic-patch.ts:681–755` |
