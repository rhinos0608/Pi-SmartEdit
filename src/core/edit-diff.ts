/**
 * Improved edit-diff module for the smart-edit Pi extension.
 *
 * Key fix: Never apply replacements in normalized space.
 * Normalization is used only as a coordinate finder — matches are
 * mapped back to original content positions and applied there.
 *
 * Also includes: indentation detection/normalization, closest-match
 * diagnostics, replaceAll support, trailing-newline edge case handling.
 */

import * as Diff from "diff";
import type {
  EditItem,
  IndentationStyle,
  MatchSpan,
  ClosestMatchDiagnostic,
  SearchScope,
} from "./types";
import { MatchTier } from "./types";

import { access, readFile } from "fs/promises";
import { constants } from "fs";
import { resolveToCwd } from "./path-utils";
import { MatchError } from "./errors";

import {
  adaptNewTextIndentation,
  countOccurrences,
  countSimilarityOccurrences,
  DOMINANT_FUZZY_DELTA,
  detectIndentation,
  findAllMatches,
  findClosestMatch,
  findText,
  formatClosestMatchHint,
  isDominantFuzzyMatch,
  materializeDotdotdots,
  normalizeForFuzzyMatch,
  preserveQuoteStyle,
} from "./edit-match.js";

// Re-export the match engine's public API so existing importers of this
// module keep working (single writer: src/core/edit-match.ts).
export {
  adaptNewTextIndentation,
  detectCommentStyle,
  detectIndentation,
  findAllMatches,
  findClosestMatch,
  findText,
  findTextWithTelemetry,
  materializeDotdotdots,
  normalizeForFuzzyMatch,
  normalizeIndentation,
  preserveQuoteStyle,
  stripCommentPrefixes,
  textSimilarityRatio,
} from "./edit-match.js";
export type { CommentStyleResult, TierTelemetry } from "./edit-match.js";

// ─── Line ending utilities ───────────────────────────────────────

export function detectLineEnding(content: string): string {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: string): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Strip UTF-8 BOM if present */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

// ─── Error message helpers ──────────────────────────────────────────

function getNotFoundError(
  path: string,
  editIndex: number,
  totalEdits: number,
  diagnostic?: ClosestMatchDiagnostic | null,
  description?: string,
  allowFuzzy?: boolean,
): MatchError {
  let msg: string;
  const desc = description ? ` (${description})` : "";

  if (totalEdits === 1) {
    msg = `Could not find the text${desc} in ${path}.`;
  } else {
    msg = `Could not find edits[${editIndex}]${desc} in ${path}.`;
  }

  // Idempotency hint: if the replacement is already in the file, say so
  // (newText is passed via the options object below, so we check it there)

  if (diagnostic) {
    const fuzzyHint = formatClosestMatchHint(diagnostic, allowFuzzy ?? false);
    msg += fuzzyHint;
  }

  return new MatchError(msg, 'NOT_FOUND', editIndex);
}

function getAmbiguousError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
  lineIndices?: number[],
  description?: string,
): MatchError {
  const desc = description ? ` (${description})` : "";
  let lineInfo = "";
  if (lineIndices && lineIndices.length > 0) {
    const preview = lineIndices.slice(0, 5);
    const suffix = lineIndices.length > 5 ? `, and ${lineIndices.length - 5} more` : "";
    lineInfo = ` Found ${occurrences} occurrences at lines: ${preview.join(", ")}${suffix}.`;
  } else {
    lineInfo = ` Found ${occurrences} occurrences.`;
  }
  const msg =
    totalEdits === 1
      ? `Could not find unique text${desc} in ${path}.${lineInfo}` +
        ` Please provide more surrounding context to make it unique, ` +
        `or use replaceAll: true if you intend to replace all occurrences.`
      : `Could not find unique text for edits[${editIndex}]${desc} in ${path}.${lineInfo}` +
        ` Each oldText must be unique. Please provide more surrounding context to make it unique, ` +
        `or use replaceAll: true if you intend to replace all occurrences.`;
  return new MatchError(msg, 'AMBIGUOUS', editIndex);
}

function getEmptyOldTextError(
  path: string,
  editIndex: number,
  totalEdits: number,
): Error {
  if (totalEdits === 1) {
    return new Error(`oldText must not be empty in ${path}.`);
  }
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. ` +
      `This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new Error(
    `No changes made to ${path}. The replacements produced identical content.`,
  );
}

// ─── ApplyEditsOptions ───────────────────────────────────────────

/** Optional configuration for applyEdits */
export interface ApplyEditsOptions {
  /**
   * Pre-computed search scopes for narrowing text matching.
   * Each entry corresponds to the edit at the same index.
   * Undefined means no scope restriction for that edit.
   */
  searchScopes?: (SearchScope | undefined)[];

  /** Enable similarity-based fuzzy matching. Defaults to true. */
  allowFuzzy?: boolean;

  /** Called with resolved match spans before applying, e.g., for conflict detection */
  onBeforeApply?: (spans: MatchSpan[], content: string) => void | Promise<void>;

  /**
   * Path to the file being edited. Passed to onResolveAnchor so it can
   * perform language-aware resolution (e.g., AST parsing by extension).
   */
  filePath?: string;

  /**
   * Called per-edit to resolve anchor/lineRange to a SearchScope.
   * Allows the caller (e.g., index.ts) to use AST symbol resolution,
   * tree-sitter queries, or any other strategy.
   *
   * Returns the resolved SearchScope, or null to fall back to full-file search.
   */
  onResolveAnchor?: (
    edit: EditItem,
    content: string,
    filePath: string,
  ) => Promise<SearchScope | null> | SearchScope | null;

}

// ─── Line-range helpers ─────────────────────────────────────────

/**
 * Convert a line range (1-based) to byte offsets in the content.
 * Operates on LF-normalized content after BOM strip.
 * If endLine is omitted, defaults to startLine (single line).
 */
export function lineRangeToByteRange(
  content: string,
  range: { startLine: number; endLine?: number },
): { startIndex: number; endIndex: number; totalLines: number } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const startLine = Math.max(1, Math.min(range.startLine, totalLines));
  const endLine = range.endLine
    ? Math.max(startLine, Math.min(range.endLine, totalLines))
    : startLine;

  let startIndex = 0;
  for (let i = 0; i < startLine - 1 && i < lines.length; i++) {
    startIndex += lines[i].length + 1;
  }

  let endIndex = startIndex;
  const hasTrailingNewline = content.endsWith('\n');
  for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
    endIndex += lines[i].length;
    // Add 1 for the newline separator, unless this is the last line
    // without a trailing newline
    if (i < lines.length - 1 || hasTrailingNewline) {
      endIndex += 1;
    }
  }

  return { startIndex, endIndex, totalLines };
}

/**
 * Validate a line range against the file length.
 * Returns null if valid, error message if invalid.
 */
export function validateLineRange(
  range: { startLine: number; endLine?: number },
  totalLines: number,
): string | null {
  if (range.startLine < 1) return "startLine must be >= 1";
  if (range.startLine > totalLines)
    return `startLine ${range.startLine} exceeds file length (${totalLines} lines)`;
  if (range.endLine && range.endLine > totalLines)
    return `endLine ${range.endLine} exceeds file length (${totalLines} lines)`;
  if (range.endLine && range.endLine < range.startLine)
    return "endLine must be >= startLine";
  return null;
}

// ─── Idempotency helper ────────────────────────────────────────────

/**
 * Check if an edit would be a no-op (oldText already replaced by newText).
 * Returns true if the replacement is already in place at the match position.
 */
function checkIdempotency(
  content: string,
  oldText: string,
  newText: string,
  path: string,
  editIndex: number,
  description?: string,
): boolean {
  const trimmedNew = newText.trim();
  const trimmedOld = oldText.trim();

  if (!trimmedNew || !trimmedOld) return false;

  const idx = content.indexOf(trimmedOld);
  if (idx === -1) return false;

  const end = idx + trimmedOld.length;
  const beforeText = content.slice(Math.max(0, idx - trimmedNew.length), idx);
  const afterText = content.slice(end, end + trimmedNew.length);

  // Check if trimmedNew already exists in any adjacent position
  const isAlreadyReplaced =
    content.slice(idx, end) === trimmedNew ||
    beforeText === trimmedNew ||
    afterText === trimmedNew;

  if (isAlreadyReplaced) {
    return true;
  }

  return false;
}

// ─── Main application function ──────────────────────────────────────

/**
 * Apply edits to LF-normalized content. This is THE core function.
 *
 * Architecture: All matching uses normalization as a coordinate finder.
 * All replacements are applied to the ORIGINAL LF-normalized content at
 * mapped positions. This prevents file corruption when fuzzy matching is
 * used. BOM and line-ending restoration are the caller's responsibility.
 *
 * @param normalizedContent - LF-normalized, BOM-stripped file content
 * @param edits - Edits to apply (may contain replaceAll and description)
 * @param path - File path for error messages
 * @param options - Optional configuration for anchor resolution and conflict detection
 */
// ─── applyEdits seam helpers (file-local, extract-only) ───────────────

type NormalizedEdit = EditItem & { oldText: string; newText: string };

interface MatchBuildContext {
  normalizedContent: string;
  indentationStyle: IndentationStyle;
  allowFuzzy: boolean;
  path: string;
  totalEdits: number;
}

/** Seam: normalize (LF). Metadata-only edits are routed before this pipeline. */
function normalizeEditTexts(edits: EditItem[]): NormalizedEdit[] {
  const normalizedEdits: NormalizedEdit[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (typeof edit.oldText !== "string") {
      throw new Error(
        `edits[${i}].oldText is ${typeof edit.oldText}, expected a string. ` +
        `If using hashline format, the hashline anchor data may have been lost ` +
        `during tool parameter processing. Re-read the file and retry with explicit hashline anchors.`
      );
    }
    normalizedEdits.push({
      ...edit,
      oldText: normalizeToLF(edit.oldText),
      newText: typeof edit.newText === "string" ? normalizeToLF(edit.newText) : "",
    });
  }
  return normalizedEdits;
}

/** Seam: normalize validation — no empty oldText. */
function assertNonEmptyOldText(normalizedEdits: NormalizedEdit[], path: string): void {
  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }
}

/** Seam: scopes — resolve search scopes for edits with anchors or lineRanges. */
async function resolveSearchScopes(
  normalizedEdits: NormalizedEdit[],
  normalizedContent: string,
  path: string,
  options?: ApplyEditsOptions,
): Promise<(SearchScope | undefined)[]> {
  const searchScopes: (SearchScope | undefined)[] = [];
  if (options?.searchScopes || options?.onResolveAnchor) {
    for (let i = 0; i < normalizedEdits.length; i++) {
      if (options?.searchScopes?.[i]) {
        searchScopes.push(options.searchScopes[i]);
      } else if (options?.onResolveAnchor) {
        const scope = await options.onResolveAnchor(
          normalizedEdits[i],
          normalizedContent,
          options.filePath || path,
        );
        searchScopes.push(scope ?? undefined);
      } else {
        searchScopes.push(undefined);
      }
    }
  }
  return searchScopes;
}

function hasEofTrailingBlanks(oldText: string): boolean {
  return oldText.endsWith('\n\n') || oldText.endsWith(' \n');
}

function isDeletionMissingTrailingNewline(edit: NormalizedEdit): boolean {
  return (
    edit.newText.length === 0 &&
    edit.oldText.length > 0 &&
    !edit.oldText.endsWith("\n")
  );
}

/** Seam: preprocess — EOF context anchor (`*** End of File` pattern). */
function stripEofContextAnchor(
  edit: NormalizedEdit,
  normalizedContent: string,
  index: number,
  matchNotes: string[],
): NormalizedEdit {
  if (!hasEofTrailingBlanks(edit.oldText)) return edit;
  const trimmedOld = edit.oldText.trimEnd();
  if (!trimmedOld) return edit;
  if (normalizedContent.includes(edit.oldText)) return edit;
  if (!normalizedContent.includes(trimmedOld)) return edit;
  const potentialIdx = normalizedContent.indexOf(trimmedOld);
  if (potentialIdx === -1) return edit;
  const afterMatch = normalizedContent.slice(potentialIdx + trimmedOld.length);
  if (afterMatch.trim()) return edit;
  matchNotes.push(`edits[${index}]: trailing blank lines in oldText stripped (EOF context anchor).`);
  return { ...edit, oldText: trimmedOld };
}

/** Seam: preprocess — trailing newline edge case (deletion leaving orphan blank line). */
function extendDeletionWithTrailingNewline(
  edit: NormalizedEdit,
  normalizedContent: string,
): NormalizedEdit {
  if (!isDeletionMissingTrailingNewline(edit)) return edit;
  const withNewline = edit.oldText + "\n";
  if (!normalizedContent.includes(withNewline)) return edit;
  return { ...edit, oldText: withNewline };
}

/** Seam: preprocess — materialize `...` elisions before matching. */
function materializeEllipsis(
  edit: NormalizedEdit,
  normalizedContent: string,
  index: number,
  matchNotes: string[],
): NormalizedEdit {
  const DOT_LINE_RE = /^[ \t]*\.\.\.[ \t]*$/m;
  if (!DOT_LINE_RE.test(edit.oldText)) return edit;
  const materialized = materializeDotdotdots(
    edit.oldText,
    edit.newText,
    normalizedContent,
  );
  if (!materialized) return edit;
  matchNotes.push(`edits[${index}]: ... ellipsis materialized (numericFuzz=4, dotdotdots).`);
  return {
    ...edit,
    oldText: materialized.materializedOld,
    newText: materialized.materializedNew,
  };
}

/** Seam: preprocess — EOF anchor, trailing-newline, dotdotdots in fixed order. */
function preprocessEdit(
  edit: NormalizedEdit,
  normalizedContent: string,
  index: number,
  matchNotes: string[],
): NormalizedEdit {
  let next = stripEofContextAnchor(edit, normalizedContent, index, matchNotes);
  next = extendDeletionWithTrailingNewline(next, normalizedContent);
  next = materializeEllipsis(next, normalizedContent, index, matchNotes);
  return next;
}

function idempotencyNote(
  scopedContent: string,
  edit: NormalizedEdit,
  path: string,
  index: number,
): string | null {
  if (!checkIdempotency(scopedContent, edit.oldText, edit.newText, path, index, edit.description)) {
    return null;
  }
  return (
    `edits[${index}]${edit.description ? ` (${edit.description})` : ''}: ` +
    `replacement text already present in ${path} — edit is a no-op.`
  );
}

function throwNotFound(
  normalizedContent: string,
  edit: NormalizedEdit,
  index: number,
  ctx: MatchBuildContext,
): never {
  const diagnostic = findClosestMatch(normalizedContent, edit.oldText);
  throw getNotFoundError(
    ctx.path, index, ctx.totalEdits, diagnostic, edit.description, ctx.allowFuzzy,
  );
}

function pushTierNote(
  matchNote: string | undefined,
  tier: MatchTier,
  index: number,
  matchNotes: string[],
): void {
  if (tier === MatchTier.EXACT || !matchNote) return;
  matchNotes.push(matchNote.replace(
    "Matched via",
    `edits[${index}] matched via`,
  ));
}

function adaptReplacementText(
  newText: string,
  edit: NormalizedEdit,
  ctx: MatchBuildContext,
  matchedText: string,
  matchIndex: number,
  matchLength: number,
): string {
  const adapted = adaptNewTextIndentation(
    newText,
    edit.oldText,
    ctx.indentationStyle,
    matchedText,
  );
  return preserveQuoteStyle(
    adapted,
    ctx.normalizedContent,
    matchIndex,
    matchLength,
    ctx.path,
  );
}

/** Seam: replace-all spans. */
function buildReplaceAllSpans(
  edit: NormalizedEdit,
  index: number,
  ctx: MatchBuildContext,
  searchScope: SearchScope | undefined,
  scopedContent: string,
  matchNotes: string[],
): MatchSpan[] {
  const match = findText(
    ctx.normalizedContent,
    edit.oldText,
    ctx.indentationStyle,
    0,
    searchScope,
    ctx.allowFuzzy,
  );
  if (!match.found) {
    const note = idempotencyNote(scopedContent, edit, ctx.path, index);
    if (note) {
      matchNotes.push(note);
      return [];
    }
    throwNotFound(ctx.normalizedContent, edit, index, ctx);
  }
  // Lock to this tier and find all matches
  const allMatches = findAllMatches(
    ctx.normalizedContent,
    edit.oldText,
    ctx.indentationStyle,
    match.tier,
    searchScope,
    ctx.allowFuzzy,
  );
  if (allMatches.length === 0) {
    throwNotFound(ctx.normalizedContent, edit, index, ctx);
  }
  const spans: MatchSpan[] = [];
  for (const m of allMatches) {
    let newText = edit.newText;
    if (m.tier !== MatchTier.EXACT) {
      newText = adaptReplacementText(newText, edit, ctx, m.matchedText, m.index, m.matchLength);
    } else {
      newText = preserveQuoteStyle(
        newText,
        ctx.normalizedContent,
        m.index,
        m.matchLength,
        ctx.path,
      );
    }
    spans.push({
      editIndex: index,
      matchIndex: m.index,
      matchLength: m.matchLength,
      newText,
      tier: m.tier,
      matchNote: m.matchNote,
      replaceAll: true,
      description: edit.description,
    });
  }
  pushTierNote(match.matchNote, match.tier, index, matchNotes);
  return spans;
}

function assertUnicodeUnique(
  scopedContent: string,
  edit: NormalizedEdit,
  index: number,
  ctx: MatchBuildContext,
): void {
  const fuzzyContent = normalizeForFuzzyMatch(scopedContent);
  const fuzzyOldText = normalizeForFuzzyMatch(edit.oldText);
  let fuzzyCount = 0;
  let pos = 0;
  while ((pos = fuzzyContent.indexOf(fuzzyOldText, pos)) !== -1) {
    fuzzyCount++;
    pos += fuzzyOldText.length;
  }
  if (fuzzyCount > 1) {
    throw getAmbiguousError(
      ctx.path, index, ctx.totalEdits, fuzzyCount, undefined, edit.description,
    );
  }
}

function assertSimilarityUnique(
  scopedContent: string,
  edit: NormalizedEdit,
  index: number,
  ctx: MatchBuildContext,
  matchNotes: string[],
): void {
  const { count: similarityCount, bestScore, secondBestScore } = countSimilarityOccurrences(
    scopedContent,
    edit.oldText,
  );
  if (similarityCount <= 1) return;
  // Fuzzy-dominant auto-accept: if one match is clearly better, accept it.
  if (isDominantFuzzyMatch(bestScore, secondBestScore)) {
    matchNotes.push(
      `edits[${index}]${edit.description ? ` (${edit.description})` : ''}: ` +
      `fuzzy-dominant auto-accepted (best=${(bestScore * 100).toFixed(1)}%, ` +
      `delta=${((bestScore - secondBestScore) * 100).toFixed(1)}% > ` +
      `${(DOMINANT_FUZZY_DELTA * 100).toFixed(0)}% threshold).`,
    );
    return;
  }
  throw getAmbiguousError(
    ctx.path, index, ctx.totalEdits, similarityCount, undefined, edit.description,
  );
}

function assertExactTierUnique(
  scopedContent: string,
  edit: NormalizedEdit,
  index: number,
  ctx: MatchBuildContext,
): void {
  const strippedOld = edit.oldText.replace(/^[\t ]+/gm, '');
  const strippedContent = scopedContent.replace(/^[\t ]+/gm, '');
  const exactCount = countOccurrences(strippedContent, strippedOld);
  if (exactCount > 1) {
    throw getAmbiguousError(
      ctx.path, index, ctx.totalEdits, exactCount, undefined, edit.description,
    );
  }
}

/** Seam: single-match ambiguity check across tiers (scoped to search scope). */
function assertSingleMatchUnique(
  tier: MatchTier,
  scopedContent: string,
  edit: NormalizedEdit,
  index: number,
  ctx: MatchBuildContext,
  matchNotes: string[],
): void {
  if (tier === MatchTier.UNICODE) {
    assertUnicodeUnique(scopedContent, edit, index, ctx);
  } else if (tier === MatchTier.SIMILARITY) {
    assertSimilarityUnique(scopedContent, edit, index, ctx, matchNotes);
  } else {
    assertExactTierUnique(scopedContent, edit, index, ctx);
  }
}

/** Seam: single-match span. Returns [] when the edit is an idempotent no-op. */
function buildSingleMatchSpan(
  edit: NormalizedEdit,
  index: number,
  ctx: MatchBuildContext,
  searchScope: SearchScope | undefined,
  scopedContent: string,
  matchNotes: string[],
): MatchSpan[] {
  const match = findText(
    ctx.normalizedContent,
    edit.oldText,
    ctx.indentationStyle,
    0,
    searchScope,
    ctx.allowFuzzy,
  );
  if (!match.found) {
    const note = idempotencyNote(scopedContent, edit, ctx.path, index);
    if (note) {
      matchNotes.push(note);
      return [];
    }
    throwNotFound(ctx.normalizedContent, edit, index, ctx);
  }
  assertSingleMatchUnique(match.tier, scopedContent, edit, index, ctx, matchNotes);
  let newText = edit.newText;
  if (match.tier !== MatchTier.EXACT || match.usedFuzzyMatch) {
    newText = adaptNewTextIndentation(
      newText,
      edit.oldText,
      ctx.indentationStyle,
      match.matchedText,
    );
    newText = preserveQuoteStyle(
      newText,
      ctx.normalizedContent,
      match.index,
      match.matchLength,
      ctx.path,
    );
  }
  pushTierNote(match.matchNote, match.tier, index, matchNotes);
  return [{
    editIndex: index,
    matchIndex: match.index,
    matchLength: match.matchLength,
    newText,
    tier: match.tier,
    matchNote: match.matchNote,
    replaceAll: false,
    description: edit.description,
  }];
}

/** Seam: overlap — reject overlapping spans with replaceAll-aware messages. */
function validateNoOverlappingSpans(matchSpans: MatchSpan[], path: string): void {
  matchSpans.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchSpans.length; i++) {
    const prev = matchSpans[i - 1];
    const curr = matchSpans[i];
    if (prev.matchIndex + prev.matchLength <= curr.matchIndex) continue;
    const prevDesc = prev.description ? ` (${prev.description})` : "";
    const currDesc = curr.description ? ` (${curr.description})` : "";
    if (prev.replaceAll || curr.replaceAll) {
      throw new Error(
        `edits[${prev.editIndex}]${prevDesc}${prev.replaceAll ? " (replaceAll)" : ""} and ` +
        `edits[${curr.editIndex}]${currDesc}${curr.replaceAll ? " (replaceAll)" : ""} overlap ` +
        `in ${path}. If you need to replace all occurrences except one specific case, ` +
        `split into two calls: first apply the specific edit, then replaceAll for the rest.`,
      );
    }
    throw new Error(
      `edits[${prev.editIndex}]${prevDesc} and edits[${curr.editIndex}]${currDesc} ` +
      `overlap in ${path}. Merge them into one edit or target disjoint regions.`,
    );
  }
}

/** Seam: reverse/no-change — apply spans in reverse order against ORIGINAL content. */
function applySpansInReverse(normalizedContent: string, matchSpans: MatchSpan[]): string {
  let newContent = normalizedContent;
  matchSpans.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = matchSpans.length - 1; i >= 0; i--) {
    const span = matchSpans[i];
    newContent =
      newContent.slice(0, span.matchIndex) +
      span.newText +
      newContent.slice(span.matchIndex + span.matchLength);
  }
  return newContent;
}

export async function applyEdits(
  normalizedContent: string,
  edits: EditItem[],
  path: string,
  options?: ApplyEditsOptions,
): Promise<{
  baseContent: string;
  newContent: string;
  matchNotes: string[];
  replacementCount: number;
  matchSpans: MatchSpan[];
}> {
  const normalizedEdits = normalizeEditTexts(edits);
  assertNonEmptyOldText(normalizedEdits, path);

  // Detect file indentation style once
  const indentationStyle = detectIndentation(normalizedContent);
  const allowFuzzy = options?.allowFuzzy ?? true;
  const searchScopes = await resolveSearchScopes(normalizedEdits, normalizedContent, path, options);
  const ctx: MatchBuildContext = {
    normalizedContent,
    indentationStyle,
    allowFuzzy,
    path,
    totalEdits: normalizedEdits.length,
  }

  // Phase 1: Match phase — find all spans in ORIGINAL content
  const matchSpans: MatchSpan[] = [];
  const matchNotes: string[] = [];

  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = preprocessEdit(normalizedEdits[i], normalizedContent, i, matchNotes);

    const searchScope = searchScopes[i];
    const scopedContent = searchScope
      ? normalizedContent.slice(searchScope.startIndex, searchScope.endIndex)
      : normalizedContent;

    if (edit.replaceAll) {
      matchSpans.push(...buildReplaceAllSpans(edit, i, ctx, searchScope, scopedContent, matchNotes));
    } else {
      matchSpans.push(...buildSingleMatchSpan(edit, i, ctx, searchScope, scopedContent, matchNotes));
    }
  }

  // Phase 2: Check for overlaps
  validateNoOverlappingSpans(matchSpans, path);

  // Phase 2.5: Pre-apply hooks (conflict detection, etc.)
  // Only run hooks after structural validation so invalid batches cannot
  // advance external state like conflict baselines.
  if (options?.onBeforeApply) {
    await options.onBeforeApply(matchSpans, normalizedContent);
  }

  // Phase 3: Apply replacements in reverse order against ORIGINAL content
  const baseContent = normalizedContent;
  const newContent = applySpansInReverse(normalizedContent, matchSpans);

  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }

  return { baseContent, newContent, matchNotes, replacementCount: matchSpans.length, matchSpans };
}

// ─── Diff generation ────────────────────────────────────────────────

/**
 * Generate a unified diff string with line numbers and context.
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines: number = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;

      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextPartIsChange =
        i < parts.length - 1 &&
        (parts[i + 1].added || parts[i + 1].removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;

      if (hasLeadingChange && hasTrailingChange) {
        renderContext(raw, output, oldLineNum, newLineNum, lineNumWidth, contextLines);
        oldLineNum += raw.length;
        newLineNum += raw.length;
      } else if (hasLeadingChange) {
        const shown = raw.slice(0, contextLines);
        const skipped = raw.length - shown.length;
        for (const line of shown) {
          const ln = String(oldLineNum++).padStart(lineNumWidth, " ");
          output.push(` ${ln} ${line}`);
          newLineNum++;
        }
        if (skipped > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipped;
          newLineNum += skipped;
        }
      } else if (hasTrailingChange) {
        const skipped = Math.max(0, raw.length - contextLines);
        if (skipped > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipped;
          newLineNum += skipped;
        }
        for (const line of raw.slice(skipped)) {
          const ln = String(oldLineNum++).padStart(lineNumWidth, " ");
          output.push(` ${ln} ${line}`);
          newLineNum++;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

function renderContext(
  lines: string[],
  output: string[],
  oldStart: number,
  newStart: number,
  lineNumWidth: number,
  context: number,
): void {
  if (lines.length <= context * 2) {
    for (const line of lines) {
      const ln = String(oldStart++).padStart(lineNumWidth, " ");
      output.push(` ${ln} ${line}`);
    }
    return;
  }

  const leading = lines.slice(0, context);
  const trailing = lines.slice(lines.length - context);
  const skipped = lines.length - leading.length - trailing.length;

  for (const line of leading) {
    const ln = String(oldStart++).padStart(lineNumWidth, " ");
    output.push(` ${ln} ${line}`);
  }
  output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
  oldStart += skipped;
  for (const line of trailing) {
    const ln = String(oldStart).padStart(lineNumWidth, " ");
    output.push(` ${ln} ${line}`);
    oldStart++;
  }
}

// ─── Preview diff computation ───────────────────────────────────────

/**
 * Compute diff for edits without applying them. Used for TUI preview.
 */
export async function computeEditsDiff(
  path: string,
  edits: EditItem[],
  cwd: string,
): Promise<
  { diff: string; firstChangedLine: number | undefined } | { error: string }
> {
  const absolutePath = resolveToCwd(path, cwd);
  try {
    try {
      await access(absolutePath, constants.R_OK);
    } catch {
      return { error: `File not found: ${path}` };
    }

    const rawContent = await readFile(absolutePath, "utf-8");
    const { text: content } = stripBom(rawContent);
    const normalizedContent = normalizeToLF(content);
    const result = await applyEdits(normalizedContent, edits, path);
    return generateDiffString(result.baseContent, result.newContent);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
