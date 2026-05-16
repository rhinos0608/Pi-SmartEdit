# Streaming Patch Preview — SPEC

> **Status:** Draft  
> **Priority:** P1  
> **Effort:** ~250 lines  
> **Inspired by:** Codex `StreamingPatchParser` (500ms-buffered partial-patch preview)

---

## 1. Motivation

SmartEdit's `edit` tool receives a complete edits array and processes it synchronously. For large patches (many files, many hunks), the model waits without any progress feedback until the entire operation completes. This creates:

- **User uncertainty:** "Is the tool still working?" during multi-hunk edits
- **Loss of incremental feedback:** No ability to see partial diffs as hunks are applied
- **Missed infrastructure:** Pi's tool system supports an `onUpdate` callback, but SmartEdit's `edit` tool doesn't use it

Codex solves this with a `StreamingPatchParser` that processes partial `apply_patch` text every 500ms and emits `PatchApplyUpdatedEvent` to update the TUI's diff view in real-time. SmartEdit should adopt the same pattern.

---

## 2. `StreamingPatchParser` — Class Interface

```typescript
export type StreamingProgress = {
  /** Total hunks discovered so far in the patch */
  totalHunks: number;
  /** Hunks that have been completely parsed */
  completedHunks: number;
  /** Human-readable progress text */
  text: string;
  /** Unified diff of completed hunks (only on first emit for each hunk) */
  diff?: string;
};

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

## 5. Integration with `index.ts` Execute

### 5.1 Signature Change

Rename `_onUpdate` to `onUpdate` in the `edit` tool's `execute` method signature:

```typescript
// Before
async execute(
  _toolCallId: string,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
  _ctx: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: EditResult["details"] }>

// After
async execute(
  _toolCallId: string,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
  _ctx: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: EditResult["details"] }>
```

### 5.2 Streaming Pipeline (inside `prepareArguments` or `execute`)

When `onUpdate` is provided AND the input format is `codex_patch` (detected by `detectInputFormat`):

1. Before processing edits, create a `StreamingPatchParser(onUpdate)`.
2. Feed the raw patch text through `pushDelta` in stages — or atomically, since the `edit` tool receives the complete text at once. The parser's throttle still controls when updates reach the caller, so even a single `pushDelta(raw)` followed by `finish()` benefits from incremental emission.
3. Call `finish()` before returning the final result.

When `onUpdate` is missing or the format is not `codex_patch`, behave normally — no streaming, no overhead.

### 5.3 Placement in `execute`

The streaming pipeline runs during `prepareArguments` (while parsing multi-format input) and completes before the edit pipeline begins:

```typescript
// Inside execute(), after prepareArguments and before validateInput:
if (onUpdate && typeof input.edits === "string") {
  const format = detectInputFormat(input.edits);
  if (format === "codex_patch") {
    const parser = new StreamingPatchParser(onUpdate);
    parser.pushDelta(input.edits);
    parser.finish();
  }
}
```

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
| `src/formats/streaming-patch-parser.ts` | **NEW** | ~150 |
| `test/streaming-patch-parser.test.ts` | **NEW** | ~150 |
| `index.ts` | **MODIFY** | ~15 (signature rename + streaming pipeline insertion) |

---

## 8. Open Questions / Risks

1. **Pi platform support:** The `_onUpdate` callback is currently unused across all Pi tools. Is there a runtime that delivers these callbacks synchronously during `execute`, or is it a no-op? Testing with a Pi session is required to validate.
2. **Timer integration:** `setTimeout` inside `execute()` works for async callback scheduling, but `finish()` must cancel pending timers to avoid stale emissions after completion.
3. **Large patches:** For very large patches (100+ hunks), `parseCodexPatch` with `mode: 'lenient'` on every `pushDelta` could be expensive. Consider caching the parser cursor position for incremental parsing in a future iteration.
