import type Parser from "web-tree-sitter";
import type { EditAnchor, MatchSpan, SymbolEditTarget, SymbolRef } from "../lib/types";
import type { ParseResult } from "../lib/ast-resolver";
import { MatchTier } from "../lib/types";

export type { SymbolEditTarget };

export interface SymbolicEditRequest {
  editIdx: number;
  symbol: SymbolEditTarget;
  replaceBody?: string;
  insertBefore?: string;
  insertAfter?: string;
  description?: string;
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
  findSymbolNode(tree: Parser.Tree, anchor: EditAnchor): Parser.SyntaxNode | null;
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
  const symbol = value.symbol;
  if (!symbol || typeof symbol !== "object") return false;
  const s = symbol as Record<string, unknown>;
  return (
    typeof s.name === "string" ||
    (Array.isArray(s.namePath) &&
      (s.namePath as unknown[]).length > 0 &&
      (s.namePath as unknown[]).every((p) => typeof p === "string"))
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
      // symbolLength uses Math.max(..., 1) to guard against division-by-zero when
      // a symbol has zero length (e.g. empty function body). editLength uses Math.max(..., 0)
      // to avoid negative lengths but allow zero-width edits. The subsequent coverage
      // calculation (editLength / symbolLength) relies on symbolLength being non-zero.
      const symbolLength = Math.max(symbol.endByte - symbol.startByte, 1);
      const editLength = Math.max(endIndex - startIndex, 0);
      const coverage = editLength / symbolLength;
      if (coverage < threshold) continue;
      const key = `${symbol.name}:${symbol.startByte}`;
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push(
        `⚠ Symbol edit preferred: this oldText/newText edit covers ${Math.round(coverage * 100)}% of ${symbol.kind} \`${symbol.name}\`. Use { symbol: { name: "${symbol.name}", kind: "${symbol.kind}", line: ${symbol.lineStart} }, replaceBody: "..." } for whole-symbol changes.`,
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

  for (const edit of input.edits) {
    const item = await resolveSymbolicEdit(edit, newContent, input.filePath, input.astResolver);
    if (!item) {
      throw new Error(`Could not resolve symbol edit #${edit.editIdx + 1}: ${formatSymbolTarget(edit.symbol)}`);
    }
    resolved.push(item);
  }

  // Sort in descending order (highest index first) so edits are applied from
  // highest to lowest to prevent earlier edits from shifting subsequent indices
  // when mutating the string. Tie-breaker uses editIdx to deterministically order
  // edits with the same operationIndex. See resolved.sort, operationIndex, editIdx.
  resolved.sort((a, b) => {
    const aIndex = operationIndex(a);
    const bIndex = operationIndex(b);
    const delta = bIndex - aIndex;
    return delta !== 0 ? delta : a.editIdx - b.editIdx;
  });

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
      description: edit.description,
      matchNote: `symbolic ${edit.operation} on ${formatSymbolTarget(edit.symbol)}`,
    });
    applied.push({
      editIdx: edit.editIdx,
      operation: edit.operation,
      symbolName: symbolNameFromTarget(edit.symbol),
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

  const operation = getOperation(edit);
  const body = getOperationBody(edit, operation);
  const anchor = symbolTargetToAnchor(edit.symbol);
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

function getOperation(edit: SymbolicEditRequest): AppliedSymbolicEdit["operation"] {
  const operations = [
    edit.replaceBody !== undefined ? "replaceBody" : null,
    edit.insertBefore !== undefined ? "insertBefore" : null,
    edit.insertAfter !== undefined ? "insertAfter" : null,
  ].filter((value): value is AppliedSymbolicEdit["operation"] => value !== null);

  if (operations.length !== 1) {
    throw new Error("Symbol edit must provide exactly one of replaceBody, insertBefore, or insertAfter.");
  }
  return operations[0];
}

function getOperationBody(edit: SymbolicEditRequest, operation: AppliedSymbolicEdit["operation"]): string {
  const body = edit[operation];
  if (typeof body !== "string") {
    throw new Error(`${operation} must be a string.`);
  }
  return body;
}

function symbolTargetToAnchor(target: SymbolEditTarget): EditAnchor {
  return {
    symbolName: symbolNameFromTarget(target),
    symbolKind: target.kind,
    symbolLine: target.line,
  };
}

function symbolNameFromTarget(target: SymbolEditTarget): string {
  if ("name" in target && target.name !== undefined) return target.name;
  if ("namePath" in target && target.namePath) {
    const parts = target.namePath.split(/[/.#]/).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  throw new Error("Symbol edit requires symbol.name or symbol.namePath.");
}

function formatSymbolTarget(target: SymbolEditTarget): string {
  return target.namePath ?? target.name ?? "<unnamed>";
}

function operationIndex(edit: ResolvedSymbolicEdit): number {
  if (edit.operation === "insertAfter") return edit.endIndex;
  return edit.startIndex;
}
