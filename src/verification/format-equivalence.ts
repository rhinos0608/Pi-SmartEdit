/**
 * Format-equivalence verification for auto-validation.
 *
 * Formatter discovery, indentation scoring, diff generation, subprocess
 * execution, temp-file lifecycle, and equivalence evaluation live here.
 * Advisory only — every failure path is fail-open (returns an equivalent
 * result with indentScore 0) so the edit pipeline is never blocked.
 */

import { resolve, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { diffLines, type Change } from "diff";

export interface FormatEquivalenceResult {
  equivalent: boolean; // true if formatted matches original (ignoring whitespace-only diffs)
  diff?: string; // compact diff if not equivalent
  indentScore: number; // 0-1 normalized indentation divergence
  error?: string; // error if formatter failed
  formatted?: string; // auto-formatted content for comparison
}

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.mjs',
  'prettier.config.cjs',
];

type FormatterKind = 'biome' | 'prettier';

/** Private discovery result: kind + invocation inputs. Exported for regression tests. */
export interface FormatterDiscovery {
  kind: FormatterKind;
  command: string;
  /** Nearest Prettier config path (prettier kind only, null when default). */
  configPath: string | null;
}

/** Shared ancestor walk: file dir up through cwd root, inclusive. */
function ancestorDirs(cwd: string, filePath: string): string[] {
  const root = resolve(cwd);
  let dir = dirname(resolve(cwd, filePath));
  const dirs: string[] = [];
  for (;;) {
    dirs.push(dir);
    if (dir === root || !dir.startsWith(root)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** Nearest Prettier config over shared walk, or null. */
function findNearestPrettierConfig(dirs: string[]): string | null {
  for (const dir of dirs) {
    for (const config of PRETTIER_CONFIGS) {
      const candidate = resolve(dir, config);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Private discovery seam: single walk, Biome-over-Prettier per directory. */
function discoverFormatter(cwd: string, filePath: string): FormatterDiscovery | null {
  const dirs = ancestorDirs(cwd, filePath);
  for (const dir of dirs) {
    if (existsSync(resolve(dir, 'biome.json'))) {
      return { kind: 'biome', command: 'bunx biome format', configPath: null };
    }
    for (const config of PRETTIER_CONFIGS) {
      if (existsSync(resolve(dir, config))) {
        return {
          kind: 'prettier',
          command: 'npx prettier --write',
          configPath: findNearestPrettierConfig([dir]),
        };
      }
    }
  }
  return null;
}

/** Build formatter argv for a temp file (config forwarding for Prettier). Exported for regression tests. */
export function buildFormatterArgs(discovery: FormatterDiscovery, tmpPath: string): string[] {
  if (discovery.kind === 'biome') return ['bunx', 'biome', 'format', '--write', tmpPath];
  return discovery.configPath
    ? ['npx', 'prettier', '--write', '--config', discovery.configPath, tmpPath]
    : ['npx', 'prettier', '--write', tmpPath];
}

/** Execute formatter binary against temp file. Fail-open payload on error. */
async function executeFormatterOnTempFile(
  discovery: FormatterDiscovery,
  tmpPath: string,
  cwd: string,
): Promise<{ formatted?: string; error?: string }> {
  const result = await runFormatterCommand(buildFormatterArgs(discovery, tmpPath), cwd);
  if (result.error) return { error: result.error };
  try {
    return { formatted: readFileSync(tmpPath, 'utf-8') };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { error };
  }
}

/** Compare original vs formatted: indent score + equivalence + diff. */
function compareFormatResults(
  original: string,
  formatted: string,
): { equivalent: boolean; indentScore: number; diff?: string } {
  const indentScore = computeIndentScore(original, formatted);
  const diff = generateEquivalenceDiff(original, formatted);
  const equivalent = diff.trim() === '' || !hasNonWhitespaceChanges(original, formatted);
  return { equivalent, indentScore, diff: equivalent ? undefined : diff };
}

function tempFilePath(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')) || '.ts';
  return resolve(tmpdir(), `.smart-edit-tmp-${randomUUID()}${ext}`);
}

/**
 * Detect available formatter by checking for config files in cwd.
 * Returns the formatter command string or null if none found.
 */
export function detectFormatter(cwd: string, filePath: string): string | null {
  return discoverFormatter(cwd, filePath)?.command ?? null;
}

/**
 * Locate the nearest Prettier config file for `filePath`, walking ancestor
 * directories from the file directory up through `cwd`. Returns the
 * absolute config path, or null if none is found. Mirrors the discovery
 * walk in detectFormatter so the retained path matches the detection.
 */
export function findPrettierConfigPath(cwd: string, filePath: string): string | null {
  return findNearestPrettierConfig(ancestorDirs(cwd, filePath));
}

/**
 * Compute indentation score between original and formatted content.
 * Returns 0.0-1.0 where 0 = no indent differences, 1 = all lines differ.
 */
export function computeIndentScore(original: string, formatted: string): number {
  const originalLines = original.split('\n');
  const formattedLines = formatted.split('\n');

  let differingIndentCount = 0;
  const maxLines = Math.max(originalLines.length, formattedLines.length);

  for (let i = 0; i < maxLines; i++) {
    const originalLine = originalLines[i] ?? '';
    const formattedLine = formattedLines[i] ?? '';

    // Compute indentation (leading whitespace) for each line
    const originalIndent = originalLine.match(/^(\s*)/)?.[1] ?? '';
    const formattedIndent = formattedLine.match(/^(\s*)/)?.[1] ?? '';

    if (originalIndent !== formattedIndent) {
      differingIndentCount++;
    }
  }

  if (maxLines === 0) return 0;
  return differingIndentCount / maxLines;
}

/** Collect +/- changed lines from diff parts, skipping blanks. */
function collectChangedLines(changes: Change[]): string[] {
  const lines: string[] = [];
  for (const part of changes) {
    if (part.added) {
      for (const line of part.value.split('\n')) {
        if (line !== '') {
          lines.push(`+${line}`);
        }
      }
    } else if (part.removed) {
      for (const line of part.value.split('\n')) {
        if (line !== '') {
          lines.push(`-${line}`);
        }
      }
    }
  }
  return lines;
}

/** Cap changed lines at 50 with overflow marker. */
function truncateChangedLines(lines: string[]): string[] {
  const output = lines.slice(0, 50);
  if (lines.length > 50) {
    output.push(`... [${lines.length - 50} more changes]`);
  }
  return output;
}

/**
 * Generate a compact diff showing only changed regions.
 * Uses 3 lines of context around changes.
 */
export function generateEquivalenceDiff(original: string, formatted: string): string {
  const changes = diffLines(original, formatted);
  const lines = collectChangedLines(changes);
  // Limit output to first 50 changed lines to avoid bloat
  return truncateChangedLines(lines).join('\n');
}

/**
 * Run format equivalence check on content.
 * Auto-formats the content and compares against original.
 */
export async function runFormatEquivalenceCheck(
  content: string,
  filePath: string,
  cwd: string,
): Promise<FormatEquivalenceResult> {
  const discovery = discoverFormatter(cwd, filePath);

  if (!discovery) {
    return { equivalent: true, indentScore: 0 };
  }

  // Create a temporary file for formatting (preserve extension for formatter detection)
  const tmpPath = tempFilePath(filePath);

  try {
    // Write content to temp file
    writeFileSync(tmpPath, content, 'utf-8');

    const outcome = await executeFormatterOnTempFile(discovery, tmpPath, cwd);
    if (outcome.error || outcome.formatted === undefined) {
      return { equivalent: true, indentScore: 0, error: outcome.error };
    }

    const comparison = compareFormatResults(content, outcome.formatted);
    return {
      equivalent: comparison.equivalent,
      indentScore: comparison.indentScore,
      diff: comparison.diff,
      formatted: outcome.formatted,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { equivalent: true, indentScore: 0, error };
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Run a formatter command and return the result.
 */
async function runFormatterCommand(
  args: string[],
  cwd: string,
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stderr = '';

    if (child.stderr) {
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (data: string) => {
        stderr += data;
      });
    }

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr.trim() || `Exit code: ${code}` });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    // Timeout after 30 seconds, unref'd so it doesn't keep process alive
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ success: false, error: 'Formatter timed out' });
    }, 30_000);
    timer.unref();
  });
}

/**
 * Check if there are non-whitespace changes between two strings.
 */
function hasNonWhitespaceChanges(original: string, formatted: string): boolean {
  const changes = diffLines(original, formatted);

  for (const part of changes) {
    if (part.added || part.removed) {
      // Check if the change contains non-whitespace characters
      const testContent = part.value.replace(/\s/g, '');
      if (testContent.length > 0) {
        return true;
      }
    }
  }

  return false;
}
