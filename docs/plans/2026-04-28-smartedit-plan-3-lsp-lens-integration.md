# Plan 3: LSP Lens Integration

> **Date:** 2026-04-28
> **Status:** Research Phase — Ready for Implementation
> **Phase:** 3/4
> **Depends on:** Plan 1 (AST-Enhancement Fixes), Plan 2 (Multi-Format Input)
> **Blocked by:** Nothing
> **Estimate:** 5–7 days

---

## 1. Objective

Add **Language Server Protocol (LSP)** integration to provide real-time semantic intelligence after edits — diagnostics checking, reference-aware editing, and definition-based anchoring.

This transforms Pi-SmartEdit from a **syntax-aware editor** (Plan 1: tree-sitter AST) into a **semantic editor** that understands types, imports, and cross-file references.

---

## 2. Architecture

```
LLM → edit(path, edits)
         │
         ▼
    applyEdits()        ← Tree-sitter AST validation (Plan 1)
         │
         ▼
    LSP Post-Edit Hook  ← NEW: Check diagnostics after edit
         │
         ├─ ✅ No diagnostics → return result
         ├─ ⚠ Warnings → append to matchNotes
         └─ ❌ Errors → warn in result (advisory, not blocking)
```

### LSP Server Lifecycle

```
session_start
     │
     ▼
  LSPManager created (no servers started)
     │
     │  ┌─── edit .ts file ──→ Start typescript-language-server (lazy)
     │  ├─── edit .py file ──→ Start pyright/pylsp (lazy)
     │  └─── edit unsupported ──→ No LSP (silent fallback)
     │
     ▼
  session_end
     │
     ▼
  LSPManager.shutdown() → all servers exit
```

---

## 3. Module Structure

```
src/lsp/
├── lsp-manager.ts       (NEW — server lifecycle, connection pool)
├── diagnostics.ts       (NEW — post-edit diagnostic checking)
├── semantic-nav.ts      (NEW — go-to-def, find-refs)
├── lsp-connection.ts    (NEW — JSON-RPC stdio transport)
└── index.ts             (NEW — barrel export)
```

### 3.1 `lsp-connection.ts` — JSON-RPC Transport

**Zero-dependency LSP client** — communicates via Node.js `child_process` stdio.

```typescript
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

export class LSPConnection {
  private process: ChildProcess;
  private messageId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';

  constructor(command: string, args: string[]) {
    this.process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdout!.on('data', this.onData.bind(this));
  }

  async initialize(rootUri: string): Promise<void> {
    const response = await this.request('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          diagnostic: { dynamicRegistration: true },
          definition: { dynamicRegistration: true },
          references: { dynamicRegistration: true },
        },
      },
    });
    await this.notify('initialized', {});
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
      // Timeout after 5s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request "${method}" timed out after 5s`));
        }
      }, 5000);
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: '2.0', method, params });
  }

  async shutdown(): Promise<void> {
    await this.request('shutdown');
    this.process.stdin!.end();
  }

  private write(msg: object): void {
    const content = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(content, 'utf-8')}\r\n\r\n`;
    this.process.stdin!.write(header + content);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    // Parse Content-Length headers and JSON messages
    // Full implementation handles header parsing per LSP spec
  }
}
```

**Timeout strategy:** 5s timeout on all LSP requests. If timeout fires, treat as "LSP unavailable" and fall back to non-LSP behavior. This prevents a slow LSP server from blocking edits.

### 3.2 `lsp-manager.ts` — Server Lifecycle

```typescript
interface ServerConfig {
  command: string;
  args: string[];
  languageIds: string[];
}

export class LSPManager {
  private connections = new Map<string, LSPConnection>();
  private rootUri: string;

  // Server binaries — discoverable via PATH
  private static SERVER_CONFIGS: ServerConfig[] = [
    {
      command: 'typescript-language-server',
      args: ['--stdio'],
      languageIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    },
    // More servers can be registered at runtime
  ];

  constructor(cwd: string) {
    this.rootUri = `file://${cwd}`;
  }

  async getServer(languageId: string): Promise<LSPConnection | null> {
    // Check existing connections
    for (const [id, conn] of this.connections) {
      if (id === languageId) return conn;
    }

    // Find matching server config
    const config = LSPManager.SERVER_CONFIGS.find(c =>
      c.languageIds.includes(languageId),
    );
    if (!config) return null;

    // Check if command exists in PATH
    try {
      await access(resolve(process.env.PATH?.split(':')[0] || '/usr/local/bin', config.command));
    } catch {
      console.warn(`[smart-edit] LSP server "${config.command}" not found in PATH`);
      return null;
    }

    // Start server
    try {
      const conn = new LSPConnection(config.command, config.args);
      await conn.initialize(this.rootUri);
      this.connections.set(languageId, conn);
      return conn;
    } catch (err) {
      console.warn(`[smart-edit] Failed to start LSP server "${config.command}":`, err);
      return null;
    }
  }

  async shutdown(): Promise<void> {
    for (const [id, conn] of this.connections) {
      try { await conn.shutdown(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }
}
```

### 3.3 `diagnostics.ts` — Post-Edit Diagnostics Hook

```typescript
export interface DiagnosticResult {
  diagnostics: Array<{
    message: string;
    severity: 1 | 2 | 3 | 4;  // 1=error, 2=warning, 3=info, 4=hint
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    source?: string;
  }>;
  source: 'lsp' | 'none';
}

export async function checkPostEditDiagnostics(
  filePath: string,
  content: string,
  languageId: string,
  lspManager: LSPManager,
): Promise<DiagnosticResult> {
  const server = await lspManager.getServer(languageId);
  if (!server) return { diagnostics: [], source: 'none' };

  const uri = `file://${resolve(filePath)}`;

  // Open document with new content
  await server.notify('textDocument/didOpen', {
    textDocument: { uri, languageId, version: 1, text: content },
  });

  // Wait for diagnostics (server pushes them as notification)
  const diagnostics = await waitForDiagnostics(server, 2000);

  // Close document
  await server.notify('textDocument/didClose', { textDocument: { uri } });

  return { diagnostics, source: 'lsp' };
}
```

**Diagnostics collection:** LSP servers push diagnostics via `textDocument/publishDiagnostics` notification. The `waitForDiagnostics` helper intercepts this notification and collects results with a 2s timeout.

### 3.4 `semantic-nav.ts` — Semantic Navigation Tools

**Go to Definition:**
```typescript
export async function goToDefinition(
  filePath: string,
  line: number,
  character: number,
  languageId: string,
  lspManager: LSPManager,
): Promise<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } } | null> {
  const server = await lspManager.getServer(languageId);
  if (!server) return null;

  const response = await server.request('textDocument/definition', {
    textDocument: { uri: `file://${resolve(filePath)}` },
    position: { line, character },
  });

  return response as any;
}
```

**Find References:**
```typescript
export async function findReferences(
  filePath: string,
  line: number,
  character: number,
  languageId: string,
  lspManager: LSPManager,
): Promise<Array<{ uri: string; range: object }>> {
  const server = await lspManager.getServer(languageId);
  if (!server) return [];

  const response = await server.request('textDocument/references', {
    textDocument: { uri: `file://${resolve(filePath)}` },
    position: { line, character },
    context: { includeDeclaration: true },
  });

  return response as any[];
}
```

**Hover (type info):**
```typescript
export async function getHoverInfo(
  filePath: string,
  line: number,
  character: number,
  languageId: string,
  lspManager: LSPManager,
): Promise<string | null> {
  const server = await lspManager.getServer(languageId);
  if (!server) return null;

  const response = await server.request('textDocument/hover', {
    textDocument: { uri: `file://${resolve(filePath)}` },
    position: { line, character },
  });

  if (!response) return null;
  const hover = response as { contents: { value?: string } | string };
  return typeof hover.contents === 'string' ? hover.contents : hover.contents?.value || null;
}
```

---

## 4. Integration in `index.ts`

### 4.1 Lifecycle Wiring

```typescript
// In index.ts
import { LSPManager } from './lsp/lsp-manager';
import { checkPostEditDiagnostics } from './lsp/diagnostics';

let lspManager: LSPManager | null = null;

pi.on("session_start", async (_event, _ctx) => {
  astResolver = createAstResolver();
  conflictDetector = createConflictDetector(defaultConflictConfig, () => astResolver);
  lspManager = new LSPManager(process.cwd());
  conflictDetector.clearAll();
});

// On session end
pi.on("session_end", async () => {
  await lspManager?.shutdown();
  lspManager = null;
});
```

### 4.2 Post-Edit Diagnostics Hook

In the `execute()` method, **after** `applyEdits()` succeeds but **before** returning the result:

```typescript
// After applyEdits, before return
if (lspManager) {
  const languageId = detectLanguageFromExtension(path);
  const diagnosticResult = await checkPostEditDiagnostics(
    path,
    result.newContent,   // The content that was written
    languageId,
    lspManager,
  );

  if (diagnosticResult.source === 'lsp' && diagnosticResult.diagnostics.length > 0) {
    const errors = diagnosticResult.diagnostics.filter(d => d.severity === 1);
    const warnings = diagnosticResult.diagnostics.filter(d => d.severity === 2);

    if (errors.length > 0) {
      result.matchNotes.push(
        `⚠ LSP detected ${errors.length} error(s) after edit: ` +
        errors.map(e => `line ${e.range.start.line + 1}: ${e.message}`).join('; ')
      );
    }
    if (warnings.length > 0) {
      result.matchNotes.push(
        `ℹ LSP has ${warnings.length} warning(s): ` +
        warnings.map(e => e.message).join('; ')
      );
    }
  }
}
```

---

## 5. LSP Server Discovery Strategy

### Step 1: PATH Scanning (default)
Check common location for language server binaries:
```typescript
async function findServerInPath(command: string): Promise<string | null> {
  const paths = (process.env.PATH || '').split(':');
  for (const dir of paths) {
    const fullPath = join(dir, command);
    try {
      await access(fullPath, constants.X_OK);
      return fullPath;
    } catch { /* not here */ }
  }
  return null;
}
```

### Step 2: Config file override (optional)
Users can specify custom server paths in `.pi/extensions/smart-edit/lsp-config.json`:
```json
{
  "servers": {
    "typescript": { "command": "/path/to/typescript-language-server", "args": ["--stdio"] },
    "python": { "command": "pylsp", "args": [] }
  }
}
```

---

## 6. File Changes Summary

| File | Change |
|------|--------|
| `src/lsp/lsp-connection.ts` | NEW — JSON-RPC stdio transport |
| `src/lsp/lsp-manager.ts` | NEW — Server lifecycle |
| `src/lsp/diagnostics.ts` | NEW — Post-edit diagnostics |
| `src/lsp/semantic-nav.ts` | NEW — Go-to-def, find-refs, hover |
| `src/lsp/index.ts` | NEW — Barrel export |
| `lib/types.ts` | Add `DiagnosticResult`, `LSPConfig` types |
| `index.ts` | Add LSP lifecycle + post-edit hook |

---

## 7. Test Plan

### Unit Tests (16+ tests)

| Test Suite | Tests | Key Cases |
|-----------|-------|-----------|
| `lsp-connection.test.ts` | 6 | Init sequence; request/response; notification; timeout; shutdown; malformed response |
| `lsp-manager.test.ts` | 6 | Server start; caching; server not found; start failure; concurrent languages; shutdown |
| `diagnostics.test.ts` | 6 | No diagnostics; errors; warnings; mixed; timeout; no LSP server |
| `semantic-nav.test.ts` | 4 | Go-to-def; find-refs; hover; not found |

### Integration Tests (3+)

| Test | What It Verifies |
|------|-----------------|
| Real TS LSP server: edit type-safe code → no diagnostics | LSP works end-to-end |
| Real TS LSP server: break type → see error in matchNotes | Diagnostics surfaced |
| Real TS LSP server: no changes → no diagnostics | No false positives |

### Mock LSP Server

For unit tests, use a **mock LSP server** that echoes predefined responses:

```typescript
// test/lsp/mock-server.ts
import { spawn } from 'child_process';

export function createMockLSP(): ChildProcess {
  const child = spawn(process.execPath, ['-e', `
    process.stdin.on('data', (chunk) => {
      const content = chunk.toString();
      // Parse Content-Length, respond with mock data
      process.stdout.write(
        'Content-Length: 65\\r\\n\\r\\n' +
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } })
      );
    });
  `]);
  return child;
}
```

---

## 8. Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| LSP server not found in PATH | LSP unavailable | Graceful degradation to non-LSP editing |
| LSP server crashes mid-edit | Lost connection | Catch errors, restart on next edit |
| Slow LSP diagnostic response | Edit latency spike | 5s timeout — timeout = fallback |
| LSP server memory leak | Process memory growth | Shutdown on session_end, one server per language |
| User doesn't have LSP installed | No diagnostics | Clear error message at info level, not warning |
| Language server conflicts with project's tsconfig | Wrong diagnostics | User-configurable server paths |

---

## 9. Dependencies

**No new npm dependencies.** The LSP client is implemented from scratch using:
- `child_process.spawn` — stdio communication
- Custom LSP message parser (Content-Length header format)
- No `vscode-languageserver-node` dependency (too heavy, has VS Code baggage)

---

## 10. Acceptance Criteria

- [ ] LSP server starts lazily on first edit to a supported file type
- [ ] Post-edit diagnostics appear in matchNotes
- [ ] Errors (severity 1) produce ⚠-prefixed warnings
- [ ] Warnings (severity 2) produce ℹ-prefixed notes
- [ ] 5s timeout on LSP requests — doesn't block edit
- [ ] Graceful degradation when LSP server not installed
- [ ] Server shutdown on session_end
- [ ] 16+ unit tests + 3+ integration tests pass
- [ ] Mock LSP server for testing
