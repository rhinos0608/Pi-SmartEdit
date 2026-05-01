# Plan 4: Edit Pipeline & Completion

> **Date:** 2026-04-28
> **Status:** Ready for Implementation
> **Phase:** 4/4 (Capstone)
> **Depends on:** Plans 1, 2, 3
> **Estimate:** 2–3 days

---

## 1. Objective

Wire all three implemented plans together into a cohesive edit pipeline. After this plan, the `edit` tool transparently handles multi-format input, AST-enhanced scope narrowing, conflict detection, post-edit syntax validation, and LSP diagnostics — all in one call.

---

## 2. Current State

### Already Wired ✅
- AST resolver, conflict detector, LSP manager lifecycle (session_start/session_end)
- Post-edit validateSyntax call
- Post-edit LSP diagnostics hook
- Conflict warning collection + surfacing
- Atomic writes with BOM preservation
- Stale-file detection with retry (20ms)
- replaceAll side-channel for schema compatibility

### Still Missing ❌
1. **Multi-format pipeline not wired** — `src/pipeline.ts` exists but is never called from `index.ts`
2. **anchor/lineRange have no schema entry or side-channel** — they'll be rejected by TypeBox validation
3. **No end-to-end integration tests** — individual modules tested, but never together
4. **Stale-file retry is fragile** — single 20ms delay, no backoff

---

## 3. Implementation Items

### 3.1 Add anchor/lineRange/replaceAll Side-Channels

**File:** `index.ts`

**Problem:** TypeBox schema only has `oldText` and `newText`. `anchor`, `lineRange`, and `replaceAll` are rejected.

**Fix:** Extend the existing `pendingReplaceAllFlags` side-channel pattern:

```typescript
// Side-channel storage (sequential calls only, no races)
let pendingReplaceAllFlags: boolean[] | null = null;
let pendingAnchorData: (EditAnchor | undefined)[] | null = null;
let pendingLineRangeData: (LineRange | undefined)[] | null = null;
```

In `prepareArguments`, strip them:
```typescript
if (Array.isArray(args.edits)) {
  const flags: boolean[] = [];
  const anchors: (EditAnchor | undefined)[] = [];
  const ranges: (LineRange | undefined)[] = [];
  
  for (const edit of args.edits as Array<Record<string, unknown>>) {
    // replaceAll
    if (typeof edit.replaceAll === 'boolean') {
      flags.push(edit.replaceAll);
      delete edit.replaceAll;
    } else {
      flags.push(false);
    }
    // anchor
    if (edit.anchor && typeof edit.anchor === 'object') {
      anchors.push(edit.anchor as EditAnchor);
      delete edit.anchor;
    } else {
      anchors.push(undefined);
    }
    // lineRange
    if (edit.lineRange && typeof edit.lineRange === 'object') {
      ranges.push(edit.lineRange as LineRange);
      delete edit.lineRange;
    } else {
      ranges.push(undefined);
    }
  }
  
  if (flags.some(f => f)) pendingReplaceAllFlags = flags;
  if (anchors.some(a => a)) pendingAnchorData = anchors;
  if (ranges.some(r => r)) pendingLineRangeData = ranges;
}
```

In `execute()`, restore them:
```typescript
// Restore side-channel data
const localFlags = pendingReplaceAllFlags;
const localAnchors = pendingAnchorData;
const localRanges = pendingLineRangeData;
pendingReplaceAllFlags = null;
pendingAnchorData = null;
pendingLineRangeData = null;

for (let i = 0; i < edits.length; i++) {
  if (localFlags?.[i]) (edits[i] as Record<string, unknown>).replaceAll = true;
  if (localAnchors?.[i]) (edits[i] as Record<string, unknown>).anchor = localAnchors[i];
  if (localRanges?.[i]) (edits[i] as Record<string, unknown>).lineRange = localRanges[i];
}
```

### 3.2 Wire Multi-Format Pipeline

**File:** `index.ts` — in `prepareArguments`

**Problem:** When `edits` is a string that's not valid JSON, it could be a search/replace block or unified diff.

**Fix:** After JSON parsing fails in `prepareArguments`, try format detection + parsing:

```typescript
// In the edits-as-string handling in prepareArguments:
// After JSON.parse catches and all validation checks, add:
import { detectInputFormat } from './src/formats/format-detector';
import { parseSearchReplace } from './src/formats/search-replace';
import { parseUnifiedDiffToEditItems } from './src/formats/unified-diff';
import { parseOpenAIPatch, openAIPatchToEditItem } from './src/formats/openai-patch';

if (typeof args.edits === 'string') {
  // ... existing JSON parsing logic ...

  // If JSON parsing failed, try multi-format parsing
  if (!Array.isArray(parsed) && typeof args.edits === 'string') {
    const raw = (args.edits as string).trim();
    const format = detectInputFormat(raw);
    
    if (format !== 'raw_edits') {
      try {
        let parsedEdits: Array<{ path?: string; oldText: string; newText: string }> = [];
        
        switch (format) {
          case 'search_replace':
            parsedEdits = parseSearchReplace(raw);
            break;
          case 'unified_diff':
            parsedEdits = parseUnifiedDiffToEditItems(raw);
            break;
          case 'openai_patch':
            parsedEdits = parseOpenAIPatch(raw).map(p => openAIPatchToEditItem(p));
            break;
        }
        
        if (parsedEdits.length > 0) {
          // If the string contained a path hint, use it
          const pathHint = parsedEdits.find(e => e.path)?.path;
          if (pathHint && !args.path) {
            args.path = pathHint;
          }
          
          args.edits = parsedEdits.map(e => ({
            oldText: e.oldText,
            newText: e.newText,
          }));
        }
      } catch (formatError) {
        throw formatEditError(
          `Failed to parse ${format} format input: ${(formatError as Error).message}`,
        );
      }
    }
  }
}
```

**Integration point:** The multi-format parsing should go RIGHT AFTER the "edits as JSON string" section in `prepareArguments`, before the legacy format normalization.

### 3.3 End-to-End Integration Tests

**File:** `test/integration.test.ts`

Create comprehensive integration tests that exercise the full pipeline:

```typescript
// Test: Search/replace → parse → AST scope → apply → conflict detect → post-edit validate
// Test: Unified diff → parse → apply → conflict detect → LSP diagnostics
// Test: OpenAPI patch → parse → apply → post-edit validation
// Test: Edge case - search/replace with anchor that doesn't resolve → full search fallback
// Test: Edge case - conflict in "warn" mode → warning in result
// Test: Edge case - BOM-preserved round trip
// Test: Edge case - replaceAll with scope narrowing
```

### 3.4 Stale-File Hardening

**File:** `index.ts` — stale-file retry in `execute()`

Increase from 20ms single retry to 3 attempts with exponential backoff:

```typescript
// ── Stale file check with retry (handles macOS APFS mtime granularity) ──
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 50;

let staleError: string | null = null;
for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  staleError = await checkStale(path, cwd);
  if (!staleError) break;
  
  if (attempt < MAX_RETRIES - 1) {
    // Wait with exponential backoff before retry
    await new Promise(r => setTimeout(r, INITIAL_DELAY_MS * Math.pow(2, attempt)));
  }
}
```

---

## 4. File Changes Summary

| File | Change |
|------|--------|
| `index.ts` | Add anchor/lineRange side-channels (strip in prepareArguments, restore in execute); wire multi-format pipeline; harden stale-file retry with backoff |
| `test/integration.test.ts` | NEW — End-to-end integration tests |

---

## 5. Test Plan

### Integration Tests (12+)

| Test | What It Verifies |
|------|-----------------|
| Search/replace block → format detected → parsed → applyEdits succeeds | Full pipeline: format → parse → apply |
| Search/replace with anchor → AST resolves scope → edit narrows | Format + AST integration |
| Search/replace with conflict → warning surfaced | Format + conflict detector integration |
| Unified diff → parse → apply → edits correct | Format pipeline completeness |
| OpenAPI patch → parse → apply → edits correct | Format pipeline completeness |
| anchor in edit passes schema (side-channel) → restores in execute | Schema + execute integration |
| lineRange in edit passes schema → scope narrows | Schema + scope resolution |
| Stale-file retry succeeds after APFS delay | Robustness |
| BOM-preserved round-trip | BOM handling |
| Multiple edits with mixed replaceAll flags | Side-channel correctness |
| LSP diagnostics not available → graceful degradation | Error resilience |

---

## 6. Acceptance Criteria

- [ ] Search/replace blocks sent as `edits` string are parsed and applied
- [ ] Unified diffs sent as `edits` string are parsed and applied
- [ ] `anchor` and `lineRange` fields survive schema validation via side-channel
- [ ] Stale-file check retries up to 3 times with backoff
- [ ] All existing 39 tests + 12+ new tests pass
- [ ] Format detection + AST resolution + conflict detection + post-edit validation work together
- [ ] No silent drops of any edit field
