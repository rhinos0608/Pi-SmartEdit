# Specification: Lightweight Approval Gating for SmartEdit

**Status:** Implemented  
**Date:** 2026-05-16  
**Author:** SmartEdit  
**Driven-by:** Codex's `AskForApproval` system (Never/OnFailure/OnRequest/UnlessTrusted/Granular) — a lightweight alternative for SmartEdit's scope.

---

## 1. Problem Statement

Codex has a comprehensive approval system backed by a 37k-line execution policy engine. SmartEdit operates in a narrower scope (file edits within a coding agent session) and needs a lighter mechanism to:

- Prompt the agent when edits touch sensitive locations (config files, entry points, infrastructure code)
- Warn about edits that modify dangerous symbols (`main()`, `init()`, constructors, `process.env`)
- Alert when edits span critical ranges (first N lines of entry point files)
- Do all of the above without introducing a full policy engine or blocking the edit

---

## 2. Approval Levels

Three levels, controlled by the environment variable `SMART_EDIT_APPROVAL_LEVEL`:

| Level | Env Value | Behavior |
|---|---|---|
| **never_prompt** | `"never_prompt"` | No approval checks run. Edits proceed without any safety prompts. |
| **prompt_on_dangerous** | `"prompt_on_dangerous"` | Only emits warnings when dangerous file paths, symbol patterns, or critical line ranges are detected. Safe edits produce no output. |
| **prompt_always** | `"prompt_always"` | Emits warnings for every edit. On safe edits, a generic "approval prompt" note is added. On dangerous edits, the specific warnings are included. |

Default: `never_prompt` (backward-compatible — existing users see no change).

---

## 3. Dangerous File Patterns (Glob-based)

Patterns matched against the edit target file path. Matching is case-sensitive and uses `**` for recursive wildcard, `*` for single-segment wildcard:

| Pattern | Rationale |
|---|---|
| `**/main.ts`, `**/main.js` | Application entry points — edits here affect process startup |
| `**/index.ts`, `**/index.js` | Module entry points — edits here affect public surface |
| `**/config*`, `**/*config*` | Configuration files — changes can break the app silently |
| `**/.env*`, `**/.env.*` | Environment files — may contain secrets or critical settings |
| `**/__init__*` | Python package init — affects module initialization |
| `**/Dockerfile*` | Container build configuration |
| `**/*.yaml`, `**/*.yml` | Deployment/config YAML files |
| `**/k8s/**`, `**/kubernetes/**` | Kubernetes manifests |
| `**/terraform/**`, `**/tf/**` | Infrastructure-as-code |
| `**/Dockerfile*` | Container config (duplicate, kept for clarity in spec) |
| `**/ci/**`, `**/.github/**`, `**/.gitlab-ci.yml` | CI/CD pipeline definitions |

Matching algorithm: simple glob-to-regex conversion supporting `**` (match across path separators) and `*` (match within a single path segment). Patterns are anchored to match the full file path.

---

## 4. Dangerous Edit Patterns (Regex-based)

Patterns matched against the `oldText` and `newText` content of each edit. Matching is case-sensitive and multiline:

| Pattern | RegExp | Rationale |
|---|---|---|
| `main()` function | `/function\s+main\s*\(/` | Modifying entry-point logic |
| `init()` function | `/function\s+init\s*\(/` | Modifying initialization logic |
| Constructor chains | `/constructor\s*\([^)]*\)\s*\{/` | Modifying object construction |
| `process.env` access | `/process\.env\b/` | Environment variable access — may change runtime behavior |
| `__init__` method | `/def\s+__init__\s*\(/` | Python class initialization |
| Privileged operations | `/require\(['"]child_process['"]\)/`, `/import\s+.*from\s+['"]child_process['"]/` | Process/command execution |
| File system write | `/fs\.writeFile\b/`, `/fs\.appendFile\b/`, `/fsPromises\.writeFile\b/` | Changes to file writing behavior |
| Network operations | `/\.listen\(/`, `/app\.(get\|post\|put\|delete\|patch\|use)\(/`, `/router\.(get\|post\|put\|delete\|patch\|use)\(/` | Route/networking changes |

The list is deliberately short and focused on the most common risk categories. Additional patterns can be added via `DANGEROUS_SYMBOL_PATTERNS` constant extension.

---

## 5. Warning-vs-Block Behavior

**Current stance: warnings only, never block.**

All safety checks emit warnings as `matchNotes` in the edit result. The edit proceeds to completion regardless of what the checks find.

Rationale:
- SmartEdit is a developer tool in a collaborative agent session — blocking would break flow
- The model (agent) sees the warnings and can adjust behavior
- Simple to implement and doesn't require a review-UI or confirmation dialog

Future consideration: add `prompt_on_dangerous_block` level that throws an error instead of a warning for dangerous edits, requiring the agent to call with `force: true` or adjust the edit.

---

## 6. Integration with Conflict Detector

The approval gating check operates **before** the edit is written to disk, in the same flow position as the conflict detector:

```
execute() flow:
  1. prepareArguments → validateInput
  2. read file → stale check
  3. range coverage check
  4. apply edits (hashline + legacy)
  5. conflict detection (onBeforeApply hook)     <── existing
  6. APPROVAL GATING CHECK (new)                 <── NEW
  7. atomicWrite
  8. post-edit validation (AST, LSP, evidence)
```

The approval gating check does NOT depend on conflict detection results — it runs independently and its warnings are merged into the same `matchNotes[]` array.

---

## 7. API Design

### `src/safety/approval-gating.ts`

```typescript
export interface ApprovalConfig {
  level: 'never_prompt' | 'prompt_on_dangerous' | 'prompt_always';
  dangerousPathPatterns: string[];
  dangerousSymbolPatterns: RegExp[];
  criticalLineRange: number;  // first N lines considered critical
}

export interface SafetyCheckResult {
  safe: boolean;
  warnings: string[];
  level: string;
}

// Check edit safety for a given file path and edit items
export function checkEditSafety(
  filePath: string,
  edits: EditItem[],
  config?: Partial<ApprovalConfig>,
): SafetyCheckResult;
```

### Environment variable

```
SMART_EDIT_APPROVAL_LEVEL=never_prompt|prompt_on_dangerous|prompt_always
```

Read via `process.env` directly in the module (following the same pattern as `SMART_EDIT_USE_HASHLINE_EDITING` in `src/edit-mode.ts`).

---

## 8. Edge Cases

| Case | Behavior |
|---|---|
| `SMART_EDIT_APPROVAL_LEVEL` unset or invalid | Default to `never_prompt` (no change in behavior) |
| Empty edits array | No symbol checks possible; file path check still runs |
| File path doesn't exist yet (new file) | Path check runs on the target path before creation |
| Multiple edits, some dangerous | All warnings for all dangerous edits are collected and emitted together |
| Both path + edit warnings | Both types of warnings are combined in the same `warnings[]` array |
| Same pattern matches multiple edits | Warnings are deduplicated to avoid noise |
| Unicode/modified file paths | Path patterns match the path string directly without normalization |

---

## 9. Open Questions / Future Work

1. **Should `prompt_always` also warn about non-edit operations?** Unlikely — SmartEdit only handles edits.
2. **Should there be a `force` flag to suppress warnings?** Possible future addition but adds scope creep now.
3. **Should warnings be surfaced differently (not just matchNotes)?** Could add a `details.safetyWarnings` field in the future for structured access.
4. **Should blocking behavior be added?** See §5. Easy to add if needed (throw instead of push warning).
5. **Should the pattern lists be configurable?** Could extend `ApprovalConfig` to accept project-specific patterns, but static defaults are sufficient for v1.
