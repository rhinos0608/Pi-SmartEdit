/**
 * Fake-logic detector for AI-generated code edits.
 *
 * Identifies common placeholder / tautological patterns that look correct
 * but do no real work:
 *   - stub-body: function whose entire body is a constant return, pass,
 *     ellipsis, or "not implemented" throw
 *   - constant-condition: if/while/ternary test that is always true/false
 *   - empty-catch: catch/except block with no real error handling
 *
 * Advisory only. Never throws — any internal error returns a safe passing
 * result so the edit pipeline is not blocked.
 */

import { createRequire } from "module";
import { readFile } from "fs/promises";
import type Parser from "web-tree-sitter";
import { parseFile, type ParseResult } from "../ast/ast-resolver.js";

// ─── Public types ────────────────────────────────────────────────────

export type FakeLogicRule = "stub-body" | "constant-condition" | "empty-catch";

export interface FakeLogicFinding {
  rule: FakeLogicRule;
  line: number;
  message: string;
}

export interface FakeLogicResult {
  passed: boolean;
  findings: FakeLogicFinding[];
}

interface CheckOptions {
  oldContent?: string;
  maxFindings?: number;
}

// ─── Constants ───────────────────────────────────────────────────────

import {
  BODY_TYPES,
  CATCH_NODE_TYPES,
  COMMENT_TYPES,
  DEFAULT_MAX_FINDINGS,
  FUNCTION_NODE_TYPES,
  LOOP_NODE_TYPES,
  MAX_FILE_BYTES,
} from "./fake-logic-constants.js";

export {
  BODY_TYPES,
  CATCH_NODE_TYPES,
  COMMENT_TYPES,
  DEFAULT_MAX_FINDINGS,
  FUNCTION_NODE_TYPES,
  LOOP_NODE_TYPES,
  MAX_FILE_BYTES,
} from "./fake-logic-constants.js";

// ─── Entry point ─────────────────────────────────────────────────────

/**
 * Check content for fake-logic patterns.
 *
 * Safe to call at any point — never throws. On error or unsupported input,
 * returns a passing result.
 */
export async function checkFakeLogic(
  content: string,
  filePath: string,
  languageId: string | null,
  opts?: CheckOptions,
): Promise<FakeLogicResult> {
  const maxFindings = opts?.maxFindings ?? DEFAULT_MAX_FINDINGS;

  try {
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return safePass();
    }

    const effectiveLang = normalizeLanguage(languageId, filePath);
    let parseResult: ParseResult | null = await parseFile(content, filePath);

    // The bundled @vscode/tree-sitter-wasm parser supports grammars (e.g.
    // Python v15) that the web-tree-sitter package in this repo cannot load.
    // Try it when the standard parser fails so we can still do AST-based
    // detection for languages whose WASM is present.
    if (!parseResult) {
      parseResult = await parseWithBundledParser(content, filePath, effectiveLang);
    }

    let findings: FakeLogicFinding[] = [];

    if (parseResult) {
      try {
        findings = analyzeAst(parseResult.tree.rootNode, effectiveLang);
      } finally {
        parseResult.tree.delete();
        parseResult.parser.delete();
      }
    } else {
      findings = runRegexFallback(content, effectiveLang);
    }

    findings = suppressOldContentFindings(findings, content, opts?.oldContent);
    findings = findings.slice(0, maxFindings);

    return {
      passed: findings.length === 0,
      findings,
    };
  } catch {
    return safePass();
  }
}

function safePass(): FakeLogicResult {
  return { passed: true, findings: [] };
}

// ─── AST analysis ────────────────────────────────────────────────────

function analyzeAst(
  root: Parser.SyntaxNode,
  _language: string,
): FakeLogicFinding[] {
  const findings: FakeLogicFinding[] = [];

  walkTree(root, (node) => {
    const finding = checkNodeForFakeLogic(node);
    if (finding) findings.push(finding);
  });

  return findings;
}

function checkNodeForFakeLogic(node: Parser.SyntaxNode): FakeLogicFinding | null {
  if (FUNCTION_NODE_TYPES.has(node.type)) {
    return checkStubBody(node);
  }
  if (LOOP_NODE_TYPES.has(node.type)) {
    return checkConstantCondition(node);
  }
  if (CATCH_NODE_TYPES.has(node.type)) {
    return checkEmptyCatch(node);
  }
  return null;
}

// ─── Stub-body detection ─────────────────────────────────────────────

function checkStubBody(node: Parser.SyntaxNode): FakeLogicFinding | null {
  const params = node.childForFieldName("parameters");
  if (!params || countNamedChildren(params) === 0) {
    return null;
  }

  const body = getBodyNode(node);
  if (!body || !BODY_TYPES.has(body.type)) {
    return null;
  }

  const stmts = getNonCommentNamedChildren(body);
  if (stmts.length !== 1) {
    return null;
  }

  const stmt = stmts[0];
  if (!isStubStatement(stmt)) {
    return null;
  }

  return {
    rule: "stub-body",
    line: node.startPosition.row + 1,
    message: `Function body appears to be a stub (${stmt.text.replace(/\s+/g, " ").slice(0, 40)})`,
  };
}

function isStubStatement(stmt: Parser.SyntaxNode): boolean {
  if (stmt.type === "return_statement") {
    const value = stmt.namedChildren[0];
    if (!value) return false;
    return isConstantReturnValue(value);
  }

  if (stmt.type === "pass_statement") {
    return true;
  }

  if (stmt.type === "throw_statement") {
    return /not\s+implemented/i.test(stmt.text);
  }

  if (stmt.type === "raise_statement") {
    return /NotImplementedError|not\s+implemented/i.test(stmt.text);
  }

  return false;
}

function isConstantReturnValue(node: Parser.SyntaxNode): boolean {
  const t = node.type;
  if (["true", "false", "null", "undefined", "number", "integer"].includes(t)) {
    return true;
  }
  if (t === "none") {
    return true;
  }
  if (t === "string") {
    const text = node.text;
    return text === '""' || text === "''" || text === "``";
  }
  if (t === "array" || t === "object") {
    return true;
  }
  return false;
}

// ─── Constant-condition detection ────────────────────────────────────

function checkConstantCondition(node: Parser.SyntaxNode): FakeLogicFinding | null {
  const cond = extractCondition(node);
  if (!cond) return null;

  const message = classifyCondition(cond);
  if (!message) return null;

  if (isBenignWhileTrue(node, cond)) {
    return null;
  }

  return {
    rule: "constant-condition",
    line: node.startPosition.row + 1,
    message,
  };
}

function classifyCondition(cond: Parser.SyntaxNode): string | null {
  if (isLiteralBooleanOrNumber(cond)) {
    return `Constant condition: literal ${cond.text}`;
  }
  if (isSelfComparison(cond)) {
    return `Constant condition: self-comparison ${cond.text.replace(/\s+/g, " ").slice(0, 40)}`;
  }
  return null;
}

function isBenignWhileTrue(node: Parser.SyntaxNode, cond: Parser.SyntaxNode): boolean {
  if (node.type !== "while_statement") return false;
  if (!isLiteralTrue(cond)) return false;
  const body = getBodyNode(node);
  if (!body) return false;
  return bodyHasExit(body);
}

function extractCondition(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const viaField = extractFieldCondition(node);
  if (viaField) return viaField;
  if (node.type === "conditional_expression") {
    return extractTernaryCondition(node);
  }
  return null;
}

function extractFieldCondition(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const cond = node.childForFieldName("condition");
  if (!cond) return null;
  return unwrapParenthesized(cond);
}

function unwrapParenthesized(cond: Parser.SyntaxNode): Parser.SyntaxNode {
  if (cond.type !== "parenthesized_expression") return cond;
  return cond.namedChildren[0] ?? cond;
}

function extractTernaryCondition(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  // Python conditional_expression has no named fields; the condition sits
  // between the "if" and "else" anonymous tokens.
  const children = node.children;
  const ifIndex = findAnonymousText(children, "if");
  if (ifIndex <= 0) return null;
  const elseIndex = findAnonymousText(children, "else", ifIndex + 1);
  if (elseIndex <= ifIndex) return null;
  return findFirstNamedBetween(children, ifIndex, elseIndex);
}

function findAnonymousText(
  children: Parser.SyntaxNode[],
  text: string,
  from = 0,
): number {
  for (let i = from; i < children.length; i++) {
    const child = children[i];
    if (isAnonymousText(child, text)) return i;
  }
  return -1;
}

function isAnonymousText(node: Parser.SyntaxNode, text: string): boolean {
  return !node.isNamed && node.text === text;
}

function findFirstNamedBetween(
  children: Parser.SyntaxNode[],
  start: number,
  end: number,
): Parser.SyntaxNode | null {
  for (let i = start + 1; i < end; i++) {
    const child = children[i];
    if (child.isNamed) return child;
  }
  return null;
}

function isLiteralBooleanOrNumber(node: Parser.SyntaxNode): boolean {
  return ["true", "false", "number", "integer"].includes(node.type);
}

function isLiteralTrue(node: Parser.SyntaxNode): boolean {
  return node.type === "true" || node.text === "True";
}

function isSelfComparison(node: Parser.SyntaxNode): boolean {
  if (node.type === "binary_expression") {
    return isBinarySelfEquality(node);
  }
  if (node.type === "comparison_operator") {
    return isComparisonOperatorSelfEquality(node);
  }
  return false;
}

function isBinarySelfEquality(node: Parser.SyntaxNode): boolean {
  if (!hasStrictEqualityOp(node)) return false;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  return textsEqual(left, right);
}

function hasStrictEqualityOp(node: Parser.SyntaxNode): boolean {
  return node.children.some((c) => isEqualityOp(c));
}

function isEqualityOp(child: Parser.SyntaxNode): boolean {
  if (child.isNamed) return false;
  return child.text === "===" || child.text === "==";
}

function textsEqual(
  left: Parser.SyntaxNode | null,
  right: Parser.SyntaxNode | null,
): boolean {
  if (!left) return false;
  if (!right) return false;
  return left.text === right.text;
}

function isComparisonOperatorSelfEquality(node: Parser.SyntaxNode): boolean {
  const eqIndex = findDoubleEquals(node.children);
  if (eqIndex <= 0) return false;
  if (eqIndex >= node.children.length - 1) return false;
  const left = node.children[eqIndex - 1];
  const right = node.children[eqIndex + 1];
  if (!left.isNamed) return false;
  if (!right.isNamed) return false;
  return left.text === right.text;
}

function findDoubleEquals(children: Parser.SyntaxNode[]): number {
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isAnonymousText(child, "==")) return i;
  }
  return -1;
}

const EXIT_NODE_TYPES: ReadonlySet<string> = new Set([
  "break_statement",
  "return_statement",
  "throw_statement",
  "raise_statement",
  "yield_expression",
  "yield",
]);

function bodyHasExit(body: Parser.SyntaxNode): boolean {
  let exits = false;
  walkTree(body, (n) => {
    if (isExitNode(n)) {
      exits = true;
    }
  });
  return exits;
}

function isExitNode(node: Parser.SyntaxNode): boolean {
  return EXIT_NODE_TYPES.has(node.type);
}

// ─── Empty-catch detection ───────────────────────────────────────────

function checkEmptyCatch(node: Parser.SyntaxNode): FakeLogicFinding | null {
  const body = getBodyNode(node);
  if (!body) return null;

  const { comments, stmts } = splitCatchBody(body);
  collectNodeComments(node, body, comments);

  if (!isEmptyCatchStmts(stmts)) return null;
  if (hasJustifyingComment(comments)) return null;

  return {
    rule: "empty-catch",
    line: node.startPosition.row + 1,
    message: "Empty catch/except block without justification",
  };
}

interface CatchBodyParts {
  comments: Parser.SyntaxNode[];
  stmts: Parser.SyntaxNode[];
}

function splitCatchBody(body: Parser.SyntaxNode): CatchBodyParts {
  const comments: Parser.SyntaxNode[] = [];
  const stmts: Parser.SyntaxNode[] = [];
  for (const child of body.children) {
    if (!child.isNamed) continue;
    if (COMMENT_TYPES.has(child.type)) {
      comments.push(child);
    } else {
      stmts.push(child);
    }
  }
  return { comments, stmts };
}

function collectNodeComments(
  node: Parser.SyntaxNode,
  body: Parser.SyntaxNode,
  comments: Parser.SyntaxNode[],
): void {
  // Some grammars (Python) attach comments to the catch node directly rather
  // than to the body block, so collect those too.
  for (const child of node.children) {
    if (isExtraCatchComment(child, body)) {
      comments.push(child);
    }
  }
}

function isExtraCatchComment(
  child: Parser.SyntaxNode,
  body: Parser.SyntaxNode,
): boolean {
  if (child === body) return false;
  if (!child.isNamed) return false;
  return COMMENT_TYPES.has(child.type);
}

function isEmptyCatchStmts(stmts: Parser.SyntaxNode[]): boolean {
  if (stmts.length === 0) return true;
  return stmts.length === 1 && isPassStatement(stmts[0]);
}

function isPassStatement(stmt: Parser.SyntaxNode): boolean {
  return stmt.type === "pass_statement";
}

function hasJustifyingComment(comments: Parser.SyntaxNode[]): boolean {
  return comments.some(isJustifyingComment);
}

function isJustifyingComment(comment: Parser.SyntaxNode): boolean {
  return /\b(intentional|ignore)\b/i.test(comment.text);
}

// ─── Regex fallback ──────────────────────────────────────────────────

function runRegexFallback(content: string, language: string): FakeLogicFinding[] {
  const lang = language.toLowerCase();
  const isPy = lang === "python";

  return [
    ...collectLiteralConditionFallback(content, isPy),
    ...collectCatchFallback(content),
    ...collectExceptFallback(content),
  ];
}

function collectLiteralConditionFallback(content: string, isPy: boolean): FakeLogicFinding[] {
  // Only the low-risk literal pattern reliably detectable by regex.
  const pattern = isPy ? /\bif\s+(True|False)\s*:/g : /\bif\s*\(\s*(true|false)\s*\)/g;
  return collectPattern(content, pattern, (literal, index) => ({
    rule: "constant-condition",
    line: lineAtIndex(content, index),
    message: `Constant condition: literal ${literal}`,
  }));
}

function collectCatchFallback(content: string): FakeLogicFinding[] {
  const catchRe = /catch\s*\(\s*(?:[^)]*)\s*\)\s*\{(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|pass\s*;?)\s*)*\}/g;
  return collectPattern(content, catchRe, (_match, index, full) => {
    if (hasIntentionalIgnore(content, index, full.length)) return null;
    return {
      rule: "empty-catch",
      line: lineAtIndex(content, index),
      message: "Empty catch block without justification",
    };
  });
}

function collectExceptFallback(content: string): FakeLogicFinding[] {
  const exceptRe = /except(?:\s+\w+(?:\s+as\s+\w+)?)?\s*:(?:\s*(?:#[^\n]*|pass)\s*)*(?=\n|$)/g;
  return collectPattern(content, exceptRe, (_match, index, full) => {
    if (hasIntentionalIgnore(content, index, full.length)) return null;
    return {
      rule: "empty-catch",
      line: lineAtIndex(content, index),
      message: "Empty except block without justification",
    };
  });
}

function collectPattern(
  content: string,
  pattern: RegExp,
  build: (match: string, index: number, full: string) => FakeLogicFinding | null,
): FakeLogicFinding[] {
  const findings: FakeLogicFinding[] = [];
  let m: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((m = pattern.exec(content)) !== null) {
    const literal = m[1] ?? m[0];
    const finding = build(literal, m.index, m[0]);
    if (finding) findings.push(finding);
  }
  return findings;
}

function hasIntentionalIgnore(content: string, start: number, length: number): boolean {
  const snippet = content.slice(start, start + length);
  return /\b(intentional|ignore)\b/i.test(snippet);
}

function lineAtIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

// ─── Old-content suppression ─────────────────────────────────────────

function suppressOldContentFindings(
  findings: FakeLogicFinding[],
  content: string,
  oldContent?: string,
): FakeLogicFinding[] {
  if (!oldContent) return findings;

  const oldLines = new Set(
    oldContent.split("\n").map((l) => l.trim()),
  );
  const contentLines = content.split("\n");

  return findings.filter((f) => {
    const lineText = contentLines[f.line - 1]?.trim();
    return lineText === undefined || !oldLines.has(lineText);
  });
}

// ─── Bundled tree-sitter fallback ────────────────────────────────────

interface BundledParseResult extends ParseResult {
  parser: Parser;
  tree: Parser.Tree;
}

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */

let bundledParserModule: unknown = null;
let bundledInitPromise: Promise<void> | null = null;

async function getBundledParserModule(): Promise<any> {
  if (bundledParserModule) return bundledParserModule;
  if (bundledInitPromise) {
    await bundledInitPromise;
    return bundledParserModule;
  }

  bundledInitPromise = (async () => {
    const req = createRequire(import.meta.url);
    const mod = req("@vscode/tree-sitter-wasm/wasm/tree-sitter.js");
    const wasmPath = req.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm");
    await mod.Parser.init({ locateFile: () => wasmPath });
    bundledParserModule = mod;
  })();

  await bundledInitPromise;
  return bundledParserModule;
}

const BUNDLED_WASM_MAP: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  cpp: "tree-sitter-cpp.wasm",
  c: "tree-sitter-cpp.wasm",
  ruby: "tree-sitter-ruby.wasm",
};

async function parseWithBundledParser(
  content: string,
  filePath: string,
  language: string,
): Promise<BundledParseResult | null> {
  try {
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    const langKey = language.toLowerCase();
    const wasmName = BUNDLED_WASM_MAP[langKey] ?? BUNDLED_WASM_MAP[ext.slice(1)];
    if (!wasmName) return null;

    const mod = await getBundledParserModule();
    const req = createRequire(import.meta.url);
    const wasmPath = req.resolve(`@vscode/tree-sitter-wasm/wasm/${wasmName}`);
    const wasm = await readFile(wasmPath);
    const grammar = await mod.Language.load(wasm);

    const parser = new mod.Parser();
    parser.setLanguage(grammar);
    const tree = parser.parse(content);

    return {
      parser,
      tree,
      language: ext || `.${langKey}`,
      hasErrors: tree.rootNode.hasError,
      content,
    };
  } catch {
    return null;
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizeLanguage(languageId: string | null, filePath: string): string {
  if (languageId) return languageId;
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "jsx",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".cpp": "cpp",
    ".c": "c",
    ".h": "cpp",
    ".rb": "ruby",
  };
  return map[ext] ?? ext.slice(1) ?? "unknown";
}

function getBodyNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const viaField = getFieldBody(node);
  if (viaField) return viaField;
  return findTrailingBody(node);
}

function getFieldBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const body = node.childForFieldName("body");
  if (!body) return null;
  if (!BODY_TYPES.has(body.type)) return null;
  return body;
}

function findTrailingBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let i = node.childCount - 1; i >= 0; i--) {
    const child = node.child(i);
    if (isNamedBodyChild(child)) {
      return child;
    }
  }
  return null;
}

function isNamedBodyChild(child: Parser.SyntaxNode | null): child is Parser.SyntaxNode {
  if (!child) return false;
  if (!child.isNamed) return false;
  return BODY_TYPES.has(child.type);
}

function getNonCommentNamedChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (isKeptChild(child)) {
      out.push(child);
    }
  }
  return out;
}

function isKeptChild(child: Parser.SyntaxNode | null): child is Parser.SyntaxNode {
  if (!child) return false;
  if (!child.isNamed) return false;
  return !COMMENT_TYPES.has(child.type);
}

function countNamedChildren(node: Parser.SyntaxNode): number {
  let count = 0;
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.isNamed) count++;
  }
  return count;
}

function walkTree(
  root: Parser.SyntaxNode,
  visitor: (node: Parser.SyntaxNode) => void,
): void {
  const stack: Array<{ node: Parser.SyntaxNode; index: number }> = [
    { node: root, index: 0 },
  ];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    visitOnFirst(frame, visitor);
    if (!descendOnce(frame, stack)) {
      stack.pop();
    }
  }
}

function visitOnFirst(
  frame: { node: Parser.SyntaxNode; index: number },
  visitor: (node: Parser.SyntaxNode) => void,
): void {
  if (frame.index !== 0) return;
  if (!frame.node.isNamed) return;
  visitor(frame.node);
}

function descendOnce(
  frame: { node: Parser.SyntaxNode; index: number },
  stack: Array<{ node: Parser.SyntaxNode; index: number }>,
): boolean {
  if (frame.index >= frame.node.childCount) return false;
  const child = frame.node.child(frame.index);
  frame.index++;
  if (!child) return true;
  stack.push({ node: child, index: 0 });
  return true;
}
