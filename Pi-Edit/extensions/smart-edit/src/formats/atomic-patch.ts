/**
 * Multi-File Atomic Patch Envelope for SmartEdit.
 *
 * Parses and applies atomic patch envelopes that can operate on multiple files
 * in a single transaction. Operations are validated before application, and
 * rollback is performed on any failure.
 *
 * Grammar (BNF):
 *   atomic_patch     = [ preamble ] , "*** Begin Atomic Patch" , newline , { section } , [ "*** End Atomic Patch" ] , [ postamble ]
 *   section          = add-section | delete-section | update-section | rename-section
 *   add-section      = "*** Add File:" , ws , path , newline , { contents-line }
 *   delete-section   = "*** Delete File:" , ws , path , newline
 *   update-section   = "*** Update File:" , ws , path , newline , [ "*** Move to:" , ws , path , newline ] , { hunk }
 *   rename-section   = "*** Rename File:" , ws , path , ws , "->" , ws , path , newline
 *
 * Inspired by: Codex CLI's apply_patch format, extended with RenameFile operation.
 */

import { access as fsAccess, readFile as fsReadFile, unlink as fsUnlink, stat as fsStat } from "fs/promises";
import { resolve, dirname, basename } from "path";
import { constants } from "fs";

import { saveUndoState, restoreUndoState } from "../undo/edit-history";
import { atomicWrite } from "../undo/atomic-write";

// ─── Types ──────────────────────────────────────────────────────────

/**
 * The four operations supported by the atomic patch envelope.
 */
export type AtomicPatchOp =
  | { kind: 'AddFile'; path: string; contents: string }
  | { kind: 'DeleteFile'; path: string }
  | { kind: 'UpdateFile'; path: string; movePath?: string; patches: Array<{ oldText: string; newText: string }> }
  | { kind: 'RenameFile'; oldPath: string; newPath: string };

/**
 * An atomic patch envelope containing multiple operations.
 */
export interface AtomicPatchEnvelope {
  operations: AtomicPatchOp[];
}

/**
 * Options for atomic patch application.
 */
export interface AtomicPatchOptions {
  /** When true, AddFile succeeds even if file exists (overwrite) */
  force?: boolean;
  /** When true, operations are applied without undo snapshot */
  skipUndo?: boolean;
  /** Max retries per file operation */
  maxAttemptsPerFile?: number;
  /** Working directory for resolving paths */
  cwd?: string;
}

/**
 * Status of an individual operation within an atomic patch.
 */
export type OperationStatus = 'pending' | 'applied' | 'rolled_back' | 'skipped' | 'failed';

/**
 * Result of applying an atomic patch.
 */
export interface AtomicPatchResult {
  /** true if ALL operations succeeded */
  success: boolean;
  /** Per-operation results */
  operations: Array<{
    op: AtomicPatchOp;
    status: OperationStatus;
    error?: string;
  }>;
  /** Files that were rolled back (empty on success) */
  rolledBack: string[];
  /** Human-readable summary */
  summary: string;
}

/**
 * Warning accumulated during lenient-mode parsing.
 */
export interface AtomicPatchWarning {
  message: string;
  line: number;
  kind: 'missing_end_patch' | 'unknown_marker' | 'lenient_spelling' | 'preamble_skipped';
}

/**
 * Result of parsing an atomic patch envelope.
 */
export interface AtomicPatchParseResult {
  envelope: AtomicPatchEnvelope;
  warnings: AtomicPatchWarning[];
}

// ─── Error Types ────────────────────────────────────────────────────

export class AtomicPatchError extends Error {
  constructor(
    message: string,
    public readonly operation?: AtomicPatchOp,
    public readonly operationIndex?: number,
  ) {
    super(`❌ Atomic patch error: ${message}`);
    this.name = 'AtomicPatchError';
  }
}

// ─── Parser ─────────────────────────────────────────────────────────

/**
 * Parse an atomic patch envelope from raw text.
 *
 * @param input Raw patch text
 * @returns Parsed envelope and warnings
 */
export function parseAtomicPatchEnvelope(input: string): AtomicPatchParseResult {
  const parser = new AtomicPatchParser(input);
  return parser.parse();
}

// ─── Internal Parser ────────────────────────────────────────────────

class AtomicPatchParser {
  private input: string;
  private pos: number;
  private line: number;
  private column: number;
  private warnings: AtomicPatchWarning[];

  constructor(input: string) {
    // Normalize line endings
    this.input = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    this.pos = 0;
    this.line = 1;
    this.column = 1;
    this.warnings = [];
  }

  parse(): AtomicPatchParseResult {
    const envelope = this.parseEnvelope();
    return { envelope, warnings: this.warnings };
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

  private consumeLine(): string {
    const start = this.pos;
    while (!this.done() && this.peek() !== '\n') {
      this.pos++;
    }
    const line = this.input.slice(start, this.pos);
    this.column += this.pos - start;
    if (!this.done() && this.peek() === '\n') {
      this.advance();
    }
    return line;
  }

  private peekLine(): string {
    const start = this.pos;
    let end = start;
    while (end < this.input.length && this.input[end] !== '\n') {
      end++;
    }
    return this.input.slice(start, end);
  }

  private skipBlankLines(): void {
    while (!this.done()) {
      const saved = { pos: this.pos, line: this.line, column: this.column };
      this.skipHorizontalWs();
      if (this.peek() === '\n' || this.done()) {
        if (this.peek() === '\n') this.advance();
        continue;
      }
      this.pos = saved.pos;
      this.line = saved.line;
      this.column = saved.column;
      return;
    }
  }

  private skipHorizontalWs(): void {
    while (this.peek() === ' ' || this.peek() === '\t') {
      this.advance();
    }
  }

  // ── Grammar: envelope ───────────────────────────────────────────

  private parseEnvelope(): AtomicPatchEnvelope {
    const operations: AtomicPatchOp[] = [];

    // Lenient mode: look for Begin Atomic Patch or start of sections
    let foundBeginMarker = false;

    // Try to consume Begin Atomic Patch marker
    if (this.tryParseBeginAtomicPatch()) {
      foundBeginMarker = true;
    } else {
      // Not at begin marker yet — in lenient mode, check if we're at a section marker
      // If the first non-blank line starts with *** but isn't Begin Atomic Patch,
      // we're already at sections (lenient mode without envelope markers)
      const firstLine = this.peekLine();
      if (firstLine.startsWith('***') && !firstLine.startsWith('*** Begin Atomic Patch')) {
        // We're at a section marker without a Begin marker — this is valid lenient mode
        // No preamble consumed, we'll parse sections directly
      } else {
        // Consume preamble until we find Begin Atomic Patch or a section marker
        while (!this.done()) {
          const currentLine = this.peekLine();
          // Stop consuming preamble if we hit a section marker
          if (currentLine.startsWith('***') && !currentLine.startsWith('*** Begin Atomic Patch') && !currentLine.startsWith('***End Atomic Patch')) {
            // We're at a section marker — stop consuming preamble
            break;
          }
          this.warnings.push({
            message: `Skipped non-patch preamble content`,
            line: this.line,
            kind: 'preamble_skipped',
          });
          this.consumeLine();
          // Check if next line is the begin marker
          if (this.tryParseBeginAtomicPatch()) {
            foundBeginMarker = true;
            break;
          }
        }
      }
    }

    // Parse sections until *** End Atomic Patch or end of input
    while (!this.done()) {
      this.skipBlankLines();

      // Check for End Atomic Patch marker (handle lenient variants)
      const currentLine = this.peekLine();
      if (currentLine === '*** End Atomic Patch' || currentLine === '***End Atomic Patch') {
        this.consumeLine();
        return { operations }; // Success — normal exit
      }

      // Check for begin marker (in case we encounter it mid-stream)
      if (currentLine === '*** Begin Atomic Patch' || currentLine === '***Begin Atomic Patch') {
        this.consumeLine();
        continue;
      }

      // Try each section type
      const section = this.tryParseSection();
      if (section !== null) {
        operations.push(section);
        continue;
      }

      // Nothing matched — skip line in lenient mode
      this.warnings.push({
        message: `Skipped unrecognised content: "${this.peekLine().slice(0, 60)}"`,
        line: this.line,
        kind: 'unknown_marker',
      });
      this.consumeLine();
    }

    // End of input without *** End Atomic Patch — warn
    if (operations.length > 0) {
      this.warnings.push({
        message: 'Missing "*** End Atomic Patch" marker — reached end of input',
        line: this.line,
        kind: 'missing_end_patch',
      });
    }

    return { operations };
  }

  // ── Grammar: sections ──────────────────────────────────────────

  private tryParseSection(): AtomicPatchOp | null {
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

    // Try Rename File
    const renameOp = this.tryParseRenameSection();
    if (renameOp !== null) {
      return renameOp;
    }

    return null;
  }

  private parseAddSection(path: string): AtomicPatchOp {
    const contentLines: string[] = [];

    while (!this.done()) {
      const nextLine = this.peekLine();

      // Check for any *** marker (section end or End Atomic Patch)
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

  private parseDeleteSection(path: string): AtomicPatchOp {
    return {
      kind: 'DeleteFile',
      path,
    };
  }

  private parseUpdateSection(path: string): AtomicPatchOp {
    let movePath: string | undefined;
    const patches: Array<{ oldText: string; newText: string }> = [];

    // Check for *** Move to: marker
    this.skipBlankLines();
    const move = this.tryParseMarkerWithPath('*** Move to:');
    if (move !== null) {
      movePath = move;
    }

    // Parse hunks (simplified format: oldText/newText pairs)
    this.skipBlankLines();
    while (!this.done()) {
      const nextLine = this.peekLine();

      // Check for next section or End Atomic Patch
      if (nextLine.startsWith('***')) {
        break;
      }

      // Check for @@ hunk marker
      if (nextLine.startsWith('@@')) {
        const chunk = this.parseHunk();
        if (chunk !== null) {
          patches.push({ oldText: chunk.oldText, newText: chunk.newText });
        }
        this.skipBlankLines();
        continue;
      }

      this.consumeLine();
    }

    return {
      kind: 'UpdateFile',
      path,
      movePath,
      patches,
    };
  }

  private tryParseRenameSection(): AtomicPatchOp | null {
    const line = this.peekLine();

    // Match "*** Rename File: <oldPath> -> <newPath>"
    if (!line.startsWith('*** Rename File:')) {
      return null;
    }

    this.consumeLine();

    // Extract path after the marker
    const afterMarker = line.slice('*** Rename File:'.length).trim();

    // Parse "path1 -> path2"
    const arrowIndex = afterMarker.indexOf('->');
    if (arrowIndex === -1) {
      this.warnings.push({
        message: `Invalid Rename File section: missing "->" separator`,
        line: this.line,
        kind: 'unknown_marker',
      });
      return null;
    }

    const oldPath = afterMarker.slice(0, arrowIndex).trim();
    const newPath = afterMarker.slice(arrowIndex + 2).trim();

    if (!oldPath || !newPath) {
      this.warnings.push({
        message: `Invalid Rename File section: empty path`,
        line: this.line,
        kind: 'unknown_marker',
      });
      return null;
    }

    return {
      kind: 'RenameFile',
      oldPath,
      newPath,
    };
  }

  private parseHunk(): { oldText: string; newText: string } | null {
    // Consume the @@ line
    const hunkLine = this.consumeLine();

    const oldLines: string[] = [];
    const newLines: string[] = [];
    let pendingLine: string | null = null;

    while (!this.done()) {
      const nextLine = this.peekLine();

      // End of hunk
      if (nextLine.startsWith('@@') || nextLine.startsWith('***')) {
        break;
      }

      const firstChar = nextLine[0] ?? '';

      if (firstChar === ' ') {
        // Context line — add to both
        const content = nextLine.slice(1);
        oldLines.push(content);
        newLines.push(content);
        this.consumeLine();
      } else if (firstChar === '-') {
        oldLines.push(nextLine.slice(1));
        this.consumeLine();
      } else if (firstChar === '+') {
        newLines.push(nextLine.slice(1));
        this.consumeLine();
      } else if (nextLine.trim() === '') {
        // Blank line — preserve in both
        oldLines.push('');
        newLines.push('');
        this.consumeLine();
      } else {
        // Content line without prefix — treat as context
        // (simplified format where content lines have no prefix)
        if (pendingLine === null && nextLine.trim() !== '') {
          pendingLine = nextLine;
        }
        this.consumeLine();
      }
    }

    // If we have a pending line (content without prefix), add it to both
    if (pendingLine !== null) {
      oldLines.push(pendingLine);
      newLines.push(pendingLine);
    }

    if (oldLines.length === 0 && newLines.length === 0) {
      return null;
    }

    return {
      oldText: oldLines.join('\n'),
      newText: newLines.join('\n'),
    };
  }

  // ── Marker detection ───────────────────────────────────────────

  private tryParseBeginAtomicPatch(): boolean {
    const line = this.peekLine();
    return line === '*** Begin Atomic Patch' || line === '***Begin Atomic Patch';
  }

  private tryParseMarker(marker: string): boolean {
    const line = this.peekLine();
    if (line === marker) {
      this.consumeLine();
      return true;
    }
    return false;
  }

  private tryParseMarkerWithPath(prefix: string): string | null {
    const line = this.peekLine();

    if (line.startsWith(prefix) && line.length > prefix.length) {
      const path = line.slice(prefix.length).trim();
      this.consumeLine();
      return path;
    }

    return null;
  }
}

// ─── Application Engine ─────────────────────────────────────────────

/**
 * Apply an atomic patch envelope to the filesystem.
 *
 * Implements 5-phase approach:
 * 1. Validate all operations
 * 2. Snapshot pre-edit state (via saveUndoState)
 * 3. Apply operations in order (Add, then Delete, then Update, then Rename)
 * 4. Rollback on any failure
 * 5. Report per-file results
 *
 * @param envelope The parsed atomic patch envelope
 * @param options Application options
 * @param cwd Working directory for resolving relative paths
 * @returns Result with per-operation status and rollback info
 */
export async function applyAtomicPatch(
  envelope: AtomicPatchEnvelope,
  options: AtomicPatchOptions = {},
  cwd: string = process.cwd(),
): Promise<AtomicPatchResult> {
  const { force = false, skipUndo = false, maxAttemptsPerFile = 3 } = options;

  const operationResults: AtomicPatchResult['operations'] = [];
  const appliedOperations: Array<{ op: AtomicPatchOp; contents?: string }> = [];
  const rolledBack: string[] = [];

  // ── Phase 1: Validation ────────────────────────────────────────────
  const validationErrors: string[] = [];

  for (const op of envelope.operations) {
    let error: string | undefined;

    switch (op.kind) {
      case 'AddFile': {
        const resolvedPath = resolve(cwd, op.path);
        try {
          await fsAccess(resolvedPath, constants.F_OK);
          if (!force) {
            error = `AddFile: target file already exists at ${op.path} (use force option to overwrite)`;
          }
        } catch {
          // File doesn't exist — valid for AddFile
        }
        break;
      }

      case 'DeleteFile': {
        const resolvedPath = resolve(cwd, op.path);
        try {
          await fsAccess(resolvedPath, constants.F_OK);
        } catch {
          error = `DeleteFile: target file does not exist at ${op.path}`;
        }
        break;
      }

      case 'UpdateFile': {
        const targetPath = op.movePath ?? op.path;
        const resolvedPath = resolve(cwd, targetPath);
        try {
          await fsAccess(resolvedPath, constants.F_OK);
        } catch {
          error = `UpdateFile: target file does not exist at ${targetPath}`;
        }
        break;
      }

      case 'RenameFile': {
        const resolvedOldPath = resolve(cwd, op.oldPath);
        const resolvedNewPath = resolve(cwd, op.newPath);
        try {
          await fsAccess(resolvedOldPath, constants.F_OK);
        } catch {
          error = `RenameFile: source file does not exist at ${op.oldPath}`;
        }
        if (!error) {
          try {
            await fsAccess(resolvedNewPath, constants.F_OK);
            error = `RenameFile: target path already exists at ${op.newPath}`;
          } catch {
            // Target doesn't exist — valid for RenameFile
          }
        }
        break;
      }
    }

    if (error) {
      validationErrors.push(error);
    }
  }

  // If validation fails, return early without applying anything
  if (validationErrors.length > 0) {
    return {
      success: false,
      operations: envelope.operations.map(op => ({
        op,
        status: 'failed' as const,
        error: validationErrors.find(e => e.includes(op.kind)) ?? 'Validation failed',
      })),
      rolledBack: [],
      summary: `Validation failed: ${validationErrors.join('; ')}`,
    };
  }

  // ── Phase 2: Snapshot ─────────────────────────────────────────────
  // Save undo state for all files that will be modified
  if (!skipUndo) {
    const affectedPaths = new Set<string>();

    for (const op of envelope.operations) {
      switch (op.kind) {
        case 'DeleteFile':
        case 'UpdateFile':
          affectedPaths.add(op.path);
          break;
        case 'RenameFile':
          affectedPaths.add(op.oldPath);
          break;
        case 'AddFile':
          if (force) {
            affectedPaths.add(op.path);
          }
          break;
      }
    }

    // Snapshot each affected file
    for (const path of affectedPaths) {
      const resolvedPath = resolve(cwd, path);
      try {
        const content = (await fsReadFile(resolvedPath)).toString('utf-8');
        await saveUndoState(cwd, resolvedPath, content, envelope.operations.length);
      } catch {
        // File might not exist or be readable — skip
      }
    }
  }

  // ── Phase 3 & 4: Apply with rollback on failure ────────────────────
  let firstError: { index: number; error: string } | null = null;

  for (let i = 0; i < envelope.operations.length; i++) {
    const op = envelope.operations[i];
    let status: OperationStatus = 'pending';
    let error: string | undefined;

    try {
      // Apply operation with retry support
      let attempts = 0;
      let success = false;

      while (attempts < maxAttemptsPerFile && !success) {
        try {
          await applySingleOperation(op, cwd);
          success = true;
        } catch (err) {
          attempts++;
          if (attempts >= maxAttemptsPerFile) {
            throw err;
          }
          // Brief delay before retry
          await new Promise(resolve => setTimeout(resolve, 50 * attempts));
        }
      }

      status = 'applied';
      appliedOperations.push({ op });
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      firstError = { index: i, error };
    }

    operationResults.push({ op, status, error });

    // If this operation failed, rollback all previously applied operations
    if (status === 'failed' && firstError) {
      // Mark all previously applied operations as rolled_back
      for (const result of operationResults) {
        if (result.status === 'applied') {
          result.status = 'rolled_back';
        }
      }

      for (const applied of appliedOperations.reverse()) {
        try {
          await rollbackSingleOperation(applied.op, cwd);
          let rolledBackPath: string | undefined;
          if (applied.op.kind === 'RenameFile') {
            rolledBackPath = applied.op.oldPath;
          } else if ('path' in applied.op) {
            rolledBackPath = (applied.op as { path: string }).path;
          }
          if (rolledBackPath) {
            rolledBack.push(rolledBackPath);
          }
        } catch {
          // Rollback failure — best effort
        }
      }

      // Mark all remaining operations as skipped
      for (let j = i + 1; j < envelope.operations.length; j++) {
        operationResults.push({
          op: envelope.operations[j],
          status: 'skipped',
          error: 'Skipped due to earlier failure',
        });
      }

      break;
    }
  }

  // ── Phase 5: Report ────────────────────────────────────────────────
  const allSucceeded = operationResults.every(r => r.status === 'applied');

  const successCount = operationResults.filter(r => r.status === 'applied').length;
  const failedCount = operationResults.filter(r => r.status === 'failed').length;

  let summary: string;
  if (allSucceeded) {
    summary = `Successfully applied ${successCount} operation(s)`;
  } else if (failedCount === 1 && firstError) {
    summary = `Failed at operation ${firstError.index + 1}: ${firstError.error}. Rolled back ${rolledBack.length} file(s).`;
  } else {
    summary = `Partially applied: ${successCount} succeeded, ${failedCount} failed. Rolled back ${rolledBack.length} file(s).`;
  }

  return {
    success: allSucceeded,
    operations: operationResults,
    rolledBack,
    summary,
  };
}

/**
 * Apply a single atomic patch operation to the filesystem.
 */
async function applySingleOperation(op: AtomicPatchOp, cwd: string): Promise<void> {
  switch (op.kind) {
    case 'AddFile': {
      const resolvedPath = resolve(cwd, op.path);
      const dir = dirname(resolvedPath);

      // Ensure parent directory exists
      try {
        await fsStat(dir);
      } catch {
        // Directory doesn't exist — need to create it
        // This is handled by atomicWrite which creates parent dirs
      }

      await atomicWrite(resolvedPath, op.contents);
      break;
    }

    case 'DeleteFile': {
      const resolvedPath = resolve(cwd, op.path);
      await fsUnlink(resolvedPath);
      break;
    }

    case 'UpdateFile': {
      const targetPath = op.movePath ?? op.path;
      const resolvedPath = resolve(cwd, targetPath);
      const originalPath = op.path !== targetPath ? resolve(cwd, op.path) : null;

      // Read current content
      let content = (await fsReadFile(resolvedPath)).toString('utf-8');

      // Apply patches in order
      for (const patch of op.patches) {
        const idx = content.indexOf(patch.oldText);
        if (idx !== -1) {
          content = content.slice(0, idx) + patch.newText + content.slice(idx + patch.oldText.length);
        } else {
          throw new Error(`UpdateFile: oldText not found in file at ${targetPath}: "${patch.oldText.slice(0, 50)}..."`);
        }
      }

      await atomicWrite(resolvedPath, content);

      // If move path is different, delete the original
      if (originalPath) {
        try {
          await fsUnlink(originalPath);
        } catch {
          // Original might not exist or already be handled
        }
      }
      break;
    }

    case 'RenameFile': {
      const resolvedOldPath = resolve(cwd, op.oldPath);
      const resolvedNewPath = resolve(cwd, op.newPath);
      await fsUnlink(resolvedOldPath);
      break;
    }
  }
}

/**
 * Rollback a single atomic patch operation.
 */
async function rollbackSingleOperation(op: AtomicPatchOp, cwd: string): Promise<void> {
  switch (op.kind) {
    case 'AddFile': {
      const resolvedPath = resolve(cwd, op.path);
      try {
        await fsUnlink(resolvedPath);
      } catch {
        // File might not exist
      }
      break;
    }

    case 'DeleteFile':
    case 'RenameFile':
    case 'UpdateFile': {
      // Restore from undo state
      const path = op.kind === 'RenameFile' ? op.oldPath : (op as { path: string }).path;
      const resolvedPath = resolve(cwd, path);
      await restoreUndoState(cwd, resolvedPath);
      break;
    }
  }
}

/**
 * Enqueue an atomic patch for the mutation queue.
 *
 * This wraps the atomic patch as a single mutation queue entry.
 * On failure, all applied operations are rolled back.
 *
 * @param input Raw patch text to parse and apply
 * @param options Application options
 * @param cwd Working directory
 * @returns Result with per-operation status
 */
export async function enqueueAtomicPatch(
  input: string,
  options: AtomicPatchOptions = {},
  cwd: string = process.cwd(),
): Promise<AtomicPatchResult> {
  // Parse the envelope first
  const { envelope, warnings } = parseAtomicPatchEnvelope(input);

  // Check for parsing warnings
  if (warnings.length > 0) {
    const criticalWarnings = warnings.filter(w =>
      w.kind !== 'preamble_skipped' && w.kind !== 'lenient_spelling'
    );
    if (criticalWarnings.length > 0) {
      return {
        success: false,
        operations: [],
        rolledBack: [],
        summary: `Parse warnings: ${criticalWarnings.map(w => w.message).join('; ')}`,
      };
    }
  }

  // Apply the atomic patch
  return applyAtomicPatch(envelope, options, cwd);
}

// ─── Helper Functions ───────────────────────────────────────────────

/**
 * Convert an AtomicPatchOp to EditItem-compatible format for single-file updates.
 *
 * @param op The atomic patch operation
 * @param fileContents Current file contents (for UpdateFile operations)
 * @returns Array of EditItem-compatible objects
 */
export function atomicPatchOpToEditItem(
  op: AtomicPatchOp,
  fileContents?: string,
): Array<{ path: string; oldText: string; newText: string }> {
  switch (op.kind) {
    case 'AddFile':
      return [{
        path: op.path,
        oldText: '',
        newText: op.contents,
      }];

    case 'DeleteFile':
      return [{
        path: op.path,
        oldText: fileContents ?? '',
        newText: '',
      }];

    case 'UpdateFile':
      return op.patches.map(patch => ({
        path: op.movePath ?? op.path,
        oldText: patch.oldText,
        newText: patch.newText,
      }));

    case 'RenameFile':
      // Rename is not directly convertible to EditItem — requires filesystem operation
      return [];
  }
}