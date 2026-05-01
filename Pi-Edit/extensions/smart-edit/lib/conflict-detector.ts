/**
 * Conflict Detector — tracks which AST-level scopes have been edited
 * across sequential edit calls and detects semantic conflicts.
 *
 * Problem: Two separate edit calls targeting the same function body
 * don't overlap at the byte level in the original file. When Call 1
 * edits "return user.name" and Call 2 edits "function getUser()",
 * they DON'T overlap (different text regions) but DO conflict
 * semantically (Call 2 renamed the function while Call 1 targets
 * code inside it).
 *
 * The stale-file guard catches externally-modified files, but not
 * the LLM's own prior edits. This detector fills that gap.
 *
 * Architecture:
 * - Created per-session in pi.on("session_start")
 * - Accepts ASTResolver (from ast-resolver.ts) for symbol-level tracking
 * - Falls back to byte-range overlap when AST is unavailable
 * - Two conflict modes implemented: warn | error (auto-reread planned)
 */

import type { EditAnchor } from "./types";
import {
  type ConflictDetectionConfig,
  type ConflictReport,
  type SymbolEditRecord,
  type SymbolRef,
} from "./types";

// Symbol used for fallback line-range tracking when AST is unavailable
interface LineRangeEdit {
  filePath: string;
  startByte: number;
  endByte: number;
  turn: number;
  description?: string;
}

/**
 * Create a ConflictDetector instance.
 *
 * @param config - Conflict detection configuration
 * @param getAstResolver - Optional function that returns an AST resolver
 *   (passed lazily to avoid circular dependency issues per FIX-4).
 *   Returns null if AST resolution is unavailable for the current file.
 */
export function createConflictDetector(
  config: ConflictDetectionConfig = {
    enabled: true,
    onConflict: "warn",
    scope: "all",
  },
  getAstResolver?: () => {
    parseFile(content: string, filePath: string): Promise<{
      tree: {
        rootNode: { hasError: boolean; walk: () => unknown };
        delete: () => void;
      };
      parser: { delete: () => void };
    } | null>;
    findEnclosingSymbols(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tree: any,
      startByte: number,
      endByte: number,
    ): SymbolRef[];
    disposeParseResult(result: {
      tree: { delete: () => void };
      parser: { delete: () => void };
    }): void;
  } | null,
) {
  /** Edit history per file: filePath → records */
  const editHistory = new Map<string, SymbolEditRecord[]>();

  /** Fallback line-range history when AST is unavailable */
  const lineRangeHistory = new Map<string, LineRangeEdit[]>();

  /** Monotonic turn counter for the session */
  let turnCounter = 0;

  /**
   * Baseline snapshots for delta mode.
   * Stores a snapshot of edit history per file at the time captureBaseline() was called.
   * Used by checkDeltaConflicts to return only NEW conflicts since baseline.
   */
  const baselineHistory = new Map<string, Set<string>>();

  /**
   * Record that an edit was applied to a set of symbols in a file.
   * Called AFTER a successful edit application.
   */
  async function recordEdit(
    filePath: string,
    content: string,
    editSpans: Array<{ startIndex: number; endIndex: number }>,
    editDescription?: string,
  ): Promise<void> {
    turnCounter++;

    const resolver = getAstResolver?.();
    const hasResolver = resolver != null && config.enabled;

    // Parse the file ONCE and share across all span checks.
    // Avoids re-parsing N times for N edit spans.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sharedParseResult: Awaited<ReturnType<NonNullable<typeof resolver>['parseFile']>> | null = null;
    if (hasResolver) {
      try {
        sharedParseResult = await resolver.parseFile(content, filePath);
      } catch {
        // Parse failed — will fall through to line-range fallback
      }
    }

    try {
      for (const span of editSpans) {
        // Try AST-based symbol resolution first
        if (hasResolver && sharedParseResult && !sharedParseResult.tree.rootNode.hasError) {
          const symbols = resolver.findEnclosingSymbols(
            sharedParseResult.tree,
            span.startIndex,
            span.endIndex,
          );

          for (const symbol of symbols) {
            const record: SymbolEditRecord = {
              symbol,
              turn: turnCounter,
              editRange: { startIndex: span.startIndex, endIndex: span.endIndex },
              description: editDescription,
            };

            const existing = editHistory.get(filePath) ?? [];
            existing.push(record);
            editHistory.set(filePath, existing);
          }
          continue; // Skip line-range fallback for this span
        }

        // Fallback: line-range tracking (byte level)
        const lineRecord: LineRangeEdit = {
          filePath,
          startByte: span.startIndex,
          endByte: span.endIndex,
          turn: turnCounter,
          description: editDescription,
        };

        const existing = lineRangeHistory.get(filePath) ?? [];
        existing.push(lineRecord);
        lineRangeHistory.set(filePath, existing);
      }
    } finally {
      if (sharedParseResult) {
        resolver?.disposeParseResult(sharedParseResult);
      }
    }
  }

  /**
   * Check if a proposed edit would conflict with previous edits.
   * Called BEFORE applying the edit.
   *
   * @returns Array of conflict reports (empty if no conflicts)
   */
  async function checkConflicts(
    filePath: string,
    content: string,
    editSpans: Array<{ startIndex: number; endIndex: number }>,
  ): Promise<ConflictReport[]> {
    if (!config.enabled) return [];

    const reports: ConflictReport[] = [];
    const resolver = getAstResolver?.();
    const hasResolver = resolver != null;

    // Parse the file ONCE and share across all span checks.
    // This avoids re-parsing N times for N edit spans.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sharedParseResult: Awaited<ReturnType<NonNullable<typeof resolver>['parseFile']>> | null = null;
    if (hasResolver) {
      try {
        sharedParseResult = await resolver.parseFile(content, filePath);
      } catch {
        // Parse failed — will fall through to line-range checks below
      }
    }

    try {
      for (const span of editSpans) {
        // Try AST-based checking with the shared parse result
        if (hasResolver && sharedParseResult && !sharedParseResult.tree.rootNode.hasError) {
          const localReports = checkAstConflictsFromTree(
            resolver,
            filePath,
            content,
            span,
            sharedParseResult,
          );
          reports.push(...localReports);
        }

        // Also check line-range conflicts (complementary — catches
        // things AST might miss when parse fails)
        const localReports = checkLineRangeConflicts(filePath, span);
        reports.push(...localReports);
      }
    } finally {
      if (sharedParseResult) {
        resolver?.disposeParseResult(sharedParseResult);
      }
    }

    return reports;
  }

  /**
   * Check AST-level symbol conflicts using a pre-parsed syntax tree.
   * The parse result is provided by the caller (checkConflicts) so it
   * is shared across all span checks — avoiding N parses for N spans.
   */
  function checkAstConflictsFromTree(
    resolver: NonNullable<Exclude<typeof getAstResolver, null | undefined>> extends (...args: any[]) => infer R ? NonNullable<R> : never,
    filePath: string,
    _content: string,
    span: { startIndex: number; endIndex: number },
    parseResult: NonNullable<Awaited<ReturnType<typeof resolver.parseFile>>>,
  ): ConflictReport[] {
    const reports: ConflictReport[] = [];
    const fileHistory = editHistory.get(filePath);
    if (!fileHistory || fileHistory.length === 0) return [];

    const currentSymbols = resolver.findEnclosingSymbols(
      parseResult.tree,
      span.startIndex,
      span.endIndex,
    );

    if (currentSymbols.length === 0) return [];

    // Check each current symbol against the edit history
    for (const currentSymbol of currentSymbols) {
      // For "all" scope, check ALL previous edits
      // For "last" scope, only check the most recent edit
      const relevantHistory =
        config.scope === "last"
          ? getLastEditForFile(fileHistory)
          : fileHistory;

      for (const record of relevantHistory) {
        const rel = getRelationship(record.symbol, currentSymbol);

        if (rel === "none") continue;

        reports.push({
          previousSymbol: record.symbol,
          previousEdit: {
            turn: record.turn,
            description: record.description,
          },
          currentSymbol,
          relationship: rel,
          suggestion: buildSuggestion(rel, currentSymbol, record),
        });

        // In "last" scope, only check each current symbol once
        if (config.scope === "last") break;
      }
    }

    return reports;
  }

  /**
   * Check line-range (byte overlap) conflicts.
   * Fallback when AST is unavailable — simpler but still useful.
   */
  function checkLineRangeConflicts(
    filePath: string,
    span: { startIndex: number; endIndex: number },
  ): ConflictReport[] {
    const reports: ConflictReport[] = [];
    const fileHistory = lineRangeHistory.get(filePath);
    if (!fileHistory || fileHistory.length === 0) return [];

    const relevantHistory =
      config.scope === "last"
        ? getLastLineEditForFile(fileHistory)
        : fileHistory;

    for (const record of relevantHistory) {
      // Check for byte-range overlap
      if (
        span.startIndex < record.endByte &&
        span.endIndex > record.startByte
      ) {
        reports.push({
          previousSymbol: {
            name: `<byte-range>`,
            kind: "byte_range",
            lineStart: -1,
            lineEnd: -1,
            startByte: record.startByte,
            endByte: record.endByte,
          },
          previousEdit: {
            turn: record.turn,
            description: record.description,
          },
          currentSymbol: {
            name: `<byte-range>`,
            kind: "byte_range",
            lineStart: -1,
            lineEnd: -1,
            startByte: span.startIndex,
            endByte: span.endIndex,
          },
          relationship: "same",
          suggestion:
            `This edit overlaps with the previous edit (turn ${record.turn}). ` +
            `Consider re-reading the file to get updated content.`,
        });
      }
    }

    return reports;
  }

  /**
   * Get only the most recent edit for each symbol.
   *
   * KNOWN GAP: Keyed by `name:kind`, so if the second edit renames
   * the function (newText changes the function name), the key changes
   * and the next conflict check will look for the old name in the
   * now-stale pre-edit AST. Since checkConflicts uses pre-edit file
   * content, the renamed function won't match by name, so the conflict
   * goes undetected. This is an inherent limitation of pre-edit-based
   * conflict detection.
   */
  function getLastEditForFile(
    history: SymbolEditRecord[],
  ): SymbolEditRecord[] {
    const lastTurns = new Map<string, SymbolEditRecord>();
    for (const record of history) {
      const key = `${record.symbol.name}:${record.symbol.kind}`;
      const existing = lastTurns.get(key);
      if (!existing || record.turn > existing.turn) {
        lastTurns.set(key, record);
      }
    }
    return Array.from(lastTurns.values());
  }

  /**
   * Get only the most recent line-range edit.
   */
  function getLastLineEditForFile(
    history: LineRangeEdit[],
  ): LineRangeEdit[] {
    if (history.length === 0) return [];
    // Return only the latest entry
    const sorted = [...history].sort((a, b) => b.turn - a.turn);
    return [sorted[0]];
  }

  /**
   * Clear history for a file (e.g., after a fresh read).
   */
  function clearForFile(filePath: string): void {
    editHistory.delete(filePath);
    lineRangeHistory.delete(filePath);
  }

  /**
   * Clear all history.
   */
  function clearAll(): void {
    editHistory.clear();
    lineRangeHistory.clear();
    baselineHistory.clear();
    turnCounter = 0;
  }

  // ─── Delta mode (P3: pi-lens delta pattern) ─────────────────────

  /**
   * Capture a baseline snapshot of the current edit history state.
   * After calling captureBaseline, subsequent checkDeltaConflicts calls
   * will only report conflicts involving edits that were ADDED after
   * this baseline.
   *
   * Call before the first edit to a file to suppress stale conflict
   * reports from previous session history.
   *
   * The baseline is a Set of "symbolName:symbolKind" keys representing
   * the edits that existed at the time of capture. Any new edit that
   * creates a conflict with a symbol NOT in this set is reported as new.
   */
  function captureBaseline(filePath: string): void {
    const history = editHistory.get(filePath);
    const baseline = new Set<string>();

    if (history) {
      for (const record of history) {
        baseline.add(`${record.symbol.name}:${record.symbol.kind}`);
      }
    }

    // Also capture line-range history baseline
    const lineHistory = lineRangeHistory.get(filePath);
    if (lineHistory) {
      for (const record of lineHistory) {
        baseline.add(`byte-range:${record.turn}`);
      }
    }

    baselineHistory.set(filePath, baseline);
  }

  /**
   * Clear the baseline for a file (forces fresh capture on next call).
   */
  function clearBaseline(filePath: string): void {
    baselineHistory.delete(filePath);
  }

  /**
   * Check conflicts, returning only NEW conflicts since the last baseline.
   *
   * If no baseline has been captured for this file, returns all conflicts
   * (same as checkConflicts). Call captureBaseline() first to enable delta mode.
   */
  async function checkDeltaConflicts(
    filePath: string,
    content: string,
    editSpans: Array<{ startIndex: number; endIndex: number }>,
  ): Promise<ConflictReport[]> {
    // Get all conflicts (existing logic)
    const allConflicts = await checkConflicts(filePath, content, editSpans);

    // No baseline — return all conflicts (first-time warning)
    const baseline = baselineHistory.get(filePath);
    if (!baseline) return allConflicts;

    // Filter to only NEW conflicts (involving symbols not in baseline)
    const newConflicts = allConflicts.filter((c) => {
      const key = `${c.previousSymbol.name}:${c.previousSymbol.kind}`;
      return !baseline.has(key);
    });

    return newConflicts;
  }

  return {
    recordEdit,
    checkConflicts,
    checkDeltaConflicts,
    captureBaseline,
    clearBaseline,
    clearForFile,
    clearAll,
  };
}

// ─── Private helpers ────────────────────────────────────────────────

/**
 * Determine the semantic relationship between two symbols.
 */
function getRelationship(
  previous: SymbolRef,
  current: SymbolRef,
): "same" | "contains" | "contained-by" | "sibling-overlap" | "none" {
  // Same symbol (name + kind match)
  if (previous.name === current.name && previous.kind === current.kind) {
    return "same";
  }

  // Previous symbol contains current
  if (
    previous.startByte <= current.startByte &&
    previous.endByte >= current.endByte
  ) {
    return "contains";
  }

  // Current symbol contains previous (current is broader)
  if (
    current.startByte <= previous.startByte &&
    current.endByte >= previous.endByte
  ) {
    return "contained-by";
  }

  // Overlap but neither fully contains the other
  if (
    current.startByte < previous.endByte &&
    current.endByte > previous.startByte
  ) {
    return "sibling-overlap";
  }

  return "none";
}

/**
 * Build a human-readable suggestion message.
 */
function buildSuggestion(
  rel: string,
  currentSymbol: SymbolRef,
  record: SymbolEditRecord,
): string {
  switch (rel) {
    case "same":
      return (
        `"${currentSymbol.name}" (${currentSymbol.kind}, lines ${currentSymbol.lineStart}-${currentSymbol.lineEnd}) ` +
        `was already modified in turn ${record.turn}` +
        (record.description ? ` (${record.description})` : "") +
        `. Re-read the file and combine changes into a single edit call.`
      );
    case "contains":
      return (
        `This edit targets "${currentSymbol.name}" which is inside ` +
        `"${record.symbol.name}" (${record.symbol.kind}) modified in turn ${record.turn}. ` +
        `The parent scope may have changed.`
      );
    case "contained-by":
      return (
        `This edit targets a broader scope "${currentSymbol.name}" which contains ` +
        `"${record.symbol.name}" modified in turn ${record.turn}. ` +
        `The inner symbol may have changed.`
      );
    case "sibling-overlap":
      return (
        `This edit partially overlaps with a previous edit to ` +
        `"${record.symbol.name}" (turn ${record.turn}).`
      );
    default:
      return "Consider re-reading the file.";
  }
}

/**
 * Default configuration for conflict detection.
 */
export const defaultConflictConfig: ConflictDetectionConfig = {
  enabled: true,
  onConflict: "warn",
  scope: "all",
};
