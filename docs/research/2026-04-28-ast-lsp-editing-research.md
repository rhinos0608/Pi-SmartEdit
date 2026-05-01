# AST-Based Tools, AI Editing Patterns & LSP Integration — Research Report

> **Date:** 2026-04-28
> **Scope:** Comprehensive research into AST manipulation tools, AI coding agent editing strategies, parser ecosystems, and Language Server Protocol integration — for Pi-SmartEdit Phase 3 expansion.

---

## Table of Contents

1. [AST-Based Search & Rewrite Tools](#1-ast-based-search--rewrite-tools)
2. [String Manipulation & Diff Libraries](#2-string-manipulation--diff-libraries)
3. [Parser Ecosystems](#3-parser-ecosystems)
4. [AI Agent Editing Patterns — Industry Survey](#4-ai-agent-editing-patterns--industry-survey)
5. [LSP Integration for AI Agents](#5-lsp-integration-for-ai-agents)
6. [File System & Pattern Matching Tools](#6-file-system--pattern-matching-tools)
7. [Cross-Cutting Patterns & Recommendations](#7-cross-cutting-patterns--recommendations)
8. [Sources & References](#8-sources--references)

---

## 1. AST-Based Search & Rewrite Tools

### 1.1 @ast-grep/napi (v0.42.1)

**Repository:** [ast-grep/ast-grep](https://github.com/ast-grep/ast-grep) — 13,600+ stars, MIT license, Rust-based

**Overview:**
ast-grep is a **structural search and rewrite** tool that uses abstract syntax tree (AST) pattern matching via tree-sitter. It treats search patterns as code — you write normal-looking code with `$META` wildcards that match any AST node, not just text.

**Key Capabilities:**

| Feature | Description |
|---------|-------------|
| Pattern matching | Write code-like patterns; `$VAR` matches any single AST node |
| Multi-language | Supports 20+ languages via tree-sitter, custom parsers via dynamic loading |
| Rewrite/Replace | `--rewrite 'new $PATTERN'` transforms matched code structurally |
| YAML rules | Write lint rules and codemods as YAML configuration files |
| jQuery-like API | Programmatic AST traversal and manipulation in JavaScript |
| Parallel execution | Rust-based, multi-core search across thousands of files |
| Type-safe Node API | `@ast-grep/napi` provides opt-in TypeScript types |

**NPM Package:** `@ast-grep/napi` — 0.42.1, published 2026-04-04
**GitHub Stars:** 13,602 | **Forks:** 347 | **Language:** Rust | **License:** MIT

**How Patterns Work:**

```typescript
// Pattern: 'var $CODE = $PATTERN'
// Matches: let x = foo() — AST-node aware, not text regex
// Rewrite: 'let $CODE = new $PATTERN'
// Produces: let x = new foo()
```

**Relevance to Pi-SmartEdit:**
- Can provide **structural search** across the agent's codebase before edits
- Enables **syntax-aware refactoring** (rename parameters, transform patterns)
- YAML rules enable **custom lint/codemod policies** that the agent enforces
- Perfect for **large-scale edits** where pattern replacement applies across many files

**Limitations:**
- Requires tree-sitter grammar per language (may not be installed by default)
- Pattern DSL has learning curve for complex matches
- Heavier dependency than pure-text approaches

---

### 1.2 tree-sitter (v0.25.0)

**Repository:** [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) — 19,800+ stars

**Overview:**
Tree-sitter is an **incremental parsing library** that builds a concrete syntax tree (CST) and efficiently updates it as source code changes. It is the foundational layer for ast-grep, many LSP servers, and all modern IDE code intelligence.

**Key Capabilities:**

| Feature | Description |
|---------|-------------|
| Incremental parsing | Re-parses only changed regions — O(log n) updates |
| Error recovery | Produces a valid tree even from incomplete/incorrect code |
| Multi-language | Grammars for 100+ languages |
| Node.js bindings | `tree-sitter` npm package, v0.25.0, 219+ dependents |
| WebAssembly | `web-tree-sitter` for browser environments |
| CST, not AST | Preserves whitespace, comments — ideal for editing tools |

**Pi-SmartEdit Already Uses:**
The extension's `package.json` already lists `web-tree-sitter: ^0.22.6` as a dependency, and the `ast-resolver.test.ts` test file exists, suggesting initial AST infrastructure is in place.

**Integration Patterns:**

```typescript
// Lazy-init tree-sitter per language
const parser = await Parser.create();
const lang = await Parser.Language.load(languageWasmPath);
parser.setLanguage(lang);
const tree = parser.parse(sourceCode);

// Query for nodes
const query = lang.query('(function_definition name: (identifier) @fn)');
const matches = query.matches(tree.rootNode);
```

**Relevance to Pi-SmartEdit:**
- **AST-aware edit validation** — validate edits maintain syntactic correctness
- **Edit scope detection** — find the enclosing function/class/block for context anchoring
- **Smart indentation** — use tree structure to calculate correct indentation
- **Comment preservation** — ensure AST-aware transforms don't lose comments
- **Already partially integrated** via `web-tree-sitter` dependency

---

### 1.3 jscodeshift (v17.3.0)

**Repository:** [facebook/jscodeshift](https://github.com/facebook/jscodeshift) — Facebook-maintained

**Overview:**
jscodeshift is a **codemod toolkit** for running JavaScript/TypeScript transformations across multiple files. It wraps **recast** for AST-to-AST transformation while preserving formatting.

**Key Capabilities:**

| Feature | Description |
|---------|-------------|
| Recast-based | Non-destructive AST transforms — preserves original formatting |
| Runner | Batch-process multiple files with summary output |
| Collection API | jQuery-style fluent API for AST traversal |
| TypeScript support | Built-in parser support for `.ts`/`.tsx` files |
| Source maps | Automatic source map generation |
| Battle-tested | Industry standard for large-scale refactoring (React codemods, etc.) |

**Architecture Pattern:**
```typescript
// Transform file: transform.js
export default function transformer(file, api) {
  const j = api.jscodeshift;
  return j(file.source)
    .find(j.FunctionDeclaration)
    .forEach(path => {
      j(path).replaceWith(
        j.arrowFunctionExpression([], path.node.body)
      );
    })
    .toSource();
}
```

**Relevance to Pi-SmartEdit:**
- **JavaScript/TypeScript-specific deep transformations**
- **Format-preserving edits** — critical for user acceptance
- **Collection API** pattern could inspire Pi-SmartEdit's own edit operations
- Best for **complex refactors** where simple search/replace isn't enough

---

### 1.4 recast (v0.23.11)

**Repository:** [benjamn/recast](https://github.com/benjamn/recast) — Used by jscodeshift, Babel

**Overview:**
Recast is a **non-destructive pretty-printer** that parses JavaScript into an AST, lets you transform it, and prints it back while preserving original formatting (whitespace, comments, etc.).

**Key Insight:**
Recast's secret is that it tracks **comments and formatting tokens** separately from the AST, reattaching them on output. This is the gold standard for format-preserving AST transforms.

---

## 2. String Manipulation & Diff Libraries

### 2.1 magic-string (v0.30.21)

**NPM:** [magic-string](https://www.npmjs.com/package/magic-string) — 3,420+ dependents

**Overview:**
Magic-string provides **efficient string manipulation with automatic source map generation**. It tracks original → modified positions so you can modify strings, split, append, and prepend content while always knowing where output characters map back to the source.

**Key API:**
```typescript
import MagicString from 'magic-string';
const s = new MagicString(sourceCode);
s.overwrite(start, end, replacement); // Replace range with new text
s.remove(start, end);                  // Remove range
s.prepend(text); s.append(text);       // Add before/after
s.generateMap();                       // Generate source map
```

**Relevance to Pi-SmartEdit:**
- **Source map generation** — critical for editors/debuggers when code is transformed
- **Efficient overlapping edits** — chain multiple edits on the same string
- **Position tracking** — track where edits land relative to original source
- **Lighter than full AST** — for cases where AST parsing is overkill

### 2.2 diff-match-patch / @sanity/diff-match-patch

**Overview:**
Google's diff-match-patch implements the **Myers diff algorithm** for robust text comparison and patch application. It's used by Google Docs, VS Code, and many collaborative editing systems.

**Key Capabilities:**
- `diff_main()` — compute differences between two texts
- `match_main()` — fuzzy search for pattern in text
- `patch_make()` — create patches from diffs
- `patch_apply()` — apply patches with fuzzy matching

**Relevance to Pi-SmartEdit:**
- **Better diff visualization** for edit confirmation
- **Fuzzy patch application** — more robust than exact-match-only approaches
- **Conflict resolution** — merge multiple edits to same region
- Already in the space: `diff` package (v7.0.0) is a current dependency

---

## 3. Parser Ecosystems

### 3.1 espree (v11.2.0)

**Role:** ESLint's default JavaScript parser (acorn-based)
**Use case:** Linting-compatible AST for JavaScript/TypeScript validation after edits
**Relevance:** Post-edit lint validation — check that edited code passes ESLint rules

### 3.2 hermes-parser (v0.35.0)

**Role:** Facebook's Flow-compatible JavaScript parser
**Use case:** Flow-typed codebase parsing; experimental transforms
**Relevance:** Niche — only needed for Flow-typed projects

### 3.3 oxc-parser (v0.127.0)

**Repository:** [oxc-project/oxc](https://github.com/oxc-project/oxc) — The JavaScript Oxidation Compiler

**Performance Highlights:**
| Metric | oxc | swc | Biome |
|--------|-----|-----|-------|
| Parsing speed | 1x (fastest) | 3x slower | 5x slower |
| Memory (parser.ts 10,777 lines) | ~50MB | ~150MB | ~200MB |
| Transformer | 3x faster | — | — |

**Overview:**
oxc is a **high-performance Rust-based JavaScript/TypeScript toolchain** with Node.js bindings. It includes parser, linter, minifier, and transformer. It's part of VoidZero's vision for a unified JS toolchain.

**Key Capabilities (Node API):**
```typescript
import oxc from 'oxc-parser';
const result = oxc.parseAsync(sourceCode, {
  sourceType: 'module',
  sourceFilename: 'file.tsx'
});
// Returns: { ast, comments, errors, ... }
```

**Relevance to Pi-SmartEdit:**
- **Blazing fast parsing** — 3-5x faster than alternatives for large files
- **AST validation** after edits to catch syntax errors
- **Semantic analysis** via oxc_semantic crate (scope, references, types)
- **Linter integration** — run oxlint rules on edited code
- Future-proof: oxc is becoming the standard for Rust-based JS tooling

---

## 4. AI Agent Editing Patterns — Industry Survey

### 4.1 The Core Problem

Research by Fabian Hertwig (April 2025) and validated across Codex, Aider, OpenHands, RooCode, and Cursor:

> **LLMs lack direct file system access.** They describe changes via tools, which interpret and apply them. This handoff is the primary source of edit failures.

### 4.2 Edit Format Evolution

| Format | Used By | Strengths | Weaknesses |
|--------|---------|-----------|------------|
| **Search/Replace** (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`) | Aider, Cline, RooCode | Intuitive, explicit before/after | Exact match required (with fuzzy fallback) |
| **Unified Diff** (`diff -U0` style) | Aider (udiff), OpenHands | Standard tool format, reversible | Harder for LLMs to generate correctly |
| **OpenAI Patch** (`*** Begin Patch`, `@@` context lines) | Codex, Aider | Line-number-free, context anchoring | Verbose, requires trained model |
| **Whole File** | Aider (whole) | Simple, unambiguous | Token-inefficient for large files |
| **LLM-Assisted Apply** | Cursor, OpenHands | Handles complex cases | Requires second model, latency |

### 4.3 Key Strategies Compared

**Codex (OpenAI):** Patch-based with `@@` context line matching. Three-tier fallback: exact → ignore line endings → ignore all whitespace. Structured JSON error feedback.

**Aider:** Pluggable "coder" classes for each format. Layered matching: exact → whitespace-insensitive → indentation-preserving → fuzzy (difflib). Detailed error output showing the mismatched context.

**OpenHands:** Traditional + optional LLM-based editing. Detects patch format via regex (unified diffs, git diffs, context diffs, ed scripts). "Draft editor" LLM for rewriting extracted sections.

**RooCode:** Middle-out fuzzy matching (Levenshtein distance). Start near expected location, expand outward, score similarity. **Best-in-class indentation preservation** — captures original leading whitespace, analyzes relative indentation, re-applies.

**Cursor:** Two-stage AI process — **sketch** (primary LLM generates change) → **apply** (specialized model integrates into codebase). Separates "what to change" from "how to apply."

### 4.4 Universal Lessons for Pi-SmartEdit

1. **Avoid line numbers** — they shift and cause brittle edits
2. **Provide context (anchoring)** — surrounding unchanged lines are crucial
3. **Layered matching** — start strict, get fuzzy on failure
4. **Rich error feedback** — show what didn't match and what was expected
5. **Indentation preservation** — critical for Python, important for all languages
6. **Format convergence** — search/replace blocks and context-anchored patches are the winners

---

## 5. LSP Integration for AI Agents

### 5.1 What Is LSP?

The **Language Server Protocol** (Microsoft, 2016) standardizes communication between code editors and language intelligence backends. A language server is a standalone process that deeply understands a language's syntax, type system, imports, and project structure, communicating via JSON-RPC.

### 5.2 Key LSP Operations

| Operation | Method | What It Does | Agent Benefit |
|-----------|--------|--------------|---------------|
| Go to Definition | `textDocument/definition` | Jump to symbol declaration | Precise navigation instead of grep |
| Find References | `textDocument/references` | All call sites of a symbol | 23 real results vs 500+ grep matches |
| Hover | `textDocument/hover` | Type info and docs | Context without reading full code |
| Diagnostics | `textDocument/publishDiagnostics` | Real-time errors/warnings | Immediate error feedback after edits |
| Document Symbols | `textDocument/documentSymbol` | File structure outline | Understand file organization |
| Rename | `textDocument/rename` | Safe cross-file renaming | Refactoring precision |
| Code Actions | `textDocument/codeAction` | Quick fixes and refactors | Auto-fix suggestions |

### 5.3 Performance Comparison

| Operation | LSP | grep/find |
|-----------|-----|-----------|
| Find all references | ~50ms | 5-60s (recursive) |
| Go to definition | ~20ms | 30s+ (must find + validate) |
| Diagnostics | ~100ms | N/A (requires build) |
| Hover info | ~15ms | N/A |

### 5.4 Current AI Agent Integrations

**Claude Code (v2.0.74+, Dec 2025):**
- Plugin-based LSP system with marketplace
- Supports TypeScript (`@vtsls/language-server`), Java (JDTLS), Python, Go, Rust
- `/plugin marketplace add Piebald-AI/claude-code-lsps`
- Operations: `goToDefinition`, `findReferences`, `diagnostics`

**GitHub Copilot CLI:**
- Configuration via `~/.copilot/lsp-config.json` or `.github/lsp.json`
- Multiple language servers in one config
- `/lsp test <server>` for verification
- Same core operations

### 5.5 Why LSP Is a Game-Changer

1. **Precision over noise** — semantic references vs text grep
2. **Speed** — 50ms vs seconds for reference lookups
3. **Automatic error detection** — type errors caught immediately after every edit
4. **Semantic scope understanding** — local vs module-level variables
5. **Safe refactoring** — rename knows all occurrences

### 5.6 LSP Library Options for Pi

| Library | Description | Pros | Cons |
|---------|-------------|------|------|
| `vscode-languageserver-node` | Microsoft's official LSP client/server | Complete spec coverage, battle-tested | Heavy, VS Code dependency baggage |
| `ts-lsp-client` | Standalone LSP client, minimal deps | Lightweight, no VS Code deps | Fewer features, newer |
| Direct JSON-RPC via stdio | Raw protocol communication | Zero dependencies, full control | Manual implementation of all methods |

---

## 6. File System & Pattern Matching Tools

### 6.1 fast-glob (v3.3.3)

**NPM:** [fast-glob](https://www.npmjs.com/package/fast-glob) — 44M+ weekly downloads

**Key Capabilities:**
- Efficient glob matching for file discovery
- Supports patterns like `src/**/*.{ts,tsx}`
- Used by nearly every build tool

**Relevance to Pi-SmartEdit:**
- Multi-file edit targeting — discover files matching a pattern
- Scope editing operations to relevant file sets

### 6.2 replace-in-file (v8.4.0)

**NPM:** [replace-in-file](https://www.npmjs.com/package/replace-in-file) — 1,300+ dependents

**Key Capabilities:**
- Simple regex/string replacement across multiple files
- Dry-run mode, count matches, verbose output

**Relevance to Pi-SmartEdit:**
- Lightweight alternative to full codemod for simple replacements
- Multi-file operations with progress reporting

---

## 7. Cross-Cutting Patterns & Recommendations

### 7.1 The Smart-Edit Capability Maturity Model

Based on all research, here's where Pi-SmartEdit currently stands and what the next levels look like:

```
Level 1: Text-based edit (current)  ──  Level 3: AST-aware edit
  ✓ Exact match                         Add: tree-sitter validation
  ✓ Fuzzy match                         Add: scope detection
  ✓ Indentation normalize               Add: structural search
  ✓ Overlap detection                   Add: syntax validation

Level 2: Diff/Patch multi-format     ──  Level 4: LSP-enhanced edit
  Add: Unified diff support             Add: diagnostics feedback
  Add: Search/Replace blocks            Add: reference-aware editing
  Add: OpenAI patch format              Add: semantic rename
  Add: Rich error feedback              Add: completion-assisted edit
```

### 7.2 Recommended Architecture

```
Pi-SmartEdit Core (existing)
├── read-cache.ts        ✓ Stale-file detection
├── edit-diff.ts         ✓ Smart edit application
├── index.ts             ✓ Tool override + routing
├── conflict-detector.ts ✓ Overlap detection
├── ast-resolver.ts      ▲ Partial (web-tree-sitter dep exists)

Phase 3 Additions
├── formats/             New: Multi-format parser
│   ├── search-replace.ts   Parse <<< SEARCH / >>> REPLACE blocks
│   ├── unified-diff.ts     Parse standard diff format
│   └── openai-patch.ts     Parse *** Begin Patch format
├── lsp-lens/            New: LSP integration
│   ├── lsp-client.ts       LSP client management
│   ├── diagnostics.ts      Post-edit diagnostic checking
│   └── semantic-nav.ts     Go-to-def, find-refs, hover
├── ast/                 Enhanced: AST tools
│   ├── ast-grep.ts         @ast-grep/napi integration
│   ├── validator.ts        Post-edit syntax validation
│   └── scope.ts            Scope-aware edit anchoring
└── pipeline.ts          New: Multi-strategy edit pipeline
```

### 7.3 LSP Lens Integration Strategy

**What is an "LSP Lens"?**
An integrated view that sits alongside the edit tool and provides real-time semantic information about the code being edited — showing diagnostics, type information, reference counts, and definition locations.

**Implementation Approach:**

1. **Lazy LSP Server Pool** — Start language servers on-demand per file type
2. **Post-Edit Diagnostics Hook** — After every successful edit, query LSP diagnostics
3. **Reference-Aware Editing** — Before editing a symbol, use LSP to find all references
4. **Completion-Enhanced Edits** — Use LSP completion for generated code
5. **Definition Anchoring** — Use `textDocument/definition` to locate exact edit targets

**Node.js LSP Client (minimal approach):**

```typescript
import { spawn } from 'child_process';
import { createInterface } from 'readline';

class LSPClient {
  private process: ChildProcess;
  private messageId = 0;

  constructor(command: string, args: string[]) {
    this.process = spawn(command, args);
    // Communicate via stdin/stdout JSON-RPC
  }

  async initialize(rootUri: string) {
    return this.request('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {}
    });
  }

  async openDocument(uri: string, text: string) {
    return this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'typescript', version: 1, text }
    });
  }

  async getDiagnostics(uri: string, text: string) {
    // After didChange, server publishes diagnostics via notification
    await this.notify('textDocument/didChange', {
      textDocument: { uri, version: Date.now() },
      contentChanges: [{ text }]
    });
  }

  async findReferences(uri: string, line: number, character: number) {
    return this.request('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true }
    });
  }

  private async request(method: string, params: any) {
    const id = ++this.messageId;
    this.process.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id, method, params
    }) + '\r\n');
    // Read response from stdout
  }
}
```

### 7.4 Tool Discovery & Decision Tree

When Pi's edit tool is called, the pipeline should:

```
Receive edit instruction
│
├─ Is it a known format? ──→ Parse format → Apply edit
│   (search/replace, patch, diff)
│
├─ Is it simple text edit? ──→ Current edit-diff pipeline
│
├─ Is AST available? ──→ AST-validate first
│   (tree-sitter/ast-grep)    Check syntax after edit
│                             Suggest fixes if broken
│
└─ Is LSP available? ──→ LSP-enhanced edit
    (language server)        Check diagnostics after edit
                             Find references before rename
                             Provide type info in feedback
```

### 7.5 Key Dependencies to Add

| Package | Version | Why | Priority |
|---------|---------|-----|----------|
| `@ast-grep/napi` | ^0.42.1 | Structural search & replace | High |
| `magic-string` | ^0.30.21 | Source map aware string editing | Medium |
| `fast-glob` | ^3.3.3 | Multi-file discovery | Medium |
| `@types/diff` | ^7.0.0 | TypeScript types for existing diff dep | High |
| `ts-lsp-client` | ^1.1.1 | Minimal LSP client (or custom impl) | High |

### 7.6 Architecture Principles

1. **Lazy initialization** — Load language servers, parsers, and grammars only when needed for the file type
2. **Graceful degradation** — If AST/LSP unavailable, fall back to text-based edit
3. **Multi-format input** — Accept search/replace blocks, unified diffs, OpenAI patches, and JSON payloads
4. **Rich error feedback** — Always tell the agent what went wrong and what to fix
5. **Indentation first** — Preserve original formatting unless explicitly overridden
6. **Source maps** — Track original→modified positions for debugging

---

## 8. Sources & References

### Articles & Blog Posts
- [Code Surgery: How AI Assistants Make Precise Edits to Your Files](https://fabianhertwig.com/blog/coding-assistants-file-edits/) — Fabian Hertwig, Apr 2025
- [Give Your AI Coding Agent Eyes: How LSP Integrations Transform Coding Agents](https://tech-talk.the-experts.nl/give-your-ai-coding-agent-eyes-how-lsp-integration-transform-coding-agents-4ccae8444929) — Maik Kingma, Feb 2026
- [LSP: The Secret Weapon for AI Coding Tools](https://amirteymoori.com/lsp-language-server-protocol-ai-coding-tools/) — Amir Teymoori, Feb 2026
- [Using Coding Agents with Language Server Protocols on Large Codebases](https://medium.com/@dconsonni/using-coding-agents-with-language-server-protocols-on-large-codebases-24334bfff834) — Davide Consonni, Dec 2025
- [I Benchmarked 5 File Editing Strategies for AI Coding Agents](https://dev.to/ceaksan/i-benchmarked-5-file-editing-strategies-for-ai-coding-agents-heres-what-actually-works-1855) — Mar 2026

### GitHub Repositories
- [ast-grep/ast-grep](https://github.com/ast-grep/ast-grep) — 13.6k stars, structural search/rewrite
- [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) — 19.8k stars, incremental parsing
- [facebook/jscodeshift](https://github.com/facebook/jscodeshift) — Codemod toolkit
- [oxc-project/oxc](https://github.com/oxc-project/oxc) — Rust JS/TS toolchain
- [Rich-Harris/magic-string](https://github.com/Rich-Harris/magic-string) — String manipulation + sourcemaps
- [microsoft/vscode-languageserver-node](https://github.com/microsoft/vscode-languageserver-node) — Official LSP implementation
- [typescript-language-server/typescript-language-server](https://github.com/typescript-language-server/typescript-language-server) — TS LSP server

### npm Packages
- `@ast-grep/napi` v0.42.1
- `tree-sitter` v0.25.0
- `magic-string` v0.30.21
- `fast-glob` v3.3.3
- `replace-in-file` v8.4.0
- `oxc-parser` v0.127.0
- `ts-lsp-client` v1.1.1

### Official Documentation
- [ast-grep Core Concepts](https://ast-grep.github.io/advanced/core-concepts.html)
- [Tree-sitter Using Parsers](https://tree-sitter.github.io/tree-sitter/using-parsers/)
- [Oxc Parser Usage](https://oxc.rs/docs/guide/usage/parser.html)
- [jscodeshift Introduction](https://jscodeshift.com/overview/introduction)
- [OpenAI Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)
- [LSP Specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
