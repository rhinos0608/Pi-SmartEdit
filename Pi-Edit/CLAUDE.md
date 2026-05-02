# Smart Edit Extension: Production-Grade Code Mutation Engine

**Version:** v2.1 (Resilience Architecture Implemented)
**Description:** The smart-edit extension overrides the standard Pi `edit` tool, transforming simple text replacement into a context-aware, highly resilient code mutation pipeline. It is designed to handle real-world codebase drift, semantic complexity, and LLM non-determinism with superior safety and precision.

## ⚙️ Core Philosophy: Safety over Simplicity
The extension's primary goal is **deterministic correctness**. An edit should only proceed if its target state can be validated against the source file snapshot taken during the current session. This is achieved through a layered, fail-safe pipeline.

## 🔬 The Layered Edit Pipeline (Priority Order)

All edits must pass two initial safety checks before proceeding:
1.  **Stale File Guard (`read-cache.ts`):** Compares file metadata (mtime, size, hash). If the file has changed since the last session read, the edit is blocked, and an actionable error with current context is provided.
2.  **Range Coverage Guard:** Ensures that every line targeted by `oldText` actually exists within a section of the file that was explicitly loaded in the current session (preventing edits to unseen code).

If the guards pass, one of these four matching strategies attempts the replacement:

###  Tier 1: Hashline Anchored Edit (`hashline.ts`, `hashline-edit.ts`)
*   **Mechanism:** Edits target specific line hashes (`LINE+HASH` e.g., `'42ab'`) rather than reproducing surrounding text.
*   **Benefit:** Zero-text reproduction, extremely fast matching ($\mu$s/line), and immediate freshness verification via the anchor itself. This is the preferred path for stability.

###  Tier 2: AST Scoping Fallback (`ast-resolver.ts`)
*   **Mechanism:** If `hashline` fails or is unavailable, the system attempts to scope the search using Tree-sitter AST symbols (name and kind). The search for `oldText` is confined to the byte range of the target symbol (e.g., inside a specific function body).
*   **Benefit:** Provides contextual disambiguation, preventing false positives when identical variable names exist across different scopes.

###  Tier 3: Standard Text Matching (`edit-diff.ts`)
*   **Mechanism:** The classic 4-tier pipeline (Exact $\rightarrow$ Indentation $\rightarrow$ Unicode $\rightarrow$ Similarity). This is the final fallback for ambiguous cases that survive the higher tiers.
*   **Limitation:** Inherently susceptible to minor text drift, which is why Tiers 1 and 2 exist.

##  Key Engineering Artifacts

*   **Atomic Writes (`index.ts`):** All mutations are performed via a temp file + rename operation. This ensures the file is never left in a partially written state, providing transactional safety equivalent to database commits.
*   **Conflict Detection (`conflict-detector.ts`):** Utilizes AST parsing to track semantic conflicts between multiple proposed edits within a single call, preventing logically inconsistent code changes.
*   **Actionable Diagnostics:** Errors are not vague. They contain the file path, line range, similarity score (where applicable), and crucially, hints or corrected anchors to facilitate immediate self-correction by the LLM.

## Usage Guidelines
Always leverage `semantic_context` before making edits on unfamiliar types/symbols. Use `hashline`-anchored inputs for maximum reliability when available.