/**
 * Post-mutation diagnostic surfacing for SmartEdit.
 *
 * SmartEdit owns post-mutation diagnostics for its `edit` tool and the native
 * `write` tool. This module provides the bounded, model-actionable helpers
 * used to append diagnostics to a tool result's `content` and `details`.
 *
 * Collection itself (LSP/compiler) is injected so tests can supply canned
 * diagnostics deterministically without spawning tsc/eslint/LSP servers.
 */

/** Max diagnostics lines surfaced in tool-result content. */
export const MAX_CONTENT_DIAGNOSTICS = 12;

/**
 * Build a bounded, model-actionable text block from diagnostic strings.
 * Returns "" when there is nothing to show.
 */
export function formatBoundedDiagnostics(
  diagnostics: readonly string[],
  max: number = MAX_CONTENT_DIAGNOSTICS,
): string {
  if (!diagnostics || diagnostics.length === 0) return "";
  const shown = diagnostics.slice(0, max);
  const lines = shown.map((d) => `  • ${d}`);
  if (diagnostics.length > max) {
    lines.push(`  ... and ${diagnostics.length - max} more diagnostic(s)`);
  }
  return ["", "Post-edit diagnostics:", ...lines].join("\n");
}

/**
 * Append a diagnostics text block to a tool result's content. Returns a new
 * result object; the original is not mutated.
 */
export function appendDiagnosticsToContent(
  content: Array<{ type: string; text?: unknown }>,
  block: string,
): Array<{ type: string; text?: unknown }> {
  if (!block) return content;
  const next = Array.isArray(content) ? [...content] : [];
  const textIdx = next.findIndex((c) => c.type === "text");
  if (textIdx >= 0) {
    next[textIdx] = { ...next[textIdx], text: `${coerceText(next[textIdx].text)}${block}` };
  } else {
    next.push({ type: "text", text: block });
  }
  return next;
}

function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object Object]";
    }
  }
  if (typeof value === "function") return value.name || "[Function]";
  if (typeof value === "symbol") return value.toString();
  return (value as symbol).toString();
}
