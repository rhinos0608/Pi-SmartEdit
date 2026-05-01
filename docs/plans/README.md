# Smart Edit — Phase 3+ Implementation Tracking

> **Last Updated:** 2026-04-28
> **Current Status:** Research items identified, structured plans created
> **Overall Progress:** 0% (planned)

---

## Implementation Plan Overview

Four structured implementation plans derived from research documents, codebase analysis, and review findings.

| Plan | Title | Priority | Est. | Depends On | Status |
|------|-------|----------|------|------------|--------|
| 1 | AST-Enhancement Fixes & Integration | P0 | 3–5d | Phase 2 codebase | 📋 Documented |
| 2 | Multi-Format Input Parsing | P0 | 4–5d | Nothing (parallel) | 📋 Documented |
| 3 | LSP Lens Integration | P1 | 5–7d | Plans 1, 2 | 📋 Documented |
| 4 | Edit Pipeline & Completion | P2 | 3–4d | Plans 1–3 | ⏳ Not started |

---

## Plan 1: AST-Enhancement Fixes & Integration

**File:** `docs/plans/2026-04-28-smartedit-plan-1-ast-enhancement-fixes.md`

### Work Items
1. Fix `onResolveAnchor` missing from `ApplyEditsOptions` — make `applyEdits` async
2. Stop stripping `anchor`/`lineRange` in `prepareArguments`
3. Surface conflict detector warnings in edit result
4. Add post-edit syntax validation via tree-sitter
5. Write 15 new tests for AST integration path

### Current Codebase State
- ✅ `grammar-loader.ts` — correct `@tree-sitter-grammars/*` scope, lazy init
- ✅ `ast-resolver.ts` — all functions (parseFile, findSymbolNode, findEnclosingSymbols, disposeParseResult)
- ✅ `conflict-detector.ts` — fully built with AST + line-range fallback
- ✅ `package.json` — `web-tree-sitter@^0.22.6` (correct version from FIX-1)
- ❌ `edit-diff.ts` — `ApplyEditsOptions` missing `onResolveAnchor` field
- ❌ `index.ts` — strips anchor/lineRange; conflict warnings not surfaced

---

## Plan 2: Multi-Format Input Parsing

**File:** `docs/plans/2026-04-28-smartedit-plan-2-multi-format-input.md`

### Work Items
1. `format-detector.ts` — auto-detect input format
2. `search-replace.ts` — Aider/Cline/RooCode SEARCH/REPLACE format parser
3. `unified-diff.ts` — standard diff format parser (uses existing `diff` dep)
4. `openai-patch.ts` — Codex CLI patch format parser
5. `pipeline.ts` — orchestrator that routes format → parser → `applyEdits`
6. Wire into `index.ts` as pre-processing step
7. 22+ unit tests + 4 integration tests

### Key Decision
Convert all formats to `EditItem[]` (oldText/newText) at pipeline boundary. Existing `applyEdits()` handles matching, indentation, overlap detection unchanged.

---

## Plan 3: LSP Lens Integration

**File:** `docs/plans/2026-04-28-smartedit-plan-3-lsp-lens-integration.md`

### Work Items
1. `lsp-connection.ts` — Zero-dep JSON-RPC over stdio with 5s timeout
2. `lsp-manager.ts` — Lazy server lifecycle (init → cache → shutdown)
3. `diagnostics.ts` — Post-edit diagnostic hook, non-blocking
4. `semantic-nav.ts` — Go-to-def, find-refs, hover
5. Wire into `index.ts` session lifecycle and post-edit hook
6. Mock LSP server for testing
7. 16+ unit tests + 3+ integration tests

### Key Decisions
- Zero dependencies — raw JSON-RPC over stdio
- Advisory, non-blocking diagnostics (warnings, not errors)
- PATH-based server discovery + optional config override
- 5s timeout prevents LSP latency from blocking edits

---

## Dependencies by Component

```
Plan 1 (AST Fixes) ──────────────┐
                                 ├──→ Plan 4 (Pipeline & Polish)
Plan 2 (Multi-Format Input) ─────┤
                                 │
Plan 3 (LSP Lens) ──────────────┘
```

Plans 1 and 2 can be implemented in **parallel**. Plan 3 depends on Plan 1 (for AST integration patterns). Plan 4 (pipeline) depends on all three.

---

## Total Test Target

| Component | Existing | New | Total |
|-----------|----------|-----|-------|
| `edit-diff` | ~24 | +5 | ~29 |
| `ast-resolver` | ~9 | +5 | ~14 |
| `conflict-detector` | ~12 | +0 | ~12 |
| `error-handling` | ~23 | +0 | ~23 |
| `read-cache` | ~7 | +0 | ~7 |
| `format-detector` | — | +4 | ~4 |
| `search-replace` | — | +8 | ~8 |
| `unified-diff` | — | +8 | ~8 |
| `openai-patch` | — | +6 | ~6 |
| `lsp-connection` | — | +6 | ~6 |
| `lsp-manager` | — | +6 | ~6 |
| `diagnostics` | — | +6 | ~6 |
| `semantic-nav` | — | +4 | ~4 |
| Integration tests | — | +10 | ~10 |
| **Total** | **75** | **+68** | **~143** |

---

## Research Items Used

This implementation plan incorporates findings from:

| Doc | Key Insights Used |
|-----|-------------------|
| `research.md` (12 findings) | FIX-1 through FIX-12 — version fixes, grammar scope, WASM loading, circular deps, ERROR nodes, tree lifecycle, ±5 expansion, symbolLine, BOM/line-ending |
| `REVIEW-FINDINGS.md` | Full finding analysis |
| `REVIEW-ACTION-ITEMS.md` | Prioritized action items from Critical → Important → Minor |
| `FEATURE-AST-TARGETING.md` | Original anchor + symbol design (corrected by FIX-8) |
| `FEATURE-CONFLICT-DETECTION.md` | Conflict detection design (corrected by FIX-4) |
| `FEATURE-LINE-RANGE.md` | Line-range targeting design (corrected by FIX-7) |
| `2026-04-28-ast-lsp-editing-research.md` | Research into ast-grep, tree-sitter, LSP, industry patterns |
| `2026-04-28-smartedit-phase3-plan.md` | Phase 3 vision: multi-format input, LSP lens, AST-enhanced editing |

---

## Quick Start

```bash
# Run existing tests to verify baseline
cd /Users/rhinesharar/Pi-SmartEdit
npx tsx --test test/*.test.ts

# When implementing:
# Plan 1: edit lib/edit-diff.ts + index.ts + lib/ast-resolver.ts
# Plan 2: add src/formats/*.ts + src/pipeline.ts
# Plan 3: add src/lsp/*.ts
