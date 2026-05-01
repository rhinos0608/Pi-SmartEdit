/**
 * Semantic Context Retrieval — Core orchestration for LSP-RAG.
 *
 * Extracts key tokens from a target range and resolves their dependencies
 * using Language Server Protocol (LSP) or Tree-sitter AST fallbacks.
 */

import { resolve } from "path";
import { 
  goToDefinitions, 
  goToTypeDefinition, 
  goToImplementation, 
  findReferences, 
  getHoverInfo, 
  getSemanticTokensForRange,
  getDocumentSymbols,
  ResolvedLocation,
  Location,
  LSPRange,
  SemanticToken,
  DocumentSymbol
} from "./semantic-nav";
import { withOpenDocument } from "./document-sync";
import { resolveTargetRange, ResolvedTarget } from "./target-range";
import { ContextItem, renderSemanticContext, estimateTokens } from "./context-renderer";
import { findEnclosingDocumentSymbol, extractSymbolExcerpt } from "./symbol-skeleton";
import { detectLanguageFromExtension } from "./language-id";

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
  lspManager: any; // LSPManager instance
  astResolver: any; // Result of createAstResolver()
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

  // 2. Read File Content
  const content = await deps.readFile(input.path);

  // 3. Resolve Target and Fetch Symbols
  let documentSymbols: DocumentSymbol[] = [];
  let target: ResolvedTarget;

  const server = deps.lspManager ? await deps.lspManager.getServer(languageId) : null;

  if (server) {
    const uri = `file://${resolve(input.path)}`;
    target = await withOpenDocument(server, {
      uri,
      languageId,
      content,
    }, async () => {
      documentSymbols = await getDocumentSymbols(input.path, languageId, deps.lspManager);
      
      return await resolveTargetRange({
        path: input.path,
        content,
        lineRange: input.lineRange,
        symbol: input.symbol,
        hashline: input.hashline,
        snapshot: deps.getSnapshot(input.path, deps.cwd),
        astResolver: deps.astResolver,
        documentSymbols,
      });
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

  // 4. Extract Key Tokens
  let keyTokens: { name: string; line: number; character: number; score: number }[] = [];
  let source: "lsp" | "ast" | "none" = "none";

  if (server && server.serverCapabilities?.capabilities?.semanticTokensProvider) {
    source = "lsp";
    const lspRange = {
      start: { line: target.lineRange.startLine - 1, character: 0 },
      end: { line: target.lineRange.endLine - 1, character: 9999 }
    };
    // Use withOpenDocument for semantic tokens too? 
    // Usually it's already open from the block above but withOpenDocument handles nesting/locks.
    const tokens = await withOpenDocument(server, { uri: `file://${resolve(input.path)}`, languageId, content }, async () => {
       return await getSemanticTokensForRange(input.path, lspRange, languageId, deps.lspManager);
    });
    
    keyTokens = tokens
      .map(t => {
        // Populate text from content
        const line = content.split("\n")[t.line];
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
  } else if (deps.astResolver) {
    source = "ast";
    // AST Fallback
    keyTokens = await extractTokensViaAst(content, target.byteRange, deps.astResolver);
  }

  // Dedupe and sort key tokens
  keyTokens = Array.from(new Map(keyTokens.map(t => [`${t.name}:${t.line}:${t.character}`, t])).values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  // 6. Expand Semantic Graph
  const items: ContextItem[] = [];
  const processedLocations = new Set<string>();

  const definitionTasks = keyTokens.map(async (token) => {
    // Standard Definition
    const defs = await goToDefinitions(input.path, token.line, token.character, languageId, deps.lspManager);
    for (const def of defs.slice(0, 3)) {
      await processLocation(def, "definition", token.name, token.score);
    }

    // Type Definition
    if (input.includeTypeDefinitions !== false) {
      const typeDefs = await goToTypeDefinition(input.path, token.line, token.character, languageId, deps.lspManager);
      for (const tdef of typeDefs.slice(0, 2)) {
        await processLocation(tdef, "typeDefinition", token.name, token.score - 5);
      }
    }

    // Implementation
    if (input.includeImplementations) {
      const impls = await goToImplementation(input.path, token.line, token.character, languageId, deps.lspManager);
      for (const impl of impls.slice(0, 2)) {
        await processLocation(impl, "implementation", token.name, token.score - 10);
      }
    }

    // Hover
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

    // References
    if (input.includeReferences) {
      const refs = await findReferences(input.path, token.line, token.character, languageId, deps.lspManager);
      for (const ref of refs.slice(0, 2)) {
        await processLocation({ location: ref }, "reference", token.name, token.score - 20);
      }
    }
  });

  await Promise.all(definitionTasks);

  async function processLocation(resolved: ResolvedLocation, relationship: ContextItem["relationship"], symbolName: string, score: number) {
    const loc = resolved.location;
    const locKey = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`;
    if (processedLocations.has(locKey)) return;
    
    // Ignore definitions inside the target range (unless it's a reference)
    if (relationship !== "reference" && loc.uri.endsWith(input.path)) {
      if (loc.range.start.line + 1 >= target.lineRange.startLine && loc.range.end.line + 1 <= target.lineRange.endLine) {
        return;
      }
    }

    processedLocations.add(locKey);

    try {
      const isExternal = !loc.uri.startsWith("file://") || !loc.uri.includes(deps.cwd);
      let itemText = "";
      let itemTruncated = false;
      let excerptKind: ContextItem["excerptKind"] = "signature";

      if (isExternal) {
        const hover = await getHoverInfo(input.path, loc.range.start.line, loc.range.start.character, languageId, deps.lspManager);
        itemText = hover || "(external definition)";
        excerptKind = "hover";
      } else {
        const filePath = loc.uri.replace("file://", "");
        const fileContent = await deps.readFile(filePath);
        
        // Fetch symbols for dependency file to provide better context
        const depSymbols = await getDocumentSymbols(filePath, languageId, deps.lspManager);
        const enclosingSymbol = findEnclosingDocumentSymbol(depSymbols, loc);
        
        const excerpt = extractSymbolExcerpt(fileContent, enclosingSymbol, loc, {
          maxLines: 20,
          preferSkeleton: relationship === "reference" ? false : true
        });
        
        itemText = excerpt.text;
        itemTruncated = excerpt.truncated;
        excerptKind = excerpt.excerptKind;
        
        // Record read for dependency
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

  return {
    markdown: rendered.markdown,
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

async function extractTokensViaAst(content: string, byteRange: { startIndex: number; endIndex: number }, _astResolver: any): Promise<{ name: string; line: number; character: number; score: number }[]> {
  const result: { name: string; line: number; character: number; score: number }[] = [];
  
  // Regex fallback: find whole-word identifiers
  const text = content.slice(byteRange.startIndex, byteRange.endIndex);
  const regex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;
  let match;
  
  const keywords = new Set(["async", "await", "function", "const", "let", "var", "return", "class", "interface", "export", "import", "from", "extends", "implements", "public", "private", "protected", "static", "readonly", "type", "of", "in", "as"]);

  while ((match = regex.exec(text)) !== null) {
    const name = match[0];
    if (name.length < 3) continue;
    if (keywords.has(name)) continue;
    
    // Estimate line/char
    const offset = byteRange.startIndex + match.index;
    const prefix = content.slice(0, offset);
    const lines = prefix.split("\n");
    
    result.push({
      name,
      line: lines.length - 1,
      character: lines[lines.length - 1].length,
      score: 30
    });
  }

  return result;
}
