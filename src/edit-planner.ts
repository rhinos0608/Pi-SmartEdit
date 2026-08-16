/**
 * Edit planner — converts validated text, symbolic, and structural operations
 * into staged mutations against an immutable snapshot, without writing files.
 *
 * All operation types resolve against one LF-normalized, BOM-stripped snapshot
 * into one minimal `ResolvedMutation` shape (start byte, end byte, replacement,
 * request index, capability/note). Mutations are then overlap-checked and
 * applied descending against the snapshot, so mixed text/symbolic/structural
 * batches share one deterministic lifecycle.
 *
 * - Text edits route through the existing `applyEdits` engine (fuzzy tiers,
 *   replaceAll, closest-match diagnostics, literal `$` replacement) and reuse
 *   its resolved `MatchSpan[]`.
 * - Symbolic edits (replaceBody/insertBefore/insertAfter) reuse
 *   `applySymbolicEdits` from symbolic-edits.ts.
 * - Structural edits (pattern+replacement) reuse ast-grep semantics via
 *   `resolvePatternEdits` from astgrep-anchor.ts.
 *
 * BOM and original line-ending behavior are preserved using the existing
 * normalization/restoration helpers from edit-diff.
 *
 * Explicit scopes (AST target and/or lineRange) never fall back to whole-file
 * matching: an unresolved/ambiguous AST target, an out-of-range lineRange, an
 * empty AST+lineRange intersection, or a structural match outside an explicit
 * scope fails before any write with an actionable diagnostic.
 */
import {
  stripBom,
  normalizeToLF,
  restoreLineEndings,
  detectLineEnding,
  applyEdits,
  findText,
  detectIndentation,
} from "./core/edit-diff.js";
import { applyHashlinePath, type HashlineEditInput } from "./core/hashline-edit.js";
import {
  resolveAnchorToScope,
  lineRangeToScope,
  intersectScopes,
  type AstResolverLike,
  type AnchorResolutionDiagnostics,
} from "./anchor-resolution.js";
import { applySymbolicEdits } from "./symbolic-edits.js";
import { isAstGrepAvailable, resolvePatternEdits } from "./astgrep-anchor.js";
import type {
  EditItem,
  EditAnchor,
  MatchSpan,
  LineRange,
  SearchScope,
  EditCapability,
  FileSnapshot,
} from "./core/types.js";

/** One resolved replacement against the immutable snapshot. */
export interface ResolvedMutation {
  /** Byte offset of the replacement start in the LF-normalized snapshot. */
  startByte: number;
  /** Byte offset of the replacement end (exclusive). Equal to startByte for inserts. */
  endByte: number;
  /** Literal replacement text (LF-normalized). */
  replacement: string;
  /** Index into the original edits array. */
  requestIndex: number;
  /** Capability exercised by this mutation. */
  capability: EditCapability;
  /** Optional human-readable note. */
  note?: string;
}

/** One resolved structural replacement span. */
export interface ResolvedPatternEdit {
  startByte: number;
  endByte: number;
  text: string;
}

export interface StructuralResolveResult {
  ok: boolean;
  /** Resolved edits; present when ok. */
  edits?: ResolvedPatternEdit[];
  /** Actionable diagnostic when !ok. */
  error?: string;
}

/** Injectable structural (ast-grep) resolver so tests can exercise success/error paths. */
export interface StructuralResolver {
  resolve(
    content: string,
    filePath: string,
    pattern: string,
    replacement: string,
  ): Promise<StructuralResolveResult>;
}

/** Staged result of planning edits for one file. No writes performed. */
export interface PlannedTextEdits {
  /** New content with BOM and original line endings restored. */
  newContent: string;
  /** Actual resolved match spans (byte offsets into LF-normalized, BOM-stripped content). */
  matchSpans: MatchSpan[];
  /** Actual affected preimage line ranges (1-based inclusive), one per match span.
   *  Coordinate space: the PRE-edit snapshot. Use this to check authorization
   *  against evidence `allowedRanges`, which were also captured pre-edit. */
  preimageLineRanges: LineRange[];
  /** Actual affected postimage line ranges (1-based inclusive), one per match
   *  span, index-aligned with preimageLineRanges/matchSpans. Coordinate
   *  space: the POST-edit content (`newContent`). An edit that inserts or
   *  deletes lines shifts every later mutation's line numbers relative to
   *  the preimage, so callers that scope diagnostics/evidence against the
   *  post-edit content (not the pre-edit content) MUST use these ranges
   *  instead of preimageLineRanges. */
  postimageLineRanges: LineRange[];
  /** Human-readable match notes from the matching engines. */
  matchNotes: string[];
  /** Capabilities exercised by this plan. */
  capabilities: EditCapability[];
}

export interface PlanTextEditsArgs {
  /** Raw current file content (may include BOM and CRLF). */
  content: string;
  /** Operations to stage (text, symbolic, and/or structural). */
  edits: EditItem[];
  /** File path used for diagnostics and AST language detection. */
  filePath: string;
  /** AST resolver for target scoping and symbolic resolution; null when tree-sitter is unavailable. */
  astResolver: AstResolverLike | null;
  /** Structural (ast-grep) resolver; defaults to the real ast-grep engine. */
  structuralResolver?: StructuralResolver | null;
  /** Snapshot lookup for hashline oldText reconstruction. Tool-owned; never
   *  exposed in the agent schema. When absent, hashline fallback cannot
   *  reconstruct oldText and falls through to mismatch rejection. */
  getSnapshot?: (path: string) => FileSnapshot | null;
}

const defaultStructuralResolver: StructuralResolver = {
  async resolve(content, filePath, pattern, replacement) {
    const available = await isAstGrepAvailable();
    if (!available) {
      return {
        ok: false,
        error:
          "ast-grep engine is unavailable in this session; install @ast-grep/napi or use text/symbolic edits",
      };
    }
    const lang = languageIdForStructural(filePath);
    if (!lang) {
      return { ok: false, error: `structural edits are not supported for ${filePath}` };
    }
    const edits = await resolvePatternEdits(content, lang, pattern, replacement);
    if (edits === null) {
      return {
        ok: false,
        error: `structural pattern failed to match in ${filePath}; check the pattern syntax`,
      };
    }
    return { ok: true, edits };
  },
};

export async function planTextEdits(args: PlanTextEditsArgs): Promise<PlannedTextEdits> {
  // Classify edits into text / symbolic / structural before any matching.
  const textEdits: EditItem[] = [];
  const textOriginalIndex: number[] = [];
  const symbolicEdits: EditItem[] = [];
  const symbolicOriginalIndex: number[] = [];
  const structuralEdits: EditItem[] = [];
  const structuralOriginalIndex: number[] = [];
  const hashlineEdits: EditItem[] = [];
  const hashlineOriginalIndex: number[] = [];

  for (let i = 0; i < args.edits.length; i++) {
    const e = args.edits[i];
    if (e.hashline) {
      hashlineEdits.push(e);
      hashlineOriginalIndex.push(i);
      continue;
    }
    const t = e.target;
    const isSymbolic =
      !!t &&
      (t.replaceBody !== undefined || t.insertBefore !== undefined || t.insertAfter !== undefined);
    const isStructural = !!t && t.pattern !== undefined;
    if (isSymbolic && isStructural) {
      throw new Error(`edits[${i}] cannot be both symbolic and structural`);
    }
    if (isSymbolic) {
      symbolicEdits.push(e);
      symbolicOriginalIndex.push(i);
    } else if (isStructural) {
      structuralEdits.push(e);
      structuralOriginalIndex.push(i);
    } else {
      if (typeof e.oldText !== "string" || typeof e.newText !== "string") {
        throw new Error(`edits[${i}] missing oldText/newText`);
      }
      textEdits.push(e);
      textOriginalIndex.push(i);
    }
  }

  const { bom, text } = stripBom(args.content);
  const normalized = normalizeToLF(text);
  const lineEnding = detectLineEnding(args.content);

  // Resolve explicit scopes (AST target and/or lineRange) for text and
  // structural edits. An explicit scope never falls back to whole-file.
  const textScopes: (SearchScope | undefined)[] = [];
  for (let i = 0; i < textEdits.length; i++) {
    textScopes.push(
      await resolveEditScope(textEdits[i], normalized, args.filePath, args.astResolver, textOriginalIndex[i]),
    );
  }
  const symbolicScopes: (SearchScope | undefined)[] = [];
  for (let i = 0; i < symbolicEdits.length; i++) {
    symbolicScopes.push(
      await resolveEditScope(symbolicEdits[i], normalized, args.filePath, args.astResolver, symbolicOriginalIndex[i]),
    );
  }
  const structuralScopes: (SearchScope | undefined)[] = [];
  for (let i = 0; i < structuralEdits.length; i++) {
    structuralScopes.push(
      await resolveEditScope(structuralEdits[i], normalized, args.filePath, args.astResolver, structuralOriginalIndex[i]),
    );
  }
  const hashlineScopes: (SearchScope | undefined)[] = [];
  for (let i = 0; i < hashlineEdits.length; i++) {
    hashlineScopes.push(
      await resolveEditScope(hashlineEdits[i], normalized, args.filePath, args.astResolver, hashlineOriginalIndex[i]),
    );
  }

  const mutations: ResolvedMutation[] = [];
  const matchSpans: MatchSpan[] = [];
  const matchNotes: string[] = [];

  // ── Text edits: reuse applyEdits matchSpans ────────────────────────
  if (textEdits.length > 0) {
    let textResult: {
      baseContent: string;
      newContent: string;
      matchNotes: string[];
      replacementCount: number;
      matchSpans: MatchSpan[];
    };
    try {
      textResult = await applyEdits(normalized, textEdits, args.filePath, {
        searchScopes: textScopes,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNoChange = /^No changes made to/.test(msg);
      // A text-only no-change is a real failure; but when symbolic/structural
      // or hashline edits are present, a no-op text batch must not abort the
      // whole plan.
      if (
        isNoChange
        && (symbolicEdits.length > 0 || structuralEdits.length > 0 || hashlineEdits.length > 0)
      ) {
        textResult = {
          baseContent: normalized,
          newContent: normalized,
          matchNotes: [],
          replacementCount: 0,
          matchSpans: [],
        };
      } else {
        throw err;
      }
    }
    for (const span of textResult.matchSpans) {
      mutations.push({
        startByte: span.matchIndex,
        endByte: span.matchIndex + span.matchLength,
        replacement: span.newText,
        requestIndex: textOriginalIndex[span.editIndex],
        capability: "oldText",
        note: span.matchNote,
      });
      matchSpans.push({ ...span, editIndex: textOriginalIndex[span.editIndex] });
    }
    for (const note of textResult.matchNotes) matchNotes.push(note);
  }

  // ── Symbolic edits: reuse applySymbolicEdits resolution ────────────
  // Resolve each symbolic edit independently so same-position zero-length
  // inserts are not rejected by the engine's cross-edit overlap check; the
  // unified applyMutations below owns overlap/ordering.
  if (symbolicEdits.length > 0) {
    for (let i = 0; i < symbolicEdits.length; i++) {
      const edit = symbolicEdits[i];
      const t = edit.target;
      if (!t) {
        throw new Error(`edits[${symbolicOriginalIndex[i]}] symbolic edit requires a target`);
      }
      const op =
        t.replaceBody !== undefined
          ? "replaceBody"
          : t.insertBefore !== undefined
            ? "insertBefore"
            : "insertAfter";
      const body = t[op];
      if (typeof body !== "string") {
        throw new Error(`edits[${symbolicOriginalIndex[i]}] ${op} must be a string`);
      }
      const symbolicResult = await applySymbolicEdits({
        content: normalized,
        filePath: args.filePath,
        astResolver: args.astResolver as never,
        edits: [{ editIdx: symbolicOriginalIndex[i], target: t }],
      });
      const applied = symbolicResult.applied[0];
      // Guard a missing applied entry: the engine reported success but resolved
      // no span (e.g. an out-of-scope or malformed symbol). Fail with an
      // actionable diagnostic instead of a TypeError on `applied.startIndex`.
      if (!applied) {
        throw new Error(
          `edits[${symbolicOriginalIndex[i]}] symbolic ${op} produced no applied span in ${args.filePath}`,
        );
      }
      // applySymbolicEdits reports the whole symbol span in matchSpans even for
      // inserts; derive the true zero-length insert position from `applied`.
      const startByte =
        op === "replaceBody" ? applied.startIndex : op === "insertAfter" ? applied.endIndex : applied.startIndex;
      const endByte = op === "replaceBody" ? applied.endIndex : startByte;
      const scope = symbolicScopes[i];
      if (scope && (startByte < scope.startIndex || endByte > scope.endIndex)) {
        throw new Error(
          `edits[${symbolicOriginalIndex[i]}] symbolic ${op} span [${startByte},${endByte}) falls outside the explicit scope (${scope.description}) in ${args.filePath}`,
        );
      }
      const replacement = normalizeToLF(body);
      mutations.push({
        startByte,
        endByte,
        replacement,
        requestIndex: symbolicOriginalIndex[i],
        capability: "symbolicEdit",
        note: `symbolic ${op} on ${applied.symbolName}`,
      });
      matchSpans.push({
        editIndex: symbolicOriginalIndex[i],
        matchIndex: startByte,
        matchLength: endByte - startByte,
        newText: replacement,
        tier: "exact" as MatchSpan["tier"],
        replaceAll: false,
        matchNote: `symbolic ${op} on ${applied.symbolName}`,
      });
    }
  }

  // ── Structural edits: reuse ast-grep resolution, scoped ────────────
  if (structuralEdits.length > 0) {
    const resolver = args.structuralResolver ?? defaultStructuralResolver;
    for (let i = 0; i < structuralEdits.length; i++) {
      const edit = structuralEdits[i];
      const t = edit.target;
      if (!t) {
        throw new Error(`edits[${structuralOriginalIndex[i]}] structural edit requires a target`);
      }
      const pattern = t.pattern;
      const replacement = t.replacement;
      if (typeof pattern !== "string" || typeof replacement !== "string") {
        throw new Error(
          `edits[${structuralOriginalIndex[i]}] structural edit requires pattern and replacement`,
        );
      }
      const scope = structuralScopes[i];
      const result = await resolver.resolve(normalized, args.filePath, pattern, replacement);
      if (!result.ok) {
        throw new Error(
          `edits[${structuralOriginalIndex[i]}] structural edit failed: ${result.error ?? "unknown error"}`,
        );
      }
      const resolvedEdits = (result.edits ?? []).filter(
        (resolved) => !scope
          || (resolved.startByte >= scope.startIndex && resolved.endByte <= scope.endIndex),
      );
      if (resolvedEdits.length === 0) {
        const scopeDetail = scope ? ` within explicit scope (${scope.description})` : "";
        throw new Error(
          `edits[${structuralOriginalIndex[i]}] structural pattern "${pattern}" matched nothing${scopeDetail} in ${args.filePath}`,
        );
      }
      for (const e of resolvedEdits) {
        mutations.push({
          startByte: e.startByte,
          endByte: e.endByte,
          replacement: normalizeToLF(e.text),
          requestIndex: structuralOriginalIndex[i],
          capability: "astGrepAnchor",
        });
        matchSpans.push({
          editIndex: structuralOriginalIndex[i],
          matchIndex: e.startByte,
          matchLength: Math.max(e.endByte - e.startByte, 0),
          newText: normalizeToLF(e.text),
          tier: "exact" as MatchSpan["tier"],
          replaceAll: false,
          matchNote: `structural pattern "${t.pattern}"`,
        });
      }
    }
  }

  // ── Hashline edits: reuse applyHashlinePath routing ────────────────
  // Each hashline edit resolves against the immutable LF-normalized snapshot
  // into one ResolvedMutation span (the actual changed region), so mixed
  // hashline/text/symbolic/structural batches share overlap rejection,
  // descending application, BOM+CRLF preservation, and preimage range
  // authorization. The fallback's actual changed span is derived from the
  // before/after content, so a stale hashline fallback can never broaden a
  // selected prior line-range authority beyond its real changed region.
  if (hashlineEdits.length > 0) {
    const getSnapshot = args.getSnapshot ?? (() => null);
    // applyHashlinePath passes a scope without the `source` field; findText
    // only reads startIndex/endIndex/description, so adapt with a cast.
    const findTextFn = (
      content: string,
      oldText: string,
      indentStyle: { char: "\t" | " "; width: number },
      startOffset?: number,
      scope?: { startIndex: number; endIndex: number; description: string },
    ) => findText(content, oldText, indentStyle, startOffset, scope as SearchScope | undefined);
    const resolveScopeFn = async (
      anchor: EditAnchor,
      content: string,
      _path: string,
    ): Promise<{ startIndex: number; endIndex: number; description: string } | null> => {
      const scope = await resolveAnchorToScope(
        { anchor } as EditItem,
        content,
        args.filePath,
        args.astResolver,
      );
      return scope
        ? { startIndex: scope.startIndex, endIndex: scope.endIndex, description: scope.description }
        : null;
    };
    for (let i = 0; i < hashlineEdits.length; i++) {
      const edit = hashlineEdits[i];
      const h = edit.hashline;
      if (!h) continue;
      const input: HashlineEditInput = {
        anchor: { range: h.range, symbol: h.symbol },
        content: h.content ?? null,
      };
      const snapshot = getSnapshot(args.filePath);
      const result = await applyHashlinePath(
        input,
        normalized,
        snapshot,
        resolveScopeFn,
        findTextFn,
        detectIndentation,
      );
      const { startByte, endByte, replacement } = computeChangedSpan(normalized, result.newContent);
      // A hashline whose target already matches (no before/after change) is a
      // no-op: skip its mutation/span so it cannot inject an empty insert into
      // the overlap check or mislead coverage in a mixed batch. When it is the
      // only edit the final no-changes guard reports the no-op.
      if (startByte === endByte && replacement === "") continue;
      const scope = hashlineScopes[i];
      if (scope && (startByte < scope.startIndex || endByte > scope.endIndex)) {
        throw new Error(
          `edits[${hashlineOriginalIndex[i]}] hashline ${result.tier} span [${startByte},${endByte}) falls outside the explicit scope (${scope.description}) in ${args.filePath}`,
        );
      }
      mutations.push({
        startByte,
        endByte,
        replacement,
        requestIndex: hashlineOriginalIndex[i],
        capability: "hashline",
        note: `hashline ${result.tier}${result.warnings.length ? ` (${result.warnings.join("; ")})` : ""}`,
      });
      matchSpans.push({
        editIndex: hashlineOriginalIndex[i],
        matchIndex: startByte,
        matchLength: endByte - startByte,
        newText: replacement,
        tier: "exact" as MatchSpan["tier"],
        replaceAll: false,
        matchNote: `hashline ${result.tier}`,
      });
      for (const w of result.warnings) matchNotes.push(w);
    }
  }

  // ── Unified overlap check + descending apply against the snapshot ──
  const newContentNormalized = applyMutations(normalized, mutations, args.filePath);

  if (newContentNormalized === normalized) {
    throw new Error(
      `No changes made to ${args.filePath}. The replacements produced identical content.`,
    );
  }

  let newContent = restoreLineEndings(newContentNormalized, lineEnding);
  newContent = bom + newContent;

  // Newline-offset index built once per normalized snapshot; binary searches
  // map byte spans to 1-based inclusive line ranges, preserving the original
  // semantics (line = 1 + newlines strictly before the byte).
  const newlineOffsets = buildNewlineOffsets(normalized);
  const preimageLineRanges = mutations.map((m) =>
    byteSpanToLineRange(newlineOffsets, m.startByte, m.endByte - m.startByte),
  );

  // Postimage ranges live in a different coordinate space than preimage
  // ranges: an earlier mutation that inserts/deletes lines shifts the line
  // numbers of every mutation after it in the final text. Compute each
  // mutation's postimage byte span by accumulating the length delta of every
  // mutation that lands before it (by startByte, then by requestIndex for
  // same-position inserts) — the same ordering applyMutations uses to build
  // newContentNormalized — then map those spans to line numbers against the
  // POST-edit snapshot.
  const postNewlineOffsets = buildNewlineOffsets(newContentNormalized);
  const postimageLineRanges = computePostimageLineRanges(mutations, postNewlineOffsets);

  const capabilities: EditCapability[] = [];
  if (textEdits.length > 0) capabilities.push("oldText");
  if (args.edits.some((e) => e.replaceAll)) capabilities.push("replaceAll");
  if (args.edits.some((e) => e.target)) capabilities.push("astAnchor");
  if (symbolicEdits.length > 0) capabilities.push("symbolicEdit");
  if (structuralEdits.length > 0) capabilities.push("astGrepAnchor");
  if (hashlineEdits.length > 0) capabilities.push("hashline");

  return {
    newContent,
    matchSpans,
    preimageLineRanges,
    postimageLineRanges,
    matchNotes,
    capabilities,
  };
}

/**
 * Map each mutation's preimage byte span to its postimage line range.
 * Mutations are processed in ascending (startByte, requestIndex) order — the
 * same tie-break applyMutations uses when splicing same-position zero-length
 * inserts — while accumulating the running length delta so every mutation's
 * postimage start byte reflects every earlier mutation's net size change.
 * Results are returned index-aligned with the input `mutations` array (not
 * in the ascending order used internally to compute them).
 */
function computePostimageLineRanges(
  mutations: ResolvedMutation[],
  postNewlineOffsets: number[],
): LineRange[] {
  const order = mutations.map((_, i) => i).sort((a, b) => {
    const byStart = mutations[a].startByte - mutations[b].startByte;
    if (byStart !== 0) return byStart;
    return mutations[a].requestIndex - mutations[b].requestIndex;
  });
  const result: LineRange[] = new Array<LineRange>(mutations.length);
  let delta = 0;
  for (const idx of order) {
    const m = mutations[idx];
    const postStart = m.startByte + delta;
    const postLength = m.replacement.length;
    result[idx] = byteSpanToLineRange(postNewlineOffsets, postStart, postLength);
    delta += postLength - (m.endByte - m.startByte);
  }
  return result;
}

/**
 * Resolve an edit's explicit scope (AST target and/or lineRange) to a byte
 * range. Returns undefined when the edit carries no explicit scope. Throws an
 * actionable diagnostic when an explicit scope cannot be resolved or the
 * AST/lineRange intersection is empty — never falls back to whole-file.
 */
async function resolveEditScope(
  edit: EditItem,
  normalized: string,
  filePath: string,
  astResolver: AstResolverLike | null,
  index: number,
): Promise<SearchScope | undefined> {
  const t = edit.target;
  const hasAstIdentifier =
    !!t &&
    (t.name !== undefined || t.namePath !== undefined || t.line !== undefined || t.kind !== undefined);
  const hasTarget = hasAstIdentifier;
  const hasLineRange = !!edit.lineRange;
  if (!hasTarget && !hasLineRange) return undefined;

  let astScope: SearchScope | null = null;
  if (hasTarget) {
    if (!astResolver) {
      throw new Error(
        `edits[${index}] requires AST support to resolve target.name/namePath/kind/line in ${filePath}`,
      );
    }
    const resolveDiag: AnchorResolutionDiagnostics = {};
    astScope = await resolveAnchorToScope(edit, normalized, filePath, astResolver, resolveDiag);
    if (!astScope) {
      const parseHint = resolveDiag.parseError ? ` ${resolveDiag.parseError}` : "";
      throw new Error(
        `edits[${index}] could not resolve AST target${edit.description ? ` (${edit.description})` : ""} in ${filePath}.${parseHint} ` +
          `Provide a resolvable target.name/namePath/kind/line or re-inspect the file.`,
      );
    }
  }

  let lineScope: SearchScope | null = null;
  const lineRange = edit.lineRange;
  if (lineRange) {
    lineScope = lineRangeToScope(normalized, lineRange);
    if (!lineScope) {
      throw new Error(
        `edits[${index}] lineRange [${lineRange.startLine},${lineRange.endLine}] is out of range for ${filePath} ` +
          `(${normalized.split("\n").length} lines).`,
      );
    }
  }

  let scope = astScope;
  if (lineScope) {
    scope = scope ? intersectScopes(scope, lineScope) : lineScope;
  }
  if (!scope) {
    throw new Error(
      `edits[${index}] AST target and lineRange scopes do not intersect in ${filePath}. ` +
        `Narrow the target or lineRange so they overlap.`,
    );
  }
  return scope;
}

/**
 * Check for overlapping replacement spans and apply all mutations descending
 * against the snapshot. Rejects intersecting non-zero spans and any zero-length
 * insert that sits at the boundary of a non-zero span (ambiguous same-position
 * operation). Same-position zero-length inserts preserve request order.
 */
function applyMutations(snapshot: string, mutations: ResolvedMutation[], filePath: string): string {
  const nonZero = mutations.filter((m) => m.endByte > m.startByte);
  const inserts = mutations.filter((m) => m.endByte === m.startByte);

  // Non-zero spans must not intersect.
  const sortedNonZero = [...nonZero].sort((a, b) => a.startByte - b.startByte);
  for (let i = 1; i < sortedNonZero.length; i++) {
    const prev = sortedNonZero[i - 1];
    const curr = sortedNonZero[i];
    if (prev.endByte > curr.startByte) {
      throw new Error(
        `edits[${prev.requestIndex}] and edits[${curr.requestIndex}] overlap in ${filePath}. ` +
          `Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  // A zero-length insert at the boundary of a non-zero span is ambiguous.
  for (const ins of inserts) {
    for (const nz of nonZero) {
      if (ins.startByte >= nz.startByte && ins.startByte <= nz.endByte) {
        throw new Error(
          `edits[${ins.requestIndex}] insert at byte ${ins.startByte} is ambiguous with ` +
            `edits[${nz.requestIndex}] span [${nz.startByte},${nz.endByte}) in ${filePath}. ` +
            `Move the insert to a disjoint position.`,
        );
      }
    }
  }

  // Apply descending by start byte; for same-position inserts, apply higher
  // request index first so lower request index appears first (request order).
  const applyOrder = [...mutations].sort((a, b) => {
    if (b.startByte !== a.startByte) return b.startByte - a.startByte;
    return b.requestIndex - a.requestIndex;
  });

  let result = snapshot;
  for (const m of applyOrder) {
    result = result.slice(0, m.startByte) + m.replacement + result.slice(m.endByte);
  }
  return result;
}

/**
 * Compute the minimal changed span between two LF-normalized strings and the
 * replacement text that reproduces `b` from `a`. `startByte`/`endByte` are
 * offsets into `a` (the immutable snapshot); `replacement` is the new text.
 * A pure insertion yields a zero-length span with the inserted text.
 */
function computeChangedSpan(a: string, b: string): {
  startByte: number;
  endByte: number;
  replacement: string;
} {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = a.length - 1;
  let k = b.length - 1;
  while (j >= i && k >= i && a[j] === b[k]) {
    j--;
    k--;
  }
  return { startByte: i, endByte: j + 1, replacement: b.slice(i, k + 1) };
}

/**
 * Build the sorted byte offsets of every "\n" in an LF-normalized snapshot.
 */
function buildNewlineOffsets(content: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") offsets.push(i);
  return offsets;
}

/**
 * Number of sorted entries strictly less than `target` (upper-bound binary search).
 */
function countLessThan(sorted: number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Convert a byte span into a 1-based inclusive preimage line range. */
function byteSpanToLineRange(newlineOffsets: number[], start: number, length: number): LineRange {
  const startLine = 1 + countLessThan(newlineOffsets, start);
  const endLine = length > 0
    ? 1 + countLessThan(newlineOffsets, start + length - 1)
    : startLine;
  return { startLine, endLine };
}

/** Map a file path to an ast-grep-compatible language id, or null. */
function languageIdForStructural(filePath: string): string | null {
  const ext = filePath.toLowerCase();
  if (ext.endsWith(".ts") || ext.endsWith(".mts") || ext.endsWith(".cts")) return "typescript";
  if (ext.endsWith(".tsx")) return "tsx";
  if (ext.endsWith(".js") || ext.endsWith(".mjs") || ext.endsWith(".cjs")) return "javascript";
  if (ext.endsWith(".jsx")) return "jsx";
  if (ext.endsWith(".py")) return "python";
  if (ext.endsWith(".json")) return "json";
  if (ext.endsWith(".css")) return "css";
  if (ext.endsWith(".html")) return "html";
  if (ext.endsWith(".md")) return "markdown";
  if (ext.endsWith(".yaml") || ext.endsWith(".yml")) return "yaml";
  if (ext.endsWith(".sql")) return "sql";
  if (ext.endsWith(".rs")) return "rust";
  if (ext.endsWith(".go")) return "go";
  if (ext.endsWith(".java")) return "java";
  if (ext.endsWith(".rb")) return "ruby";
  if (ext.endsWith(".php")) return "php";
  if (ext.endsWith(".c")) return "c";
  if (ext.endsWith(".cpp") || ext.endsWith(".cc") || ext.endsWith(".h")) return "cpp";
  if (ext.endsWith(".cs")) return "csharp";
  if (ext.endsWith(".swift")) return "swift";
  if (ext.endsWith(".kt") || ext.endsWith(".kts")) return "kotlin";
  if (ext.endsWith(".sh") || ext.endsWith(".bash")) return "bash";
  return null;
}
