import { generateDiffString } from "./core/edit-diff.js";
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";

export interface PositionalEdit {
  filePath: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

export interface StagedFile {
  filePath: string;
  originalContent: string;
  newContent: string;
  edits: PositionalEdit[];
}

export interface PlannedRename {
  stagedFiles: StagedFile[];
  diffString: string;
}

const DEFAULT_MAX_DIFF_BYTES = 200 * 1024;

export async function planPositionalEdits(
  workspaceEdit: LspWorkspaceEdit,
  readFile: (path: string) => Promise<string>,
  opts?: { maxDiffBytes?: number }
): Promise<PlannedRename> {
  const maxDiffBytes = opts?.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;

  if (!workspaceEdit || !Array.isArray(workspaceEdit.fileEdits) || workspaceEdit.fileEdits.length === 0) {
    throw new Error("workspaceEdit must have at least one fileEdit");
  }

  const byPath = new Map<string, (typeof workspaceEdit.fileEdits)[number]>();
  for (const fe of workspaceEdit.fileEdits) {
    const existing = byPath.get(fe.filePath);
    if (existing) {
      existing.edits = [...existing.edits, ...fe.edits];
    } else {
      byPath.set(fe.filePath, { ...fe, edits: [...fe.edits] });
    }
  }

  const stagedFiles: StagedFile[] = [];

  for (const fileEdit of byPath.values()) {
    let originalContent: string;
    try {
      originalContent = await readFile(fileEdit.filePath);
    } catch (err) {
      throw new Error(`cannot read file for rename: ${fileEdit.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const eol = originalContent.includes("\r\n") ? "\r\n" : "\n";
    const normalized = originalContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const sorted = [...fileEdit.edits].sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
      return b.range.start.character - a.range.start.character;
    });

    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        const bEnd = b.range.end;
        const aStart = a.range.start;
        if (bEnd.line > aStart.line || (bEnd.line === aStart.line && bEnd.character > aStart.character)) {
          throw new Error(`overlapping edits in ${fileEdit.filePath}`);
        }
      }
    }

    let curLines = normalized.split("\n");

    for (const edit of sorted) {
      const { start, end } = edit.range;

      if (start.line < 0 || end.line < 0 || start.line >= curLines.length || end.line >= curLines.length) {
        const isEOFInsertion = start.line === curLines.length && start.character === 0 && end.line === curLines.length && end.character === 0;
        if (!isEOFInsertion) {
          throw new Error(`edit range out of bounds in ${fileEdit.filePath}: [${start.line}:${start.character}-${end.line}:${end.character}] file has ${curLines.length} lines`);
        }
        const joined = curLines.join("\n");
        const updated = joined + edit.newText;
        curLines = updated.split("\n");
        continue;
      }
      if (start.character < 0 || end.character < 0) {
        throw new Error(`edit range has negative character in ${fileEdit.filePath}`);
      }
      if (start.character > curLines[start.line].length || end.character > curLines[end.line].length) {
        throw new Error(`edit range character out of bounds in ${fileEdit.filePath}: line ${start.line} len ${curLines[start.line].length} char ${start.character}`);
      }
      if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
        throw new Error(`edit range start after end in ${fileEdit.filePath}`);
      }

      const startOffset = offsetForPosition(curLines, start.line, start.character);
      const endOffset = offsetForPosition(curLines, end.line, end.character);
      const joined = curLines.join("\n");
      const updated = joined.slice(0, startOffset) + edit.newText + joined.slice(endOffset);
      curLines = updated.split("\n");
    }
    const newContentRaw = curLines.join("\n");
    const finalContent = eol === "\r\n" ? newContentRaw.replace(/\n/g, "\r\n") : newContentRaw;

    stagedFiles.push({
      filePath: fileEdit.filePath,
      originalContent,
      newContent: finalContent,
      edits: fileEdit.edits.map((e: PositionalEdit) => ({ filePath: fileEdit.filePath, range: e.range, newText: e.newText })),
    });
  }

  if (stagedFiles.length === 0) {
    throw new Error("no files staged (all files missing or empty workspaceEdit)");
  }

  const diffParts: string[] = [];
  for (const sf of stagedFiles) {
    const { diff } = generateDiffString(sf.originalContent, sf.newContent);
    diffParts.push(`--- ${sf.filePath}\n+++ ${sf.filePath}\n${diff}`);
  }
  let diffString = diffParts.join("\n\n");
  if (Buffer.byteLength(diffString, "utf8") > maxDiffBytes) {
    diffString = diffString.slice(0, maxDiffBytes) + "\n... [diff truncated]";
  }

  return { stagedFiles, diffString };
}

function offsetForPosition(lines: string[], line: number, character: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    offset += lines[i].length + 1;
  }
  return offset + character;
}
