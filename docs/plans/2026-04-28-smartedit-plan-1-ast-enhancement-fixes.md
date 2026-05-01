# Plan 1: AST-Enhanced Editing — Fixes & Integration

> **Date:** 2026-04-28
> **Status:** Ready for Implementation
> **Phase:** 1/4 (Foundational)
> **Depends on:** Phase 2 complete codebase
> **Blocked by:** Nothing
> **Estimate:** 3–5 days

---

## 1. Objective

Fix the **five remaining integration gaps** between the existing AST resolver, conflict detector, and edit pipeline, then wire them together end-to-end. The scaffolding exists (`ast-resolver.ts`, `grammar-loader.ts`, `conflict-detector.ts`) but was never fully connected to the `applyEdits` call path.

---

## 2. Current State vs Target

| Area | Current | Target |
|------|---------|--------|
| `onResolveAnchor` | Silently dropped — no field in `ApplyEditsOptions` | Resolves anchor to `SearchScope` before `findText` |
| Anchor/lineRange | Stripped in `prepareArguments` | Preserved through schema validation |
| Conflict warnings | Checked but never surfaced in result | Included in match notes or error message |
| SearchScope generation | `resolveAnchorToScope` only handles AST symbols | Also handles `lineRange` → `SearchScope` |
| Post-edit AST validation | Not implemented | Run after edit, warn on syntax errors |
| Test coverage | 32 tests (text-only) | +15 tests for AST integration path |

---

## 3. Detailed Work Items

### 3.1 Fix `ApplyEditsOptions` — Add `onResolveAnchor`

**File:** `lib/edit-diff.ts`
**Problem:** `index.ts` passes `onResolveAnchor` to `applyEdits()` but the type doesn't exist.

**Change:**
```typescript
// In ApplyEditsOptions interface (around line 740)
export interface ApplyEditsOptions {
  /** Pre-computed search scopes for narrowing text matching */
  searchScopes?: (SearchScope | undefined)[];

  /** Called with resolved match spans before applying, e.g., for conflict detection */
  onBeforeApply?: (spans: MatchSpan[], content: string) => void;

  /** NEW: Called per-edit to resolve anchor/lineRange to a SearchScope.
   *  Returns null if no scope could be determined. */
  onResolveAnchor?: (
    edit: EditItem,
    content: string,
    filePath: string,
  ) => Promise<SearchScope | null> | SearchScope | null;
}
```

Then **inside** `applyEdits()`, before the match phase (before Phase 1), add:

```typescript
// Resolve search scopes from anchors/lineRanges
const searchScopes: (SearchScope | undefined)[] = [];
if (options?.onResolveAnchor || options?.searchScopes) {
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (options?.searchScopes?.[i]) {
      searchScopes.push(options.searchScopes[i]);
    } else if (options?.onResolveAnchor) {
      const scope = await options.onResolveAnchor(
        normalizedEdits[i],
        normalizedContent,
        options.filePath || path,
      );
      searchScopes.push(scope ?? undefined);
    } else {
      searchScopes.push(undefined);
    }
  }
}
```

**⚠️ Important:** `applyEdits` currently returns synchronously. Adding `await` makes it async. This cascades to the caller in `index.ts` and to all test callers.

**Upgrade path for sync callers:** Make `applyEdits` async. Tests that don't need anchor resolution can pass no options (no behavioral change, just `await` the call).

### 3.2 Preserve `anchor` and `lineRange` Through prepareArguments

**File:** `index.ts`
**Problem:** Lines that strip `replaceAll` also delete `anchor` and `lineRange`:

```typescript
// In prepareArguments — this kills anchor and lineRange
for (const edit of args.edits as Array<Record<string, unknown>>) {
  delete edit.anchor;    // <-- WRONG: strips anchor
  delete edit.lineRange; // <-- WRONG: strips lineRange
}
```

**Fix:** Remove these deletions. `anchor` and `lineRange` are valid schema extensions. Since we already handle the schema with a custom `execute` path (not Pi's built-in validator), these extra fields won't cause issues.

```typescript
// Remove these two lines — anchor and lineRange are legitimate extension fields.
// delete edit.anchor;    // REMOVED
// delete edit.lineRange; // REMOVED
```

### 3.3 Surface Conflict Warnings in Edit Result

**File:** `index.ts` `execute()` method
**Problem:** `checkConflicts()` runs but its warnings are never surfaced.

**Fix:** Capture conflict warnings and include them in the match notes:

```typescript
// Before applyEdits call
const conflictMessages: string[] = [];
if (conflictDetector) {
  const editSpans = edits.map((e) => {
    const startIndex = normalizedContent.indexOf(normalizeToLF(e.oldText));
    return {
      startIndex,
      endIndex: startIndex >= 0 ? startIndex + normalizeToLF(e.oldText).length : 0,
    };
  });

  const conflicts = await conflictDetector.checkConflicts(
    path,
    normalizedContent,
    editSpans,
  );

  if (conflicts.length > 0) {
    if (defaultConflictConfig.onConflict === "error") {
      throw new Error(formatConflictWarning(conflicts));
    }
    // "warn" mode: collect to surface later
    for (const c of conflicts) {
      conflictMessages.push(`⚠ ${c.suggestion}`);
    }
  }
}

// Then in the result:
const allNotes = [...(result.matchNotes || []), ...conflictMessages];
```

### 3.4 Add `searchScopes` Parameter to `findAllMatches`

**File:** `lib/edit-diff.ts`
**Status:** Already implemented (check). The `searchScope` parameter exists on `findAllMatches`. Tests exist.

No changes needed for this item.

### 3.5 Post-Edit Syntax Validation

**File:** `lib/ast-resolver.ts` (new function) + `index.ts` (call site)
**New function:** `validateSyntax(content, filePath) → { valid, warnings }`

```typescript
export async function validateSyntax(
  content: string,
  filePath: string,
): Promise<{ valid: boolean; error?: string }> {
  const parseResult = await parseFile(content, filePath);
  if (!parseResult) return { valid: true, warnings: ['No parser available'] };
  try {
    if (parseResult.hasErrors) {
      return { valid: false, error: 'Syntax error detected after edit' };
    }
    return { valid: true };
  } finally {
    disposeParseResult(parseResult);
  }
}
```

Wire into `index.ts` after `applyEdits()` but before write:

```typescript
// Post-edit syntax validation
if (astResolver) {
  const syntaxResult = await validateSyntax(normalizedContent, path);
  if (!syntaxResult.valid) {
    allNotes.push(`⚠ ${syntaxResult.error}`);
  }
}
```

---

## 4. File Changes Summary

| File | Change |
|------|--------|
| `lib/edit-diff.ts` | Make `applyEdits` async; add `onResolveAnchor` to `ApplyEditsOptions`; add filePath to options |
| `index.ts` | Stop stripping anchor/lineRange; surface conflict warnings; add post-edit validation |
| `lib/ast-resolver.ts` | Add `validateSyntax` export |
| `lib/types.ts` | No changes needed |

---

## 5. Test Plan

### New / Updated Tests

| Test | What It Verifies |
|------|-----------------|
| `applyEdits with anchor → SearchScope` | anchor resolves to byte range, search narrows |
| `applyEdits with lineRange → SearchScope` | line range converts correctly |
| `anchor not found → falls back to full search` | graceful degradation preserves match |
| `onResolveAnchor returns null → no scope applied` | null is handled as "no narrowing" |
| `Conflict warnings surfaced in matchNotes` | warnings appear in result |
| `Post-edit validation warns on syntax error` | broken code triggers warning |
| `onResolveAnchor async resolution` | Promise-returning resolver works |

---

## 6. Migration Notes

1. **`applyEdits` becomes async.** All callers need `await`. Tests need `await` on every `applyEdits` call.
2. **No existing edit behavior changes** when `onResolveAnchor` is not provided — the function works identically without scope narrowing.
3. **Anchor + lineRange fields now survive `prepareArguments`.** If Pi's schema validator rejects unknown fields, we may need to add them to the schema. Verify with a real Pi session.

---

## 7. Acceptance Criteria

- [ ] `edit({ path, edits: [{ oldText, newText, anchor: { symbolName } }]})` resolves anchor
- [ ] Anchor/non-matching symbol → full-file search with matchNote
- [ ] `lineRange` narrows search to specified lines
- [ ] Conflict detector warnings appear in edit result
- [ ] Post-edit syntax validation warns on broken code
- [ ] All 32 existing tests + new tests pass
- [ ] No silent drops of `onResolveAnchor` or `searchScopes`
