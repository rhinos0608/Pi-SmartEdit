# pi-lens Research: Pattern Analysis & Integration Opportunities

**Date**: 2026-05-02  
**Repository**: [apmantza/pi-lens](https://github.com/apmantza/pi-lens)  
**Focus**: Real-time code feedback for AI agents — LSP, linters, formatters, type-checking, structural analysis

---

## 1. Architecture Overview

pi-lens is a pi extension that runs a **6-phase pipeline** on every file write/edit:

```
1. Secrets scan (blocking)
2. Auto-format (26 language-specific formatters)
3. Auto-fix (Biome, Ruff, ESLint, etc.)
4. LSP file sync
5. Dispatch lint (type errors, security rules)
6. Cascade diagnostics (impact analysis)
```

**Key architectural decisions:**
- Phases are **independently toggleable** via flags (`--no-lsp`, `--no-autoformat`, etc.)
- Each phase has **timing instrumentation** via `PhaseTracker`
- LSP lifecycle managed with **240s idle timeout**
- State coordination via `RuntimeCoordinator` (session → turn → tool result)

---

## 2. High-Value Patterns for smart-edit

### 2.1 Pipeline Architecture (`pipeline.ts`)

**Pattern**: Sequential phases with clear separation of concerns and timing.

```typescript
// Phase tracker for instrumentation
interface PhaseTracker {
  start(name: string): void;
  end(name: string, metadata?: Record<string, unknown>): void;
}

// Each phase: secrets → format → fix → lsp → dispatch → cascade
async function runPipeline(ctx: PipelineContext, deps: PipelineDeps): Promise<PipelineResult>
```

**Integration opportunity**: smart-edit's hashline editing could adopt a similar phased approach:
- Phase 1: Stale file check (read-cache validation)
- Phase 2: Hashline matching (tier 1: exact → tier 2: rebase → tier 3: scoped fuzzy → tier 4: full-file fuzzy)
- Phase 3: AST conflict detection
- Phase 4: Post-edit validation (LSP diagnostics)

**Why it fits**: smart-edit already has a 4-tier matching pipeline (`edit-diff.ts:findText`). Wrapping it in a pipeline with timing/telemetry (like pi-lens) would improve observability.

---

### 2.2 Read-Before-Edit Guard (`read-guard.ts`)

**Pattern**: Three-layer guard that blocks edits without adequate prior reading:

1. **Zero-read block**: Never read this file in current session
2. **File-modified block**: File changed on disk since last read (mtime/size check)
3. **Out-of-range block**: Edit target lines not covered by previous reads

**Key features**:
- **Symbol-level coverage**: If agent read lines 50-60 (within a function), and that function is actually lines 45-70, the guard expands coverage to the enclosing symbol via tree-sitter
- **Configurable mode**: `block` (default), `warn`, `off`
- **Pattern exemptions**: `*.md`, `*.txt`, `*.log` auto-allowed
- **One-time exemptions**: `/lens-allow-edit <path>` command

**Integration opportunity**: smart-edit's `read-cache.ts` already tracks file snapshots (mtime+size+hash). Could add:
- Read-before-edit enforcement: block hashline edits to files not in read-cache
- Symbol expansion: use smart-edit's existing tree-sitter integration to expand read ranges to enclosing symbols
- This would prevent "blind edits" where the agent's mental model is stale

**Relevant smart-edit files**:
- `read-cache.ts` — already has `checkStale()` with APFS retry
- `ast-resolver.ts` — tree-sitter symbol resolution (could reuse for symbol expansion)

---

### 2.3 Declarative Tool Dispatcher (`dispatcher.ts`)

**Pattern**: Runner registry with priority-based selection and group execution:

```typescript
class RunnerRegistry {
  private runners = new Map<string, RunnerDefinition>();
  
  register(runner: RunnerDefinition): void;
  getForKind(kind: FileKind, filePath?: string): RunnerDefinition[];
}

interface RunnerDefinition {
  id: string;
  appliesTo: FileKind[];
  priority: number;
  skipTestFiles?: boolean;
  when?: (ctx: DispatchContext) => Promise<boolean>;
  run: (ctx: DispatchContext) => Promise<RunnerResult>;
}
```

**Key features**:
- **Delta mode**: Only show NEW issues (baseline tracking across turns)
- **Inline suppressions**: `// pi-lens-ignore: rule-id` syntax
- **LSP overlap suppression**: LSP diagnostics take precedence over lint tools at same span
- **Deduplication**: Remove overlapping diagnostics from multiple tools
- **Unused promotion**: Unused variable warnings promoted to blockers

**Integration opportunity**: smart-edit's conflict detection (`conflict-detector.ts`) could adopt:
- Declarative rule definitions instead of hardcoded checks
- Delta mode for hashline edits: only report NEW conflicts since last edit
- Inline suppressions for hashline edits: `// smart-edit-ignore: conflict-type`

---

### 2.4 LSP Integration (`lsp/`)

**Pattern**: 37 language server definitions with:
- **Auto-discovery**: From PATH, `node_modules`, managed installs
- **Idle management**: 240s timeout to free resources (resets on edit resume)
- **Warm files**: Pre-load entry-point files for lazy-indexing servers (e.g., clangd)
- **File sync modes**: `preserveDiagnostics: true` for format-only resyncs

**Key files**:
- `lsp/index.ts` — LSP service singleton
- `lsp/server.ts` — Language server lifecycle
- `lsp/config.ts` — Auto-discover server configs
- `lsp/interactive-install.ts` — Prompt user to install missing servers

**Integration opportunity**: smart-edit's LSP integration is minimal (only used for post-edit diagnostics). Could expand to:
- Pre-edit LSP sync: ensure file is open in LSP before applying hashline edit
- Post-edit diagnostics: run LSP to catch type errors from the edit
- Warm files: pre-load symbols for files the agent is likely to edit

**Relevant smart-edit files**:
- `index.ts` — already has `postEditValidation` with LSP check, but it's limited

---

### 2.5 Auto-Format/Fix Tools (`format-service.ts`, `pipeline.ts`)

**Pattern**: Policy-based tool selection with config-gated detection:

```typescript
function getAutofixPolicyForFile(
  filePath: string, 
  context: { hasBiomeConfig: boolean; /* etc. */ }
): { defaultTool: string; safe: boolean; gate: string } | undefined;

function getPreferredAutofixTools(filePath: string, context): string[];
```

**Tool selection rules**:
- **Config-gated**: Only runs when project config indicates usage (e.g., `biome.json`)
- **Nearest-wins**: Multiple configs at different levels → closest wins
- **Language-defaults**: Biome for JS/TS without config, Ruff for Python without Black

**Integration opportunity**: smart-edit could:
- Auto-format after hashline edits (ensure consistent style)
- Use policy-based selection to avoid forcing formatters on projects that don't use them
- This aligns with smart-edit's goal of being "invisible" unless there's a problem

---

### 2.6 Runtime Coordination (`runtime-coordinator.ts`, etc.)

**Pattern**: Three-tier state management:
- **Session**: Reset state, detect project root, warm caches
- **Turn**: Summarize findings, persist state for next turn
- **Tool result**: Handle pipeline, update diagnostics

**Key insight**: pi-lens injects findings into the **next turn's context** (not the current one) to avoid mid-refactor noise:

```typescript
// context event — fires before each provider request
pi.on("context", async (event, ctx) => {
  const turnEndFindings = consumeTurnEndFindings(cacheManager, cwd);
  return {
    messages: [...existingMessages, ...turnEndFindings.messages],
  };
});
```

**Integration opportunity**: smart-edit's mutation queue could adopt this pattern:
- Defer conflict reports to next turn (avoid disrupting current edit flow)
- Persist hashline anchor state across turns (for delta mode)
- Inject read-cache validation into next turn context

---

### 2.7 Diagnostics & Telemetry

**Pattern**: Structured diagnostics with taxonomy:

```typescript
interface Diagnostic {
  id: string;
  tool: string;
  rule?: string;
  filePath: string;
  line?: number;
  column?: number;
  message: string;
  severity: "error" | "warning" | "info";
  semantic: "blocking" | "warning" | "fixed" | "silent";
  defectClass?: string;
  fixable?: boolean;
  fixSuggestion?: string;
}
```

**Key features**:
- **Semantic classification**: blocking (stop), warning (inform), fixed (auto-resolved), silent (suppress)
- **Latency tracking**: Per-runner timing with slow-runner detection
- **Health dashboard**: `/lens-health` command shows crash counts, slow runners, repeat offenders

**Integration opportunity**: smart-edit could add:
- Structured output for hashline edit results (not just "success/failure")
- Telemetry on which tier succeeded (tier 1 exact vs tier 4 full-file fuzzy)
- Health report for hashline anchors (stale anchors, collision rate)

---

## 3. Patterns NOT Relevant to smart-edit

| Pattern | Why Not Relevant |
|---------|-------------------|
| Secrets scan (blocking) | smart-edit is about editing, not credential scanning |  
| Test runner integration | Out of scope for editing tool |
| Cascade diagnostics | Complex dependency graph analysis — not needed for single-file edits |
| 26 formatters | smart-edit assumes project has formatter config; no need to bundle 26 |
| GitHub release binary downloads | pi-lens auto-installs tools; smart-edit can assume tools pre-installed |
| Slash commands (`/lens-booboo`, etc.) | smart-edit is a tool replacement, not a full extension with commands |

---

## 4. Recommended Integrations

### 4.1 High Priority (Direct Fit)

**A. Read-Before-Edit Guard**
- File: `read-cache.ts` + new `read-guard.ts`
- Block hashline edits to files not in read-cache
- Use `ast-resolver.ts` for symbol-level coverage expansion
- **Effort**: Medium | **Impact**: High (prevents stale edits)

**B. Pipeline Timing/Telemetry**
- File: `edit-diff.ts`, `index.ts`
- Wrap 4-tier matching in `PhaseTracker`-like instrumentation
- Track which tier succeeds for each edit
- **Effort**: Low | **Impact**: Medium (observability)

**C. Post-Edit LSP Diagnostics**
- File: `index.ts` (postEditValidation already exists)
- Expand to run LSP diagnostics after EVERY hashline edit (not just "on" mode)
- Use pi-lens pattern: `preserveDiagnostics: true` for format-only resyncs
- **Effort**: Medium | **Impact**: High (catch type errors early)

### 4.2 Medium Priority (Architectural Alignment)

**D. Declarative Conflict Rules**
- File: `conflict-detector.ts`
- Convert hardcoded checks to `RunnerDefinition`-like rule objects
- Add delta mode: only report NEW conflicts since last edit
- **Effort**: High | **Impact**: Medium (maintainability)

**E. Runtime Coordination (Turn Injection)**
- File: `index.ts`
- Defer conflict reports to next turn context
- Persist hashline anchor state across turns
- **Effort**: Medium | **Impact**: Medium (smoother agent flow)

### 4.3 Low Priority (Nice to Have)

**F. Inline Suppressions**
- Syntax: `// smart-edit-ignore: anchor-collision`
- Apply to hashline edits and conflict reports
- **Effort**: Low | **Impact**: Low (edge case handling)

**G. Auto-Format After Edit**
- File: `format-service.ts` (new) or reuse pi-lens `formatters.ts`
- Policy-based: only format if project has config
- **Effort**: High | **Impact**: Low (style preference)

---

## 5. Code References (pi-lens)

| Feature | File | Key Lines |  
|---------|------|-----------|
| Pipeline phases | `clients/pipeline.ts` | 630-750 (runPipeline) |
| Read guard checks | `clients/read-guard.ts` | 188-280 (checkEdit) |
| Symbol expansion | `clients/read-expansion.ts` | 45-120 (tryExpandRead) |
| Runner registry | `clients/dispatch/dispatcher.ts` | 50-90 (RunnerRegistry) |
| Delta mode | `clients/dispatch/dispatcher.ts` | 300-340 (filterDelta) |
| LSP warm files | `clients/lsp/config.ts` | 120-160 (warmFiles) |
| Diagnostics taxonomy | `clients/dispatch/diagnostic-taxonomy.ts` | 1-50 (classifyDiagnostic) |
| Phase timing | `clients/pipeline.ts` | 530-560 (PhaseTracker) |
| Turn context injection | `index.ts` (pi-lens) | 1150-1180 (context event) |

---

## 6. Quick Start Integration Path

If we want to start with **one high-impact pattern**, I recommend:

**Option A: Read-Before-Edit Guard (Simplest High-Value)**
1. Add `checkEdit(filePath, touchedLines)` to `read-cache.ts`
2. Call it from `index.ts:prepareArguments` before applying hashline edit
3. Return block reason if file not in read-cache or is stale
4. **Time**: ~2 hours | **Risk**: Low

**Option B: Pipeline Telemetry (Easiest Quick Win)**
1. Add `PhaseTracker` to `edit-diff.ts`
2. Time each tier: exact → indent → unicode → similarity
3. Log which tier succeeded for each edit
4. **Time**: ~1 hour | **Risk**: Very Low

**Option C: Post-Edit LSP (Most User-Facing)**
1. Expand `postEditValidation` in `index.ts`
2. Always run LSP diagnostics after hashline edit (not just "on" mode)
3. Surface type errors as structured diagnostics
4. **Time**: ~3 hours | **Risk**: Medium (LSP overhead)

---

## 7. Summary

pi-lens has **8 high-value patterns**, of which **3 are directly applicable** to smart-edit:
1. ✅ Read-Before-Edit Guard (maps to `read-cache.ts` + `ast-resolver.ts`)
2. ✅ Pipeline Telemetry (maps to `edit-diff.ts` 4-tier matching)
3. ✅ Post-Edit LSP (extends existing `postEditValidation`)

The other patterns are either:
- Out of scope (secrets, test runners, cascade diagnostics)
- Already partially implemented (LSP integration)
- Nice-to-have but not critical (formatters, slash commands)

**Next step**: Pick one integration from Section 6 and implement it.
