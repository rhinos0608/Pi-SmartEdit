# Hashline Edit Mode — Technical Specification

> **Status**: Proposal  
> **Version**: 1.0  
> **Date**: 2026-05-01  
> **Author**: Smart Edit Architecture Analysis  
> **Reference**: oh-my-pi hashline mode (can1357/oh-my-pi, packages/coding-agent/src/edit/modes/hashline.ts)

---

## 1. Problem Statement

Smart Edit's current edit tool asks the model to reproduce `oldText` exactly, then applies a 4-tier fuzzy matching pipeline (Exact → Indentation → Unicode → Similarity) when that reproduction inevitably fails. This approach:

- Burns output tokens on retry loops when whitespace/formatting drift prevents matching
- Fails disproportionately on weak models (Grok Code Fast 1: 6.7% success)
- Requires elaborate fallback infrastructure to paper over a fundamental mismatch between model capabilities and task requirements

The hashline approach eliminates the root cause: it never asks the model to reproduce text. Lines are tagged with short content hashes, and edits reference those hashes instead of raw text.

## 2. Design Principles

1. **Never reproduce text.** The model references `LINE+ID` anchors (e.g., `42ab`), not raw text. Whitespace reproduction errors, smart quote drift, and indentation variance simply cannot occur.
2. **Hash-as-freshness-check.** If the file changed since the last read, hashes won't match and the edit is rejected before any mutation.
3. **Hard rejection, not silent relocation.** Unlike similarity-based matching, a hash mismatch is a hard error with clear diagnostics — no silently editing the wrong location.
4. **AST scoping as complement, not replacement.** Hashline anchors handle precision and freshness; AST symbol targeting handles disambiguation across identically-hashed structural lines.
5. **Preserve existing investment.** The 4-tier pipeline remains as a safety net, not the primary mechanism.

## 3. Architecture Overview

### 3.1 System Context

```
┌────────────────────────────────────────────────────────────────────┐
│                         LLM (Model)                                 │
│  Reads file → gets LINE+ID|content                                  │
│  Emits edits → { anchor: { symbol?, range }, content: string[] }   │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│                   Smart Edit Extension                              │
│                                                                     │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────────────────┐ │
│  │ Read Hook   │   │ Edit Tool    │   │ Post-Apply Pipeline     │ │
│  │             │   │              │   │                         │ │
│  │ hashlines   │──▶│ validateHash │──▶│ • LSP diagnostics       │ │
│  │ file content │   │ ▼            │   │ • AST syntax validation │ │
│  │ on read      │   │ applyDirect  │   │ • Conflict recording   │ │
│  └─────────────┘   │ ▼            │   │ • Diff generation       │ │
│                    │ scopedFallback│   └─────────────────────────┘ │
│                    │ ▼            │                                 │
│                    │ fullFuzzy     │                                 │
│                    └──────────────┘                                 │
└────────────────────────────────────────────────────────────────────┘
```

### 3.2 Edit Flow

```
EDIT REQUEST
    │
    ▼
┌─────────────────────────────┐
│ 1. Parse anchor.range        │  Extract LINE+ID from pos/end anchors
│    Parse anchor.symbol       │  Extract AST symbol target if provided
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 2. Read file from disk       │  Get current file content
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ 3. Validate hashes           │  computeLineHash(anchor.line, file[line])
│    ┌──────────┐             │  vs anchor.hash
│    │ Match?   │──Yes────────▶ 4. APPLY DIRECT (fast path)
│    └────┬─────┘             │     ~90% of edits take this path
│         │No                 │
│         ▼                   │
│    ┌──────────────┐        │
│    │ tryRebase    │        │  Search ±5 lines for matching hash
│    │ ±5 window    │        │  Only accepts same hash, different pos
│    └──┬──────┬────┘        │
│       │Found │Ambiguous    │
│       ▼      ▼             │
│   Rebase  ┌──────────┐    │
│   +warn   │ symbol?  │    │
│           └──┬───┬───┘    │
│              │Yes│No      │
│              ▼   ▼        │
│         5. SCOPED     6. FULL FUZZY
│         FALLBACK      FALLBACK
│         (AST scope    (4-tier
│          narrows       pipeline
│          search)       as safety net)
└─────────────────────────────┘
```

## 4. Hash Algorithm

### 4.1 Requirements

- Fast (sub-μs per line) — must not add latency to read operations
- Deterministic — same line always produces same hash
- Collision-resistant enough for ±5-line rebase windows (~1/647 per line)
- Single-token BPE representation — `42ab` must be 1 token, not 4

### 4.2 Algorithm

```
computeLineHash(lineNumber, lineText):
    1. Strip CR, trim trailing whitespace
    2. If line contains only whitespace and {/}:
       → Return ordinal suffix bigram (1st, 2nd, 3rd, 4th, ...)
       → LINE+bigram merges into single ordinal token
    3. Set seed = 0
    4. If line contains no alphanumeric characters:
       → seed = lineNumber (prevents hash collisions on separator lines)
    5. hash = xxHash32(lineText, seed) % 647
    6. Return HASHLINE_BIGRAMS[hash]
```

### 4.3 Bigram Table

647 single-token BPE bigrams. Every entry tokenizes as exactly 1 token in cl100k, o200k, and Claude family vocabularies. The table is **stable forever** — changing order would invalidate all saved LINE+ID references.

```typescript
// Abbreviated — full table is 647 entries
const HASHLINE_BIGRAMS = [
  "aa","ab","ac","ad","ae","af","ag","ah","ai","aj","ak","al","am","an","ao",
  "ap","aq","ar","as","at","au","av","aw","ax","ay","az",
  "ba","bb","bc","bd","be","bf","bg","bh","bi","bj","bk","bl","bm","bn","bo",
  // ... 597 more entries ...
  "za","zb","zc","zd","ze","zf","zg","zh","zi","zk","zl","zm","zn","zo",
  "zp","zr","zs","zt","zu","zw","zx","zy","zz"
] as const;
```

### 4.4 Structural Bigrams

Lines containing only whitespace and braces (`{`, `}`) get ordinal-suffix bigrams:

| Line # | Bigram | Rationale |
|--------|--------|-----------|
| 1 | `st` | `1st` — ordinal, merges to 1 BPE token |
| 2 | `nd` | `2nd` — ordinal, merges to 1 BPE token |
| 3 | `rd` | `3rd` — ordinal, merges to 1 BPE token |
| 4 | `th` | `4th` — ordinal, merges to 1 BPE token |
| 11-13 | `th` | Special case for 11th/12th/13th |
| 21 | `st` | `21st` — ordinal |
| 42 | `nd` | `42nd` — ordinal |

This is a significant optimization: brace-only structure costs **0 additional tokens** beyond the line number digits.

### 4.5 Dependency

Smart Edit currently uses Node.js `crypto.createHash("sha256")` for content hashing. The hashline system requires `xxHash32`. Options:

| Option | Size | Speed | Notes |
|--------|------|-------|-------|
| `xxhash-wasm` | ~10KB WASM | ~2 GB/s | Pure JS fallback, works everywhere |
| `xxhash-addon` | Native | ~15 GB/s | Requires native build |
| Bun built-in | 0 | ~10 GB/s | `Bun.hash.xxHash32()` — runtime-dependent |

**Recommendation**: `xxhash-wasm` for portability. If running in Bun, auto-detect and use native.

## 5. Schema

### 5.1 Edit Tool Input

```typescript
interface HashlineEditInput {
  path: string;

  edits: Array<{
    /** Where to apply the edit */
    anchor: {
      /** Optional AST symbol scoping */
      symbol?: {
        /** Name of enclosing symbol (function, class, etc.) */
        name: string;
        /** Kind of symbol */
        kind?: "function" | "method" | "class" | "interface" | "type" | "variable";
        /** 1-based line number hint for disambiguation */
        line?: number;
      };

      /** Required hash-anchored range */
      range: {
        /** Full anchor (e.g., "42ab") — first line to edit (inclusive) */
        pos: string;
        /** Full anchor (e.g., "45cd") — last line to edit (inclusive) */
        end: string;
      };
    };

    /** Replacement lines (string[] — one per logical line) or null to delete */
    content: string[] | null;
  }>;
}
```

### 5.2 Backward Compatibility

The existing `{ oldText, newText, replaceAll?, anchor?, lineRange? }` schema remains supported. The system detects which format is being used:

```typescript
function detectEditFormat(edit: Record<string, unknown>): "hashline" | "legacy" {
  if (edit.anchor && typeof edit.anchor === "object" && "range" in edit.anchor) {
    return "hashline";
  }
  if (typeof edit.oldText === "string") {
    return "legacy";
  }
  throw new Error("Unknown edit format");
}
```

### 5.3 Read Output Augmentation

The read tool output is augmented with hashline prefixes. This is NOT a schema change — it's a hook that transforms the display format:

```
Raw file content:
function hello() {
  return "world";
}

Read output (LLM sees):
1th|function hello() {
2er|  return "world";
3in|}
```

The hashline prefix stripping is applied by the edit tool when resolving `content`, so the model doesn't need to reproduce or strip them.

### 5.4 Search/Grep Output

When `search_symbols` or grep tools return results, each line also carries a LINE+ID anchor:

```
src/hello.ts:2:  2er|  return "world";
```

## 6. Application Logic

### 6.1 Fast Path: Direct Apply

When all hashes match, edits are applied directly — sorted bottom-up to preserve line numbering through multiple splices:

```typescript
function applyHashlineEdits(
  fileLines: string[],
  edits: ResolvedHashlineEdit[],
): { lines: string[]; firstChangedLine: number | undefined } {
  // 1. Validate all hashes
  const mismatches = validateAllHashes(fileLines, edits);
  if (mismatches.length > 0) {
    throw new HashlineMismatchError(mismatches, fileLines);
  }

  // 2. Deduplicate identical edits
  dedupeEdits(edits);

  // 3. Sort bottom-up: highest line first
  //    Prevents earlier splices from invalidating later line numbers
  const sorted = edits.sort((a, b) => {
    const aLine = a.op === "append_file" ? fileLines.length + 1
                : a.op === "prepend_file" ? 0
                : a.op === "replace_range" ? a.end.line
                : a.pos.line;
    const bLine = /* ... same ... */;
    return bLine - aLine || precedenceCompare(a, b);
  });

  // 4. Apply sequentially
  let firstChanged: number | undefined;
  for (const edit of sorted) {
    const changedLine = applySingleEdit(fileLines, edit);
    if (firstChanged === undefined || changedLine < firstChanged) {
      firstChanged = changedLine;
    }
  }

  return { lines: fileLines, firstChangedLine: firstChanged };
}
```

### 6.2 Anchor Rebase

When a hash doesn't match the requested line, attempt rebasing within ±5 lines:

```typescript
const ANCHOR_REBASE_WINDOW = 5;

function tryRebaseAnchor(
  anchor: { line: number; hash: string },
  fileLines: string[],
): "exact" | { rebasedLine: number } | "mismatch" {
  // Check exact position first
  const exactHash = computeLineHash(anchor.line, fileLines[anchor.line - 1]);
  if (exactHash === anchor.hash) return "exact";

  // Search ±window for the hash
  const lo = Math.max(1, anchor.line - ANCHOR_REBASE_WINDOW);
  const hi = Math.min(fileLines.length, anchor.line + ANCHOR_REBASE_WINDOW);
  let found: number | null = null;

  for (let line = lo; line <= hi; line++) {
    if (line === anchor.line) continue;
    if (computeLineHash(line, fileLines[line - 1]) !== anchor.hash) continue;
    if (found !== null) return "mismatch"; // ambiguous — multiple matches
    found = line;
  }

  return found !== null ? { rebasedLine: found } : "mismatch";
}
```

### 6.3 Scoped Fallback

When hashes genuinely don't match AND a symbol anchor was provided, narrow the search using AST scoping:

```typescript
async function scopedFallbackApply(
  edit: HashlineEdit,
  fileContent: string,
  astResolver: AstResolver,
): Promise<ApplyResult> {
  // Resolve symbol to byte range
  const scope = await resolveSymbolToScope(
    edit.anchor.symbol!,
    fileContent,
    astResolver,
  );

  if (!scope) {
    // Symbol not found → escalate to full fuzzy
    return fullFuzzyApply(edit, fileContent);
  }

  // Try 4-tier matching within the scoped range
  const match = findText(
    fileContent,
    reconstructOldText(edit),  // From hash-anchored original read
    detectIndentation(fileContent),
    0,
    scope,  // Narrowed search scope
  );

  if (match.found) {
    return applyMatch(fileContent, match, edit.content);
  }

  // Even scoped match failed — last resort
  return fullFuzzyApply(edit, fileContent);
}
```

### 6.4 Full Fuzzy Fallback

When both hash validation and scoped matching fail, fall through to the existing 4-tier pipeline as a safety net:

```typescript
function fullFuzzyApply(
  edit: HashlineEdit,
  fileContent: string,
): ApplyResult {
  // Reconstruct oldText from the original read content
  // (stored alongside hashes in the read cache)
  const oldText = reconstructOldTextFromCache(edit.anchor.range);

  // Run through existing 4-tier pipeline
  const match = findText(
    fileContent,
    oldText,
    detectIndentation(fileContent),
  );

  if (match.found) {
    return applyMatch(fileContent, match, edit.content);
  }

  throw new EditMatchError(/* ... */);
}
```

## 7. Read Cache Enhancement

The existing `FileSnapshot` type must be extended to preserve hashline anchors:

```typescript
// lib/types.ts — extension to FileSnapshot
interface FileSnapshot {
  path: string;
  mtimeMs: number;
  size: number;
  contentHash: string;    // Existing: SHA-256 truncated
  readAt: number;
  partial?: boolean;

  // NEW: Hashline data
  hashline?: {
    /** Map from LINE+ID anchor to content for each line */
    anchors: Map<string, { text: string; line: number }>;
    /** The formatted content with hashline prefixes (for reconstruction) */
    formattedContent: string;
  };
}
```

The read hook in `index.ts` is augmented:

```typescript
// After reading file content in the read hook:
const lines = content.split("\n");
const anchors = new Map();
const formattedLines: string[] = [];

for (let i = 0; i < lines.length; i++) {
  const lineNum = i + 1;
  const hash = computeLineHash(lineNum, lines[i]);
  const anchor = `${lineNum}${hash}`;
  anchors.set(anchor, { text: lines[i], line: lineNum });
  formattedLines.push(`${anchor}|${lines[i]}`);
}

recordRead(path, cwd, content, isPartial, {
  hashline: {
    anchors,
    formattedContent: formattedLines.join("\n"),
  },
});
```

## 8. Conflict Detection Integration

The existing conflict detector (`lib/conflict-detector.ts`) operates on byte ranges in the AST. Hashline edits map naturally to this:

```typescript
// After successful hashline edit application:
const spans = editSpans.map(edit => ({
  startIndex: lineToByteOffset(fileContent, edit.pos.line),
  endIndex: lineToByteOffset(fileContent, edit.end.line) 
           + fileContent.split("\n")[edit.end.line - 1].length,
}));

await conflictDetector.recordEdit(path, fileContent, spans);
```

No changes needed to the conflict detector — it already operates on byte ranges.

## 9. Token Economics

### 9.1 Anchor Token Cost

| Scenario | Cost (tokens) |
|----------|---------------|
| Regular line anchor (`42ab`) | 1 (merged BPE token) |
| Structural line anchor (`1st`) | 1 (merged ordinal token) |
| Full anchor reference in JSON (`"42ab"`) | 2 (quote + merged anchor) |
| Raw oldText reproduction (typical) | 8-40 (depending on line length) |

### 9.2 Retry Loop Elimination

The 61% output token reduction on Grok 4 Fast comes from eliminating:

```
Turn 1: Model emits oldText with whitespace bugs → match fails
Turn 2: LLM retries with "corrected" oldText → still slightly wrong → match fails  
Turn 3: Fuzzy matching finally accepts → edit applied, but 2 turns of tokens wasted
```

With hashline:
```
Turn 1: Model emits "42ab" → hash matches → applied directly
```

### 9.3 Expected Savings

| Model Class | Expected Token Reduction | Success Rate Improvement |
|-------------|-------------------------|--------------------------|
| Strong (Claude, GPT-5) | 10-20% (fewer retries) | +2-5pp (near-perfect already) |
| Medium (Gemini Flash, GPT-4o) | 25-40% | +5-15pp |
| Weak (Grok Fast, MiniMax) | 50-65% | +20-60pp (dramatic) |

## 10. Error Handling

### 10.1 HashlineMismatchError

When hashes don't match, the error shows:

```
Edit rejected: 2 lines have changed since the last read (marked *).
The edit was NOT applied, please re-read the file and try again.

 41ab|  return user.name;
*42xy|  return user.getName();    ← hash mismatch: expected 42cd
 43ef|}
```

The model receives both the existing LINE+ID anchors (context lines) and the corrected anchors (mismatch lines), so it can immediately issue a corrected edit without re-reading.

### 10.2 Ambiguous Rebase

When `tryRebaseAnchor` finds the hash in multiple nearby positions:

```
Edit rejected: ambiguous anchor "42ab" — hash found at lines 40 and 44.
Re-read the file for current content before editing.
```

### 10.3 Fallthrough Warning

When a hash mismatch falls through to scoped or full fuzzy matching:

```
Note: hash mismatch on anchors 42ab,43cd — file changed since last read.
AST scoping resolved edit to "getUser" function body.
```

## 11. Performance Considerations

### 11.1 Read Overhead

Hashing each line adds ~1μs per line. For a 10,000-line file: ~10ms overhead on read. Acceptable.

### 11.2 Hash Collision Risk

- 647-entry bigram table → 1/647 collision chance per line
- Structural bigrams (ordinal suffixes) reduce collisions on the most common structure
- ±5-line rebase window makes practical collisions rarer: two different lines within 5 lines of each other would need the same hash
- Even if a collision occurs: mismatched edit is caught by content comparison before any write

### 11.3 Memory

Storing anchors in FileSnapshot: ~50 bytes per line (anchor string + text pointer). For a 10,000-line file: ~500KB. Acceptable for in-memory cache.

## 12. Test Strategy

### 12.1 Unit Tests

| Test | Description |
|------|-------------|
| `computeLineHash` | Determinism, collision rate, structural bigrams |
| `tryRebaseAnchor` | Exact match, ±5 window, ambiguous rejection, out-of-bounds |
| `applyHashlineEdits` | Replace, append, prepend, delete, multi-edit sorting, noop detection |
| `HashlineMismatchError` | Error format, remap correctness, display vs model messages |
| `hashlineParseText` | Prefix stripping, null handling, truncation notice filtering |
| `hashlineEditSchema` | Valid/invalid JSON, anchor format validation |

### 12.2 Integration Tests

| Test | Description |
|------|-------------|
| Full edit flow | Read → hash → edit → verify correct output |
| Stale rejection | Modify file after read, verify edit rejected with correct error |
| Rebase success | Add lines above target, verify edit auto-rebases within window |
| Symbol scoping | Two functions with same body text, verify edit targets correct one |
| Fallthrough behavior | Corrupt hashes, verify fuzzy fallback still works |
| Backward compatibility | Legacy `{ oldText, newText }` format continues to work |

### 12.3 Benchmark Tests

Adapt oh-my-pi's benchmark suite (180 tasks, 16 models, 3 runs each) to compare:

- Smart Edit 4-tier (baseline)
- Smart Edit + hashline (new)
- oh-my-pi hashline (reference)
- oh-my-pi replace (comparison point)

## 13. Migration Path

### Phase 1: Parallel Operation (Non-breaking)
- Add hashline mode alongside existing legacy mode
- Legacy `{ oldText, newText }` continues to work identically
- New `{ anchor: { range: {pos, end} }, content }` format uses hashline
- Models choose which format to use based on prompt instructions

### Phase 2: Deprecation (Optional)
- If benchmark data confirms hashline superiority across all model classes
- Add deprecation warning to legacy format (still functional)
- Update prompt templates to prefer hashline format

### Phase 3: Removal (Distant future, if ever)
- Only if hashline consistently outperforms across ALL models
- Keep the fuzzy pipeline for fallthrough, not as primary mechanism
- Never remove outright — always keep as safety net

## 14. Open Questions

1. **xxHash32 dependency**: `xxhash-wasm` vs native? Bun auto-detection?
2. **Read cache memory**: Should we limit anchor storage to last-N-files to bound memory?
3. **Search tool integration**: Should `search_symbols` also emit hashline anchors? Cost/benefit?
4. **Prompt tuning**: Should the model be instructed to prefer hashline format or use both? What's the right prompt density?
5. **Symbol kind granularity**: `function` vs `method` vs `arrow_function`? How precise should symbol kind be?

## 15. References

- [oh-my-pi hashline implementation](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/edit/modes/hashline.ts)
- [hashline line-hash utilities](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/edit/line-hash.ts)
- [hashline prompt template](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/prompts/tools/hashline.md)
- [edit benchmark runner](https://github.com/can1357/oh-my-pi/blob/main/packages/typescript-edit-benchmark/src/runner.ts)
- [Smart Edit current codebase](./)
