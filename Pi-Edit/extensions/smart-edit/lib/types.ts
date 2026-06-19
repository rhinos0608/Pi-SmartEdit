/**
 * Types for the smart-edit Pi extension.
 *
 * Mirrors and extends Pi's built-in edit tool schema with:
 * - replaceAll: replace every occurrence of oldText
 * - description: echoed in error messages for model self-reference
 */

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

// ─── Target / Anchor types ────────────────────────────────────────────

/**
 * Unified edit target combining anchor scoping and symbolic edit operations.
 * When used with oldText/newText: scopes the text search within the symbol's byte range.
 * When used with replaceBody/insertBefore/insertAfter: operates on the whole symbol.
 * Provide at most one of replaceBody, insertBefore, or insertAfter.
 */
export interface EditTarget {
  /** Symbol name to target (e.g., function name, class name). */
  name?: string;

  /** Qualified symbol path; the final component is matched by AST name
   * (e.g., 'MyClass.myMethod'). */
  namePath?: string;

  /** AST node kind hint (e.g., 'function_declaration', 'class_declaration'). */
  kind?: string;

  /** 1-based line hint for disambiguation when multiple symbols share a name. */
  line?: number;

  /** Replace the entire AST symbol definition with this text. */
  replaceBody?: string;

  /** Insert this text immediately before the AST symbol definition. */
  insertBefore?: string;

  /** Insert this text immediately after the AST symbol definition. */
  insertAfter?: string;

  /** Optional label echoed in diagnostics for model self-reference. */
  description?: string;
}

/**
 * Target for symbolic edits only (replaceBody/insertBefore/insertAfter).
 * Kept for internal use by symbolic-edits.ts pipeline.
 */
export type SymbolEditTarget =
  | { readonly name: string; namePath?: string; kind?: string; line?: number }
  | { readonly name?: string; readonly namePath: string; kind?: string; line?: number };

export type EditCapability =
  | "oldText"
  | "replaceAll"
  | "astAnchor"
  | "hashline"
  | "symbolicEdit"
  | "lspDiagnostics"
  | "compilerDiagnostics"
  | "scopedDiagnostics";

export interface EditItem {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  description?: string;

  /** Unified target: anchor scoping (name/kind/line) + optional symbolic operation.
   *  Anchor: oldText/newText matched within the symbol's byte range.
   *  Symbolic: replaceBody/insertBefore/insertAfter operate on the whole symbol.
   *  Backwards compat: old anchor/symbol fields are converted to target in prepareArguments(). */
  target?: EditTarget;
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
  /** Numeric fuzz: 0=exact, 1=indent, 2=unicode, 3=similarity, 4=dotdotdots, 5=relative_indent, -1=no match found */
  numericFuzz: number;
}

export enum MatchTier {
  EXACT = "exact",
  INDENTATION = "indentation",
  UNICODE = "unicode",
  COMMENT_PREFIX = "comment_prefix",
  SIMILARITY = "similarity",
  DOTDOTDOTS = "dotdotdots",
  RELATIVE_INDENT = "relative_indent",
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

  /** The 1-based file line offset for this snapshot.
   *  For full-file reads (offset=1), display line N matches file line N.
   *  For offset/limit reads (offset=70), display line 1 describes file line 70.
   *  Hashline validation uses this to translate relative display line numbers
   *  (what the model sees in read output) to absolute file line numbers.
   *  Defaults to 1 (no translation needed). */
  readOffset: number;

  /** Hashline anchor data, populated on read when hashline is enabled.
   *  Maps LINE+ID anchor strings (e.g. "42ab") to line text + line number.
   *  Anchor line numbers are RELATIVE to the read offset, matching what
   *  the model sees in read output (display line number, not absolute).
   *  Used by hashline edit mode to validate freshness and reconstruct oldText. */
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
    /**
     * Absolute paths of files mutated by this edit, emitted so
     * the context optimizer can trigger semantic cache invalidation
     * without re-parsing tool result text.
     *
     * Integration: consumed by Pi Context Optimizer's tool_result
     * handler to mark affected paths for cache invalidation.
     */
    mutatedPaths?: string[];
    /**
     * Structured post-edit diagnostics from LSP/compiler checks.
     * Emitted so the context optimizer's tool_result handler can
     * classify errors as high-confidence "current-failure" class
     * with exact file+line context, rather than re-parsing from
     * unstructured text.
     *
     * Mirrors the Diagnostic interface from src/lsp/diagnostics.ts
     * and src/lsp/diagnostic-dispatcher.ts.
     */
    diagnostics?: Array<{
      message: string;
      severity: 1 | 2 | 3 | 4;
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
      source?: string;
      filePath?: string;
    }>;
    editCapabilities?: EditCapability[];
    scopedDiagnostics?: Array<{
      diagnostic: {
        message: string;
        severity: 1 | 2 | 3 | 4;
        range: { start: { line: number; character: number }; end: { line: number; character: number } };
        source?: string;
        filePath?: string;
      };
      scope: "edited-symbol" | "referencing-symbol" | "same-file" | "other-file";
      targetName?: string;
      referenceCount?: number;
    }>;
  };
}

import { createHash } from "crypto";

/**
 * Fast content hash using SHA-256 truncated to 16 hex chars.
 * Provides sub-ms hashing for typical source files.
 * Uses crypto SHA-256 for portability (no native addon dependency).
 * Truncation makes it suitable for content comparison, not cryptographic use.
 */

export function fastHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
/** Backwards-compatible AST anchor shape used by hashline scoped fallback. */
export interface EditAnchor {
  symbolName?: string;
  symbolKind?: string;
  symbolLine?: number;
}
