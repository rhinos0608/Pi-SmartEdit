# Context Marker System

**Status:** Implemented  
**Date:** 2026-05-16  
**Author:** SmartEdit  
**Inspired by:** Codex `ContextualUserFragment` trait  

---

## 1. Motivation

The `semantic_context` tool returns plain markdown with type definitions, interfaces, implementations, and references. Downstream consumers — particularly compaction/prompt-management layers — cannot distinguish this injected context from model-generated text. This undermines two capabilities:

- **Attribution:** The model cannot see *where* each piece of information came from (file path, tool name, resolution method).
- **Filtering:** Compaction logic cannot selectively trim or summarise injected context while preserving model-generated reasoning.

A lightweight XML-style marker system solves both: mark the boundaries of every injected fragment so consumers can detect, parse, optionally strip, or selectively summarise context.

---

## 2. Design

### 2.1 Architecture

The system defines a small, unopinionated core:

- Marker constants (open/close tag pair per tool type)
- A `wrapInMarker()` function that wraps text in tags + optional metadata attributes
- An `isMarkedFragment()` predicate to detect marked regions
- A `parseMarkerMetadata()` function to extract attributes from a marked fragment

No global state, no singleton. Markers are pure text transforms that happen at the call site.

### 2.2 Marker Format

Tags follow the XML convention with a `smartedit:` namespace prefix:

```
<smartedit:context type="semantic_context" path="src/service.ts" range="42-78" source="lsp" tokens="1240">
  ...markdown content...
</smartedit:context>
```

**Rules:**
1. The open tag is self-describing — it carries all metadata as attributes.
2. The close tag is a balanced `</smartedit:context>`.
3. Attributes are space-separated `key="value"` pairs. Values are percent-encoded for arbitrary path characters.
4. The content between tags is the raw rendered markdown.
5. No nesting of `smartedit:` tags within each other (one level only). If multiple contexts are concatenated, they appear as adjacent fragments, not nested ones.

### 2.3 Tag Vocabulary

| Tag | Purpose | Tools |
|-----|---------|-------|
| `<smartedit:context>` | General context fragment | `semantic_context`, future context-injection tools |

The `type` attribute disambiguates the origin:

| `type` value | Producer | Attributes |
|---|---|---|
| `semantic_context` | `buildSemanticContext()` / `semantic_context` tool | `path`, `range`, `source`, `tokens`, `language` |
| (future) `read_cache` | Read-cache injection | `path`, `range` |

### 2.4 Attribute Encoding

Paths and arbitrary strings are percent-encoded (URL-style `encodeURIComponent`) to avoid breaking the XML attribute parser:

| Attribute | Encoding | Example |
|-----------|----------|---------|
| `path` | `encodeURIComponent(path)` | `src%2Fservice.ts` |
| `range` | raw `startLine-endLine` | `42-78` |
| `source` | raw identifier | `lsp` |
| `tokens` | raw integer | `1240` |
| `language` | raw LSP language ID | `typescript` |

---

## 3. TypeScript Interface

```typescript
interface ContextMarker {
  /** Role string describing the producer (e.g., "semantic_context") */
  role: string;

  /** Start tag with attributes, e.g. `<smartedit:context type="semantic_context" path="...">` */
  startMarker: string;

  /** End tag, e.g. `</smartedit:context>` */
  endMarker: string;

  /** The unadorned body text */
  body: string;

  /** Render the full fragment: startMarker + body + endMarker */
  render(): string;

  /** Static check: does the given text contain this marker's pattern? */
  static matchesText(text: string): boolean;
}
```

**Exported standalone functions** (preferred for the SmartEdit context — avoids class-inheritance overhead):

| Function | Signature | Purpose |
|----------|-----------|---------|
| `wrapInMarker()` | `(body: string, attrs: MarkerAttrs) => string` | Wrap body in marker tags |
| `isMarkedFragment()` | `(text: string) => boolean` | Check if text contains any `smartedit:` marker |
| `parseMarkerMetadata()` | `(text: string) => MarkerMetadata[]` | Extract all fragment metadata from text |
| `stripMarkers()` | `(text: string) => string` | Remove all markers, returning just body text |

---

## 4. Integration Points

### 4.1 `semantic_context` tool (index.ts ~line 2124)

Currently:

```typescript
return {
  content: [{ type: "text", text: result.markdown }],
  details: result.details as unknown as Record<string, unknown>,
};
```

After integration:

```typescript
import { wrapInMarker } from "./src/formats/context-markers";

// Inside the execute handler:
return {
  content: [{ type: "text", text: wrapInMarker(result.markdown, {
    type: "semantic_context",
    path: path,
    range: result.details.targetRange
      ? `${result.details.targetRange.startLine}-${result.details.targetRange.endLine}`
      : undefined,
    source: result.details.source,
    tokens: result.details.tokenCount,
    language: result.details.languageId ?? undefined,
  })}],
  details: result.details as unknown as Record<string, unknown>,
};
```

### 4.2 `buildSemanticContext()` (src/lsp/semantic-context.ts)

Alternative integration point — wrap at the return site of `buildSemanticContext()` so all callers get markers automatically. This is the preferred approach: one change in the core function, and both the `semantic_context` tool and any future consumer of `buildSemanticContext()` receive markers.

### 4.3 Read-cache injection (future)

When the read path injects context into a prompt, markers can be applied with:
```
<smartedit:context type="read_cache" path="src/foo.ts" range="1-200">
  ...file content...
</smartedit:context>
```

---

## 5. Filtering / Compaction

The `isMarkedFragment()` function enables compaction and prompt-management logic to:

1. **Detect** injected context: `if (isMarkedFragment(text))`
2. **Selectively strip or summarise**: Remove `smartedit:` tags while keeping body content, or summarise the body while preserving attribution via `parseMarkerMetadata()`.
3. **Filter out entirely**: When context is stale or superseded, strip both tags and body.

The equivalent of Codex's `is_contextual_user_fragment()`:

```typescript
function isContextualUserFragment(text: string): boolean {
  return text.includes("<smartedit:context") && text.includes("</smartedit:context>");
}
```

For compaction, markers enable a **two-phase strategy**:
- **Phase 1:** Concatenate all `smartedit:context` fragments into a single "injected context" section.
- **Phase 2:** Summarise or trim the section based on token budget, operating on the body of each fragment independently.

---

## 6. Design Decisions

### 6.1 Why XML-style tags instead of JSON?

XML tags are:
- **Human-readable** — the model can see `path="src/service.ts"` in its input text.
- **Detectable by substring match** — `includes()` is O(n) vs. JSON.parse which requires correct syntax.
- **Resilient** — a broken tag doesn't corrupt the rest of the prompt.
- **Simple to parse** — regex or basic string scanning is sufficient.

### 6.2 Why `smartedit:` namespace?

Prevents collision with:
- Other markers in the conversation (e.g., user messages, system prompts)
- XML-like structures in code the model may be writing

### 6.3 Why percent-encoding for paths?

File paths often contain characters (`/`, `#`, `?`, spaces) that would break XML attribute parsing. `encodeURIComponent` is the standard approach and avoids re-escaping complexity.

### 6.4 Why no nesting?

Nested `smartedit:` tags complicate compaction logic (which fragment wins on conflicts?). Adjacent fragments are simpler: each fragment is self-contained, and compaction can aggregate them by scanning for open-tag patterns.

---

## 7. Future Considerations

- **Fragment IDs:** A `fragment-id` attribute could let compaction deduplicate context that was injected multiple times.
- **Expiry:** A `created-at` attribute could let compaction discard stale context.
- **Summarisation hint:** A `summary` attribute (or `max-tokens` hint) could guide compaction on how aggressively to summarise the fragment.

---

## 8. Not In Scope (for this phase)

- Compression or summarisation of marker body content
- Marker-aware prompt assembly logic
- Cross-session marker persistence
- Markers for user-provided context (only tool-produced context)
