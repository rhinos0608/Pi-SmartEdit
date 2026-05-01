/**
 * LSP Connection — Zero-dependency JSON-RPC over stdio.
 *
 * Implements the Language Server Protocol over Node.js child_process stdio.
 * Handles Content-Length header parsing, message serialization, and
 * request/response correlation with timeouts.
 */

import { spawn, ChildProcess, SpawnOptions } from "child_process";

export interface LSPRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface LSPResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface LSPNotification {
  method: string;
  params?: unknown;
}

type PendingCallback = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * A single LSP server connection via stdio.
 *
 * Usage:
 *   const conn = new LSPConnection("typescript-language-server", ["--stdio"]);
 *   await conn.initialize("file:///path/to/project");
 *   const result = await conn.request("textDocument/definition", { ... });
 *   await conn.shutdown();
 */
export class LSPConnection {
  private process: ChildProcess;
  private messageId = 0;
  private pending = new Map<number, PendingCallback>();
  private buffer = "";
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
  public serverCapabilities: any;

  /**
   * Create a new LSP connection by spawning a server process.
   * @param command  Absolute path or command name (resolved via PATH)
   * @param args     Arguments passed to the command
   */
  constructor(command: string, args: string[], options?: SpawnOptions) {
    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });

    // Handle stdout — parse Content-Length headers and dispatch JSON messages
    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });

    // Handle stderr separately (log but don't process as LSP messages)
    this.process.stderr?.on("data", (_chunk: Buffer) => {
      // LSP servers write diagnostics and logs to stderr
      // We only log at debug level to avoid noise
    });

    // Handle process exit
    this.process.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        // Server exited with error — reject all pending requests
        for (const [, cb] of this.pending) {
          cb.reject(
            new Error(`LSP server exited with code ${code} (signal: ${signal})`)
          );
        }
      } else if (code === 0) {
        // Server exited cleanly — resolve any remaining requests
        for (const [, cb] of this.pending) {
          cb.resolve(null);
        }
      }
      this.pending.clear();
    });

    this.process.on("error", (err) => {
      // Process spawn failed — reject all pending requests
      for (const [, cb] of this.pending) {
        cb.reject(err);
      }
      this.pending.clear();
    });

    // Allow Node event loop to exit even if this child is still running
    this.process.unref();
  }

  /**
   * Initialize the LSP session.
   * Sends initialize request, waits for response, then sends initialized notification.
   */
  async initialize(rootUri: string): Promise<unknown> {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          diagnostic: { dynamicRegistration: true },
          declaration: { dynamicRegistration: true, linkSupport: true },
          definition: { dynamicRegistration: true, linkSupport: true },
          typeDefinition: { dynamicRegistration: true, linkSupport: true },
          implementation: { dynamicRegistration: true, linkSupport: true },
          references: { dynamicRegistration: true },
          hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
          documentSymbol: {
            dynamicRegistration: true,
            hierarchicalDocumentSymbolSupport: true,
          },
          semanticTokens: {
            dynamicRegistration: true,
            requests: { range: true, full: true },
            tokenTypes: [
              "class", "enum", "interface", "namespace", "typeParameter", "type", "parameter", "variable", "property", "function", "method"
            ],
            tokenModifiers: [
              "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"
            ],
            formats: ["relative"],
          },
        },
      },
    });

    this.serverCapabilities = result;
    await this.notify("initialized", {});
    return result;
  }

  /**
   * Send an LSP request and wait for a response.
   * @param method  LSP method name (e.g., "textDocument/definition")
   * @param params  Request parameters
   * @returns The response result
   * @throws If the request times out (5s) or the server returns an error
   */
  async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(new Error(`LSP request "${method}" was aborted`));
    }

    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" was aborted`));
      };

      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      const timer = setTimeout(() => {
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        this.pending.delete(id);
        reject(
          new Error(`LSP request "${method}" timed out after 5s`)
        );
      }, 5000);

      this.pending.set(id, {
        resolve: (v) => {
          if (signal) signal.removeEventListener("abort", abortHandler);
          resolve(v);
        },
        reject: (e) => {
          if (signal) signal.removeEventListener("abort", abortHandler);
          reject(e);
        },
        timer
      });
      this.write({ jsonrpc: "2.0", id, method, params });

      // Don't let this timer prevent Node from exiting
      timer.unref();
    });
  }

  /**
   * Send a one-way LSP notification (no response expected).
   * @param method  LSP method name (e.g., "textDocument/didOpen")
   * @param params  Notification parameters
   */
  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /**
   * Register a handler for LSP notifications (e.g., textDocument/publishDiagnostics).
   * Supports multiple independent listeners per method (EventEmitter-style).
   * Returns an unsubscribe function to remove the listener.
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);

    // Return an unsubscribe function
    return () => {
      const current = this.notificationHandlers.get(method);
      if (current) {
        const idx = current.indexOf(handler);
        if (idx !== -1) current.splice(idx, 1);
        if (current.length === 0) {
          this.notificationHandlers.delete(method);
        }
      }
    };
  }

  /**
   * Gracefully shut down the LSP server.
   *
   * Per LSP spec: after the shutdown response, send an `exit` notification
   * before closing stdin. This lets the server flush pending diagnostics,
   * indexing state, and other in-flight work before termination.
   */
  async shutdown(): Promise<void> {
    try {
      await this.request("shutdown");
    } catch {
      // Server may not support shutdown — that's ok
    }

    // LSP spec: exit notification after shutdown response.
    // Guard against EPIPE if the server already closed stdin.
    this.process.stdin?.once("error", () => {});
    await this.notify("exit", undefined);
    await new Promise((r) => setTimeout(r, 50)); // brief drain window

    this.process.stdin?.end();
    this.process.kill();
    this.pending.clear();
    this.notificationHandlers.clear();
  }

  private write(msg: object): void {
    const content = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n`;
    this.process.stdin!.write(header + content);
  }

  /**
   * Parse Content-Length headers and dispatch JSON messages from stdout.
   * Handles concatenated messages in a single chunk.
   */
  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();

    while (this.buffer.length > 0) {
      // Check for Content-Length header
      // NOTE: Don't anchor to start of buffer — some LSP servers send
      // other headers (e.g., Content-Type) before Content-Length.
      const headerMatch = this.buffer.match(
        /Content-Length:\s*(\d+)\r\n/i
      );
      if (!headerMatch) {
        // No complete header yet — wait for more data
        break;
      }

      const contentLength = parseInt(headerMatch[1], 10);
      const headerEnd =
        headerMatch.index! + headerMatch[0].length + "\r\n".length;

      if (this.buffer.length < headerEnd + contentLength) {
        // Don't have the full body yet — wait for more data
        break;
      }

      // Extract the JSON body
      const body = this.buffer.slice(headerEnd, headerEnd + contentLength);
      this.buffer = this.buffer.slice(headerEnd + contentLength);

      try {
        const message = JSON.parse(body);

        // Check if this is a response to a pending request
        if (message.id != null && this.pending.has(message.id)) {
          const cb = this.pending.get(message.id)!;
          this.pending.delete(message.id);

          // Clear the timeout timer so it doesn't keep Node alive
          if (cb.timer) clearTimeout(cb.timer);

          if (message.error) {
            cb.reject(
              new Error(
                `LSP error: ${message.error.message} (code: ${message.error.code})`
              )
            );
          } else {
            cb.resolve(message.result ?? null);
          }
        }

        // Check if this is a notification (has method but no id)
        if (message.method) {
          const handlers = this.notificationHandlers.get(message.method);
          if (handlers) {
            for (const handler of handlers) {
              handler(message.params);
            }
          }
        }
      } catch {
        // Malformed JSON — skip and continue
      }
    }
  }
}
