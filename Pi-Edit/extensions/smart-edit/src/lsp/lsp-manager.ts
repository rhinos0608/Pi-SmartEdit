/**
 * LSP Manager — Server lifecycle management.
 *
 * Manages LSP server connections per language ID, with lazy startup
 * and graceful fallback when servers are unavailable.
 */

import { access } from "fs/promises";
import { resolve } from "path";

import { LSPConnection } from "./lsp-connection";

interface ServerConfig {
  command: string;
  args: string[];
  languageIds: string[];
}

/**
 * Manages LSP server connections for multiple language types.
 * Servers are started lazily (on first request) and reused across edits.
 *
 * Usage:
 *   const manager = new LSPManager("/path/to/project");
 *   const server = await manager.getServer("typescript");
 *   // Use server...
 *   await manager.shutdown();
 */
export class LSPManager {
  private connections = new Map<string, LSPConnection>();
  private rootUri: string;

  /**
   * Pre-configured LSP servers, discovered via PATH.
   * Each server handles one or more language IDs.
   *
   * NOTE: Multiple configs may target the same languageIds (e.g., both
   * "typescript-language-server" and "typescriptlangserver" serve
   * TypeScript/JavaScript). getServer returns the first successfully
   * connected server and caches it per languageId — the backup config
   * is never tried once a server is registered. This means if the first
   * config's binary is found but fails to connect, the second config
   * will not be attempted (the languageId key is already in the map
   * at that point). Consider expanding the retry logic if this becomes
   * an issue in practice.
   */
  private static readonly SERVER_CONFIGS: ServerConfig[] = [
    // TypeScript / JavaScript
    {
      command: "typescript-language-server",
      args: ["--stdio"],
      languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    },
    {
      command: "typescriptlangserver",
      args: ["--stdio"],
      languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    },
    // Python
    {
      command: "pyright",
      args: ["--stdio"],
      languageIds: ["python"],
    },
    {
      command: "pylsp",
      args: ["--stdio"],
      languageIds: ["python"],
    },
    {
      command: "pyls",
      args: ["--stdio"],
      languageIds: ["python"],
    },
    {
      command: "jedi-language-server",
      args: ["--stdio"],
      languageIds: ["python"],
    },
    // Rust
    {
      command: "rust-analyzer",
      args: ["--stdio"],
      languageIds: ["rust"],
    },
    // Go
    {
      command: "gopls",
      args: [],
      languageIds: ["go"],
    },
    // Java
    {
      command: "java",
      args: ["-jar", "${JDT_LS_JAR}", "--stdio"],
      languageIds: ["java"],
    },
    {
      command: "jdtls",
      args: [],
      languageIds: ["java"],
    },
    // Ruby
    {
      command: "solargraph",
      args: ["--stdio"],
      languageIds: ["ruby"],
    },
    // JSON
    {
      command: "vscode-json-language-server",
      args: ["--stdio"],
      languageIds: ["json"],
    },
    // HTML
    {
      command: "vscode-html-language-server",
      args: ["--stdio"],
      languageIds: ["html"],
    },
    // CSS
    {
      command: "vscode-css-language-server",
      args: ["--stdio"],
      languageIds: ["css"],
    },
    // Markdown
    {
      command: "marksman",
      args: ["--stdio"],
      languageIds: ["markdown"],
    },
  ];

  constructor(cwd: string) {
    this.rootUri = `file://${resolve(cwd)}`;
  }

  /**
   * Get or create an LSP server connection for a given language ID.
   * Returns null if no server is configured for the language or no
   * configured server can be successfully initialized.
   *
   * @param languageId  LSP language ID (e.g., "typescript", "python")
   * @returns The LSP connection, or null if unavailable
   */
  async getServer(languageId: string): Promise<LSPConnection | null> {
    // Return existing connection if available
    const existing = this.connections.get(languageId);
    if (existing) return existing;

    // Find all matching server configs
    const configs = LSPManager.SERVER_CONFIGS.filter((c) =>
      c.languageIds.includes(languageId)
    );
    if (configs.length === 0) return null;

    for (const config of configs) {
      // Check if command exists in PATH
      const commandPath = await this.findInPath(config.command);
      if (!commandPath) {
        continue;
      }

      // Resolve runtime config values (e.g., JDT_LS_JAR for Java)
      let args = [...config.args];
      if (config.languageIds.includes("java")) {
        const jdtLsJar = process.env.JDT_LS_JAR;
        if (!jdtLsJar) {
          console.warn("[smart-edit] JDT_LS_JAR environment variable is not set for Java LSP");
          continue;
        }
        // Substitute the jar path
        args = args.map((arg) =>
          arg === "${JDT_LS_JAR}" ? jdtLsJar : arg
        );
      }

      // Start and initialize server
      let conn: LSPConnection | undefined;
      try {
        conn = new LSPConnection(commandPath, args);
        await conn.initialize(this.rootUri);
        // Only cache after successful initialization
        this.connections.set(languageId, conn);
        return conn;
      } catch (err) {
        console.warn(`[smart-edit] Failed to start LSP server "${config.command}":`, err);
        // Clean up failed connection attempt
        if (conn) {
          try {
            await conn.shutdown();
          } catch {
            // Ignore cleanup errors
          }
        }
        // Continue to the next config if available
      }
    }

    return null;
  }

  /**
   * Gracefully shut down all active LSP server connections.
   */
  async shutdown(): Promise<void> {
    const shutdowns: Promise<void>[] = [];
    for (const [, conn] of this.connections) {
      shutdowns.push(
        conn
          .shutdown()
          .catch(() => {/* ignore shutdown errors */})
      );
    }
    await Promise.all(shutdowns);
    this.connections.clear();
  }

  /**
   * Search PATH for an executable by name.
   * Returns the full path if found, or null if not in PATH.
   *
   * NOTE: Splits PATH on ":" — this assumes a Unix-like (macOS/Linux)
   * environment. Windows uses ";" as separator.
   */
  private async findInPath(command: string): Promise<string | null> {
    const paths = (process.env.PATH || "").split(":");
    for (const dir of paths) {
      const fullPath = resolve(dir, command);
      try {
        await access(fullPath);
        return fullPath;
      } catch {
        // Not in this directory — try next
      }
    }
    return null;
  }
}