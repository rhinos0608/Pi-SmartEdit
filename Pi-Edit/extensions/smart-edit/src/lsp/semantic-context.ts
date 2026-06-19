/**
 * Semantic Context Retrieval — Core orchestration for LSP-RAG.
 *
 * Extracts key tokens from a target range and resolves their dependencies
 * using Language Server Protocol (LSP) or Tree-sitter AST fallbacks.
 */

import { realpath } from "fs/promises";
import { fileURLToPath } from "url";
import { isAbsolute, relative, resolve } from "path";
import type {
  DocumentSymbol,
  ResolvedLocation,
  SemanticToken,
} from "./semantic-nav";
import {
  goToDefinitions,
  goToTypeDefinition,
  goToImplementation,
  findReferences,
  getHoverInfo,
  getSemanticTokensForRange,
  getDocumentSymbols,
} from "./semantic-nav";
import { withOpenDocument } from "./document-sync";
import type { ResolvedTarget } from "./target-range";
import { resolveTargetRange } from "./target-range";
import type { ContextItem } from "./context-renderer";
import { renderSemanticContext, estimateTokens } from "./context-renderer";
import { findEnclosingDocumentSymbol, extractSymbolExcerpt } from "./symbol-skeleton";
import { detectLanguageFromExtension } from "./language-id";
import type { LSPManager } from "./lsp-manager";
import { wrapInContextMarker } from "../formats/context-markers";

export interface AstResolverLike {
  findSymbolNode(name: string, kind?: string, line?: number): { startIndex: number; endIndex: number } | null;
}

export interface SemanticContextInput {
  path: string;
  lineRange?: { startLine: number; endLine?: number };
  symbol?: { name: string; kind?: string; line?: number };
  hashline?: { pos: string; end?: string };
  maxTokens?: number;
  maxDepth?: number;
  includeReferences?: false | "examples" | "all";
  includeImplementations?: boolean;
  includeTypeDefinitions?: boolean;
  includeHover?: boolean;
}

export interface SemanticContextDeps {
  cwd: string;
  readFile(path: string): Promise<string>;
  getSnapshot(path: string, cwd: string): { partial?: boolean; contentHash?: string; hashline?: { anchors: Map<string, { text: string; line: number }> } } | null;
  recordRead(path: string, cwd: string, content: string, partial?: boolean): void;
  recordReadSession?(path: string, cwd: string, lineRanges: Array<{ startLine: number; endLine: number }>): void;
  lspManager?: Pick<LSPManager, "getServer"> | null;
  astResolver?: AstResolverLike | null;
}

export interface SemanticContextDetails {
  source: "lsp" | "ast" | "none";
  languageId: string | null;
  targetRange?: { startLine: number; endLine: number };
  tokenCount: number;
  resolvedDefinitions: number;
  resolvedTypeDefinitions: number;
  resolvedImplementations: number;
  resolvedReferences: number;
  elapsedMs: number;
  warnings: string[];
}

export async function buildSemanticContext(
  input: SemanticContextInput,
  deps: SemanticContextDeps,
): Promise<{ markdown: string; items: ContextItem[]; details: SemanticContextDetails }> {
  const startTime = Date.now();
  const warnings: string[] = [];
  const maxTokens = input.maxTokens ?? 3000;
  const maxDepth = input.maxDepth ?? 1;

  // 1. Determine Language ID
  const languageId = detectLanguageFromExtension(input.path) || "typescript";

  // 2. Read File Content + per-build caches
  const inputAbsPath = resolve(input.path);
  const content = await deps.readFile(input.path);
  const contentLines = content.split("\n");
  const fileContentCache = new Map<string, string>([[inputAbsPath, content]]);
  const symbolCache = new Map<string, DocumentSymbol[]>();
  let preExtractedTokens: { name: string; line: number; character: number; score: number }[] = [];

  // 3. Resolve Target and Fetch Symbols
  let documentSymbols: DocumentSymbol[] = [];
  let target!: ResolvedTarget;

  const server = deps.lspManager ? await deps.lspManager.getServer(languageId) : null;

  // Consolidate all LSP work (symbols, target, tokens, expansion) into a single
  // withOpenDocument call to avoid double-open/double-close for the same content.
  const items: ContextItem[] = [];
  const processedLocations = new Set<string>();
  let source: "lsp" | "ast" | "none" = "none";

  if (server) {
    const uri = `file://${resolve(input.path)}`;
    await withOpenDocument(server, {
      uri,
      languageId,
      content,
    }, async () => {
      documentSymbols = await getDocumentSymbols(input.path, languageId, deps.lspManager);

      const resolved = await resolveTargetRange({
        path: input.path,
        content,
        lineRange: input.lineRange,
        symbol: input.symbol,
        hashline: input.hashline,
        snapshot: deps.getSnapshot(input.path, deps.cwd),
        astResolver: deps.astResolver,
        documentSymbols,
      });

      // Fetch semantic tokens while the document is still open in the server
      // (some servers only return accurate tokens for currently-open docs).
      const serverCaps = server.serverCapabilities as {
        capabilities?: { semanticTokensProvider?: unknown };
        semanticTokensProvider?: unknown;
      } | undefined;
      const provider = serverCaps?.capabilities?.semanticTokensProvider ?? serverCaps?.semanticTokensProvider;
      if (provider) {
        const lspRange = {
          start: { line: resolved.lineRange.startLine - 1, character: 0 },
          end: { line: resolved.lineRange.endLine - 1, character: 9999 }
        };
        const tokens = await getSemanticTokensForRange(input.path, lspRange, languageId, deps.lspManager);
        preExtractedTokens = tokens
          .map(t => {
            const line = contentLines[t.line];
            const text = line?.slice(t.character, t.character + t.length) || "";
            return { ...t, text };
          })
          .map(t => ({
            name: t.text,
            line: t.line,
            character: t.character,
            score: scoreToken(t)
          }))
          .filter(t => t.score > 0);
      }

      // 4. Extract Key Tokens (inside same open-document context)
      let keyTokens: { name: string; line: number; character: number; score: number }[] = [];

      if (preExtractedTokens.length > 0) {
        source = "lsp";
        keyTokens = preExtractedTokens;
      } else if (deps.astResolver) {
        source = "ast";
        keyTokens = extractTokensViaAst(content, resolved.byteRange);
      }

      // Dedupe and sort key tokens
      keyTokens = Array.from(new Map(keyTokens.map(t => [`${t.name}:${t.line}:${t.character}`, t])).values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);

      // 5. Expand Semantic Graph (inside same withOpenDocument)
      // Compute realCwd once for all getWorkspacePath calls in processLocation
      const realCwd = await realpath(deps.cwd);

      const SEMAPHORE_LIMIT = 5;
      for (let i = 0; i < keyTokens.length; i += SEMAPHORE_LIMIT) {
        const batch = keyTokens.slice(i, i + SEMAPHORE_LIMIT);
        await Promise.all(batch.map(async (token) => {
          const defs = await goToDefinitions(input.path, token.line, token.character, languageId, deps.lspManager);
          for (const def of defs.slice(0, 3)) {
            await processLocation(def, "definition", token.name, token.score, realCwd);
          }

          if (input.includeTypeDefinitions !== false) {
            const typeDefs = await goToTypeDefinition(input.path, token.line, token.character, languageId, deps.lspManager);
            for (const tdef of typeDefs.slice(0, 2)) {
              await processLocation(tdef, "typeDefinition", token.name, token.score - 5, realCwd);
            }
          }

          if (input.includeImplementations) {
            const impls = await goToImplementation(input.path, token.line, token.character, languageId, deps.lspManager);
            for (const impl of impls.slice(0, 2)) {
              await processLocation(impl, "implementation", token.name, token.score - 10, realCwd);
            }
          }

          if (input.includeHover) {
            const hover = await getHoverInfo(input.path, token.line, token.character, languageId, deps.lspManager);
            if (hover) {
              items.push({
                symbolName: token.name,
                relationship: "hover",
                uri: input.path,
                range: { start: { line: token.line, character: token.character }, end: { line: token.line, character: token.character + token.name.length } },
                score: token.score,
                excerptKind: "hover",
                text: hover,
                truncated: false,
              });
            }
          }

          if (input.includeReferences) {
            const refs = await findReferences(input.path, token.line, token.character, languageId, deps.lspManager);
            const limit = input.includeReferences === "all" ? 50 : 2;
            for (const ref of refs.slice(0, limit)) {
              await processLocation({ location: ref }, "reference", token.name, token.score - 20, realCwd);
            }
          }
        }));
      }

      target = resolved;
    });
  } else {
    target = await resolveTargetRange({
      path: input.path,
      content,
      lineRange: input.lineRange,
      symbol: input.symbol,
      hashline: input.hashline,
      snapshot: deps.getSnapshot(input.path, deps.cwd),
      astResolver: deps.astResolver,
      documentSymbols,
    });
  }

  async function processLocation(resolved: ResolvedLocation, relationship: ContextItem["relationship"], symbolName: string, score: number, realCwdFromCaller?: string) {
    const loc = resolved.location;
    const locKey = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`;
    if (processedLocations.has(locKey)) return;

    const locFilePath = filePathFromUri(loc.uri);
    if (relationship !== "reference" && locFilePath && resolve(locFilePath) === inputAbsPath) {
      if (loc.range.start.line + 1 >= target.lineRange.startLine && loc.range.end.line + 1 <= target.lineRange.endLine) {
        return;
      }
    }

    processedLocations.add(locKey);

    try {
      const workspacePath = locFilePath ? await getWorkspacePath(locFilePath, deps.cwd, realCwdFromCaller) : null;
      const isExternal = !workspacePath;
      let itemText = "";
      let itemTruncated = false;
      let excerptKind: ContextItem["excerptKind"] = "signature";

      if (isExternal) {
        const hover = await getHoverInfo(input.path, loc.range.start.line, loc.range.start.character, languageId, deps.lspManager);
        itemText = hover || "(external definition)";
        excerptKind = "hover";
      } else {
        const filePath = workspacePath;
        const cacheKey = resolve(filePath);
        let fileContent = fileContentCache.get(cacheKey);
        if (fileContent === undefined) {
          fileContent = await deps.readFile(filePath);
          fileContentCache.set(cacheKey, fileContent);
        }

        let depSymbols = symbolCache.get(cacheKey);
        if (!depSymbols) {
          depSymbols = await getDocumentSymbols(filePath, languageId, deps.lspManager);
          symbolCache.set(cacheKey, depSymbols);
        }
        const enclosingSymbol = findEnclosingDocumentSymbol(depSymbols, loc);

        const excerpt = extractSymbolExcerpt(fileContent, enclosingSymbol, loc, {
          maxLines: 20,
          preferSkeleton: relationship === "reference" ? false : true
        });

        itemText = excerpt.text;
        itemTruncated = excerpt.truncated;
        excerptKind = excerpt.excerptKind;

        if (deps.recordReadSession) {
          deps.recordReadSession(filePath, deps.cwd, [{
            startLine: enclosingSymbol?.range.start.line ? enclosingSymbol.range.start.line + 1 : loc.range.start.line + 1,
            endLine: enclosingSymbol?.range.end.line ? enclosingSymbol.range.end.line + 1 : loc.range.end.line + 1
          }]);
        }
      }

      items.push({
        symbolName,
        relationship,
        uri: loc.uri,
        range: loc.range,
        score,
        excerptKind,
        text: itemText,
        truncated: itemTruncated,
      });
    } catch (err) {
      warnings.push(`Failed to process location in ${loc.uri}: ${(err as Error).message}`);
    }
  }

  // 7. Render Markdown
  const rendered = renderSemanticContext(
    { path: input.path, range: target.lineRange, source: target.source },
    items,
    { maxTokens, cwd: deps.cwd }
  );

  const stats = items.reduce((acc, item) => {
    if (item.relationship === "definition") acc.resolvedDefinitions++;
    else if (item.relationship === "typeDefinition") acc.resolvedTypeDefinitions++;
    else if (item.relationship === "implementation") acc.resolvedImplementations++;
    else if (item.relationship === "reference") acc.resolvedReferences++;
    return acc;
  }, { resolvedDefinitions: 0, resolvedTypeDefinitions: 0, resolvedImplementations: 0, resolvedReferences: 0 });

  const markeddown = wrapInContextMarker(rendered.markdown, {
    type: "semantic_context",
    path: input.path,
    range: target.lineRange
      ? `${target.lineRange.startLine}-${target.lineRange.endLine}`
      : undefined,
    source,
    tokens: rendered.details.tokenCount,
    language: languageId ?? undefined,
  });

  return {
    markdown: markeddown,
    items,
    details: {
      source,
      languageId,
      targetRange: target.lineRange,
      tokenCount: rendered.details.tokenCount,
      ...stats,
      elapsedMs: Date.now() - startTime,
      warnings: [...warnings, ...rendered.details.warnings],
    }
  };
}

function scoreToken(t: SemanticToken): number {
  if (t.tokenType === "type" || t.tokenType === "class" || t.tokenType === "interface") return 50;
  if (t.tokenType === "parameter") return 45;
  if (t.tokenType === "function" || t.tokenType === "method") return 35;
  if (t.tokenType === "variable" && t.tokenModifiers.includes("readonly")) return 20;
  return 10;
}

function extractTokensViaAst(content: string, byteRange: { startIndex: number; endIndex: number }): { name: string; line: number; character: number; score: number }[] {
  const result: { name: string; line: number; character: number; score: number }[] = [];

  // Regex fallback: find whole-word identifiers in the byte range.
  // (Full AST extraction deferred — see AstResolverLike comment in semantic-nav.)
  const text = content.slice(byteRange.startIndex, byteRange.endIndex);
  const regex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
  let match;

  const keywords = new Set(["async", "await", "function", "const", "let", "var", "return", "class", "interface", "export", "import", "from", "extends", "implements", "public", "private", "protected", "static", "readonly", "type", "of", "in", "as"]);

  // Precompute absolute line-start offsets for the entire content once.
  // Then for each match we do a single O(log n) binary search to map
  // offset -> (line, column). Total work: O(n + k log n) instead of O(n*k).
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }

  while ((match = regex.exec(text)) !== null) {
    const name = match[0];
    if (name.length < 3) continue;
    if (keywords.has(name)) continue;

    const offset = byteRange.startIndex + match.index;
    // Binary search: find greatest lineStart <= offset.
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    result.push({
      name,
      line: lo,
      character: offset - lineStarts[lo],
      score: 30
    });
  }

  return result;
}

function filePathFromUri(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

async function getWorkspacePath(filePath: string, cwd: string, preComputedRealCwd?: string): Promise<string | null> {
  try {
    const [realCwd, realFile] = await Promise.all([
      preComputedRealCwd ? Promise.resolve(preComputedRealCwd) : realpath(cwd),
      realpath(filePath)
    ]);
    const rel = relative(realCwd, realFile);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return realFile;
  } catch {
    return null;
  }
}
