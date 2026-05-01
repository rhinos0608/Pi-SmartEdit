/**
 * Semantic navigation via LSP.
 *
 * Provides goToDefinition, findReferences, and getHoverInfo by delegating
 * to the appropriate LSP textDocument requests.
 */

import { resolve } from "path";

import { LSPManager } from "./lsp-manager";

export interface Location {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * Jump to the definition of a symbol at the given position.
 *
 * @returns The location of the definition, or null if not found / LSP unavailable
 */
export async function goToDefinition(
  filePath: string,
  line: number,      // 0-based line number
  character: number, // 0-based character offset
  languageId: string,
  lspManager: LSPManager,
): Promise<Location | null> {
  const server = await lspManager.getServer(languageId);
  if (!server) return null;

  try {
    const response = await server.request("textDocument/definition", {
      textDocument: { uri: `file://${resolve(filePath)}` },
      position: { line, character },
    });

    if (!response) return null;

    // Definition can return a single Location or an array
    if (Array.isArray(response)) {
      return (response as Location[])[0] ?? null;
    }

    return response as Location;
  } catch {
    return null;
  }
}

/**
 * Find all references to a symbol at the given position.
 *
 * @returns Array of reference locations, or empty array if not found / LSP unavailable
 */
export async function findReferences(
  filePath: string,
  line: number,
  character: number,
  languageId: string,
  lspManager: LSPManager,
): Promise<Location[]> {
  const server = await lspManager.getServer(languageId);
  if (!server) return [];

  try {
    const response = await server.request("textDocument/references", {
      textDocument: { uri: `file://${resolve(filePath)}` },
      position: { line, character },
      context: { includeDeclaration: true },
    });

    if (!response) return [];
    return response as Location[];
  } catch {
    return [];
  }
}

/**
 * Get hover information (type signature, docs) at the given position.
 *
 * @returns The hover content as a string, or null if not found / LSP unavailable
 */
export async function getHoverInfo(
  filePath: string,
  line: number,
  character: number,
  languageId: string,
  lspManager: LSPManager,
): Promise<string | null> {
  const server = await lspManager.getServer(languageId);
  if (!server) return null;

  try {
    const response = await server.request("textDocument/hover", {
      textDocument: { uri: `file://${resolve(filePath)}` },
      position: { line, character },
    });

    if (!response) return null;

    const hover = response as {
      contents?:
        | string
        | { value?: string }
        | Array<string | { language?: string; value?: string }>
        | null;
    };
    if (!hover.contents) return null;

    // Hover content can be:
    //   1. A plain string
    //   2. A MarkupContent object ({ value: string })
    //   3. A MarkedString[] array (commonly [{ language, value }] or plain strings)
    //   See LSP specification: textDocument/hover
    if (typeof hover.contents === 'string') {
      return hover.contents;
    }

    if (Array.isArray(hover.contents)) {
      // Pick the first element's value/text
      const first = hover.contents[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object' && 'value' in first) {
        return (first as { value?: string }).value ?? null;
      }
      return null;
    }

    // MarkupContent object
    if (typeof hover.contents === 'object' && hover.contents !== null) {
      return (hover.contents as { value?: string }).value ?? null;
    }

    return null;
  } catch {
    return null;
  }
}