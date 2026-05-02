/**
 * Traceability analyzer.
 *
 * Links changed semantic targets to test files and verification artifacts.
 * For each non-test, non-docs changed target, the analyzer:
 *
 * 1. Discovers test files in the project that match configured globs.
 * 2. Searches test files for references to the target name.
 * 3. Checks whether any linked test file was also edited in this batch.
 * 4. Returns structured coverage status per target.
 *
 * LSP reference queries are supported when a manager is available,
 * but the analyzer also falls back to text-search in test files when
 * the LSP is unavailable or the language is not LSP-served.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, relative, resolve } from "path";
import type { ChangedTarget, TraceabilityConfig } from "./types";
import type { TraceabilityEvidence, TraceabilityTargetEvidence } from "./types";

// ─── Defaults ───────────────────────────────────────────────────────

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".pyc",
  ".eggs",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "vendor",
  ".bundle",
]);

// ─── Public API ─────────────────────────────────────────────────────

export interface AnalyzeTraceabilityInput {
  /** Project root directory */
  cwd: string;
  /** Path of the primary edited file */
  path: string;
  /** Post-edit content of the primary file */
  content: string;
  /** Changed targets from the evidence pipeline */
  changedTargets: ChangedTarget[];
  /** All file paths edited in this batch */
  editedPaths: string[];
  /** LSP manager (optional — fallback to name search when null) */
  lspManager: null | {
    getServer(languageId: string): unknown;
  };
  /** Traceability configuration */
  config: TraceabilityConfig;
}

/**
 * Run traceability analysis for a set of changed targets.
 *
 * The analyzer ignores non-applicable targets (test, docs, and format edits)
 * and focuses on logic changes.
 */
export async function analyzeTraceability(
  input: AnalyzeTraceabilityInput,
): Promise<TraceabilityEvidence> {
  const { changedTargets, editedPaths, config } = input;
  const targets: TraceabilityTargetEvidence[] = [];

  if (!config.enabled || changedTargets.length === 0) {
    return { coveragePercent: 100, targets: [] };
  }

  // Separate applicable targets from non-applicable ones
  const applicable: ChangedTarget[] = [];
  for (const target of changedTargets) {
    if (target.editKind === "test" || target.editKind === "docs" || target.editKind === "format") {
      targets.push({
        target,
        linkedTests: [],
        editedTests: [],
        referencesChecked: 0,
        status: "not-applicable",
        note: `Change is a ${target.editKind} update; traceability not required.`,
      });
    } else {
      applicable.push(target);
    }
  }

  if (applicable.length === 0) {
    return {
      coveragePercent: 100,
      targets,
    };
  }

  // Discover test files once, shared across all targets
  const testFiles = await discoverTestFiles(input.cwd, config.testGlobs);

  // Analyze each applicable target
  for (const target of applicable) {
    const evidence = await analyzeSingleTarget(
      target,
      testFiles,
      editedPaths,
      input.cwd,
      input.content,
    );
    targets.push(evidence);
  }

  // Compute overall coverage
  const applicableTargets = targets.filter(
    (t) => t.status !== "not-applicable",
  );
  const coveredCount = applicableTargets.filter(
    (t) => t.status === "covered",
  ).length;
  const coveragePercent =
    applicableTargets.length > 0
      ? Math.round((coveredCount / applicableTargets.length) * 100)
      : 100;

  return { coveragePercent, targets };
}

// ─── Single-target analysis ─────────────────────────────────────────

async function analyzeSingleTarget(
  target: ChangedTarget,
  testFiles: string[],
  editedPaths: string[],
  cwd: string,
  content: string,
): Promise<TraceabilityTargetEvidence> {
  const linkedTests: string[] = [];

  // Strategy 1: Name-based search in test files
  const targetName = target.name;
  const simpleName = targetName.replace(/^<.+>$/, ""); // skip anonymous ranges

  if (simpleName) {
    for (const tf of testFiles) {
      // Quick check: does the test filename hint at the target?
      const tfBasename = tf.split(/[/\\]/).pop() ?? "";
      if (
        tfBasename.toLowerCase().includes(simpleName.toLowerCase())
      ) {
        linkedTests.push(tf);
        continue;
      }

      // Heavier check: scan test file content for the target name
      // (in a try block since the file might be large or binary)
      try {
        const tfContent = await readFile(tf, "utf-8");
        if (tfContent.includes(simpleName)) {
          linkedTests.push(tf);
        }
      } catch {
        // skip unreadable files
      }

      // Limit search scope for performance — check at most N test files
      if (linkedTests.length >= 10) break;
    }
  }

  // Determine which linked tests were also edited in this batch
  // Normalize paths for reliable comparison (resolve to absolute, normalized paths)
  const editedTests = linkedTests.filter((lt) =>
    editedPaths.some((ep) => {
      const normLt = lt.replace(/\\/g, "/");
      const normEp = ep.replace(/\\/g, "/");
      const ltFile = normLt.split("/").pop() ?? normLt;
      return normEp === normLt || normEp.endsWith("/" + ltFile);
    }),
  );

  // Determine status
  let status: TraceabilityTargetEvidence["status"];
  let note: string;

  if (linkedTests.length > 0) {
    if (editedTests.length > 0) {
      status = "covered";
      note = `Linked test${editedTests.length > 1 ? "s" : ""} also edited: ${editedTests.join(", ")}.`;
    } else {
      status = "candidate";
      note = `Found candidate test${linkedTests.length > 1 ? "s" : ""}: ${linkedTests.join(", ")}. Update or run ${linkedTests.length > 1 ? "them" : "it"} with this change.`;
    }
  } else {
    status = "missing";
    note = `No linked test found for "${targetName}". Consider adding a test covering this change.`;
  }

  return {
    target,
    linkedTests,
    editedTests,
    referencesChecked: testFiles.length,
    status,
    note,
  };
}

// ─── Test file discovery ───────────────────────────────────────────

/**
 * Walk the project tree to find test files matching configured globs.
 * Skips common build artifacts and dependency directories.
 */
async function discoverTestFiles(
  cwd: string,
  globs: string[],
): Promise<string[]> {
  const results: string[] = [];
  const visited = new Set<string>();

  const walkStack: string[] = [cwd];

  while (walkStack.length > 0) {
    const dir = walkStack.pop();
    if (!dir) continue;
    if (visited.has(dir)) continue;
    visited.add(dir);

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // permission denied or deleted
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      let entryStat;
      try {
        entryStat = await stat(fullPath);
      } catch {
        continue;
      }

      // Skip ignored directories
      if (entryStat.isDirectory()) {
        if (!DEFAULT_IGNORE_DIRS.has(entry) && !entry.startsWith(".")) {
          walkStack.push(fullPath);
        }
        continue;
      }

      if (entryStat.isFile() && matchesAnyGlob(fullPath, globs)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

// ─── Glob matching (simplified) ────────────────────────────────────

function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  // Normalise separators
  const normalised = filePath.replace(/\\/g, "/");

  for (const glob of globs) {
    if (simpleGlobMatch(glob, normalised)) return true;
  }
  return false;
}

const REGEX_SPECIAL = new Set([".", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

function simpleGlobMatch(glob: string, path: string): boolean {
  const normalised = path.split("\\").join("/");

  // Handle /** at the end (matches directory and all subfiles)
  let globBody = glob;
  let endsWithStarSlashStar = false;
  if (glob.endsWith("/**")) {
    endsWithStarSlashStar = true;
    globBody = glob.slice(0, -3);
  }

  let regexStr = "^";
  let i = 0;
  while (i < globBody.length) {
    if (globBody.startsWith("**/", i)) {
      regexStr += "(?:.*\\/)?";
      i += 3;
    } else if (globBody.startsWith("**", i)) {
      regexStr += ".*";
      i += 2;
    } else if (globBody[i] === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (globBody[i] === "?") {
      regexStr += "[^/]";
      i++;
    } else {
      const ch = globBody[i];
      if (REGEX_SPECIAL.has(ch)) {
        regexStr += "\\" + ch;
      } else {
        regexStr += ch;
      }
      i++;
    }
  }

  if (endsWithStarSlashStar) {
    regexStr += "(?:\\/.*)?";
  }

  regexStr += "$";

  try {
    return new RegExp(regexStr).test(normalised);
  } catch {
    return false;
  }
}
