# Plan 2: Multi-Format Input Parser

> **Date:** 2026-04-28
> **Status:** Ready for Implementation
> **Phase:** 2/4
> **Depends on:** Plan 1 (AST-Enhancement Fixes)
> **Blocked by:** Nothing — can be implemented in parallel with Plan 1
> **Estimate:** 4–5 days

---

## 1. Objective

Add support for **three industry-standard edit formats** used by other AI coding agents. Convert all formats to the existing `EditItem[]` (oldText + newText) at the pipeline boundary, so the existing `applyEdits()` pipeline handles matching, replacement, indentation, and overlap detection.

---

## 2. Supported Formats

| Format | Used By | Detection Signal | Priority |
|--------|---------|-----------------|----------|
| **Search/Replace** (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`) | Aider, Cline, RooCode | `<<<<<<< SEARCH` | P0 |
| **Unified Diff** (`--- a/` / `+++ b/` / `@@ ... @@`) | OpenHands, Aider (udiff) | `--- ` + `+++ ` + `@@ ` | P0 |
| **OpenAI Patch** (`*** Begin Patch` / `@@` context lines) | Codex CLI | `*** Begin Patch` | P1 |

---

## 3. Architecture

```
LLM edit response text
         │
         ▼
  detectInputFormat(text)
         │
         ├── "search_replace" ──→ parseSearchReplace(text) ──→ EditItem[]
         ├── "unified_diff"   ──→ parseUnifiedDiff(text)   ──→ EditItem[]
         ├── "openai_patch"   ──→ parseOpenAIPatch(text)   ──→ EditItem[]
         └── "raw_edits"      ──→ (current JSON tool path)
                                    │
                                    ▼
                              applyEdits() pipeline
```

**Key design decision:** All parsers output `EditItem[]` (oldText/newText pairs). The existing `applyEdits()` in `edit-diff.ts` handles matching, replacement, indentation, overlap detection, and error formatting. No need to reimplement edit application for each format.

---

## 4. Module Structure

```
src/formats/
├── search-replace.ts   (NEW)
├── unified-diff.ts     (NEW)
├── openai-patch.ts     (NEW)
├── format-detector.ts  (NEW — auto-detection logic)
└── index.ts            (NEW — barrel export)
```

### 4.1 `format-detector.ts` — Auto-Detection

```typescript
export type InputFormat = 'search_replace' | 'unified_diff' | 'openai_patch' | 'raw_edits';

export function detectInputFormat(input: string): InputFormat {
  const trimmed = input.trim();
  if (trimmed.startsWith('<<<<<<< SEARCH')) return 'search_replace';
  if (trimmed.startsWith('*** Begin Patch') || trimmed.startsWith('***Begin Patch')) return 'openai_patch';
  if (trimmed.startsWith('--- ') && trimmed.includes('@@ ')) return 'unified_diff';
  return 'raw_edits';
}
```

### 4.2 `search-replace.ts` — Search/Replace Block Parser

**Input:**
```
filename.ts
<<<<<<< SEARCH
const oldValue = "old";
=======
const newValue = "new";
>>>>>>> REPLACE
```

**Parser:**
```typescript
export interface SearchReplaceBlock {
  path?: string;        // Optional filename line
  oldText: string;      // Content between SEARCH and ===
  newText: string;      // Content between === and REPLACE
}

export function parseSearchReplace(input: string): SearchReplaceBlock[] { ... }
```

**Edge cases:**
| Case | Behavior |
|------|----------|
| No filename line | `path` = `undefined` (caller uses file context) |
| Multiple blocks | All parsed, returned as array |
| Nested SEARCH/REPLACE markers inside code | Only top-level SEARCH/REPLACE markers trigger split |
| Truncated block (missing REPLACE) | Error: "Unclosed SEARCH block at position X" |
| Empty SEARCH section | Error: "SEARCH block has no oldText" |
| `=======` with whitespace on both sides | Strip whitespace around markers |
| CRLF line endings | Normalize to LF before parsing |

**Parsing algorithm:**
1. Split input by `>>>>>>> REPLACE` → get blocks
2. For each block, find `<<<<<<< SEARCH` and `=======` markers
3. Content between `SEARCH` and `=======` = oldText
4. Content between `=======` and `REPLACE` = newText
5. First line of the block, if it doesn't contain markers, is the filename hint
6. Map to `{ path?, oldText, newText }`

### 4.3 `unified-diff.ts` — Unified Diff Parser

**Input:**
```
--- a/file.ts
+++ b/file.ts
@@ -10,7 +10,7 @@
 const oldValue = "old";
+const newValue = "new";
```

**Parser:**
```typescript
export interface UnifiedDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];       // Each line with prefixes: ' ' unchanged, '-' removed, '+' added
}

export interface UnifiedDiff {
  oldFile: string;
  newFile: string;
  hunks: UnifiedDiffHunk[];
}

export function parseUnifiedDiff(input: string): UnifiedDiff[] { ... }
```

**Strategy:** Use `diff` library (already a dependency `diff@^7.0.0`) to parse hunks, then convert to `SearchReplaceBlock`:

```typescript
import { parsePatch } from 'diff';

export function parseUnifiedDiffToEditItems(input: string): Array<{
  path: string;
  oldText: string;
  newText: string;
}> {
  const patches = parsePatch(input);
  return patches.map(patch => ({
    path: patch.newFileName?.replace(/^[ab]\//, '') || patch.oldFileName?.replace(/^[ab]\//, ''),
    oldText: patch.hunks.map(h =>
      h.lines.filter(l => l.startsWith(' ') || l.startsWith('-'))
             .map(l => l.slice(1))
             .join('\n')
    ).join('\n'),
    newText: patch.hunks.map(h =>
      h.lines.filter(l => l.startsWith(' ') || l.startsWith('+'))
             .map(l => l.slice(1))
             .join('\n')
    ).join('\n'),
  }));
}
```

**Edge cases:**
| Case | Behavior |
|------|----------|
| No context lines (`-U0`) | Only changed lines, no surrounding context |
| Multi-hunk diff | Each hunk becomes separate oldText/newText pair |
| No-op hunk (all spaces) | Skip — no changes to apply |
| Malformed `@@` line | Return error with line number |
| `--- /dev/null` (new file) | oldText = "" (empty) |
| `+++ /dev/null` (deletion) | newText = "" (deletion) |

### 4.4 `openai-patch.ts` — OpenAI Patch Format Parser

**Input:**
```
*** Begin Patch
*** Update File: file.ts
@@ async function fetchUserData(userId) {
-  const response = await fetch(`/api/users/${userId}`);
+  const response = await fetch(`/api/users/${userId}`, { headers });
 }
*** End Patch
```

**Parser:**
```typescript
export interface OpenAIPatch {
  path: string;
  contextAnchor: string;   // The @@ anchor line
  removedLines: string[];  // Lines prefixed with '-'
  addedLines: string[];    // Lines prefixed with '+'
}

export function parseOpenAIPatch(input: string): OpenAIPatch[] { ... }
```

**Key detail:** The `@@` line is a **context anchor**, not a line number. It's used for fuzzy location matching. The oldText is the `@@` anchor line + all `-` prefixed lines.

**OldText construction:** `contextAnchor + "\n" + removedLines.join("\n")`
**NewText construction:** `contextAnchor + "\n" + addedLines.join("\n")`

**Edge cases:**
| Case | Behavior |
|------|----------|
| No context anchor | Use first removed line as anchor |
| Multi-section patch | Each `@@` section → separate edit |
| Missing `*** End Patch` | Try to parse anyway, warn about truncation |
| No `-` lines (add-only) | oldText = contextAnchor only |

---

## 5. Integration Point in Pipeline

### 5.1 New File: `pipeline.ts`

```typescript
import { detectInputFormat, type InputFormat } from './formats/format-detector';
import { parseSearchReplace } from './formats/search-replace';
import { parseUnifiedDiffToEditItems } from './formats/unified-diff';
import { parseOpenAIPatch } from './formats/openai-patch';
import { applyEdits } from './lib/edit-diff';

export interface PipelineInput {
  /** The file path (required for raw edits, optional for format-embedded patches) */
  path?: string;
  /** The edit content — could be raw edits, search/replace blocks, etc. */
  content: string;
  /** Override auto-detected format */
  format?: InputFormat;
}

export interface PipelineResult {
  success: boolean;
  edits: Array<{ path: string; oldText: string; newText: string }>;
  applied: boolean;
  matchNotes: string[];
  error?: string;
}

export async function runEditPipeline(
  input: PipelineInput,
  fileContent: string,
): Promise<PipelineResult> {
  const format = input.format || detectInputFormat(input.content);

  let editItems;
  switch (format) {
    case 'search_replace':
      editItems = parseSearchReplace(input.content);
      break;
    case 'unified_diff':
      editItems = parseUnifiedDiffToEditItems(input.content);
      break;
    case 'openai_patch':
      editItems = parseOpenAIPatch(input.content);
      break;
    case 'raw_edits':
      return { success: true, edits: [], applied: false, matchNotes: [] };
  }

  // If a path was explicitly provided, use it for edits without path info
  for (const item of editItems) {
    if (!item.path && input.path) {
      item.path = input.path;
    }
  }

  // Apply each file's edits through existing applyEdits pipeline
  // Group by path
  const byPath = groupBy(editItems, (e) => e.path);
  const results = [];

  for (const [filePath, fileEdits] of Object.entries(byPath)) {
    const result = await applyEdits(fileContent, fileEdits.map(e => ({
      oldText: e.oldText,
      newText: e.newText,
    })), filePath);
    results.push(result);
  }

  return {
    success: true,
    edits: editItems,
    applied: true,
    matchNotes: results.flatMap(r => r.matchNotes),
  };
}
```

### 5.2 Wire into `index.ts`

The pipeline integrates as a **pre-processing step** before the current `execute()`:

```typescript
// In execute(), before applyEdits:
const format = detectInputFormat(edits);
if (format !== 'raw_edits') {
  // The "edits" field is actually a formatted patch string
  const pipelineResult = await runEditPipeline(
    { content: edits },  // edits is a string here
    normalizedContent,
  );
  // ... handle result ...
}
```

---

## 6. File Changes Summary

| File | Change |
|------|--------|
| `src/formats/format-detector.ts` | NEW — format auto-detection |
| `src/formats/search-replace.ts` | NEW — SEARCH/REPLACE block parser |
| `src/formats/unified-diff.ts` | NEW — Unified diff parser |
| `src/formats/openai-patch.ts` | NEW — OpenAI patch parser |
| `src/formats/index.ts` | NEW — barrel export |
| `src/pipeline.ts` | NEW — multi-strategy pipeline |
| `lib/edit-diff.ts` | No changes (reuses existing API) |
| `index.ts` | Add format detection before edit processing |

---

## 7. Test Plan

### Unit Tests (22+ tests)

| Test Suite | Tests | Key Cases |
|-----------|-------|-----------|
| `format-detector.test.ts` | 6 | All 4 formats detected correctly; ambiguous input; empty input |
| `search-replace.test.ts` | 8 | Valid block; multiple blocks; nested markers; missing filename; trailing whitespace; truncated block |
| `unified-diff.test.ts` | 8 | Single hunk; multi-hunk; `-U0`; new file (/dev/null); deletion; malformed @@ line; |
| `openai-patch.test.ts` | 6 | Single section; multi-section; missing End Patch; add-only; remove-only |

### Integration Tests (4+)

| Test | What It Verifies |
|------|-----------------|
| Format round-trip: search/replace → parse → applyEdits | End-to-end correctness |
| Format round-trip: unified diff → parse → applyEdits | End-to-end correctness |
| Format round-trip: OpenAI patch → parse → applyEdits | End-to-end correctness |
| All formats produce same output for same logical change | Format equivalence |

### Test Fixtures

```
test/fixtures/formats/
├── search-replace-simple.txt
├── search-replace-multiple.txt
├── search-replace-nested.txt
├── unified-diff-simple.diff
├── unified-diff-multi-hunk.diff
├── unified-diff-newfile.diff
├── openai-patch-simple.txt
└── openai-patch-multi.txt
```

---

## 8. Dependencies

No new npm dependencies needed:
- `diff` (v7.0.0) — already in `package.json`, used for unified diff parsing (`parsePatch`)
- For search/replace and OpenAI patch: pure string parsing, zero deps

---

## 9. Acceptance Criteria

- [ ] All 3 format parsers correctly extract oldText/newText from sample inputs
- [ ] Format auto-detection correctly identifies all 4 formats (including raw_edits)
- [ ] Parsed edits flow correctly through `applyEdits()` — no regression
- [ ] Edge cases: nested markers, truncated blocks, /dev/null files, missing filenames
- [ ] 22+ unit tests pass
- [ ] Integration test: search/replace → parse → apply → verify file content matches
