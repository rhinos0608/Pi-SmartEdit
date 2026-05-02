# Agent Operational Guide (AGENTS.md)

**Purpose:** Defines the durable operating procedures and constraints that govern how Pi agents interact with the codebase to ensure maximum correctness and adherence to engineering best practices. This guide serves as a set of high-level, non-negotiable rules for complex tasks.

## 🛡️ Core Operational Mandates
1.  **Verify First:** No file mutation (`edit`, `write`) is permitted until both the **Stale File Guard** and the **Range Coverage Guard** have been satisfied for that specific file/range in the current session context.
2.  **Prefer Contextual Search:** Before reading entire files, leverage specialized tools like `semantic_context` to retrieve type definitions, interfaces, and references scoped to a small region of interest. This minimizes token usage and maximizes focus.
3.  **Prioritize Precision Over Speed:** For any code modification, the agent must prioritize: **Hashline Match $\rightarrow$ AST Scoping $\rightarrow$ Text Match**. Only fall through tiers if higher precision methods fail. Never blindly rely on a full-text search result.
4.  **Handle Failure as Information:** An error is not just an interruption; it is a data point. When mutation fails, the agent must analyze the actionable error message (which includes context/corrected anchors) to inform its next action (e.g., retry with corrected parameters, or escalate).

## 🗂️ Durable Tool Usage Rules
*   **`edit` Tool:** Use only when high confidence is established via Tiers 1 or 2 of the matching pipeline. If the system detects low coverage or a stale file, *do not proceed*.
*   **`todo` Management:** All complex work must be managed by creating a `pending` task. Agents must transition tasks through status changes (`in_progress`, `completed`) to provide an auditable trail of progress and state at any given time.
*   **Tool Chaining/Subagents:** For large, multi-phase operations (e.g., Feature $\rightarrow$ Test $\rightarrow$ Document), always use a chain or subagent delegation (`pi-subagents`). This isolates context and prevents the main session from becoming overloaded.

## ⚖️ Conflict Resolution
When faced with conflicting requirements or architectural decisions:
1.  **Consult Existing Code:** Treat the current codebase as the ultimate source of truth. Do not invent patterns that contradict existing style or structure unless explicitly instructed to refactor/update.
2.  **Audit `AGENTS.md` and `CLAUDE.md`:** When uncertain about a durable rule, consult these project guides before making decisions.

These guidelines are designed to promote robust, predictable, and maintainable agent behavior in production environments.