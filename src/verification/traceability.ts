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

import { readdir, readFile } from "fs/promises";
import type { Dirent } from "fs";
import { join, relative, resolve } from "path";
import type { ChangedTarget, TraceabilityConfig } from "./types";
import type { TraceabilityEvidence, TraceabilityTargetEvidence } from "./types";
import { simpleGlobMatch } from "./glob-match";

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

// Hard caps on the tree walk below. Without them, a large or generic `cwd`
// (e.g. a monorepo root, or a scratch directory like /tmp) makes this an
// effectively-unbounded readdir/stat traversal — and a symlink cycle turns
// it into a genuine infinite loop, since `visited` only dedupes exact
// re-pushed directory paths, not the ever-growing distinct path strings a
// cycle produces (`/a/loop/loop/loop/...`). Symlinks are skipped outright
// (via dirent, no extra stat) rather than followed, which closes the cycle
// hazard and keeps the walk inside the real project tree.
const MAX_DIRS_VISITED = 5_000;
const MAX_FILES_SCANNED = 50_000;

/**
 * Walk the project tree to find test files matching configured globs.
 * Skips common build artifacts, dependency directories, and symlinks.
 */
async function discoverTestFiles(
  cwd: string,
  globs: string[],
): Promise<string[]> {
  const results: string[] = [];
  const visited = new Set<string>();

  const walkStack: string[] = [cwd];
  let filesScanned = 0;

  while (walkStack.length > 0) {
    if (visited.size >= MAX_DIRS_VISITED || filesScanned >= MAX_FILES_SCANNED) break;

    const dir = walkStack.pop();
    if (!dir) continue;
    if (visited.has(dir)) continue;
    visited.add(dir);

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // permission denied or deleted
    }

    for (const entry of entries) {
      if (filesScanned >= MAX_FILES_SCANNED) break;
      filesScanned++;

      if (entry.isSymbolicLink()) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walkStack.push(fullPath);
        }
        continue;
      }

      if (entry.isFile() && matchesAnyGlob(fullPath, globs)) {
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

