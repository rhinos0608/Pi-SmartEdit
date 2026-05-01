/**
 * Document Synchronization — Lifecycle management for LSP documents.
 *
 * Provides `withOpenDocument` to ensure a document is open in the LSP server
 * during an operation and closed afterward (if appropriate).
 * 
 * Includes serialization per URI to prevent race conditions between 
 * diagnostics, semantic retrieval, and other concurrent LSP operations.
 */

import { LSPConnection } from "./lsp-connection";

// In-memory locks per document URI to serialize operations
const locks = new Map<string, Promise<void>>();

// Monotonic versioning per URI as required by LSP didOpen/didChange
const versions = new Map<string, number>();

// Track which documents this helper has currently opened
const openDocuments = new Set<string>();

/**
 * Execute a function within the context of an open LSP document.
 * 
 * Logic:
 * 1. Wait for any previous operation on this URI to finish (serialization).
 * 2. Increment document version.
 * 3. Send textDocument/didOpen if not currently open.
 * 4. Execute the provided function.
 * 5. Send textDocument/didClose in finally (only if we opened it).
 */
export async function withOpenDocument<T>(
  server: LSPConnection,
  input: {
    uri: string;
    languageId: string;
    content: string;
    version?: number;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const { uri, languageId, content } = input;

  // 1. Serialization per URI
  const prevLock = locks.get(uri) || Promise.resolve();
  let resolveLock: () => void;
  const nextLock = new Promise<void>((resolve) => {
    resolveLock = resolve;
  });
  locks.set(uri, nextLock);

  try {
    await prevLock;

    // 2. Incremental versioning
    const version = (versions.get(uri) || 0) + 1;
    versions.set(uri, version);

    // 3. Open if needed
    const needsOpen = !openDocuments.has(uri);
    if (needsOpen) {
      await server.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version: input.version ?? version,
          text: content,
        },
      });
      openDocuments.add(uri);
    }

    // 4. Execute operation
    try {
      return await fn();
    } finally {
      // 5. Close if we opened it
      if (needsOpen) {
        try {
          await server.notify("textDocument/didClose", {
            textDocument: { uri },
          });
        } catch (err) {
          console.warn(`[smart-edit] Failed to close document "${uri}":`, err);
        }
        openDocuments.delete(uri);
      }
    }
  } finally {
    // Release lock
    resolveLock!();
    if (locks.get(uri) === nextLock) {
      locks.delete(uri);
    }
  }
}
