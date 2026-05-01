# Feature: Semantic Conflict Detection

## Problem Statement

The current `applyEdits()` detects **byte-overlap** conflicts within a *single* edit call. But when the LLM makes **separate, sequential edit calls** to the same file, there's no detection of semantically overlapping edits — two edits that modify the same function, class method, or logical code unit in different calls.

Consider:

```
Call 1: Edit oldText "return user.name" → "return user.displayName" in getUser()
Call 2: Edit oldText "function getUser()" → "function getUserName()" in the same file
```

These don't overlap at the byte level (they target different text regions), but they conflict semantically: Call 2 renamed the function while Call 1 still targets code inside it. The stale-file guard catches files modified *externally*, but not edits the LLM itself made in previous turns.

## Solution

Add a **semantic conflict layer** that tracks which AST-level scopes (functions, methods, classes) have been edited, and warns or errors when a new edit targets a scope that was previously modified.

### Conceptual Model

```
┌─────────────────────────────────────────────────┐
│              Semantic Conflict Layer              │
├─────────────────────────────────────────────────┤
│                                                  │
│  editHistory: Map<filePath, Set<SymbolRef>>      │
│                                                  │
│  After each successful edit:                     │
│    1. Parse the file (if AST available)           │
│    2. Find which symbols overlapped the edit      │
│    3. Record those symbols in editHistory         │
│                                                  │
│  Before each new edit:                           │
│    1. Parse the current file                      │
│    2. Find which symbols overlap each oldText     │
│    3. Check editHistory for conflicts             │
│    4. If conflict found:                          │
│       - If same symbol, different call: WARN      │
│       - If nested symbol conflict: WARN           │
│    5. Optionally: re-read file and advise retry    │
│                                                  │
└─────────────────────────────────────────────────┘
```

## API Design

### Configuration

```typescript
interface ConflictDetectionConfig {
  /** Enable semantic conflict detection (default: true when AST available) */
  enabled: boolean;

  /** Behavior when a conflict is detected:
   *  - "warn": Log a warning, proceed with the edit (default)
   *  - "error": Throw an error, block the edit
   */
  onConflict: "warn" | "error";

  /** Whether to detect conflicts across ALL previous edits in the session,
   *  or only the most recent edit per file. Default: "all" */
  scope: "all" | "last";
}
```

### Conflict Report

When a semantic conflict is detected, the tool returns detailed information:

```typescript
interface ConflictReport {
  /** The symbol that was previously edited */
  previousSymbol: {
    name: string;
    kind: string;    // e.g., "function_declaration"
    lineStart: number;
    lineEnd: number;
  };

  /** The edit that was previously applied */
  previousEdit: {
    turn: number;     // Which edit call made the change
    description?: string;  // From the edit's description field
  };

  /** The symbol being targeted by the current edit */
  currentSymbol: {
    name: string;
    kind: string;
    lineStart: number;
    lineEnd: number;
  };

  /** Relationship between the two symbols */
  relationship: "same" | "contains" | "contained-by" | "sibling-overlap";

  /** Suggested action */
  suggestion: string;
}
```

### Example Output

```
⚠ Semantic conflict in src/handlers.ts:
  Edit #3 targets "handleRequest" (function, lines 85-120),
  but Edit #2 already modified "handleRequest" (function, lines 85-120).
  The file has changed since your last successful edit.
  Consider re-reading the file before editing this region.
```

## Implementation Architecture

### New Module: `lib/conflict-detector.ts`

```typescript
/**
 * Tracks which AST-level scopes have been edited and detects
 * semantic conflicts between edit calls.
 */
export class ConflictDetector {
  private editHistory: Map<string, SymbolEditRecord[]>;

  /**
   * Record that an edit was applied to a set of symbols in a file.
   * Called AFTER a successful edit application.
   */
  recordEdit(
    filePath: string,
    content: string,      // The NEW file content after edit
    editSpans: Array<{ startIndex: number; endIndex: number }>,
    editDescription?: string,
    turnNumber?: number,
  ): void;

  /**
   * Check if a proposed edit would conflict with previous edits.
   * Called BEFORE applying the edit.
   */
  checkConflicts(
    filePath: string,
    content: string,      // The CURRENT file content
    editSpans: Array<{ startIndex: number; endIndex: number }>,
  ): ConflictReport[];

  /**
   * Clear history for a file (e.g., after a fresh read).
   */
  clearForFile(filePath: string): void;

  /**
   * Clear all history (e.g., on session start).
   */
  clearAll(): void;
}

interface SymbolEditRecord {
  /** The name/kind of the symbol that was edited */
  symbol: SymbolRef;

  /** When the edit was applied (monotonic counter) */
  turn: number;

  /** The byte range of the edit within the symbol */
  editRange: { startIndex: number; endIndex: number };

  /** The description from the edit item */
  description?: string;
}
```

### Integration with AST Resolver

```typescript
// In conflict-detector.ts
class ConflictDetector {
  private astResolver: ASTResolver;

  constructor(astResolver: ASTResolver) {
    this.astResolver = astResolver;
  }

  private findEnclosingSymbols(
    content: string,
    filePath: string,
    startByte: number,
    endByte: number,
  ): SymbolRef[] {
    const parseResult = this.astResolver.parseFile(content, filePath);
    if (!parseResult) return []; // fallback: no AST available

    const symbols: SymbolRef[] = [];
    const walk = (node: SyntaxNode) => {
      if (node.startIndex <= startByte && node.endIndex >= endByte) {
        // This node contains the edit range
        if (node.isNamed && this.isRelevantNodeType(node)) {
          symbols.push({
            name: this.astResolver.getSymbolName(node),
            kind: node.type,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            startByte: node.startIndex,
            endByte: node.endIndex,
          });
        }
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(parseResult.tree.rootNode);
    return symbols;
  }

  private isRelevantNodeType(node: SyntaxNode): boolean {
    // Only track meaningful code units, not expressions or trivial tokens
    const RELEVANT_TYPES = new Set([
      'function_declaration', 'function_definition', 'method_definition',
      'class_declaration', 'class_definition', 'impl_item',
      'interface_declaration', 'interface_definition',
      'type_declaration', 'type_alias_declaration',
      'lexical_declaration', 'variable_declaration',
      'arrow_function', 'function_expression',
    ]);
    return RELEVANT_TYPES.has(node.type);
  }
}
```

### Integration with Edit Pipeline

In `index.ts`, the edit handler currently:

```typescript
// Current pipeline:
// 1. Read file → content
// 2. Apply edits to content
// 3. Write result

// New pipeline:
// 1. Read file → content
// 2. CHECK: conflictDetector.checkConflicts(filePath, content, editByteSpans)
// 3. If conflicts && config.onConflict === "error": throw
// 4. If conflicts && config.onConflict === "warn": add matchNotes
// 5. Apply edits to content
// 6. Write result
// 7. RECORD: conflictDetector.recordEdit(filePath, newContent, editSpans)
```

### Session-Level State

The `ConflictDetector` instance is created per-session (in `pi.on("session_start")`) and persists across edit calls within the session. This matches the existing `read-cache.ts` pattern.

```typescript
// In index.ts
let conflictDetector: ConflictDetector;

export default function smartEdit(pi: ExtensionAPI) {
  conflictDetector = new ConflictDetector(astResolver);

  pi.on("session_start", async () => {
    conflictDetector.clearAll();
  });

  // ... in edit handler:
  // Before applyEdits:
  const conflicts = conflictDetector.checkConflicts(absolutePath, normalizedContent, spans);
  if (conflicts.length > 0) {
    if (conflictConfig.onConflict === "error") {
      throw new ConflictError(conflicts);
    }
    // Add warnings to matchNotes
    for (const c of conflicts) {
      matchNotes.push(formatConflictWarning(c));
    }
  }

  // After successful applyEdits:
  conflictDetector.recordEdit(absolutePath, newContent, appliedSpans, edit.description);
}
```

### Relationship to Stale-File Guard

The existing `checkStale()` in `read-cache.ts` detects *external* modifications (file changed outside the agent). The semantic conflict detector handles *internal* modifications (the agent's own prior edits). They complement each other:

| Scenario | Stale-File Guard | Conflict Detector |
|----------|-----------------|-------------------|
| File modified by another process | ✅ Catches | ❌ Unaware |
| Agent edits same file in different calls | ❌ Not stale (agent wrote it) | ✅ Catches |
| Agent edits overlapping regions in same call | ❌ Already handled by overlap check | ❌ N/A (same call) |
| Agent edits different symbols in same file, different calls | ❌ Different regions | ✅ Warns about same-symbol overlap |

### Fallback Without AST

When tree-sitter can't parse a file (unsupported language, syntax errors), we fall back to **line-range tracking**:

```typescript
// Fallback: track line ranges instead of symbol ranges
interface LineRangeEdit {
  lineStart: number;
  lineEnd: number;
  turn: number;
  description?: string;
}

class LineRangeConflictDetector {
  // Track edits by line range overlap
  // Less precise than AST, but still catches obvious conflicts
}
```

This is essentially Phase 3 (Line-Range Targeting) applied to conflict detection.

## Enhanced Error Messages

### Without Conflict Detection (Current)

```
Error: edits[0] matched via exact match and edits[2] matched via indentation normalization
overlap in src/handlers.ts. Merge them into one edit or target disjoint regions.
```

### With Conflict Detection (Proposed)

```
⚠ Semantic conflict warning in src/handlers.ts:

  Current edit (edits[0]): modifies "handleRequest" (function, lines 85-120)
  Previous edit (turn 2, "add error handling"): also modified "handleRequest" (function, lines 85-120)

  The file content has changed since your last read. The oldText you provided
  may no longer match. Consider:
  1. Re-reading the file to get current content
  2. Merging these changes into a single edit call
```

### With AST-Based Disambiguation Error (Proposed)

```
Error: edits[0].oldText is ambiguous in src/handlers.ts — 2 matches found:
  Match 1 at line 10 inside function "handleRequest" (request handler v1)
  Match 2 at line 85 inside function "handleRequest" (request handler v2)

Use the "anchor" field to specify which symbol contains your edit target.
Example: { "oldText": "...", "newText": "...", "anchor": { "symbolName": "handleRequest", "symbolLine": 85 } }
```

## Testing Strategy

### Unit Tests

1. **Same-symbol conflict**: Two edits to same function in different calls → detected
2. **Containing-symbol conflict**: Edit to class, then edit to method within → detected as "contains"
3. **Sibling symbols**: Edits to two different methods in same class → no conflict
4. **Graceful fallback**: Unsupported file type → line-range fallback
5. **Session reset**: New session clears history

### Integration Tests

1. **Multi-turn edit**: First call edits function A, second call edits function A → warning returned
2. **Auto-re-read mode**: Conflict triggers automatic re-read and retry
3. **Error mode**: Conflict throws error that LLM can see and respond to
4. **Read-cache integration**: External modification + internal conflict → both detected

## References

- **Kiro blog**: Language servers handle semantic refactoring — rename a symbol propagates to all references. Validates that symbol-scope tracking is the right abstraction.
- **Fabian Hertwig survey**: "The LLM often operates on a potentially outdated or incomplete view of the target file." Semantic conflict detection addresses exactly this — tracking that the LLM's view is stale due to its own prior edits.
- **RooCode**: Uses a user-approval step for edits, which is the human-in-the-loop version of conflict detection. We automate the detection.
- **Serena MCP**: `replace_symbol_body` is inherently conflict-safe because it targets a named symbol. Our `anchor` mechanism provides similar guarantees.