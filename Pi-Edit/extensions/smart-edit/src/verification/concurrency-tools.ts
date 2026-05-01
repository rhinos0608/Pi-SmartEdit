/**
 * Concurrency verification tools.
 *
 * Implements the VerificationTool interface for ecosystem-specific
 * concurrency checking adapters:
 *
 * - ConfiguredCommandTool: runs user-provided commands from config
 * - GoRaceTool: bounded `go test -race` on the nearest Go package
 * - RustLoomTool: configured Rust loom test runner
 * - JvmFrayTool: JVM Fray controlled concurrency testing
 * - JcstressTool: OpenJDK jcstress harness
 *
 * Each tool is responsible for its own detection (canRun) and execution
 * (run) with bounded timeouts and structured error reporting.
 */

import { execSync } from "child_process";
import { access } from "fs/promises";
import { dirname, join, resolve } from "path";
import { runCommand } from "./command-runner";
import type { ChangedTarget, ConcurrencyConfig, ConcurrencyEvidence, VerificationCommand } from "./types";

// ─── Verification tool interface ───────────────────────────────────

export interface VerificationInput {
  /** Project root */
  cwd: string;
  /** Absolute path to the edited file */
  filePath: string;
  /** Language ID */
  languageId: string;
  /** Targets that triggered concurrency signals */
  changedTargets: ChangedTarget[];
  /** Timeout for this invocation (ms) */
  timeoutMs: number;
}

export interface VerificationTool {
  /** Display name */
  name: string;
  /** Language IDs this tool supports */
  languages: string[];
  /** Check if this tool can run right now */
  canRun(input: VerificationInput): Promise<boolean>;
  /** Run verification and return evidence */
  run(input: VerificationInput): Promise<ConcurrencyEvidence[]>;
}

// ─── Tool: ConfiguredCommandTool ────────────────────────────────────

/**
 * Runs user-specified verification commands from configuration.
 * This is the primary way to integrate project-specific concurrency
 * testing tools (scheduler fuzzers, stress test harnesses, etc.).
 */
export class ConfiguredCommandTool implements VerificationTool {
  name = "configured-command";
  languages: string[] = []; // matches all; filtered by config entries

  private configCommands: VerificationCommand[];

  constructor(config: ConcurrencyConfig) {
    this.configCommands = config.commands ?? [];
  }

  async canRun(input: VerificationInput): Promise<boolean> {
    if (this.configCommands.length === 0) return false;

    // Find matching commands for this input
    const matching = this.findMatchingCommands(input);
    return matching.length > 0;
  }

  async run(input: VerificationInput): Promise<ConcurrencyEvidence[]> {
    const results: ConcurrencyEvidence[] = [];
    const matching = this.findMatchingCommands(input);

    for (const cmd of matching) {
      const toolTimeout = cmd.timeoutMs ?? input.timeoutMs;
      const cmdCwd = cmd.cwd ? resolve(input.cwd, cmd.cwd) : input.cwd;

      const result = await runCommand(cmd.command, cmd.args, {
        cwd: cmdCwd,
        timeoutMs: toolTimeout,
        maxOutputChars: 10_000,
      });

      // Build evidence from each target that triggered the check
      for (const target of input.changedTargets) {
        const diagnostics: ConcurrencyEvidence["diagnostics"] = [];

        if (result.timedOut) {
          results.push({
            target,
            tool: `${this.name}:${cmd.name}`,
            command: [cmd.command, ...cmd.args],
            status: "timeout",
            diagnostics: [
              {
                message: `Command timed out after ${toolTimeout}ms`,
                severity: 3,
              },
            ],
            note: `Verification command "${cmd.name}" timed out after ${toolTimeout}ms.`,
          });
        } else if (result.status !== 0 || (result.signal != null)) {
          // Parse stderr/stdout for diagnostics
          const output = (result.stderr || result.stdout || "").trim();
          const signalMsg = result.signal ? ` terminated by signal ${result.signal}` : "";
          diagnostics.push({
            message: output.slice(0, 500) || `Command exited with code ${result.status}${signalMsg}`,
            severity: 2,
            evidence: output.length > 500 ? "truncated" : undefined,
          });

          results.push({
            target,
            tool: `${this.name}:${cmd.name}`,
            command: [cmd.command, ...cmd.args],
            status: "failed",
            diagnostics,
            note: `Verification command "${cmd.name}" failed with exit code ${result.status}${signalMsg}.`,
          });
        } else {
          results.push({
            target,
            tool: `${this.name}:${cmd.name}`,
            command: [cmd.command, ...cmd.args],
            status: "passed",
            diagnostics: [],
            note: `Verification command "${cmd.name}" passed.`,
          });
        }
      }
    }

    return results;
  }

  private findMatchingCommands(input: VerificationInput): VerificationCommand[] {
    return this.configCommands.filter(
      (cmd) => {
        // Language filter
        if (cmd.languages && cmd.languages.length > 0) {
          if (!cmd.languages.includes(input.languageId)) return false;
        }
        // File glob filter
        if (cmd.fileGlobs && cmd.fileGlobs.length > 0) {
          const matched = cmd.fileGlobs.some((glob) =>
            simpleGlobMatch(glob, input.filePath),
          );
          if (!matched) return false;
        }
        return true;
      },
    );
  }
}

// ─── Tool: GoRaceTool ──────────────────────────────────────────────

/**
 * Bounded `go test -race` on the nearest Go package containing the
 * edited file. Auto-detects go.mod to find the package boundary.
 */
export class GoRaceTool implements VerificationTool {
  name = "go-race";
  languages = ["go"];

  async canRun(input: VerificationInput): Promise<boolean> {
    if (input.languageId !== "go") return false;

    try {
      execSync("go version", { stdio: "ignore", timeout: 5_000 });
    } catch {
      return false; // go not installed
    }

    // Check for go.mod nearby
    const pkgDir = await findNearestGoModDir(input.filePath);
    if (!pkgDir) return false;

    return true;
  }

  async run(input: VerificationInput): Promise<ConcurrencyEvidence[]> {
    const pkgDir = await findNearestGoModDir(input.filePath);
    if (!pkgDir) {
      return input.changedTargets.map((target) => ({
        target,
        tool: this.name,
        command: [],
        status: "skipped" as const,
        diagnostics: [{ message: "go.mod not found", severity: 3 }],
        note: "Skipped: no go.mod found in the file's package hierarchy.",
      }));
    }

    const result = await runCommand(
      "go",
      ["test", "-race", "-count=1", "./..."],
      {
        cwd: pkgDir,
        timeoutMs: input.timeoutMs,
        maxOutputChars: 10_000,
      },
    );

    return input.changedTargets.map((target) => {
      const output = (result.stdout + result.stderr).trim();
      const diagnostics: ConcurrencyEvidence["diagnostics"] = [];

      if (result.timedOut) {
        diagnostics.push({
          message: `go test -race timed out after ${input.timeoutMs}ms`,
          severity: 3,
        });
      } else if (result.status !== 0 && result.status !== null) {
        diagnostics.push({
          message: output.slice(0, 500) || `Race detected or test failure (exit ${result.status})`,
          severity: 2,
          evidence: output.length > 500 ? "truncated" : undefined,
          range: parseGoRaceLine(output),
        });
      }

      return {
        target,
        tool: this.name,
        command: ["go", "test", "-race", "-count=1", "./..."],
        status: result.timedOut ? "timeout" as const : result.status === 0 ? "passed" as const : "failed" as const,
        diagnostics,
        note: result.status === 0
          ? "go test -race passed (no race conditions detected)."
          : result.timedOut
            ? "go test -race timed out."
            : "go test -race reported potential race conditions or test failures.",
      };
    });
  }
}

// ─── Tool: RustLoomTool ────────────────────────────────────────────

/**
 * Detects whether the project uses `loom::model` for concurrency testing.
 * In v1, emits a warning with a suggested command rather than inventing
 * the right invocation.
 */
export class RustLoomTool implements VerificationTool {
  name = "rust-loom";
  languages = ["rust"];

  async canRun(input: VerificationInput): Promise<boolean> {
    if (input.languageId !== "rust") return false;

    // Check if Cargo.toml exists nearby and references loom
    const cargoToml = await findNearestFile(dirname(input.filePath), "Cargo.toml");
    if (!cargoToml) return false;

    try {
      const content = await import("fs/promises").then((m) =>
        m.readFile(cargoToml, "utf-8"),
      );
      if (
        content.includes('loom =') ||
        content.includes('"loom"') ||
        content.includes("loom ")
      ) {
        return true;
      }
    } catch {
      // Fall through
    }

    return false;
  }

  async run(input: VerificationInput): Promise<ConcurrencyEvidence[]> {
    return input.changedTargets.map((target) => ({
      target,
      tool: this.name,
      command: [],
      status: "skipped" as const,
      diagnostics: [],
      note: "Loom dependency detected. Run `cargo test --features loom` with RUSTFLAGS=\"--cfg loom\" in the crate root to verify concurrent behavior.",
    }));
  }
}

// ─── Tool: JvmFrayTool ─────────────────────────────────────────────

/**
 * Detects JVM projects with Fray dependency for controlled concurrency
 * testing. Emits setup guidance when exact command is not obvious.
 */
export class JvmFrayTool implements VerificationTool {
  name = "jvm-fray";
  languages = ["java", "kotlin"];

  async canRun(input: VerificationInput): Promise<boolean> {
    if (!["java", "kotlin"].includes(input.languageId)) return false;

    // Check for Gradle or Maven build files with Fray references
    const projectDir = dirname(input.filePath);
    const buildFiles = ["build.gradle", "build.gradle.kts", "pom.xml"];

    for (const bf of buildFiles) {
      const fullPath = await findNearestFile(projectDir, bf);
      if (fullPath) {
        try {
          const content = await import("fs/promises").then((m) =>
            m.readFile(fullPath, "utf-8"),
          );
          if (
            content.includes("fray") ||
            content.includes("Fray") ||
            content.includes("FRAY")
          ) {
            return true;
          }
        } catch {
          continue;
        }
      }
    }

    // Also check source for Fray annotation imports
    try {
      const content = await import("fs/promises").then((m) =>
        m.readFile(input.filePath, "utf-8"),
      );
      if (
        content.includes("edu.cmu.pasta.fray") ||
        content.includes("FrayTest") ||
        content.includes("ConcurrencyTest")
      ) {
        return true;
      }
    } catch {
      // Fall through
    }

    return false;
  }

  async run(input: VerificationInput): Promise<ConcurrencyEvidence[]> {
    return input.changedTargets.map((target) => ({
      target,
      tool: this.name,
      command: [],
      status: "skipped" as const,
      diagnostics: [],
      note: "Fray dependency detected. Run the Fray test harness (e.g., `./gradlew frayTest` or `mvn test -Pfray`) to verify concurrent behavior.",
    }));
  }
}

// ─── Tool: JcstressTool ────────────────────────────────────────────

/**
 * Detects OpenJDK jcstress test modules.
 */
export class JcstressTool implements VerificationTool {
  name = "jcstress";
  languages = ["java", "kotlin"];

  async canRun(input: VerificationInput): Promise<boolean> {
    if (!["java", "kotlin"].includes(input.languageId)) return false;

    // Look for jcstress test configuration
    const projectDir = dirname(input.filePath);
    const buildFiles = ["build.gradle", "build.gradle.kts", "pom.xml"];

    for (const bf of buildFiles) {
      const fullPath = await findNearestFile(projectDir, bf);
      if (fullPath) {
        try {
          const content = await import("fs/promises").then((m) =>
            m.readFile(fullPath, "utf-8"),
          );
          if (
            content.includes("jcstress") ||
            content.includes("JCStress") ||
            content.includes("org.openjdk.jcstress")
          ) {
            return true;
          }
        } catch {
          continue;
        }
      }
    }

    return false;
  }

  async run(input: VerificationInput): Promise<ConcurrencyEvidence[]> {
    return input.changedTargets.map((target) => ({
      target,
      tool: this.name,
      command: [],
      status: "skipped" as const,
      diagnostics: [],
      note: "jcstress dependency detected. Build and run the jcstress test suite with configured workloads for full stress coverage.",
    }));
  }
}

// ─── Tool registry ─────────────────────────────────────────────────

/**
 * Create the default set of verification tools for a given config.
 */
export function createVerificationTools(
  config: ConcurrencyConfig,
): VerificationTool[] {
  const tools: VerificationTool[] = [
    new ConfiguredCommandTool(config),
  ];

  if (config.autoDetectKnownTools) {
    tools.push(new GoRaceTool());
    tools.push(new RustLoomTool());
    tools.push(new JvmFrayTool());
    tools.push(new JcstressTool());
  }

  return tools;
}

/**
 * Find the first verification tool that can run on the given input.
 * Tools are checked in order — configured commands take priority.
 */
export async function selectTool(
  tools: VerificationTool[],
  input: VerificationInput,
): Promise<VerificationTool | null> {
  for (const tool of tools) {
    if (await tool.canRun(input)) {
      return tool;
    }
  }
  return null;
}

// ─── Helpers ───────────────────────────────────────────────────────

async function findNearestGoModDir(filePath: string): Promise<string | null> {
  let current = resolve(dirname(filePath));
  while (true) {
    try {
      await access(join(current, "go.mod"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function findNearestFile(
  startDir: string,
  fileName: string,
): Promise<string | null> {
  let current = resolve(startDir);
  while (true) {
    try {
      await access(join(current, fileName));
      return join(current, fileName);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

function simpleGlobMatch(glob: string, path: string): boolean {
  const normalised = path.replace(/\\/g, "/");
  if (glob.startsWith("**/")) {
    const suffix = glob.slice(3);
    return normalised.includes(suffix);
  }
  if (glob.startsWith("*.")) {
    const suffix = glob.slice(1);
    return normalised.endsWith(suffix);
  }
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3);
    return normalised.startsWith(prefix);
  }
  return normalised === glob;
}

/**
 * Try to extract a line+character range from go vet -race output.
 */
function parseGoRaceLine(
  output: string,
): { start: { line: number; character: number }; end: { line: number; character: number } } | undefined {
  // Match patterns like: pkg/sub/file.go:42:10: data race
  const match = output.match(/((?:[^\s:]+\\)*[^\s:\\/]+\.go):(\d+)(?::(\d+))?/);
  if (match) {
    const line = parseInt(match[2], 10) - 1;
    const col = match[3] ? parseInt(match[3], 10) - 1 : 0;
    return {
      start: { line, character: col },
      end: { line, character: col },
    };
  }
  return undefined;
}
