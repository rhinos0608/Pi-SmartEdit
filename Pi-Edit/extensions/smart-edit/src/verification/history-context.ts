/**
 * Historical context retriever.
 *
 * Fetches targeted Git history for each changed symbol or line range,
 * ranks commits by recency and maintenance-relevant keywords, and
 * returns a small, bounded evidence packet.
 *
 * Silently skips when the project is not a Git repository or when
 * the target has no relevant history.
 *
 * Design constraints:
 * - No network fetches (local refs only).
 * - No full diffs.
 * - Aggressive truncation to keep output bounded.
 * - Uses spawn (no shell: true) for Git commands.
 */

import { spawn } from "child_process";
import { join } from "path";
import type { ChangedTarget, HistoryConfig } from "./types";
import type { HistoryEvidence } from "./types";

// ─── Risky keywords for commit ranking ──────────────────────────────

const RISKY_KEYWORDS = [
  "race",
  "deadlock",
  "flaky",
  "regression",
  "security",
  "revert",
  "revert",
  "workaround",
  "compat",
  "avoid",
  "do not",
  "fix",
  "hotfix",
  "bug",
  "crash",
  "segfault",
  "nullpointer",
  "undefined",
  "timeout",
  "hang",
  "leak",
  "corrupt",
  "vuln",
  "cve",
];

const RISKY_PATTERN = new RegExp(
  `\\b(${RISKY_KEYWORDS.join("|")})\\b`,
  "i",
);

// ─── Public API ─────────────────────────────────────────────────────

export interface RetrieveHistoryInput {
  /** Project root directory */
  cwd: string;
  /** Changed targets from the evidence pipeline */
  changedTargets: ChangedTarget[];
  /** Post-edit file content (for comment extraction) */
  content?: string;
  /** History configuration */
  config: HistoryConfig;
}

/**
 * Retrieve historical context for each changed target.
 */
export async function retrieveHistory(
  input: RetrieveHistoryInput,
): Promise<HistoryEvidence[]> {
  const { changedTargets, config } = input;
  if (!config.enabled || changedTargets.length === 0) {
    return [];
  }

  // Quick check: is this a git repository?
  const gitDir = await findGitRoot(input.cwd);
  if (!gitDir) {
    return [];
  }

  const results: HistoryEvidence[] = [];

  for (const target of changedTargets) {
    const evidence = await retrieveHistoryForTarget(
      target,
      gitDir,
      input.content ?? "",
      config,
    );
    if (evidence) {
      results.push(evidence);
    }
  }

  return results;
}

// ─── Per-target retrieval ──────────────────────────────────────────

async function retrieveHistoryForTarget(
  target: ChangedTarget,
  gitDir: string,
  content: string,
  config: HistoryConfig,
): Promise<HistoryEvidence | null> {
  const maxCommits = config.maxCommits;
  const maxChars = config.maxChars;

  // Try three strategies in order:
  // 1. git log -L :<symbol>:<path> — best if the symbol name is meaningful
  // 2. git log -L <start>,<end>:<path> — line-range based
  // 3. git log -- <path> — fallback per-file

  let logOutput = "";

  // Strategy 1: symbol-based log
  if (
    target.kind !== "unknown" &&
    target.name &&
    !target.name.startsWith("<")
  ) {
    logOutput = await runGitLog(
      gitDir,
      ["-L", `:${escapeGitPath(target.name)}:${escapeGitPath(target.path)}`],
      maxCommits,
    );
  }

  // Strategy 2: line-range log
  if (!logOutput.trim()) {
    logOutput = await runGitLog(
      gitDir,
      ["-L", `${target.lineRange.startLine},${target.lineRange.endLine}:${escapeGitPath(target.path)}`],
      maxCommits,
    );
  }

  // Strategy 3: file-level log
  if (!logOutput.trim()) {
    logOutput = await runGitLog(
      gitDir,
      ["--", target.path],
      maxCommits,
    );
  }

  // Parse commits from log output
  const commits = parseGitLogOutput(logOutput, maxChars);

  // Apply ranking: risky keywords first, then recency
  const ranked = rankCommits(commits, maxCommits);

  // Extract nearby comments from the content at the target range
  const nearbyComments = extractNearbyComments(
    content,
    target.byteRange.startIndex,
    target.byteRange.endIndex,
  );

  // Build note
  let note: string;
  if (ranked.length === 0) {
    note = `No relevant history found for "${target.name}".`;
  } else {
    const riskyCount = ranked.filter((c) => c.reason === "risky").length;
    const parts: string[] = [
      `Found ${ranked.length} relevant commit${ranked.length > 1 ? "s" : ""}`,
    ];
    if (riskyCount > 0) {
      parts.push(`(${riskyCount} maintenance-related)`);
    }
    note = parts.join(" ");
  }

  return {
    target,
    commits: ranked,
    nearbyComments,
    note,
  };
}

// ─── Git helpers ────────────────────────────────────────────────────

/**
 * Check if cwd is a Git repository and return its root directory.
 */
async function findGitRoot(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });

    let stdout = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        resolve(null);
      }
    });

    child.on("error", () => resolve(null));
  });
}

/**
 * Run a bounded git log command and return raw output.
 */
async function runGitLog(
  gitDir: string,
  args: string[],
  maxCount: number,
): Promise<string> {
  const fullArgs = [
    "log",
    `--max-count=${maxCount}`,
    "--format=%H|%ai|%an|%s",
    ...args,
  ];

  return new Promise((resolve) => {
    const child = spawn("git", fullArgs, {
      cwd: gitDir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10_000);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) resolve("");
      else resolve(stdout);
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

// ─── Output parsing ────────────────────────────────────────────────

interface ParsedCommit {
  hash: string;
  date: string;
  author: string;
  subject: string;
  reason: "exact" | "risky" | "recent";
  score: number;
}

/**
 * Parse git log --format=%H|%ai|%an|%s output.
 */
function parseGitLogOutput(
  raw: string,
  maxChars: number,
): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let accumulated = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split("|");
    if (parts.length < 4) {
      // Git output may be truncated; skip malformed lines
      continue;
    }

    const hash = parts[0].trim();
    const date = parts[1].trim();
    const author = parts[2].trim();
    const subject = parts.slice(3).join("|").trim();

    // Truncate output to maxChars
    const entrySize = subject.length;
    if (accumulated + entrySize > maxChars) break;
    accumulated += entrySize;

    commits.push({
      hash,
      date,
      author,
      subject,
      reason: "recent",
      score: 0,
    });
  }

  return commits;
}

/**
 * Rank commits: assign scores and sort by risk + recency.
 * Returns top-N results.
 */
function rankCommits(
  commits: ParsedCommit[],
  maxResults: number,
): HistoryEvidence["commits"] {
  // Score each commit
  for (const c of commits) {
    if (RISKY_PATTERN.test(c.subject)) {
      c.reason = "risky";
      c.score = 100;
    } else {
      c.score = 50;
    }

    // Boost recency: more recent = higher score
    // Simple proxy: first in list is most recent in git log output
    // The index-based boost gives recent commits priority within same risk level
  }

  // Sort by score descending, then by position in original list (recency)
  commits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return 0; // preserve original git log order for same-score items
  });

  return commits.slice(0, maxResults).map((c) => ({
    hash: c.hash,
    date: c.date,
    subject: c.subject,
    author: c.author,
    reason: c.reason,
  }));
}

// ─── Comment extraction ────────────────────────────────────────────

/**
 * Extract nearby single-line comments within the target range.
 * Supports: //, #, --, ; and multi-line block-comment style.
 */
function extractNearbyComments(
  content: string,
  startByte: number,
  endByte: number,
): string[] {
  const comments: string[] = [];

  // Define a 25-line window around the range
  const startLine = byteOffsetToLine(content, startByte);
  const endLine = byteOffsetToLine(content, endByte);
  const windowStartLine = Math.max(1, startLine - 5);
  const windowEndLine = endLine + 5;

  const lines = content.split("\n");

  for (
    let lineNum = windowStartLine;
    lineNum <= windowEndLine && lineNum <= lines.length;
    lineNum++
  ) {
    const line = lines[lineNum - 1];

    // Line comments — skip matches inside string literals
    const slashIdx = line.indexOf("//");
    const hashIdx = line.indexOf("#");
    const dashIdx = line.indexOf("--");
    const semiIdx = line.indexOf(";");

    let bestIdx = -1;
    let bestPrefix = "";

    // Find the earliest comment marker not inside a string literal
    const candidates: Array<{ idx: number; prefix: string }> = [];
    if (slashIdx >= 0) candidates.push({ idx: slashIdx, prefix: "" });
    if (hashIdx >= 0) candidates.push({ idx: hashIdx, prefix: "" });
    if (dashIdx >= 0) candidates.push({ idx: dashIdx, prefix: "" });
    if (semiIdx >= 0) candidates.push({ idx: semiIdx, prefix: "" });

    candidates.sort((a, b) => a.idx - b.idx);

    for (const c of candidates) {
      // Count unescaped quotes before the comment marker
      const before = line.slice(0, c.idx);
      const doubleQuotes = (before.match(/(?<!\\)"/g) || []).length;
      const singleQuotes = (before.match(/(?<!\\)'/g) || []).length;
      if (doubleQuotes % 2 === 0 && singleQuotes % 2 === 0) {
        bestIdx = c.idx;
        break;
      }
    }

    if (bestIdx >= 0) {
      let commentText: string;
      if (line[bestIdx] === '/' && line[bestIdx + 1] === '/') {
        commentText = line.slice(bestIdx + 2).trim();
      } else if (line[bestIdx] === '#') {
        commentText = line.slice(bestIdx + 1).trim();
      } else if (line[bestIdx] === '-' && line[bestIdx + 1] === '-') {
        commentText = line.slice(bestIdx + 2).trim();
      } else {
        commentText = line.slice(bestIdx + 1).trim();
      }
      if (commentText) {
        comments.push(commentText);
      }
    }
  }

  return comments;
}

/**
 * Compute 1-based line number for a byte offset.
 * Operates on actual UTF-8 bytes.
 */
function byteOffsetToLine(content: string, offset: number): number {
  if (offset <= 0) return 1;

  const buffer = Buffer.from(content, "utf8");
  const maxOffset = Math.min(offset, buffer.length);

  let line = 1;
  for (let i = 0; i < maxOffset; i++) {
    if (buffer[i] === 0x0A) { // '\n' in UTF-8
      line++;
    }
  }
  return line;
}

/**
 * Escape a symbol name for use in `git log -L :<funcname>:<file>`.
 */
function escapeGitPath(name: string): string {
  // Git uses regex for function name matching; escape special chars
  return name.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}
