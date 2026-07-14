import type Parser from "web-tree-sitter";
import type { EditTarget, MatchSpan, SymbolRef } from "./core/types";
import type { ParseResult } from "./core/ast-resolver";
import { MatchTier } from "./core/types";

export type { SymbolEditTarget } from "./core/types";

export interface SymbolicEditRequest {
  editIdx: number;
  target: EditTarget;
}

export interface AppliedSymbolicEdit {
  editIdx: number;
  operation: "replaceBody" | "insertBefore" | "insertAfter";
  symbolName: string;
  startIndex: number;
  endIndex: number;
}

export interface ApplySymbolicEditsInput {
  content: string;
  filePath: string;
  astResolver: AstResolverForSymbolic | null;
  edits: SymbolicEditRequest[];
}

export interface ApplySymbolicEditsResult {
  newContent: string;
  matchSpans: MatchSpan[];
  applied: AppliedSymbolicEdit[];
}

export interface ResolveSymbolicEditLineRangeInput {
  content: string;
  filePath: string;
  astResolver: AstResolverForSymbolic | null;
  edit: Omit<SymbolicEditRequest, "editIdx">;
}

export interface SymbolicGuidanceInput {
  content: string;
  filePath: string;
  astResolver: AstResolverForSymbolic | null;
  spans: Array<{ startIndex: number; endIndex: number }>;
  threshold?: number;
}

interface AstResolverForSymbolic {
  parseFile(content: string, filePath: string): Promise<ParseResult | null>;
  findSymbolNode(tree: Parser.Tree, anchor: { symbolName?: string; symbolKind?: string; symbolLine?: number }): Parser.SyntaxNode | null;
  findEnclosingSymbols?(tree: Parser.Tree, startByte: number, endByte: number): SymbolRef[];
  disposeParseResult(result: ParseResult): void;
}

interface ResolvedSymbolicEdit extends SymbolicEditRequest {
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
  operation: AppliedSymbolicEdit["operation"];
  body: string;
}

export function isSymbolicEdit(value: Record<string, unknown>): boolean {
  const target = value.target;
  if (!target || typeof target !== "object") return false;
  const t = target as Record<string, unknown>;
  // A target is symbolic if it has an operation field
  return (
    typeof t.replaceBody === "string" ||
    typeof t.insertBefore === "string" ||
    typeof t.insertAfter === "string"
  );
}

export async function resolveSymbolicEditLineRange(
  input: ResolveSymbolicEditLineRangeInput,
): Promise<[number, number] | null> {
  const resolved = await resolveSymbolicEdit({ ...input.edit, editIdx: 0 }, input.content, input.filePath, input.astResolver);
  if (!resolved) return null;
  return [resolved.startLine, resolved.endLine];
}

export async function buildSymbolicEditGuidance(
  input: SymbolicGuidanceInput,
): Promise<string[]> {
  if (!input.astResolver?.findEnclosingSymbols || input.spans.length === 0) return [];
  const threshold = input.threshold ?? 0.85;
  const notes: string[] = [];
  const seen = new Set<string>();
  let parseResult: ParseResult | null = null;

  try {
    parseResult = await input.astResolver.parseFile(input.content, input.filePath);
    if (!parseResult || parseResult.hasErrors) return [];

    for (const span of input.spans) {
      if (span.endIndex < span.startIndex) {
        throw new RangeError(`Invalid span: endIndex (${span.endIndex}) < startIndex (${span.startIndex}) in buildSymbolicEditGuidance`);
      }
      const startIndex = span.startIndex;
      const endIndex = span.endIndex;
      const symbols = input.astResolver.findEnclosingSymbols(parseResult.tree, startIndex, endIndex);
      const symbol = symbols[0];
      if (!symbol) continue;
      const symbolLength = Math.max(symbol.endByte - symbol.startByte, 1);
      const editLength = Math.max(endIndex - startIndex, 0);
      const coverage = editLength / symbolLength;
      if (coverage < threshold) continue;
      const key = `${symbol.name}:${symbol.startByte}`;
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push(
        `⚠ Symbol edit preferred: this oldText/newText edit covers ${Math.round(coverage * 100)}% of ${symbol.kind} \`${symbol.name}\`. Use { target: { name: "${symbol.name}", kind: "${symbol.kind}", line: ${symbol.lineStart} }, replaceBody: "..." } for whole-symbol changes.`,
      );
    }
  } finally {
    if (parseResult) {
      input.astResolver.disposeParseResult(parseResult);
    }
  }

  return notes;
}

export async function applySymbolicEdits(
  input: ApplySymbolicEditsInput,
): Promise<ApplySymbolicEditsResult> {
  let newContent = input.content;
  const resolved: ResolvedSymbolicEdit[] = [];

  // Validate all targets have enough identifying info before attempting resolution
  for (const edit of input.edits) {
    const hasName = edit.target.name || edit.target.namePath;
    const hasLine = edit.target.line != null;
    if (!hasName && !hasLine) {
      throw new Error(
        `Symbol edit #${edit.editIdx + 1} needs an identifier: provide target.name, target.namePath, or target.line (1-based line number).`
      );
    }
  }

  for (const edit of input.edits) {
    const item = await resolveSymbolicEdit(edit, newContent, input.filePath, input.astResolver);
    if (!item) {
      throw new Error(`Could not resolve symbol edit #${edit.editIdx + 1}: ${formatTarget(edit.target)}`);
    }
    resolved.push(item);
  }

  // Sort in descending order (highest index first) so edits are applied from
  // highest to lowest to prevent earlier edits from shifting subsequent indices
  // when mutating the string.
  resolved.sort((a, b) => {
    const aIndex = operationIndex(a);
    const bIndex = operationIndex(b);
    const delta = bIndex - aIndex;
    return delta !== 0 ? delta : a.editIdx - b.editIdx;
  });

  // Check for overlapping ranges and reject if any overlaps detected
  const overlaps: Array<{ a: ResolvedSymbolicEdit; b: ResolvedSymbolicEdit }> = [];
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];
      const aStart = a.startIndex;
      const aEnd = a.endIndex;
      const bStart = b.startIndex;
      const bEnd = b.endIndex;
      if (aStart < bEnd && aEnd > bStart) {
        overlaps.push({ a, b });
      }
    }
  }
  if (overlaps.length > 0) {
    const details = overlaps
      .map(
        ({ a, b }) =>
          `  - ${formatTarget(a.target)} (${a.startIndex}-${a.endIndex}) overlaps with ${formatTarget(b.target)} (${b.startIndex}-${b.endIndex})`,
      )
      .join("\n");
    throw new Error(
      `applySymbolicEdits: overlapping symbol edits detected:\n${details}`,
    );
  }

  const matchSpans: MatchSpan[] = [];
  const applied: AppliedSymbolicEdit[] = [];

  for (const edit of resolved) {
    const startIndex = edit.startIndex;
    const endIndex = edit.endIndex;
    const insertIndex = operationIndex(edit);

    if (edit.operation === "replaceBody") {
      newContent = newContent.slice(0, startIndex) + edit.body + newContent.slice(endIndex);
    } else {
      newContent = newContent.slice(0, insertIndex) + edit.body + newContent.slice(insertIndex);
    }

    matchSpans.push({
      editIndex: edit.editIdx,
      matchIndex: startIndex,
      matchLength: Math.max(endIndex - startIndex, 0),
      newText: edit.body,
      tier: MatchTier.EXACT,
      replaceAll: false,
      description: edit.target.description,
      matchNote: `symbolic ${edit.operation} on ${formatTarget(edit.target)}`,
    });
    applied.push({
      editIdx: edit.editIdx,
      operation: edit.operation,
      symbolName: targetNameFromEditTarget(edit.target),
      startIndex,
      endIndex,
    });
  }

  return { newContent, matchSpans, applied };
}

async function resolveSymbolicEdit(
  edit: SymbolicEditRequest,
  content: string,
  filePath: string,
  astResolver: AstResolverForSymbolic | null,
): Promise<ResolvedSymbolicEdit | null> {
  if (!astResolver) {
    throw new Error("Symbol edit requires AST support for this session.");
  }

  const operation = getOperation(edit.target);
  const body = getOperationBody(edit.target, operation);
  const anchor = targetToAnchor(edit.target);
  let parseResult: ParseResult | null = null;

  try {
    parseResult = await astResolver.parseFile(content, filePath);
    if (!parseResult || parseResult.hasErrors) return null;
    const node = astResolver.findSymbolNode(parseResult.tree, anchor);
    if (!node) return null;
    return {
      ...edit,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      operation,
      body,
    };
  } finally {
    if (parseResult) {
      astResolver.disposeParseResult(parseResult);
    }
  }
}

function getOperation(target: EditTarget): AppliedSymbolicEdit["operation"] {
  const operations = [
    target.replaceBody !== undefined ? "replaceBody" : null,
    target.insertBefore !== undefined ? "insertBefore" : null,
    target.insertAfter !== undefined ? "insertAfter" : null,
  ].filter((value): value is AppliedSymbolicEdit["operation"] => value !== null);

  if (operations.length !== 1) {
    throw new Error("Symbol edit must provide exactly one of replaceBody, insertBefore, or insertAfter.");
  }
  return operations[0];
}

function getOperationBody(target: EditTarget, operation: AppliedSymbolicEdit["operation"]): string {
  const body = target[operation];
  if (typeof body !== "string") {
    throw new Error(`${operation} must be a string.`);
  }
  return body;
}

function targetToAnchor(target: EditTarget): { symbolName?: string; symbolKind?: string; symbolLine?: number } {
  return {
    symbolName: target.name,
    symbolKind: target.kind,
    symbolLine: target.line,
  };
}

function targetNameFromEditTarget(target: EditTarget): string {
  if (target.name !== undefined) return target.name;
  if (target.namePath) {
    const parts = target.namePath.split(/[/.#]/).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  // Line-only target: generate descriptive label
  if (target.line != null) {
    return `<symbol at line ${target.line}${target.kind ? ` (${target.kind})` : ""}>`;
  }
  return "<unnamed>";
}

function formatTarget(target: EditTarget): string {
  if (target.namePath) return target.namePath;
  if (target.name) return target.name;
  if (target.line != null) return `<symbol at line ${target.line}${target.kind ? ` (${target.kind})` : ""}>`;
  return "<unnamed>";
}

function operationIndex(edit: ResolvedSymbolicEdit): number {
  if (edit.operation === "insertAfter") return edit.endIndex;
  return edit.startIndex;
}
