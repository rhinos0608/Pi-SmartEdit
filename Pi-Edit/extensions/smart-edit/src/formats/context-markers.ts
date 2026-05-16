/**
 * Context Marker System — Wraps injected context in XML-like markers.
 *
 * Inspired by Codex's `ContextualUserFragment` trait. Markers serve dual
 * purpose:
 * 1. Delimit injected context so downstream filtering can identify/remove fragments
 * 2. Preserve attribution — the model can see what information came from where
 *
 * Marker format:
 *   <smartedit:context type="semantic_context" path="src%2Fservice.ts" range="42-78" source="lsp" tokens="1240">
 *     ...markdown content...
 *   </smartedit:context>
 *
 * @module
 */

/**
 * Metadata attributes carried by a smartedit:context marker.
 */
export interface ContextMarkerAttrs {
  /** Type of context (e.g., "semantic_context") */
  type: string;
  /** Source file path (percent-encoded in the tag) */
  path?: string;
  /** Line range, e.g. "42-78" */
  range?: string;
  /** Resolution source: "lsp" | "ast" | "none" */
  source?: string;
  /** Estimated token count */
  tokens?: number;
  /** LSP language ID (e.g., "typescript", "python") */
  language?: string;
}

const CONTEXT_OPEN_TAG_PATTERN = /<smartedit:context\s[^>]*>/;
const CONTEXT_CLOSE_TAG = "</smartedit:context>";
const SMARTEDIT_TAG_PREFIX = "<smartedit:";

/**
 * Wrap body text in smartedit:context markers with the given attributes.
 *
 * @param body - The markdown content to wrap
 * @param attrs - Metadata attributes to encode in the open tag
 * @returns The full fragment: open tag + body + close tag
 */
export function wrapInContextMarker(
  body: string,
  attrs: ContextMarkerAttrs,
): string {
  const attrParts: string[] = [];

  // Encode path so XML attribute parsing is never broken by /, #, ?, etc.
  if (attrs.type) attrParts.push(`type="${encodeAttr(attrs.type)}"`);
  if (attrs.path) attrParts.push(`path="${encodeURIComponent(attrs.path)}"`);
  if (attrs.range) attrParts.push(`range="${encodeAttr(attrs.range)}"`);
  if (attrs.source) attrParts.push(`source="${encodeAttr(attrs.source)}"`);
  if (attrs.tokens !== undefined) attrParts.push(`tokens="${attrs.tokens}"`);
  if (attrs.language) attrParts.push(`language="${encodeAttr(attrs.language)}"`);

  const openTag = `<smartedit:context ${attrParts.join(" ")}>`;
  return `${openTag}\n${body}\n${CONTEXT_CLOSE_TAG}`;
}

/**
 * Check if the given text contains any smartedit: marker.
 *
 * Intended for compaction / prompt-management logic that needs to detect
 * whether injected context is present.
 *
 * @param text - Arbitrary text to inspect
 * @returns `true` if a smartedit: marker is found
 */
export function isMarkedFragment(text: string): boolean {
  return (
    text.includes(SMARTEDIT_TAG_PREFIX) &&
    text.includes(CONTEXT_CLOSE_TAG)
  );
}

/**
 * Parsed metadata for one fragment in the text.
 */
export interface FragmentMetadata {
  /** The full open tag text */
  openTag: string;
  /** Parsed attributes from the open tag */
  attrs: ContextMarkerAttrs;
  /** The body text between open and close tags */
  body: string;
  /** Start index of the open tag in the source text */
  startIndex: number;
  /** End index after the close tag */
  endIndex: number;
}

/**
 * Extract all smartedit:context fragment metadata from text.
 *
 * Returns an array even for a single fragment, so callers can iterate.
 * Returns an empty array when no markers are found.
 *
 * @param text - Text containing potential marker fragments
 * @returns Array of parsed fragment metadata
 */
export function parseMarkerMetadata(text: string): FragmentMetadata[] {
  const results: FragmentMetadata[] = [];
  let pos = 0;

  while (pos < text.length) {
    const openMatch = text.slice(pos).match(CONTEXT_OPEN_TAG_PATTERN);
    if (!openMatch) break;

    const openTag = openMatch[0];
    const openStart = pos + (openMatch.index ?? 0);
    const openEnd = openStart + openTag.length;

    // Find the matching close tag
    const closeIdx = text.indexOf(CONTEXT_CLOSE_TAG, openEnd);
    if (closeIdx === -1) break;

    const body = text.slice(openEnd, closeIdx).trim();
    const endIndex = closeIdx + CONTEXT_CLOSE_TAG.length;

    results.push({
      openTag,
      attrs: parseAttrs(openTag),
      body,
      startIndex: openStart,
      endIndex,
    });

    pos = endIndex;
  }

  return results;
}

/**
 * Remove all smartedit: markers from text, returning only the body content.
 *
 * When multiple fragments are present, their bodies are concatenated with
 * newlines.
 *
 * @param text - Text with potential marker fragments
 * @returns Text with markers removed
 */
export function stripMarkers(text: string): string {
  const fragments = parseMarkerMetadata(text);
  if (fragments.length === 0) return text;

  // Build result by interleaving non-marker text with fragment bodies
  const parts: string[] = [];
  let cursor = 0;

  for (const frag of fragments) {
    // Text before this fragment
    if (frag.startIndex > cursor) {
      parts.push(text.slice(cursor, frag.startIndex).trimEnd());
    }
    // Fragment body
    parts.push(frag.body);
    cursor = frag.endIndex;
  }

  // Remaining text after last fragment
  if (cursor < text.length) {
    parts.push(text.slice(cursor).trimStart());
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Encode a string for safe use as an XML attribute value.
 * Escapes `"`, `<`, `>`, `&` and strips control characters.
 */
function encodeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Parse attributes from a smartedit:context open tag.
 * Extracts key="value" pairs with percent-decoding for the `path` attribute.
 */
function parseAttrs(openTag: string): ContextMarkerAttrs {
  const attrs: ContextMarkerAttrs = { type: "" };
  const attrRegex = /(\w+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(openTag)) !== null) {
    const [, key, rawValue] = match;
    const value = key === "path"
      ? decodeURIComponent(rawValue)
      : rawValue
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");

    switch (key) {
      case "type":
        attrs.type = value;
        break;
      case "path":
        attrs.path = value;
        break;
      case "range":
        attrs.range = value;
        break;
      case "source":
        attrs.source = value;
        break;
      case "tokens":
        attrs.tokens = Number(value);
        break;
      case "language":
        attrs.language = value;
        break;
    }
  }

  return attrs;
}
