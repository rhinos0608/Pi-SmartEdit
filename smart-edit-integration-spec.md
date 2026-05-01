# smart-edit + pi-lens Integration Specification

**Date**: 2026-05-02  
**Status**: Specification (grounded in source code)  
**Next**: Implementation document follows  

---

## 0. Important Correction from Code Reading#

**The initial spec claimed smart-edit lacked a zero-read check. This was INCORRECT.**

`checkStale()` in `read-cache.ts` already checks the snapshot cache and returns:
```
`Cannot edit ${path} — this file has not been read in the current session.`
```
if the file was never read. The ACTUAL gaps are:

1. **Range coverage**: After a partial read (offset/limit), the file IS in cache but edits can target unread lines
2. **Error messages**: Current messages are generic with no actionable re-read hints
3. **Telemetry**: No timing on matching tiers
4. **Delta conflicts**: All conflicts reported, not just new ones

The spec below has been corrected to reflect this refined understanding.

---

## 1. Current State Analysis (Grounded in Code)

### 1.1 smart-edit Architecture (Actual)

```
smart-edit/
├── index.ts                    # Entry point, schema, edit execution
├── lib/
│   ├── edit-diff.ts          # 4-tier matching pipeline (L392-450)
│   ├── hashline-edit.ts     # Hashline anchoring (LINE+HASH)
│   ├── hashline.ts           # Line hashing (xxhash-wasm)
│   ├── read-cache.ts        # Stale-file detection (APFS retry)
│   ├── conflict-detector.ts  # AST-level conflict detection
│   ├── ast-resolver.ts      # tree-sitter integration
│   └── types.ts            # Shared type definitions
└── src/
    ├── lsp/
    │   ├── diagnostics.ts    # Post-edit LSP checks (L392-450)
    │   ├── lsp-manager.ts   # LSP server lifecycle
    │   └── lsp-connection.ts # LSP protocol
    └── pipeline.ts           # ⚠️ ORPHANED — NOT IMPORTED
```

### 1.2 What smart-edit ALREADY Has (Code Evidence)

| Feature | File:Lines | Code Evidence |
|---------|----------|---------------|
| **4-tier matching** | `edit-diff.ts:392-450` | `SIMILARITY_MATCH_THRESHOLD = 0.85` + `findText()` with tiers: exact → indent → unicode → similarity |
| **Hashline anchors** | `hashline-edit.ts:1-120` | `Anchor { line: number; hash: string }` + `tryRebaseAnchor()` with ±5 window |
| **Stale-file check** | `read-cache.ts:101-200` | `checkStale()` with APFS retry: `CHECK_STALE_MAX_RETRIES = 3` + exponential backoff |
| **AST conflict detection** | `conflict-detector.ts:1-250` | `checkConflicts()` using `ast-resolver.ts` for symbol-level tracking |
| **tree-sitter integration** | `ast-resolver.ts:1-300` | `parseFile()` + `findEnclosingSymbols()` with web-tree-sitter |
| **LSP diagnostics** | `src/lsp/diagnostics.ts:1-100` | `waitForDiagnostics()` with push + pull fallback |
| **Atomic writes** | `index.ts:800-850` | `atomicWrite()` with temp file + rename |

### 1.3 What pi-lens Has that smart-edit MISSES (Corrected)#

| Pattern | pi-lens File | Missing from smart-edit |
|---------|--------------|----------------------|
| **Range Coverage Validation** | `read-guard.ts:188-280` | ✅ Zero-read check via `checkStale()` already exists. ❌ No range coverage — edit outside partial read passes. |
| **Pipeline Telemetry** | `pipeline.ts:530-560` | No timing instrumentation on 4-tier matching. Tier success is tracked (`MatchTier` enum) but no ms duration. |
| **Delta Mode** | `dispatcher.ts:300-340` | `checkConflicts()` returns ALL historical conflicts — no baseline filtering. |
| **Actionable Error Messages** | `read-guard.ts:220-250` | `checkStale()` messages are generic with no tool/offset hints for the re-read. |
| Declarative Rules | `dispatcher.ts:50-90` | Conflict detector is hardcoded, not data-driven. ⬇ LOW priority. |
| Inline Suppressions | `dispatcher.ts:400-430` | No `// smart-edit-ignore: conflict-type` syntax. ⬇ LOW priority. |

---

## 2. Integration Specification

### 2.1 Range Coverage Guard (HIGH PRIORITY)

**Problem (corrected from initial spec)**: `checkStale()` already blocks edits to files NOT in `snapshotCache` (zero-read check exists). The actual gap is **range coverage**: after a partial read (offset/limit), the file IS in cache but edits can target lines the model never saw. Also, error messages are generic with no actionable re-read hints.

**pi-lens pattern** (`read-guard.ts:340-380`):
- Interval merging: reads `[1-50, 60-100]` → merged `[1-100]`
- Check: does `[editStart, editEnd]` ⊆ any merged interval?
- Actionable error: "Edit targets line 150, but you only read lines 1-100. Re-read: `read path="foo.ts" offset=140 limit=30`"

**Specification for smart-edit**:

#### 2.1.1 Modify `read-cache.ts`

**Current state** (lines 101-150):
- `snapshotCache` stores `FileSnapshot` — mtime + size + content hash for stale detection
- `checkStale()` checks snapshot cache (returns `"not been read"` if absent)
- No session-level read range tracking — only knows if file was read, not what range

**Required changes**:
1. Add `sessionReads` Map tracking ALL reads with offset, limit, and totalLines
2. Add `recordReadSession()` to record what range was actually read
3. Add `checkRangeCoverage()` with interval merging (pi-lens pattern)
4. Add `checkEditAllowed()` wrapping `checkStale()` + `checkRangeCoverage()`

#### 2.1.2 Modify `index.ts`

**tool_result handlers**: Call `recordReadSession()` for each read tool
- `read`: offset/limit or full file
- `read_multiple_files`: per-file with optional offset/limit
- `intent_read`: full file (offset=1, limit=-1)

**execute()**: After `checkStale()` passes and file is read:
1. Compute edit line range from oldText using `computeEditContainingRange()`
2. Call `checkRangeCoverage()` with [startLine, endLine]
3. If uncovered → throw error with actionable hint (which offset/limit to re-read)

---

### 2.2 Pipeline Telemetry (MEDIUM PRIORITY)

**Problem**: smart-edit's 4-tier matching works but has NO timing/telemetry. Can't tell which tier succeeded or how long each takes.

**pi-lens pattern** (`pipeline.ts:530-560`):
```typescript
function createPhaseTracker(toolName: string, filePath: string): PhaseTracker {
  const phases: Array<{ name: string; startTime: number; ended: boolean }> = [];
  return {
    start(name: string) { phases.push({ name, startTime: Date.now(), ended: false }); },
    end(name: string, metadata?: Record<string, unknown>) {
      const p = phases.find(x => x.name === name && !x.ended);
      if (p) {
        logLatency({ type: "phase", phase: name, durationMs: Date.now() - p.startTime, metadata });
      }
    },
  };
}
```

**Specification for smart-edit**:

#### 2.2.1 Add Telemetry to `edit-diff.ts`

**Location**: Wrap the 4-tier matching in `findText()` (around line 392)

**Current code** (simplified):
```typescript
export function findText(content: string, search: string, options): MatchResult {
  // Tier 1: Exact match
  let result = tryExactMatch(content, search);
  if (result) return { ...result, tier: MatchTier.Exact };
  
  // Tier 2: Indent normalization
  result = tryIndentMatch(content, search);
  if (result) return { ...result, tier: MatchTier.Indent };
  // ... etc.
}
```

**New code**:
```typescript
type TierResult = {
  tier: MatchTier;
  durationMs: number;
  success: boolean;
  matches: MatchSpan[];
};

export async function findTextWithTelemetry(
  content: string, 
  search: string, 
  options
): MatchResult & { telemetry: TierResult[] } {
  const telemetry: TierResult[] = [];
  
  // Tier 1: Exact
  let start = Date.now();
  let result = tryExactMatch(content, search);
  telemetry.push({ tier: MatchTier.Exact, durationMs: Date.now() - start, success: !!result, matches: result?.spans || [] });
  if (result) return { ...result, tier: MatchTier.Exact, telemetry };
  
  // Tier 2: Indent
  start = Date.now();
  result = tryIndentMatch(content, search);
  telemetry.push({ tier: MatchTier.Indent, durationMs: Date.now() - start, success: !!result, matches: result?.spans || [] });
  if (result) return { ...result, tier: MatchTier.Indent, telemetry };
  // ... Tier 3, Tier 4 similarly
  
  return { matches: [], tier: MatchTier.None, telemetry };
}
```

#### 2.2.2 Output Telemetry in `index.ts`

**Location**: After `findText()` returns, format telemetry for LLM

```typescript
// In execute() after findText()
if (matchResult.telemetry) {
  const summary = matchResult.telemetry
    .filter(t => t.success)
    .map(t => `${t.tier}: ${t.durationMs}ms`)
    .join(', ');
  if (summary) {
    editNotes.push(`[match-telemetry] ${summary}`);
  }
}
```

---

### 2.3 Delta Mode for Conflicts (MEDIUM PRIORITY)

**Problem**: Conflict detector reports ALL historical conflicts. Should only report NEW conflicts since last edit.

**pi-lens pattern** (`dispatcher.ts:300-340`):
```typescript
function filterDelta<T extends { id: string }>(
  after: T[], before: T[] | undefined, keyFn: (d: T) => string
): { new: T[]; fixed: T[] } {
  const beforeSet = new Set((before ?? []).map(keyFn));
  const newItems = after.filter(d => !beforeSet.has(keyFn(d)));
  return { new: newItems, fixed: [] };
}
```

**Specification for smart-edit**:

#### 2.3.1 Modify `conflict-detector.ts`

**Current state**: `checkConflicts()` returns ALL conflicts from history

**Required changes**:
1. Add `captureBaseline(filePath)` function — snapshots current conflict state
2. Add `getDeltaConflicts(filePath)` — returns only NEW conflicts since baseline
3. Store baseline in `editHistory` Map with key `baseline:${filePath}`

**Interface**:
```typescript
// NEW: In conflict-detector.ts
export async function checkDeltaConflicts(
  filePath: string,
  content: string,
  editSpans: Array<{ startIndex: number; endIndex: number }>,
): Promise<ConflictReport[]> {
  // Get ALL conflicts (existing logic)
  const allConflicts = await checkConflicts(filePath, content, editSpans);
  
  // Load baseline
  const baselineKey = `baseline:${filePath}`;
  const baseline = editHistory.get(baselineKey) || [];
  
  // Filter to only NEW conflicts
  const baselineIds = new Set(baseline.map(c => `${c.previousSymbol.name}:${c.currentSymbol.name}`));
  const newConflicts = allConflicts.filter(c => 
    !baselineIds.has(`${c.previousSymbol.name}:${c.currentSymbol.name}`)
  );
  
  return newConflicts;
}

export function captureBaseline(filePath: string): void {
  const history = editHistory.get(filePath) || [];
  const baselineKey = `baseline:${filePath}`;
  editHistory.set(baselineKey, [...history]); // snapshot current state
}
```

#### 2.3.2 Call Baseline in `index.ts`

**Timing**:
- `captureBaseline()` at session start or before first edit to a file
- `checkDeltaConflicts()` in place of `checkConflicts()` for LLM-facing output
- Fall back to `checkConflicts()` if delta mode disabled

---

### 2.4 Declarative Conflict Rules (LOW PRIORITY)

**Note**: This is a REFACTOR, not a new feature. Low priority given smart-edit's conflict detector already works.

**pi-lens pattern** (`dispatcher.ts:50-90`):
```typescript
interface RunnerDefinition {
  id: string;
  appliesTo: FileKind[];
  priority: number;
  when?: (ctx: DispatchContext) => Promise<boolean>;
  run: (ctx: DispatchContext) => Promise<RunnerResult>;
}
```

**Rationale for LOW priority**: smart-edit's `conflict-detector.ts` is hardcoded but WORKS. Converting to declarative:
- Would require defining `ConflictRule` interface
- Would need rule registry (like `RunnerRegistry`)
- Benefit: easier to add new conflict types
- Cost: significant refactor for unclear UX gain

**Recommendation**: Skip for now. Add to backlog.

---

## 3. Implementation Priority Matrix

| Integration | Effort | Impact | Code Changes | Priority |
|-------------|--------|--------|---------------|----------|
| **Range Coverage Guard** | Medium (~2h) | HIGH — prevents edits to unseen lines | `read-cache.ts` + `index.ts` | 🔴 HIGH |
| **Pipeline Telemetry** | Low (~1h) | MEDIUM — observability | `edit-diff.ts` + `index.ts` | 🟣 MEDIUM |
| **Delta Mode Conflicts** | Medium (~2h) | MEDIUM — cleaner UX | `conflict-detector.ts` + `index.ts` | 🟣 MEDIUM |
| Declarative Rules | High (~4h) | LOW — refactor | `conflict-detector.ts` rewrite | ⬇ LOW |

---

## 4. Code References (Exact Locations)

### smart-edit Files
| File | Key Lines | Purpose |
|------|------------|---------|
| `index.ts` | 151-350 | Schema definition (oldText, newText, anchor, lineRange) |
| `index.ts` | ~1000-1100 | `execute()` function — edit application |
| `lib/edit-diff.ts` | 392-450 | `findText()` — 4-tier matching |
| `lib/edit-diff.ts` | L392-450 | `SIMILARITY_MATCH_THRESHOLD = 0.85` |
| `lib/hashline-edit.ts` | 1-120 | `Anchor` parsing + `tryRebaseAnchor()` |
| `lib/read-cache.ts` | 101-200 | `checkStale()` + APFS retry logic |
| `lib/conflict-detector.ts` | 1-250 | `checkConflicts()` + AST resolution |
| `lib/ast-resolver.ts` | 1-300 | `parseFile()` + tree-sitter |
| `src/lsp/diagnostics.ts` | 1-100 | `waitForDiagnostics()` push/pull |

### pi-lens Files (for reference)
| File | Key Lines | Pattern |
|------|------------|---------|
| `read-guard.ts` | 188-280 | Zero-read + file-modified + out-of-range checks |
| `pipeline.ts` | 530-560 | `PhaseTracker` timing instrumentation |
| `dispatcher.ts` | 300-340 | `filterDelta()` for NEW-only issues |
| `dispatcher.ts` | 50-90 | `RunnerRegistry` declarative rules |

---

## 5. Next Steps

1. **Validate specification** with user
2. **Write implementation doc** (next file) with exact code changes
3. **Start with HIGH priority**: Read-Before-Edit Guard
4. **Then MEDIUM priorities**: Telemetry, then Delta Mode

---

**Appendix: Key Insight from Code Reading (Corrected)**

smart-edit is MORE ADVANCED and DIFFERENT than initially apparent:
- ✅ Has 4-tier matching (pi-lens doesn't have this)
- ✅ Has hashline anchors (pi-lens doesn't have this)
- ✅ Has AST conflict detection (similar to pi-lens but scoped to edits)
- ✅ Has zero-read check via `checkStale()` snapshot cache check
- ✅ Has stale-file detection with APFS VFS retry
- ❌ Missing: Range coverage validation (edit outside partial read)
- ❌ Missing: Telemetry/timing on matching tiers
- ❌ Missing: Delta mode for conflicts (baseline filtering)

**Correction from code reading**: The zero-read claim was wrong. `checkStale()` already checks `snapshotCache` and returns `"this file has not been read"` if no snapshot exists. The ACTUAL gaps are more nuanced: range coverage, telemetry, and delta filtering.

**Therefore**: Integration is about ADDING patterns, not REPLACING architecture.
