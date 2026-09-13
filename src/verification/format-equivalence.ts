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
import { diffLines } from "diff";

export interface FormatEquivalenceResult {
  equivalent: boolean; // true if formatted matches original (ignoring whitespace-only diffs)
  diff?: string; // compact diff if not equivalent
  indentScore: number; // 0-1 normalized indentation divergence
  error?: string; // error if formatter failed
  formatted?: string; // auto-formatted content for comparison
}

/**
 * Detect available formatter by checking for config files in cwd.
 * Returns the formatter command string or null if none found.
 */
export function detectFormatter(cwd: string, filePath: string): string | null {
  // Walk ancestor directories from the file directory up through cwd,
  // so a config in cwd applies to nested files.
  const root = resolve(cwd);
  let dir = dirname(resolve(cwd, filePath));

  const prettierConfigs = [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.js',
    '.prettierrc.yaml',
    '.prettierrc.toml',
    'prettier.config.js',
    'prettier.config.mjs',
    'prettier.config.cjs',
  ];

  for (;;) {
    if (existsSync(resolve(dir, 'biome.json'))) {
      return 'bunx biome format';
    }
    for (const config of prettierConfigs) {
      if (existsSync(resolve(dir, config))) {
        return 'npx prettier --write';
      }
    }
    if (dir === root || !dir.startsWith(root)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * Locate the nearest Prettier config file for `filePath`, walking ancestor
 * directories from the file directory up through `cwd`. Returns the
 * absolute config path, or null if none is found. Mirrors the discovery
 * walk in detectFormatter so the retained path matches the detection.
 */
export function findPrettierConfigPath(cwd: string, filePath: string): string | null {
  const root = resolve(cwd);
  let dir = dirname(resolve(cwd, filePath));

  const prettierConfigs = [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.js',
    '.prettierrc.yaml',
    '.prettierrc.toml',
    'prettier.config.js',
    'prettier.config.mjs',
    'prettier.config.cjs',
  ];

  for (;;) {
    for (const config of prettierConfigs) {
      const candidate = resolve(dir, config);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    if (dir === root || !dir.startsWith(root)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
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

/**
 * Generate a compact diff showing only changed regions.
 * Uses 3 lines of context around changes.
 */
export function generateEquivalenceDiff(original: string, formatted: string): string {
  const changes = diffLines(original, formatted);
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

  // Limit output to first 50 changed lines to avoid bloat
  const output = lines.slice(0, 50);
  if (lines.length > 50) {
    output.push(`... [${lines.length - 50} more changes]`);
  }

  return output.join('\n');
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
  const formatter = detectFormatter(cwd, filePath);

  if (!formatter) {
    return { equivalent: true, indentScore: 0 };
  }

  // Create a temporary file for formatting (preserve extension for formatter detection)
  const ext = filePath.slice(filePath.lastIndexOf('.')) || '.ts';
  const tmpPath = resolve(tmpdir(), `.smart-edit-tmp-${randomUUID()}${ext}`);

  try {
    // Write content to temp file
    writeFileSync(tmpPath, content, 'utf-8');

    // Run formatter based on detected type
    let formattedContent: string;

    if (formatter === 'bunx biome format') {
      const result = await runFormatterCommand(['bunx', 'biome', 'format', tmpPath], cwd);
      if (result.error) {
        return { equivalent: true, indentScore: 0, error: result.error };
      }
      // Read the formatted file
      formattedContent = readFileSync(tmpPath, 'utf-8');
    } else {
      // Prettier — retain the detected config path via --config so project
      // rules apply to tmpPath (tmp file lives outside the project, so a
      // bare --write would fall back to defaults).
      const configPath = findPrettierConfigPath(cwd, filePath);
      const prettierArgs = configPath
        ? ['npx', 'prettier', '--write', '--config', configPath, tmpPath]
        : ['npx', 'prettier', '--write', tmpPath];
      const result = await runFormatterCommand(prettierArgs, cwd);
      if (result.error) {
        return { equivalent: true, indentScore: 0, error: result.error };
      }
      // Read the formatted file
      formattedContent = readFileSync(tmpPath, 'utf-8');
    }

    // Compute indent score
    const indentScore = computeIndentScore(content, formattedContent);

    // Check if they're equivalent (only whitespace differences)
    const diff = generateEquivalenceDiff(content, formattedContent);
    const equivalent = diff.trim() === '' || !hasNonWhitespaceChanges(content, formattedContent);

    return {
      equivalent,
      indentScore,
      diff: equivalent ? undefined : diff,
      formatted: formattedContent,
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
