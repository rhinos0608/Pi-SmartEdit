import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEslintJsonOutput,
  checkEslintDiagnostics,
} from "../src/lsp/eslint-runner.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function installFakeEslint(
  dir: string,
  stdout: string,
  exitCode = 0,
): void {
  const binDir = join(dir, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, "eslint");
  const shell =
    process.platform === "win32"
      ? `@echo off\n${stdout}\nexit /b ${exitCode}\n`
      : `#!/bin/sh\nprintf '%s' ${shellEscape(stdout)}\nexit ${exitCode}\n`;
  writeFileSync(script, shell, "utf-8");
  chmodSync(script, 0o755);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeEslintConfig(dir: string): void {
  writeFileSync(join(dir, ".eslintrc.json"), "{}", "utf-8");
}

describe("eslint-runner", () => {
  describe("parseEslintJsonOutput", () => {
    it("parses realistic ESLint JSON fixture", () => {
      const targetPath = "/project/src/widget.ts";
      const output = JSON.stringify([
        {
          filePath: targetPath,
          messages: [
            {
              ruleId: "no-unused-vars",
              severity: 2,
              message: "'foo' is defined but never used.",
              line: 5,
              column: 10,
              endLine: 5,
              endColumn: 13,
            },
            {
              ruleId: "no-console",
              severity: 1,
              message: "Unexpected console statement.",
              line: 2,
              column: 3,
            },
            {
              ruleId: null,
              severity: 2,
              message: "Parsing error: Unexpected token",
              line: 1,
              column: 1,
            },
          ],
        },
      ]);

      const diagnostics = parseEslintJsonOutput(output, targetPath);

      assert.strictEqual(diagnostics.length, 3);

      const error = diagnostics[0];
      assert.strictEqual(error.severity, 1);
      assert.strictEqual(error.source, "eslint");
      assert.strictEqual(error.filePath, targetPath);
      assert.strictEqual(error.message, "[no-unused-vars] 'foo' is defined but never used.");
      assert.strictEqual(error.range.start.line, 4);
      assert.strictEqual(error.range.start.character, 9);
      assert.strictEqual(error.range.end.line, 4);
      assert.strictEqual(error.range.end.character, 12);

      const warning = diagnostics[1];
      assert.strictEqual(warning.severity, 2);
      assert.strictEqual(warning.message, "[no-console] Unexpected console statement.");
      assert.strictEqual(warning.range.start.line, 1);
      assert.strictEqual(warning.range.start.character, 2);
      assert.strictEqual(warning.range.end.line, 1);
      assert.strictEqual(warning.range.end.character, 2);

      const noRule = diagnostics[2];
      assert.strictEqual(noRule.severity, 1);
      assert.strictEqual(noRule.message, "Parsing error: Unexpected token");
      assert.strictEqual(noRule.range.start.line, 0);
      assert.strictEqual(noRule.range.start.character, 0);
    });

    it("returns empty array for invalid JSON", () => {
      const diagnostics = parseEslintJsonOutput("not json", "/project/file.ts");
      assert.strictEqual(diagnostics.length, 0);
    });

    it("ignores diagnostics for unrelated files", () => {
      const output = JSON.stringify([
        {
          filePath: "/project/other.ts",
          messages: [
            {
              ruleId: "no-unused-vars",
              severity: 2,
              message: "unused",
              line: 1,
              column: 1,
            },
          ],
        },
      ]);

      const diagnostics = parseEslintJsonOutput(
        output,
        "/project/target.ts",
      );
      assert.strictEqual(diagnostics.length, 0);
    });
  });

  describe("checkEslintDiagnostics", () => {
    let tempDirs: string[] = [];

    beforeEach(() => {
      tempDirs = [];
    });

    afterEach(() => {
      for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns empty result when no ESLint config exists", async () => {
      const dir = makeTempDir("smart-edit-eslint-no-config-");
      tempDirs.push(dir);
      const filePath = join(dir, "src", "app.ts");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(filePath, "const x = 1;\n", "utf-8");

      const result = await checkEslintDiagnostics(filePath, dir);

      assert.deepStrictEqual(result, { diagnostics: [], source: "none" });
    });

    it("handles malformed/non-JSON spawn output without throwing", async () => {
      const dir = makeTempDir("smart-edit-eslint-bad-output-");
      tempDirs.push(dir);
      writeEslintConfig(dir);
      installFakeEslint(dir, "not json", 1);

      const filePath = join(dir, "app.ts");
      writeFileSync(filePath, "const x = 1;\n", "utf-8");

      const result = await checkEslintDiagnostics(filePath, dir);

      assert.ok(result);
      assert.strictEqual(result.diagnostics.length, 0);
      assert.strictEqual(result.source, "none");
    });

    it("finds config in cwd when file directory has none", async () => {
      const fileDir = makeTempDir("smart-edit-eslint-file-");
      const configDir = makeTempDir("smart-edit-eslint-cwd-");
      tempDirs.push(fileDir, configDir);

      writeEslintConfig(configDir);
      installFakeEslint(
        configDir,
        JSON.stringify([
          {
            filePath: join(fileDir, "app.ts"),
            messages: [
              {
                ruleId: "semi",
                severity: 2,
                message: "Missing semicolon.",
                line: 1,
                column: 1,
              },
            ],
          },
        ]),
        0,
      );

      const filePath = join(fileDir, "app.ts");
      writeFileSync(filePath, "const x = 1\n", "utf-8");

      const result = await checkEslintDiagnostics(filePath, configDir);

      assert.strictEqual(result.source, "eslint");
      assert.strictEqual(result.diagnostics.length, 1);
      assert.strictEqual(result.diagnostics[0].severity, 1);
      assert.strictEqual(result.diagnostics[0].message, "[semi] Missing semicolon.");
    });

    it("returns source 'none' when ESLint reports a clean file", async () => {
      const dir = makeTempDir("smart-edit-eslint-clean-");
      tempDirs.push(dir);
      writeEslintConfig(dir);
      installFakeEslint(
        dir,
        JSON.stringify([
          {
            filePath: join(dir, "app.ts"),
            messages: [],
          },
        ]),
        0,
      );

      const filePath = join(dir, "app.ts");
      writeFileSync(filePath, "const x = 1;\n", "utf-8");

      const result = await checkEslintDiagnostics(filePath, dir);

      assert.strictEqual(result.source, "none");
      assert.strictEqual(result.diagnostics.length, 0);
    });
  });
});
