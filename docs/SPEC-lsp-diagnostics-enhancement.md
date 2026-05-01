# Specification: smart-edit LSP Diagnostics Enhancement

## Motivation

smart-edit's current LSP diagnostics only work within TypeScript projects (with tsconfig.json). pi-lens achieves automatic diagnostics through a multi-tier fallback approach. This spec defines enhancements to achieve similar behavior.

## Goals

1. **Work immediately** without project configuration
2. **Multi-tier diagnostics** - LSP + compiler fallback + linter fallback
3. **Auto-discovery** - Find servers in PATH, node_modules, bundled
4. **Graceful degradation** - No warnings when tools unavailable

---

## Architecture

### Current (smart-edit)
```
Edit → textDocument/didOpen → Wait for diagnostics → Return
```

### Proposed (pi-lens style)
```
Edit → LSP diagnostics
     → Compiler diagnostics (tsc/pyright/cargo)
     → Linter diagnostics (ruff/biome/eslint)
     → Aggregate results
```

---

## Implementation Specification

### 1. Add Diagnostic Dispatcher

Create `src/lsp/diagnostic-dispatcher.ts`:

```typescript
interface DiagnosticTool {
  name: string;
  canRun: () => Promise<boolean>;
  run: (file: string, cwd: string) => Promise<ToolResult>;
  priority: number;
}

class DiagnosticDispatcher {
  private tools: DiagnosticTool[] = [];
  
  // Add tools in priority order (lower = run first)
  addTool(tool: DiagnosticTool): void;
  
  async dispatch(file: string, cwd: string): Promise<DiagnosticsResult>;
}
```

### 2. Add Compiler Fallback Tools

Define compiler-based diagnostic runners:

```typescript
import { execFileSync, spawn } from "node:child_process";

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

// For TypeScript
const tscRunner: DiagnosticTool = {
  name: "tsc",
  canRun: async () => {
    try {
      execFileSync("npx", ["tsc", "--version"], { timeout: 5000, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
  run: async (file, cwd) => {
    const result = await runCommand("npx", ["tsc", "--noEmit", "--pretty", "false", file], cwd, 60000);
    return parseTscOutput(result.stdout + result.stderr);
  },
  priority: 10,
};

// For Python
const pyrightRunner: DiagnosticTool = {
  name: "pyright",
  canRun: async () => {
    try {
      execFileSync("pyright", ["--version"], { timeout: 5000, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
  run: async (file, cwd) => {
    const result = await runCommand("pyright", ["--outputjson", file], cwd, 60000);
    return parsePyrightOutput(result.stdout || result.stderr || "");
  },
  priority: 10,
};

// More runners: ruff, cargo check, go vet, rubocop
```

### 3. Add Bundled Server Fallback

Install vscode-langservers-extracted to get baseline diagnostics:

```bash
npm install vscode-langservers-extracted vscode-json-languageserver vscode-css-languageserver vscode-html-languageserver
```

Or bundle detection in lsp-manager.ts:

```typescript
import { access } from "node:fs/promises";
import path from "node:path";

async function findInNodeModules(binary: string, cwd: string): Promise<string | null> {
  const isWin = process.platform === "win32";
  let dir = cwd;

  while (true) {
    const candidates = isWin
      ? [path.join(dir, "node_modules", ".bin", `${binary}.cmd`), path.join(dir, "node_modules", ".bin", binary)]
      : [path.join(dir, "node_modules", ".bin", binary)];

    for (const full of candidates) {
      try {
        await access(full);
        return full;
      } catch {
        // continue upward
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function findBundledServer(languageId: string, cwd: string): Promise<string | null> {
  const bundled: Record<string, string[]> = {
    typescript: ["typescript-language-server", "tsserver"],
    javascript: ["typescript-language-server", "tsserver"],
    json: ["vscode-json-languageserver"],
    css: ["vscode-css-languageserver"],
    html: ["vscode-html-languageserver"],
  };

  const candidates = bundled[languageId] || [];
  return candidates.length > 0 ? findInNodeModules(candidates[0], cwd) : null;
}
```

### 4. Add Diagnostic Aggregator

After edit, run dispatcher and aggregate all results:

```typescript
// In index.ts, after edit is applied
async function runDiagnosticPipeline(
  filePath: string,
  content: string,
  cwd: string
): Promise<AggregatedDiagnostics> {
  const dispatcher = new DiagnosticDispatcher();
  
  // Add LSP as first tier
  dispatcher.addTool({
    name: "lsp",
    canRun: async () => !!await lspManager.getServer(detectLanguage(filePath)),
    run: async (file, cwd) => await checkPostEditDiagnostics(file, content, ...),
    priority: 1,
  });
  
  // Add compiler as fallback
  const compiler = getCompilerForLanguage(detectLanguage(filePath));
  if (compiler) dispatcher.addTool(compiler);
  
  // Add linter as further fallback
  const linter = getLinterForLanguage(detectLanguage(filePath));
  if (linter) dispatcher.addTool(linter);
  
  return dispatcher.dispatch(filePath, cwd);
}
```

### 5. Update Match Notes Generation

In index.ts output generation:

```typescript
// Current (only LSP)
if (diagResult.source === "lsp" && diagResult.diagnostics.length > 0) { ... }

// Updated (aggregate LSP + compiler + linter)
const allDiagnostics = await runDiagnosticPipeline(path, content, cwd);
const errors = allDiagnostics.filter(d => d.severity === 1);
const warnings = allDiagnostics.filter(d => d.severity === 2);

if (errors.length > 0) {
  matchNotes.push(`Error: ${errors.length} issue(s): ` + 
    errors.map(e => `line ${e.range.start.line}: ${e.message}`).join("; "));
}
```

---

## File Changes

### New Files
- `src/lsp/diagnostic-dispatcher.ts` - Multi-tier diagnostic runner
- `src/lsp/compiler-runners.ts` - tsc/pyright/cargo/go vet runners
- `src/lsp/bundled-servers.ts` - Bundled server discovery

### Modified Files
- `src/lsp/lsp-manager.ts` - Add bundled server lookup ✓ (done)
- `index.ts` - Replace single LSP call with diagnostic pipeline
- `package.json` - Add vscode-langservers-extracted (optional)

---

## Priority

1. **High**: Add vscode-langservers-extracted to provide baseline diagnostics
2. **High**: Add tsc compiler fallback for TypeScript project errors  
3. **Medium**: Add pyright/ruff fallback for Python
4. **Medium**: Add diagnostic dispatcher for multi-tier aggregation
5. **Low**: Add full installer for auto-installing missing tools

---

## Alternative: Lightweight Approach

If full implementation is too complex, add simple compiler fallback:

```typescript
interface DiagnosticResult {
  diagnostics: Diagnostic[];
  source: string;
}

function parseCompilerOutput(output: string): DiagnosticResult {
  // Accept compiler stdout + stderr, parse the supported compiler formats,
  // and return a normalized diagnostic result.
  return {
    diagnostics: [],
    source: "compiler",
  };
}

async function checkCompilerDiagnostics(
  filePath: string,
  cwd: string,
  languageId: string
): Promise<DiagnosticResult> {
  const ext = path.extname(filePath);

  // Map extension to compiler
  const compilerMap: Record<string, [string, string[]]> = {
    ".ts": ["npx", ["tsc", "--noEmit", "--pretty", "false", filePath]],
    ".py": ["pyright", ["--outputjson", filePath]],
    ".go": ["go", ["vet", "./..."]],
    ".rs": ["cargo", ["check", "--message-format=json", "--quiet"]],
  };

  const [cmd, args] = compilerMap[ext] || [];
  if (!cmd) return { diagnostics: [], source: "none" };

  // Run compiler with a real timeout and parse its combined output.
  const result = await runCommand(cmd, args, cwd, 60000);
  return parseCompilerOutput(result.stdout + result.stderr);
}
```

This provides immediate value without full diagnostic dispatcher complexity.
