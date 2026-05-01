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
  range: LSPRange;
}

export interface LSPRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface LocationLink {
  originSelectionRange?: LSPRange;
  targetUri: string;
  targetRange: LSPRange;
  targetSelectionRange: LSPRange;
}

export interface ResolvedLocation {
  location: Location;
  originRange?: LSPRange;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: DocumentSymbol[];
}

export interface SemanticToken {
  line: number;
  character: number;
  length: number;
  tokenType?: string;
  tokenModifiers: string[];
  text: string;
}

/**
 * Normalizes various LSP location responses into a unified ResolvedLocation array.
 * Handles null, single Location, Location[], and LocationLink[].
 */
export function normalizeLocations(response: unknown): ResolvedLocation[] {
  if (!response) return [];

  if (Array.isArray(response)) {
    return response.map((item: any) => {
      if (item.targetUri && item.targetRange) {
        // LocationLink
        return {
          location: {
            uri: item.targetUri,
            range: item.targetRange,
          },
          originRange: item.originSelectionRange,
        };
      } else {
        // Location
        return {
          location: item as Location,
        };
      }
    });
  }

  // Single Location
  return [{
    location: response as Location,
  }];
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
  const definitions = await goToDefinitions(filePath, line, character, languageId, lspManager);
  return definitions.length > 0 ? definitions[0].location : null;
}

/**
 * Find all definitions of a symbol at the given position.
 * Returns normalized ResolvedLocation array.
 */
export async function goToDefinitions(
  filePath: string,
  line: number,
  character: number,
  languageId: string,
  lspManager: LSPManager,
): Promise<ResolvedLocation[]> {
  const server = await lspManager.getServer(languageId);
  if (!server) return [];

  try {
    const response = await server.request("textDocument/definition", {
      textDocument: { uri: `file://${resolve(filePath)}` },
      position: { line, character },
    });

    return normalizeLocations(response);
  } catch {
    return [];
  }
}

/**
 * Find the declaration of a symbol at the given position.
 */
export async function goToDeclaration(
  filePath: string,
  line: number,
  character: number,
  languageId: string,
  lspManager: LSPManager,
): Promise<ResolvedLocation[]> {
  const server = await lspManager.getServer(languageId);
  if (!server) return [];

  try {
    const response = await server.request("textDocument/declaration", {
      textDocument: { uri: `file://${resolve(filePath)}` },
      position: { line, character },
    });

    return normalizeLocations(response);
  } catch {
    return [];
  }
}

/**
 * Find the type definition of a symbol at the given position.
 */
export async function goToTypeDefinition(
  filePath: string,
  line: number,
  character: number,
  languageId: string,
  lspManager: LSPManager,
): Promise<ResolvedLocation[]> {
  const server = await lspManager.getServer(languageId);
  if (!server) return [];

  try {
    const response = await server.request("textDocument/typeDefinition", {
      textDocument: { uri: `file://${resolve(filePath)}` },
      position: { line, character },
    });

    return normalizeLocations(response);
  } catch {
    return [];
  }
}

/**
 * Find the implementation of a symbol at the given position.
 */
export async function goToImplementation(
  filePath: string,
  line: number,
  character: number,
  languageId: string,
  lspManager: LSPManager,
): Promise<ResolvedLocation[]> {
  const server = await lspManager.getServer(languageId);
  if (!server) return [];

  try {
    const response = await server.request("textDocument/implementation", {
      textDocument: { uri: `file://${resolve(filePath)}` },
      position: { line, character },
    });

    return normalizeLocations(response);
  } catch {
    return [];
  }
}

/**
 * Get document symbols for the given file.
 */
export async function getDocumentSymbols(
  filePath: string,
  languageId: string,
  lspManager: LSPManager,
): Promise<DocumentSymbol[]> {
  const server = await lspManager.getServer(languageId);
  if (!server) return [];

  try {
    const response = await server.request("textDocument/documentSymbol", {
      textDocument: { uri: `file://${resolve(filePath)}` },
    });

    if (!response || !Array.isArray(response)) return [];

    // Response can be DocumentSymbol[] or SymbolInformation[]
    // For now we assume the server supports hierarchical DocumentSymbol
    return response as DocumentSymbol[];
  } catch {
    return [];
  }
}

/**
 * Get semantic tokens for a given range in a file.
 */
export async function getSemanticTokensForRange(
  filePath: string,
  range: LSPRange,
  languageId: string,
  lspManager: LSPManager,
): Promise<SemanticToken[]> {
  const server = await lspManager.getServer(languageId);
  if (!server) return [];

  try {
    const response = await server.request("textDocument/semanticTokens/range", {
      textDocument: { uri: `file://${resolve(filePath)}` },
      range,
    });

    if (!response || !Array.isArray((response as any).data)) return [];

    const data = (response as any).data as number[];
    const legend = server.serverCapabilities?.capabilities?.semanticTokensProvider?.legend;
    if (!legend) return [];

    const tokenTypes = legend.tokenTypes as string[];
    const tokenModifiers = legend.tokenModifiers as string[];

    const result: SemanticToken[] = [];
    let currentLine = 0;
    let currentChar = 0;

    for (let i = 0; i < data.length; i += 5) {
      const deltaLine = data[i];
      const deltaChar = data[i + 1];
      const length = data[i + 2];
      const tokenTypeIdx = data[i + 3];
      const tokenModifiersBitmask = data[i + 4];

      currentLine += deltaLine;
      if (deltaLine === 0) {
        currentChar += deltaChar;
      } else {
        currentChar = deltaChar;
      }

      const modifiers: string[] = [];
      for (let j = 0; j < tokenModifiers.length; j++) {
        if ((tokenModifiersBitmask >> j) & 1) {
          modifiers.push(tokenModifiers[j]);
        }
      }

      result.push({
        line: currentLine,
        character: currentChar,
        length,
        tokenType: tokenTypes[tokenTypeIdx],
        tokenModifiers: modifiers,
        text: "", // To be populated by caller if needed
      });
    }

    return result;
  } catch {
    return [];
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