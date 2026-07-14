import { dirname, resolve } from "path";
import type { Diagnostic, DiagnosticResult } from "./diagnostic-dispatcher.js";
import {
  appendBounded,
  findAncestorDirWithFile,
  safeSpawnAsync,
} from "./spawn-utils.js";

const ESLINT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".eslintrc",
];

async function findEslintConfigDir(
  filePath: string,
  cwd: string,
): Promise<string | null> {
  const fileDir = dirname(filePath);

  for (const configName of ESLINT_CONFIG_FILES) {
    const dir = await findAncestorDirWithFile(fileDir, configName);
    if (dir) return dir;
  }

  for (const configName of ESLINT_CONFIG_FILES) {
    const dir = await findAncestorDirWithFile(cwd, configName);
    if (dir) return dir;
  }

  return null;
}

interface EslintMessage {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

export function parseEslintJsonOutput(
  output: string,
  targetPath: string,
): Diagnostic[] {
  let parsed: EslintFileResult[];
  try {
    parsed = JSON.parse(output) as EslintFileResult[];
    if (!Array.isArray(parsed)) return [];
  } catch {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const target = resolve(targetPath);

  for (const file of parsed) {
    if (resolve(file.filePath) !== target) continue;

    for (const msg of file.messages) {
      const line = Math.max((msg.line ?? 1) - 1, 0);
      const character = Math.max((msg.column ?? 1) - 1, 0);
      const endLine = msg.endLine !== undefined
        ? Math.max(msg.endLine - 1, 0)
        : line;
      const endCharacter = msg.endColumn !== undefined
        ? Math.max(msg.endColumn - 1, 0)
        : character;

      const prefix = msg.ruleId ? `[${msg.ruleId}] ` : "";

      diagnostics.push({
        message: `${prefix}${msg.message}`,
        severity: msg.severity === 2 ? 1 : 2,
        range: {
          start: { line, character },
          end: { line: endLine, character: endCharacter },
        },
        source: "eslint",
        filePath: file.filePath,
      });
    }
  }

  return diagnostics;
}

export async function checkEslintDiagnostics(
  filePath: string,
  cwd: string,
): Promise<DiagnosticResult> {
  const configDir = await findEslintConfigDir(filePath, cwd);
  if (!configDir) {
    return { diagnostics: [], source: "none" };
  }

  try {
    const result = await safeSpawnAsync(
      "npx",
      ["--no-install", "eslint", "--format", "json", "--no-warn-ignored", filePath],
      {
        cwd: configDir,
        timeout: 30_000,
      },
    );

    const diagnostics = parseEslintJsonOutput(
      result.stdout || result.stderr || "",
      filePath,
    );

    return {
      diagnostics,
      source: diagnostics.length > 0 ? "eslint" : "none",
    };
  } catch {
    return { diagnostics: [], source: "none" };
  }
}
