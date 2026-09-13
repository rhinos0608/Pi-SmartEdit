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
 *   `applySymbolicEdits` from ../ast/symbolic-edits.js.
 * - Structural edits (pattern+replacement) reuse ast-grep semantics via
 *   `resolvePatternEdits` from ../ast/astgrep-anchor.js.
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
} from "./edit-diff.js";
import { applyHashlinePath, type HashlineEditInput } from "../hashline/hashline-edit.js";
import {
  resolveAnchorToScope,
  lineRangeToScope,
  intersectScopes,
  type AstResolverLike,
  type AnchorResolutionDiagnostics,
} from "../anchor/anchor-resolution.js";
import { applySymbolicEdits } from "../ast/symbolic-edits.js";
import { isAstGrepAvailable, resolvePatternEdits } from "../ast/astgrep-anchor.js";
import type {
  EditItem,
  EditAnchor,
  MatchSpan,
  LineRange,
  SearchScope,
  EditCapability,
  FileSnapshot,
} from "./types.js";

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

/** Classified edit buckets with index alignment into the original edits array. */
interface ClassifiedEdits {
  textEdits: EditItem[];
  textOriginalIndex: number[];
  symbolicEdits: EditItem[];
  symbolicOriginalIndex: number[];
  structuralEdits: EditItem[];
  structuralOriginalIndex: number[];
  hashlineEdits: EditItem[];
  hashlineOriginalIndex: number[];
}

/** LF-normalized snapshot with BOM/line-ending preservation metadata. */
interface NormalizedSnapshot {
  bom: string;
  normalized: string;
  lineEnding: string;
}

/** Resolved explicit scopes, index-aligned with each classified bucket. */
interface ResolvedScopes {
  textScopes: (SearchScope | undefined)[];
  symbolicScopes: (SearchScope | undefined)[];
  structuralScopes: (SearchScope | undefined)[];
  hashlineScopes: (SearchScope | undefined)[];
}

/** One batch contribution: mutations plus engine spans/notes. */
interface BatchMutations {
  mutations: ResolvedMutation[];
  matchSpans: MatchSpan[];
  matchNotes: string[];
}

/** Split mixed operations into text/symbolic/structural/hashline buckets. */
function classifyEdits(edits: EditItem[]): ClassifiedEdits {
  const classified: ClassifiedEdits = {
    textEdits: [],
    textOriginalIndex: [],
    symbolicEdits: [],
    symbolicOriginalIndex: [],
    structuralEdits: [],
    structuralOriginalIndex: [],
    hashlineEdits: [],
    hashlineOriginalIndex: [],
  };
  for (let i = 0; i < edits.length; i++) {
    classifyOneEdit(edits[i], i, classified);
  }
  return classified;
}

/** Route one operation into its bucket; validates text/symbolic shape. */
function classifyOneEdit(edit: EditItem, index: number, classified: ClassifiedEdits): void {
  if (edit.hashline) {
    classified.hashlineEdits.push(edit);
    classified.hashlineOriginalIndex.push(index);
    return;
  }
  const t = edit.target;
  if (isSymbolicTarget(t) && isStructuralTarget(t)) {
    throw new Error(`edits[${index}] cannot be both symbolic and structural`);
  }
  if (isSymbolicTarget(t)) {
    classified.symbolicEdits.push(edit);
    classified.symbolicOriginalIndex.push(index);
  } else if (isStructuralTarget(t)) {
    classified.structuralEdits.push(edit);
    classified.structuralOriginalIndex.push(index);
  } else {
    requireTextShape(edit, index);
    classified.textEdits.push(edit);
    classified.textOriginalIndex.push(index);
  }
}

/** True when the target carries a symbolic operation field. */
function isSymbolicTarget(t: EditItem["target"]): boolean {
  return !!t
    && (t.replaceBody !== undefined || t.insertBefore !== undefined || t.insertAfter !== undefined);
}

/** True when the target carries a structural pattern field. */
function isStructuralTarget(t: EditItem["target"]): boolean {
  return !!t && t.pattern !== undefined;
}

/** Reject a text-routed operation missing its required payload. */
function requireTextShape(edit: EditItem, index: number): void {
  if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
    throw new Error(`edits[${index}] missing oldText/newText`);
  }
}

/** Strip BOM, normalize to LF, and capture restoration metadata. */
function snapshotContent(content: string): NormalizedSnapshot {
  const { bom, text } = stripBom(content);
  return { bom, normalized: normalizeToLF(text), lineEnding: detectLineEnding(content) };
}

/** Resolve one bucket's explicit scopes in order. */
async function resolveScopeBucket(
  bucket: EditItem[],
  originalIndex: number[],
  normalized: string,
  filePath: string,
  astResolver: AstResolverLike | null,
): Promise<(SearchScope | undefined)[]> {
  const scopes: (SearchScope | undefined)[] = [];
  for (let i = 0; i < bucket.length; i++) {
    scopes.push(await resolveEditScope(bucket[i], normalized, filePath, astResolver, originalIndex[i]));
  }
  return scopes;
}

/** Resolve explicit scopes for every bucket; explicit scopes never fall back. */
async function resolveAllScopes(
  classified: ClassifiedEdits,
  normalized: string,
  filePath: string,
  astResolver: AstResolverLike | null,
): Promise<ResolvedScopes> {
  return {
    textScopes: await resolveScopeBucket(
      classified.textEdits,
      classified.textOriginalIndex,
      normalized,
      filePath,
      astResolver,
    ),
    symbolicScopes: await resolveScopeBucket(
      classified.symbolicEdits,
      classified.symbolicOriginalIndex,
      normalized,
      filePath,
      astResolver,
    ),
    structuralScopes: await resolveScopeBucket(
      classified.structuralEdits,
      classified.structuralOriginalIndex,
      normalized,
      filePath,
      astResolver,
    ),
    hashlineScopes: await resolveScopeBucket(
      classified.hashlineEdits,
      classified.hashlineOriginalIndex,
      normalized,
      filePath,
      astResolver,
    ),
  };
}

/** True when a resolved span escapes its explicit scope (no scope = unconstrained). */
function spanOutsideScope(
  scope: SearchScope | undefined,
  startByte: number,
  endByte: number,
): boolean {
  return !!scope && (startByte < scope.startIndex || endByte > scope.endIndex);
}

/** Throw when a resolved span escapes its explicit scope; a missing scope never throws. */
function assertSpanInScope(
  scope: SearchScope | undefined,
  startByte: number,
  endByte: number,
  editRef: number,
  kind: string,
  filePath: string,
): void {
  if (spanOutsideScope(scope, startByte, endByte)) {
    throw new Error(
      `edits[${editRef}] ${kind} span [${startByte},${endByte}) falls outside the explicit scope (${scope?.description}) in ${filePath}`,
    );
  }
}

/** Rethrow a text-batch failure unless it is a no-change tolerated by other buckets. */
function throwUnlessToleratedTextNoChange(err: unknown, hasOtherEdits: boolean): void {
  const msg = err instanceof Error ? err.message : String(err);
  const isNoChange = /^No changes made to/.test(msg);
  // A text-only no-change is a real failure; but when symbolic/structural
  // or hashline edits are present, a no-op text batch must not abort the
  // whole plan.
  if (isNoChange && hasOtherEdits) return;
  throw err;
}

/** Plan the text bucket via the applyEdits engine. A no-op text batch is
 * tolerated only when another bucket may still produce the change; a
 * text-only no-change is a real failure. */
async function collectTextMutations(
  normalized: string,
  filePath: string,
  textEdits: EditItem[],
  textScopes: (SearchScope | undefined)[],
  textOriginalIndex: number[],
  hasOtherEdits: boolean,
): Promise<BatchMutations> {
  const batch: BatchMutations = { mutations: [], matchSpans: [], matchNotes: [] };
  if (textEdits.length === 0) return batch;
  let textResult: {
    baseContent: string;
    newContent: string;
    matchNotes: string[];
    replacementCount: number;
    matchSpans: MatchSpan[];
  };
  try {
    textResult = await applyEdits(normalized, textEdits, filePath, {
      searchScopes: textScopes,
    });
  } catch (err) {
    throwUnlessToleratedTextNoChange(err, hasOtherEdits);
    return batch;
  }
  for (const span of textResult.matchSpans) {
    batch.mutations.push({
      startByte: span.matchIndex,
      endByte: span.matchIndex + span.matchLength,
      replacement: span.newText,
      requestIndex: textOriginalIndex[span.editIndex],
      capability: "oldText",
      note: span.matchNote,
    });
    batch.matchSpans.push({ ...span, editIndex: textOriginalIndex[span.editIndex] });
  }
  for (const note of textResult.matchNotes) batch.matchNotes.push(note);
  return batch;
}

/** Symbolic operation selected from a validated target (replace wins over inserts). */
type SymbolicOp = "replaceBody" | "insertBefore" | "insertAfter";

/** Pick the symbolic operation from its target shape. */
function symbolicOpOf(t: NonNullable<EditItem["target"]>): SymbolicOp {
  if (t.replaceBody !== undefined) return "replaceBody";
  return t.insertBefore !== undefined ? "insertBefore" : "insertAfter";
}

/** Derive the true mutation span: whole symbol for replace, zero-length
 * insert position for insertBefore/insertAfter. */
function symbolicSpanOf(
  op: SymbolicOp,
  applied: { startIndex: number; endIndex: number },
): { startByte: number; endByte: number } {
  // applySymbolicEdits reports the whole symbol span in matchSpans even for
  // inserts; derive the true zero-length insert position from `applied`.
  const startByte =
    op === "replaceBody" ? applied.startIndex : op === "insertAfter" ? applied.endIndex : applied.startIndex;
  return { startByte, endByte: op === "replaceBody" ? applied.endIndex : startByte };
}

/** Resolve one symbolic edit to its mutation plus engine span. */
async function resolveSymbolicMutation(
  normalized: string,
  filePath: string,
  astResolver: AstResolverLike | null,
  edit: EditItem,
  scope: SearchScope | undefined,
  editRef: number,
): Promise<{ mutation: ResolvedMutation; span: MatchSpan }> {
  const t = edit.target;
  if (!t) {
    throw new Error(`edits[${editRef}] symbolic edit requires a target`);
  }
  const op = symbolicOpOf(t);
  const body = t[op];
  if (typeof body !== "string") {
    throw new Error(`edits[${editRef}] ${op} must be a string`);
  }
  const symbolicResult = await applySymbolicEdits({
    content: normalized,
    filePath,
    astResolver: astResolver as never,
    edits: [{ editIdx: editRef, target: t }],
  });
  const applied = symbolicResult.applied[0];
  // Guard a missing applied entry: the engine reported success but resolved
  // no span (e.g. an out-of-scope or malformed symbol). Fail with an
  // actionable diagnostic instead of a TypeError on `applied.startIndex`.
  if (!applied) {
    throw new Error(
      `edits[${editRef}] symbolic ${op} produced no applied span in ${filePath}`,
    );
  }
  // applySymbolicEdits reports the whole symbol span in matchSpans even for
  // inserts; derive the true zero-length insert position from `applied`.
  const { startByte, endByte } = symbolicSpanOf(op, applied);
  assertSpanInScope(scope, startByte, endByte, editRef, `symbolic ${op}`, filePath);
  const replacement = normalizeToLF(body);
  const note = `symbolic ${op} on ${applied.symbolName}`;
  return {
    mutation: {
      startByte,
      endByte,
      replacement,
      requestIndex: editRef,
      capability: "symbolicEdit",
      note,
    },
    span: {
      editIndex: editRef,
      matchIndex: startByte,
      matchLength: endByte - startByte,
      newText: replacement,
      tier: "exact" as MatchSpan["tier"],
      replaceAll: false,
      matchNote: note,
    },
  };
}

/** Plan the symbolic bucket, resolving each edit independently so
 * same-position zero-length inserts are not rejected by the engine's
 * cross-edit overlap check; the unified applyMutations below owns
 * overlap/ordering. */
async function collectSymbolicMutations(
  normalized: string,
  filePath: string,
  astResolver: AstResolverLike | null,
  symbolicEdits: EditItem[],
  symbolicScopes: (SearchScope | undefined)[],
  symbolicOriginalIndex: number[],
): Promise<BatchMutations> {
  const batch: BatchMutations = { mutations: [], matchSpans: [], matchNotes: [] };
  for (let i = 0; i < symbolicEdits.length; i++) {
    const { mutation, span } = await resolveSymbolicMutation(
      normalized,
      filePath,
      astResolver,
      symbolicEdits[i],
      symbolicScopes[i],
      symbolicOriginalIndex[i],
    );
    batch.mutations.push(mutation);
    batch.matchSpans.push(span);
  }
  return batch;
}

/** Validate a structural target into its pattern/replacement strings. */
function requireStructuralPayload(
  t: EditItem["target"],
  editRef: number,
): { pattern: string; replacement: string } {
  if (!t) {
    throw new Error(`edits[${editRef}] structural edit requires a target`);
  }
  const pattern = t.pattern;
  const replacement = t.replacement;
  if (typeof pattern !== "string" || typeof replacement !== "string") {
    throw new Error(
      `edits[${editRef}] structural edit requires pattern and replacement`,
    );
  }
  return { pattern, replacement };
}

/** Keep only resolved spans inside the explicit scope (no scope = unconstrained). */
function filterStructuralToScope<T extends { startByte: number; endByte: number }>(
  edits: readonly T[] | undefined,
  scope: SearchScope | undefined,
): T[] {
  return (edits ?? []).filter(
    (resolved) => !scope
      || (resolved.startByte >= scope.startIndex && resolved.endByte <= scope.endIndex),
  );
}

/** Throw when a structural pattern matched nothing (naming the scope when present). */
function requireStructuralMatches<T>(
  resolvedEdits: T[],
  pattern: string,
  scope: SearchScope | undefined,
  editRef: number,
  filePath: string,
): T[] {
  if (resolvedEdits.length === 0) {
    const scopeDetail = scope ? ` within explicit scope (${scope.description})` : "";
    throw new Error(
      `edits[${editRef}] structural pattern "${pattern}" matched nothing${scopeDetail} in ${filePath}`,
    );
  }
  return resolvedEdits;
}

/** Plan one structural edit: resolve via ast-grep, filter to the explicit scope. */
async function collectOneStructuralMutation(
  batch: BatchMutations,
  normalized: string,
  filePath: string,
  resolver: StructuralResolver,
  edit: EditItem,
  scope: SearchScope | undefined,
  editRef: number,
): Promise<void> {
  const { pattern, replacement } = requireStructuralPayload(edit.target, editRef);
  const result = await resolver.resolve(normalized, filePath, pattern, replacement);
  if (!result.ok) {
    throw new Error(
      `edits[${editRef}] structural edit failed: ${result.error ?? "unknown error"}`,
    );
  }
  const resolvedEdits = requireStructuralMatches(
    filterStructuralToScope(result.edits, scope),
    pattern,
    scope,
    editRef,
    filePath,
  );
  for (const e of resolvedEdits) {
    batch.mutations.push({
      startByte: e.startByte,
      endByte: e.endByte,
      replacement: normalizeToLF(e.text),
      requestIndex: editRef,
      capability: "astGrepAnchor",
    });
    batch.matchSpans.push({
      editIndex: editRef,
      matchIndex: e.startByte,
      matchLength: Math.max(e.endByte - e.startByte, 0),
      newText: normalizeToLF(e.text),
      tier: "exact" as MatchSpan["tier"],
      replaceAll: false,
      matchNote: `structural pattern "${pattern}"`,
    });
  }
}

/** Plan the structural bucket via the ast-grep resolver, scoped per edit. */
async function collectStructuralMutations(
  normalized: string,
  filePath: string,
  resolver: StructuralResolver,
  structuralEdits: EditItem[],
  structuralScopes: (SearchScope | undefined)[],
  structuralOriginalIndex: number[],
): Promise<BatchMutations> {
  const batch: BatchMutations = { mutations: [], matchSpans: [], matchNotes: [] };
  for (let i = 0; i < structuralEdits.length; i++) {
    await collectOneStructuralMutation(
      batch,
      normalized,
      filePath,
      resolver,
      structuralEdits[i],
      structuralScopes[i],
      structuralOriginalIndex[i],
    );
  }
  return batch;
}

/** Adapter: applyHashlinePath passes a scope without the `source` field; findText
 * only reads startIndex/endIndex/description, so adapt with a cast. */
function makeHashlineFindText(): (
  content: string,
  oldText: string,
  indentStyle: { char: "\t" | " "; width: number },
  startOffset?: number,
  scope?: { startIndex: number; endIndex: number; description: string },
) => {
  found: boolean;
  index: number;
  matchLength: number;
  tier: string;
  usedFuzzyMatch: boolean;
  matchedText: string;
  matchNote?: string;
} {
  return (content, oldText, indentStyle, startOffset?, scope?) =>
    findText(content, oldText, indentStyle, startOffset, scope as SearchScope | undefined);
}

/** Adapter: resolve an anchor to a plain index range for the hashline path. */
function makeHashlineScopeResolver(
  filePath: string,
  astResolver: AstResolverLike | null,
): (
  anchor: EditAnchor,
  content: string,
  path: string,
) => Promise<{ startIndex: number; endIndex: number; description: string } | null> {
  return async (anchor, content, _path) => {
    const scope = await resolveAnchorToScope(
      { anchor } as EditItem,
      content,
      filePath,
      astResolver,
    );
    return scope
      ? { startIndex: scope.startIndex, endIndex: scope.endIndex, description: scope.description }
      : null;
  };
}

/** Plan one hashline edit against the immutable snapshot into its actual changed span. */
async function collectOneHashlineMutation(
  batch: BatchMutations,
  normalized: string,
  filePath: string,
  findTextFn: ReturnType<typeof makeHashlineFindText>,
  resolveScopeFn: ReturnType<typeof makeHashlineScopeResolver>,
  getSnapshot: (path: string) => FileSnapshot | null,
  edit: EditItem,
  scope: SearchScope | undefined,
  editRef: number,
): Promise<void> {
  const h = edit.hashline;
  if (!h) return;
  const input: HashlineEditInput = {
    anchor: { range: h.range, symbol: h.symbol },
    content: h.content ?? null,
  };
  const snapshot = getSnapshot(filePath);
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
  if (startByte === endByte && replacement === "") return;
  assertSpanInScope(scope, startByte, endByte, editRef, `hashline ${result.tier}`, filePath);
  batch.mutations.push({
    startByte,
    endByte,
    replacement,
    requestIndex: editRef,
    capability: "hashline",
    note: `hashline ${result.tier}${result.warnings.length ? ` (${result.warnings.join("; ")})` : ""}`,
  });
  batch.matchSpans.push({
    editIndex: editRef,
    matchIndex: startByte,
    matchLength: endByte - startByte,
    newText: replacement,
    tier: "exact" as MatchSpan["tier"],
    replaceAll: false,
    matchNote: `hashline ${result.tier}`,
  });
  for (const w of result.warnings) batch.matchNotes.push(w);
}

/** Plan the hashline bucket: each edit resolves against the immutable
 * LF-normalized snapshot into one ResolvedMutation span (the actual changed
 * region), so mixed batches share overlap rejection, descending application,
 * BOM+CRLF preservation, and preimage range authorization. The fallback's
 * actual changed span is derived from the before/after content, so a stale
 * hashline fallback can never broaden a selected prior line-range authority
 * beyond its real changed region. */
async function collectHashlineMutations(
  normalized: string,
  filePath: string,
  astResolver: AstResolverLike | null,
  getSnapshot: (path: string) => FileSnapshot | null,
  hashlineEdits: EditItem[],
  hashlineScopes: (SearchScope | undefined)[],
  hashlineOriginalIndex: number[],
): Promise<BatchMutations> {
  const batch: BatchMutations = { mutations: [], matchSpans: [], matchNotes: [] };
  if (hashlineEdits.length === 0) return batch;
  const findTextFn = makeHashlineFindText();
  const resolveScopeFn = makeHashlineScopeResolver(filePath, astResolver);
  for (let i = 0; i < hashlineEdits.length; i++) {
    await collectOneHashlineMutation(
      batch,
      normalized,
      filePath,
      findTextFn,
      resolveScopeFn,
      getSnapshot,
      hashlineEdits[i],
      hashlineScopes[i],
      hashlineOriginalIndex[i],
    );
  }
  return batch;
}

/** Capability ledger: one entry per bucket present, plus replaceAll/astAnchor flags. */
function collectCapabilities(allEdits: EditItem[], classified: ClassifiedEdits): EditCapability[] {
  const capabilities: EditCapability[] = [];
  if (classified.textEdits.length > 0) capabilities.push("oldText");
  if (allEdits.some((e) => e.replaceAll)) capabilities.push("replaceAll");
  if (allEdits.some((e) => e.target)) capabilities.push("astAnchor");
  if (classified.symbolicEdits.length > 0) capabilities.push("symbolicEdit");
  if (classified.structuralEdits.length > 0) capabilities.push("astGrepAnchor");
  if (classified.hashlineEdits.length > 0) capabilities.push("hashline");
  return capabilities;
}

/** Splice mutations, restore BOM/CRLF, and map pre/post line ranges. */
function finalizePlan(
  normalized: string,
  lineEnding: string,
  bom: string,
  filePath: string,
  allEdits: EditItem[],
  classified: ClassifiedEdits,
  mutations: ResolvedMutation[],
  matchSpans: MatchSpan[],
  matchNotes: string[],
): PlannedTextEdits {
  // ── Unified overlap check + descending apply against the snapshot ──
  const newContentNormalized = applyMutations(normalized, mutations, filePath);

  if (newContentNormalized === normalized) {
    throw new Error(
      `No changes made to ${filePath}. The replacements produced identical content.`,
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

  return {
    newContent,
    matchSpans,
    preimageLineRanges,
    postimageLineRanges,
    matchNotes,
    capabilities: collectCapabilities(allEdits, classified),
  };
}

export async function planTextEdits(args: PlanTextEditsArgs): Promise<PlannedTextEdits> {
  // Classify edits into text / symbolic / structural before any matching.
  const classified = classifyEdits(args.edits);
  const { textEdits, textOriginalIndex } = classified;
  const { symbolicEdits, symbolicOriginalIndex } = classified;
  const { structuralEdits, structuralOriginalIndex } = classified;
  const { hashlineEdits, hashlineOriginalIndex } = classified;

  const snapshot = snapshotContent(args.content);
  const bom = snapshot.bom;
  const normalized = snapshot.normalized;
  const lineEnding = snapshot.lineEnding;

  // Resolve explicit scopes (AST target and/or lineRange) for text and
  // structural edits. An explicit scope never falls back to whole-file.
  const scopes = await resolveAllScopes(classified, normalized, args.filePath, args.astResolver);
  const textScopes = scopes.textScopes;
  const symbolicScopes = scopes.symbolicScopes;
  const structuralScopes = scopes.structuralScopes;
  const hashlineScopes = scopes.hashlineScopes;

  const mutations: ResolvedMutation[] = [];
  const matchSpans: MatchSpan[] = [];
  const matchNotes: string[] = [];

  // ── Batch planning: each bucket resolves against the immutable LF-normalized
  // snapshot; the unified apply in finalizePlan owns overlap rejection and ordering ──
  const hasOtherEdits =
    symbolicEdits.length > 0 || structuralEdits.length > 0 || hashlineEdits.length > 0;
  const textBatch = await collectTextMutations(
    normalized,
    args.filePath,
    textEdits,
    textScopes,
    textOriginalIndex,
    hasOtherEdits,
  );
  mutations.push(...textBatch.mutations);
  matchSpans.push(...textBatch.matchSpans);
  matchNotes.push(...textBatch.matchNotes);

  const symbolicBatch = await collectSymbolicMutations(
    normalized,
    args.filePath,
    args.astResolver,
    symbolicEdits,
    symbolicScopes,
    symbolicOriginalIndex,
  );
  mutations.push(...symbolicBatch.mutations);
  matchSpans.push(...symbolicBatch.matchSpans);

  const structuralBatch = await collectStructuralMutations(
    normalized,
    args.filePath,
    args.structuralResolver ?? defaultStructuralResolver,
    structuralEdits,
    structuralScopes,
    structuralOriginalIndex,
  );
  mutations.push(...structuralBatch.mutations);
  matchSpans.push(...structuralBatch.matchSpans);

  const hashlineBatch = await collectHashlineMutations(
    normalized,
    args.filePath,
    args.astResolver,
    args.getSnapshot ?? (() => null),
    hashlineEdits,
    hashlineScopes,
    hashlineOriginalIndex,
  );
  mutations.push(...hashlineBatch.mutations);
  matchSpans.push(...hashlineBatch.matchSpans);
  matchNotes.push(...hashlineBatch.matchNotes);

  return finalizePlan(
    normalized,
    lineEnding,
    bom,
    args.filePath,
    args.edits,
    classified,
    mutations,
    matchSpans,
    matchNotes,
  );
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

/** True when the target carries an AST-identifier field (name/namePath/line/kind). */
function hasAstIdentifier(t: EditItem["target"]): boolean {
  return !!t
    && (t.name !== undefined || t.namePath !== undefined || t.line !== undefined || t.kind !== undefined);
}

/** Resolve the AST-target half of an explicit scope; null when no target fields. */
async function resolveAstTargetScope(
  edit: EditItem,
  normalized: string,
  filePath: string,
  astResolver: AstResolverLike | null,
  index: number,
): Promise<SearchScope | null> {
  if (!hasAstIdentifier(edit.target)) return null;
  if (!astResolver) {
    throw new Error(
      `edits[${index}] requires AST support to resolve target.name/namePath/kind/line in ${filePath}`,
    );
  }
  const resolveDiag: AnchorResolutionDiagnostics = {};
  const astScope = await resolveAnchorToScope(edit, normalized, filePath, astResolver, resolveDiag);
  if (!astScope) {
    const parseHint = resolveDiag.parseError ? ` ${resolveDiag.parseError}` : "";
    throw new Error(
      `edits[${index}] could not resolve AST target${edit.description ? ` (${edit.description})` : ""} in ${filePath}.${parseHint} ` +
        `Provide a resolvable target.name/namePath/kind/line or re-inspect the file.`,
    );
  }
  return astScope;
}

/** Resolve the lineRange half of an explicit scope; null when absent. */
function resolveLineRangeScope(
  edit: EditItem,
  normalized: string,
  filePath: string,
  index: number,
): SearchScope | null {
  const lineRange = edit.lineRange;
  if (!lineRange) return null;
  const lineScope = lineRangeToScope(normalized, lineRange);
  if (!lineScope) {
    throw new Error(
      `edits[${index}] lineRange [${lineRange.startLine},${lineRange.endLine}] is out of range for ${filePath} ` +
        `(${normalized.split("\n").length} lines).`,
    );
  }
  return lineScope;
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
  const astScope = await resolveAstTargetScope(edit, normalized, filePath, astResolver, index);
  const lineScope = resolveLineRangeScope(edit, normalized, filePath, index);
  if (!astScope && !lineScope) return undefined;
  const scope = astScope && lineScope ? intersectScopes(astScope, lineScope) : (astScope ?? lineScope);
  if (!scope) {
    throw new Error(
      `edits[${index}] AST target and lineRange scopes do not intersect in ${filePath}. ` +
        `Narrow the target or lineRange so they overlap.`,
    );
  }
  return scope;
}

/** Reject intersecting non-zero spans, sorted by start byte. */
function assertNonZeroDisjoint(nonZero: ResolvedMutation[], filePath: string): void {
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
}

/** Reject a zero-length insert sitting inside a non-zero span boundary. */
function assertInsertsDisjoint(
  inserts: ResolvedMutation[],
  nonZero: ResolvedMutation[],
  filePath: string,
): void {
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
  assertNonZeroDisjoint(nonZero, filePath);

  // A zero-length insert at the boundary of a non-zero span is ambiguous.
  assertInsertsDisjoint(inserts, nonZero, filePath);

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

/** Extension suffixes per ast-grep language id, checked in order via endsWith. */
const STRUCTURAL_LANGUAGE_BY_EXTENSION: { suffixes: string[]; language: string }[] = [
  { suffixes: [".ts", ".mts", ".cts"], language: "typescript" },
  { suffixes: [".tsx"], language: "tsx" },
  { suffixes: [".js", ".mjs", ".cjs"], language: "javascript" },
  { suffixes: [".jsx"], language: "jsx" },
  { suffixes: [".py"], language: "python" },
  { suffixes: [".json"], language: "json" },
  { suffixes: [".css"], language: "css" },
  { suffixes: [".html"], language: "html" },
  { suffixes: [".md"], language: "markdown" },
  { suffixes: [".yaml", ".yml"], language: "yaml" },
  { suffixes: [".sql"], language: "sql" },
  { suffixes: [".rs"], language: "rust" },
  { suffixes: [".go"], language: "go" },
  { suffixes: [".java"], language: "java" },
  { suffixes: [".rb"], language: "ruby" },
  { suffixes: [".php"], language: "php" },
  { suffixes: [".c"], language: "c" },
  { suffixes: [".cpp", ".cc", ".h"], language: "cpp" },
  { suffixes: [".cs"], language: "csharp" },
  { suffixes: [".swift"], language: "swift" },
  { suffixes: [".kt", ".kts"], language: "kotlin" },
  { suffixes: [".sh", ".bash"], language: "bash" },
];

/** Map a file path to an ast-grep-compatible language id, or null. */
function languageIdForStructural(filePath: string): string | null {
  const path = filePath.toLowerCase();
  for (const { suffixes, language } of STRUCTURAL_LANGUAGE_BY_EXTENSION) {
    if (suffixes.some((suffix) => path.endsWith(suffix))) return language;
  }
  return null;
}
