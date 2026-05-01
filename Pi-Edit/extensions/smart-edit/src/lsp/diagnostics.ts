/**
 * Post-edit diagnostic checking via LSP.
 *
 * After an edit is applied, opens the file in the LSP server and collects
 * any diagnostics (errors, warnings) that the server reports.
 *
 * Uses a two-phase approach:
 * 1. Wait for push-based `textDocument/publishDiagnostics` notification
 * 2. Fall back to pull-based `textDocument/diagnostic` request (LSP 3.17)
 *
 * This handles servers that don't immediately push diagnostics for newly
 * opened files, which is the common case for TypeScript language servers
 * processing standalone files.
 */

import { resolve } from "path";

import { LSPConnection } from "./lsp-connection";
import { LSPManager } from "./lsp-manager";

export interface Diagnostic {
  message: string;
  severity: 1 | 2 | 3 | 4; // 1=error, 2=warning, 3=info, 4=hint
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  source?: string;
}

export interface DiagnosticResult {
  diagnostics: Diagnostic[];
  source: "lsp" | "none";
}

/**
 * Wait for diagnostics notification from the LSP server, filtered to a
 * specific document URI. Times out after the given duration.
 *
 * Uses per-call listener registration (via onNotification's unsubscribe
 * return value) so concurrent calls to waitForDiagnostics on the same
 * LSP connection do not race — each call gets its own listener that
 * is removed after resolution.
 *
 * Resolves early as soon as at least one diagnostic notification for the
 * target URI arrives. Falls back to the full timeout for slow servers or
 * servers that batch diagnostics across multiple notifications.
 *
 * @param conn      LSP connection
 * @param uri       Document URI to filter diagnostics for
 * @param timeoutMs Max time to wait (ms)
 */
function waitForDiagnostics(
  conn: LSPConnection,
  uri: string,
  timeoutMs: number,
): Promise<Diagnostic[]> {
  return new Promise((resolve) => {
    const allDiagnostics: Diagnostic[] = [];
    let unsubscribe: (() => void) | undefined;
    let didResolve = false;

    function done(diagnostics: Diagnostic[]) {
      if (didResolve) return;
      didResolve = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(diagnostics);
    }

    const timer = setTimeout(() => {
      done(allDiagnostics);
    }, timeoutMs);

    // Don't let this timer keep Node alive if everything else is done
    timer.unref();

    // Register a per-call listener — the returned unsubscribe function
    // ensures this listener is removed when the promise settles, so
    // concurrent calls do not interfere.
    unsubscribe = conn.onNotification(
      "textDocument/publishDiagnostics",
      (params) => {
        const typedParams = params as { uri?: string; diagnostics?: Diagnostic[] };

        // Skip diagnostics for other files — the TypeScript LSP publishes
        // project-wide batched notifications, not just for the opened file.
        if (typedParams.uri !== uri) return;

        if (typedParams.diagnostics) {
          allDiagnostics.push(...typedParams.diagnostics);

          // Resolve early once we've seen at least one batch for our URI.
          // The diagnostics at this point are authoritative — the LSP
          // computed them in response to didOpen with the post-edit content.
          done(allDiagnostics);
        }
      },
    );
  });
}

/**
 * Check for LSP diagnostics after an edit.
 *
 * Opens the file in the LSP server (with updated content), waits for
 * diagnostics to be published, then closes the document.
 *
 * Uses a two-phase approach:
 * 1. Wait up to 3s for push-based `textDocument/publishDiagnostics` notification
 * 2. If none received, try pull-based `textDocument/diagnostic` request (LSP 3.17)
 *
 * Returns `source: 'none'` if no LSP server is available for the language.
 *
 * @param filePath     Absolute path to the file (used for file:// URI)
 * @param content      Current file content (after edit)
 * @param languageId   LSP language ID (e.g., "typescript")
 * @param lspManager   LSP manager instance
 */
export async function checkPostEditDiagnostics(
  filePath: string,
  content: string,
  languageId: string,
  lspManager: LSPManager,
): Promise<DiagnosticResult> {
  const server = await lspManager.getServer(languageId);
  if (!server) return { diagnostics: [], source: "none" };

  const uri = `file://${resolve(filePath)}`;

  try {
    // Open document with current (post-edit) content
    await server.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });

    // Phase 1: Wait for push-based diagnostics notification (up to 3s).
    // TypeScript language servers typically push diagnostics within 1-2s
    // for files that are part of a tsconfig.json project.
    let diagnostics = await waitForDiagnostics(server, uri, 3000);

    // Phase 2: If no diagnostics received via notification, try the
    // pull-based `textDocument/diagnostic` request (LSP 3.17).
    // This is needed for standalone files or servers that don't auto-push.
    if (diagnostics.length === 0) {
      try {
        const pullResult = await server.request("textDocument/diagnostic", {
          textDocument: { uri },
        }) as { items?: Diagnostic[]; kind?: string } | null;

        if (pullResult?.items) {
          diagnostics = pullResult.items;
        }
      } catch {
        // textDocument/diagnostic not supported (pre-LSP 3.17 servers)
        // or request failed — diagnostics remains empty, which is fine.
      }
    }

    // Close the document — keep server alive for future edits
    await server.notify("textDocument/didClose", {
      textDocument: { uri },
    });

    return { diagnostics, source: "lsp" };
  } catch (err) {
    // Diagnostics check failed — silently degrade
    return { diagnostics: [], source: "none" };
  }
}
