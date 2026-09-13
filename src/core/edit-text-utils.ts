/**
 * Text normalization utilities for the smart-edit Pi extension.
 *
 * Extracted verbatim from src/core/edit-diff.ts (MS1): line-ending
 * detection/normalization/restoration plus UTF-8 BOM stripping.
 * Pure helpers with no dependencies — no logic change.
 */

// ─── Line ending utilities ───────────────────────────────────────

export function detectLineEnding(content: string): string {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: string): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Strip UTF-8 BOM if present */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}
