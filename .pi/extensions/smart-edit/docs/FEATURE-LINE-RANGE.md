# Feature: Line-Range Targeting

## Problem Statement

The edit tool currently requires `oldText` — an exact (or fuzzy-matched) snippet of text to find and replace. This is the only targeting mechanism. When `oldText` is ambiguous (appears multiple times) or the LLM doesn't have the exact text available, there's no alternative way to specify where the edit should apply.

A **line-range targeting** mode provides a second, complementary mechanism: specify edit location by line numbers, with optional text verification.

## Research Context

### Claude's Text Editor Tool

Claude's `text_editor_20250418` tool uses a `view` command that prepends line numbers:

```
1: def is_prime(n):
2:     if n < 2:
3:         return False
4:     for i in range(2, int(n**0.5) + 1):
5:         if n % i == 1:
```

And an `insert` command that uses line numbers directly:

```json
{
  "command": "insert",
  "path": "/path/to/file.py",
  "insert_line": 3,
  "new_str": "    # Check for edge cases\n    if n == 2:\n        return True"
}
```

The `str_replace` command still requires exact text matching. Line numbers are used as a secondary reference point.

### Codex CLI Patch Format

Uses `@@` context anchors:

```
*** Update File: src/api.js
@@ async function fetchUserData(userId) {
-  const response = await fetch(`/api/users/${userId}`);
+  try {
+    const response = await fetch(`/api/users/${userId}`);
```

The `@@` line provides a text anchor near the change, avoiding absolute line numbers. But if the anchor text is also ambiguous, this still fails.

### RooCode

RooCode's `MultiSearchReplaceDiffStrategy` accepts a `:start_line:` hint:

```
<<<<<<< SEARCH
:start_line:10
-------
function calculateTotal(items) {
=======
function calculateTotal(items) {
>>>>>>> REPLACE
```

This narrows the search starting point but doesn't replace text matching — it's an optimization hint for the fuzzy matcher.

### Key Insight

None of these tools make line ranges a *replacement* for text matching. They're always complementary. Line ranges are fragile (line numbers shift after edits), so they must be used as **hints that narrow scope**, not as the primary matching mechanism.

## API Design

### Extended EditItem Schema

```typescript
interface LineRange {
  /** 1-based start line (inclusive) */
  startLine: number;

  /** 1-based end line (inclusive). If omitted, defaults to startLine (single line) */
  endLine?: number;
}

interface EditItem {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  description?: string;
  anchor?: EditAnchor;           // From Feature 1 (AST targeting)

  /** Line-range hint to narrow the search scope for oldText matching.
   *
   * When provided, oldText is only searched within the specified line range.
   * If oldText is not found within this range, the tool falls back to
   * whole-file search (with a matchNote about the fallback).
   *
   * Line numbers are 1-based and refer to the file content AS LAST READ
   * by the agent. After edits, line numbers shift — this is why lineRange
   * is a HINT, not a guarantee. The tool validates that the range still
   * makes sense and adjusts if needed.
   */
  lineRange?: LineRange;
}
```

### Example Usage

```json
{
  "path": "src/handlers.ts",
  "edits": [
    {
      "oldText": "return user.name",
      "newText": "return user.displayName",
      "lineRange": { "startLine": 85, "endLine": 120 },
      "description": "Fix user display name in handleRequest"
    }
  ]
}
```

## Behavior Specification

### Search Priority

When `lineRange` is provided:

```
1. Extract lines [startLine, endLine] from file content
2. Search for oldText within the extracted slice
3. If found: apply edit (success, no fallback needed)
4. If NOT found in slice:
   a. Expand range by ±5 lines and retry (line shift tolerance)
   b. If still not found: fall back to whole-file search
   c. If found in whole file: apply edit with matchNote about range shift
   d. If not found at all: throw not-found error as usual
```

### Range Expansion

Line numbers shift after edits — the LLM's view of line numbers may be stale. To compensate:

```typescript
function expandRange(
  content: string,
  range: LineRange,
  oldText: string,
  expansionLines: number = 5,
): { startIndex: number; endIndex: number } | null {
  const lines = content.split('\n');

  // Try exact range first
  const slice = lines.slice(range.startLine - 1, range.endLine).join('\n');
  const exactIndex = slice.indexOf(oldText);
  if (exactIndex !== -1) {
    return offsetToContentRange(range.startLine, exactIndex, oldText.length);
  }

  // Try expanded range: ±expansionLines around the specified range
  const expandedStart = Math.max(0, range.startLine - 1 - expansionLines);
  const expandedEnd = Math.min(lines.length, (range.endLine ?? range.startLine) + expansionLines);
  const expandedSlice = lines.slice(expandedStart, expandedEnd).join('\n');
  const expandedIndex = expandedSlice.indexOf(oldText);
  if (expandedIndex !== -1) {
    return offsetToContentRange(expandedStart + 1, expandedIndex, oldText.length);
  }

  return null; // Fall back to whole-file search
}
```

### Integration with AST Anchoring

`lineRange` and `anchor` can be combined:

```json
{
  "oldText": "return obj.value",
  "newText": "return obj.computedValue",
  "anchor": { "symbolName": "calculateTotal" },
  "lineRange": { "startLine": 85, "endLine": 95 }
}
```

When both are provided:
1. Resolve the anchor to a specific AST node → get its byte range
2. Intersect with the line range → narrow further
3. Search for oldText within the intersection
4. This provides maximum disambiguation: "the `return obj.value` in function `calculateTotal` around line 85-95"

### Validation

```typescript
function validateLineRange(range: LineRange, totalLines: number): string | null {
  if (range.startLine < 1) return "startLine must be >= 1";
  if (range.startLine > totalLines) return `startLine ${range.startLine} exceeds file length (${totalLines} lines)`;
  if (range.endLine && range.endLine > totalLines) return `endLine ${range.endLine} exceeds file length (${totalLines} lines)`;
  if (range.endLine && range.endLine < range.startLine) return "endLine must be >= startLine";
  return null; // valid
}
```

## Integration with Read Cache

The line numbers in `lineRange` refer to the file **as last read by the agent**. The read cache already stores the file content at read time. We can add line number validation:

```typescript
// In read-cache.ts, add:
interface FileSnapshot {
  path: string;
  mtimeMs: number;
  size: number;
  contentHash: string;
  readAt: number;
  lineCount: number;      // NEW: number of lines at read time
  lineOffsets: number[];  // NEW: byte offset of each line start
}
```

When verifying line ranges, we check:
- `startLine <= snapshot.lineCount` (line existed at read time)
- If the file has been modified since read, the stale-file guard catches it first

## Diagnostics

### Success with Range Hint

```
Successfully replaced 1 block(s) in src/handlers.ts.
Note: Edit targeted lines 85-120 (function "handleRequest").
```

### Range Hint Missed, Found Via Whole-File Search

```
Successfully replaced 1 block(s) in src/handlers.ts.
Note: lineRange [85, 120] did not contain oldText; found at line 203 instead.
The line range may be stale — consider re-reading the file.
```

### Range Out of Bounds

```
Error: edits[0].lineRange.startLine (500) exceeds file length (142 lines).
Re-read the file to get current line numbers.
```

### Combined Anchor + LineRange

```
Successfully replaced 1 block(s) in src/handlers.ts.
Note: Edit anchored to symbol "handleRequest" at lines 85-120, narrowed by lineRange [80, 130].
```

## Implementation in `edit-diff.ts`

The `findText()` function gains a `searchScope` parameter:

```typescript
interface SearchScope {
  /** If provided, restrict search to this byte range within content */
  startIndex: number;
  endIndex: number;

  /** Human-readable description of the scope for diagnostics */
  description: string;

  /** Whether this scope was inferred from AST (anchor) or line range */
  source: "anchor" | "lineRange" | "intersection";
}

function findText(
  originalContent: string,
  oldText: string,
  indentationStyle: IndentationStyle,
  startOffset: number = 0,
  searchScope?: SearchScope,    // NEW PARAMETER
): MatchResult | MatchResult[] {
  // If searchScope provided, restrict search to slice
  const searchContent = searchScope
    ? originalContent.slice(searchScope.startIndex, searchScope.endIndex)
    : originalContent;

  const searchStartOffset = searchScope?.startIndex ?? startOffset;

  // ... existing 4-tier matching logic, scoped to searchContent ...

  // If match found in scoped content, map back to original offsets
  if (result.found) {
    return {
      ...result,
      index: result.index + searchStartOffset,
      matchNote: result.matchNote
        ? `${result.matchNote} (scoped to ${searchScope.description})`
        : `Matched within ${searchScope.description}`,
    };
  }

  // If scope was provided but no match found, fall back to whole content
  if (searchScope) {
    return findText(originalContent, oldText, indentationStyle, 0);
  }

  return { found: false, index: -1, matchLength: 0, ... };
}
```

### Computing Search Scope

```typescript
function computeSearchScope(
  content: string,
  filePath: string,
  edit: EditItem,
  astResolver: ASTResolver,
): SearchScope | undefined {
  const scopes: SearchScope[] = [];

  // From lineRange
  if (edit.lineRange) {
    const { startIndex, endIndex } = lineRangeToByteRange(content, edit.lineRange);
    scopes.push({ startIndex, endIndex, description: `lines ${edit.lineRange.startLine}-${edit.lineRange.endLine ?? edit.lineRange.startLine}`, source: "lineRange" });
  }

  // From anchor (Feature 1)
  if (edit.anchor) {
    const node = astResolver.findSymbolNode(
      astResolver.parseFile(content, filePath)!,
      edit.anchor,
    );
    if (node) {
      scopes.push({
        startIndex: node.startIndex,
        endIndex: node.endIndex,
        description: `${node.type} "${astResolver.getSymbolName(node)}"`,
        source: "anchor",
      });
    }
  }

  // Intersect if both present
  if (scopes.length === 2) {
    const intersection = intersectRanges(scopes[0], scopes[1]);
    return {
      ...intersection,
      description: `${scopes[0].description} ∩ ${scopes[1].description}`,
      source: "intersection",
    };
  }

  return scopes[0]; // Return single scope, or undefined if none
}
```

## Testing Strategy

### Unit Tests

1. **Exact range match**: `lineRange: {startLine: 5, endLine: 10}` finds oldText on line 7
2. **Range too narrow**: `lineRange` doesn't contain oldText, but expansion finds it on line 8 (±5 tolerance)
3. **Full fallback**: oldText not in expanded range, but found elsewhere in file
4. **Out of range**: `startLine: 500` on a 50-line file → clear error
5. **Combined anchor + lineRange**: Intersection narrows search correctly
6. **Shifted lines**: File modified between read and edit, lines shifted → expansion tolerance catches it
7. **Multi-match disambiguation**: oldText appears 3 times, lineRange contains only one → selects that one

### Integration Tests

1. **LLM provides lineRange**: Verify line hint appears in success message
2. **Stale lineRange + conflict detector**: Both fire appropriately
3. **replaceAll + lineRange**: replaceAll scoped to lineRange within file

## Prompt Guidelines Update

```typescript
// In index.ts, update promptGuidelines:
promptGuidelines: [
  // ... existing guidelines ...
  "Use lineRange to narrow edits to specific line ranges when oldText might be ambiguous.",
  "Line numbers refer to the file as you last read it. If you're unsure about line numbers, re-read the file.",
  "You can combine anchor and lineRange for maximum disambiguation: the edit applies within the intersection of both.",
  "If oldText is unique in the file, lineRange is unnecessary — but it adds safety by verifying the edit lands where expected.",
],
```

## Schema Update

```typescript
const lineRangeSchema = Type.Object({
  startLine: Type.Number({
    description: "1-based start line (inclusive). Refers to file as last read.",
    minimum: 1,
  }),
  endLine: Type.Optional(
    Type.Number({
      description: "1-based end line (inclusive). Defaults to startLine if omitted.",
      minimum: 1,
    })
  ),
});

// Add to editItemSchema:
lineRange: Type.Optional(lineRangeSchema),
```

## References

- **Claude text_editor tool**: Uses `view_range: [1, 10]` for viewing and `insert_line: 3` for insertions. Line numbers are secondary to text matching, used as hints.
- **Codex CLI**: Uses `@@` text anchors (not line numbers) to locate change context. Avoids line numbers explicitly.
- **RooCode**: Supports `:start_line:` hints in search/replace blocks. These are search optimization hints, not primary matchers.
- **Survey insight**: All successful formats converge on "avoid line numbers as primary targeting" but use them as disambiguation hints. Our design follows this pattern exactly.