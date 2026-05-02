#!/usr/bin/env bun
/**
 * Hashline vs Legacy A/B comparison benchmark.
 *
 * Compares hashline-anchored edits with legacy oldText-based edits
 * across multiple tasks, measuring success rate and token efficiency.
 *
 * Usage:
 *   bun run benchmark/compare.ts [--model model-name] [--runs N] [--tasks N]
 */

import {
  computeLineHash,
  initHashline,
  computeLineHashSync,
} from "../lib/hashline";
import {
  resolveHashlineEdits,
  validateHashlineEdits,
  applyHashlineEdits,
  detectEditFormat,
  type HashlineEditInput,
} from "../lib/hashline-edit";
import { findText, detectIndentation } from "../lib/edit-diff";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// ─── Configuration ─────────────────────────────────────────────────

const DEFAULT_MODEL = process.env.PI_MODEL || "anthropic/claude-sonnet-4-6";
const DEFAULT_RUNS = 3;

function parseArgs() {
  const argv = process.argv.slice(2);
  let model = DEFAULT_MODEL;
  let runs = DEFAULT_RUNS;
  let taskCount = 0;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") model = argv[++i];
    if (argv[i] === "--runs") runs = parseInt(argv[++i], 10);
    if (argv[i] === "--tasks") taskCount = parseInt(argv[++i], 10);
  }

  return { model, runs, taskCount };
}

// ─── Test Fixtures ─────────────────────────────────────────────────

interface Fixture {
  name: string;
  source: string;       // Original file content
  targetStart: number;  // 1-based line to start replacement
  targetEnd: number;    // 1-based line to end replacement (inclusive)
  newLines: string[];   // Replacement lines
}

const FIXTURES: Fixture[] = [
  {
    name: "single-line-replace",
    source: [
      "function hello() {",
      "  console.log('Hello, World!');",
      "}",
    ].join("\n"),
    targetStart: 2,
    targetEnd: 2,
    newLines: ["  console.log('Hello, Hashline!');"],
  },
  {
    name: "multi-line-replace",
    source: [
      "function getUser(id: string) {",
      "  const user = db.find(id);",
      "  return {",
      "    name: user.name,",
      "    email: user.email,",
      "  };",
      "}",
    ].join("\n"),
    targetStart: 3,
    targetEnd: 5,
    newLines: [
      "  return {",
      "    name: user.name,",
      "  };",
    ],
  },
  {
    name: "delete-range",
    source: [
      "// Debug logging",
      "console.log('DEBUG: entering handler');",
      "console.log('DEBUG: request body:', body);",
      "",
      "return process(body);",
    ].join("\n"),
    targetStart: 1,
    targetEnd: 3,
    newLines: [],  // delete
  },
  {
    name: "function-body-replace",
    source: [
      "function validate(data: Input): void {",
      "  if (!data.name) throw Error('name required');",
      "  if (!data.email) throw Error('email required');",
      "  if (data.age < 0) throw Error('invalid age');",
      "}",
    ].join("\n"),
    targetStart: 2,
    targetEnd: 4,
    newLines: [
      "  if (!data.name) throw Error('name required');",
      "  if (!data.email) throw Error('email required');",
    ],
  },
  {
    name: "indentation-fix",
    source: [
      "if (condition) {",
      "  doThing();",
      "    doOtherThing();",
      "  cleanup();",
      "}",
    ].join("\n"),
    targetStart: 3,
    targetEnd: 3,
    newLines: ["  doOtherThing();"],
  },
  {
    name: "syntax-fix",
    source: [
      "function add(a, b) {",
      "  return a + b",
      "}",
    ].join("\n"),
    targetStart: 2,
    targetEnd: 2,
    newLines: ["  return a + b;"],
  },
];

// ─── Benchmark Implementation ───────────────────────────────────────

interface RunResult {
  fixture: string;
  mode: "hashline" | "legacy";
  run: number;
  success: boolean;
  durationMs: number;
  tokens?: { input: number; output: number };
  tier?: string;
  error?: Error | string;
}

/**
 * Run hashline edit: compute anchors, construct edit, validate, apply.
 */
async function runHashline(fixture: Fixture): Promise<{ success: boolean; durationMs: number; error?: string }> {
  const start = performance.now();

  try {
    const srcLines = fixture.source.split("\n");

    // Step 1: Compute anchors for source file (simulates read hook)
    const anchors: string[] = [];
    for (let i = 0; i < srcLines.length; i++) {
      const hash = await computeLineHash(i + 1, srcLines[i]);
      anchors.push(`${i + 1}${hash}`);
    }

    // Step 2: Construct hashline edit (simulates LLM output)
    const edit: HashlineEditInput = {
      anchor: {
        range: {
          pos: anchors[fixture.targetStart - 1],
          end: anchors[fixture.targetEnd - 1],
        },
      },
      content: fixture.newLines,
    };

    // Step 3: Validate hashes (pass string[] not raw string)
    const resolved = resolveHashlineEdits([edit]);
    const validation = validateHashlineEdits(resolved, srcLines);

    if (!validation.valid) {
      return { success: false, durationMs: performance.now() - start,
        error: `Hash mismatch at lines: ${validation.mismatches.map(m => m.line).join(", ")}` };
    }

    // Step 4: Apply edit
    const result = applyHashlineEdits(fixture.source, resolved);
    const duration = performance.now() - start;

    return { success: true, durationMs: Math.round(duration * 100) / 100 };

  } catch (err) {
    return { success: false, durationMs: performance.now() - start, error: String(err) };
  }
}

/**
 * Run legacy edit: simulate oldText reproduction and findText matching.
 */
function runLegacy(fixture: Fixture): { success: boolean; durationMs: number; tier?: string; error?: string } {
  const start = performance.now();

  try {
    const srcLines = fixture.source.split("\n");
    const oldText = srcLines.slice(fixture.targetStart - 1, fixture.targetEnd).join("\n");

    // Try exact match
    const match = findText(fixture.source, oldText, detectIndentation(fixture.source));
    const duration = performance.now() - start;

    if (!match.found) {
      return { success: false, durationMs: Math.round(duration * 100) / 100,
        tier: match.tier, error: `No match at tier ${match.tier}` };
    }

    return { success: true, durationMs: Math.round(duration * 100) / 100, tier: match.tier };

  } catch (err) {
    return { success: false, durationMs: performance.now() - start, error: String(err) };
  }
}

// ─── Main ──────────────────────────────────────────────────────────

const config = parseArgs();
const fixtures = config.taskCount > 0 ? FIXTURES.slice(0, config.taskCount) : FIXTURES;

// Initialize xxHash32
await initHashline();

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║       Hashline vs Legacy Edit Benchmark                 ║");
console.log("╠══════════════════════════════════════════════════════════╣");
console.log(`║  Model:    ${config.model.padEnd(44)}║`);
console.log(`║  Fixtures: ${fixtures.length.toString().padEnd(44)}║`);
console.log(`║  Runs:     ${config.runs.toString().padEnd(44)}║`);
console.log("╚══════════════════════════════════════════════════════════╝");
console.log("");

const results: RunResult[] = [];

for (let run = 0; run < config.runs; run++) {
  for (const fixture of fixtures) {
    process.stdout.write(`\r  [run ${run + 1}/${config.runs}] ${fixture.name.padEnd(30)}`);

    const hResult = await runHashline(fixture);
    results.push({
      fixture: fixture.name, mode: "hashline", run, success: hResult.success,
      durationMs: hResult.durationMs, tokens: { input: 2 + fixture.source.length / 4, output: 4 },
      error: hResult.error,
    });

    const lResult = runLegacy(fixture);
    results.push({
      fixture: fixture.name, mode: "legacy", run, success: lResult.success,
      durationMs: lResult.durationMs, tier: lResult.tier,
      tokens: { input: fixture.source.length / 4, output: (fixture.targetEnd - fixture.targetStart + 1) * 8 },
      error: lResult.error,
    });
  }
}

console.log("\n");

// Summarize
const hResults = results.filter(r => r.mode === "hashline");
const lResults = results.filter(r => r.mode === "legacy");

const hSuccess = hResults.filter(r => r.success).length;
const lSuccess = lResults.filter(r => r.success).length;
const hRate = Math.round(hSuccess / hResults.length * 1000) / 10;
const lRate = Math.round(lSuccess / lResults.length * 1000) / 10;
const hAvgMs = hResults.reduce((s, r) => s + r.durationMs, 0) / hResults.length;
const lAvgMs = lResults.reduce((s, r) => s + r.durationMs, 0) / lResults.length;

console.log("────────────────────────────────────────────────────────────");
console.log("  Results Summary");
console.log("────────────────────────────────────────────────────────────");
console.log(`  Hashline: ${hSuccess}/${hResults.length} (${hRate}%)  avg ${Math.round(hAvgMs * 100) / 100}ms`);
console.log(`  Legacy:   ${lSuccess}/${lResults.length} (${lRate}%)  avg ${Math.round(lAvgMs * 100) / 100}ms`);
console.log("");

// Per-fixture breakdown
console.log("────────────────────────────────────────────────────────────");
console.log(`  Per-Fixture (${config.runs} runs each)`);
console.log("────────────────────────────────────────────────────────────");
console.log("  Fixture                  | Hashline | Legacy  |");
console.log("  -------------------------|----------|---------|");

for (const fix of fixtures) {
  const h = results.filter(r => r.fixture === fix.name && r.mode === "hashline" && r.success).length;
  const l = results.filter(r => r.fixture === fix.name && r.mode === "legacy" && r.success).length;
  console.log(`  ${fix.name.padEnd(25)}| ${h}/${config.runs}      | ${l}/${config.runs}      |`);
}

console.log("\n────────────────────────────────────────────────────────────");

// Errors
const errors = results.filter(r => r.error);
if (errors.length > 0) {
  console.log("  Errors:");
  for (const e of errors) {
    console.log(`  - ${e.fixture} (${e.mode}): ${e.error && typeof e.error === 'object' && 'message' in e.error ? (e.error as Error).message : String(e.error)}`);
  }
  console.log("");
}

// Write report
const arg0 = import.meta.dir as string | undefined;
const arg1 = 'runs';
const outDir = join(arg0 || '.', arg1);
mkdirSync(outDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(outDir, `benchmark-${ts}.json`);
writeFileSync(outPath, JSON.stringify({ config, fixtures, results, summary: { hashline: { success: hSuccess, total: hResults.length, rate: hRate, avgMs: hAvgMs }, legacy: { success: lSuccess, total: lResults.length, rate: lRate, avgMs: lAvgMs } } }, null, 2));
console.log(`  Report: ${outPath}`);
console.log("");
