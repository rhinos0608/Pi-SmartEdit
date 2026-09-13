import type Parser from "web-tree-sitter";

/** Result of parsing a file with tree-sitter */
export interface ParseResult {
  /** The parser instance — caller must call parser.delete() when done */
  parser: Parser;

  /** The syntax tree — caller must call tree.delete() when done */
  tree: Parser.Tree;

  /** The language grammar used */
  language: string;

  /** Whether the tree has ERROR or MISSING nodes indicating syntax errors */
  hasErrors: boolean;

  /** The content that was parsed */
  content: string;

  /** Optional diagnostic describing why AST resolution may be unreliable. */
  diagnostic?: string;
}

// ─── Parse Cache (LRU, 10 entries) ─────────────────────────────────

interface CachedParse {
  result: ParseResult;
  contentHash: string;
}

const parseCache = new Map<string, CachedParse>();
const MAX_CACHE_SIZE = 10;

/**
 * Get a cached parse result if the content hash matches.
 * @param filePath - Path used as cache key
 * @param contentHash - SHA-256 hash of the content
 * @returns The cached ParseResult, or null if not found or hash mismatch
 */
export function getCachedParse(filePath: string, contentHash: string): ParseResult | null {
  const cached = parseCache.get(filePath);
  if (!cached) return null;
  if (cached.contentHash !== contentHash) return null;
  // Bump to end (LRU promotion)
  parseCache.delete(filePath);
  parseCache.set(filePath, cached);
  return cached.result;
}

/**
 * Store a parse result in the cache.
 * Evicts the oldest entry when the cache exceeds MAX_CACHE_SIZE.
 * @param filePath - Path used as cache key
 * @param contentHash - SHA-256 hash of the content
 * @param result - The parse result to cache
 */
export function setCachedParse(filePath: string, contentHash: string, result: ParseResult): void {
  // Evict oldest if at capacity
  if (parseCache.size >= MAX_CACHE_SIZE && !parseCache.has(filePath)) {
    const firstKey = parseCache.keys().next().value;
    if (firstKey !== undefined) {
      const evicted = parseCache.get(firstKey);
      if (evicted) {
        evicted.result.tree.delete();
        evicted.result.parser.delete();
      }
      parseCache.delete(firstKey);
    }
  }
  parseCache.set(filePath, { result, contentHash });
}

/**
 * Clear the entire parse cache.
 * Disposes all cached trees and parsers to free WASM memory.
 */
export function clearParseCache(): void {
  for (const cached of parseCache.values()) {
    cached.result.tree.delete();
    cached.result.parser.delete();
  }
  parseCache.clear();
}
