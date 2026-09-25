#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
/**
 * End-to-end SmartEdit agent benchmark.
 *
 * This runner invokes Pi for every task, limits the model to read+edit,
 * and scores files that land on disk against hidden exact expected outputs.
 * The deterministic hashline microbenchmark remains in hashline-bench.ts.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Mode = "hashline" | "normal";

interface Config {
  model: string;
  runs: number;
  taskCount: number;
  mode: Mode | "both";
  timeoutMs: number;
  keepWorkdirs: boolean;
}

interface Task {
  id: string;
  dir: string;
  prompt: string;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  reasoning: number;
  costUsd: number;
}

interface RunResult {
  task: string;
  mode: Mode;
  run: number;
  success: boolean;
  exactMatch: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  usage: UsageTotals;
  editCalls: number;
  editErrors: number;
  compliantEditCalls: number;
  protocolCompliancePct: number;
  mismatches: string[];
  transcript: string;
  stderr: string;
  workdir?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "fixtures");
const RUN_ROOT = join(HERE, "runs");
const PI_BIN = process.env.PI_BIN
  || (existsSync("/opt/homebrew/bin/pi") ? "/opt/homebrew/bin/pi"
    : existsSync("/usr/local/bin/pi") ? "/usr/local/bin/pi"
      : "pi");

function parseArgs(): Config {
  const argv = process.argv.slice(2);
  const config: Config = {
    model: process.env.PI_MODEL || "opencode-go/muse-spark-1.3-contributor",
    runs: 1,
    taskCount: 0,
    mode: "both",
    timeoutMs: 0,
    keepWorkdirs: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") config.model = argv[++i];
    else if (arg === "--runs") config.runs = Number(argv[++i]);
    else if (arg === "--tasks") config.taskCount = Number(argv[++i]);
    else if (arg === "--mode") config.mode = argv[++i] as Config["mode"];
    else if (arg === "--timeout-ms") config.timeoutMs = Number(argv[++i]);
    else if (arg === "--keep-workdirs") config.keepWorkdirs = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run benchmark/compare.ts [--model ID] [--runs N] [--tasks N] [--mode both|hashline|normal] [--timeout-ms N] [--keep-workdirs] (timeout 0 = disabled)");
      process.exit(0);
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }

  if (!Number.isInteger(config.runs) || config.runs < 1) throw new Error("--runs must be >= 1");
  if (!Number.isInteger(config.taskCount) || config.taskCount < 0) throw new Error("--tasks must be >= 0");
  if (!["both", "hashline", "normal"].includes(config.mode)) throw new Error("--mode must be both, hashline, or normal");
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 0 || (config.timeoutMs > 0 && config.timeoutMs < 1_000)) {
    throw new Error("--timeout-ms must be 0 (disabled) or >= 1000");
  }
  return config;
}

function loadTasks(limit: number): Task[] {
  if (!existsSync(FIXTURE_ROOT)) throw new Error("Missing fixture directory: " + FIXTURE_ROOT);
  const tasks = readdirSync(FIXTURE_ROOT)
    .filter((id) => existsSync(join(FIXTURE_ROOT, id, "input")) && existsSync(join(FIXTURE_ROOT, id, "expected")))
    .sort()
    .map((id) => ({
      id,
      dir: join(FIXTURE_ROOT, id),
      prompt: readFileSync(join(FIXTURE_ROOT, id, "prompt.md"), "utf8").trim(),
    }));
  return limit > 0 ? tasks.slice(0, limit) : tasks;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules" || name.startsWith(".pi") || name === ".smart-edit-undo") continue;
      const full = join(dir, name);
      const rel = relative(root, full);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

function verifyWorkspace(workspace: string, expected: string): { exact: boolean; mismatches: string[] } {
  const actualFiles = listFiles(workspace);
  const expectedFiles = listFiles(expected);
  const mismatches: string[] = [];
  const names = new Set([...actualFiles, ...expectedFiles]);

  for (const name of [...names].sort()) {
    const actualPath = join(workspace, name);
    const expectedPath = join(expected, name);
    if (!existsSync(actualPath)) {
      mismatches.push(name + ": missing");
    } else if (!existsSync(expectedPath)) {
      mismatches.push(name + ": unexpected file");
    } else if (!readFileSync(actualPath).equals(readFileSync(expectedPath))) {
      mismatches.push(name + ": content differs");
    }
  }
  return { exact: mismatches.length === 0, mismatches };
}

function numeric(obj: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function parseJsonEvents(stdout: string, mode: Mode) {
  const usage: UsageTotals = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    total: 0, reasoning: 0, costUsd: 0,
  };
  const calls = new Map<string, unknown>();
  const errors = new Set<string>();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }

    if (event?.type === "message_end" && event?.message?.usage) {
      const u = event.message.usage as Record<string, unknown>;
      usage.input += numeric(u, "input", "inputTokens", "input_tokens");
      usage.output += numeric(u, "output", "outputTokens", "output_tokens");
      usage.cacheRead += numeric(u, "cacheRead", "cacheReadTokens", "cache_read_input_tokens");
      usage.cacheWrite += numeric(u, "cacheWrite", "cacheWriteTokens", "cache_creation_input_tokens");
      usage.total += numeric(u, "total", "totalTokens", "total_tokens");
      usage.reasoning += numeric(u, "reasoning", "reasoningTokens", "reasoning_tokens");
      const cost = u.cost;
      if (cost && typeof cost === "object" && !Array.isArray(cost)) {
        usage.costUsd += numeric(cost as Record<string, unknown>, "total");
      }
    }

    const content = event?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const type = block?.type;
        const name = block?.name ?? block?.toolName;
        if ((type === "toolCall" || type === "tool_call") && name === "edit") {
          const id = String(block?.id ?? block?.toolCallId ?? ("content-" + String(calls.size)));
          calls.set(id, block?.arguments ?? block?.input ?? {});
        }
      }
    }

    if ((event?.type === "tool_execution_start" || event?.type === "tool_call") && event?.toolName === "edit") {
      const id = String(event?.toolCallId ?? event?.id ?? ("event-" + String(calls.size)));
      calls.set(id, event?.args ?? event?.arguments ?? event?.input ?? {});
    }
    if ((event?.type === "tool_execution_end" || event?.message?.role === "toolResult") &&
        (event?.toolName === "edit" || event?.message?.toolName === "edit")) {
      const details = event?.result?.details ?? event?.details ?? event?.message?.details;
      const failedStatus = details?.status?.kind === "failed";
      if (event?.isError === true || event?.message?.isError === true || failedStatus) {
        errors.add(String(event?.toolCallId ?? event?.message?.toolCallId ?? ("error-" + String(errors.size))));
      }
    }
  }

  let compliant = 0;
  for (const args of calls.values()) {
    const text = JSON.stringify(args);
    const usesHashline = text.includes('"hashline"');
    const usesOldText = text.includes('"oldText"');
    if (mode === "hashline" ? (usesHashline && !usesOldText) : (usesOldText && !usesHashline)) compliant++;
  }
  if (usage.total === 0) usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return { usage, editCalls: calls.size, editErrors: errors.size, compliantEditCalls: compliant };
}

function modePrompt(mode: Mode): string {
  if (mode === "hashline") {
    return [
      "You are a coding agent running a controlled edit benchmark.",
      "Use the available read and SmartEdit edit tools to make the requested workspace change exactly.",
      "Read files first. A read row looks like 42ab|source text. The anchor is only the complete LINE+ID token before |, e.g. \"42ab\"; copy that token as one unit. Never include | or source text, never send only the hash suffix, and never combine a line number from one row with a hash suffix from another.",
      "Use only lines actually shown by read; elided or unread lines are not valid edit anchors. SmartEdit checks anchor provenance against the retained read snapshot.",
      "If an edit rejects an anchor as stale, ambiguous, or not present in the read snapshot, re-read the target lines and use the fresh complete token instead of manually repairing the anchor.",
      "The edit schema is hashline-only. The top-level edits field must be a native JSON array of edit objects, never a JSON-encoded string and never a singleton object. Full replace/delete call shape: { path: \"file.ts\", edits: [{ hashline: { range: { pos: \"42ab\", end: \"44cd\" }, content: replacement } }] }. For pure insertion after/before an observed line, use pos \"42ab:after\" or \"42ab:before\" and end \"42ab\"; do not re-emit unchanged keeper lines.",
      "Set hashline.content to the replacement string or replacement-line array; use null explicitly to delete the anchored range. Never put source/old text in hashline.content.",
      "All anchors in one edit call refer to the same pre-edit file version, so batch disjoint edits using their original anchors rather than adjusting later line numbers.",
      "After a successful edit call, re-read a file before making another hashline edit call against it.",
      "Do not use oldText, newText, lineRange, target, raw patch input, write, shell redirection, or patch utilities.",
    ].join(" ");
  }
  return [
    "You are a coding agent running a controlled edit benchmark.",
    "Use the available read and SmartEdit edit tools to make the requested workspace change exactly.",
    "Read files first. Use edit.edits[].oldText and newText for edits.",
    "Do not use hashline metadata.",
    "Do not use write, shell redirection, or patch utilities.",
  ].join(" ");
}

function runTask(config: Config, task: Task, mode: Mode, run: number, stampDir: string): RunResult {
  const tempRoot = mkdtempSync(join(tmpdir(), "smart-edit-bench-" + mode + "-"));
  const workspace = join(tempRoot, "workspace");
  mkdirSync(workspace, { recursive: true });
  cpSync(join(task.dir, "input"), workspace, { recursive: true });

  const prompt = [
    task.prompt,
    "",
    "Make the requested change in the workspace. Do not modify unrelated text or files.",
    "When the edit is complete, stop.",
  ].join("\n");

  const args = [
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--model", config.model,
    "--thinking", "off",
    "--system-prompt", modePrompt(mode),
    "--mode", "json",
    "--tools", "read,edit",
    "-p", prompt,
  ];

  const started = performance.now();
  const child = spawnSync(PI_BIN, args, {
    cwd: workspace,
    env: {
      ...process.env,
      SMART_EDIT_USE_HASHLINE_EDITING: mode === "hashline" ? "1" : "0",
      SMART_EDIT_HASHLINE_EXPERIMENTAL: mode === "hashline" ? "1" : "0",
    },
    encoding: "utf8",
    ...(config.timeoutMs > 0 ? { timeout: config.timeoutMs } : {}),
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const durationMs = Math.round(performance.now() - started);
  const stdout = child.stdout ?? "";
  const stderr = child.stderr ?? "";
  const timedOut = child.error?.name === "ETIMEDOUT" || (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const metrics = parseJsonEvents(stdout, mode);
  const verification = verifyWorkspace(workspace, join(task.dir, "expected"));
  const protocolCompliancePct = metrics.editCalls === 0
    ? 0
    : Math.round((metrics.compliantEditCalls / metrics.editCalls) * 1000) / 10;

  const transcriptDir = join(stampDir, mode);
  mkdirSync(transcriptDir, { recursive: true });
  const transcript = join(transcriptDir, task.id + "-run" + String(run + 1) + ".jsonl");
  writeFileSync(transcript, stdout);
  writeFileSync(transcript.replace(/\.jsonl$/, ".stderr.txt"), stderr);

  const result: RunResult = {
    task: task.id,
    mode,
    run,
    success: verification.exact && child.status === 0 && !timedOut,
    exactMatch: verification.exact,
    exitCode: child.status,
    timedOut,
    durationMs,
    usage: metrics.usage,
    editCalls: metrics.editCalls,
    editErrors: metrics.editErrors,
    compliantEditCalls: metrics.compliantEditCalls,
    protocolCompliancePct,
    mismatches: verification.mismatches,
    transcript: relative(HERE, transcript),
    stderr: stderr.trim().slice(-4000),
  };

  if (config.keepWorkdirs) result.workdir = workspace;
  else rmSync(tempRoot, { recursive: true, force: true });
  return result;
}

function summarize(results: RunResult[], mode: Mode) {
  const rows = results.filter((r) => r.mode === mode);
  const sum = (fn: (r: RunResult) => number) => rows.reduce((n, r) => n + fn(r), 0);
  const success = rows.filter((r) => r.success).length;
  const exact = rows.filter((r) => r.exactMatch).length;
  const editCalls = sum((r) => r.editCalls);
  const compliant = sum((r) => r.compliantEditCalls);
  return {
    mode,
    success,
    total: rows.length,
    successRate: rows.length ? Math.round(success / rows.length * 1000) / 10 : 0,
    exactMatchRate: rows.length ? Math.round(exact / rows.length * 1000) / 10 : 0,
    avgDurationMs: rows.length ? Math.round(sum((r) => r.durationMs) / rows.length) : 0,
    tokens: {
      input: sum((r) => r.usage.input),
      output: sum((r) => r.usage.output),
      cacheRead: sum((r) => r.usage.cacheRead),
      cacheWrite: sum((r) => r.usage.cacheWrite),
      total: sum((r) => r.usage.total),
      reasoning: sum((r) => r.usage.reasoning),
      costUsd: Math.round(sum((r) => r.usage.costUsd) * 1_000_000) / 1_000_000,
    },
    editCalls,
    editErrors: sum((r) => r.editErrors),
    protocolCompliancePct: editCalls ? Math.round(compliant / editCalls * 1000) / 10 : 0,
    timeouts: rows.filter((r) => r.timedOut).length,
  };
}

const config = parseArgs();
const tasks = loadTasks(config.taskCount);
if (tasks.length === 0) throw new Error("No benchmark tasks found");
const modes: Mode[] = config.mode === "both" ? ["hashline", "normal"] : [config.mode];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const stampDir = join(RUN_ROOT, "agent-" + stamp + "-p" + String(process.pid));
mkdirSync(stampDir, { recursive: true });

console.log("SmartEdit agent benchmark: " + String(tasks.length) + " task(s) x " + String(config.runs) + " run(s) x " + modes.join(", "));
console.log("Model: " + config.model);
console.log("Pi: " + PI_BIN);

const results: RunResult[] = [];
for (let run = 0; run < config.runs; run++) {
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
    const task = tasks[taskIndex];
    const taskModes = modes.length === 2 && (run + taskIndex) % 2 === 1
      ? [...modes].reverse()
      : modes;
    for (const mode of taskModes) {
      process.stdout.write("[" + mode + "] run " + String(run + 1) + "/" + String(config.runs) + " " + task.id + " ... ");
      const result = runTask(config, task, mode, run, stampDir);
      results.push(result);
      console.log((result.success ? "PASS" : "FAIL") + " " + String(result.durationMs) + "ms edits=" + String(result.editCalls) + " errors=" + String(result.editErrors) + " compliance=" + String(result.protocolCompliancePct) + "%");
      if (result.mismatches.length) console.log("  " + result.mismatches.join("; "));
      if (result.stderr) console.log("  stderr: " + result.stderr.split(/\r?\n/).slice(-2).join(" | "));
    }
  }
}

const summary = Object.fromEntries(modes.map((mode) => [mode, summarize(results, mode)]));
const report = {
  generatedAt: new Date().toISOString(),
  config,
  piBin: PI_BIN,
  taskIds: tasks.map((t) => t.id),
  results,
  summary,
};
const reportPath = join(stampDir, "report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log("\nSummary");
for (const mode of modes) {
  const s = summary[mode] as ReturnType<typeof summarize>;
  console.log(mode.padEnd(8) + " " + String(s.success) + "/" + String(s.total) + " (" + String(s.successRate) + "%) exact=" + String(s.exactMatchRate) + "% edits=" + String(s.editCalls) + " editErrors=" + String(s.editErrors) + " compliance=" + String(s.protocolCompliancePct) + "% tokens=" + String(s.tokens.total) + " avg=" + String(s.avgDurationMs) + "ms");
}
console.log("Report: " + reportPath);
