/**
 * Smart Edit — Improved edit tool extension for Pi Coding Agent.
 *
 * Overrides Pi's built-in edit tool with improved matching, fuzzy-match
 * safety, replaceAll support, stale-file detection, atomic writes, and
 * richer diagnostics.
 *
 * Installation: copy to ~/.pi/agent/extensions/smart-edit.ts
 *   or place in .pi/extensions/smart-edit/index.ts for project-local use.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { constants, statSync } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { dirname, isAbsolute, relative, resolve } from "path";
import { withFileMutationQueue } from "./src/mutation-queue.js";
import { resolveAnchorToScope, findTextLineRange, getHashlineAnchorLine, computeEditContainingRange } from "./src/anchor-resolution.js";
import { sortHashlineEditsForApplication, formatHashlineBatchSummary } from "./src/hashline-batching.js";
import { reReadAfterFailure, buildMultiFileFallbackHint } from "./src/multi-file-hints.js";
import { buildContextGuardCheck, formatContextGuardRejection } from "./src/context-guard-check.js";
import { prepareArguments, validateInput, formatEditError } from "./src/args.js";

import {
  applyEdits,
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./lib/edit-diff";

import { createAstResolver, validateSyntax } from "./lib/ast-resolver";
import {
  createConflictDetector,
  defaultConflictConfig,
} from "./lib/conflict-detector";

import { detectLanguageFromExtension } from "./src/lsp/language-id";
import { recordRead, checkStale, recordReadWithStat, recordReadSession, getSessionReads, checkEditAllowed, checkRangeCoverage, getSnapshot, getAllSessionPaths } from "./lib/read-cache";
import { buildHashlineAnchors, initHashline } from "./lib/hashline";
import type { HashlineEditInput } from "./lib/hashline-edit";
import { HashlineMismatchError } from "./lib/hashline-edit";

import { detectInputFormat } from "./src/formats/format-detector";
import { StreamingPatchParser } from "./src/formats/streaming-patch-parser";

import { LSPManager } from "./src/lsp/lsp-manager";
import { checkPostEditDiagnostics } from "./src/lsp/diagnostics";
import { deferredDiagnostics } from "./src/lsp/deferred-diagnostics";
import { getCompilerForLanguage } from "./src/lsp/diagnostic-dispatcher";
import type { DiagnosticResult } from "./src/lsp/diagnostic-dispatcher";

import { runPostEditEvidencePipeline } from "./src/verification/post-edit-evidence";
import type { PostEditEvidenceResult } from "./src/verification/types";
import { scopeDiagnosticsToChangedTargets } from "./src/verification/scoped-diagnostics";
import type { ScopedDiagnostic } from "./src/verification/scoped-diagnostics";
import { recordBreakage, recordCoChange } from "./src/smartread-bridge";
import { getSmartEditRuntimeConfig } from "./src/edit-mode";
import { checkEditSafety } from "./src/safety/approval-gating";
import { saveUndoState } from "./src/undo/edit-history";
import { atomicWrite } from "./src/undo/atomic-write";
import { checkContextGuardSimilarity } from "./src/safety/context-guard";
import { MatchError } from "./lib/errors";
import { runAutoValidation, formatValidationFeedback, resetRetryCounts, checkStructural, incrementRetryCount as incRetryCount } from "./src/verification/auto-validate";
import { applySymbolicEdits, buildSymbolicEditGuidance, resolveSymbolicEditLineRange } from "./src/symbolic-edits";
import type { SymbolicEditRequest } from "./src/symbolic-edits";

import type {
  EditTarget,
  EditItem,
  EditInput,
  EditResult,
  EditCapability,
  MatchSpan,
  SearchScope,
} from "./lib/types";

const smartEditRuntimeConfig = getSmartEditRuntimeConfig();

function coerceText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "symbol") return value.description ?? value.toString();
  if (typeof value === "function") return value.name ? `[Function: ${value.name}]` : "[Function]";
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// ─── Schema (must match built-in edit schema exactly) ──────────────
// Extra properties like `replaceAll`, `target` are stripped
// by prepareArguments before validation, then restored in execute().


const editItemSchema = Type.Object(
  {
    oldText: Type.Optional(Type.String()),
    newText: Type.Optional(Type.String()),
    description: Type.Optional(Type.String({ description: "Optional label echoed in diagnostics for self-reference." })),
    target: Type.Optional(Type.Object(
      {
        name: Type.Optional(Type.String({ description: "Symbol name to target (e.g., function name, class name)." })),
        namePath: Type.Optional(Type.String({ description: "Qualified symbol path; the final component is matched by AST name (e.g., 'MyClass.myMethod')." })),
        kind: Type.Optional(Type.String({ description: "AST node kind hint (e.g., 'function_declaration', 'class_declaration')." })),
        line: Type.Optional(Type.Number({ description: "1-based line hint for disambiguation when multiple symbols share a name." })),
        replaceBody: Type.Optional(Type.String({ description: "Replace the entire AST symbol definition with this text." })),
        insertBefore: Type.Optional(Type.String({ description: "Insert this text immediately before the AST symbol definition." })),
        insertAfter: Type.Optional(Type.String({ description: "Insert this text immediately after the AST symbol definition." })),
      },
      {
        description:
          "AST symbol target. When used with oldText/newText, scopes the text search within the symbol's byte range. " +
          "When used with replaceBody/insertBefore/insertAfter, operates on the whole symbol. " +
          "Provide at most one of replaceBody, insertBefore, or insertAfter.",
      },
    )),
  },
);

const editSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to the file to edit (relative or absolute)",
    }),
    replaceAll: Type.Optional(
      Type.Boolean({
        description:
          "When true, replaces every non-overlapping occurrence of oldText in each edit. " +
          "Default: false (requires unique match).",
      }),
    ),
    edits: Type.Union([
      Type.Array(editItemSchema, {
        description:
          "One or more targeted edits using oldText/newText or symbol targets. " +
          "Edits are matched against the original file, not incrementally. " +
          "\nDo not include overlapping or nested edits — merge nearby changes into one edit.",
      }),
      Type.String({
        description:
          "JSON string of edits array. Accepted for compatibility with models " +
          "that serialize the array into a string somewhere in the tool-calling pipeline.",
      }),
    ]),
  },
);

function resolveWorkspacePath(cwd: string, targetPath: string): string {
  const absolutePath = resolve(cwd, targetPath);
  const rel = relative(cwd, absolutePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw formatEditError(
      `Cannot edit "${targetPath}": path is outside the current workspace.`,
      `Use a path inside ${cwd}.`,
    );
  }
  return absolutePath;
}






// ─── AST resolver and conflict detector instances (per-session) ────

/** AST resolver instance, created once per session. null if Tree-sitter unavailable. */
let astResolver: ReturnType<typeof createAstResolver> | null = null;

/** Conflict detector instance, created once per session. */
let conflictDetector: ReturnType<typeof createConflictDetector> | null = null;

/** LSP manager instance, created once per session. */
let lspManager: LSPManager | null = null;


/**
 * Compute the containing line range for a set of edits from their oldText.
 * Returns [startLine, endLine] (1-based) or null if oldText can't be located.
 *
 * Used by the range coverage guard to validate that edit targets fall within
 * lines that were actually read this session.
 */


export { sortHashlineEditsForApplication, formatHashlineBatchSummary };


// ─── Extension entry point ──────────────────────────────────────────

export default function smartEdit(pi: ExtensionAPI) {
  // ── Populate read cache on every successful read ──
  pi.on("tool_result", async (event, _ctx) => {
    const toolCwd = process.cwd();
    if (
      event.toolName === "read" &&
      !event.isError &&
      event.content
    ) {
      try {
        // Determine if this is a partial read (user-specified offset/limit)
        const isOffsetLimitRead =
          event.input?.offset != null || event.input?.limit != null;

        // Build full content from result blocks
        const contentBlocks = Array.isArray(event.content) ? event.content : [];
        const fullText = contentBlocks
          .filter((c) => c.type === "text")
          .map((c) => coerceText((c as { text?: unknown }).text))
          .join("");

        const inputPath = (event.input as { path?: string } | undefined)?.path;
        if (fullText && inputPath) {
          if (isOffsetLimitRead) {
            // Offset/limit reads are intentionally partial — record as partial.
            // Hashline anchors are only computed in the experimental mode.
            const readOffset = (event.input as { offset?: number })?.offset ?? 1;
            const lines = fullText.split("\n");
            const hashline = smartEditRuntimeConfig.useHashlineEditing
              ? await buildHashlineAnchors(lines, readOffset)
              : undefined;
            recordRead(inputPath, toolCwd, fullText, true, hashline, readOffset);

            // Track read range for coverage validation
            const explicitLimit = (event.input as { limit?: number })?.limit;

            // When no explicit limit is given (offset-only read), use -1 to mean
            // "through end of file" so range coverage can validate correctly.
            // Determine the actual total file line count from snapshot data if
            // available rather than relying on the returned output, which may be
            // truncated by Pi's output limit.
            if (explicitLimit === undefined) {
              let totalFileLines = lines.length + readOffset - 1;
              try {
                const snapshot = getSnapshot(inputPath, toolCwd);
                if (snapshot?.hashline?.formattedLines?.length) {
                  totalFileLines = snapshot.hashline.formattedLines.length;
                }
              } catch {
                // Fall back to computed value
              }
              recordReadSession(inputPath, toolCwd, readOffset, -1, totalFileLines, "read");
            } else {
              recordReadSession(inputPath, toolCwd, readOffset, explicitLimit, lines.length + readOffset - 1, "read");
            }
            return;
          }

          // Detect Pi's automatic output truncation: if the file on disk is
          // larger than the content returned, the read was truncated.
          // We record as partial so the stale check only verifies mtime.
          let isTruncated = false;
          try {
            const resolvedPath = resolve(toolCwd, inputPath);
            const fileStat = statSync(resolvedPath);
            if (fileStat.size > fullText.length) {
              isTruncated = true;
            }
          } catch {
            // file may not exist or stat failed — record normally
          }

          // Build hashline anchors only in the experimental mode.
          const lines = fullText.split("\n");
          const hashline = smartEditRuntimeConfig.useHashlineEditing
            ? await buildHashlineAnchors(lines)
            : undefined;
          recordRead(inputPath, toolCwd, fullText, isTruncated, hashline);

          // Track read range for coverage validation
          recordReadSession(inputPath, toolCwd, 1, -1, lines.length, "read");
        }
      } catch {
        /* silently ignore cache population errors */
      }
    }

    // ── Track read_files results ──
    // Populates the snapshot cache for each file read, so edits are allowed.
    // Accepts both "read_files" (current Pi-SmartRead name) and "read_multiple_files"
    // (legacy ToolDefinition.name) for backward compatibility.
    if (
      (event.toolName === "read_files" || event.toolName === "read_multiple_files") &&
      !event.isError
    ) {
      try {
        // Prefer event.details.files (has ok status from read-many) over event.input.files
        const rawDetailFiles = (event.details as { files?: Array<{ path: string; ok?: boolean }> } | undefined)?.files;
        const detailFiles = Array.isArray(rawDetailFiles) ? rawDetailFiles : undefined;
        const rawInputFiles = (event.input as { files?: Array<{ path: string; offset?: number; limit?: number }> } | undefined)?.files;
        const inputFiles = Array.isArray(rawInputFiles) ? rawInputFiles : undefined;

        // Merge detail status with input params (offset/limit)
        const filesToProcess = (detailFiles ?? inputFiles) ?? [];
        if (filesToProcess.length > 0) {
          // Build lookup from input files for offset/limit info
          const inputMap = new Map<string, { offset?: number; limit?: number }>();
          if (inputFiles) {
            for (const f of inputFiles) inputMap.set(f.path, { offset: f.offset, limit: f.limit });
          }

          for (const file of filesToProcess) {
            // Skip files that failed to read
            if ('ok' in file && file.ok === false) continue;

            try {
              const resolvedPath = resolve(toolCwd, file.path);
              const content = (await fsReadFile(resolvedPath)).toString("utf-8");
              if (content) {
                const inputInfo = inputMap.get(file.path);
                const isPartial = inputInfo?.offset != null || inputInfo?.limit != null;
                const lines = content.split("\n");
                const hashline = smartEditRuntimeConfig.useHashlineEditing
                  ? await buildHashlineAnchors(lines)
                  : undefined;
                recordRead(file.path, toolCwd, content, isPartial, hashline);

                // Track read range for coverage validation
                const readOffset = inputInfo?.offset ?? 1;
                const readLimit = inputInfo?.limit ?? -1;
                recordReadSession(file.path, toolCwd, readOffset, readLimit, lines.length, "read_files");
              }
            } catch {
              // File may not exist or can't be read — skip silently
            }
          }
        }
      } catch {
        /* silently ignore cache population errors */
      }
    }

    // ── Track intent_read results ──
    // Populates the snapshot cache for each successfully-read file.
    // Uses event.details.files (which includes directory-resolved files)
    // rather than event.input.files for completeness.
    if (
      event.toolName === "intent_read" &&
      !event.isError
    ) {
      try {
        const rawDetailFiles = (event.details as { files?: Array<{ path: string; ok: boolean; inclusion?: string }> } | undefined)?.files;
        const detailFiles = Array.isArray(rawDetailFiles) ? rawDetailFiles : undefined;
        if (detailFiles && detailFiles.length > 0) {
          for (const file of detailFiles) {
            if (!file.ok) continue;

            try {
              const resolvedPath = resolve(toolCwd, file.path);
              const content = (await fsReadFile(resolvedPath)).toString("utf-8");
              if (content) {
                // Mark as partial if the file wasn't fully included in output
                // due to packing limits or truncation (omitted files are still
                // recorded so the edit stale-check knows they were seen).
                const isPartial = file.inclusion !== "full";
                const lines = content.split("\n");
                const hashline = smartEditRuntimeConfig.useHashlineEditing
                  ? await buildHashlineAnchors(lines)
                  : undefined;
                recordRead(file.path, toolCwd, content, isPartial, hashline);

                // Track read range for coverage validation
                // intent_read reads full files, so offset=1, limit=-1 (full file)
                recordReadSession(file.path, toolCwd, 1, -1, lines.length, "intent_read");
              }
            } catch {
              // File may not exist or can't be read — skip silently
            }
          }
        }
      } catch {
        /* silently ignore cache population errors */
      }
    }

    // ── Track writes so write-then-edit flow doesn't trigger stale-file guard ──
    const writePath = (event.input as { path?: string } | undefined)?.path;
    if (
      event.toolName === "write" &&
      !event.isError &&
      writePath
    ) {
      try {
        // Read the file from disk to get what was actually written
        const resolvedPath = resolve(toolCwd, writePath);
        const content = (await fsReadFile(resolvedPath)).toString("utf-8");
        if (content) {
          recordRead(writePath, toolCwd, content);

          // Track write as a read (write-then-edit flow bypasses stale guard)
          const lines = content.split("\n");
          recordReadSession(writePath, toolCwd, 1, -1, lines.length, "write");

          // ── Auto-validation hook (SmallCode-inspired) ──
          // After a write, run structural + compiler/linter validation.
          // Feed errors back as structured data on the event for the model to see.
          //
          // VALIDATION IS ADVISORY: runAutoValidation runs asynchronously and may
          // complete after this handler returns. Consumers MUST NOT rely on
          // event.validationFeedback being present synchronously. The promise is
          // intentionally fire-and-forget so write results are not blocked by
          // validation overhead — the model receives diagnostics as a later signal
          // rather than a blocking response. See formatValidationFeedback for the
          // shape of validation feedback that gets attached to the event object.
          runAutoValidation(writePath, content, {
            cwd: toolCwd,
            maxRetries: 3,
            enabled: true,
          }).then((validationResult) => {
            if (!validationResult.passed) {
              const feedback = formatValidationFeedback(validationResult);
              if (feedback) {
                const ev = event as unknown as Record<string, unknown>;
                ev.validationFeedback = feedback;
                ev.validationRetries = validationResult.retryCount;
                ev.shouldDecompose = validationResult.shouldDecompose;
              }
            }
          }).catch(() => {
            // Validation is advisory — silent degradation
          });
        }
      } catch {
        // File might not exist yet or can't be read — skip silently
      }
    }
  });

  // ── Initialize per-session state ──
  pi.on("session_start", async (_event, _ctx) => {
    const sessionCwd = process.cwd();
    // Create AST resolver (returns null if Tree-sitter unavailable)
    astResolver = createAstResolver();

    // Create conflict detector wired to the AST resolver
    conflictDetector = createConflictDetector(defaultConflictConfig, () => astResolver);

    // Create LSP manager for semantic intelligence
    lspManager = new LSPManager(sessionCwd);

    // Clear conflict history and retry counts on session start
    if (conflictDetector) {
      conflictDetector.clearAll();
    }
    resetRetryCounts();
  });

  // ── Shutdown on session end ──
  pi.on("session_shutdown", async () => {
    await lspManager?.shutdown();
    lspManager = null;
  });

  // ── Register the improved edit tool ──
  // TypeScript cannot express the full structural variance of Pi's ExtensionAPI.
  // The cast to `unknown` + `as any` bypasses the inferred generic constraints
  // that are stricter than what Pi actually enforces at runtime.
  (pi.registerTool as (t: unknown) => void)(({
    name: "edit",
    label: "edit",
    description:
      "Edit a single file. Proactively use symbol edits for whole function/class/method replacements or insertions; use oldText/newText for small local changes. " +
      "If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. " +
      "Do not include large unchanged regions just to connect distant changes.",

    promptSnippet:
      "Make precise file edits. Prefer symbol edits for whole-symbol changes, oldText/newText for narrow local edits.",

    promptGuidelines: [
      "Proactively use symbol edits for whole function/class/method replacements or insertions: { symbol: { name: 'handleRequest' }, replaceBody: 'function handleRequest(...) { ... }' }. This avoids reproducing oldText for large semantic units.",
      "Use oldText/newText for small, exact local changes inside a symbol, import tweaks, config values, or other non-symbol edits.",
      "Use multiple edits in one call for independent changes to the same file. All edits are matched against the original file content, not incrementally.",
      "Do not emit overlapping edits — merge nearby changes into one edit. Keep content arrays concise — only include lines that change.",
      "Before editing code that depends on custom types, imported factories, interfaces, or unfamiliar symbols, call semantic_context for the target range instead of reading whole dependency files.",
    ],

    parameters: editSchema as unknown as Record<string, unknown>,
    renderShell: "self" as const,

    async execute(
      _toolCallId: string,
      input: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
      _ctx: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: EditResult["details"] }> {
      if (smartEditRuntimeConfig.useHashlineEditing) {
        await initHashline();
      }
      // Save original edits string for streaming (before prepareArguments converts it)
      const rawEditsString = typeof input.edits === "string" ? input.edits : undefined;

      input = prepareArguments(input, smartEditRuntimeConfig.useHashlineEditing) || input;

      // ── Streaming patch preview ───────────────────────────────
      // When onUpdate is provided and the edits were originally a codex_patch
      // string, feed the raw patch text through StreamingPatchParser before
      // processing. This gives the caller real-time progress on how many hunks
      // are being processed.
      if (onUpdate && rawEditsString) {
        try {
          const format = detectInputFormat(rawEditsString);
          if (format === "codex_patch") {
            const parser = new StreamingPatchParser(onUpdate);
            parser.pushDelta(rawEditsString);
            parser.finish();
          }
        } catch {
          // Streaming is advisory — silent degradation on failure
        }
      }

      let extraData: Record<string, unknown> | null = null;
      if (typeof input.path === "string") {
        const extraIdx = input.path.indexOf("??smartEditExtra=");
        if (extraIdx !== -1) {
          try {
            extraData = JSON.parse(Buffer.from(input.path.slice(extraIdx + 17).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")) as Record<string, unknown> | null;
          // Validate decoded extraData shape before use
          if (extraData && typeof extraData === 'object' && !Array.isArray(extraData)) {
            const ed = extraData as Record<string, unknown>;
            if (ed.replaceAllFlags != null && (!Array.isArray(ed.replaceAllFlags) || !ed.replaceAllFlags.every(f => typeof f === 'boolean'))) {
              extraData = null;
            }
            if (ed.targetData != null && (!Array.isArray(ed.targetData) || !ed.targetData.every(t => t == null || (typeof t === 'object' && !Array.isArray(t))))) {
              extraData = null;
            }
            if (ed.hashlineData != null && (!Array.isArray(ed.hashlineData) || !ed.hashlineData.every(h => h == null || (typeof h === 'object' && !Array.isArray(h))))) {
              extraData = null;
            }
          }
        } catch {}
        input.path = input.path.slice(0, extraIdx);
        }
      }

      const { path, edits } = validateInput(input, smartEditRuntimeConfig.useHashlineEditing);

      // Resolve path
      const cwd = process.cwd();
      const absolutePath = resolveWorkspacePath(cwd, path);

      // Check if aborted
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      // Wrap in mutation queue to serialize edits to the same file
      return withFileMutationQueue(absolutePath, async () => {
        let aborted = false;
        const onAbort = () => {
          aborted = true;
        };

        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
        }

        let deferralController: AbortController | undefined;

        try {
          // Check file exists
          try {
            await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
          } catch {
            if (signal) signal.removeEventListener("abort", onAbort);
            throw new Error(`File not found or not writable: ${path}`);
          }

          if (aborted) throw new Error("Operation aborted");

          // Read the file
          const buffer = await fsReadFile(absolutePath);
          const rawContent = buffer.toString("utf-8");
          const { bom, text: content } = stripBom(rawContent);
          const originalEnding = detectLineEnding(content);
          let normalizedContent = normalizeToLF(content);

          const localFlags = extraData != null && !Array.isArray(extraData) ? (extraData as Record<string, unknown>).replaceAllFlags as unknown[] ?? null : null;
          const localTargets = extraData != null && !Array.isArray(extraData) ? (extraData as Record<string, unknown>).targetData as unknown[] ?? null : null;
          const localHashlines = extraData != null && !Array.isArray(extraData) ? (extraData as Record<string, unknown>).hashlineData as unknown[] ?? null : null;
          const contextGuardCheck = await buildContextGuardCheck(normalizedContent, path, edits, localTargets, astResolver);
          const contextGuardNotes: string[] = [];

          // ── Stale file check (checkStale handles its own APFS retry + zero-read) ──
          const staleError = await checkStale(path, cwd);
          if (staleError) {
            if (!contextGuardCheck.allowed) {
              if (signal) signal.removeEventListener("abort", onAbort);
              throw new MatchError(formatContextGuardRejection(staleError, contextGuardCheck.reason), 'STALE');
            }
            for (const note of contextGuardCheck.notes) {
              if (!contextGuardNotes.includes(note)) contextGuardNotes.push(note);
            }
          }

          // ── Session read fallback ──
          // Edge case: snapshot exists (file was read) but session reads weren't
          // recorded. This can happen when:
          //   - The tool_result handler didn't fire for this read
          //   - A previous reReadAfterFailure populated the snapshot without session reads
          //   - The file was injected via --context or @mention
          // If checkStale passed (snapshot exists) but there are no session reads,
          // populate them from the fresh file content so range coverage can validate.
          const existingSessions = getSessionReads(path, cwd);
          if (!staleError && existingSessions.length === 0 && getSnapshot(path, cwd)) {
            const rawLines = rawContent.split('\n');
            recordReadSession(path, cwd, 1, -1, rawLines.length, "edit_fallback");
          }

          // ── Range coverage check (P1: read-guard pattern) ──
          // Validate that edit targets fall within lines actually read this session.
          // This prevents edits to sections of a file the model hasn't seen.
          // Uses the edits' oldText to determine target lines.
          // ── Range coverage guard ──
          // Priority 1: Derive range from oldText (works for legacy edits)
          // Priority 2: Derive range from hashline anchors (works for hashline-only edits)
          let editLineRange = computeEditContainingRange(rawContent, edits);

          if (!editLineRange && extraData?.hashlineData) {
            const totalLines = rawContent.split('\n').length;
            let minStart = Infinity;
            let maxEnd = -Infinity;

            for (const h of (extraData.hashlineData as unknown[])) {
              if (!h) continue;
              const he = h as Record<string, unknown>;
              const range = he.range as { pos?: string; end?: string } | undefined;
              if (!range?.pos || !range?.end) continue;

              const startLine = getHashlineAnchorLine(range.pos, totalLines);
              const endLine = getHashlineAnchorLine(range.end, totalLines);
              if (startLine === null || endLine === null) continue;

              if (startLine < minStart) minStart = startLine;
              if (endLine > maxEnd) maxEnd = endLine;
            }

            if (minStart !== Infinity && maxEnd !== -Infinity) {
              editLineRange = [minStart, maxEnd];
            }
          }

          if (!editLineRange && extraData?.targetData) {
            let minStart = Infinity;
            let maxEnd = -Infinity;
            for (const target of extraData.targetData as unknown[]) {
              if (!target) continue;
              // Only check targets with operation fields (symbolic edits)
              const t = target as Record<string, unknown>;
              if (!t.replaceBody && !t.insertBefore && !t.insertAfter) continue;
              const range = await resolveSymbolicEditLineRange({
                content: normalizeToLF(stripBom(rawContent).text),
                filePath: path,
                astResolver,
                edit: { target: target as EditTarget },
              });
              if (!range) continue;
              if (range[0] < minStart) minStart = range[0];
              if (range[1] > maxEnd) maxEnd = range[1];
            }
            if (minStart !== Infinity && maxEnd !== -Infinity) {
              editLineRange = [minStart, maxEnd];
            }
          }

          if (editLineRange) {
            const coverageResult = checkRangeCoverage(path, cwd, editLineRange[0], editLineRange[1]);
            if (!coverageResult.covered) {
              if (!contextGuardCheck.allowed) {
                if (signal) signal.removeEventListener("abort", onAbort);
                throw new MatchError(formatContextGuardRejection(coverageResult.reason, contextGuardCheck.reason), 'COVERAGE');
              }
              for (const note of contextGuardCheck.notes) {
                if (!contextGuardNotes.includes(note)) contextGuardNotes.push(note);
              }
            }
          }

          if (aborted) throw new Error("Operation aborted");

          // Separate hashline edits from legacy edits
          const totalLines = rawContent.split("\n").length;
          const hashlineEdits: Array<{ editIdx: number; sortLine: number; hashline: Record<string, unknown> }> = [];
          const symbolicEdits: SymbolicEditRequest[] = [];
          const legacyEdits: Array<{ editIdx: number; edit: EditItem }> = [];

          for (let i = 0; i < edits.length; i++) {
            const rawEdit = edits[i] as unknown as Record<string, unknown>;
            if (localHashlines?.[i]) {
              const hashline = localHashlines[i] as Record<string, unknown>;
              const range = hashline.range as { pos?: string; end?: string } | undefined;
              const sortLine = Math.max(
                getHashlineAnchorLine(range?.pos ?? "", totalLines) ?? 0,
                getHashlineAnchorLine(range?.end ?? "", totalLines) ?? 0,
              );
              hashlineEdits.push({ editIdx: i, sortLine, hashline });
            } else if (localTargets?.[i]) {
              const targetData = localTargets[i] as Record<string, unknown>;
              // A target with an operation field is a symbolic edit
              if (targetData.replaceBody || targetData.insertBefore || targetData.insertAfter) {
                symbolicEdits.push({
                  target: targetData as EditTarget,
                  editIdx: i,
                });
              } else {
                // Anchor-only target: restore to edit for legacy path
                (edits[i] as unknown as Record<string, unknown>).target = targetData;
                if (localFlags?.[i]) (edits[i] as unknown as Record<string, unknown>).replaceAll = true;
                legacyEdits.push({ editIdx: i, edit: edits[i] });
              }
            } else {
              // Guard: hashline-only edit with no oldText can't go through legacy pipeline
              // This happens when the hashline side-channel (path-encoded extraData) fails to decode.
              if (typeof rawEdit.oldText !== "string") {
                throw new Error(
                  `edits[${i}] has no oldText and no recoverable hashline or target data. ` +
                  `This edit was sent as hashline or symbol format but the side-channel data was lost during tool parameter processing. ` +
                  `Re-read the file and retry the edit.`
                );
              }
              // Restore replaceAll/anchor/lineRange
              if (localFlags?.[i]) (edits[i] as unknown as Record<string, unknown>).replaceAll = true;
              legacyEdits.push({ editIdx: i, edit: edits[i] });
            }
          }

          // ── Save original content for diff generation (before any edits) ──
          const baseContent = normalizedContent;

          // ── Collect match notes and conflict warnings ──
          const matchNotes: string[] = [...contextGuardNotes];
          const conflictWarnings: string[] = [];
          const editCapabilities = new Set<EditCapability>();
          if (hashlineEdits.length > 0) editCapabilities.add("hashline");
          if (symbolicEdits.length > 0) editCapabilities.add("symbolicEdit");
          if (legacyEdits.length > 0) editCapabilities.add("oldText");
          if (legacyEdits.some(({ edit }) => edit.replaceAll)) editCapabilities.add("replaceAll");
          if (legacyEdits.some(({ edit }) => edit.target)) editCapabilities.add("astAnchor");
          const resultMatchSpans: MatchSpan[] = [];
          let replacementCount = 0;

          // ── Soft hashline feedback ──
          // Only surfaced in experimental hashline mode.
          if (smartEditRuntimeConfig.useHashlineEditing && legacyEdits.length > 0) {
            const snapshot = getSnapshot(path, cwd);
            if (snapshot?.hashline?.anchors && snapshot.hashline.anchors.size > 0) {
              const needsLegacy = legacyEdits.some(
                ({ edit }) => edit.replaceAll || edit.target
              );
              if (!needsLegacy) {
                const anchorExamples: string[] = [];
                let count = 0;
                for (const [anchor] of snapshot.hashline.anchors) {
                  anchorExamples.push(anchor);
                  if (++count >= 3) break;
                }
                matchNotes.push(
                  `hint: hashline anchors are available for this file — prefer hashline format next time for freshness checking. ` +
                  `Example: { hashline: { range: { pos: '${anchorExamples[0] ?? '42ab'}', end: '${anchorExamples[1] ?? '45cd'}' }, content: ['lines'] } }`
                );
              }
            }
          }

          // ── Phase A: Apply hashline edits (if any) ──
          if (hashlineEdits.length > 0) {
            // Import hashline-edit functions at runtime to avoid circular deps
            const {
              applyHashlinePath,
            } = await import("./lib/hashline-edit.js");
            const { getSnapshot } = await import("./lib/read-cache.js");
            const { findText, findTextWithTelemetry, detectIndentation } = await import("./lib/edit-diff.js");

            // Get file snapshot from cache for oldText reconstruction
            const snapshot = getSnapshot(path, cwd);

            // Build adapter for AST scope resolution
            const resolveScopeFn = async (
              anchor: { symbolName?: string; symbolKind?: string; symbolLine?: number },
              content: string,
              _filePath: string,
            ) => {
              const scope = await resolveAnchorToScope(
                { oldText: "", newText: "", target: { name: anchor.symbolName, kind: anchor.symbolKind, line: anchor.symbolLine } } as EditItem,
                content,
                path,
                astResolver,
              );
              if (!scope) return null;
              return scope;
            };

            // Wrap findText with telemetry for matching instrumentation
            const findTextWithT: typeof findText = (content, search, style, offset, scope) => {
              const { result, telemetry } = findTextWithTelemetry(content, search, style, offset, scope);
              // Only report telemetry when a fuzzy tier was used
              if (telemetry && telemetry.length > 0) {
                const successTiers = telemetry.filter((t: { success: boolean }) => t.success);
                if (successTiers.length > 0) {
                  const summary = successTiers
                    .map((t: { tier: string; durationMs: number }) => `${t.tier}: ${t.durationMs.toFixed(1)}ms`)
                    .join(", ");
                  matchNotes.push(`[match-telemetry] ${summary}`);
                }
              }
              return result;
            };

            const orderedHashlineEdits = sortHashlineEditsForApplication(hashlineEdits);

            const hashlineErrors: Array<{ editIdx: number; message: string }> = [];
            for (const { editIdx, hashline } of orderedHashlineEdits) {
              const rawEdit = hashline as Record<string, unknown>;

              const input: HashlineEditInput = {
                anchor: {
                  range: rawEdit.range as { pos: string; end: string },
                  ...(rawEdit.symbol
                    ? { symbol: rawEdit.symbol as { name: string; kind?: string; line?: number } }
                    : {}),
                },
                content: rawEdit.content as string[] | string | null | undefined,
              };

              try {
                const pathResult = await applyHashlinePath(
                  input,
                  normalizedContent,
                  snapshot,
                  resolveScopeFn,
                  findTextWithT as Parameters<typeof applyHashlinePath>[4],
                  detectIndentation,
                );

                if (pathResult.warnings.length > 0) {
                  matchNotes.push(...pathResult.warnings);
                }

                normalizedContent = pathResult.newContent;
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                hashlineErrors.push({ editIdx, message });
              }
            }

            const batchSummary = formatHashlineBatchSummary(
              orderedHashlineEdits.length,
              orderedHashlineEdits.length - hashlineErrors.length,
              hashlineErrors,
            );
            if (batchSummary) {
              matchNotes.push(batchSummary);
            }

            if (hashlineErrors.length > 0 && hashlineErrors.length === orderedHashlineEdits.length) {
              throw new Error(hashlineErrors.map((e) => e.message).join("\n\n"));
            }
          }

          // ── Phase B: Apply symbolic AST edits (if any) ──
          if (symbolicEdits.length > 0) {
            const symbolicPreview = await applySymbolicEdits({
              content: normalizedContent,
              filePath: path,
              astResolver,
              edits: symbolicEdits,
            });

            const symbolicSpans = symbolicPreview.matchSpans.map((s) => ({
              startIndex: s.matchIndex,
              endIndex: s.matchIndex + s.matchLength,
            }));

            if (conflictDetector && symbolicSpans.length > 0) {
              conflictDetector.captureBaseline(path);
              const conflicts = await conflictDetector.checkDeltaConflicts(path, normalizedContent, symbolicSpans);
              if (conflicts.length > 0) {
                const conflictMessages = conflicts.map(
                  (c) => `  - "${c.previousSymbol.name}" (${c.previousSymbol.kind}): ${c.suggestion}`,
                );
                const warningMsg =
                  `⚠ Conflict detected with previous edit:\n` +
                  conflictMessages.join("\n") +
                  `\nConsider re-reading the file to get updated content.`;

                if (defaultConflictConfig.onConflict === "error") {
                  throw new Error(warningMsg);
                }
                conflictWarnings.push(warningMsg);
              }
            }

            normalizedContent = symbolicPreview.newContent;
            resultMatchSpans.push(...symbolicPreview.matchSpans);
            replacementCount += symbolicPreview.applied.length;
            matchNotes.push(...symbolicPreview.applied.map((edit) => `symbolic ${edit.operation}: ${edit.symbolName}`));
          }

          // ── Phase C: Apply legacy edits (if any) ──
          if (legacyEdits.length > 0) {
            // Resolve anchors to search scopes
            const resolvedScopes: (SearchScope | undefined)[] = [];
            for (const { edit } of legacyEdits) {
              if (edit.target) {
                const scope = await resolveAnchorToScope(edit, normalizedContent, path, astResolver);
                resolvedScopes.push(scope ?? undefined);
              } else {
                resolvedScopes.push(undefined);
              }
            }

            // Apply legacy edits with pre-apply hooks (conflict detection)
            const legacyResult = await applyEdits(
              normalizedContent,
              legacyEdits.map(e => e.edit),
              path,
              {
                searchScopes: resolvedScopes,
                onBeforeApply: conflictDetector
                  ? async (spans) => {
                      const realSpans = spans.map((s) => ({
                        startIndex: s.matchIndex,
                        endIndex: s.matchIndex + s.matchLength,
                      }));

                      // Capture baseline before checking delta conflicts
                      // This ensures we only report NEW conflicts since the
                      // last successful edit to this file.
                      if (conflictDetector) conflictDetector.captureBaseline(path);

                      const conflicts = conflictDetector
                        ? await conflictDetector.checkDeltaConflicts(path, normalizedContent, realSpans)
                        : [];

                      if (conflicts.length > 0) {
                        const conflictMessages = conflicts.map(
                          (c) => `  - "${c.previousSymbol.name}" (${c.previousSymbol.kind}): ${c.suggestion}`,
                        );
                        const warningMsg =
                          `⚠ Conflict detected with previous edit:\n` +
                          conflictMessages.join("\n") +
                          `\nConsider re-reading the file to get updated content.`;

                        if (defaultConflictConfig.onConflict === "error") {
                          throw new Error(warningMsg);
                        } else {
                          conflictWarnings.push(warningMsg);
                        }
                      }
                    }
                  : undefined,
              },
            );

            if (aborted) throw new Error("Operation aborted");

            normalizedContent = legacyResult.newContent;
            matchNotes.push(...(legacyResult.matchNotes || []));
            const symbolicGuidance = await buildSymbolicEditGuidance({
              content: baseContent,
              filePath: path,
              astResolver,
              spans: legacyResult.matchSpans.map((s) => ({
                startIndex: s.matchIndex,
                endIndex: s.matchIndex + s.matchLength,
              })),
            });
            matchNotes.push(...symbolicGuidance);
            resultMatchSpans.push(...legacyResult.matchSpans);
            replacementCount += legacyResult.replacementCount;
          }

          // ── Guard: no-op check ──
          if (baseContent === normalizedContent) {
            const msg = edits.length === 1
              ? `No changes made to ${path}. The replacement produced identical content.`
              : `No changes made to ${path}. The replacements produced identical content.`;
            throw new Error(msg);
          }

          if (aborted) throw new Error("Operation aborted");

          // Reconstruct with BOM and line endings
          const finalContent =
            bom + restoreLineEndings(normalizedContent, originalEnding);

          // ── Approval gating check (warnings only — never blocks) ──
          const safetyResult = await checkEditSafety(path, edits);
          if (safetyResult.warnings.length > 0) {
            matchNotes.push(...safetyResult.warnings);
          }

          // ── Save undo state before write (non-blocking, fire-and-forget) ──
          saveUndoState(cwd, absolutePath, baseContent, edits.length).catch((undoErr: unknown) => {
            console.warn("saveUndoState failed:", undoErr instanceof Error ? undoErr.message : String(undoErr));
          });

          // Atomic write
          await atomicWrite(absolutePath, finalContent);

          // ── Update read cache with our known content (avoid APFS VFS stale reads) ──
          //
          // After atomicWrite's rename(), both statSync and fsReadFile can return
          // stale data from the replaced APFS inode for a brief window due to VFS
          // caching. Using our in-memory finalContent for hashing guarantees the
          // snapshot hash reflects what was actually written. We retry fsStat until
          // the file size stabilizes to match what we wrote, then store the settled
          // metadata via recordReadWithStat (bypasses the statSync in recordRead).
          const expectedSize = Buffer.byteLength(finalContent);
          let settledMtimeMs = Date.now();
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              const st = await fsStat(absolutePath);
              if (st.size === expectedSize) {
                settledMtimeMs = st.mtimeMs;
                break;
              }
            } catch {
              /* retry */
            }
            await new Promise((r) => setTimeout(r, 20 * Math.pow(2, attempt)));
          }

          const postEditLines = normalizedContent.split("\n");
          const postEditHashline = smartEditRuntimeConfig.useHashlineEditing
            ? await buildHashlineAnchors(postEditLines)
            : undefined;
          recordReadWithStat(path, cwd, finalContent, settledMtimeMs, expectedSize, postEditHashline);
          recordReadSession(path, cwd, 1, -1, postEditLines.length, "edit");

          if (aborted) throw new Error("Operation aborted");

          // Record successful edit for future conflict detection
          // (after atomicWrite, so no phantom record if write fails)
          if (conflictDetector && resultMatchSpans.length > 0) {
            await conflictDetector.recordEdit(
              path,
              normalizedContent,
              resultMatchSpans.map((s) => ({
                startIndex: s.matchIndex,
                endIndex: s.matchIndex + s.matchLength,
              })),
            );
          }

          // Generate diff (baseContent saved before any edits were applied)
          const diffResult = generateDiffString(baseContent, normalizedContent);

          // ── Post-edit AST validation ──
          // Check that the file still parses correctly after the edit.
          // If validation is enabled, surface a warning but don't block success.
          if (astResolver) {
            const syntaxResult = await validateSyntax(normalizedContent, path);
            if (!syntaxResult.valid) {
              matchNotes.push(syntaxResult.error);
            }
          }

          // Build success message — use actual match count, not edit object count
          const matchCount = replacementCount || edits.length;
          let text: string;
          if (matchCount > edits.length) {
            // replaceAll expanded one edit into multiple replacements
            text = `Successfully applied ${edits.length} edit(s), replacing ${matchCount} occurrence(s) in ${path}.`;
          } else {
            text = `Successfully replaced ${matchCount} block(s) in ${path}.`;
          }

          // ── Post-edit diagnostic check: LSP + compiler fallback ──
          // First check LSP diagnostics, then fall back to compilers if no results.
          // allDiagnostics is declared at this scope so the details section below
          // can emit structured diagnostics for context-optimizer integration.
          let allDiagnostics: Array<{
            message: string;
            severity: 1 | 2 | 3 | 4;
            range: { start: { line: number; character: number }; end: { line: number; character: number } };
            source?: string;
            filePath?: string;
          }> = [];
          let scopedDiagnostics: ScopedDiagnostic[] = [];
          let postEditEvidence: PostEditEvidenceResult | null = null;

          // ── Begin deferred diagnostics capture ──
          // Signal the LSP manager to collect diagnostics that arrive after the
          // initial response. The LSP server may produce diagnostics with a delay
          // after the document is synced.
          deferralController = lspManager
            ? deferredDiagnostics.beginDeferred(absolutePath)
            : undefined;

          if (lspManager) {
            const languageId = detectLanguageFromExtension(path);
            if (languageId) {
              // Phase 1: LSP diagnostics
              const diagResult = await checkPostEditDiagnostics(
                absolutePath,
                normalizedContent,
                languageId,
                lspManager,
              );

              // Phase 2: Compiler fallback (runs if LSP found nothing)
              const compilerRunner = getCompilerForLanguage(languageId);
              let compilerResult: DiagnosticResult = { diagnostics: [], source: "none" };
              if (compilerRunner && diagResult.diagnostics.length === 0) {
                compilerResult = await compilerRunner(absolutePath, dirname(absolutePath));
              }

              // Aggregate results from both phases
              allDiagnostics = [...diagResult.diagnostics];
              if (diagResult.source === "lsp") editCapabilities.add("lspDiagnostics");
              if (compilerResult.diagnostics.length > 0) {
                allDiagnostics.push(...compilerResult.diagnostics);
                editCapabilities.add("compilerDiagnostics");
              }

              // ── Record cross-file breakage edges (Smart-Edit → Pi-SmartRead bridge) ──
              // When diagnostics point to files OTHER than the one being edited,
              // these are empirically observed semantic coupling edges that no
              // static analysis captured. Record them so Pi-SmartRead's graph
              // expansion considers them on subsequent retrieval calls.
              if (allDiagnostics.length > 0) {
                try {
                  for (const d of allDiagnostics) {
                    if (d.severity === 1) {
                      // Check if the diagnostic has a filePath that differs from the edit target
                      const diagFilePath = (d as Record<string, unknown>).filePath as string | undefined;
                      if (diagFilePath && diagFilePath !== absolutePath && diagFilePath !== path) {
                        const contextMsg = d.message.slice(0, 120);
                        recordBreakage(cwd, path, diagFilePath, contextMsg, 0.9);
                      }
                    }
                  }
                } catch {
                  // Breakage recording is advisory — silently ignore failures
                }

                const errors = allDiagnostics.filter((d) => d.severity === 1);
                const warnings = allDiagnostics.filter((d) => d.severity === 2);
                const sources = new Set([diagResult.source, compilerResult.source].filter(s => s !== "none"));

                if (errors.length > 0) {
                  matchNotes.push(
                    `⚠ ${[...sources].join("+")} detected ${errors.length} error(s): ` +
                    errors.map((e) => `line ${e.range.start.line + 1}: ${e.message}`).join("; ")
                  );
                }
                if (warnings.length > 0) {
                  matchNotes.push(
                    `ℹ ${[...sources].join("+")} has ${warnings.length} warning(s): ` +
                    warnings.map((w) => w.message).join("; ")
                  );
                }
              } else if (diagResult.source !== "none") {
                // LSP is active and found no issues
                matchNotes.push("✓ LSP validated: no issues found");
              }

              // ── Auto-validation with retry tracking (SmallCode-inspired) ──
              // Run structural check in addition to compiler diagnostics.
              // Track retries: after N failed attempts, signal decomposition.
              try {
                const structural = checkStructural(normalizedContent, absolutePath);
                if (!structural.passed) {
                  matchNotes.push(`⚠ Structural: ${structural.errors.join("; ")}`);
                }

                // Only count as a retry if validation found issues
                const hasErrors = !structural.passed || allDiagnostics.filter(d => d.severity === 1).length > 0;
                if (hasErrors) {
                  const retryCount = incRetryCount(cwd, path);
                  const MAX_RETRIES = 3;
                  if (retryCount > MAX_RETRIES) {
                    matchNotes.push(
                      `⚠ Decomposition suggested: ${retryCount} retries for ${path} (max ${MAX_RETRIES}). ` +
                      `Break this task into smaller, independently-validatable steps. ` +
                      `Consider: 1) write one function/section at a time, 2) validate each, 3) combine only after all pass.`
                    );
                  } else if (retryCount > 1) {
                    matchNotes.push(`ℹ Retry ${retryCount}/${MAX_RETRIES} — validation still shows issues in ${path}.`);
                  }
                }
              } catch {
                // Auto-validation is advisory — silent degradation
              }
            }
          }

          // ── Post-edit evidence pipeline (traceability, history, concurrency) ──
          // Run the full evidence pipeline to gather historical context for changed
          // symbols and detect co-change patterns. Co-change edges are recorded to
          // Pi-SmartRead's mutation log for future graph expansion.
          if (resultMatchSpans.length > 0) {
            try {
              const evidence = await runPostEditEvidencePipeline({
                cwd,
                path: absolutePath,
                content: normalizedContent,
                languageId: detectLanguageFromExtension(path) ?? "unknown",
                matchSpans: resultMatchSpans.map((s) => ({
                  startIndex: s.matchIndex,
                  endIndex: s.matchIndex + s.matchLength,
                })),
                editedPaths: [absolutePath],
                lspManager,
              });
              postEditEvidence = evidence;

              // Record co-change edges from git history analysis
              // Each history entry tells us a file/symbol was changed alongside
              // other files in the same commits. This is a weak signal (0.6)
              // that decays with time, but accumulates across many edit sessions.
              for (const h of evidence.details.history) {
                if (h.commits.length > 0 && h.target.path) {
                  try {
                    recordCoChange(
                      cwd,
                      absolutePath,
                      h.target.path,
                      `recent history: ${h.commits[0].hash.slice(0, 8)} ${h.commits[0].subject.slice(0, 60)}`,
                      0.6,
                    );
                  } catch {
                    // Co-change recording is advisory
                  }
                }
              }
            } catch {
              // Evidence pipeline failure is advisory — don't block the edit result
            }
          }

          if (allDiagnostics.length > 0 && postEditEvidence) {
            try {
              scopedDiagnostics = await scopeDiagnosticsToChangedTargets({
                cwd,
                path: absolutePath,
                content: normalizedContent,
                languageId: detectLanguageFromExtension(path) ?? "unknown",
                diagnostics: allDiagnostics,
                changedTargets: postEditEvidence.details.changes,
                lspManager,
              });
              if (scopedDiagnostics.length > 0) {
                editCapabilities.add("scopedDiagnostics");
                const editedCount = scopedDiagnostics.filter((d) => d.scope === "edited-symbol").length;
                const referenceCount = scopedDiagnostics.filter((d) => d.scope === "referencing-symbol").length;
                if (editedCount > 0 || referenceCount > 0) {
                  matchNotes.push(`ℹ Scoped diagnostics: ${editedCount} inside edited symbol(s), ${referenceCount} at reference site(s).`);
                }
              }
            } catch {
              // Scoped diagnostics are advisory.
            }
          }

          // Add match notes for transparency
          if (matchNotes.length > 0) {
            text += "\nNote: " + matchNotes.join(" ");
          }

          // ── Collect late/deferred diagnostics ──
          // After the initial response is built, wait briefly (2s) for any diagnostics
          // that the LSP server produces with a delay (e.g., type-checking after
          // document sync). If late diagnostics arrive, append them as follow-up
          // feedback so the model receives the full picture.
          if (deferralController) {
            const languageId = detectLanguageFromExtension(path) ?? "unknown";
            const lspServer = await lspManager?.getServer(languageId);
            const controller = deferralController;

            await new Promise<void>((promiseResolve) => {
              let didResolve = false;
              const subscription: { unsubscribe?: () => void } = {};

              function done() {
                if (didResolve) return;
                didResolve = true;
                clearTimeout(timer);
                subscription.unsubscribe?.();
                promiseResolve();
              }

              const timer = setTimeout(() => {
                done();
              }, 2000);
              timer.unref();

              if (!lspServer) {
                done();
                return;
              }

              const uri = `file://${resolve(absolutePath)}`;
              subscription.unsubscribe = lspServer.onNotification?.(
                "textDocument/publishDiagnostics",
                (params: unknown) => {
                  const p = params as {
                    uri?: string;
                    diagnostics?: Array<{
                      message: string;
                      severity?: number;
                      range?: {
                        start?: { line?: number; character?: number };
                        end?: { line?: number; character?: number };
                      };
                      source?: string;
                    }>;
                  };

                  if (p.uri !== uri) return;
                  if (!p.diagnostics) return;
                  for (const d of p.diagnostics) {
                    deferredDiagnostics.collect(absolutePath, {
                      message: d.message,
                      severity: (d.severity ?? 1) as 1 | 2 | 3 | 4,
                      range: {
                        start: {
                          line: d.range?.start?.line ?? 0,
                          character: d.range?.start?.character ?? 0,
                        },
                        end: {
                          line: d.range?.end?.line ?? 0,
                          character: d.range?.end?.character ?? 0,
                        },
                      },
                      source: d.source ?? "lsp",
                    });
                  }
                },
              );

              // Clean up listener when controller is aborted or timer fires
              controller.signal.addEventListener("abort", () => {
                done();
              });
            });

            // Flush any deferred diagnostics and append to result
            const late = deferredDiagnostics.flush(absolutePath);
            if (late.length > 0) {
              const errors = late.filter((ld) => ld.diagnostic.severity === 1);
              const warnings = late.filter((ld) => ld.diagnostic.severity === 2);

              if (errors.length > 0) {
                text += "\nLate diagnostic (error): " +
                  errors.map((e) => `line ${e.diagnostic.range.start.line + 1}: ${e.diagnostic.message}`).join("; ");
              }
              if (warnings.length > 0) {
                text += "\nLate diagnostic (warning): " +
                  warnings.map((w) => w.diagnostic.message).join("; ");
              }
            }
          }

          // Append conflict warnings
          if (conflictWarnings.length > 0) {
            text += "\n\n" + conflictWarnings.join("\n\n");
          }

          // Add conflict details to details output
          const details: {
            diff?: string;
            firstChangedLine?: number;
            matchNotes?: string[];
            conflictWarnings?: string[];
            mutatedPaths?: string[];
            diagnostics?: Array<{
              message: string;
              severity: 1 | 2 | 3 | 4;
              range: { start: { line: number; character: number }; end: { line: number; character: number } };
              source?: string;
              filePath?: string;
            }>;
            editCapabilities?: EditCapability[];
            scopedDiagnostics?: ScopedDiagnostic[];
          } = {
            diff: diffResult.diff,
            firstChangedLine: diffResult.firstChangedLine,
          };
          if (matchNotes.length > 0) {
            details.matchNotes = matchNotes;
          }
          if (conflictWarnings.length > 0) {
            details.conflictWarnings = conflictWarnings;
          }

          // Emit mutated path for context-optimizer integration.
          // This signals which files were actually changed so the context
          // optimizer can invalidate semantic cache entries without
          // re-parsing tool result text.
          details.mutatedPaths = [absolutePath];

          // Emit structured diagnostics for context-optimizer integration.
          // When diagnostics are available, the context optimizer's
          // tool_result_classifier consumes them as high-confidence
          // "current-failure" class content with exact file+line context,
          // rather than re-parsing from unstructured text.
          if (allDiagnostics && allDiagnostics.length > 0) {
            details.diagnostics = allDiagnostics.map((d) => ({
              message: d.message,
              severity: d.severity,
              range: d.range,
              source: d.source,
              filePath: d.filePath,
            }));
          }
          if (editCapabilities.size > 0) {
            details.editCapabilities = [...editCapabilities].sort();
          }
          if (scopedDiagnostics.length > 0) {
            details.scopedDiagnostics = scopedDiagnostics;
          }

          return {
            content: [{ type: "text", text }],
            details,
          };
        } catch (error) {
          if (signal) signal.removeEventListener("abort", onAbort);
          // Clean up deferred diagnostics collector on failure
          if (deferralController) {
            deferredDiagnostics.cancel(absolutePath);
          }

          if (!aborted) {
            const err = error instanceof Error ? error : new Error(String(error));

            // For edit-matching failures (stale file, oldText not found, etc.),
            // re-read the file from disk and include current content in the error.
            // This gives the user immediate context for retrying the edit.
            const isMatchFailure =
              err instanceof MatchError ||
              err instanceof HashlineMismatchError;

            if (isMatchFailure) {
              const enhancedError = await reReadAfterFailure(
                absolutePath,
                path,
                cwd,
                edits,
                err,
                smartEditRuntimeConfig.useHashlineEditing,
              );

              // Multi-file fallback hint: check if oldText exists in other session-read files.
              // Only for match-not-found errors (not stale-file, range-coverage, or ambiguity).
              if (
              err instanceof MatchError &&
              (err.code === "NOT_FOUND")
            ) {
                const multiFileHint = await buildMultiFileFallbackHint(
                  absolutePath,
                  edits,
                  cwd,
                );
                if (multiFileHint) {
                  throw new Error(enhancedError.message + multiFileHint);
                }
              }

              throw enhancedError;
            }

            throw err;
          }
          throw new Error("Operation aborted");
        }
      });
    },

    // ── TUI rendering (delegates to same diff rendering as built-in) ──
    // renderCall and renderResult are optional; Pi's built-in rendering
    // provides sensible defaults for tools with text results.
  } as unknown));
}

// ── Exports for testing ─────────────────────────────────────────────
// These are used by test/error-handling.test.ts only.
// At runtime, only the default export is consumed by Pi.
export {
  prepareArguments,
  formatEditError,
  validateInput,
};
