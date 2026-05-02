# Continuous Task State Management Protocol (CONTINUE.md)

**Purpose:** To maintain a deterministic, verifiable state of ongoing user tasks across sessions, superseding ambiguous historical summaries or automatic fallbacks. This protocol enforces that the agent operates from confirmed knowledge and explicit goals.

## 🔄 State Flow Model
The agent's operational cycle must adhere to this sequence:

1.  **Active Request Check:** Identify the current, most recent user intent. If no clear request exists, transition to `Dormant` state (monitoring/idle).
2.  **Context Integrity Check:** Inspect live repository state (`git diff --check`, modified files) and check internal session state against external reality.
3.  **Plan Validation Gate:** Before any mutation or major discovery, verify that the current plan is still valid:
    *   *Is the target file/symbol still present?* (Check `resolve_symbol`.)
    *   *Has the relevant code area changed since last read?* (Trigger Stale File Guard check).
4.  **Execution:** Proceed with the planned task (`in_progress`).
5.  **Validation Gate:** Upon completion, run all necessary verification checks (Tests $\rightarrow$ Lint $\rightarrow$ Build) before claiming `completed`.

## 🛑 Handling Ambiguity (Superseding Fallbacks)
When a previous session summary is unclear or incomplete:
*   **Do NOT assume continuity.** Treat the state as `Unknown` and revert to Step 1.
*   **Consult Live Evidence:** Use search tools (`intent_read`, `repo_map`) on the newest user messages and local file modifications (dirty state) *before* executing any plan or continuing a task.
*   **The Safe Default:** The default, safest operational mode is to pause, request clarification from the user, or perform light discovery, rather than proceeding with an unverified assumption.

## 📅 Milestone Tracking
All tasks must be managed via the `todo` tool (pending $\rightarrow$ in\_progress $\rightarrow$ completed). Any multi-step task that transitions from `in_progress` to a period of inactivity must explicitly log its last successful milestone and status update, preventing it from being erroneously restarted or abandoned.