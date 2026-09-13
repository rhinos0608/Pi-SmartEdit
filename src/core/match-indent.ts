/**
 * Indentation subsystem for the smart-edit match engine (Tier 2).
 *
 * Extracted verbatim from src/core/edit-match.ts (MS1): detectIndentation,
 * normalizeIndentation, adaptNewTextIndentation plus private helpers
 * inferIndentWidth, countIndentLevel, makeIndent. Tier order, thresholds,
 * and coordinates unchanged. One-way dependency: edit-match.ts consumes
 * this module; this module must NOT import edit-match.ts or edit-diff.ts.
 */

import type { IndentationStyle } from "./types";

// ─── Indentation utilities (Tier 2) ────────────────────────────────

/**
 * Detect the file's predominant indentation style.
 * Counts lines starting with tabs vs spaces. If spaces win, infers width
 * from the most common indent depth delta among non-zero indented lines.
 */
export function detectIndentation(content: string): IndentationStyle {
  const lines = content.split("\n");
  let tabCount = 0;
  let spaceCount = 0;
  const indentDepths: number[] = [];

  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith("\t")) {
      tabCount++;
      continue;
    }
    const leadingSpaces = line.match(/^ +/);
    if (leadingSpaces) {
      spaceCount++;
      indentDepths.push(leadingSpaces[0].length);
    }
  }

  if (tabCount > spaceCount) {
    // Tab-indented files: assume 4-space visual width per tab.
    // Most coding conventions use 4-space tabs; this enables correct
    // conversion of model's space-indented oldText (e.g., 4 spaces → 1 tab).
    return { char: "\t", width: 4 };
  }

  // Infer width from indent depth deltas
  const width = inferIndentWidth(indentDepths);
  return { char: " ", width };
}

function inferIndentWidth(depths: number[]): number {
  if (depths.length === 0) return 2; // default
  // Sort unique depths
  const unique = [...new Set(depths)].sort((a, b) => a - b);

  // If all depths are multiples of a common number, use that
  if (unique.length === 0) return 2;

  // Common heuristic: the smallest non-zero depth is the indent width
  const nonZero = unique.filter((d) => d > 0);
  if (nonZero.length === 0) return 2;

  // Check if most non-zero depths are multiples of 2 or 4
  const multiplesOf2 = nonZero.filter((d) => d % 2 === 0).length;
  const multiplesOf4 = nonZero.filter((d) => d % 4 === 0).length;

  if (multiplesOf4 > nonZero.length * 0.6 && nonZero[0] >= 4) return 4;
  if (multiplesOf2 > nonZero.length * 0.6 && nonZero[0] >= 2) return 2;

  return nonZero[0];
}

/**
 * Normalize leading whitespace of text to match the detected indentation style.
 * For spaces → tabs: replace N spaces with 1 tab
 * For tabs → spaces: replace 1 tab with N spaces
 * Handles mixed leading whitespace by counting equivalent indent levels.
 */
export function normalizeIndentation(
  text: string,
  fileStyle: IndentationStyle,
): string {
  const lines = text.split("\n");
  return lines
    .map((line) => {
      if (line.length === 0) return line;

      const leadingWs = line.match(/^[\t ]*/);
      if (!leadingWs || leadingWs[0].length === 0) return line;

      const ws = leadingWs[0];
      const rest = line.slice(ws.length);

      // Calculate indent level
      let level: number;
      if (ws.includes("\t") && ws.includes(" ")) {
        // Mixed — count character-by-character
        level = 0;
        for (const ch of ws) {
          level += ch === "\t" ? 1 : 1 / fileStyle.width;
        }
        level = Math.round(level);
      } else if (ws.startsWith("\t")) {
        level = ws.length;
      } else {
        level = Math.round(ws.length / fileStyle.width);
      }

      // Emit with file's style
      if (fileStyle.char === "\t") {
        return "\t".repeat(level) + rest;
      } else {
        return " ".repeat(level * fileStyle.width) + rest;
      }
    })
    .join("\n");
}

/**
 * Adjust newText's indentation to match the file's style.
 * Only adjusts the first line's leading whitespace relative to oldText's
 * first-line indent level difference.
 */
export function adaptNewTextIndentation(
  newText: string,
  oldText: string,
  fileStyle: IndentationStyle,
  oldTextOriginal: string, // the actual matched oldText from file
): string {
  if (!newText || !oldText) return newText;

  const newLines = newText.split("\n");
  if (newLines.length === 0) return newText;

  // Get indent level of oldText's first line in the file (original)
  const oldFirstLine = oldTextOriginal.split("\n")[0] || "";
  const oldFileIndentWs = oldFirstLine.match(/^[\t ]*/);
  const oldFileIndent = oldFileIndentWs ? oldFileIndentWs[0] : "";

  // Get indent level of oldText's first line (what model sent)
  const oldModelFirstLine = oldText.split("\n")[0] || "";
  const oldModelIndentWs = oldModelFirstLine.match(/^[\t ]*/);
  const oldModelIndent = oldModelIndentWs ? oldModelIndentWs[0] : "";

  // Get indent level of newText's first line
  const newFirstLineIndentWs = newLines[0].match(/^[\t ]*/);
  const newFirstLineIndent = newFirstLineIndentWs ? newFirstLineIndentWs[0] : "";

  // Calculate the indent delta: how much did model change the indent?
  // If oldModel has 2-space and new has 4-space, delta is +1 level
  const oldModelLevel = countIndentLevel(oldModelIndent, fileStyle);
  const newModelLevel = countIndentLevel(newFirstLineIndent, fileStyle);
  const oldFileLevel = countIndentLevel(oldFileIndent, fileStyle);

  // When the model sends oldText with stripped (zero) indentation but the
  // file match has non-zero indentation, we can't compute a meaningful
  // delta — the model's 0 baseline doesn't reflect the file's nesting.
  // Fall back to treating the model's newText as absolute in file style.
  const strippedIndent = oldModelIndent.length === 0 && oldFileIndent.length > 0;
  const delta = strippedIndent ? 0 : (newModelLevel - oldModelLevel);
  const newFileLevel = Math.max(0, oldFileLevel + delta);

  // Step 1: Normalize ALL lines of newText to the file's indentation style.
  // This converts e.g. 2-space to 4-space (or spaces to tabs) across all lines.
  const normalizedNewText = normalizeIndentation(newText, fileStyle);
  const normalizedLines = normalizedNewText.split("\n");

  // Step 2: Set the first line's indent to the file-relative level.
  // normalizeIndentation normalizes to absolute file style; newFileLevel
  // applies the model's intentional indent change on top of the file's
  // actual baseline (oldFileLevel), avoiding a double-applied delta that
  // would occur if we added delta on top of the already-normalized level.
  if (normalizedLines.length > 0) {
    const remainder = normalizedLines[0].slice(
      (normalizedLines[0].match(/^[\t ]*/) || [""])[0].length,
    );
    normalizedLines[0] = makeIndent(newFileLevel, fileStyle) + remainder;
  }

  return normalizedLines.join("\n");
}

function countIndentLevel(indent: string, style: IndentationStyle): number {
  if (!indent) return 0;
  if (style.char === "\t" && indent.startsWith("\t")) return indent.length;
  if (style.char === " ") return Math.round(indent.length / style.width);
  // Mixed — count each char
  let level = 0;
  for (const ch of indent) {
    level += ch === "\t" ? 1 : 1 / style.width;
  }
  return Math.round(level);
}

function makeIndent(level: number, style: IndentationStyle): string {
  if (level <= 0) return "";
  return style.char === "\t" ? "\t".repeat(level) : " ".repeat(level * style.width);
}

