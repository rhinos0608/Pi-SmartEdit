# Research: pi-lens LSP Diagnostics Pattern

## Problem Statement

smart-edit has LSP diagnostics code, but it only works for files within a TypeScript project (requires `tsconfig.json`). pi-lens works immediately without any setup. This document researches why and how pi-lens achieves automatic diagnostics.

## pi-lens Diagnostic Architecture

pi-lens uses a **multi-tier fallback dispatcher**, NOT just LSP:

### Tier 1: LSP Server Diagnostics
- Opens file via `textDocument/didOpen`
- Waits for push-based `textDocument/publishDiagnostics` notification
- Falls back to pull-based `textDocument/diagnostic` request (LSP 3.17)
- Requires language server to be installed

### Tier 2: Language-Specific Type-Checkers
These catch cross-file errors that LSP per-file analysis misses:

| Language | Command | When |
|----------|---------|------|
| TypeScript | `npx tsc --noEmit` | tsconfig.json exists |
| Python | `pyright --outputjson .` or `ruff check` | .py files detected |
| Go | `go vet ./...` | go.mod exists |
| Rust | `cargo check --message-format=json` | Cargo.toml exists |
| Ruby | `rubocop --format json` | Gemfile exists |

### Tier 3: Tree-sitter Structural Rules
Language-aware pattern matching via tree-sitter queries.

### Tier 4: Ast-grep Rule Scans
180+ security/correctness rules for JS/TS/Python.

### Tier 5: Similarity Detection
Duplicate code detection.

---

## How pi-lens Auto-Discovers LSP Servers

### Discovery Chain
pi-lens tries servers in this order:

1. **PATH** - Direct command lookup via `safeSpawn(command, ["--version"])`
2. **node_modules/.bin** - Per-project npm binaries via `findInNodeModules()`
3. **vscode-langservers-extracted** - Pre-bundled npm package for JS/TS/CSS/HTML
4. **npm package installers** - Auto-installs via `ensureTool()`
5. **Compiler fallback** - Uses language compiler as last resort

### The vscode-langservers-extracted Bundle
This is the key: pi-lens installs `vscode-langservers-extracted` which includes:
- JSON language server
- CSS language server  
- HTML language server
- ESLint language server
- And more

This provides diagnostics for JS/TS/JSON/CSS/HTML **without any external LSP server**.

### Node_modules Binary Discovery
```typescript
async function findInNodeModules(binary: string, cwd: string): Promise<string | null> {
  const isWin = process.platform === "win32";
  let dir = cwd;
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidates = isWin
      ? [path.join(dir, "node_modules", ".bin", `${binary}.cmd`), path.join(dir, "node_modules", ".bin", binary)]
      : [path.join(dir, "node_modules", ".bin", binary)];
    for (const full of candidates) {
      if (await fileExists(full)) return full;
    }
    dir = path.dirname(dir);
  }
  return null;
}
```

---

## Why smart-edit Diagnostics Don't Work

### Current smart-edit Flow
1. Opens file via `textDocument/didOpen` with content
2. Waits for push-based diagnostics (3s timeout)
3. Falls back to pull-based `textDocument/diagnostic`
4. Returns empty if no server found or no tsconfig.json

### Problems
1. **Only has TS/JS server configs** - No Python, Go, Rust, etc.
2. **No vscode-langservers-extracted** - Missing the bundled servers
3. **No compiler fallback** - Doesn't run tsc/pyright/cargo for whole-workspace errors
4. **No installer** - Can't auto-install missing tools
5. **Requires tsconfig.json** - TypeScript server only works in project context

---

## Key Findings

### Finding 1: The Installer is Critical
pi-lens has a full installer component that:
1. Detects missing tools via `[command, --version]` spawn tests
2. Auto-installs via `pi install` or GitHub releases
3. Stores binaries in `~/.pi-lens/bin/`
4. Adds to PATH at runtime

This is why it "just works" - missing tools get installed automatically.

### Finding 2: Compiler Fallback Catches More Errors
The big difference is compiler-based diagnostics:
- LSP diagnostics are per-file (opened document only)
- Compiler runs on entire project, finds cross-file errors
- This catches broken imports, missing exports, etc.

### Finding 3: vscode-langservers-extracted
This npm package ships the core language servers pre-bundled:
- No external server installation needed
- Works immediately for JS/TS/JSON/CSS/HTML
- Installed via `npm install vscode-langservers-extracted`

---

## Recommendations for smart-edit

To match pi-lens behavior, need to add:

1. **Add vscode-langservers-extracted** to dependencies
2. **Add compiler fallback** - Run tsc/pyright/cargo after LSP
3. **Add more server configs** - Already done in previous edit
4. **Add diagnostic dispatcher** - Multi-tier pipeline
5. **Consider installer** - For auto-installing missing tools

This explains why smart-edit "doesn't work" - it's missing this entire fallback layer.