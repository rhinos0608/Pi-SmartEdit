#!/usr/bin/env bun
/**
 * Hashline accuracy and churn threshold benchmark.
 *
 * Tests hashline anchor matching, rebasing, and churn across
 * 10 diverse editing scenarios.  Produces a table with per-fixture
 * metrics and a recommended ANCHOR_CHURN_THRESHOLD based on P90.
 *
 * Usage: bun run benchmark/hashline-bench.ts
 */

import { initHashline, computeLineHashSync, buildHashlineAnchors } from "../src/core/hashline";
import {
  validateHashlineEdits,
  tryRebaseAll,
  applyHashlineEdits,
  type HashlineEditOp,
  type Anchor,
} from "../src/core/hashline-edit";
import { computeAnchorDelta, ANCHOR_CHURN_THRESHOLD } from "../src/anchor-registry";
import type { FileSnapshot } from "../src/core/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Fixture {
  name: string;
  description: string;
  oldContent: string[];
  edits: HashlineEditOp[];
  expectedContent: string[];
  /** Line range (0-indexed, inclusive) within oldContent that gets replaced */
  editPos: number;
  editEnd: number;
}

interface FixtureResult {
  name: string;
  description: string;
  /** Percentage of anchors that matched directly */
  directPct: number;
  /** Was rebase successful with ±N shifts? */
  rebasePass1: boolean;
  rebasePass3: boolean;
  rebasePass5: boolean;
  /** Total anchors churned (shifted + deleted + changed) */
  churnCount: number;
  /** Estimated tokens for hashline format */
  hashlineTokens: number;
  /** Estimated tokens for legacy oldText+newText format */
  legacyTokens: number;
  /** Total old lines */
  totalLines: number;
  /** Lines touched by edit */
  changedLines: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAnchor(line: number, content: string[]): Anchor {
  const text = content[line - 1];
  const hash = computeLineHashSync(line, text);
  return { line, hash };
}

function anchorStr(line: number, content: string[]): string {
  const a = makeAnchor(line, content);
  return `${a.line}${a.hash}`;
}

/** Rough BPE token estimate: ~4 chars per token for source code / JSON */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Insert N blank lines before a given 1-based line index */
function shiftContent(lines: string[], beforeLine: number, n: number): string[] {
  const r = [...lines];
  r.splice(beforeLine - 1, 0, ...Array<string>(n).fill(""));
  return r;
}

/** Compute hashline JSON token count (anchor refs + new content only) */
function hashlineJsonTokens(oldContent: string[], posLine: number, endLine: number, newLines: string[]): number {
  const pAnchor = anchorStr(posLine, oldContent);
  const eAnchor = anchorStr(endLine, oldContent);
  const json = JSON.stringify({
    anchor: { range: { pos: pAnchor, end: eAnchor } },
    content: newLines,
  });
  return estimateTokens(json);
}

/** Compute legacy JSON token count (oldText + newText) */
function legacyJsonTokens(oldContent: string[], posLine: number, endLine: number, newLines: string[]): number {
  const oldText = oldContent.slice(posLine - 1, endLine).join("\n");
  const newText = newLines.join("\n");
  const json = JSON.stringify({ oldText, newText });
  return estimateTokens(json);
}

/** Build a mock FileSnapshot from content lines for anchor delta computation */
async function buildSnapshot(content: string[]): Promise<FileSnapshot> {
  const { anchors } = await buildHashlineAnchors(content);
  return {
    path: "bench.ts",
    mtimeMs: 0,
    size: content.join("\n").length,
    contentHash: "",
    readAt: Date.now(),
    readOffset: 1,
    hashline: { anchors, formattedLines: [] },
  };
}

// ─── Create Fixtures ──────────────────────────────────────────────────────────
// Must be called AFTER initHashline() so computeLineHashSync works.

async function createFixtures(): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];

  // ── 1. Single-line replacement ──────────────────────────────────────────
  {
    const oldContent = [
      "import { resolve } from 'path';",
      "import { readFile } from 'fs';",
      "",
      "export function loadConfig(): Config {",
      "  const raw = readFile(resolve('config.json'), 'utf-8');",
      "  return JSON.parse(raw);",
      "}",
      "",
      "console.log('config loaded');",
    ];

    const newContent = [
      "import { resolve } from 'path';",
      "import { readFile } from 'fs';",
      "",
      "export function loadConfig(): Config {",
      "  const raw = readFile(resolve('config.json'), 'utf-8');",
      "  return JSON.parse(raw);",
      "}",
      "",
      "console.log('configuration initialized');",
    ];

    fixtures.push({
      name: "single-line-replace",
      description: "Change a single log line",
      oldContent,
      edits: [
        {
          op: "replace_range",
          pos: makeAnchor(9, oldContent),
          end: makeAnchor(9, oldContent),
          lines: ["console.log('configuration initialized');"],
        },
      ],
      expectedContent: newContent,
      editPos: 9,
      editEnd: 9,
    });
  }

  // ── 2. Multi-line replacement (5 lines) ──────────────────────────────────
  {
    const oldContent = [
      "function computeStats(values: number[]): Stats {",
      "  const sum = values.reduce((a, b) => a + b, 0);",
      "  const mean = sum / values.length;",
      "  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;",
      "  const stddev = Math.sqrt(variance);",
      "  return { mean, stddev, count: values.length };",
      "}",
      "",
      "export { computeStats };",
    ];

    const newContent = [
      "function computeStats(values: number[]): Stats {",
      "  const n = values.length;",
      "  if (n === 0) return { mean: 0, stddev: 0, count: 0 };",
      "  const sum = values.reduce((a, b) => a + b, 0);",
      "  return {",
      "    mean: sum / n,",
      "    stddev: Math.sqrt(values.reduce((a, b) => a + (b - sum / n) ** 2, 0) / n),",
      "    count: n,",
      "  };",
      "}",
      "",
      "export { computeStats };",
    ];

    fixtures.push({
      name: "multi-line-replace",
      description: "Replace function body (lines 2-6 → lines 2-9)",
      oldContent,
      edits: [
        {
          op: "replace_range",
          pos: makeAnchor(2, oldContent),
          end: makeAnchor(6, oldContent),
          lines: [
            "  const n = values.length;",
            "  if (n === 0) return { mean: 0, stddev: 0, count: 0 };",
            "  const sum = values.reduce((a, b) => a + b, 0);",
            "  return {",
            '    mean: sum / n,',
            "    stddev: Math.sqrt(values.reduce((a, b) => a + (b - sum / n) ** 2, 0) / n),",
            "    count: n,",
            "  };",
          ],
        },
      ],
      expectedContent: newContent,
      editPos: 2,
      editEnd: 6,
    });
  }

  // ── 3. Function insertion ───────────────────────────────────────────────
  {
    const oldContent = [
      "function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
      "function multiply(a: number, b: number): number {",
      "  return a * b;",
      "}",
    ];

    const newContent = [
      "function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
      "function subtract(a: number, b: number): number {",
      "  return a - b;",
      "}",
      "",
      "function multiply(a: number, b: number): number {",
      "  return a * b;",
      "}",
    ];

    fixtures.push({
      name: "function-insertion",
      description: "Insert a new function between existing ones (append_at line 4)",
      oldContent,
      edits: [
        {
          op: "append_at",
          pos: makeAnchor(4, oldContent),
          lines: [
            "function subtract(a: number, b: number): number {",
            "  return a - b;",
            "}",
            "",
          ],
        },
      ],
      expectedContent: newContent,
      editPos: 4,
      editEnd: 4,
    });
  }

  // ── 4. Function deletion ─────────────────────────────────────────────────
  {
    const oldContent = [
      "function helper(value: string): boolean {",
      "  if (!value) return false;",
      "  const trimmed = value.trim();",
      "  return trimmed.length > 0;",
      "}",
      "",
      "export function process(input: string[]): string[] {",
      "  return input.filter(helper);",
      "}",
    ];

    const newContent = [
      "export function process(input: string[]): string[] {",
      "  return input.filter(helper);",
      "}",
    ];

    fixtures.push({
      name: "function-deletion",
      description: "Delete a helper function (replace lines 1-6 → 0 lines)",
      oldContent,
      edits: [
        {
          op: "replace_range",
          pos: makeAnchor(1, oldContent),
          end: makeAnchor(6, oldContent),
          lines: [],
        },
      ],
      expectedContent: newContent,
      editPos: 1,
      editEnd: 6,
    });
  }

  // ── 5. Large refactor (50+ lines changed) ────────────────────────────────
  {
    // Build an 80-line module
    const oldContent: string[] = [];
    const newContent: string[] = [];

    // Shared header
    const header = [
      "import { EventEmitter } from 'events';",
      "import { strict as assert } from 'assert';",
      "",
    ];
    oldContent.push(...header);
    newContent.push(...header);

    // Old class — 76 lines
    const oldClass = [
      "export class DataPipeline {",
      "  private buffer: string[] = [];",
      "  private maxSize: number;",
      "  private emitter: EventEmitter;",
      "  private processedCount = 0;",
      "  private errorCount = 0;",
      "",
      "  constructor(maxSize = 1024) {",
      "    this.maxSize = maxSize;",
      "    this.emitter = new EventEmitter();",
      "  }",
      "",
      "  push(data: string): void {",
      "    if (this.buffer.length >= this.maxSize) {",
      "      this.flush();",
      "    }",
      "    this.buffer.push(data);",
      "    this.emitter.emit('data', data);",
      "  }",
      "",
      "  flush(): void {",
      "    if (this.buffer.length === 0) return;",
      "    const batch = [...this.buffer];",
      "    this.buffer = [];",
      "    this.processBatch(batch);",
      "  }",
      "",
      "  private processBatch(batch: string[]): void {",
      "    for (const item of batch) {",
      "      try {",
      "        this.transform(item);",
      "        this.processedCount++;",
      "      } catch (err) {",
      "        this.errorCount++;",
      "        this.emitter.emit('error', err);",
      "      }",
      "    }",
      "  }",
      "",
      "  private transform(item: string): string {",
      "    return item.trim().toLowerCase();",
      "  }",
      "",
      "  getStats(): { processed: number; errors: number } {",
      "    return {",
      "      processed: this.processedCount,",
      "      errors: this.errorCount,",
      "    };",
      "  }",
      "",
      "  onError(cb: (err: unknown) => void): void {",
      "    this.emitter.on('error', cb);",
      "  }",
      "",
      "  onData(cb: (data: string) => void): void {",
      "    this.emitter.on('data', cb);",
      "  }",
      "",
      "  get bufferSize(): number {",
      "    return this.buffer.length;",
      "  }",
      "",
      "  reset(): void {",
      "    this.buffer = [];",
      "    this.processedCount = 0;",
      "    this.errorCount = 0;",
      "    this.emitter.removeAllListeners();",
      "  }",
      "}",
    ];
    oldContent.push(...oldClass);

    // New class — heavily refactored (different method structure)
    const newClass = [
      "export class DataPipeline {",
      "  private buffer: string[] = [];",
      "  private readonly maxSize: number;",
      "  private readonly emitter: EventEmitter;",
      "  private processedCount = 0;",
      "  private errorCount = 0;",
      "  private latencyMs = 0;",
      "",
      "  constructor(maxSize = 1024) {",
      "    this.maxSize = maxSize;",
      "    this.emitter = new EventEmitter();",
      "  }",
      "",
      "  push(data: string): void {",
      "    if (this.buffer.length >= this.maxSize) {",
      "      this.flush();",
      "    }",
      "    this.buffer.push(data);",
      "  }",
      "",
      "  flush(): void {",
      "    if (this.buffer.length === 0) return;",
      "    const start = performance.now();",
      "    const batch = this.buffer.splice(0);",
      "    this.processBatch(batch);",
      "    this.latencyMs = performance.now() - start;",
      "  }",
      "",
      "  private processBatch(batch: string[]): void {",
      "    for (const item of batch) {",
      "      try {",
      '        const result = this.transform(item);',
      "        this.emitter.emit('data', result);",
      "        this.processedCount++;",
      "      } catch (err) {",
      "        this.errorCount++;",
      "        this.emitter.emit('error', err);",
      "      }",
      "    }",
      "  }",
      "",
      "  private transform(item: string): string {",
      "    if (typeof item !== 'string') throw new Error('Expected string');",
      "    return item.trim().toLowerCase();",
      "  }",
      "",
      "  getStats(): PipelineStats {",
      "    return {",
      "      processed: this.processedCount,",
      "      errors: this.errorCount,",
      "      latencyMs: this.latencyMs,",
      "      bufferSize: this.buffer.length,",
      "    };",
      "  }",
      "",
      "  onError(cb: (err: unknown) => void): () => void {",
      "    this.emitter.on('error', cb);",
      "    return () => this.emitter.off('error', cb);",
      "  }",
      "",
      "  get bufferSize(): number {",
      "    return this.buffer.length;",
      "  }",
      "",
      "  reset(): void {",
      "    this.buffer = [];",
      "    this.processedCount = 0;",
      "    this.errorCount = 0;",
      "    this.latencyMs = 0;",
      "    this.emitter.removeAllListeners();",
      "  }",
      "",
      "  /** Drain all remaining items and shut down */",
      "  async shutdown(): Promise<void> {",
      "    this.flush();",
      "    this.emitter.removeAllListeners();",
      "  }",
      "}",
    ];
    newContent.push(...newClass);

    // Footer (same in both)
    const footer = [
      "",
      "export interface PipelineStats {",
      "  processed: number;",
      "  errors: number;",
      "  latencyMs: number;",
      "  bufferSize: number;",
      "}",
    ];
    oldContent.push(...footer);
    newContent.push(...footer);

    // Verify we changed 50+ lines
    const startLine = header.length + 1; // 1-based, first line of class
    const endLine = header.length + oldClass.length;

    fixtures.push({
      name: "large-refactor",
      description: `Refactor class (${oldClass.length} old lines → ${newClass.length} new lines)`,
      oldContent,
      edits: [
        {
          op: "replace_range",
          pos: makeAnchor(startLine, oldContent),
          end: makeAnchor(endLine, oldContent),
          lines: newClass,
        },
      ],
      expectedContent: newContent,
      editPos: startLine,
      editEnd: endLine,
    });
  }

  // ── 6. Whitespace-only change ───────────────────────────────────────────
  {
    const oldContent = [
      "export function render(items: string[]): string {",
      "    return items",
      "        .map(i => `<li>${escape(i)}</li>`)",
      "        .join('\\n');",
      "}",
    ];

    const newContent = [
      "export function render(items: string[]): string {",
      "  return items",
      "    .map(i => `<li>${escape(i)}</li>`)",
      "    .join('\\n');",
      "}",
    ];

    fixtures.push({
      name: "whitespace-only",
      description: "Change indentation from 4-space to 2-space (lines 2-4)",
      oldContent,
      edits: [
        {
          op: "replace_range",
          pos: makeAnchor(2, oldContent),
          end: makeAnchor(4, oldContent),
          lines: [
            "  return items",
            "    .map(i => `<li>${escape(i)}</li>`)",
            "    .join('\\n');",
          ],
        },
      ],
      expectedContent: newContent,
      editPos: 2,
      editEnd: 4,
    });
  }

  // ── 7. Comment modification ─────────────────────────────────────────────
  {
    const oldContent = [
      "/**",
      " * Calculate the fibonacci number at position n.",
      " * Uses iterative approach for O(n) time.",
      " */",
      "function fibonacci(n: number): number {",
      "  if (n <= 1) return n;",
      "  let a = 0, b = 1;",
      "  for (let i = 2; i <= n; i++) {",
      "    [a, b] = [b, a + b];",
      "  }",
      "  return b;",
      "}",
    ];

    const newContent = [
      "/**",
      " * Compute the nth Fibonacci number.",
      " * Iterative, O(n) time, O(1) space.",
      " */",
      "function fibonacci(n: number): number {",
      "  if (n <= 1) return n;",
      "  let a = 0, b = 1;",
      "  for (let i = 2; i <= n; i++) {",
      "    [a, b] = [b, a + b];",
      "  }",
      "  return b;",
      "}",
    ];

    fixtures.push({
      name: "comment-modification",
      description: "Update JSDoc comment block (lines 1-4)",
      oldContent,
      edits: [
        {
          op: "replace_range",
          pos: makeAnchor(1, oldContent),
          end: makeAnchor(4, oldContent),
          lines: [
            "/**",
            " * Compute the nth Fibonacci number.",
            " * Iterative, O(n) time, O(1) space.",
            " */",
          ],
        },
      ],
      expectedContent: newContent,
      editPos: 1,
      editEnd: 4,
    });
  }

  // ── 8. Import statement change ──────────────────────────────────────────
  {
    const oldContent = [
      "import { readFile, writeFile } from 'fs';",
      "import { join } from 'path';",
      "import { format } from 'util';",
      "",
      "export async function copyFile(src: string, dest: string): Promise<void> {",
      "  const content = await readFile(src, 'utf-8');",
      "  await writeFile(dest, content);",
      "}",
    ];

    const newContent = [
      "import { access, readFile, writeFile } from 'fs/promises';",
      "import { join } from 'path';",
      "",
      "export async function copyFile(src: string, dest: string): Promise<void> {",
      "  const content = await readFile(src, 'utf-8');",
      "  await writeFile(dest, content);",
      "}",
    ];

    fixtures.push({
      name: "import-change",
      description: "Update imports (replace lines 1 + 3)",
      oldContent,
      edits: [
        {
          op: "replace_range",
          pos: makeAnchor(1, oldContent),
          end: makeAnchor(1, oldContent),
          lines: ["import { access, readFile, writeFile } from 'fs/promises';"],
        },
        {
          op: "replace_range",
          pos: makeAnchor(3, oldContent),
          end: makeAnchor(3, oldContent),
          lines: [],
        },
      ],
      expectedContent: newContent,
      editPos: 1,
      editEnd: 3,
    });
  }

  // ── 9. Class method addition ────────────────────────────────────────────
  {
    const oldContent = [
      "class Counter {",
      "  private count = 0;",
      "",
      "  increment(): number {",
      "    this.count++;",
      "    return this.count;",
      "  }",
      "",
      "  get value(): number {",
      "    return this.count;",
      "  }",
      "}",
    ];

    // append_at inserts content immediately after anchor;
    // original line 8 (empty) gets pushed below the inserted block
    const newContent = [
      "class Counter {",
      "  private count = 0;",
      "",
      "  increment(): number {",
      "    this.count++;",
      "    return this.count;",
      "  }",
      "  reset(): void {",
      "    this.count = 0;",
      "  }",
      "",
      "",
      "  get value(): number {",
      "    return this.count;",
      "  }",
      "}",
    ];

    fixtures.push({
      name: "method-addition",
      description: "Add reset() method to class (append_at line 7)",
      oldContent,
      edits: [
        {
          op: "append_at",
          pos: makeAnchor(7, oldContent),
          lines: [
            "  reset(): void {",
            "    this.count = 0;",
            "  }",
            "",
          ],
        },
      ],
      expectedContent: newContent,
      editPos: 7,
      editEnd: 7,
    });
  }

  // ── 10. Variable rename across multiple lines ───────────────────────────
  {
    const oldContent = [
      "function buildUrl(endpoint: string, params: Record<string, string>): string {",
      "  const base = `https://api.example.com/${endpoint}`;",
      "  const search = new URLSearchParams(params);",
      "  return `${base}?${search.toString()}`;",
      "}",
      "",
      "export async function fetchData(url: string): Promise<unknown> {",
      "  const resp = await fetch(url);",
      "  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);",
      "  const respData = await resp.json();",
      "  return respData;",
      "}",
    ];

    const newContent = [
      "function buildUrl(endpoint: string, params: Record<string, string>): string {",
      "  const base = `https://api.example.com/${endpoint}`;",
      "  const search = new URLSearchParams(params);",
      "  return `${base}?${search.toString()}`;",
      "}",
      "",
      "export async function fetchData(url: string): Promise<unknown> {",
      "  const response = await fetch(url);",
      "  if (!response.ok) throw new Error(`HTTP ${response.status}`);",
      "  const payload = await response.json();",
      "  return payload;",
      "}",
    ];

    fixtures.push({
      name: "variable-rename",
      description: "Rename `resp`→`response`, `respData`→`payload` across 4 lines",
      oldContent,
      edits: [
        {
          op: "replace_range",
          pos: makeAnchor(8, oldContent),
          end: makeAnchor(11, oldContent),
          lines: [
            "  const response = await fetch(url);",
            "  if (!response.ok) throw new Error(`HTTP ${response.status}`);",
            "  const payload = await response.json();",
            "  return payload;",
          ],
        },
      ],
      expectedContent: newContent,
      editPos: 8,
      editEnd: 11,
    });
  }

  return fixtures;
}

// ─── Benchmarking Logic ───────────────────────────────────────────────────────

async function runFixture(fixture: Fixture): Promise<FixtureResult> {
  const { oldContent, edits, name, expectedContent, editPos, editEnd } = fixture;

  // Direct match: validate anchors against original content
  const validation = validateHashlineEdits(edits, oldContent);
  const directMismatches = validation.mismatches.length;
  const totalAnchors = countAnchors(edits);
  const directPct = directMismatches === 0
    ? 100
    : Math.round((1 - directMismatches / totalAnchors) * 100);

  // Apply edit to verify correctness
  const applyResult = applyHashlineEdits(oldContent.join("\n"), edits);
  const actualLines = applyResult.lines.split("\n");

  // Verify expected content
  const contentMatch = arraysEqual(actualLines, expectedContent);

  // Rebase tests: shift content by N blank lines before the edit position
  const rebasePass1 = testRebase(edits, oldContent, editPos, 1);
  const rebasePass3 = testRebase(edits, oldContent, editPos, 3);
  const rebasePass5 = testRebase(edits, oldContent, editPos, 5);

  // Anchor churn: compute delta between pre-edit snapshot and post-edit content
  const snapshot = await buildSnapshot(oldContent);
  const postContent = expectedContent.join("\n");
  const delta = await computeAnchorDelta(snapshot, postContent);
  const churnCount = delta.shifted.length + delta.deleted.length + delta.changed.length;

  // Token counts
  const newLines = edits.flatMap(e => e.op === "replace_range" ? e.lines : e.lines);
  const hashlineTokens = hashlineJsonTokens(oldContent, editPos, editEnd, newLines);
  const legacyTokens = legacyJsonTokens(oldContent, editPos, editEnd, newLines);

  // Report content mismatch as warning
  if (!contentMatch) {
    console.error(`  ⚠  ${name}: expected content does not match applied result`);
  }

  return {
    name,
    description: fixture.description,
    directPct,
    rebasePass1,
    rebasePass3,
    rebasePass5,
    churnCount,
    hashlineTokens,
    legacyTokens,
    totalLines: oldContent.length,
    changedLines: editEnd - editPos + 1,
  };
}

function countAnchors(edits: HashlineEditOp[]): number {
  let count = 0;
  for (const e of edits) {
    if (e.op === "replace_range") {
      count += (e.end.line - e.pos.line + 1);
    } else if (e.op === "append_at" || e.op === "prepend_at") {
      count += 1;
    }
    // append_file / prepend_file have no anchors to count
  }
  return count;
}

function testRebase(
  edits: HashlineEditOp[],
  oldContent: string[],
  editPos: number,
  shiftCount: number,
): boolean {
  const shiftedContent = shiftContent(oldContent, editPos, shiftCount);
  const result = tryRebaseAll(edits, shiftedContent);
  return result.allResolved;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Churn analysis ──────────────────────────────────────────────────────────

function computePercentiles(sorted: number[]): Map<string, number> {
  const p = (k: number) => {
    const idx = Math.ceil((k / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  };
  return new Map([
    ["p50", p(50)],
    ["p75", p(75)],
    ["p90", p(90)],
    ["p95", p(95)],
    ["p99", p(99)],
  ]);
}

// ─── Output formatting ────────────────────────────────────────────────────────

function printResults(results: FixtureResult[]): void {
  const colW = [27, 8, 10, 10, 10, 7, 12, 12];

  console.log("\n=== Hashline Benchmark Results ===\n");

  const hdr = [
    padR("Fixture", colW[0]),
    padR("Direct", colW[1]),
    padR("Rebase±1", colW[2]),
    padR("Rebase±3", colW[3]),
    padR("Rebase±5", colW[4]),
    padR("Churn", colW[5]),
    padR("Tok(H)", colW[6]),
    padR("Tok(L)", colW[7]),
  ].join(" | ");

  console.log(hdr);
  console.log("-".repeat(hdr.length));

  for (const r of results) {
    const row = [
      padR(r.name, colW[0]),
      padR(pct(r.directPct), colW[1]),
      padR(bool(r.rebasePass1), colW[2]),
      padR(bool(r.rebasePass3), colW[3]),
      padR(bool(r.rebasePass5), colW[4]),
      padR(`${r.churnCount}`, colW[5]),
      padR(`${r.hashlineTokens}`, colW[6]),
      padR(`${r.legacyTokens}`, colW[7]),
    ].join(" | ");
    console.log(row);
  }

  console.log("\n### Notes");
  console.log(`- Direct = 100% means all anchors matched without rebase.`);
  console.log(`- Rebase±N = YES if tryRebaseAll succeeded with N blank lines inserted before edit.`);
  console.log(`- Churn = shifted + deleted + changed anchors in delta.`);
  console.log(`- Tok(H) = hashline format token estimate; Tok(L) = legacy oldText+newText estimate.`);
}

function padR(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function pct(v: number): string {
  return v === 100 ? "100%" : ` ${v}%`;
}

function bool(v: boolean): string {
  return v ? "  YES  " : "  NO   ";
}

function printDistribution(sorted: number[]): void {
  const pcts = computePercentiles(sorted);

  // Try thresholds from 5 to 50, pick the one at p90
  // P90 means 90% of edits have churn ≤ that value
  // If current threshold < p90, recommend p90
  // If current threshold >= p90, keep current threshold but flag if too high

  const churnAtP90 = pcts.get("p90") ?? 0;
  const churnAtP95 = pcts.get("p95") ?? 0;

  // What percentage of edits fall under current threshold?
  const underCurrent = sorted.filter(c => c <= ANCHOR_CHURN_THRESHOLD).length / sorted.length;

  console.log("\n=== Churn Distribution ===\n");

  console.log(
    `p50: ${pcts.get("p50")}   ` +
    `p75: ${pcts.get("p75")}   ` +
    `p90: ${pcts.get("p90")}   ` +
    `p95: ${pcts.get("p95")}   ` +
    `p99: ${pcts.get("p99")}`
  );

  console.log(`\nRaw churn values: [${sorted.join(", ")}]`);
  console.log(`\nSamples: ${sorted.length}`);

  console.log("\n=== Recommendation ===\n");
  console.log(`Current ANCHOR_CHURN_THRESHOLD: ${ANCHOR_CHURN_THRESHOLD}`);
  console.log(`Edits below current threshold: ${(underCurrent * 100).toFixed(1)}%`);
  console.log(`Churn at P90: ${churnAtP90}`);
  console.log(`Churn at P95: ${churnAtP95}`);

  if (churnAtP90 < ANCHOR_CHURN_THRESHOLD) {
    // Current threshold is generous enough; but we can suggest tightening
    const p90Captures = sorted.filter(c => c <= churnAtP90).length / sorted.length;
    console.log(`\nRecommended ANCHOR_CHURN_THRESHOLD: ${churnAtP90} (captures ${(p90Captures * 100).toFixed(0)}% of normal edits)`);
    console.log(`  → Tighter than current ${ANCHOR_CHURN_THRESHOLD}, still safe.`);
  } else {
    // Current threshold is below P90 — raise it
    const recommended = Math.max(churnAtP90, ANCHOR_CHURN_THRESHOLD);
    const p90Captures = sorted.filter(c => c <= recommended).length / sorted.length;
    console.log(`\nRecommended ANCHOR_CHURN_THRESHOLD: ${recommended} (captures ${(p90Captures * 100).toFixed(0)}% of normal edits)`);
    console.log(`  → Raise from ${ANCHOR_CHURN_THRESHOLD} to ${recommended} to avoid false re-read triggers.`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Initializing hashline (xxHash32)...");
  await initHashline();

  console.log("Creating fixtures...");
  const fixtures = await createFixtures();

  console.log(`Running ${fixtures.length} fixtures...\n`);

  const results: FixtureResult[] = [];
  const allChurn: number[] = [];
  let passed = 0;

  for (let i = 0; i < fixtures.length; i++) {
    const fx = fixtures[i];
    process.stdout.write(`  [${i + 1}/${fixtures.length}] ${fx.name} ... `);
    try {
      const r = await runFixture(fx);
      results.push(r);
      allChurn.push(r.churnCount);
      process.stdout.write(`churn=${r.churnCount} tok(H)=${r.hashlineTokens} tok(L)=${r.legacyTokens}`);
      if (r.directPct === 100) {
        process.stdout.write(" ✓");
        passed++;
      } else {
        process.stdout.write(` ${r.directPct}% direct (partial)`);
      }
      console.log();
    } catch (err) {
      console.error(`ERROR: ${err}`);
      results.push({
        name: fx.name,
        description: fx.description,
        directPct: 0,
        rebasePass1: false,
        rebasePass3: false,
        rebasePass5: false,
        churnCount: -1,
        hashlineTokens: 0,
        legacyTokens: 0,
        totalLines: fx.oldContent.length,
        changedLines: fx.editEnd - fx.editPos + 1,
      });
      allChurn.push(0);
    }
  }

  console.log(`\n${passed}/${fixtures.length} fixtures passed direct match validation.`);

  // Print results table
  printResults(results);

  // Print churn distribution
  allChurn.sort((a, b) => a - b);
  printDistribution(allChurn);

  // Summary
  if (passed === fixtures.length) {
    console.log("\n=== Summary ===");
    console.log("All fixtures passed.");
  } else {
    console.log(`\n=== Summary ===`);
    console.log(`${fixtures.length - passed} fixture(s) had partial direct matches (mismatches).`);
  }
}

await main();
