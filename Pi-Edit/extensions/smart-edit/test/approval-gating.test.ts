import assert from "assert";
import { describe, it } from "node:test";

import {
  checkEditSafety,
  matchesDangerousPath,
  DANGEROUS_PATH_PATTERNS,
  DANGEROUS_SYMBOL_PATTERNS,
} from "../src/safety/approval-gating.js";
import type { ApprovalLevel, SafetyCheckResult } from "../src/safety/approval-gating.js";
import type { EditItem } from "../lib/types.js";

// ─── Helpers ───────────────────────────────────────────────────────────

function makeEdit(oldText?: string, newText?: string): EditItem {
  return { oldText: oldText ?? "", newText: newText ?? "" };
}

// ─── DANGEROUS_PATH_PATTERNS ──────────────────────────────────────────

describe("DANGEROUS_PATH_PATTERNS", () => {
  it("matches main.ts at any depth", () => {
    assert.strictEqual(matchesDangerousPath("src/main.ts"), "**/main.ts");
    assert.strictEqual(matchesDangerousPath("main.ts"), "**/main.ts");
    assert.strictEqual(matchesDangerousPath("foo/bar/main.ts"), "**/main.ts");
  });

  it("matches main.js at any depth", () => {
    assert.strictEqual(matchesDangerousPath("cli/main.js"), "**/main.js");
  });

  it("matches index.ts at any depth", () => {
    assert.strictEqual(matchesDangerousPath("src/index.ts"), "**/index.ts");
    assert.strictEqual(matchesDangerousPath("index.ts"), "**/index.ts");
  });

  it("matches index.js at any depth", () => {
    assert.strictEqual(matchesDangerousPath("api/index.js"), "**/index.js");
  });

  it("matches config files", () => {
    assert.strictEqual(matchesDangerousPath("config"), "**/config*");
    assert.strictEqual(matchesDangerousPath("src/config.ts"), "**/config*");
  });

  it("matches *config* files", () => {
    assert.strictEqual(matchesDangerousPath("eslint.config.js"), "**/*config*");
    assert.strictEqual(matchesDangerousPath("webpack.config.ts"), "**/*config*");
  });

  it("matches .env files", () => {
    assert.strictEqual(matchesDangerousPath(".env"), "**/.env*");
    assert.strictEqual(matchesDangerousPath(".env.production"), "**/.env.*");
  });

  it("matches __init__ files", () => {
    assert.strictEqual(matchesDangerousPath("src/__init__.py"), "**/__init__*");
    assert.strictEqual(matchesDangerousPath("__init__.py"), "**/__init__*");
  });

  it("matches Dockerfile", () => {
    assert.strictEqual(matchesDangerousPath("Dockerfile"), "**/Dockerfile*");
    assert.strictEqual(matchesDangerousPath("deploy/Dockerfile.prod"), "**/Dockerfile*");
  });

  it("matches CI configs", () => {
    assert.strictEqual(matchesDangerousPath(".github/workflows/test.yml"), "**/.github/**");
    assert.strictEqual(matchesDangerousPath(".gitlab-ci.yml"), "**/.gitlab-ci.yml");
  });

  it("matches YAML files", () => {
    assert.strictEqual(matchesDangerousPath("deploy.yaml"), "**/*.yaml");
    assert.strictEqual(matchesDangerousPath("values.yml"), "**/*.yml");
  });

  it("matches k8s/terraform/infra paths", () => {
    assert.strictEqual(matchesDangerousPath("k8s/deployment.yaml"), "**/k8s/**");
    assert.strictEqual(matchesDangerousPath("terraform/main.tf"), "**/terraform/**");
    assert.strictEqual(matchesDangerousPath("tf/variables.tf"), "**/tf/**");
  });

  it("does NOT match safe paths", () => {
    assert.strictEqual(matchesDangerousPath("src/service.ts"), null);
    assert.strictEqual(matchesDangerousPath("src/components/Button.tsx"), null);
    assert.strictEqual(matchesDangerousPath("README.md"), null);
    assert.strictEqual(matchesDangerousPath("test/fixtures/index.html"), null);
    assert.strictEqual(matchesDangerousPath("src/utils/helpers.ts"), null);
  });
});

// ─── DANGEROUS_SYMBOL_PATTERNS (approval-gating) ─────────────────────

describe("checkEditSafety — symbol patterns", () => {
  it("detects main() function in edits", () => {
    const result = checkEditSafety(
      "src/worker.ts",
      [makeEdit("function main() {", "function main() { console.log('start'); }")],
      { level: "prompt_on_dangerous" },
    );
    assert.ok(!result.safe);
    assert.ok(result.warnings.some((w) => w.includes("main() function")));
  });

  it("detects init() function in edits", () => {
    const result = checkEditSafety(
      "src/setup.ts",
      [makeEdit(), makeEdit("function init() {", "function init() { return true; }")],
      { level: "prompt_on_dangerous" },
    );
    assert.ok(!result.safe);
    assert.ok(result.warnings.some((w) => w.includes("init() function")));
  });

  it("detects process.env in edits", () => {
    const result = checkEditSafety(
      "config/db.ts",
      [makeEdit("process.env.DB_URL", "process.env.DB_URL_NEW")],
      { level: "prompt_on_dangerous" },
    );
    assert.ok(!result.safe);
    assert.ok(result.warnings.some((w) => w.includes("process.env")));
  });

  it("detects constructor method in edits", () => {
    const result = checkEditSafety(
      "src/service.ts",
      [makeEdit("constructor(name: string) {", "constructor(name: string, age: number) {")],
      { level: "prompt_on_dangerous" },
    );
    assert.ok(!result.safe);
    assert.ok(result.warnings.some((w) => w.includes("constructor")));
  });

  it("detects Python __init__ in edits", () => {
    const result = checkEditSafety(
      "src/models.py",
      [makeEdit("def __init__(self):", "def __init__(self, name: str):")],
      { level: "prompt_on_dangerous" },
    );
    assert.ok(!result.safe);
    assert.ok(result.warnings.some((w) => w.includes("__init__")));
  });

  it("detects child_process require in edits", () => {
    const result = checkEditSafety(
      "src/exec.ts",
      [makeEdit('const cp = require("child_process")', 'const { exec } = require("child_process")')],
      { level: "prompt_on_dangerous" },
    );
    assert.ok(!result.safe);
    assert.ok(result.warnings.some((w) => w.includes("child_process")));
  });

  it("detects fs.writeFile in edits", () => {
    const result = checkEditSafety(
      "src/fs.ts",
      [makeEdit("fs.writeFile", "fs.writeFileSync")],
      { level: "prompt_on_dangerous" },
    );
    assert.ok(!result.safe);
    assert.ok(result.warnings.some((w) => w.includes("writeFile")));
  });

  it("detects .listen() in edits", () => {
    const result = checkEditSafety(
      "src/server.ts",
      [makeEdit("app.listen(3000)", "app.listen(8080)")],
      { level: "prompt_on_dangerous" },
    );
    assert.ok(!result.safe);
    assert.ok(result.warnings.some((w) => w.includes("listen")));
  });

  it("detects route handlers in edits", () => {
    const result = checkEditSafety(
      "src/routes.ts",
      [makeEdit("router.get('/api/users', handler)", "router.use('/api/users', authMiddleware)")],
      { level: "prompt_on_dangerous" },
    );
    assert.ok(!result.safe);
    assert.ok(result.warnings.some((w) => w.includes("route")));
  });
});

// ─── Approval levels ─────────────────────────────────────────────────

describe("checkEditSafety — approval levels", () => {
  it("never_prompt returns safe with no warnings", () => {
    const result = checkEditSafety(
      "src/main.ts",
      [makeEdit("function main() {", "function main() { return 1; }")],
      { level: "never_prompt" },
    );
    assert.strictEqual(result.safe, true);
    assert.strictEqual(result.warnings.length, 0);
    assert.strictEqual(result.level, "never_prompt");
  });

  it("prompt_on_dangerous warns on dangerous path but safe edits", () => {
    const result = checkEditSafety(
      "src/main.ts",
      [makeEdit("hello", "world")],
      { level: "prompt_on_dangerous" },
    );
    assert.strictEqual(result.safe, false);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings.some((w) => w.includes("main.ts")));
  });

  it("prompt_on_dangerous is safe for safe path and safe edits", () => {
    const result = checkEditSafety(
      "src/service.ts",
      [makeEdit("hello", "world")],
      { level: "prompt_on_dangerous" },
    );
    assert.strictEqual(result.safe, true);
    assert.strictEqual(result.warnings.length, 0);
  });

  it("prompt_always emits warning even for safe edits", () => {
    const result = checkEditSafety(
      "src/service.ts",
      [makeEdit("hello", "world")],
      { level: "prompt_always" },
    );
    assert.strictEqual(result.safe, true); // safe because no dangerous patterns
    assert.ok(result.warnings.length > 0); // but still warns (prompt_always)
    assert.ok(result.warnings.some((w) => w.includes("no dangerous patterns")));
  });

  it("prompt_always also catches dangerous patterns", () => {
    const result = checkEditSafety(
      ".env",
      [makeEdit("API_KEY=old", "API_KEY=new")],
      { level: "prompt_always" },
    );
    assert.strictEqual(result.safe, false);
    assert.ok(result.warnings.length > 0);
  });
});

// ─── Empty / edge cases ─────────────────────────────────────────────

describe("checkEditSafety — edge cases", () => {
  it("handles empty edits array", () => {
    const result = checkEditSafety(
      "config/deploy.yml",
      [],
      { level: "prompt_on_dangerous" },
    );
    assert.strictEqual(result.safe, false); // path is dangerous
    assert.ok(result.warnings.some((w) => w.includes("deploy.yml")));
  });

  it("handles edits with no oldText/newText", () => {
    const result = checkEditSafety(
      "src/util.ts",
      [{ oldText: "", newText: "" }] as EditItem[],
      { level: "prompt_on_dangerous" },
    );
    assert.strictEqual(result.safe, true);
    assert.strictEqual(result.warnings.length, 0);
  });

  it("defaults to never_prompt when no config given", () => {
    // Without setting SMART_EDIT_APPROVAL_LEVEL, defaults to never_prompt
    const result = checkEditSafety("src/main.ts", [makeEdit("function main()", "function main() {}")]);
    assert.strictEqual(result.safe, true);
    assert.strictEqual(result.warnings.length, 0);
    assert.strictEqual(result.level, "never_prompt");
  });

  it("combines path warning and symbol warning", () => {
    const result = checkEditSafety(
      "src/main.ts",
      [makeEdit("function main() {", "function main() { return 0; }")],
      { level: "prompt_on_dangerous" },
    );
    // Both path and symbol matched
    const pathWarnings = result.warnings.filter((w) => w.includes("main.ts"));
    const symbolWarnings = result.warnings.filter((w) => w.includes("main() function"));
    assert.ok(pathWarnings.length > 0, "expected path warning");
    assert.ok(symbolWarnings.length > 0, "expected symbol warning");
  });

  it("deduplicates same symbol across edits", () => {
    const result = checkEditSafety(
      "src/service.ts",
      [
        makeEdit("function main() { return 1; }", "function main() { return 2; }"),
        makeEdit("function main() { return 3; }", "function main() { return 4; }"),
      ],
      { level: "prompt_on_dangerous" },
    );
    // "main() function" should appear only once in warnings
    const mainWarnings = result.warnings.filter((w) => w.includes("main() function"));
    assert.strictEqual(mainWarnings.length, 1, "pattern should be deduplicated");
  });
});
