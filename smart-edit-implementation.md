# smart-edit + pi-lens Implementation Document#

**Date**: 2026-05-02  
**Status**: Implementation guide (grounded in source code + memory)  
**Prerequisite**: `smart-edit-integration-spec.md`  

---

## 1. Implementation Priority Order#

Based on code analysis + memory context (session #82, #85, #86, #87, #88, #89):

| Priority | Integration | Est. Time | Why This First |
|----------|--------------|-----------|-------------------|
| 🔴 **P1** | Read-Before-Edit Guard | ~2h | Blocks stale edits — memory #86: "Hashline system relies on freshness checks" |
| 🟣 **P2** | Pipeline Telemetry | ~1h | Instruments 4-tier matching — memory #87: "Multi-tier fallback strategy designed for resilience" |
| 🟣 **P3** | Delta Mode Conflicts | ~2h | Cleaner UX — memory #88: "Scoped Fallback tier uses AST symbols" |
| ⬇ **P4** | LSP Post-Edit (expand) | ~3h | More diagnostics — existing `waitForDiagnostics()` |
| ⬇ **P5** | Declarative Rules | ~4h | Refactor — memory #89: "Architectural specification for hashline-anchored editing" |

---

## 2. P1: Range Coverage Guard — Implementation#

### 2.1 Problem Statement (Refined After Code Reading)#

**Actual current state** (`read-cache.ts:101-200`):
- ✅ Checks if file was **modified** since read (`checkStale()`) — also checks `snapshotCache`
- ✅ Block on zero-read **already exists**: `checkStale()` returns `"this file has not been read"` if file not in snapshot cache
- ❌ Missing **range coverage validation**: If the model reads lines 50-100 (`offset=50, limit=50`) and tries to edit line 150, the file IS in snapshot cache (partial read) so edit looks valid — even though the model never saw line 150
- ❌ Error messages are generic (`"this file has not been read"`) with no actionable hints (which tool to use, what offset/range to read)

**Key Discovery**: The zero-read gap claimed in the spec was INCORRECT. smart-edit's `checkStale()` already blocks edits to files not in the snapshot cache. The actual gap is **range coverage** — after a partial read (offset/limit or truncation), the edit can target lines the model never saw.

**Pattern Used**: pi-lens `read-guard.ts:188-280` (range coverage check + interval merging)

### 2.2 Actual Changes Made (Grounded in Code)#

#### File: `lib/read-cache.ts`

**Added**:
- `ReadRange` interface — tracks read metadata (offset, limit, totalLines, source tool)
- `sessionReads` Map — per-file array of ReadRange entries
- `recordReadSession()` — called from `index.ts` on every successful read
- `getSessionReads()` — retrieve read history for a file
- `getLastFullRead()` — find the most recent full-file read
- `checkRangeCoverage()` — validates that [editStartLine, editEndLine] falls within merged read intervals
- `checkEditAllowed()` — unified guard wrapping `checkStale()` + `checkRangeCoverage()`

**Key design**: Kept `checkStale()` unchanged (backward compatible). Added new functions alongside it. The `sessionReads` Map is separate from `snapshotCache` — they serve different purposes (coverage vs. staleness).

**Range coverage algorithm**: Merges overlapping/adjacent read intervals using interval merging, then checks if the edit range falls within any merged interval. This handles cumulative reads (e.g., reading lines 1-50, then 60-100 → merged to 1-100).

#### File: `index.ts`

**Modified**:
- Import: Added `recordReadSession`, `getSessionReads`, `checkEditAllowed`, `checkRangeCoverage`
- Added `computeEditContainingRange()` — helper that finds the containing line range for oldText in file content (used to pass edit line range to the coverage check)

**Hooked into execute()**:
1. After `checkStale()` succeeds but before applying edits:
   - Compute `editLineRange` from oldText matches against fresh file content
   - Call `checkRangeCoverage()` with the edit line range
   - If uncovered → throw error with actionable re-read hint

**Hooked into tool_result handlers**:
- `read` (offset/limit): `recordReadSession(path, cwd, offset, limit, lines.length, "read")`
- `read` (full): `recordReadSession(path, cwd, 1, -1, lines.length, "read")`
- `read_multiple_files`: `recordReadSession(path, cwd, offset ?? 1, limit ?? -1, lines.length, "read_multiple_files")`
- `intent_read`: `recordReadSession(path, cwd, 1, -1, lines.length, "intent_read")`
- `write`: `recordReadSession(path, cwd, 1, -1, lines.length, "write")`

#### Files Changed#

| File | Changes | Lines Added |
|------|---------|-------------|
| `lib/read-cache.ts` | +`ReadRange`, +`sessionReads`, +`recordReadSession()`, +`checkRangeCoverage()`, +`checkEditAllowed()` | ~90 |
| `index.ts` | +`recordReadSession()` in 5 tool_result handlers, +`checkRangeCoverage()` in execute(), +`computeEditContainingRange()` helper | ~50 |

**Total P1**: ~140 lines across 2 files.

### 2.3 Verification#

```bash
# Test 1: Edit without read (should block)
echo "console.log('hello');" > /tmp/test.ts
# Agent tries to edit /tmp/test.ts without reading → expect BLOCKED

# Test 2: Edit after read (should pass)
# Agent reads /tmp/test.ts → then edits → expect SUCCESS

# Test 3: Edit after file modified (should block)
# Agent reads /tmp/test.ts → external tool modifies it → agent edits → expect BLOCKED

# Test 4: Range coverage
# Agent reads lines 1-50 → tries to edit line 60 → expect BLOCKED
```

---

## 3. P2: Pipeline Telemetry — Implementation#

### 3.1 Problem Statement (Refined After Code Reading)#

**Current state** (`edit-diff.ts:498-600`):
- ✅ Has 4-tier matching: exact → indent → unicode → similarity
- ✅ Has `SIMILARITY_MATCH_THRESHOLD = 0.85`
- ❌ NO timing instrumentation — can't tell which tier succeeded or took how long
- ❌ `findText()` is synchronous but telemetry is additive (no async refactor needed)

**Gap**: No visibility into match performance. A slow similarity match vs. fast exact match changes the UX but there's no way to distinguish them in output.

### 3.2 Actual Changes Made (Grounded in Code)#

#### File: `lib/edit-diff.ts`

**Added**:
- `TierTelemetry` interface — `{ tier, durationMs, success, matchCount, note? }`
- `findTextWithTelemetry()` — clones `findText()` but wraps each tier with `performance.now()` timing
  - Kept `findText()` as a backward-compatible wrapper that calls `findTextWithTelemetry().result`
  - Same signature as `findText()` (synchronous, same parameters)
  - Returns `{ result: MatchResult; telemetry: TierTelemetry[] }`

**Tier timing**:
- Tier 1 (Exact): `indexOf` call timing
- Tier 2 (Indentation): `tryIndentationMatch()` timing
- Tier 3 (Unicode): `tryUnicodeMatch()` timing
- Tier 4 (Similarity): `trySimilarityMatch()` timing

Each tier records: success/failure, duration in ms, and a note for indent normalization (e.g., detected `2-space` vs `4-space`).

#### File: `index.ts`

**Modified (hashline path)**:
- Import `findTextWithTelemetry` alongside `findText`
- Created `findTextWithT` wrapper in Phase A (hashline edits) that:
  1. Calls `findTextWithTelemetry()` instead of `findText()`
  2. Captures successful tier names + durations
  3. Pushes `[match-telemetry] Exact: 0.3ms, Indentation: 1.1ms` to `matchNotes[]`
- Passes `findTextWithT` as the callback to `applyHashlinePath`

**Legacy path note**: Not instrumented at the per-tier level. The existing `applyEdits()` match notes already capture fuzzy match information. Full per-tier telemetry for legacy edits would require modifying `applyEdits()` to support telemetry collection, which is a larger refactor.

#### Files Changed#

| File | Changes | Lines Added |
|------|---------|-------------|
| `lib/edit-diff.ts` | +`TierTelemetry` interface, +`findTextWithTelemetry()`, `findText()` wraps it | ~90 |
| `index.ts` | telemetry wrapper in hashline path, `[match-telemetry]` in matchNotes | ~25 |

**Total P2**: ~115 lines across 2 files.

---

## 4. P3: Delta Mode Conflicts — Implementation#

### 4.1 Problem Statement (Refined After Code Reading)#

**Current state** (`conflict-detector.ts:100-200`):
- ✅ `checkConflicts()` returns ALL matching conflicts from history
- ✅ AST-level symbol tracking via tree-sitter
- ✅ Line-range fallback for non-AST files
- ❌ Reports SAME conflict across successive edits — e.g., if edit 1 targets `function foo`, edit 2 targeting `function bar` still reports "conflict with previous edit to `foo`"

**Gap**: No baseline mechanism. Each `checkConflicts()` call returns the entire conflict history, not just newly-arisen ones. This creates noise for the model.

### 4.2 Actual Changes Made (Grounded in Code)#

#### File: `lib/conflict-detector.ts`

**Added inside `createConflictDetector()`**:
- `baselineHistory: Map<string, Set<string>>` — stores Set of `"symbolName:symbolKind"` keys per file, representing the state at time of baseline capture
- `captureBaseline(filePath)` — snapshots current `editHistory` and `lineRangeHistory` into `baselineHistory` as key sets
- `clearBaseline(filePath)` — removes baseline entry (forces fresh capture)
- `checkDeltaConflicts(filePath, content, editSpans)` — calls `checkConflicts()` then filters to only conflicts whose `previousSymbol.name:kind` is NOT in the baseline
- Updated `clearAll()` to also clear `baselineHistory`
- Returned new functions from factory: `captureBaseline`, `clearBaseline`, `checkDeltaConflicts`

**Key design**:
- Baseline is a Set of `"symbolName:symbolKind"` keys, not a copy of the history array. This is more memory-efficient and comparison is O(1) per conflict
- Line-range history fallback uses keys like `"byte-range:{turn}"` — captures turn-specific line range edits
- After `captureBaseline()`, subsequent `checkDeltaConflicts()` calls only return conflicts from edits-added-after-baseline

#### File: `index.ts`

**Modified in onBeforeApply (legacy edits Phase B)**:
- Replaced `checkConflicts()` call with `checkDeltaConflicts()`
- Added `conflictDetector.captureBaseline(path)` call BEFORE checking delta conflicts
  - This captures the "before edit" state so the delta comparison works correctly
- The baseline is updated after each successful `recordEdit()` call (via the next edit's `captureBaseline` call)

**Flow**:
1. Edit 1 to `foo.ts`: `captureBaseline("foo.ts")` → baseline = `{}` (empty) → `checkDeltaConflicts()` → returns all (baseline empty, so all are new)
2. Edit applied → `recordEdit()` adds symbol to history
3. Edit 2 to `foo.ts`: `captureBaseline("foo.ts")` → baseline = `{ "foo:function_declaration" }` → `checkDeltaConflicts()` → returns only conflicts with symbols NOT in baseline

#### Files Changed#

| File | Changes | Lines Added |
|------|---------|-------------|
| `lib/conflict-detector.ts` | +`baselineHistory`, +`captureBaseline()`, +`clearBaseline()`, +`checkDeltaConflicts()` | ~50 |
| `index.ts` | Switch to `checkDeltaConflicts()` + `captureBaseline()`, import update | ~10 |

**Total P3**: ~60 lines across 2 files.

---

## 5. File Change Summary (Actual)#

| File | Changes | Lines Added |
|------|---------|-------------|
| `lib/read-cache.ts` | +`ReadRange` interface, +`sessionReads` Map, +`recordReadSession()`, +`getSessionReads()`, +`getLastFullRead()`, +`checkRangeCoverage()`, +`checkEditAllowed()` | ~90 |
| `lib/edit-diff.ts` | +`TierTelemetry` interface, +`findTextWithTelemetry()`, `findText()` wraps it | ~90 |
| `lib/conflict-detector.ts` | +`baselineHistory`, +`captureBaseline()`, +`clearBaseline()`, +`checkDeltaConflicts()` | ~50 |
| `index.ts` | +`recordReadSession()` in 5 tool_result handlers, +`checkRangeCoverage()` in execute(), +`computeEditContainingRange()`, +telemetry wrapper in hashline path, +delta mode in conflict hook, import updates | ~85 |

**Total**: ~315 lines across 4 files.

---

## 6. Testing Strategy#

### 6.1 Unit Tests (per feature)#

```bash
# P1: Read-Before-Edit Guard
npx tsx --test test/read-guard.test.ts
# Tests: zero-read block, stale file block, range coverage

# P2: Pipeline Telemetry  
npx tsx --test test/telemetry.test.ts
# Tests: tier timing, success tracking

# P3: Delta Mode Conflicts
npx tsx --test test/delta-conflicts.test.ts
# Tests: baseline capture, new-only filtering
```

### 6.2 Integration Test#

```bash
# Full flow test
# 1. Agent reads file
# 2. External tool modifies it
# 3. Agent tries to edit → expect BLOCKED (P1)
# 4. Agent re-reads
# 5. Agent edits → expect SUCCESS + telemetry output (P2)
# 6. Agent edits same symbol → expect conflict (P3)
# 7. Agent edits different symbol → expect NO conflict (delta mode)
```

---

## 7. Rollout Plan#

| Phase | Action | Risk |
|-------|---------|------|
| **Alpha** | P1 only (Read-Before-Edit Guard) | Low — blocks bad edits |
| **Beta** | + P2 (Telemetry) | Low — additive, no behavior change |
| **Gamma** | + P3 (Delta Conflicts) | Low — filters existing output |
| **Stable** | + P4 (LSP expand) | Medium — LSP overhead |

**Recommended first step**: Implement P1 (Read-Before-Edit Guard) — highest impact with medium effort.

---

## 8. Key Code References Recap#

### smart-edit (current implementation)
| Feature | File:Lines | Memory Context |
|---------|--------------|---------------|
| 4-tier matching | `edit-diff.ts:392-450` | #87 Multi-tier fallback strategy |
| Hashline anchors | `hashline-edit.ts:1-120` | #86 Hashline system design |
| Stale check (APFS) | `read-cache.ts:101-200` | #85 xxhash-wasm decision |
| AST conflict detection | `conflict-detector.ts:200-250` | #88 Scoped Fallback tier |
| tree-sitter | `ast-resolver.ts:1-300` | #89 Architectural specification |

### pi-lens (reference patterns)
| Pattern | File:Lines | Integration Target |
|---------|--------------|------------------|
| Read guard (zero-read) | `read-guard.ts:188-280` | P1: `checkEditAllowed()` |
| Phase telemetry | `pipeline.ts:530-560` | P2: `findTextWithTelemetry()` |
| Delta filtering | `dispatcher.ts:300-340` | P3: `checkDeltaConflicts()` |
