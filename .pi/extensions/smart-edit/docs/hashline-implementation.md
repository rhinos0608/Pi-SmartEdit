# Hashline Edit Mode — Implementation Plan

> **Status**: Planning  
> **Spec Reference**: [hashline-spec.md](./hashline-spec.md)  
> **Codebase**: `/Users/rhinesharar/Pi-SmartEdit/.pi/extensions/smart-edit`  
> **Total LOC**: ~3,800 (existing), ~1,200 (new + modified)  
> **Phases**: 5  
> **Estimated effort**: 5-6 weeks

---

## Phase Overview

| Phase | Weeks | What | Risk | Dependency |
|-------|-------|------|------|------------|
| 1: Foundation | 1-2 | xxHash32, bigram table, line hashing | Low | None |
| 2: Hashline Mode | 2-3 | Edit schema, apply logic, rebase | Low | Phase 1 |
| 3: AST Scoping | 3-4 | Symbol anchor + hashline combo | Medium | Phase 2 |
| 4: Fallback Tiers | 4-5 | Scoped fallthrough, full fuzzy safety net | Medium | Phase 3 |
| 5: Polish | 5-6 | A/B testing, benchmarks, prompt tuning, docs | Low | Phase 4 |

---

## Phase 1: Foundation (Week 1-2)

### Goal
Add xxHash32 line hashing and bigram table. Read output gets hashline prefixes. No schema changes yet.

### 1.1 New File: `lib/hashline.ts`

**Purpose**: Core hashing library — mirror of oh-my-pi's `line-hash.ts`. Extracted to avoid circular deps.

```typescript
// lib/hashline.ts (~200 lines)

export const HASHLINE_BIGRAMS = [
  "aa","ab","ac", /* ... 644 more ... */ "zy","zz"
] as const;

export const HASHLINE_BIGRAMS_COUNT = 647;

export const HASHLINE_BIGRAM_RE_SRC = `(?:${HASHLINE_BIGRAMS.join("|")})`;

export const HASHLINE_CONTENT_SEPARATOR = "|";

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;
const RE_STRUCTURAL_STRIP = /[\s{}]/g;

/** Structural bigram: ordinal suffix matching line number */
function structuralBigram(line: number): string {
  const mod100 = line % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (line % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

/** 
 * Compute a short BPE-bigram hash of a single line.
 * Uses xxHash32 on normalized line text, modulo 647.
 * The line should NOT include a trailing newline.
 */
export function computeLineHash(idx: number, line: string): string {
  line = line.replace(/\r/g, "").trimEnd();
  
  if (line.replace(RE_STRUCTURAL_STRIP, "").length === 0) {
    return structuralBigram(idx);
  }
  
  let seed = 0;
  if (!RE_SIGNIFICANT.test(line)) {
    seed = idx;
  }
  
  return HASHLINE_BIGRAMS[xxHash32(line, seed) % HASHLINE_BIGRAMS_COUNT];
}

/** Format: `LINE+ID` (e.g., "42nd") */
export function formatLineHash(line: number, text: string): string {
  return `${line}${computeLineHash(line, text)}`;
}

/** Format: `LINE+ID|TEXT` (e.g., "42nd|function hello() {") */
export function formatHashLine(lineNumber: number, line: string): string {
  return `${lineNumber}${computeLineHash(lineNumber, line)}${HASHLINE_CONTENT_SEPARATOR}${line}`;
}
```

**Dependency**: Choose `xxhash-wasm` for portability.

```bash
npm install xxhash-wasm
```

```typescript
// xxHash32 wrapper
import xxhashWasm from "xxhash-wasm";
let xxhash32: (input: string, seed?: number) => number;

(async () => {
  const { createXXHash32 } = await xxhashWasm();
  xxhash32 = (input, seed = 0) => createXXHash32(seed).update(input).digest();
})();
```

### 1.2 Modify: `lib/types.ts`

Add hashline data to `FileSnapshot`:

```typescript
// lib/types.ts — add to FileSnapshot interface
export interface FileSnapshot {
  // ... existing fields ...
  
  /** Hashline anchor data, populated on read */
  hashline?: {
    /** LINE+ID → { text, line } for all lines */
    anchors: Map<string, { text: string; line: number }>;
    /** Full formatted content with hashline prefixes */
    formattedContent: string;
  };
}
```

### 1.3 Modify: `index.ts` — Read Hook

Augment the `tool_result` handler for `read`:

```typescript
// In the read hook at ~line 735
if (fullText && inputPath) {
  // ... existing logic ...
  
  // NEW: Compute hashline anchors
  const lines = fullText.split("\n");
  const anchorMap = new Map<string, { text: string; line: number }>();
  const formattedLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const hash = computeLineHash(lineNum, lines[i]);
    const anchor = `${lineNum}${hash}`;
    anchorMap.set(anchor, { text: lines[i], line: lineNum });
    formattedLines.push(`${anchor}${HASHLINE_CONTENT_SEPARATOR}${lines[i]}`);
  }
  
  recordRead(inputPath, process.cwd(), fullText, isTruncated, {
    hashline: {
      anchors: anchorMap,
      formattedContent: formattedLines.join("\n"),
    },
  });
}
```

### 1.4 Modify: `lib/read-cache.ts`

Update `recordRead` to accept optional hashline data:

```typescript
// lib/read-cache.ts
export function recordRead(
  path: string,
  cwd: string,
  content: string,
  partial?: boolean,
  extra?: { hashline?: FileSnapshot["hashline"] },
): void { /* store in cache */ }
```

### 1.5 Tests: `test/hashline.test.ts`

```typescript
// test/hashline.test.ts
describe("computeLineHash", () => {
  it("is deterministic", () => { /* same input → same hash */ });
  it("produces structural bigrams for braces", () => {
    expect(computeLineHash(1, "{")).toBe("st");
    expect(computeLineHash(2, "  }")).toBe("nd");
  });
  it("handles empty lines", () => { /* */ });
  it("handles separator lines (----)", () => { /* seeded hash */ });
  it("collision rate is < 1/647 per line", () => { /* statistical test */ });
});

describe("formatHashLine", () => {
  it("produces correct format", () => {
    expect(formatHashLine(42, "const x = 1;")).toMatch(/^42[a-z]{2}\|const x = 1;$/);
  });
});
```

### Phase 1 Deliverables
- [x] `lib/hashline.ts` — core hashing (~200 lines)
- [x] `lib/types.ts` — FileSnapshot extension (~5 lines)
- [x] `index.ts` — read hook augmentation (~20 lines)
- [x] `lib/read-cache.ts` — recordRead signature update (~5 lines)
- [x] `test/hashline.test.ts` — unit tests (~100 lines)
- [x] `package.json` — xxhash-wasm dependency
- [x] Verification: `bun test test/hashline.test.ts` passes

---

## Phase 2: Hashline Edit Mode (Week 2-3)

### Goal
Add `{ anchor: { range: {pos, end} }, content }` schema. Apply hashline edits with hash validation and rebase. No AST scoping yet.

### 2.1 New File: `lib/hashline-edit.ts`

**Purpose**: Hashline edit parsing and application — mirror of oh-my-pi's `hashline.ts`.

```typescript
// lib/hashline-edit.ts (~400 lines)

import { computeLineHash, HASHLINE_BIGRAM_RE_SRC } from "./hashline";

export interface HashMismatch {
  line: number;
  expected: string;
  actual: string;
}

export type Anchor = { line: number; hash: string };

export type HashlineEdit =
  | { op: "replace_range"; pos: Anchor; end: Anchor; lines: string[] }
  | { op: "append_at"; pos: Anchor; lines: string[] }
  | { op: "prepend_at"; pos: Anchor; lines: string[] }
  | { op: "append_file"; lines: string[] }
  | { op: "prepend_file"; lines: string[] };

export const ANCHOR_REBASE_WINDOW = 5;

/**
 * Parse "42ab" → { line: 42, hash: "ab" }
 */
export function parseTag(ref: string): Anchor {
  const match = ref.match(
    new RegExp(`^\\s*[>+\\-*]*\\s*(\\d+)(${HASHLINE_BIGRAM_RE_SRC})`)
  );
  if (!match) {
    throw new Error(`Invalid anchor: "${ref}". Expected LINE+ID (e.g., "42ab").`);
  }
  return { line: parseInt(match[1], 10), hash: match[2] };
}

/**
 * Try to find anchor.hash within ±window lines of anchor.line.
 * Returns new line number or null if ambiguous/not found.
 */
export function tryRebaseAnchor(
  anchor: Anchor,
  fileLines: string[],
  window = ANCHOR_REBASE_WINDOW,
): number | null {
  const lo = Math.max(1, anchor.line - window);
  const hi = Math.min(fileLines.length, anchor.line + window);
  let found: number | null = null;
  
  for (let line = lo; line <= hi; line++) {
    if (line === anchor.line) continue;
    if (computeLineHash(line, fileLines[line - 1]) !== anchor.hash) continue;
    if (found !== null) return null; // ambiguous
    found = line;
  }
  return found;
}

/**
 * Validate anchor hashes and apply edits.
 * Throws HashlineMismatchError on genuine mismatches.
 */
export function applyHashlineEdits(
  text: string,
  edits: HashlineEdit[],
): {
  lines: string;
  firstChangedLine: number | undefined;
  warnings?: string[];
  noopEdits?: Array<{ editIndex: number; loc: string; current: string }>;
} {
  // ... implementation (see spec §6.1) ...
}

export class HashlineMismatchError extends Error {
  // ... formatted error with LINE+ID context ...
}

/**
 * Normalize content arrays: strip read prefixes, handle null
 */
export function hashlineParseText(
  content: string[] | null | undefined,
): string[] {
  if (content == null) return [];
  return content; // Already string[] from JSON — no prefix stripping needed
}

/**
 * Resolve raw tool input to HashlineEdit[]
 */
export function resolveHashlineEdits(
  edits: Array<{
    anchor: { range: { pos: string; end: string } };
    content: string[] | null;
  }>,
): HashlineEdit[] {
  return edits.map(edit => {
    const lines = hashlineParseText(edit.content);
    const pos = parseTag(edit.anchor.range.pos);
    const end = parseTag(edit.anchor.range.end);
    
    if (pos.line > end.line) {
      throw new Error(
        `Range start line ${pos.line} must be <= end line ${end.line}`
      );
    }
    
    return { op: "replace_range", pos, end, lines };
  });
}
```

### 2.2 Modify: `index.ts` — Edit Schema

Add hashline variant to the edit schema:

```typescript
// Add to editItemSchema (alongside existing fields)
const hashlineAnchorSchema = Type.Optional(
  Type.Object({
    range: Type.Object({
      pos: Type.String({ description: "first line to edit (inclusive), e.g. '42ab'" }),
      end: Type.String({ description: "last line to edit (inclusive), e.g. '45cd'" }),
    }),
  }, { description: "Hashline-anchored range for precise, staleness-checked edits" }),
);

// Add to editItemSchema object:
const editItemSchema = Type.Object({
  // ... existing oldText, newText, replaceAll, anchor, lineRange ...
  hashline: hashlineAnchorSchema,
});
```

### 2.3 Modify: `index.ts` — Execute Flow

Add hashline detection and routing in `execute()`:

```typescript
// In execute(), after prepareArguments and validateInput
for (const edit of edits) {
  const rawEdit = edit as Record<string, unknown>;
  
  // Detect hashline format
  if (rawEdit.hashline && typeof rawEdit.hashline === "object") {
    // Route to hashline apply path
    const hashlineResult = await applyHashlinePath(
      rawEdit.hashline as HashlineAnchorInput,
      normalizedContent,
      path,
      absolutePath,
    );
    // ... integrate result into overall response ...
  } else if (typeof rawEdit.oldText === "string") {
    // Existing legacy path
  }
}
```

### 2.4 New File: `test/hashline-apply.test.ts`

```typescript
// test/hashline-apply.test.ts
describe("parseTag", () => {
  it("parses '42ab'", () => { /* {line:42, hash:"ab"} */ });
  it("rejects 'ab' (no line number)", () => { /* throws */ });
  it("rejects '42xx' (invalid bigram)", () => { /* throws */ });
});

describe("tryRebaseAnchor", () => {
  it("returns null for genuine mismatch", () => { /* */ });
  it("finds hash within ±5 window", () => { /* */ });
  it("returns null for ambiguous (two matches)", () => { /* */ });
});

describe("applyHashlineEdits", () => {
  it("replaces single line", () => { /* */ });
  it("replaces range", () => { /* */ });
  it("sorts bottom-up", () => { /* */ });
  it("detects noop edits", () => { /* */ });
  it("rejects stale hashes", () => { /* */ });
});

describe("HashlineMismatchError", () => {
  it("formats message with correct anchors", () => { /* */ });
  it("remaps work correctly", () => { /* */ });
});
```

### Phase 2 Deliverables
- [x] `lib/hashline-edit.ts` — edit application (~400 lines)
- [x] `index.ts` — schema + routing (~100 lines)
- [x] `test/hashline-apply.test.ts` — unit tests (~150 lines)
- [x] `test/hashline-integration.test.ts` — integration tests (~100 lines)
- [x] Verification: full edit flow works end-to-end

---

## Phase 3: AST Symbol Scoping (Week 3-4)

### Goal
Layer AST symbol targeting onto hashline anchors. The `symbol` field disambiguates edits within identically-structured code blocks.

### 3.1 Modify: `lib/hashline-edit.ts` — Symbol Support

```typescript
// Extend the edit schema
export type HashlineEditInput = {
  anchor: {
    symbol?: {
      name: string;
      kind?: "function" | "method" | "class" | "interface" | "type" | "variable";
      line?: number;
    };
    range: {
      pos: string;
      end: string;
    };
  };
  content: string[] | null;
};

// Parse symbol from edit
export function parseSymbolAnchor(
  symbol: HashlineEditInput["anchor"]["symbol"],
): EditAnchor | undefined {
  if (!symbol) return undefined;
  return {
    symbolName: symbol.name,
    symbolKind: symbol.kind,
    symbolLine: symbol.line,
  };
}
```

### 3.2 Modify: `index.ts` — Scoped Apply Path

```typescript
async function applyHashlinePath(
  input: HashlineEditInput,
  normalizedContent: string,
  path: string,
  absolutePath: string,
  astResolver: AstResolver | null,
): Promise<HashlineApplyResult> {
  const edits = resolveHashlineEdits([input]);
  const fileLines = normalizedContent.split("\n");
  
  // Validate all hashes
  const allValid = validateAllHashlineHashes(edits, fileLines);
  
  if (allValid.valid) {
    // FAST PATH: direct apply
    return { result: applyHashlineEdits(normalizedContent, edits), tier: "hashline" };
  }
  
  // Try rebase for each mismatch
  const rebased = tryRebaseAll(edits, fileLines, allValid.mismatches);
  if (rebased.allResolved) {
    // Apply with rebased positions + warning
    return { result: applyHashlineEdits(normalizedContent, rebased.edits), 
             tier: "hashline-rebased",
             warnings: rebased.warnings };
  }
  
  // Hashline failed — try symbol-scoped fallback
  if (input.anchor.symbol && astResolver) {
    const symbolScope = await resolveSymbolToScope(
      parseSymbolAnchor(input.anchor.symbol),
      normalizedContent,
      path,
      astResolver,
    );
    
    if (symbolScope) {
      // Reconstruct oldText from hashline cache
      const oldText = reconstructOldTextFromCache(input.anchor.range);
      
      // 4-tier match within symbol scope
      const match = findText(
        normalizedContent, oldText, 
        detectIndentation(normalizedContent),
        0, symbolScope,
      );
      
      if (match.found) {
        return { result: applyMatch(normalizedContent, match, edits[0].lines),
                 tier: "scoped-fallback",
                 warnings: [`Hashline anchors stale; resolved via AST scoping to ${symbolScope.description}`] };
      }
    }
  }
  
  // All hashline attempts failed — escalate to full fuzzy
  return { result: await fullFuzzyApply(input, normalizedContent, path),
           tier: "full-fuzzy-fallback" };
}
```

### 3.3 Tests

```typescript
// test/hashline-scoping.test.ts
describe("AST-scoped hashline", () => {
  it("targets correct function when two have same body", () => { /* */ });
  it("scoped fallback when hashes stale but symbol resolves", () => { /* */ });
  it("fails gracefully when symbol not found", () => { /* */ });
});
```

### Phase 3 Deliverables
- [x] `lib/hashline-edit.ts` — symbol parsing (~30 lines)
- [x] `index.ts` — scoped apply path (~150 lines)
- [x] `test/hashline-scoping.test.ts` (~100 lines)
- [x] Verification: symbol + hashline edits work correctly

---

## Phase 4: Fallback Tiers (Week 4-5)

### Goal
Complete the fallback chain: hashline → rebase → scoped-fallback → full-fuzzy. Measure fallthrough rates. Tune thresholds.

### 4.1 Modify: `index.ts` — Full Fuzzy Fallback

```typescript
async function fullFuzzyApply(
  input: HashlineEditInput,
  normalizedContent: string,
  path: string,
): Promise<HashlineApplyResult> {
  // Reconstruct oldText from hashline anchors in read cache
  const snapshot = getSnapshot(path, process.cwd());
  const oldText = reconstructOldText(snapshot, input.anchor.range);
  
  if (!oldText) {
    throw new Error(
      `Cannot reconstruct oldText from hashline anchors. ` +
      `File may have been modified since last read. Re-read and try again.`
    );
  }
  
  // Run through existing 4-tier pipeline
  const match = findText(
    normalizedContent,
    oldText,
    detectIndentation(normalizedContent),
  );
  
  if (!match.found) {
    const diagnostic = findClosestMatch(normalizedContent, oldText);
    throw getNotFoundError(path, 0, 1, diagnostic, undefined);
  }
  
  // Apply the match
  const content = hashlineParseText(input.content);
  const result = applySingleMatch(normalizedContent, match, content);
  
  return {
    result,
    tier: "full-fuzzy-fallback",
    warnings: [
      `Edit fell through to full fuzzy matching (hashline anchors were stale and ` +
      `AST scoping unavailable). Matched via ${match.tier} tier (${match.matchNote ?? "exact"}).`
    ],
  };
}
```

### 4.2 Add: Fallthrough Metrics

```typescript
// Collect stats for A/B comparison
interface HashlineMetrics {
  totalEdits: number;
  hashlineDirect: number;      // Fast path
  hashlineRebased: number;     // ±5 window rebase
  scopedFallback: number;      // AST-scoped fuzzy
  fullFuzzyFallback: number;   // Full 4-tier safety net
  hashMismatchRejects: number; // Genuine rejections
}
```

### 4.3 Tune: Thresholds

Based on real fallthrough data:

```typescript
// If scopedFallback > 20%: consider larger rebase window
// If fullFuzzyFallback < 2%: consider removing (or keeping as safety net)
// If hashMismatchRejects > 10%: prompt instructions may need tuning
```

### 4.4 Tests

```typescript
// test/hashline-fallback.test.ts
describe("Fallback chain", () => {
  it("hashline direct: hashes match → applied immediately", () => { /* */ });
  it("hashline rebase: file shifted by 3 lines → auto-corrected", () => { /* */ });
  it("scoped fallback: hashes stale, symbol resolves → scoped match", () => { /* */ });
  it("full fuzzy: hashes stale, no symbol → 4-tier pipeline", () => { /* */ });
  it("rejection: hashes stale, no symbol, no match → clear error", () => { /* */ });
});
```

### Phase 4 Deliverables
- [x] `index.ts` — full fuzzy fallback (~80 lines)
- [x] `lib/hashline-edit.ts` — oldText reconstruction from cache (~50 lines)
- [x] `index.ts` — metrics collection (~30 lines)
- [x] `test/hashline-fallback.test.ts` (~120 lines)
- [x] Verification: all 4 fallback paths work end-to-end

---

## Phase 5: Polish, Testing, Benchmark (Week 5-6)

### Goal
A/B test against baseline, tune prompts, measure token savings, write docs.

### 5.1 Benchmark Setup

Adapt oh-my-pi's benchmark infrastructure:

```bash
# Create benchmark directory
mkdir -p benchmark/fixtures
mkdir -p benchmark/runs

# Run comparison
bun run benchmark/compare.ts \
  --model anthropic/claude-sonnet-4-6 \
  --model openai/gpt-5.3-codex \
  --model google/gemini-2.5-pro \
  --model xai/grok-4-fast \
  --runs 3 \
  --tasks 50 \
  --output benchmark/runs/comparison-$(date +%Y%m%d).md
```

### 5.2 Metrics to Compare

| Metric | Baseline (4-tier) | New (hashline hybrid) |
|--------|-------------------|----------------------|
| Overall success rate | ? | ? |
| Tokens in / out per task | ? | ? |
| Edit retry rate | ? | ? |
| Fallthrough tier distribution | N/A | hashline:X%, scoped:Y%, fuzzy:Z% |
| Weak model success rate | ? | ? |

### 5.3 Prompt Tuning

Current prompt guidelines at ~line 944:

```
Current:
"Use edit for precise file modifications. Copy exact snippets from the latest 
file read as oldText."

Proposed addition:
"Prefer hashline-anchored edits when the file was read with LINE+ID anchors.
Reference anchors as '42ab' instead of reproducing text — this is faster, more 
reliable, and avoids whitespace errors."
```

### 5.4 Documentation

- [x] `docs/hashline-spec.md` — technical specification (done)
- [x] `docs/hashline-implementation.md` — this document
- [ ] `README.md` — update with hashline feature
- [ ] `CLAUDE.md` — update project context

### 5.5 Final Checklist

- [ ] All tests pass: `bun test`
- [ ] TypeScript compiles: `bun run --bun tsc --noEmit`
- [ ] Backward compatibility: legacy `{ oldText, newText }` still works
- [ ] Benchmark shows improvement or parity (no regression)
- [ ] Documentation complete
- [ ] Code review pass

## File Manifest

### New Files

| File | Lines | Purpose |
|------|-------|---------|
| `lib/hashline.ts` | ~200 | Hash algorithm, bigram table |
| `lib/hashline-edit.ts` | ~450 | Edit parsing, validation, application |
| `test/hashline.test.ts` | ~100 | Unit tests for hash algorithm |
| `test/hashline-apply.test.ts` | ~150 | Unit tests for edit application |
| `test/hashline-integration.test.ts` | ~120 | Integration tests |
| `test/hashline-scoping.test.ts` | ~100 | AST scoping tests |
| `test/hashline-fallback.test.ts` | ~120 | Fallback chain tests |
| `docs/hashline-spec.md` | ~350 | Technical specification |
| `docs/hashline-implementation.md` | ~300 | This document |
| `benchmark/compare.ts` | ~200 | A/B comparison runner |

### Modified Files

| File | Changes | Purpose |
|------|---------|---------|
| `lib/types.ts` | +15 lines | FileSnapshot hashline extension |
| `lib/read-cache.ts` | +20 lines | Store hashline data in snapshots |
| `index.ts` | +200 lines | Schema, hashline routing, fallback chain |
| `package.json` | +1 line | xxhash-wasm dependency |

### Total: ~1,200 new lines, ~235 modified lines across the codebase

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| xxHash32 perf regression | Low | Medium | Benchmark read latency before/after |
| Hash collision in rebase window | Very Low | Low | 1/647 per line; content comparison catches |
| Model confused by dual format | Medium | Medium | Clear prompt instructions; auto-detect format |
| Strong model regression | Low | High | A/B test before enabling by default |
| Read cache memory growth | Low | Low | Limit to last-N files; LRU eviction |

## Key Design Decisions

1. **xxhash-wasm over native**: Portability trumps 2x speed for a μs-level operation.
2. **Structural bigrams**: Worth the complexity — brace lines are ~20% of source code.
3. **Rebase window of ±5**: Wide enough for typical line shifts, narrow enough to avoid ambiguity.
4. **Keep 4-tier pipeline**: As safety net, not primary. Never remove it.
5. **Hashline in read hook, not schema**: Transparent to the model — reduces prompt complexity.
6. **Symbol kind as string, not enum**: Compatible with tree-sitter's node type strings.

## Open Items

See [hashline-spec.md §14](./hashline-spec.md#14-open-questions).
