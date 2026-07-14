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
import { parseFile, type ParseResult } from "../core/ast-resolver.js";

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

const MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_FINDINGS = 10;

const FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "method_definition",
  "arrow_function",
  "function_definition",
]);

const LOOP_NODE_TYPES = new Set([
  "if_statement",
  "while_statement",
  "ternary_expression",
  "conditional_expression",
]);

const CATCH_NODE_TYPES = new Set([
  "catch_clause",
  "except_clause",
]);

const BODY_TYPES = new Set([
  "statement_block",
  "block",
]);

const COMMENT_TYPES = new Set([
  "comment",
  "line_comment",
  "block_comment",
]);

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
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const finding = checkStubBody(node);
      if (finding) findings.push(finding);
      return;
    }

    if (LOOP_NODE_TYPES.has(node.type)) {
      const finding = checkConstantCondition(node);
      if (finding) findings.push(finding);
      return;
    }

    if (CATCH_NODE_TYPES.has(node.type)) {
      const finding = checkEmptyCatch(node);
      if (finding) findings.push(finding);
    }
  });

  return findings;
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

  let message: string | null = null;

  if (isLiteralBooleanOrNumber(cond)) {
    message = `Constant condition: literal ${cond.text}`;
  } else if (isSelfComparison(cond)) {
    message = `Constant condition: self-comparison ${cond.text.replace(/\s+/g, " ").slice(0, 40)}`;
  }

  if (!message) return null;

  if (node.type === "while_statement" && isLiteralTrue(cond)) {
    const body = getBodyNode(node);
    if (body && bodyHasExit(body)) {
      return null;
    }
  }

  return {
    rule: "constant-condition",
    line: node.startPosition.row + 1,
    message,
  };
}

function extractCondition(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const cond = node.childForFieldName("condition");
  if (cond) {
    if (cond.type === "parenthesized_expression") {
      return cond.namedChildren[0] ?? cond;
    }
    return cond;
  }

  // Python conditional_expression has no named fields; the condition sits
  // between the "if" and "else" anonymous tokens.
  if (node.type === "conditional_expression") {
    const children = node.children;
    const ifIndex = children.findIndex((c) => !c.isNamed && c.text === "if");
    const elseIndex = children.findIndex((c) => !c.isNamed && c.text === "else");
    if (ifIndex > 0 && elseIndex > ifIndex) {
      for (let i = ifIndex + 1; i < elseIndex; i++) {
        const child = children[i];
        if (child.isNamed) return child;
      }
    }
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
    const op = node.children.find((c) => !c.isNamed && /^(===|==)$/.test(c.text));
    if (!op) return false;
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (left && right && left.text === right.text) {
      return true;
    }
  }

  if (node.type === "comparison_operator") {
    const children = node.children;
    const eqIndex = children.findIndex((c) => !c.isNamed && c.text === "==");
    if (eqIndex > 0 && eqIndex < children.length - 1) {
      const left = children[eqIndex - 1];
      const right = children[eqIndex + 1];
      if (left.isNamed && right.isNamed && left.text === right.text) {
        return true;
      }
    }
  }

  return false;
}

function bodyHasExit(body: Parser.SyntaxNode): boolean {
  let exits = false;
  walkTree(body, (n) => {
    if (
      n.type === "break_statement" ||
      n.type === "return_statement" ||
      n.type === "throw_statement" ||
      n.type === "raise_statement" ||
      n.type === "yield_expression" ||
      n.type === "yield"
    ) {
      exits = true;
    }
  });
  return exits;
}

// ─── Empty-catch detection ───────────────────────────────────────────

function checkEmptyCatch(node: Parser.SyntaxNode): FakeLogicFinding | null {
  const body = getBodyNode(node);
  if (!body) return null;

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

  // Some grammars (Python) attach comments to the catch node directly rather
  // than to the body block, so collect those too.
  for (const child of node.children) {
    if (child !== body && child.isNamed && COMMENT_TYPES.has(child.type)) {
      comments.push(child);
    }
  }

  const isEmpty =
    stmts.length === 0 ||
    (stmts.length === 1 && stmts[0].type === "pass_statement");

  if (!isEmpty) return null;

  for (const c of comments) {
    if (/\b(intentional|ignore)\b/i.test(c.text)) {
      return null;
    }
  }

  return {
    rule: "empty-catch",
    line: node.startPosition.row + 1,
    message: "Empty catch/except block without justification",
  };
}

// ─── Regex fallback ──────────────────────────────────────────────────

function runRegexFallback(content: string, language: string): FakeLogicFinding[] {
  const findings: FakeLogicFinding[] = [];
  const lang = language.toLowerCase();
  const isPy = lang === "python";

  // Only the two low-risk patterns that are reliably detectable by regex.
  if (!isPy) {
    const ifRe = /\bif\s*\(\s*(true|false)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = ifRe.exec(content)) !== null) {
      findings.push({
        rule: "constant-condition",
        line: lineAtIndex(content, m.index),
        message: `Constant condition: literal ${m[1]}`,
      });
    }
  } else {
    const ifRe = /\bif\s+(True|False)\s*:/g;
    let m: RegExpExecArray | null;
    while ((m = ifRe.exec(content)) !== null) {
      findings.push({
        rule: "constant-condition",
        line: lineAtIndex(content, m.index),
        message: `Constant condition: literal ${m[1]}`,
      });
    }
  }

  // Empty catch (JS/TS) or except (Python).
  const catchRe = /catch\s*\(\s*(?:[^)]*)\s*\)\s*\{(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|pass\s*;?)\s*)*\}/g;
  let cm: RegExpExecArray | null;
  while ((cm = catchRe.exec(content)) !== null) {
    if (!hasIntentionalIgnore(content, cm.index, cm[0].length)) {
      findings.push({
        rule: "empty-catch",
        line: lineAtIndex(content, cm.index),
        message: "Empty catch block without justification",
      });
    }
  }

  const exceptRe = /except(?:\s+\w+(?:\s+as\s+\w+)?)?\s*:(?:\s*(?:#[^\n]*|pass)\s*)*(?=\n|$)/g;
  let em: RegExpExecArray | null;
  while ((em = exceptRe.exec(content)) !== null) {
    if (!hasIntentionalIgnore(content, em.index, em[0].length)) {
      findings.push({
        rule: "empty-catch",
        line: lineAtIndex(content, em.index),
        message: "Empty except block without justification",
      });
    }
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
  const body = node.childForFieldName("body");
  if (body && BODY_TYPES.has(body.type)) return body;
  for (let i = node.childCount - 1; i >= 0; i--) {
    const child = node.child(i);
    if (child && child.isNamed && BODY_TYPES.has(child.type)) {
      return child;
    }
  }
  return null;
}

function getNonCommentNamedChildren(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.isNamed && !COMMENT_TYPES.has(child.type)) {
      out.push(child);
    }
  }
  return out;
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
    const node = frame.node;

    if (frame.index === 0 && node.isNamed) {
      visitor(node);
    }

    if (frame.index < node.childCount) {
      const child = node.child(frame.index);
      frame.index++;
      if (child) {
        stack.push({ node: child, index: 0 });
      }
    } else {
      stack.pop();
    }
  }
}
