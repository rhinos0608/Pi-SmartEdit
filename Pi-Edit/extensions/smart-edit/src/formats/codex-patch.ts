/**
 * Recursive-descent parser for Codex apply_patch format.
 * 
 * Grammar (BNF):
 *   patch           = [ preamble ] , envelope-start , newline , { section } , [ envelope-end ] , [ postamble ]
 *   section         = add-section | delete-section | update-section
 *   add-section     = "*** Add File:" , ws , path , newline , { contents-line }
 *   delete-section  = "*** Delete File:" , ws , path , newline
 *   update-section  = "*** Update File:" , ws , path , newline , [ "*** Move to:" , ws , path , newline ] , { hunk }
 *   hunk            = "@@" , [ ws , hunk-scope ] , newline , { hunk-line }
 *   hunk-line       = context-line | removed-line | added-line
 *   context-line    = " " , text
 *   removed-line    = "-" , text
 *   added-line      = "+" , text
 *
 * Inspired by: codex-rs/apply-patch/src/parser.rs
 */

// ─── Types ──────────────────────────────────────────────────────────

/**
 * The three operations Codex's apply_patch grammar supports.
 * Mirrors the Hunk enum from codex-rs/apply-patch/src/parser.rs.
 */
export type CodexHunk =
  | { kind: 'AddFile'; path: string; contents: string }
  | { kind: 'DeleteFile'; path: string }
  | { kind: 'UpdateFile'; path: string; movePath?: string; chunks: UpdateFileChunk[] };

/**
 * A single @@-delimited hunk within an UpdateFile section.
 */
export interface UpdateFileChunk {
  /** Multi-level scope path from @@ chain, e.g. ["class BaseClass", "  def method():"] */
  scope: string[];
  /** Lines prefixed with ' ' (context) */
  contextLines: string[];
  /** Lines prefixed with '-' (removed content) */
  removedLines: string[];
  /** Lines prefixed with '+' (added content) */
  addedLines: string[];
}

export interface PatchWarning {
  message: string;
  line: number;
  kind: 'missing_end_patch' | 'empty_hunk' | 'unknown_marker' | 'lenient_spelling' | 'preamble_skipped';
}

export interface CodexPatchResult {
  /** Parsed hunks, in order of appearance */
  hunks: CodexHunk[];
  /** Warnings accumulated during lenient-mode parsing */
  warnings: PatchWarning[];
}

export type ParseMode = 'strict' | 'lenient';

// ─── Error Types ────────────────────────────────────────────────────

export class PatchParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly column: number,
  ) {
    super(`❌ Codex patch parse error at line ${line}, col ${column}: ${message}`);
    this.name = 'PatchParseError';
  }
}

// ─── Parser ─────────────────────────────────────────────────────────

/**
 * Parse Codex apply_patch format into structured hunks.
 *
 * @param input Raw patch text
 * @param mode  Parse mode (default: lenient)
 * @returns     Parsed hunks and warnings
 */
export function parseCodexPatch(input: string, mode: ParseMode = 'lenient'): CodexPatchResult {
  const parser = new CodexPatchParser(input, mode);
  return parser.parse();
}

/**
 * Extract a bare symbol name and optional kind from a scope string.
 *
 * Strips known kind prefixes from Codex @@ scope chains so the AST
 * resolver can find the symbol by its actual name.
 *
 * Examples:
 *   "function hello"       → { name: "hello", kind: "function" }
 *   "class BaseClass"       → { name: "BaseClass", kind: "class" }
 *   "def method():"         → { name: "method", kind: "method" }
 *   "export function init"  → { name: "init", kind: "function" }
 *   "const FOO = 1"         → { name: "FOO", kind: "variable" }
 */

/** Ordered list of known kind prefixes — longer prefixes first to avoid partial matches. */
const KIND_PATTERNS: Array<{ prefix: string; kind: string }> = [
  { prefix: "export function ", kind: "function" },
  { prefix: "export class ", kind: "class" },
  { prefix: "export const ", kind: "variable" },
  { prefix: "export let ", kind: "variable" },
  { prefix: "export var ", kind: "variable" },
  { prefix: "async function ", kind: "function" },
  { prefix: "function ", kind: "function" },
  { prefix: "class ", kind: "class" },
  { prefix: "def ", kind: "method" },
  { prefix: "method ", kind: "method" },
  { prefix: "const ", kind: "variable" },
  { prefix: "let ", kind: "variable" },
  { prefix: "var ", kind: "variable" },
];

function extractSymbolFromScope(scope: string): { name: string; kind?: string } {
  const trimmed = scope.trim();
  for (const { prefix, kind } of KIND_PATTERNS) {
    if (trimmed.startsWith(prefix)) {
      const name = trimmed.slice(prefix.length).trim();
      // Strip trailing parens/colons from method-like syntax (e.g., "method():" → "method")
      const cleanName = name.replace(/[():]+$/, '').trim();
      if (cleanName) {
        return { name: cleanName, kind };
      }
    }
  }

  // No known prefix — return the scope as-is without a kind hint.
  // The AST resolver will try to match it as-is.
  return { name: trimmed };
}

/**
 * Sentinel emitted as oldText when a DeleteFile operation has no
 * available file contents. Callers should treat this marker as an
 * unresolved deletion and supply actual file contents before applying.
 */
const DELETE_FILE_SENTINEL = '\0__DELETE_FILE__\0';

/**
 * Convert multiple CodexHunks to EditItem-compatible format.
 * 
 * This function mirrors openAIPatchToEditItem's shape but handles
 * all three hunk kinds (AddFile, DeleteFile, UpdateFile).
 *
 * For DeleteFile hunks, oldText is set to a sentinel string since
 * we don't have the file contents here; the caller should read
 * file contents before applying.
 */
export function codexHunkToEditItem(
  hunk: CodexHunk,
  fileOldContents?: string,
): Array<{ path: string; oldText: string; newText: string; anchor?: { symbolName?: string; symbolKind?: string } }> {
  switch (hunk.kind) {
    case 'AddFile': {
      return [{
        path: hunk.path,
        oldText: '',
        newText: hunk.contents,
      }];
    }

    case 'DeleteFile': {
      if (fileOldContents !== undefined) {
        return [{
          path: hunk.path,
          oldText: fileOldContents,
          newText: '',
        }];
      }
      // If caller can't supply old contents, emit a sentinel oldText
      // that signals "delete this file" — the caller must resolve.
      return [{
        path: hunk.path,
        oldText: DELETE_FILE_SENTINEL,
        newText: '',
      }];
    }

    case 'UpdateFile': {
      return hunk.chunks.map(chunk => {
        const contextBlock = chunk.contextLines.join('\n');
        const removedBlock = chunk.removedLines.join('\n');
        const addedBlock = chunk.addedLines.join('\n');

        const oldParts: string[] = [];
        const newParts: string[] = [];

        if (contextBlock) oldParts.push(contextBlock);
        if (removedBlock) oldParts.push(removedBlock);

        if (contextBlock) newParts.push(contextBlock);
        if (addedBlock) newParts.push(addedBlock);

        const oldText = oldParts.length > 0 ? oldParts.join('\n') : '';
        const newText = newParts.length > 0 ? newParts.join('\n') : '';

        const result: { path: string; oldText: string; newText: string; anchor?: { symbolName?: string; symbolKind?: string } } = {
          path: hunk.movePath || hunk.path,
          oldText,
          newText,
        };

        // Populate anchor hint from innermost scope if available.
        // Strip known kind prefixes (function, class, def, etc.) so the
        // AST resolver can find the bare symbol name.
        if (chunk.scope.length > 0) {
          const innermost = chunk.scope[chunk.scope.length - 1].trim();
          if (innermost) {
            const { name, kind } = extractSymbolFromScope(innermost);
            result.anchor = { symbolName: name, ...(kind ? { symbolKind: kind } : {}) };
          }
        }

        return result;
      });
    }

    default: {
      // Exhaustive check
      const _exhaustive: never = hunk;
      return [];
    }
  }
}

// ─── Internal Parser ────────────────────────────────────────────────

class CodexPatchParser {
  private input: string;
  private pos: number;
  private line: number;
  private column: number;
  private mode: ParseMode;
  private warnings: PatchWarning[];

  constructor(input: string, mode: ParseMode) {
    // Normalize CRLF to LF, then CR to LF
    this.input = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    this.pos = 0;
    this.line = 1;
    this.column = 1;
    this.mode = mode;
    this.warnings = [];
  }

  parse(): CodexPatchResult {
    const hunks = this.parsePatch();
    return { hunks, warnings: this.warnings };
  }

  // ── Cursor management ──────────────────────────────────────────

  private done(): boolean {
    return this.pos >= this.input.length;
  }

  private peek(): string {
    return this.input[this.pos] ?? '';
  }

  private advance(): string {
    const ch = this.input[this.pos] ?? '';
    this.pos++;
    if (ch === '\n') {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  /** Consume until newline, return consumed text (not including newline). */
  private consumeLine(): string {
    const start = this.pos;
    while (!this.done() && this.peek() !== '\n') {
      this.pos++;
    }
    const line = this.input.slice(start, this.pos);
    this.column += this.pos - start;
    // Consume the newline
    if (!this.done() && this.peek() === '\n') {
      this.advance();
    }
    return line;
  }

  /** Read the rest of the current line without consuming it. */
  private peekLine(): string {
    const start = this.pos;
    let end = start;
    while (end < this.input.length && this.input[end] !== '\n') {
      end++;
    }
    return this.input.slice(start, end);
  }

  /** Skip whitespace (spaces and tabs) at current position. */
  private skipHorizontalWs(): void {
    while (this.peek() === ' ' || this.peek() === '\t') {
      this.advance();
    }
  }

  /** Skip any blank lines at current position. */
  private skipBlankLines(): void {
    while (!this.done()) {
      const saved = { pos: this.pos, line: this.line, column: this.column };
      this.skipHorizontalWs();
      if (this.peek() === '\n' || this.done()) {
        // Blank line — consume the newline if present
        if (this.peek() === '\n') this.advance();
        continue;
      }
      // Not blank — restore full cursor state so caller's position is unchanged
      this.pos = saved.pos;
      this.line = saved.line;
      this.column = saved.column;
      return;
    }
  }

  // ── Grammar: patch ─────────────────────────────────────────────

  private parsePatch(): CodexHunk[] {
    const hunks: CodexHunk[] = [];

    // Skip preamble (lines before *** Begin Patch) in lenient mode
    if (this.mode === 'lenient' && !this.tryParseBeginPatch()) {
      // Not at begin patch yet — skip preamble
      while (!this.done() && !this.tryParseBeginPatch()) {
        this.warnings.push({
          message: `Skipped non-patch preamble content`,
          line: this.line,
          kind: 'preamble_skipped',
        });
        this.consumeLine();
      }
    } else if (this.mode === 'strict') {
      // Strict mode: must start with exactly *** Begin Patch at position 0
      if (!this.tryParseBeginPatch()) {
        throw new PatchParseError(
          'Expected "*** Begin Patch" at start of input',
          this.line,
          this.column,
        );
      }
    }

    // We are now positioned after *** Begin Patch's newline (or never entered if mode=lenient and not found)

    // Parse sections until *** End Patch or end of input
    while (!this.done()) {
      this.skipBlankLines();

      const saved = this.pos;

      // Check for End Patch marker
      if (this.tryParseMarker('*** End Patch') || this.tryParseLenientMarker('***', 'End Patch')) {
        return hunks; // Success — normal exit
      }

      // Try each section type
      const section = this.tryParseSection();
      if (section !== null) {
        hunks.push(section);
        continue;
      }

      // Nothing matched — skip line in lenient mode, error in strict
      if (this.mode === 'lenient') {
        this.warnings.push({
          message: `Skipped unrecognised content: "${this.peekLine().slice(0, 60)}"`,
          line: this.line,
          kind: 'unknown_marker',
        });
        this.consumeLine();
      } else {
        throw new PatchParseError(
          `Unexpected content: "${this.peekLine().slice(0, 60)}"`,
          this.line,
          this.column,
        );
      }
    }

    // End of input without *** End Patch — warn in lenient mode
    if (this.mode === 'lenient' && hunks.length > 0) {
      this.warnings.push({
        message: 'Missing "*** End Patch" marker — reached end of input',
        line: this.line,
        kind: 'missing_end_patch',
      });
    }

    return hunks;
  }

  // ── Grammar: sections ──────────────────────────────────────────

  /**
   * Try to parse any section type at current position.
   * Returns null if no section starts here.
   */
  private tryParseSection(): CodexHunk | null {
    // Try Add File
    const addPath = this.tryParseMarkerWithPath('*** Add File:');
    if (addPath !== null) {
      return this.parseAddSection(addPath);
    }

    // Try Delete File
    const delPath = this.tryParseMarkerWithPath('*** Delete File:');
    if (delPath !== null) {
      return this.parseDeleteSection(delPath);
    }

    // Try Update File
    const updPath = this.tryParseMarkerWithPath('*** Update File:');
    if (updPath !== null) {
      return this.parseUpdateSection(updPath);
    }

    return null;
  }

  /**
   * Parse an Add File section.
   * Already consumed the *** Add File: <path> line.
   * Read all subsequent lines until another *** marker or end of input.
   */
  private parseAddSection(path: string): CodexHunk {
    const contentLines: string[] = [];

    while (!this.done()) {
      const nextLine = this.peekLine();

      // Check for any *** marker (section end or End Patch)
      if (nextLine.startsWith('***')) {
        break;
      }

      contentLines.push(this.consumeLine());
    }

    // Strip trailing blank lines from contents
    while (contentLines.length > 0 && contentLines[contentLines.length - 1].trim() === '') {
      contentLines.pop();
    }

    return {
      kind: 'AddFile',
      path,
      contents: contentLines.join('\n'),
    };
  }

  /**
   * Parse a Delete File section.
   * Already consumed the *** Delete File: <path> line.
   * No body — just return the hunk.
   */
  private parseDeleteSection(path: string): CodexHunk {
    return {
      kind: 'DeleteFile',
      path,
    };
  }

  /**
   * Parse an Update File section.
   * Already consumed the *** Update File: <path> line.
   * Optionally parse *** Move to: <path>, then parse hunks.
   */
  private parseUpdateSection(path: string): CodexHunk {
    let movePath: string | undefined;

    // Check for *** Move to: marker
    this.skipBlankLines();
    const move = this.tryParseMarkerWithPath('*** Move to:');
    if (move !== null) {
      movePath = move;
    }

    // Parse hunks
    const chunks: UpdateFileChunk[] = [];

    this.skipBlankLines();
    while (!this.done()) {
      const nextLine = this.peekLine();

      // Check for next section or End Patch
      if (nextLine.startsWith('***')) {
        break;
      }

      // Check for @@ hunk marker
      if (nextLine.startsWith('@@')) {
        const chunk = this.parseHunk();
        if (chunk !== null) {
          chunks.push(chunk);
        }
        this.skipBlankLines();
        continue;
      }

      // Lenient mode: skip unexpected lines in the section body
      if (this.mode === 'lenient') {
        this.warnings.push({
          message: `Skipped unexpected line in UpdateFile: "${nextLine.slice(0, 60)}"`,
          line: this.line,
          kind: 'unknown_marker',
        });
        this.consumeLine();
        continue;
      }

      throw new PatchParseError(
        `Unexpected content in UpdateFile section: "${nextLine.slice(0, 60)}"`,
        this.line,
        this.column,
      );
    }

    return {
      kind: 'UpdateFile',
      path,
      movePath,
      chunks,
    };
  }

  // ── Grammar: hunk ──────────────────────────────────────────────

  /**
   * Parse a single @@ hunk.
   * Already positioned at the start of a @@ line.
   * Returns null if hunk is empty (no + or - lines).
   */
  private parseHunk(): UpdateFileChunk | null {
    // Consume the @@ line and extract scope
    const hunkLine = this.consumeLine();
    const scope = this.parseScope(hunkLine);

    const contextLines: string[] = [];
    const removedLines: string[] = [];
    const addedLines: string[] = [];

    let hasContent = false;

    while (!this.done()) {
      const nextLine = this.peekLine();

      // End of hunk: @@ marker or *** marker
      if (nextLine.startsWith('@@') || nextLine.startsWith('***')) {
        break;
      }

      const firstChar = nextLine[0] ?? '';
      let lineContent: string;

      if (firstChar === ' ') {
        lineContent = nextLine.slice(1);
        contextLines.push(lineContent);
        this.consumeLine();
      } else if (firstChar === '-') {
        lineContent = nextLine.slice(1);
        removedLines.push(lineContent);
        hasContent = true;
        this.consumeLine();
      } else if (firstChar === '+') {
        lineContent = nextLine.slice(1);
        addedLines.push(lineContent);
        hasContent = true;
        this.consumeLine();
      } else if (firstChar === '\\') {
        // Git-style no-newline-at-eof marker — skip it
        this.consumeLine();
      } else if (nextLine.trim() === '') {
        // Blank line within hunk — preserve as context (with empty content)
        contextLines.push('');
        this.consumeLine();
      } else {
        // Unknown hunk line — skip in lenient mode
        if (this.mode === 'lenient') {
          this.warnings.push({
            message: `Skipped unrecognised hunk line (prefix '${firstChar}'): "${nextLine.slice(0, 60)}"`,
            line: this.line,
            kind: 'unknown_marker',
          });
          this.consumeLine();
        } else {
          throw new PatchParseError(
            `Unexpected hunk line content: "${nextLine.slice(0, 60)}"`,
            this.line,
            this.column,
          );
        }
      }
    }

    // Skip empty hunks
    if (!hasContent) {
      this.warnings.push({
        message: `Skipped empty hunk (no + or - lines) at scope: ${scope.join(' > ') || '<root>'}`,
        line: this.line,
        kind: 'empty_hunk',
      });
      return null;
    }

    return {
      scope,
      contextLines,
      removedLines,
      addedLines,
    };
  }

  /**
   * Parse the scope from a @@ line.
   * Handles:
   *   @@ function name @@       → ["function name"]
   *   @@ class A . def method   → ["class A", "def method"]
   *   @@   def method           → ["def method"]
   *   @@                        → []
   */
  private parseScope(hunkLine: string): string[] {
    // Strip leading @@ and whitespace
    let rest = hunkLine.replace(/^@@\s*/, '').trim();

    // Strip trailing @@ if present
    rest = rest.replace(/\s*@@\s*$/, '');

    if (!rest) return [];

    // Split by dot separators (with optional surrounding whitespace)
    // Handle multi-level: "class A . def method" → ["class A", "def method"]
    // The dot can have spaces around it: "class A.def method" also works
    const parts: string[] = [];
    let current = '';

    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '.' && (i === 0 || rest[i - 1] !== '.')) {
        // Dot separator — push current part if non-empty
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = '';
        // Skip this dot; whitespace around it gets handled by trim below
      } else {
        current += rest[i];
      }
    }

    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);

    return parts;
  }

  // ── Marker detection ───────────────────────────────────────────

  /**
   * Try to match `*** Begin Patch` at current position (strict or lenient).
   * Consumes the matched line and returns true on success.
   */
  private tryParseBeginPatch(): boolean {
    return (
      this.tryParseMarker('*** Begin Patch') ||
      this.tryParseLenientMarker('***', 'Begin Patch')
    );
  }

  /**
   * Try to match an exact marker string at the current position.
   * Expects marker at start of line (after possible whitespace in lenient mode).
   * The entire current line must equal the marker (case-sensitive).
   */
  private tryParseMarker(marker: string): boolean {
    const line = this.peekLine();
    if (line === marker) {
      this.consumeLine();
      return true;
    }
    return false;
  }

  /**
   * Try to match a marker with a variable path component.
   * E.g., "*** Add File: <path>" — returns the path if matched.
   * Supports lenient spellings.
   */
  private tryParseMarkerWithPath(prefix: string): string | null {
    const line = this.peekLine();

    // Try exact match first
    if (line.startsWith(prefix) && line.length > prefix.length) {
      const path = line.slice(prefix.length).trim();
      this.consumeLine();
      return path;
    }

    // Lenient mode: try case-insensitive
    if (this.mode === 'lenient') {
      const normalizedLine = line.toLowerCase().replace(/\*\*\* */g, '***');
      const normalizedPrefix = prefix.toLowerCase().replace(/\*\*\* */g, '***');

      if (normalizedLine.startsWith(normalizedPrefix) && normalizedLine.length > normalizedPrefix.length) {
        this.warnings.push({
          message: `Lenient spelling: "${line.slice(0, 40)}..." accepted as "${prefix}"`,
          line: this.line,
          kind: 'lenient_spelling',
        });
        this.consumeLine();
        // The path is everything after the actual matched prefix text in the original line
        const matchedText = this.findActualPrefixMatch(line, prefix);
        if (matchedText !== null) {
          return line.slice(matchedText.length).trim();
        }
        // Fallback: use original prefix length
        return line.slice(prefix.length).trim() || 'unknown';
      }

      // Also try without space after ***: e.g. ***Add File:
      const noSpaceVariant = prefix.replace('*** ', '***');
      if (line.startsWith(noSpaceVariant) && line.length > noSpaceVariant.length) {
        const path = line.slice(noSpaceVariant.length).trim();
        this.warnings.push({
          message: `Lenient spelling (no space after ***): "${line.slice(0, 40)}..."`,
          line: this.line,
          kind: 'lenient_spelling',
        });
        this.consumeLine();
        return path;
      }
    }

    return null;
  }

  /**
   * Find how the canonical prefix actually appears in the input line.
   * E.g., for line "***add file: src/main.ts" and prefix "*** Add File:",
   * returns "***add file:" (the portion that matches case-insensitively).
   */
  private findActualPrefixMatch(line: string, canonicalPrefix: string): string | null {
    const canonicalNorm = canonicalPrefix.toLowerCase().replace(/\*\*\* */g, '***');
    const lineNorm = line.toLowerCase();

    // Try to match the normalised prefix at the start of the normalised line
    // We need to find the longest prefix of lineNorm that, when normalised, matches canonicalNorm
    const re = new RegExp(`^${this.escapeRegex(canonicalNorm)}`, 'i');
    const match = lineNorm.match(re);
    return match ? match[0] : null;
  }

  /**
   * Escape special regex characters in a string.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Try to match a marker with possible whitespace variations.
   * E.g., tryParseLenientMarker("***", "End Patch") matches:
   *   "*** End Patch", "***End Patch", "*** end patch", "*** END PATCH"
   */
  private tryParseLenientMarker(prefix: string, suffix: string): boolean {
    if (this.mode !== 'lenient') return false;

    const line = this.peekLine().trimEnd();

    // Build candidate patterns
    const patterns = [
      `${prefix} ${suffix}`,
      `${prefix}${suffix}`,
    ];

    for (const pattern of patterns) {
      if (line.toLowerCase() === pattern.toLowerCase()) {
        this.warnings.push({
          message: `Lenient spelling: "${line}" accepted as "${prefix} ${suffix}"`,
          line: this.line,
          kind: 'lenient_spelling',
        });
        this.consumeLine();
        return true;
      }
    }

    return false;
  }

  /**
   * Skip the rest of the current line (for error recovery).
   */
  private skipLine(): void {
    this.consumeLine();
  }
}
