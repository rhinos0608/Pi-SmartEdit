/**
 * Shared parser core: line-ending normalization + cursor mechanics.
 *
 * Extracted from codex-patch.ts / atomic-patch.ts / openai-patch.ts.
 * Grammars, warnings, result types, adapters, and atomic apply stay
 * in their owning modules.
 */

export interface NormalizeOptions {
  /**
   * Strip a leading BOM (U+FEFF) after line-ending normalization.
   * atomic + OpenAI strip; Codex does not. Explicit per caller.
   */
  stripBOM?: boolean;
}

/**
 * Normalize CRLF -> LF, then lone CR -> LF. Optionally strip leading BOM.
 */
export function normalizePatchText(input: string, options: NormalizeOptions = {}): string {
  let out = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (options.stripBOM) {
    out = out.replace(/^\uFEFF/, '');
  }
  return out;
}

/** Saved cursor position for restore-on-miss flows (e.g. skipBlankLines). */
export interface CursorState {
  pos: number;
  line: number;
  column: number;
}

/**
 * Shared line-oriented cursor over normalized patch text.
 * Tracks 1-based line/column for error reporting.
 */
export class PatchCursor {
  protected input: string;
  protected pos: number;
  protected line: number;
  protected column: number;

  constructor(input: string) {
    this.input = input;
    this.pos = 0;
    this.line = 1;
    this.column = 1;
  }

  get position(): number {
    return this.pos;
  }

  get lineNumber(): number {
    return this.line;
  }

  get columnNumber(): number {
    return this.column;
  }

  save(): CursorState {
    return { pos: this.pos, line: this.line, column: this.column };
  }

  restore(state: CursorState): void {
    this.pos = state.pos;
    this.line = state.line;
    this.column = state.column;
  }

  done(): boolean {
    return this.pos >= this.input.length;
  }

  peek(): string {
    return this.input[this.pos] ?? '';
  }

  advance(): string {
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
  consumeLine(): string {
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
  peekLine(): string {
    const start = this.pos;
    let end = start;
    while (end < this.input.length && this.input[end] !== '\n') {
      end++;
    }
    return this.input.slice(start, end);
  }

  /** Skip whitespace (spaces and tabs) at current position. */
  skipHorizontalWs(): void {
    while (this.peek() === ' ' || this.peek() === '\t') {
      this.advance();
    }
  }

  /** Skip any blank lines at current position. */
  skipBlankLines(): void {
    while (!this.done()) {
      const saved = this.save();
      this.skipHorizontalWs();
      if (this.peek() === '\n' || this.done()) {
        // Blank line — consume the newline if present
        if (this.peek() === '\n') this.advance();
        continue;
      }
      // Not blank — restore full cursor state so caller's position is unchanged
      this.restore(saved);
      return;
    }
  }
}
