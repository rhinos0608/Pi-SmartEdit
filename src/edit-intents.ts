import type { EditOperation } from "./edit-contract.js";
import { detectInputFormat, type InputFormat } from "./formats/format-detector.js";
import { parseSearchReplace } from "./formats/search-replace.js";
import { parseUnifiedDiff } from "./formats/unified-diff.js";
import { parseOpenAIPatch, openAIPatchToEditItem } from "./formats/openai-patch.js";
import { parseCodexPatch } from "./formats/codex-patch.js";
import { parseAtomicPatchEnvelope } from "./formats/atomic-patch.js";
import { repairJson } from "./formats/forgiving-parser.js";

export type EditIntent =
  | { kind: "text"; operation: EditOperation }
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "rename"; oldPath: string; newPath: string };

export interface NormalizedRawEdit {
  format: InputFormat;
  intents: EditIntent[];
  warnings: string[];
  diagnostics: string[];
}

const text = (path: string | undefined, oldText: string, newText: string): EditIntent => ({
  kind: "text", operation: { path, oldText, newText },
});

function pathOf(value: string, fallback?: string): string {
  const clean = value.replace(/^[ab]\//, "");
  return clean === "/dev/null" ? (fallback ?? "") : clean;
}

function jsonIntents(raw: string, fallback?: string): EditIntent[] {
  const repaired = repairJson(raw);
  const value = repaired.value;
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return list.map((item) => {
    const e = item as Record<string, unknown>;
    if (typeof e.oldText !== "string" || typeof e.newText !== "string") {
      throw new Error("JSON edit must contain string oldText and newText");
    }
    return text(typeof e.path === "string" ? e.path : fallback, e.oldText, e.newText);
  });
}

export function normalizeRawEdit(raw: string, defaultPath?: string): NormalizedRawEdit {
  const format = detectInputFormat(raw);
  const warnings: string[] = [];
  try {
    let intents: EditIntent[] = [];
    switch (format) {
      case "raw_edits":
        intents = jsonIntents(raw, defaultPath);
        break;
      case "search_replace":
        intents = parseSearchReplace(raw).map((e) => text(e.path ?? defaultPath, e.oldText, e.newText));
        break;
      case "unified_diff": {
        for (const patch of parseUnifiedDiff(raw)) {
          const oldPath = pathOf(patch.oldFile);
          const newPath = pathOf(patch.newFile);
          if (!oldPath && newPath) {
            // Added file: join added lines with newlines. A `\ No newline at end
            // of file` marker immediately after the final added line means the
            // content ends without a trailing newline; otherwise the added
            // content carries the trailing newline the diff implies.
            const addLines: string[] = [];
            let noNewline = false;
            for (const h of patch.hunks) {
              for (const l of h.lines) {
                if (l.startsWith("+")) {
                  addLines.push(l.slice(1));
                  noNewline = false;
                } else if (l.startsWith("\\ No newline")) {
                  noNewline = true;
                }
              }
            }
            const joined = addLines.join("\n");
            // An added file with no added lines is an empty file; do not append
            // the trailing newline an empty diff would imply.
            const content = addLines.length === 0 ? "" : (noNewline ? joined : `${joined}\n`);
            intents.push({ kind: "add", path: newPath, content });
          } else if (oldPath && !newPath) intents.push({ kind: "delete", path: oldPath });
          else {
            for (const h of patch.hunks) {
              // Bare empty hunk lines ("" prefix) are context present on both
              // sides; keep them instead of filtering them out. Only a `\ No
              // newline` marker (prefix "\\") is a non-line and is excluded.
              const isOld = (l: string) => l.length === 0 || l[0] === " " || l[0] === "-";
              const isNew = (l: string) => l.length === 0 || l[0] === " " || l[0] === "+";
              const body = (l: string) => (l.length === 0 ? "" : l.slice(1));
              const oldText = h.lines.filter(isOld).map(body).join("\n");
              const newText = h.lines.filter(isNew).map(body).join("\n");
              if (oldText !== newText) intents.push(text(newPath || oldPath || defaultPath, oldText, newText));
            }
          }
        }
        break;
      }
      case "openai_patch":
        intents = parseOpenAIPatch(raw).map((p) => {
          if (p.contextAnchor === "<DELETE_FILE>") return { kind: "delete", path: p.path };
          const operation = openAIPatchToEditItem(p);
          return text(p.path || defaultPath, operation.oldText, operation.newText);
        });
        break;
      case "codex_patch": {
        const result = parseCodexPatch(raw, "lenient");
        warnings.push(...result.warnings.map((w) => `line ${w.line}: ${w.message}`));
        for (const h of result.hunks) {
          if (h.kind === "AddFile") intents.push({ kind: "add", path: h.path, content: h.contents });
          else if (h.kind === "DeleteFile") intents.push({ kind: "delete", path: h.path });
          else {
            for (const c of h.chunks) intents.push(text(h.path || defaultPath, [...c.contextLines, ...c.removedLines].join("\n"), [...c.contextLines, ...c.addedLines].join("\n")));
            if (h.movePath) intents.push({ kind: "rename", oldPath: h.path, newPath: h.movePath });
          }
        }
        break;
      }
      case "atomic_patch": {
        const result = parseAtomicPatchEnvelope(raw);
        warnings.push(...result.warnings.map((w) => `line ${w.line}: ${w.message}`));
        for (const op of result.envelope.operations) {
          if (op.kind === "AddFile") intents.push({ kind: "add", path: op.path, content: op.contents });
          else if (op.kind === "DeleteFile") intents.push({ kind: "delete", path: op.path });
          else if (op.kind === "RenameFile") intents.push({ kind: "rename", oldPath: op.oldPath, newPath: op.newPath });
          else {
            for (const p of op.patches) intents.push(text(op.path || defaultPath, p.oldText, p.newText));
            if (op.movePath) intents.push({ kind: "rename", oldPath: op.path, newPath: op.movePath });
          }
        }
        break;
      }
    }
    if (intents.length === 0) return { format, intents, warnings, diagnostics: [`${format} parsed into zero operations`] };
    return { format, intents, warnings, diagnostics: [] };
  } catch (error) {
    return { format, intents: [], warnings, diagnostics: [error instanceof Error ? error.message : String(error)] };
  }
}
