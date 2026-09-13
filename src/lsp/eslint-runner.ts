import { access } from "fs/promises";
import { dirname, join, resolve } from "path";
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

/**
 * Cache of resolved ESLint config directory per (file directory, cwd) pair.
 *
 * `findEslintConfigDir` walks ancestor directories (trying every candidate
 * config filename) on every call. With no caching, every edit re-does the
 * same filesystem walk from scratch even though config discovery is stable
 * for the lifetime of a session. A "no config found" result (`null`) is
 * cached too. No TTL/invalidation: scoped to the process lifetime, matching
 * the equivalent tsconfig cache in diagnostic-dispatcher.ts.
 */
const eslintConfigDirCache = new Map<string, string | null>();

async function findEslintConfigDir(
  filePath: string,
  cwd: string,
): Promise<string | null> {
  const cacheKey = `${dirname(filePath)}::${cwd}`;
  const cached = eslintConfigDirCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const fileDir = dirname(filePath);
  let result: string | null = null;

  for (const configName of ESLINT_CONFIG_FILES) {
    const dir = await findAncestorDirWithFile(fileDir, configName);
    if (dir) {
      result = dir;
      break;
    }
  }

  if (!result) {
    for (const configName of ESLINT_CONFIG_FILES) {
      const dir = await findAncestorDirWithFile(cwd, configName);
      if (dir) {
        result = dir;
        break;
      }
    }
  }

  eslintConfigDirCache.set(cacheKey, result);
  return result;
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

export interface EslintCommandSelection {
  kind: "direct" | "npx";
  command: string;
}

/**
 * Pure selector for the ESLint spawn command.
 *
 * The Windows `cmd.exe` gate in spawn-utils `^`-escapes but never quotes
 * command paths, so an absolute local binary under a `configDir` containing
 * whitespace breaks. Paths with whitespace fall back to the `npx` form
 * (HEAD behavior); all other paths may attempt the direct local binary.
 * Commands stay bare (`eslint`/`npx`): `buildSpawnTargets` expands the
 * win32 bare + `.cmd` + `.bat` fallback chain, while a suffixed name would
 * yield a single attempt and lose the `.bat` fallback.
 * `isWin` is retained for call-signature compat but no longer selects a
 * suffix; both platforms receive the bare name.
 * Pure over (`configDir`, `isWin`) so the branch is unit-testable on POSIX.
 */
export function selectEslintCommand(
  configDir: string,
  isWin: boolean = process.platform === "win32",
): EslintCommandSelection {
  const localEslint = join(configDir, "node_modules", ".bin", "eslint");
  if (/\s/.test(localEslint)) {
    return { kind: "npx", command: "npx" };
  }
  return { kind: "direct", command: localEslint };
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
    // Prefer the config dir's local binary over npx package resolution: a
    // local install may provide only node_modules/.bin without a package
    // record `npx --no-install` resolves (observed Windows-only miss: the
    // fake was never invoked, source stayed "none"). Absolute path, so no
    // PATH dependence. Spawned bare so buildSpawnTargets expands the win32
    // fallback chain; resolvability is probed across the suffixed variants
    // below because the file on disk carries .cmd/.bat on Windows.
    const isWin = process.platform === "win32";
    // Bare `npx`: buildSpawnTargets expands the win32 bare + .cmd + .bat chain.
    const npxCommand = "npx";
    const npxArgs = [
      "--no-install",
      "eslint",
      "--format",
      "json",
      "--no-warn-ignored",
      filePath,
    ];
    let command = npxCommand;
    let args = npxArgs;
    let usedLocalDirect = false;
    // Whitespace in the absolute local path breaks the Windows cmd.exe gate
    // (^-escaping without quoting); such paths stay on the npx form.
    const selection = selectEslintCommand(configDir, isWin);
    if (selection.kind === "direct") {
      // Probe resolvability across the win32 expansion (.cmd/.bat on disk)
      // but spawn the bare name so safeSpawnAsync keeps the full fallback.
      const directCandidates = isWin
        ? [selection.command, `${selection.command}.cmd`, `${selection.command}.bat`]
        : [selection.command];
      for (const candidate of directCandidates) {
        try {
          await access(candidate);
          command = selection.command;
          args = ["--format", "json", "--no-warn-ignored", filePath];
          usedLocalDirect = true;
          break;
        } catch {
          // No local binary under this suffix — try the next, else npx.
        }
      }
    }
    let result = await safeSpawnAsync(command, args, {
      cwd: configDir,
      timeout: 30_000,
    });
    // TOCTOU: access() succeeded but the binary vanished before spawn.
    // safeSpawnAsync normalizes lookup failure to status -1 with empty
    // output; retry once via npx. Timeout kills also report -1 but carry
    // partial output, so empty stdout+stderr separates the two cases.
    if (usedLocalDirect && result.status === -1 && !result.stdout && !result.stderr) {
      result = await safeSpawnAsync(npxCommand, npxArgs, {
        cwd: configDir,
        timeout: 30_000,
      });
    }

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
