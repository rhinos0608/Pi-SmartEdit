# Streaming Patch Preview — Implementation

> **Status:** Implemented (May 2026)
> **Actual:** ~450 lines (including tests)
> **File:** `src/formats/streaming-patch-parser.ts`
> **Inspired by:** Codex `StreamingPatchParser` (500ms-buffered partial-patch preview)

---

## 1. Motivation

SmartEdit's `edit` tool receives a complete edits array and processes it synchronously. For large patches (many files, many hunks), the model waits without any progress feedback until the entire operation completes. This creates:

- **User uncertainty:** "Is the tool still working?" during multi-hunk edits
- **Loss of incremental feedback:** No ability to see partial diffs as hunks are applied
- **Missed infrastructure:** Pi's tool system supports an `onUpdate` callback, but SmartEdit's `edit` tool didn't use it

Codex solves this with a `StreamingPatchParser` that processes partial `apply_patch` text every 500ms and emits `PatchApplyUpdatedEvent` to update the TUI's diff view in real-time. SmartEdit adopted the same pattern.

---

## 2. `StreamingPatchParser` — Class Interface

```typescript
export type OnUpdateCallback = (
  update: { content: Array<{ type: "text"; text: string }> }
) => void;

export class StreamingPatchParser {
  constructor(
    onUpdate?: OnUpdateCallback,
    bufferIntervalMs?: number  // default 500
  );

  /**
   * Feed a partial patch text delta.
   * Internally accumulates text, re-parses periodically,
   * and emits completed hunks via the onUpdate callback.
   */
  pushDelta(delta: string): void;

  /**
   * Signal that all text has been received.
   * Flushes any pending buffered hunks and emits final "complete" message.
   */
  finish(): void;
}
```

### 2.1 Constructor Parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `onUpdate` | `OnUpdateCallback \| undefined` | `undefined` | Pi's tool-level streaming callback. Omit or `undefined` for graceful degradation (no streaming). |
| `bufferIntervalMs` | `number` | `500` | Minimum interval between `onUpdate` emissions, matching Codex's 500ms throttle. |

### 2.2 Internal State

```typescript
private accumulated: string;        // All text fed by pushDelta so far
private lastEmitTime: number;       // Timestamp of last onUpdate emission
private timer: ReturnType<typeof setTimeout> | null;  // Pending flush timer
private emittedHunks: Set<string>;  // Signatures of hunks already emitted
private totalHunks = 0;             // Total hunks seen in most recent parse
private fileContent: string | null; // Current file content for live diffing
```

---

## 3. Throttling / Buffering Mechanism

Matching Codex's implementation, emissions are throttled to **500ms intervals**:

1. **On `pushDelta`:** Re-parse accumulated text with `parseCodexPatch(text, 'lenient')`.
2. **Find new hunks:** Compare freshly parsed hunks against `emittedHunks`. Any hunk whose signature is not in the set is "newly completed".
3. **Buffer decision:**
   - If `Date.now() - lastEmitTime >= bufferIntervalMs` and there are new hunks: emit immediately.
   - If `Date.now() - lastEmitTime < bufferIntervalMs` and there are new hunks: schedule a deferred flush via `setTimeout` (debounce-style). If a timer is already pending, it is NOT replaced — the first timer fires, guaranteeing an eventual flush.
4. **On `finish`:** Cancel any pending timer, re-parse, and emit any remaining un-emitted hunks. Then emit a final "all hunks complete" message.

### Hunk Signature (Uniqueness)

Each hunk gets a deterministic signature to avoid duplicate emissions:

| Hunk Kind | Signature |
|---|---|
| `AddFile` | `add:<path>` |
| `DeleteFile` | `delete:<path>` |
| `UpdateFile` chunk | `update:<path>:<scope-joined>` |

Using scope (from `@@` chains) disambiguates multiple hunks within the same file.

---

## 4. Emission Content

Each `onUpdate` call sends `{ content: [{ type: "text", text: string }] }`.

### 4.1 Progress Messages (every emit)

Sent with every emission, reflecting cumulative state:

```
📋 Streaming patch progress: 3/5 hunks complete
```

### 4.2 Partial Diff (first emit only per hunk)

When a hunk is first detected as complete, its diff string is included. The format mirrors SmartEdit's existing `generateDiffString` output:

```
📋 Streaming patch progress: 3/5 hunks complete

--- a/file.ts
+++ b/file.ts
@@ ... @@ context line
+new line
```

This gives the consumer real-time visibility into each change as it's parsed.

### 4.3 Final Completion Message

On `finish()`:

```
✅ Patch streaming complete: all 5 hunks processed
```

---

## 5. Integration with `index.ts`

The streaming pipeline runs inside `execute()`, after `prepareArguments` and before `validateInput`:

```typescript
// Save raw edits string before prepareArguments converts it
const rawEditsString = typeof input.edits === "string" ? input.edits : undefined;

// After prepareArguments:
if (onUpdate && rawEditsString) {
  try {
    const format = detectInputFormat(rawEditsString);
    if (format === "codex_patch") {
      const parser = new StreamingPatchParser(onUpdate);
      parser.pushDelta(rawEditsString);
      parser.finish();
    }
  } catch {
    // Streaming is advisory — silent degradation on failure
  }
}
```

The `onUpdate` parameter is already wired through to the `execute` signature (no rename needed — it was always `onUpdate`).

---

## 6. Graceful Degradation

| Condition | Behavior |
|---|---|
| `onUpdate` is `undefined` | No streaming. Normal synchronous execution. Zero overhead. |
| `onUpdate` is provided, format is NOT codex_patch | No streaming. Normal execution. |
| `onUpdate` is provided, format IS codex_patch | Streaming active. Partial diffs + progress emitted. |
| `StreamingPatchParser` constructor throws | Error is caught. Falls through to normal execution. |

The degradation is silent — no warnings or errors. The user gets the same result they always got, without streaming.

---

## 7. File Changes

| File | Action | Lines |
|---|---|---|
| `src/formats/streaming-patch-parser.ts` | **NEW** | ~450 |
| `test/streaming-patch-parser.test.ts` | **NEW** | ~150 |
| `index.ts` | **MODIFY** | ~15 (streaming pipeline insertion) |

---

## 8. Edge Cases

| Case | Behavior |
|---|---|
| Large patches (100+ hunks) | `parseCodexPatch` runs on every `pushDelta`. For very large patches, the full re-parse is expensive but acceptable for typical use. Each hunk is ~5-20 lines. |
| `setTimeout` during `execute()` | Works for async callback scheduling. `finish()` cancels pending timers to avoid stale emissions. |
| Empty patch | No hunks to emit — `finish()` emits completion with 0 total. |
| Parser errors in patch | Invalid sections are skipped (lenient mode). Progress continues. |
