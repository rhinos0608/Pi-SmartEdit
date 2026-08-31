/**
 * LSP Manager — Server lifecycle management.
 *
 * Manages LSP server connections per language ID, with lazy startup
 * and graceful fallback when servers are unavailable.
 */

import { constants } from "fs";
import { access } from "fs/promises";
import { delimiter } from "path";
import { resolve } from "path";

import { LSPConnection } from "./lsp-connection";

export interface ServerConfig {
  command: string;
  args: string[];
  languageIds: string[];
}

export interface ManagedLSPConnection {
  initialize(rootUri: string): Promise<unknown>;
  shutdown(): Promise<void>;
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification?(method: string, handler: (params: unknown) => void): () => void;
  isRunning?(): boolean;
  serverCapabilities?: unknown;
}

export interface LSPManagerOptions {
  serverConfigs?: ServerConfig[];
  connectionFactory?: (command: string, args: string[]) => ManagedLSPConnection;
  findExecutable?: (command: string) => Promise<string | null>;
}

export interface LSPServerHealth {
  languageId: string;
  active: boolean;
  running: boolean;
  command?: string;
}

export class LSPManager {
  private connections = new Map<string, ManagedLSPConnection>();
  private connectionConfigs = new Map<string, ServerConfig>();
  private rootUri: string;
  private serverConfigs: ServerConfig[];
  private connectionFactory: (command: string, args: string[]) => ManagedLSPConnection;
  private findExecutableOverride?: (command: string) => Promise<string | null>;
  private pendingServers = new Map<string, Promise<ManagedLSPConnection | null>>();

  private static readonly SERVER_CONFIGS: ServerConfig[] = [
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
    {
      command: "rust-analyzer",
      args: ["--stdio"],
      languageIds: ["rust"],
    },
    {
      command: "gopls",
      args: [],
      languageIds: ["go"],
    },
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
    {
      command: "solargraph",
      args: ["--stdio"],
      languageIds: ["ruby"],
    },
    {
      command: "vscode-json-language-server",
      args: ["--stdio"],
      languageIds: ["json"],
    },
    {
      command: "vscode-html-language-server",
      args: ["--stdio"],
      languageIds: ["html"],
    },
    {
      command: "vscode-css-language-server",
      args: ["--stdio"],
      languageIds: ["css"],
    },
    {
      command: "marksman",
      args: ["--stdio"],
      languageIds: ["markdown"],
    },
    {
      command: "clangd",
      args: [],
      languageIds: ["c", "cpp"],
    },
    {
      command: "omnisharp",
      args: ["--languageserver"],
      languageIds: ["csharp"],
    },
    {
      command: "csharp-ls",
      args: [],
      languageIds: ["csharp"],
    },
    {
      command: "bash-language-server",
      args: ["start"],
      languageIds: ["bash", "shellscript"],
    },
    {
      command: "intelephense",
      args: ["--stdio"],
      languageIds: ["php"],
    },
    {
      command: "phpactor",
      args: ["language-server"],
      languageIds: ["php"],
    },
  ];

  constructor(cwd: string, options: LSPManagerOptions = {}) {
    this.rootUri = `file://${resolve(cwd)}`;
    this.serverConfigs = options.serverConfigs ?? LSPManager.SERVER_CONFIGS;
    this.connectionFactory = options.connectionFactory ?? ((command, args) => new LSPConnection(command, args));
    this.findExecutableOverride = options.findExecutable;
  }

  async getServer(languageId: string): Promise<ManagedLSPConnection | null> {
    const pending = this.pendingServers.get(languageId);
    if (pending) return pending;
    const promise = this.getServerInner(languageId);
    this.pendingServers.set(languageId, promise);
    try { return await promise; }
    finally { this.pendingServers.delete(languageId); }
  }

  private async getServerInner(languageId: string): Promise<ManagedLSPConnection | null> {
    const existing = this.connections.get(languageId);
    if (existing) {
      if (this.isConnectionRunning(existing)) return existing;
      await this.removeServer(languageId);
    }

    const configs = this.serverConfigs.filter((config) =>
      config.languageIds.includes(languageId),
    );
    if (configs.length === 0) return null;

    for (const config of configs) {
      const commandPath = await this.findExecutable(config.command);
      if (!commandPath) continue;

      const args = this.resolveArgs(config);
      if (!args) continue;

      let conn: ManagedLSPConnection | null = null;
      try {
        conn = this.connectionFactory(commandPath, args);
        await conn.initialize(this.rootUri);
        this.connections.set(languageId, conn);
        this.connectionConfigs.set(languageId, config);
        return conn;
      } catch (err) {
        console.warn(`[smart-edit] Failed to start LSP server "${config.command}":`, err);
        if (conn) {
          await conn.shutdown().catch(() => undefined);
        }
      }
    }

    return null;
  }

  async restartServer(languageId: string): Promise<ManagedLSPConnection | null> {
    await this.removeServer(languageId);
    return this.getServer(languageId);
  }

  async removeServer(languageId: string): Promise<void> {
    const existing = this.connections.get(languageId);
    this.connections.delete(languageId);
    this.connectionConfigs.delete(languageId);
    if (existing) {
      await existing.shutdown().catch(() => undefined);
    }
  }

  getActiveLanguages(): string[] {
    return [...this.connections.entries()]
      .filter(([, connection]) => this.isConnectionRunning(connection))
      .map(([languageId]) => languageId)
      .sort();
  }

  async hasSuitableServer(languageId: string): Promise<boolean> {
    const configs = this.serverConfigs.filter((config) =>
      config.languageIds.includes(languageId),
    );

    for (const config of configs) {
      if (!this.resolveArgs(config)) continue;
      if (await this.findExecutable(config.command)) return true;
    }
    return false;
  }

  getServerHealth(languageId: string): LSPServerHealth {
    const connection = this.connections.get(languageId);
    const config = this.connectionConfigs.get(languageId);
    return {
      languageId,
      active: Boolean(connection),
      running: connection ? this.isConnectionRunning(connection) : false,
      command: config?.command,
    };
  }

  async shutdown(): Promise<void> {
    const shutdowns: Promise<void>[] = [];
    for (const languageId of this.connections.keys()) {
      shutdowns.push(this.removeServer(languageId));
    }
    await Promise.all(shutdowns);
  }

  private resolveArgs(config: ServerConfig): string[] | null {
    if (!config.languageIds.includes("java")) return [...config.args];
    const jdtLsJar = process.env.JDT_LS_JAR;
    if (!jdtLsJar && config.args.includes("${JDT_LS_JAR}")) {
      console.warn("[smart-edit] JDT_LS_JAR environment variable is not set for Java LSP");
      return null;
    }
    return config.args.map((arg) => arg === "${JDT_LS_JAR}" ? jdtLsJar ?? arg : arg);
  }

  private isConnectionRunning(connection: ManagedLSPConnection): boolean {
    return connection.isRunning ? connection.isRunning() : true;
  }

  private async findExecutable(command: string): Promise<string | null> {
    if (this.findExecutableOverride) {
      return this.findExecutableOverride(command);
    }
    return this.findInPath(command);
  }

  private async findInPath(command: string): Promise<string | null> {
    const paths = (process.env.PATH || "").split(delimiter);
    for (const dir of paths) {
      const fullPath = resolve(dir, command);
      try {
        await access(fullPath, constants.X_OK);
        return fullPath;
      } catch {
        // Try next PATH entry.
      }
    }
    return null;
  }
}
