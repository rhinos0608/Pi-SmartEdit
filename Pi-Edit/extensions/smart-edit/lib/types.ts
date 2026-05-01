/**
 * Types for the smart-edit Pi extension.
 *
 * Mirrors and extends Pi's built-in edit tool schema with:
 * - replaceAll: replace every occurrence of oldText
 * - description: echoed in error messages for model self-reference
 */

/** AST-based disambiguation hint for the edit */
export interface EditAnchor {
  /** Name of the enclosing symbol (e.g., "handleRequest", "MyClass") */
  symbolName?: string;

  /** Kind of symbol to filter by (e.g., "function_declaration", "class_declaration")
   *  If omitted, all symbol kinds matching the name are considered. */
  symbolKind?: string;

  /** 1-based line number hint for where the symbol's NAME appears.
   *  Requires symbolName to be set. Used to disambiguate symbols with the same name. */
  symbolLine?: number;
}

/** Line-range hint to narrow the search scope for oldText matching */
export interface LineRange {
  /** 1-based start line (inclusive). Refers to file as last read. */
  startLine: number;

  /** 1-based end line (inclusive). Defaults to startLine if omitted. */
  endLine?: number;
}

/** Search scope that narrows where findText searches for oldText */
export interface SearchScope {
  /** Byte offset into the content where searching begins */
  startIndex: number;
  /** Byte offset into the content where searching ends (exclusive) */
  endIndex: number;
  /** Human-readable description of the scope for diagnostics */
  description: string;
  /** Whether this scope was inferred from AST (anchor) or line range */
  source: "anchor" | "lineRange" | "intersection";
}

export interface EditItem {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  description?: string;

  /** AST-based disambiguation hint. If provided, oldText must match
   *  within the byte range of the described AST node. */
  anchor?: EditAnchor;

  /** Line-range hint to narrow the search scope for oldText matching.
   *  When provided, oldText is only searched within the specified line range.
   *  If not found, falls back to whole-file search with a matchNote. */
  lineRange?: LineRange;
}

export interface EditInput {
  path: string;
  edits: EditItem[];
}

export interface MatchResult {
  /** Whether the match was found */
  found: boolean;
  /** Byte offset into original (LF-normalized) content */
  index: number;
  /** Length of the match in the original content */
  matchLength: number;
  /** Which tier produced the match */
  tier: MatchTier;
  /** Whether the match used fuzzy matching */
  usedFuzzyMatch: boolean;
  /** The actual text matched in the content (may differ from oldText on fuzzy match) */
  matchedText: string;
  /** Human-readable note about how matching was achieved, if fuzzy */
  matchNote?: string;
}

export enum MatchTier {
  EXACT = "exact",
  INDENTATION = "indentation",
  UNICODE = "unicode",
  SIMILARITY = "similarity",  // deferred
}

export interface MatchSpan {
  editIndex: number;
  matchIndex: number;      // byte offset into original content
  matchLength: number;     // length in original content
  newText: string;
  tier: MatchTier;
  matchNote?: string;
  replaceAll: boolean;
  description?: string;
}

export interface IndentationStyle {
  /** "\t" or " " */
  char: "\t" | " ";
  /** Width in characters (1 for tabs, 2/4/8 for spaces) */
  width: number;
}

export interface ClosestMatchDiagnostic {
  lineStart: number;
  lineEnd: number;
  similarity: number;      // 0.0 to 1.0
  expectedText: string;
  foundText: string;
  hint: string;
}

/** Conflict detection types */

export interface ConflictDetectionConfig {
  /** Enable semantic conflict detection (default: true when AST available) */
  enabled: boolean;

  /** Behavior when a conflict is detected */
  onConflict: "warn" | "error" | "auto-reread";

  /** Whether to detect conflicts across ALL previous edits or only the most recent */
  scope: "all" | "last";
}

/** Reference to a code symbol (used by conflict detector) */
export interface SymbolRef {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  startByte: number;
  endByte: number;
}

/** Record of an edit applied to a symbol */
export interface SymbolEditRecord {
  /** The symbol that was edited */
  symbol: SymbolRef;

  /** When the edit was applied (monotonic counter) */
  turn: number;

  /** The byte range of the edit within the symbol */
  editRange: { startIndex: number; endIndex: number };

  /** The description from the edit item */
  description?: string;
}

/** Report of a semantic conflict between edit calls */
export interface ConflictReport {
  /** The symbol that was previously edited */
  previousSymbol: SymbolRef;

  /** The edit that was previously applied */
  previousEdit: {
    turn: number;
    description?: string;
  };

  /** The symbol being targeted by the current edit */
  currentSymbol: SymbolRef;

  /** Relationship between the two symbols */
  relationship: "same" | "contains" | "contained-by" | "sibling-overlap";

  /** Suggested action */
  suggestion: string;
}

export interface FileSnapshot {
  path: string;
  mtimeMs: number;
  size: number;
  contentHash: string;
  readAt: number;
  /** True if the read result was partial (truncated output or user-specified offset/limit).
   *  Partial snapshots skip content hash and size comparison in stale checks,
   *  falling back to mtime-only verification. */
  partial?: boolean;

  /** Hashline anchor data, populated on read when hashline is enabled.
   *  Maps LINE+ID anchor strings (e.g. "42ab") to line text + line number.
   *  Used by the hashline edit mode to validate freshness and reconstruct
   *  oldText without requiring the model to reproduce text. */
  hashline?: {
    /** Map from LINE+ID anchor to { text, line } for all lines in the file */
    anchors: Map<string, { text: string; line: number }>;
    /** Formatted lines with hashline prefixes prepended: "42ab|text" */
    formattedLines: string[];
  };
}

export interface EditResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    diff?: string;
    firstChangedLine?: number;
    matchNotes?: string[];
    conflictWarnings?: string[];
  };
}

/**
 * Fast content hash using SHA-256 truncated to 16 hex chars.
 * Provides sub-ms hashing for typical source files.
 * Uses crypto SHA-256 for portability (no native addon dependency).
 * Truncation makes it suitable for content comparison, not cryptographic use.
 */
import { createHash } from "crypto";

export function fastHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
