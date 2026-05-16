# Codex apply_patch Grammar Parser — Specification

**Status:** Draft v1.0  
**Author:** Pi SmartEdit  
**Date:** 2026-05-16  
**Codex reference:** `codex-rs/apply-patch/src/parser.rs` (954 lines, Lark grammar)  
**SmartEdit target:** `src/formats/codex-patch.ts`

---

## 1. Motivation

SmartEdit's existing `openai-patch.ts` parser is regex-based and fragile. It supports only `*** Update File:` sections and single `@@` anchors. It does not validate the envelope, handle error recovery, or support the full Codex apply_patch syntax — file creation (`*** Add File:`), deletion (`*** Delete File:`), file moves (`*** Move to:`), or multi-level `@@` chaining.

Models trained on Codex's apply_patch format (GPT-4.1, GPT-5, Claude Opus via format transfer) produce patches in this grammar. A proper recursive-descent parser with error recovery allows SmartEdit to accept these patches directly, reducing serialization errors and improving edit precision.

---

## 2. Formal Grammar (BNF)

The grammar is defined as a context-free grammar with special handling for the hunk line prefix tokens. Line endings are normalized to `\n` before parsing.

```
patch           = [ preamble ] , envelope-start , newline , { section } , [ envelope-end ] , [ postamble ]
preamble        = { any-line }          (* ignored in lenient mode *)
postamble       = { any-line }          (* ignored in lenient mode *)

envelope-start  = "***" , [ ws ] , "Begin Patch"
envelope-end    = "***" , [ ws ] , "End Patch"
section         = add-section | delete-section | update-section

(* --- Add File --- *)
add-section     = add-marker , newline , { contents-line }

add-marker      = "***" , [ ws ] , "Add File:" , ws , path

(* --- Delete File --- *)
delete-section  = delete-marker , newline

delete-marker   = "***" , [ ws ] , "Delete File:" , ws , path

(* --- Update File --- *)
update-section  = update-marker , newline , [ move-marker , newline ] , { hunk }

update-marker   = "***" , [ ws ] , "Update File:" , ws , path
move-marker     = "***" , [ ws ] , "Move to:" , ws , path

(* --- Hunk --- *)
hunk            = hunk-marker , newline , { hunk-line }
hunk-marker     = "@@" , [ ws , hunk-scope ]

hunk-scope      = hunk-level , { ws , "." , ws , hunk-level }
hunk-level      = { printable } - newline

hunk-line       = context-line | removed-line | added-line | continuation-line
context-line    = " " , { printable }
removed-line    = "-" , { printable }
added-line      = "+" , { printable }
continuation-line = "\" , { printable }  (* git-style no-newline-at-eof marker; ignored *)

(* --- Content lines (for Add File) --- *)
contents-line   = { any-character } - ( add-marker | delete-marker | update-marker | envelope-end )

(* --- Helpers --- *)
path            = { printable } - newline
ws              = " " | "\t"
newline         = "\n"
any-line        = { any-character } , newline
printable       = any character in [0x20, 0x7E] or [0x80, ...]
any-character   = any Unicode character except \n
```

### 2.1 Marker spelling variants (lenient mode)

In lenient mode, these marker variants are accepted:

| Canonical | Accepted variants |
|---|---|
| `*** Begin Patch` | `***Begin Patch` (no space), `*** BEGIN PATCH`, `*** begin patch` |
| `*** End Patch` | `***End Patch` (no space), `*** END PATCH`, `*** end patch` |
| `*** Add File:` | `***Add File:`, `***ADD FILE:`, `*** add file:` |
| `*** Delete File:` | `***Delete File:`, `***DELETE FILE:`, `*** delete file:` |
| `*** Update File:` | `***Update File:`, `***UPDATE FILE:`, `*** update file:` |
| `*** Move to:` | `***Move to:`, `*** MOVE TO:`, `*** move to:` |

---

## 3. AST Types

### 3.1 CodexHunk (representing the three Hunk variants)

```typescript
/**
 * The three operations Codex's apply_patch grammar supports.
 * Mirrors the Hunk enum from codex-rs/apply-patch/src/parser.rs.
 */
export type CodexHunk =
  | { kind: 'AddFile'; path: string; contents: string }
  | { kind: 'DeleteFile'; path: string }
  | { kind: 'UpdateFile'; path: string; movePath?: string; chunks: UpdateFileChunk[] };
```

### 3.2 UpdateFileChunk

```typescript
/**
 * A single @@-delimited hunk within an UpdateFile section.
 * Multi-level @@ chaining yields a scope array.
 */
export interface UpdateFileChunk {
  /** Multi-level scope path from @@ chain, e.g. ["class BaseClass", "  def method():"] */
  scope: string[];
  /** Lines prefixed with ' ' (context — present in both old and new) */
  contextLines: string[];
  /** Lines prefixed with '-' (removed content) */
  removedLines: string[];
  /** Lines prefixed with '+' (added content) */
  addedLines: string[];
}
```

### 3.3 ParserResult

```typescript
export interface CodexPatchResult {
  /** Parsed hunks, in order of appearance */
  hunks: CodexHunk[];
  /** Warnings accumulated during lenient-mode parsing */
  warnings: PatchWarning[];
}

export interface PatchWarning {
  message: string;
  line: number;
  kind: 'missing_end_patch' | 'empty_hunk' | 'unknown_marker' | 'lenient_spelling' | 'preamble_skipped';
}
```

### 3.4 Mode enumeration

```typescript
export type ParseMode = 'strict' | 'lenient';
```

---

## 4. Error Recovery Rules

The parser operates in two modes. Strict mode fails on the first deviation. Lenient mode attempts recovery for common model malformations.

### 4.1 Recovery table (lenient mode)

| Model mistake | Behaviour | Produces warning? |
|---|---|---|
| Missing `*** End Patch` | Treat end-of-input as end of patch | Yes (kind: `missing_end_patch`) |
| Lines before `*** Begin Patch` | Skip preamble lines silently | Yes (kind: `preamble_skipped`) |
| Lines after `*** End Patch` | Ignore postamble lines silently | Yes (kind: `preamble_skipped`) |
| `***Begin Patch` (no space) | Accept with lenient spelling match | Yes (kind: `lenient_spelling`) |
| `*** begin patch` (lowercase) | Accept | Yes (kind: `lenient_spelling`) |
| Empty hunk (`@@` followed by another `@@` or end) | Skip hunk, continue | Yes (kind: `empty_hunk`) |
| Hunk with only context lines (no `+`/`-`) | Skip hunk, continue | Yes (kind: `empty_hunk`) |
| Unknown `***` marker | Skip line, continue | Yes (kind: `unknown_marker`) |
| Trailing whitespace on marker lines | Trimmed silently | No |
| CRLF line endings | Normalised to LF before parsing | No |
| Multiple file operations in a single patch | All parsed sequentially | No |
| Hunk lines with missing prefix | Treated as context lines | Yes (kind: `unknown_marker`) |

### 4.2 Recovery behaviour for unrecoverable errors

Some errors cannot be recovered from even in lenient mode:

| Error | Throw reason |
|---|---|
| `*** Begin Patch` found but no operation markers follow | Patch is empty; throw `PatchParseError` |
| `*** Add File:` with missing path | Path is required for file ops; throw `PatchParseError` |
| `*** Update File:` with missing path | Same |
| Unterminated `@@` hunk at end of input without `*** End Patch` | Recovered in lenient mode (see above); in strict mode, throw |

---

## 5. Mapping to SmartEdit's EditItem Format

Each `CodexHunk` maps to one or more objects compatible with SmartEdit's `EditItem` interface.

### 5.1 AddFile → EditItem

| CodexHunk | EditItem |
|---|---|
| `AddFile { path, contents }` | `{ path, oldText: "", newText: contents }` |

The empty `oldText` signals a new file. SmartEdit's matching pipeline should treat `oldText === ""` as a new-file operation.

### 5.2 DeleteFile → EditItem

| CodexHunk | EditItem |
|---|---|
| `DeleteFile { path }` | `{ path, oldText: "<full file contents>", newText: "" }` |

SmartEdit needs to read the current file to populate `oldText`. The parser provides `codexHunkToEditItem()` which for `DeleteFile` reads the file at `path` from disk and sets that as `oldText`, or throws if the file doesn't exist (the model asked to delete something that's already gone — silently succeed).

### 5.3 UpdateFile → EditItem[]

| CodexHunk | EditItem |
|---|---|
| `UpdateFile { path, chunks }` | One `EditItem` per chunk |

Each `UpdateFileChunk` converts as follows:

```
oldText = contextLines.join("\n") + "\n" + removedLines.join("\n")
newText = contextLines.join("\n") + "\n" + addedLines.join("\n")
```

The `contextLines` appear in both `oldText` and `newText`, matching Codex's semantics where context lines anchor the match.

The multi-level `@@` scope chain is passed as `anchor` hints:

```typescript
{
  path: "...",
  oldText: "...",
  newText: "...",
  anchor: {
    symbolName: scope[scope.length - 1]  // innermost scope
  }
}
```

### 5.4 Move to: within UpdateFile

When `movePath` is set, the file at `path` should be renamed to `movePath` after applying the edit. SmartEdit's current pipeline doesn't support renames natively; the `codexHunkToEditItem()` function emits a `movePath` property on the EditInput for downstream consumers that understand it.

---

## 6. Integration Points

### 6.1 `src/formats/format-detector.ts`

Add `'codex_patch'` to the `InputFormat` union. Detection logic:

1. Check for `*** Begin Patch` or `***Begin Patch` (current detection for `openai_patch`).
2. If detected, check whether the patch contains **any** of the following markers *after* `*** Begin Patch`:
   - `*** Add File:`
   - `*** Delete File:`
   - `*** Move to:`
3. If yes → return `'codex_patch'` (the full grammar parser handles it).
4. If no (only `*** Update File:` sections) → return `'openai_patch'` (existing regex parser handles it — simpler for simple cases).

This allows the codex-patch parser to handle the full grammar while the existing openai-patch parser continues to handle simple update-only patches, avoiding unnecessary overhead.

### 6.2 `src/formats/openai-patch.ts`

When `parseOpenAIPatch()` receives input that contains `*** Add File:`, `*** Delete File:`, or `*** Move to:`, it should delegate to `parseCodexPatch()` from codex-patch.ts and convert the result back via `codexHunkToEditItem()`. This backward compatibility ensures existing callers don't break.

### 6.3 `src/formats/index.ts`

Add to barrel export:
```typescript
export * from './codex-patch';
```

### 6.4 `index.ts` (main dispatcher)

Add `'codex_patch'` to the format dispatch switch statement, mapping it to `parseCodexPatch()` → `codexHunkToEditItem()`.

---

## 7. Parser Architecture

### 7.1 Recursive-descent design

The parser uses a cursor-based recursive-descent approach with character-level tracking for error messages:

```typescript
class CodexPatchParser {
  private input: string;
  private pos: number;
  private line: number;
  private column: number;
  private mode: ParseMode;
  private warnings: PatchWarning[];

  constructor(input: string, mode: ParseMode)

  // Entry point
  parse(): CodexPatchResult

  // Cursor management
  private peek(): string
  private advance(): string
  private skipWhitespace(): void
  private skipLine(): string
  private expect(expected: string): boolean

  // Grammar rules
  private parsePatch(): CodexHunk[]
  private tryParseMarker(): MarkerType | null
  private parseAddSection(path: string): CodexHunk
  private parseDeleteSection(path: string): CodexHunk
  private parseUpdateSection(path: string): CodexHunk
  private parseHunk(): UpdateFileChunk | null
  private tryParseNewline(): boolean

  // Error recovery
  private skipToNextMarker(): void
  private tryParseLenientMarker(expected: string): boolean
}
```

### 7.2 Marker detection precedence

When scanning the input, markers are detected by longest prefix match:

1. Try `*** Add File:` first
2. Try `*** Delete File:` second
3. Try `*** Move to:` third
4. Try `*** Update File:` fourth
5. Try `*** Begin Patch` / `*** End Patch`
6. If none match but starts with `***`, treat as unknown marker (warn and skip line)

### 7.3 Hunk parsing

When a `@@` marker is found within an `UpdateFile` section:

1. Extract the scope text (everything after `@@` until newline)
2. Split scope by `.` separator (for multi-level @@ chaining)
3. Enter hunk body — read lines until another `@@`, `***`, or end of section
4. Classify each hunk line by first character:
   - ` ` → context line (stripped prefix)
   - `-` → removed line (stripped prefix)
   - `+` → added line (stripped prefix)
   - `\` → continuation marker (ignored)
5. Validate: hunk must have at least one `-` or `+` line, otherwise skip with warning

---

## 8. Edge Cases

| Edge case | Behaviour |
|---|---|
| Add File with no content (empty file) | `contents` is empty string `""` |
| Add File followed immediately by another section | Contents extracted between markers |
| Multiple `@@` anchors with same scope | Both hunks parsed and emitted |
| `@@` line with only `@@` and nothing else | Scope is empty array |
| Lines with only `-`, `+`, or ` ` (empty after prefix) | Empty string in the corresponding array |
| Tab-indented hunk bodies | Tabs preserved in extracted content |
| Mixed CRLF and LF in same patch | All normalized to LF before parsing |
| Nested code containing `***` | Only treated as marker if at line start (after newline or at pos 0) |
| File paths with spaces | Path is the rest of the line after `:`, trimmed |
| `Move to:` without `Update File:` | `Move to:` is only valid within an Update File section |

---

## 9. Example: Codex Patch

```text
*** Begin Patch
*** Add File: src/new-feature.ts
export function add(a: number, b: number): number {
  return a + b;
}
*** Update File: src/main.ts
*** Move to: src/legacy/main.ts
@@ export function calculate(x)
-  const result = x * 2;
+  const result = x * 3;
   return result;
@@ export function format(value)
-  return value.toString();
+  return String(value);
*** Delete File: src/old.ts
*** End Patch
```

This patch:

1. Creates `src/new-feature.ts` with the exported function
2. Moves `src/main.ts` to `src/legacy/main.ts` with two changes
3. Deletes `src/old.ts`

The parser produces 4 `CodexHunk` values: 1 `AddFile`, 1 `UpdateFile` (with 2 chunks), 1 `DeleteFile`.

---

## 10. Future Considerations

- **Streaming parser**: A `StreamingCodexPatchParser` that emits completed hunks as the model streams patch text (500ms buffer). See `codex-rs/apply-patch/src/streaming_parser.rs`.
- **Multi-file atomic transactions**: When a single patch contains Add/Delete/Update operations across multiple files, SmartEdit could apply them atomically with rollback support.
- **Approval gating**: Path-based approval rules for specific file operations (e.g., prompt before deleting files).
