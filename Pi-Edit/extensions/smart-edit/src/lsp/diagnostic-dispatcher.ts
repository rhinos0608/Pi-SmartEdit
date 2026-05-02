/**
 * Multi-tier diagnostic dispatcher.
 * Runs LSP, then compiler, then linter in order of priority.
 */

import { spawn } from "child_process";
import { access } from "fs/promises";
import { dirname, resolve } from "path";

export interface Diagnostic {
  message: string;
  severity: 1 | 2 | 3 | 4; // 1=error, 2=warning, 3=info, 4=hint
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  source: string;
  filePath?: string;
}

export interface DiagnosticResult {
  diagnostics: Diagnostic[];
  source: string;
}

/**
 * Parse tsc output to diagnostics.
 * Format: "file(line,col): error TS####: message"
 */
export function parseTscOutput(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // Regex to match tsc --pretty false output: file.ts(10,5): error TS2322: message
  const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  
  let match;
  while ((match = regex.exec(output)) !== null) {
    const [, file, line, col, severity, _code, message] = match;
    diagnostics.push({
      message: `${file}:${message}`,
      severity: severity === "error" ? 1 : 2,
      range: {
        start: { line: parseInt(line) - 1, character: parseInt(col) - 1 },
        end: { line: parseInt(line) - 1, character: parseInt(col) - 1 },
      },
      source: "tsc",
      filePath: file,
    });
  }
  
  return diagnostics;
}

/**
 * Parse pyright JSON output to diagnostics.
 */
export function parsePyrightOutput(output: string): Diagnostic[] {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const diagnostics: Diagnostic[] = [];
    
    for (const diag of (parsed.generalDiagnostics as unknown[] || [])) {
      const d = diag as Record<string, unknown>;
      if (!["error", "warning"].includes(d.severity as string)) continue;
      diagnostics.push({
        message: d.message as string,
        severity: d.severity === "error" ? 1 : 2,
        range: {
          // Pyright uses 0-indexed values in range
          start: { line: ((d.range as Record<string, unknown> | undefined)?.start as Record<string, number> | undefined)?.line ?? 0, character: ((d.range as Record<string, unknown> | undefined)?.start as Record<string, number> | undefined)?.character ?? 0 },
          end: { line: ((d.range as Record<string, unknown> | undefined)?.end as Record<string, number> | undefined)?.line ?? 0, character: ((d.range as Record<string, unknown> | undefined)?.end as Record<string, number> | undefined)?.character ?? 0 },
        },
        source: "pyright",
      });
    }
    
    return diagnostics;
  } catch {
    return [];
  }
}

/**
 * Spawn a command asynchronously with timeout support.
 */
function safeSpawnAsync(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number }
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (options.timeout) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeout);
    }

    if (child.stdout) {
      child.stdout.on("data", (data: unknown) => {
        stdout.push(String(data));
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (data: unknown) => {
        stderr.push(String(data));
      });
    }

    child.on("close", (code: number | null) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        status: timedOut ? -1 : code,
      });
    });

    child.on("error", () => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        status: -1,
      });
    });
  });
}

async function findAncestorDirWithFile(
  startDir: string,
  fileName: string,
): Promise<string | null> {
  let current = resolve(startDir);

  while (true) {
    try {
      await access(resolve(current, fileName));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}

async function findNearestTsconfig(filePath: string, cwd: string): Promise<string | null> {
  const fromFile = await findAncestorDirWithFile(dirname(filePath), "tsconfig.json");
  if (fromFile) {
    return resolve(fromFile, "tsconfig.json");
  }

  const fromCwd = await findAncestorDirWithFile(cwd, "tsconfig.json");
  if (fromCwd) {
    return resolve(fromCwd, "tsconfig.json");
  }

  return null;
}

function resolveDiagnosticPath(candidate: string, cwd: string, tsconfigPath: string | null): string[] {
  const resolved = new Set<string>([resolve(cwd, candidate)]);

  if (tsconfigPath) {
    resolved.add(resolve(dirname(tsconfigPath), candidate));
  }

  return [...resolved];
}

function isRelevantDiagnostic(
  diagnostic: Diagnostic,
  targetPath: string,
  cwd: string,
  tsconfigPath: string | null,
): boolean {
  if (!diagnostic.filePath) {
    return true;
  }

  const target = resolve(targetPath);
  return resolveDiagnosticPath(diagnostic.filePath, cwd, tsconfigPath)
    .some((candidate) => candidate === target);
}

/**
 * Run TypeScript compiler and get diagnostics.
 */
export async function checkTscDiagnostics(
  filePath: string,
  cwd: string
): Promise<DiagnosticResult> {
  const tsconfigPath = await findNearestTsconfig(filePath, cwd);

  // Using npx tsc to catch global tsc vs local
  const args = tsconfigPath
    ? ["tsc", "--noEmit", "--pretty", "false", "-p", tsconfigPath]
    : ["tsc", "--noEmit", "--pretty", "false", filePath];

  const result = await safeSpawnAsync("npx", args, {
    cwd,
    timeout: 60000,
  });
  
  const output = result.stdout + result.stderr;
  const diagnostics = parseTscOutput(output).filter((diagnostic) =>
    isRelevantDiagnostic(diagnostic, filePath, cwd, tsconfigPath),
  );
  
  return {
    diagnostics,
    source: diagnostics.length > 0 ? "tsc" : "none",
  };
}

/**
 * Run pyright and get diagnostics.
 */
export async function checkPyrightDiagnostics(
  filePath: string,
  cwd: string
): Promise<DiagnosticResult> {
  const result = await safeSpawnAsync("pyright", ["--outputjson", filePath], {
    cwd,
    timeout: 60000,
  });

  const diagnostics = parsePyrightOutput(result.stdout || result.stderr || "");

  return {
    diagnostics,
    source: diagnostics.length > 0 ? "pyright" : "none",
  };
}

/**
 * Run cargo check and get diagnostics for Rust.
 */
export async function checkCargoDiagnostics(
  filePath: string,
  cwd: string
): Promise<DiagnosticResult> {
  const cargoRoot = (await findAncestorDirWithFile(dirname(filePath), "Cargo.toml")) ?? cwd;
  const result = await safeSpawnAsync("cargo", ["check", "--message-format=json", "--quiet"], {
    cwd: cargoRoot,
    timeout: 120000,
  });

  const diagnostics: Diagnostic[] = [];

  for (const line of `${result.stdout || ""}\n${result.stderr || ""}`.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.reason !== "compiler-message") continue;
      const inner = msg.message as Record<string, unknown>;
      if (!inner || !["error", "warning"].includes(inner.level as string)) continue;

      const spans = Array.isArray(inner.spans) ? inner.spans : [];
      const span = spans[0] as Record<string, number> | undefined;
      const rawMessage = inner.message;
      const message =
        typeof rawMessage === "string"
          ? rawMessage
          : (rawMessage as Record<string, string>)?.text ?? (rawMessage as Record<string, string>)?.rendered ?? "(no message)";
      const range = span
        ? {
            start: {
              line: Math.max((span.line_start ?? 1) - 1, 0),
              character: Math.max((span.column_start ?? 1) - 1, 0),
            },
            end: {
              line: Math.max((span.line_end ?? span.line_start ?? 1) - 1, 0),
              character: Math.max((span.column_end ?? span.column_start ?? 1) - 1, 0),
            },
          }
        : {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          };

      diagnostics.push({
        message,
        severity: inner.level === "error" ? 1 : 2,
        range,
        source: "cargo",
      });
    } catch {
      // Skip invalid lines
    }
  }

  return {
    diagnostics,
    source: diagnostics.length > 0 ? "cargo" : "none",
  };
}

/**
 * Run go vet and get diagnostics for Go.
 */
export async function checkGoVetDiagnostics(
  filePath: string,
  cwd: string
): Promise<DiagnosticResult> {
  const goPackageDir = dirname(filePath);
  const result = await safeSpawnAsync("go", ["vet", "."], {
    cwd: goPackageDir || cwd,
    timeout: 60000,
  });

  const diagnostics: Diagnostic[] = [];

  // Format: "file.go:line:col: message" or "file.go:line: message"
  const regex = /^(.+?\.go):(\d+)(?::(\d+))?:\s+(.+)$/gm;
  let match;
  const output = (result.stderr || "") + (result.stdout || "");

  while ((match = regex.exec(output)) !== null) {
    const [, file, line, col, message] = match;
    diagnostics.push({
      message: `${file}:${message}`,
      severity: 1, // go vet typically reports actual issues
      range: {
        start: { line: parseInt(line) - 1, character: col ? parseInt(col) - 1 : 0 },
        end: { line: parseInt(line) - 1, character: col ? parseInt(col) - 1 : 0 },
      },
      source: "go vet",
    });
  }

  return {
    diagnostics,
    source: diagnostics.length > 0 ? "go vet" : "none",
  };
}

/**
 * Get compiler runner for a language.
 */
export function getCompilerForLanguage(languageId: string) {
  switch (languageId) {
    case "typescript":
    case "javascript":
      return checkTscDiagnostics;
    case "python":
      return checkPyrightDiagnostics;
    case "rust":
      return checkCargoDiagnostics;
    case "go":
      return checkGoVetDiagnostics;
    case "ruby":
      return checkRubocopDiagnostics;
    default:
      return null;
  }
}

/**
 * Run rubocop and get diagnostics for Ruby.
 */
export async function checkRubocopDiagnostics(
  filePath: string,
  cwd: string
): Promise<DiagnosticResult> {
  const result = await safeSpawnAsync("rubocop", ["--format", "json", filePath], {
    cwd,
    timeout: 60000,
  });

  const diagnostics: Diagnostic[] = [];

  try {
    const output = JSON.parse(result.stdout || result.stderr || "") as { files?: Array<{ offenses?: Array<{ message: string; severity: string; location: { line: number; column: number; last_line?: number; last_column?: number } }> }> };
    for (const file of output.files || []) {
      for (const offense of file.offenses || []) {
        diagnostics.push({
          message: offense.message,
          severity: offense.severity === "error" || offense.severity === "fatal" ? 1 : 2,
          range: {
            start: { line: offense.location.line - 1, character: offense.location.column - 1 },
            end: { line: (offense.location.last_line ?? offense.location.line) - 1, character: (offense.location.last_column ?? offense.location.column) - 1 },
          },
          source: "rubocop",
        });
      }
    }
  } catch {
    // Not JSON or rubocop not found
  }

  return {
    diagnostics,
    source: diagnostics.length > 0 ? "rubocop" : "none",
  };
}
