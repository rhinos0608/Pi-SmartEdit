/**
 * Hashline-anchored edit application layer.
 *
 * Mirrors oh-my-pi's hashline.ts (can1357/oh-my-pi).
 *
 * Core concept: instead of asking the LLM to reproduce text (oldText),
 * edits reference LINE+ID anchors (e.g., "42ab") that are pre-computed
 * on read. Hashes serve as freshness checks — if the file changed since
 */

import type { EditAnchor, FileSnapshot } from "../core/types";
import { initHashline } from "./hashline";
import {
  formatAnchor,
  parseTag,
  type Anchor,
  type HashlineEditOp,
} from "./hashline-anchor";

export {
  ANCHOR_RE,
  ANCHOR_REBASE_WINDOW,
  LINE_ONLY_ANCHOR_RE,
  formatAnchor,
  getAnchorStrings,
  parseTag,
  rebaseEdit,
  tryRebaseAll,
  tryRebaseAnchor,
} from "./hashline-anchor";
export type { Anchor, HashlineEditOp } from "./hashline-anchor";

// Anchor leaf (Anchor, HashlineEditOp, parsing, rebase) lives in
// ./hashline-anchor and is re-exported above.

// Hash-mismatch types (HashMismatch, ValidationResult) live in
// ./hashline-validate and are re-exported below.

// Apply leaf (ApplyResult, applyHashlineEdits) lives in
// ./hashline-apply and is re-exported below.
import {
  applyHashlineEdits,
} from "./hashline-apply";
export {
  applyHashlineEdits,
} from "./hashline-apply";
export type { ApplyResult } from "./hashline-apply";

// (ValidationResult lives in ./hashline-validate — see re-exports below.)

// Anchor leaf (parsing, rebase) moved to ./hashline-anchor — see re-exports above.

// Content-normalization + resolution leaf (regexes, prefix stripping, text
// parsing, raw-edit resolution) lives in ./hashline-content and is
// re-exported below.
import {
  hashlineParseText,
  resolveHashlineEdits,
} from "./hashline-content";
export {
  hashlineParseText,
  resolveHashlineEdits,
  stripNewLinePrefixes,
} from "./hashline-content";

// Validation + mismatch-error leaf (validateHashlineEdits,
// HashlineMismatchError, mismatch message builders) lives in
// ./hashline-validate and is re-exported below.
import {
  HashlineMismatchError,
  validateHashlineEdits,
} from "./hashline-validate";
export {
  HashlineMismatchError,
  validateHashlineEdits,
} from "./hashline-validate";
export type { HashMismatch, ValidationResult } from "./hashline-validate";

import {
  checkHashlineSnapshotProvenance,
  HashlineAnchorProvenanceError,
  tryRecoverHashlineEdits,
} from "./hashline-recovery";
import {
  HashlineStructuralContextError,
  type StructuralRecoveryCheck,
} from "./hashline-structure.js";
export {
  checkHashlineSnapshotProvenance,
  HashlineAnchorProvenanceError,
  tryRecoverHashlineEdit,
  tryRecoverHashlineEdits,
} from "./hashline-recovery";

// Apply logic (applyHashlineEdits, applySingleEdit, getEditEndLine,
// formatEditLoc, linesEqual) moved to ./hashline-apply — see import/re-export above.

// (HashlineMismatchError + buildCliMessage/buildModelMessage/
// formatMismatchContext live in ./hashline-validate — see re-exports above.)

// Fallback-support leaf (symbol anchor parsing, fallback metrics, edit
// location description, match application, oldText reconstruction) lives in
// ./hashline-fallback and is re-exported below.
import {
  applyMatchInPlace,
  countLinesUpToIndex,
  parseSymbolAnchor,
  reconstructOldText,
  recordFallbackTier,
  type FallbackTier,
} from "./hashline-fallback";
export {
  applyMatchInPlace,
  countLinesUpToIndex,
  describeEditLocation,
  getHashlineMetrics,
  hashlineMetrics,
  parseSymbolAnchor,
  reconstructOldText,
  reconstructOldTextByLine,
  recordFallbackTier,
  resetHashlineMetrics,
} from "./hashline-fallback";
export type { FallbackTier, HashlineMetrics } from "./hashline-fallback";

/**
 * Raw hashline edit input from the LLM/tool call.
 * This is the external-facing type; internally we convert to HashlineEditOp.
 */
export interface HashlineEditInput {
  anchor?: {
    /** Optional AST symbol scoping hint.
     *  If provided, stale hashline anchors fall back to scoped fuzzy matching
     *  within the symbol's byte range instead of the full 4-tier pipeline. */
    symbol?: {
      /** Name of the enclosing symbol (function, class, etc.) */
      name: string;
      /** Kind of symbol (e.g., 'function', 'method', 'class'). */
      kind?: string;
      /** 1-based line number hint for where the symbol's name appears. */
      line?: number;
    };
    /** Hashline-anchored range */
    range: {
      /** Start anchor: LINE+HASH of the first line to edit (inclusive). */
      pos: string;
      /** End anchor: LINE+HASH of the last line to edit (inclusive). */
      end: string;
    };
  };
  /** Replacement lines (string[] — one per logical line) or null/undefined to delete. */
  content?: string[] | string | null;
}

// ─── applyHashlinePath — Main Routing Function ─────────────────────────────

/**
 * Result of applyHashlinePath.
 * Contains the resulting content AND which fallback tier was used.
 */
export interface ApplyHashlinePathResult {
  /** The resulting file content */
  newContent: string;
  /** Which resolution tier succeeded */
  tier: Exclude<FallbackTier, "hash-mismatch-reject">;
  /** Warning messages (rebased anchors, fallthrough notes) */
  warnings: string[];
  /** 1-based line number of the first changed line */
  firstChangedLine: number | undefined;
  /** The resolved HashlineEditOp(s) that were applied (for caller bookkeeping) */
  appliedOps: HashlineEditOp[];
}

/**
 * Main routing function for hashline-anchored edits.
 *
 * Tries in order:
 *  1. Hashline direct apply (fast path, ~90% of edits)
 *  2. Hashline rebase (file shifted, ±5 window)
 *  3. Scoped fallback (hash stale, symbol provided → AST-scoped 4-tier)
 *  4. Full fuzzy fallback (all hashline paths failed → full 4-tier safety net)
 *
 * @param input     Parsed hashline input (from LLM/tool call)
 * @param fileContent Current file content (LF-normalized)
 * @param snapshot   FileSnapshot from read cache (for oldText reconstruction)
 * @param resolveScopeFn  Function to resolve EditAnchor → SearchScope via AST.
 *                       Signature: (anchor: EditAnchor, content: string, path: string)
 *                       → Promise<SearchScope | null>
 * @param findTextFn   The 4-tier findText function from edit-diff.ts.
 * @param detectIndentFn The detectIndentation function from edit-diff.ts.
 * @returns ApplyHashlinePathResult with newContent, tier, warnings, firstChangedLine.
 * @throws HashlineMismatchError if hashes genuinely don't match and no fallback resolves.
 */
export async function applyHashlinePath(
  input: HashlineEditInput,
  fileContent: string,
  snapshot: FileSnapshot | null,
  resolveScopeFn: (
    anchor: EditAnchor,
    content: string,
    path: string,
  ) => Promise<{ startIndex: number; endIndex: number; description: string } | null>,
  findTextFn: (
    content: string,
    oldText: string,
    indentStyle: { char: "\t" | " "; width: number },
    startOffset?: number,
    scope?: { startIndex: number; endIndex: number; description: string },
  ) => {
    found: boolean;
    index: number;
    matchLength: number;
    tier: string;
    usedFuzzyMatch: boolean;
    matchedText: string;
    matchNote?: string;
  },
  detectIndentFn: (content: string) => { char: "\t" | " "; width: number },
  verifyRecoveryStructureFn?: (args: {
    original: HashlineEditOp;
    recovered: HashlineEditOp;
    currentContent: string;
    snapshot: FileSnapshot;
  }) => Promise<StructuralRecoveryCheck>,
): Promise<ApplyHashlinePathResult> {
  // Validation and rebasing intentionally use the synchronous hash API. Make
  // its initialization an explicit invariant of the async routing boundary
  // instead of relying on an earlier read path to have warmed xxhash-wasm.
  await initHashline();

  const warnings: string[] = [];

  // ── Step 1: Resolve hashline edits ──────────────────────────────────────────
  const resolvedEdits = resolveHashlineEdits([{ ...input, content: input.content ?? null }], true);
  if (resolvedEdits.length === 0) {
    return {
      newContent: fileContent,
      tier: "hashline-direct",
      warnings: [],
      firstChangedLine: undefined,
      appliedOps: [],
    };
  }
  // ── Normalize anchor line numbers for offset reads ────────────────
  // Anchors are built with absolute line numbers (via buildHashlineAnchors(lines, readOffset))
  // so no adjustment needed — the parsed anchor line numbers already match the file.
  // ── Step 2: Verify anchor provenance, then validate live hashes ──────────────
  // A retained hashline read lets us reject model-spliced LINE+ID tokens even
  // when their short hash suffix happens to be syntactically valid.
  const provenance = checkHashlineSnapshotProvenance(resolvedEdits, snapshot);
  if (!provenance.valid) {
    recordFallbackTier("hash-mismatch-reject");
    throw new HashlineAnchorProvenanceError(provenance.missing);
  }

  const fileLines = fileContent.split("\n");
  const validation = validateHashlineEdits(resolvedEdits, fileLines);

  if (validation.valid) {
    // ── FAST PATH: All hashes match ──────────────────────────────────────────
    const result = applyHashlineEdits(fileContent, resolvedEdits);
    recordFallbackTier("hashline-direct");
    return {
      newContent: result.lines,
      tier: "hashline-direct",
      warnings: result.warnings ?? [],
      firstChangedLine: result.firstChangedLine,
      appliedOps: resolvedEdits,
    };
  }

  // ── Step 3: Snapshot-proven recovery of coherent line drift ───────────────
  // Never relocate an edit merely because a two-letter hash occurs nearby.
  // Recovery requires the authored token to exist in the retained read,
  // byte-identical target text, a uniform shift, and neighbouring context.
  const rebaseResult = tryRecoverHashlineEdits(resolvedEdits, fileLines, snapshot);

  if (rebaseResult.allResolved) {
    if (verifyRecoveryStructureFn && snapshot) {
      for (let i = 0; i < resolvedEdits.length; i++) {
        const structural = await verifyRecoveryStructureFn({
          original: resolvedEdits[i],
          recovered: rebaseResult.recoveredEdits[i],
          currentContent: fileContent,
          snapshot,
        });
        if (structural.checked && !structural.ok) {
          recordFallbackTier("hash-mismatch-reject");
          throw new HashlineStructuralContextError(structural.reason);
        }
        if (structural.checked && structural.ok) {
          rebaseResult.warnings.push(
            `Structural recovery context preserved: ${structural.fingerprint}.`,
          );
        }
      }
    }
    const result = applyHashlineEdits(fileContent, rebaseResult.recoveredEdits);
    recordFallbackTier("hashline-rebased");
    return {
      newContent: result.lines,
      tier: "hashline-rebased",
      warnings: [...rebaseResult.warnings],
      firstChangedLine: result.firstChangedLine,
      appliedOps: rebaseResult.recoveredEdits,
    };
  }

  // ── Step 4: Try scoped fallback (AST symbol + 4-tier within scope) ─────────
  if (input.anchor?.symbol && resolveScopeFn) {
    const symbolAnchor = parseSymbolAnchor(input.anchor.symbol);
    if (symbolAnchor) {
      const scope = await resolveScopeFn(symbolAnchor, fileContent, "");

      if (scope) {
        // Reconstruct oldText from cache
        const posStr = input.anchor.range.pos;
        const endStr = input.anchor.range.end;
        const oldText = snapshot
          ? reconstructOldText(snapshot, posStr, endStr)
          : null;

        if (oldText !== null) {
          // Run 4-tier matching within symbol scope
          const indentStyle = detectIndentFn(fileContent);
          const match = findTextFn(
            fileContent,
            oldText,
            indentStyle,
            0,
            scope,
          );

          if (match.found) {
            // Apply the match
            const newLines = hashlineParseText(input.content ?? []) ?? [];
            const newContent = applyMatchInPlace(fileContent, match, newLines);
            const firstChangedLine = countLinesUpToIndex(fileContent, match.index);

            recordFallbackTier("scoped-fallback");
            warnings.push(
              `Hashline anchors stale; resolved via AST scoping to "${scope.description}". ` +
              `Matched via ${match.tier} tier${match.matchNote ? ` (${match.matchNote})` : ""}.`
            );

            return {
              newContent,
              tier: "scoped-fallback",
              warnings,
              firstChangedLine,
              appliedOps: resolvedEdits,
            };
          }
        }
      }
    }
  }

  // ── Step 5: Full fuzzy fallback (full 4-tier pipeline) ───────────────────────
  const posStr = input.anchor?.range?.pos ?? "";
  const endStr = input.anchor?.range?.end ?? "";
  const oldText = snapshot ? reconstructOldText(snapshot, posStr, endStr) : null;

  if (oldText === null) {
    // Cannot reconstruct oldText — throw mismatch error with corrected anchors
    recordFallbackTier("hash-mismatch-reject");
    throw new HashlineMismatchError(validation.mismatches, fileLines, false);
  }

  // Run full 4-tier pipeline (no scope restriction)
  const indentStyle = detectIndentFn(fileContent);
  const match = findTextFn(fileContent, oldText, indentStyle);

  if (!match.found) {
    // Even full fuzzy failed — throw mismatch error
    recordFallbackTier("hash-mismatch-reject");
    throw new HashlineMismatchError(validation.mismatches, fileLines, false);
  }

  // Apply the match
  const newLines = hashlineParseText(input.content ?? []) ?? [];
  const newContent = applyMatchInPlace(fileContent, match, newLines);
  const firstChangedLine = countLinesUpToIndex(fileContent, match.index);

  recordFallbackTier("full-fuzzy-fallback");
  warnings.push(
    `Edit fell through to full fuzzy matching (hashline anchors stale and ` +
    `AST scoping unavailable). Matched via ${match.tier} tier${match.matchNote ? ` (${match.matchNote})` : ""}.`
  );

  return {
    newContent,
    tier: "full-fuzzy-fallback",
    warnings,
    firstChangedLine,
    appliedOps: resolvedEdits,
  };
}
