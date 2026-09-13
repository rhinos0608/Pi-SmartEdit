import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui";

import { normalizeRawEdit } from "../formats/edit-intents.js";
import type { PatchToolDetails } from "../patch.js";

export type EditRenderArgs = {
  path?: unknown;
  edits?: unknown;
  raw?: unknown;
};

export type EditRenderResult = {
  content: Array<{ type: string; text?: string }>;
  details?: PatchToolDetails;
};

export class EditTextComponent implements Component {
  constructor(private readonly text: string, private readonly paddingX = 0) {}

  render(width: number): string[] {
    const padding = " ".repeat(this.paddingX);
    return this.text.split("\n").map((line) => {
      const renderedLine = `${padding}${line}`;
      return visibleWidth(renderedLine) <= width
        ? renderedLine
        : truncateToWidth(renderedLine, width);
    });
  }

  invalidate(): void {}
}

export function renderEditDiff(diff: string, theme: Theme): string {
  return diff.split("\n").map((line) => {
    if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
    if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
    return theme.fg("toolDiffContext", line);
  }).join("\n");
}

/**
 * Extract display paths from a raw patch string (unified diff, search/replace,
 * OpenAI/Codex patch, Atomic Patch, etc.) by reusing the same intent parsing
 * the edit tool applies at execution time. A raw call can legitimately have
 * neither a top-level `path` nor an `edits` array — the path(s) live inside
 * the raw diff content itself (e.g. `--- a/path` / `+++ b/path` headers).
 * Never throws: parse failures simply yield no paths, so the caller falls
 * back to its existing "missing path" display.
 */
export function getRawEditDisplayPaths(raw: string, defaultPath: string | undefined): string[] {
  try {
    const normalized = normalizeRawEdit(raw, defaultPath);
    const paths = normalized.intents.flatMap((intent): (string | undefined)[] => {
      switch (intent.kind) {
        case "text":
          return [intent.operation.path];
        case "add":
        case "delete":
          return [intent.path];
        case "rename":
          return [intent.newPath, intent.oldPath];
        default:
          return [];
      }
    });
    return [...new Set(paths.filter((path): path is string => Boolean(path)))];
  } catch {
    return [];
  }
}

export function getEditDisplayPaths(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const input = args as EditRenderArgs;
  const defaultPath = typeof input.path === "string" ? input.path : undefined;
  const edits = Array.isArray(input.edits) ? input.edits : [];

  if (edits.length > 0) {
    const paths = edits
      .map((edit) => {
        if (!edit || typeof edit !== "object") return defaultPath;
        const itemPath = (edit as { path?: unknown }).path;
        return typeof itemPath === "string" ? itemPath : defaultPath;
      })
      .filter((path): path is string => Boolean(path));

    if (paths.length === 0 && defaultPath) paths.push(defaultPath);
    return [...new Set(paths)];
  }

  // No `edits` array — a raw patch call carries its path(s) inside the raw
  // diff content instead of top-level fields. Parse it the same way the
  // tool does at execution time rather than falling straight to "missing path".
  if (typeof input.raw === "string" && input.raw.length > 0) {
    const rawPaths = getRawEditDisplayPaths(input.raw, defaultPath);
    if (rawPaths.length > 0) return rawPaths;
  }

  return defaultPath ? [defaultPath] : [];
}

export function renderEditCall(args: unknown, theme: Theme): Component {
  const paths = getEditDisplayPaths(args);
  const pathText = paths.length > 0
    ? theme.fg("accent", paths.join(", "))
    : theme.fg("error", "missing path");
  return new EditTextComponent(`${theme.fg("toolTitle", theme.bold("edit"))} ${pathText}`);
}

export function renderEditResult(
  result: EditRenderResult,
  options: { isPartial: boolean },
  theme: Theme,
): Component {
  if (options.isPartial) {
    return new EditTextComponent(theme.fg("warning", "Editing..."), 1);
  }

  const details = result.details;
  const diffs = details?.diffs?.filter(
    (entry) => typeof entry.path === "string" && typeof entry.diff === "string" && entry.diff.length > 0,
  );
  if (diffs && diffs.length > 0) {
    const output = diffs.length === 1
      ? renderEditDiff(diffs[0].diff, theme)
      : diffs
          .map((entry) => `${theme.fg("accent", entry.path)}\n${renderEditDiff(entry.diff, theme)}`)
          .join("\n\n");
    return new EditTextComponent(output, 1);
  }
  if (typeof details?.diff === "string" && details.diff.length > 0) {
    return new EditTextComponent(renderEditDiff(details.diff, theme), 1);
  }

  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
  const failed = details?.status.kind !== "applied";
  return new EditTextComponent(theme.fg(failed ? "error" : "success", text || (failed ? "Edit failed" : "Applied")), 1);
}
