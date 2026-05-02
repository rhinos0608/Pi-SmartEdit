/**
 * Grammar Loader — lazy-loads language grammars for tree-sitter.
 *
 * Each grammar is loaded on first use as a WASM file via fs.readFile().
 * Loaded grammars are cached in memory for the lifetime of the process.
 *
 * Architecture:
 * - WASM files come from @vscode/tree-sitter-wasm (pre-built, comprehensive)
 * - Core tree-sitter runtime comes from web-tree-sitter
 * - If a grammar isn't installed, graceful fallback with a warning
 * - Zero native dependencies — all via web-tree-sitter WASM
 * - Now queries package.json for available grammars instead of hardcoding
 */

import { createRequire } from "module";
import { readFile } from "fs/promises";
import type Parser from "web-tree-sitter";

const _require = createRequire(import.meta.url);

const VSCODE_WASM_PACKAGE = "@vscode/tree-sitter-wasm";
const WASM_DIR = "wasm";

/**
 * Map file extensions to WASM filenames within @vscode/tree-sitter-wasm.
 * These are the canonical names used by the upstream package.
 * If a grammar isn't available, we fall back gracefully.
 */
const EXT_TO_WASM: Record<string, string | null> = {
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".py": "tree-sitter-python.wasm",
  ".rs": "tree-sitter-rust.wasm",
  ".go": "tree-sitter-go.wasm",
  ".java": "tree-sitter-java.wasm",
  ".c": "tree-sitter-cpp.wasm",       // C falls back to CPP parser
  ".cpp": "tree-sitter-cpp.wasm",
  ".h": "tree-sitter-cpp.wasm",       // C header → CPP parser
  ".hpp": "tree-sitter-cpp.wasm",
  ".rb": "tree-sitter-ruby.wasm",
  ".css": "tree-sitter-css.wasm",
  // The following extensions gracefully degrade if grammar not available
  ".json": null,  // not in @vscode/tree-sitter-wasm
  ".yaml": null,  // not in @vscode/tree-sitter-wasm
  ".yml": null,   // not in @vscode/tree-sitter-wasm
  ".html": null,  // not in @vscode/tree-sitter-wasm
};

/**
 * Cached package.json data from @vscode/tree-sitter-wasm.
 * Populated lazily on first load attempt.
 */
interface PackageJson {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

let discoveredGrammars: Map<string, string> | null = null;
const packageJsonCache: PackageJson | null = null;

let ParserModule: typeof Parser | null = null;
let parserInitPromise: Promise<typeof Parser> | null = null;
const grammarCache = new Map<string, Parser.Language>();
const loadWarnings = new Set<string>();

/**
 * Initialize the web-tree-sitter WASM module.
 * Called once, lazily, on first parse.
 */
async function initParser(): Promise<typeof Parser> {
  if (ParserModule) return ParserModule;
  if (parserInitPromise) return parserInitPromise;

  parserInitPromise = (async () => {
    try {
      ParserModule = (await import("web-tree-sitter")).default;
      await ParserModule.init();
      if (!ParserModule) throw new Error("Failed to initialize tree-sitter parser");
      return ParserModule;
    } catch (err) {
      ParserModule = null;
      parserInitPromise = null;
      throw err;
    }
  })();

  return parserInitPromise;
}

/**
 * Resolve the WASM file path for a grammar from @vscode/tree-sitter-wasm.
 * Falls back gracefully if the grammar isn't available in the installed package.
 */
function resolveWasmPath(wasmFile: string): string | null {
  try {
    return _require.resolve(`${VSCODE_WASM_PACKAGE}/${WASM_DIR}/${wasmFile}`);
  } catch {
    // Grammar not found — will fall back gracefully
    return null;
  }
}

/**
 * Discover available grammars from the @vscode/tree-sitter-wasm package.
 * Reads package.json to find which grammars are actually installed.
 * Caches the result for subsequent calls.
 */
async function discoverAvailableGrammars(): Promise<Map<string, string>> {
  if (discoveredGrammars) {
    return discoveredGrammars;
  }

  discoveredGrammars = new Map();

  try {
    // Read package.json from the installed package
    const packageJsonPath = _require.resolve(
      `${VSCODE_WASM_PACKAGE}/package.json`
    );
    const content = await readFile(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content) as PackageJson;

    // The package lists grammars in dependencies (e.g., "tree-sitter-typescript": "*")
    // We infer WASM files from the grammar name (tree-sitter-typescript -> tree-sitter-typescript.wasm)
    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    };

    for (const [name, version] of Object.entries(allDeps)) {
      if (name.startsWith("tree-sitter-")) {
        // tree-sitter-typescript -> tree-sitter-typescript.wasm
        const wasmFile = `${name}.wasm`;
        discoveredGrammars.set(wasmFile, version); // Note: version stored for debugging
      }
    }
  } catch {
    // Package not installed — will rely on hardcoded fallback
  }

  return discoveredGrammars;
}

/**
 * Resolve a WASM file for an extension, checking if it's actually
 * available in the installed package.
 */
async function resolveGrammarFile(ext: string): Promise<string | null> {
  const fallbackName = EXT_TO_WASM[ext.toLowerCase()];
  if (!fallbackName) return null;

  // Get available grammars from package.json
  const available = await discoverAvailableGrammars();

  // Check if the grammar is installed
  if (available.has(fallbackName)) {
    return fallbackName;
  }

  // Not installed — try to find alternatives or return null
  return null;
}

/**
 * Load a grammar for the given file extension.
 *
 * Returns the Language object, or null if:
 * - The file extension is not supported
 * - The grammar package is not installed
 * - WASM initialization fails
 *
 * @param ext - File extension including dot (e.g., ".ts")
 * @returns Language | null
 */
export async function loadGrammar(
  ext: string,
): Promise<Parser.Language | null> {
  const wasmFile = EXT_TO_WASM[ext.toLowerCase()];
  if (!wasmFile) return null; // unsupported extension

  // Check cache (keyed by wasm filename, not ext — ts and tsx share the same wasm)
  if (grammarCache.has(wasmFile)) {
    const cached = grammarCache.get(wasmFile);
    if (!cached) return null;
    return cached;
  }

  try {
    const Parser = await initParser();

    const wasmPath = resolveWasmPath(wasmFile);
    if (!wasmPath) {
      // Grammar not available in installed package
      if (!loadWarnings.has(wasmFile)) {
        loadWarnings.add(wasmFile);
        console.warn(
          `[smart-edit] Grammar for ${ext} not installed in ${VSCODE_WASM_PACKAGE}`
        );
      }
      return null;
    }

    // Load WASM file via fs.readFile + Language.load
    const fs = await import("fs/promises");
    const wasmBuffer = await fs.readFile(wasmPath);

    const language = await Parser.Language.load(wasmBuffer);

    grammarCache.set(wasmFile, language);
    return language;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Only warn once per grammar
    if (!loadWarnings.has(wasmFile)) {
      loadWarnings.add(wasmFile);
      console.warn(`[smart-edit] Cannot load grammar for ${ext}: ${msg}`);
    }

    return null;
  }
}

/**
 * Check if a grammar is available for the given extension
 * without triggering a load. Returns true if cached.
 */
export function isGrammarCached(ext: string): boolean {
  const wasmFile = EXT_TO_WASM[ext.toLowerCase()];
  if (!wasmFile) return false;
  return grammarCache.has(wasmFile);
}

/**
 * Get all supported file extensions.
 */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXT_TO_WASM).filter(
    (ext) => EXT_TO_WASM[ext] !== null,
  );
}

/**
 * Clear all cached grammars. Frees WASM memory.
 * Useful for testing — resets state between tests.
 */
export function clearGrammarCache(): void {
  grammarCache.clear();
  loadWarnings.clear();
}

/**
 * Reset parser state (for testing).
 */
export function resetParser(): void {
  ParserModule = null;
  parserInitPromise = null;
}
