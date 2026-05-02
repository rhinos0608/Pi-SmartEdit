import { describe, it } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { retrieveHistory } from "../../src/verification/history-context.js";
import { defaultHistoryConfig } from "../../src/verification/config.js";
import type { ChangedTarget } from "../../src/verification/types.js";

function makeTarget(name: string, overrides?: Partial<ChangedTarget>): ChangedTarget {
  return {
    path: "",
    languageId: "typescript",
    kind: "function",
    name,
    lineRange: { startLine: 1, endLine: 10 },
    byteRange: { startIndex: 0, endIndex: 100 },
    editKind: "logic",
    concurrencySignals: [],
    ...overrides,
  };
}

function createGitRepo(dir: string, files: Record<string, string>, commits: Array<{ msg: string; file: string; append?: string }>): void {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name test", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });

  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }

  const committed = new Set<string>();
  for (const c of commits) {
    const fullPath = join(dir, c.file);
    if (committed.has(c.file)) {
      // Append to create a distinct change
      const existing = readFileSync(fullPath, "utf-8");
      writeFileSync(fullPath, existing + "\n// " + (c.append ?? c.msg), "utf-8");
    } else {
      committed.add(c.file);
    }
    const { spawnSync } = await import("node:child_process");
    execSync(`git add -A`, { cwd: dir, stdio: "pipe" });
    spawnSync("git", ["commit", "-m", c.msg], { cwd: dir, stdio: "pipe" });
  }
}

describe("history-context", () => {
  describe("retrieveHistory", () => {
    it("returns empty array when history is disabled", async () => {
      const result = await retrieveHistory({
        cwd: "/tmp",
        changedTargets: [makeTarget("foo")],
        config: { ...defaultHistoryConfig(), enabled: false },
      });
      assert.strictEqual(result.length, 0);
    });

    it("returns empty array for non-git directory", async () => {
      const { rmSync } = await import("node:fs");
      const noGitDir = mkdtempSync(join(tmpdir(), "no-git-"));
      try {
        const target = makeTarget("testFn", { path: join(noGitDir, "test.ts") });
        const result = await retrieveHistory({
          cwd: noGitDir,
          changedTargets: [target],
          config: defaultHistoryConfig(),
        });
        assert.strictEqual(result.length, 0);
      } finally {
        rmSync(noGitDir, { recursive: true, force: true });
      }
    });

    it("returns commits for a function in a git repo", async () => {
      const repoDir = mkdtempSync(join(tmpdir(), "hist-test-"));
      try {
        createGitRepo(repoDir, {
          "src/app.ts": `function existingFn() { return 1; }`,
        }, [
          { msg: "initial commit", file: "src/app.ts" },
        ]);

        const target = makeTarget("existingFn", {
          path: join(repoDir, "src", "app.ts"),
          lineRange: { startLine: 1, endLine: 1 },
          byteRange: { startIndex: 0, endIndex: 50 },
        });

        const result = await retrieveHistory({
          cwd: repoDir,
          changedTargets: [target],
          content: `function existingFn() { return 1; }`,
          config: defaultHistoryConfig(),
        });

        const entry = result.find((h) => h.target.name === "existingFn");
        assert.ok(entry, "Expected history entry for existingFn");
        assert.ok(entry.commits.length >= 1, `Expected at least 1 commit, got ${entry.commits.length}`);
        const subjects = entry.commits.map((c) => c.subject);
        assert.ok(subjects.some((s) => s.includes("initial")), `Expected "initial" in subjects: [${subjects}]`);
      } finally {
        execSync(`rm -rf "${repoDir}"`, { stdio: "pipe" });
      }
    });

    it("ranks risky commits higher", async () => {
      const repoDir = mkdtempSync(join(tmpdir(), "hist-rank-"));
      try {
        createGitRepo(repoDir, {
          "src/app.ts": `function riskyFn() { return 1; }`,
        }, [
          { msg: "fix race condition in riskyFn", file: "src/app.ts" },
          { msg: "refactor riskyFn", file: "src/app.ts" },
        ]);

        const target = makeTarget("riskyFn", {
          path: join(repoDir, "src", "app.ts"),
          byteRange: { startIndex: 0, endIndex: 50 },
        });

        const result = await retrieveHistory({
          cwd: repoDir,
          changedTargets: [target],
          content: `function riskyFn() { return 1; }`,
          config: defaultHistoryConfig(),
        });

        const entry = result.find((h) => h.target.name === "riskyFn");
        assert.ok(entry, "Expected history entry for riskyFn");
        assert.ok(entry.commits.length >= 1);

        // At least one commit should be tagged as risky if the keyword matched
        const riskyCount = entry.commits.filter((c) => c.reason === "risky").length;
        assert.ok(riskyCount > 0, `Expected at least 1 risky commit, got ${riskyCount}`);
      } finally {
        execSync(`rm -rf "${repoDir}"`, { stdio: "pipe" });
      }
    });

    it("extracts nearby comments from source", async () => {
      const repoDir = mkdtempSync(join(tmpdir(), "hist-comment-"));
      try {
        createGitRepo(repoDir, {
          "src/app.ts": `// This is a critical section
// Do not change this without testing
function criticalFn() { return 1; }`,
        }, [
          { msg: "initial", file: "src/app.ts" },
        ]);

        const target = makeTarget("criticalFn", {
          path: join(repoDir, "src", "app.ts"),
          byteRange: { startIndex: 56, endIndex: 100 },
        });

        const result = await retrieveHistory({
          cwd: repoDir,
          changedTargets: [target],
          content: `// This is a critical section\n// Do not change this without testing\nfunction criticalFn() { return 1; }`,
          config: defaultHistoryConfig(),
        });

        const entry = result.find((h) => h.target.name === "criticalFn");
        assert.ok(entry, "Expected history entry for criticalFn");
        assert.ok(entry.nearbyComments.length > 0, "Expected nearby comments to be extracted");
      } finally {
        execSync(`rm -rf "${repoDir}"`, { stdio: "pipe" });
      }
    });

    it("handles empty changed targets array", async () => {
      const result = await retrieveHistory({
        cwd: "/tmp",
        changedTargets: [],
        config: { ...defaultHistoryConfig(), enabled: true },
      });
      assert.strictEqual(result.length, 0);
    });
  });
});
