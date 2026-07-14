/**
 * Document Synchronization — Lifecycle management for LSP documents.
 *
 * Provides `withOpenDocument` to ensure a document is open in the LSP server
 * during an operation and closed afterward (if appropriate).
 * 
 * Includes serialization per URI to prevent race conditions between 
 * diagnostics, semantic retrieval, and other concurrent LSP operations.
 */

interface OpenDocumentConnection {
  notify(method: string, params?: unknown): Promise<void>;
  request?(method: string, params?: unknown): Promise<unknown>;
}

interface ConnectionState {
  locks: Map<string, Promise<void>>;
  versions: Map<string, number>;
  openDocuments: Set<string>;
}

// Per-server state to prevent cross-connection leaks (e.g. tsserver vs pyright).
// WeakMap so connections can be GC'd; .delete(server) is also safe.
const states = new WeakMap<OpenDocumentConnection, ConnectionState>();

function stateFor(server: OpenDocumentConnection): ConnectionState {
  let s = states.get(server);
  if (!s) {
    s = { locks: new Map(), versions: new Map(), openDocuments: new Set() };
    states.set(server, s);
  }
  return s;
}

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
  server: OpenDocumentConnection,
  input: {
    uri: string;
    languageId: string;
    content: string;
    version?: number;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const { uri, languageId, content } = input;
  const state = stateFor(server);

  // 1. Serialization per URI
  const prevLock = state.locks.get(uri) || Promise.resolve();
  let resolveLock: () => void = () => {};
  const nextLock = new Promise<void>((resolve) => {
    resolveLock = resolve;
  });
  state.locks.set(uri, nextLock);

  try {
    await prevLock;

    // 2. Incremental versioning
    const version = (state.versions.get(uri) || 0) + 1;
    state.versions.set(uri, version);

    // 3. Open if needed
    const needsOpen = !state.openDocuments.has(uri);
    if (needsOpen) {
      await server.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version: input.version ?? version,
          text: content,
        },
      });
      state.openDocuments.add(uri);
      await server.request?.("workspace/symbol", { query: "__smart_edit_sync_after_didopen__" }).catch(() => undefined);
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
        state.openDocuments.delete(uri);
      }
    }
  } finally {
    // Release lock
    resolveLock();
    if (state.locks.get(uri) === nextLock) {
      state.locks.delete(uri);
    }
  }
}
