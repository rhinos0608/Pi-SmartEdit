/**
 * Concurrency signal detector.
 *
 * Performs deterministic, cheap text scanning to detect concurrency-related
 * patterns in changed code ranges. Uses a two-layer approach:
 *
 * 1. **Token/pattern scan** — scans the changed source text for keywords and
 *    API patterns (async, await, Lock, Mutex, go, chan, etc.) within each
 *    changed target's byte range.
 *
 * 2. **Name scan** — inspects symbol names and file names for concurrency
 *    cues (lock, mutex, race, atomic, thread, etc.).
 *
 * This module is intentionally simple — no AST queries, no tree-sitter
 * dependency. It runs in sub-millisecond time on any source file.
 */

import type { ChangedTarget, ConcurrencySignal } from "./types";

// ─── Per-language token signal tables ───────────────────────────────

interface PatternEntry {
  /** Regex pattern to search for */
  pattern: RegExp;
  /** Category label */
  category: ConcurrencySignal["category"];
}

const LANGUAGE_PATTERNS: Record<string, PatternEntry[]> = {
  typescript: [
    { pattern: /\basync\b/g, category: "async" },
    { pattern: /\bawait\b/g, category: "async" },
    { pattern: /\bPromise\.all\b/g, category: "async" },
    { pattern: /\bPromise\.race\b/g, category: "async" },
    { pattern: /\bsetTimeout\b/g, category: "scheduler" },
    { pattern: /\bsetImmediate\b/g, category: "scheduler" },
    { pattern: /\bsetInterval\b/g, category: "scheduler" },
    { pattern: /\bqueueMicrotask\b/g, category: "scheduler" },
    { pattern: /\bnew\s+Worker\b/g, category: "thread" },
    { pattern: /\bWorker\b/g, category: "thread" },
    { pattern: /\bEventEmitter\b/g, category: "async" },
    { pattern: /\bAbortSignal\b/g, category: "async" },
    { pattern: /\bworker_threads\b/g, category: "thread" },
    { pattern: /\bisMainThread\b/g, category: "thread" },
    { pattern: /\bparentPort\b/g, category: "thread" },
    { pattern: /\bMessagePort\b/g, category: "async" },
    { pattern: /\bAtomics\./g, category: "atomic" },
    { pattern: /\bSharedArrayBuffer\b/g, category: "atomic" },
    { pattern: /\block\b/g, category: "lock" },
    { pattern: /\bLock\b/g, category: "lock" },
    { pattern: /\bdeferred\b/g, category: "async" },
    { pattern: /\bSubject\b/g, category: "async" },
    { pattern: /\bBehaviorSubject\b/g, category: "async" },
    { pattern: /\bObservable\b/g, category: "async" },
  ],
  javascript: [
    { pattern: /\basync\b/g, category: "async" },
    { pattern: /\bawait\b/g, category: "async" },
    { pattern: /\bPromise\.all\b/g, category: "async" },
    { pattern: /\bPromise\.race\b/g, category: "async" },
    { pattern: /\bsetTimeout\b/g, category: "scheduler" },
    { pattern: /\bsetImmediate\b/g, category: "scheduler" },
    { pattern: /\bsetInterval\b/g, category: "scheduler" },
    { pattern: /\bqueueMicrotask\b/g, category: "scheduler" },
    { pattern: /\bnew\s+Worker\b/g, category: "thread" },
    { pattern: /\bWorker\b/g, category: "thread" },
    { pattern: /\bEventEmitter\b/g, category: "async" },
    { pattern: /\bworker_threads\b/g, category: "thread" },
    { pattern: /\bAtomics\./g, category: "atomic" },
    { pattern: /\bSharedArrayBuffer\b/g, category: "atomic" },
    { pattern: /\block\b/g, category: "lock" },
    { pattern: /\bLock\b/g, category: "lock" },
  ],
  python: [
    { pattern: /\basync\b/g, category: "async" },
    { pattern: /\bawait\b/g, category: "async" },
    { pattern: /\basyncio\b/g, category: "async" },
    { pattern: /\bthreading\b/g, category: "thread" },
    { pattern: /\bmultiprocessing\b/g, category: "thread" },
    { pattern: /\bThread\b/g, category: "thread" },
    { pattern: /\bProcess\b/g, category: "thread" },
    { pattern: /\bLock\b/g, category: "lock" },
    { pattern: /\bRLock\b/g, category: "lock" },
    { pattern: /\bSemaphore\b/g, category: "lock" },
    { pattern: /\bCondition\b/g, category: "lock" },
    { pattern: /\bEvent\b/g, category: "async" },
    { pattern: /\bQueue\b/g, category: "channel" },
    { pattern: /\bcoroutine\b/g, category: "async" },
    { pattern: /\banext\b/g, category: "async" },
    { pattern: /\basend\b/g, category: "async" },
    { pattern: /\bgather\b/g, category: "async" },
  ],
  java: [
    { pattern: /\bsynchronized\b/g, category: "lock" },
    { pattern: /\block\b/g, category: "lock" },
    { pattern: /\bvolatile\b/g, category: "atomic" },
    { pattern: /\bLock\b/g, category: "lock" },
    { pattern: /\bReentrantLock\b/g, category: "lock" },
    { pattern: /\bReadWriteLock\b/g, category: "lock" },
    { pattern: /\bAtomic\w+\b/g, category: "atomic" },
    { pattern: /\bCompletableFuture\b/g, category: "async" },
    { pattern: /\bFutureTask\b/g, category: "async" },
    { pattern: /\bExecutor\w*\b/g, category: "thread" },
    { pattern: /\bThreadPool\b/g, category: "thread" },
    { pattern: /\bThread\b/g, category: "thread" },
    { pattern: /\bCountDownLatch\b/g, category: "lock" },
    { pattern: /\bCyclicBarrier\b/g, category: "lock" },
    { pattern: /\bSemaphore\b/g, category: "lock" },
    { pattern: /\bConcurrentHashMap\b/g, category: "lock" },
    { pattern: /\bConcurrentLinked\b/g, category: "lock" },
    { pattern: /\bForkJoinPool\b/g, category: "thread" },
  ],
  go: [
    { pattern: /\bgo\b/g, category: "thread" },
    { pattern: /\bchan\b/g, category: "channel" },
    { pattern: /\bselect\b/g, category: "channel" },
    { pattern: /\bsync\.Mutex\b/g, category: "lock" },
    { pattern: /\bsync\.RWMutex\b/g, category: "lock" },
    { pattern: /\bsync\.WaitGroup\b/g, category: "lock" },
    { pattern: /\bsync\.Once\b/g, category: "lock" },
    { pattern: /\bsync\.Cond\b/g, category: "lock" },
    { pattern: /\bsync\.Pool\b/g, category: "lock" },
    { pattern: /\bsync\/atomic\b/g, category: "atomic" },
    { pattern: /\batomic\./g, category: "atomic" },
    { pattern: /\bruntime\.Gosched\b/g, category: "scheduler" },
    { pattern: /\bgoroutine\b/g, category: "thread" },
    { pattern: /\bcontext\.WithCancel\b/g, category: "async" },
    { pattern: /\bcontext\.WithDeadline\b/g, category: "async" },
    { pattern: /\bcontext\.WithTimeout\b/g, category: "async" },
  ],
  rust: [
    { pattern: /\bArc\b/g, category: "atomic" },
    { pattern: /\bMutex\b/g, category: "lock" },
    { pattern: /\bRwLock\b/g, category: "lock" },
    { pattern: /\bAtomic\w+\b/g, category: "atomic" },
    { pattern: /\bthread::spawn\b/g, category: "thread" },
    { pattern: /\bspawn\b/g, category: "thread" },
    { pattern: /\btokio::spawn\b/g, category: "async" },
    { pattern: /\btokio::task\b/g, category: "async" },
    { pattern: /\bFuturesUnordered\b/g, category: "async" },
    { pattern: /\bjoin_all\b/g, category: "async" },
    { pattern: /\bselect!\b/g, category: "async" },
    { pattern: /\bloom::model\b/g, category: "scheduler" },
    { pattern: /\bChannel\b/g, category: "channel" },
    { pattern: /\bmpsc\b/g, category: "channel" },
    { pattern: /\bwatch\b/g, category: "channel" },
    { pattern: /\bBarrier\b/g, category: "lock" },
    { pattern: /\bCondvar\b/g, category: "lock" },
  ],
  ruby: [
    { pattern: /\bThread\.new\b/g, category: "thread" },
    { pattern: /\bMutex\.new\b/g, category: "lock" },
    { pattern: /\bMonitor\b/g, category: "lock" },
    { pattern: /\bConditionVariable\b/g, category: "lock" },
    { pattern: /\bQueue\b/g, category: "channel" },
    { pattern: /\bSizedQueue\b/g, category: "channel" },
    { pattern: /\bPromise\b/g, category: "async" },
    { pattern: /\bFiber\b/g, category: "scheduler" },
    { pattern: /\bRactor\b/g, category: "thread" },
  ],
};

const NAME_CONCURRENCY_CUES: Array<{
  keyword: string;
  category: ConcurrencySignal["category"];
}> = [
  { keyword: "lock", category: "lock" },
  { keyword: "mutex", category: "lock" },
  { keyword: "race", category: "async" },
  { keyword: "deadlock", category: "lock" },
  { keyword: "atomic", category: "atomic" },
  { keyword: "thread", category: "thread" },
  { keyword: "concurrent", category: "thread" },
  { keyword: "parallel", category: "thread" },
  { keyword: "queue", category: "channel" },
  { keyword: "scheduler", category: "scheduler" },
  { keyword: "throttle", category: "scheduler" },
  { keyword: "debounce", category: "scheduler" },
  { keyword: "semaphore", category: "lock" },
  { keyword: "barrier", category: "lock" },
  { keyword: "spinlock", category: "lock" },
  { keyword: "rwlock", category: "lock" },
  { keyword: "eventloop", category: "scheduler" },
  { keyword: "event_loop", category: "scheduler" },
];

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Detect concurrency signals within a changed target's source range.
 *
 * Layer 1: Scans the target's source text for language-specific keywords
 *          and API usage patterns.
 * Layer 2: Checks the target's name and file name for concurrency cues.
 *
 * Returns an empty array for targets that show no concurrency sensitivity,
 * so callers can use `signals.length > 0` as the trigger gate.
 */
export function detectConcurrencySignals(
  content: string,
  target: Pick<
    ChangedTarget,
    "name" | "lineRange" | "byteRange" | "languageId" | "path"
  >,
): ConcurrencySignal[] {
  const signals: ConcurrencySignal[] = [];
  const seen = new Set<string>();

  // ── Layer 1: Token/pattern scan in the target's source range ──
  // Convert byte offsets to string character indices for content.slice()
  const charStart = byteOffsetToCharIndex(content, target.byteRange.startIndex);
  const charEnd = byteOffsetToCharIndex(content, target.byteRange.endIndex);
  const sourceSlice = content.slice(charStart, charEnd);

  const languagePatterns = getPatternsForLanguage(target.languageId);
  for (const entry of languagePatterns) {
    entry.pattern.lastIndex = 0; // reset global regex state
    let m: RegExpExecArray | null;
    while ((m = entry.pattern.exec(sourceSlice)) !== null) {
      const absoluteCharOffset =
        charStart + m.index;
      const line = byteOffsetToLine(content, absoluteCharOffset);
      const key = `${line}:${m[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        signals.push({
          category: entry.category,
          token: m[0],
          line,
        });
      }
    }
  }

  // ── Layer 2: Name scan on target symbol name ──
  const targetNameLower = target.name.toLowerCase();
  for (const cue of NAME_CONCURRENCY_CUES) {
    if (targetNameLower.includes(cue.keyword)) {
      const key = `name:${cue.keyword}`;
      if (!seen.has(key)) {
        seen.add(key);
        signals.push({
          category: cue.category,
          token: target.name,
          line: target.lineRange.startLine,
        });
      }
    }
  }

  // ── Layer 2 extended: File name scan ──
  const fileName =
    target.path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  for (const cue of NAME_CONCURRENCY_CUES) {
    if (fileName.includes(cue.keyword)) {
      const key = `fname:${cue.keyword}`;
      if (!seen.has(key)) {
        seen.add(key);
        signals.push({
          category: cue.category,
          token: fileName,
          line: 1,
        });
      }
    }
  }

  return signals;
}

/**
 * Convenience: detect signals for an array of targets, mutating
 * the targets' concurrencySignals arrays in place.
 */
export function attachConcurrencySignals(
  content: string,
  targets: ChangedTarget[],
): void {
  for (const target of targets) {
    target.concurrencySignals = detectConcurrencySignals(content, target);
  }
}

/**
 * Check whether any concurrency signals exist across all targets.
 * Useful as a fast gate before running the concurrency verification lane.
 */
export function hasConcurrencySignals(
  signals: ConcurrencySignal[],
): boolean {
  return signals.length > 0;
}

// ─── Helpers ────────────────────────────────────────────────────────

function getPatternsForLanguage(languageId: string): PatternEntry[] {
  if (LANGUAGE_PATTERNS[languageId]) {
    return LANGUAGE_PATTERNS[languageId];
  }
  // React variants fall back to vanilla
  if (languageId === "typescriptreact") {
    return LANGUAGE_PATTERNS.typescript;
  }
  if (languageId === "javascriptreact") {
    return LANGUAGE_PATTERNS.javascript;
  }
  return [];
}

/**
 * Convert a UTF-8 byte offset to a string character index.
 * Iterates the UTF-8 byte representation of `content` and counts
 * characters until the given byte offset is reached.
 */
function byteOffsetToCharIndex(content: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const buffer = Buffer.from(content, "utf8");
  const maxOffset = Math.min(byteOffset, buffer.length);
  let charIndex = 0;
  let byteIdx = 0;
  while (byteIdx < maxOffset && charIndex < content.length) {
    const byte = buffer[byteIdx];
    if (byte < 0x80) {
      byteIdx += 1;
    } else if (byte < 0xE0) {
      byteIdx += 2;
    } else if (byte < 0xF0) {
      byteIdx += 3;
    } else {
      byteIdx += 4;
    }
    charIndex++;
  }
  return charIndex;
}

/**
 * Compute 1-based line number for a character index in the full content.
 */
function byteOffsetToLine(content: string, offset: number): number {
  if (offset <= 0) return 1;
  if (offset >= content.length) offset = content.length - 1;
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}
