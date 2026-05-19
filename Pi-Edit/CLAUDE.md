# Smart Edit Extension: Production-Grade Code Mutation Engine

**Version:** v3.0 (Full Feature Set)
**Description:** The smart-edit extension overrides the standard Pi `edit` tool, transforming simple text replacement into a context-aware, highly resilient code mutation pipeline with multi-format input, symbolic editing, approval gating, undo, verification, and streaming patch support.

## ⚙️ Core Philosophy: Safety over Simplicity
The extension's primary goal is **deterministic correctness**. An edit should only proceed if its target state can be validated against the source file snapshot taken during the current session. This is achieved through a layered, fail-safe pipeline.

## 🔬 The Layered Edit Pipeline (Priority Order)

All edits must pass two initial safety checks before proceeding:
1.  **Stale File Guard (`read-cache.ts`):** Compares file metadata (mtime, size, hash). If the file has changed since the last session read, the edit is blocked, and an actionable error with current context is provided.
2.  **Range Coverage Guard:** Ensures that every line targeted by `oldText` actually exists within a section of the file that was explicitly loaded in the current session (preventing edits to unseen code).
3.  **Approval Gating (`approval-gating.ts`):** Path/symbol/line-range safety checks before edits proceed (configurable: never_prompt, prompt_on_dangerous, prompt_always).

If the guards pass, one of these matching strategies attempts the replacement:

###  Tier 1: Symbolic Editing (`symbolic-edits.ts`)
*   **Mechanism:** Direct AST-level operations — replaceBody, insertBefore, insertAfter — that target named symbols without requiring oldText matching.
*   **Benefit:** Most precise form of editing; bypasses text matching entirely.

###  Tier 2: AST Scoping (`ast-resolver.ts`)
*   **Mechanism:** The search for `oldText` is confined to the byte range of the target symbol (e.g., inside a specific function body), using Tree-sitter AST symbols (name and kind).
*   **Benefit:** Provides contextual disambiguation, preventing false positives when identical variable names exist across different scopes.

###  Tier 3: 6-Tier Text Matching (`edit-diff.ts`)
*   **Mechanism:** The extended pipeline (Exact → Indentation → Unicode → Similarity → Dotdotdots Ellipsis → Relative Indent). This is the final fallback for ambiguous cases.
*   **Limitation:** Inherently susceptible to minor text drift.

###  Tier 4: Hashline Editing (`hashline.ts`, `hashline-edit.ts`)
*   **Mechanism:** Zero-text freshness-checked edits via line content hashes (opt-in). The model references `LINE+ID` anchors instead of raw text.
*   **Benefit:** Eliminates whitespace/formatting drift issues entirely.

##  Multi-Format Input

Smart Edit auto-detects and parses multiple input formats:

- **JSON edits** — standard Pi edit array (with forgiving JSON repair)
- **Search/replace blocks** — `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE`
- **Unified diff** — standard `@@` hunk format
- **OpenAI patch** — `*** Begin Patch` / `*** End Patch` envelope
- **Codex apply_patch** — full grammar parser with `Add File`, `Delete File`, `Update File`, `Move to`

##  Key Engineering Artifacts

*   **Atomic Writes (`src/undo/atomic-write.ts`):** All mutations via temp file + rename. Transactional safety equivalent to database commits.
*   **Undo System (`src/undo/edit-history.ts`):** Pre-edit state captured to `.smart-edit-undo/` as base64 JSON. Fire-and-forget, never blocks the edit hot path.
*   **Conflict Detection (`lib/conflict-detector.ts`):** AST-level semantic conflict tracking across edit calls — same-symbol, contains, contained-by, sibling-overlap relationships.
*   **Post-Edit Evidence Pipeline (`src/verification/`):** Concurrency signal detection, test traceability analysis, git history context retrieval, scoped diagnostics.
*   **Auto-Validation (`src/verification/auto-validate.ts`):** Retry-aware structural validation with incrementing retry counts per file.
*   **Streaming Patch Parser (`src/formats/streaming-patch-parser.ts`):** Progressive parse with progress callbacks for large multi-hunk patches.
*   **Context Markers (`src/formats/context-markers.ts`):** XML-style tags around injected semantic context for attribution and filtering.
*   **SmartRead Bridge (`src/smartread-bridge.ts`):** Records breakage and co-change events for cross-extension learning.
*   **Actionable Diagnostics:** Errors contain file path, line range, similarity score, and hints/corrected anchors for LLM self-correction.

## Usage Guidelines
Always leverage `semantic_context` before making edits on unfamiliar types/symbols. Use symbolic edits (replaceBody/insertBefore/insertAfter) when targeting known symbols for maximum precision.