/**
 * Smart Edit — Improved edit tool extension for Pi Coding Agent.
 *
 * Overrides Pi's built-in edit tool with improved matching, fuzzy-match
 * safety, replaceAll support, stale-file detection, atomic writes, and
 * richer diagnostics.
 *
 * Installation: copy to ~/.pi/agent/extensions/smart-edit.ts
 *   or load ./src/index.ts for repository-local use.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import { constants, statSync } from "fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { dirname, resolve } from "path";
import { sortHashlineEditsForApplication, formatHashlineBatchSummary } from "./hashline-batching.js";
import {
  prepareArguments,
  validateInput,
  formatEditError,
} from "./args.js";

import { createConflictDetector, defaultConflictConfig } from "./core/conflict-detector";
import { createAstResolver } from "./core/ast-resolver";

import { recordRead, recordReadSession, getSnapshot } from "./core/read-cache";
import type { HashlineEditInput } from "./core/hashline-edit";
import { buildHashlineAnchors } from "./core/hashline";

import { LSPManager } from "./lsp/lsp-manager";
import { checkPostEditDiagnostics } from "./lsp/diagnostics";
import { deferredDiagnostics } from "./lsp/deferred-diagnostics";
import { getCompilerForLanguage } from "./lsp/diagnostic-dispatcher";
import type { DiagnosticResult } from "./lsp/diagnostic-dispatcher";

import { recordBreakage, recordCoChange } from "./smartread-bridge";
import { getSmartEditRuntimeConfig } from "./edit-mode";
import { saveUndoState } from "./undo/edit-history";
import { atomicWrite } from "./undo/atomic-write";
import { MatchError } from "./core/errors";
import { runAutoValidation, formatValidationFeedback, resetRetryCounts, checkStructural, incrementRetryCount as incRetryCount } from "./verification/auto-validate";
import { applySymbolicEdits, buildSymbolicEditGuidance, resolveSymbolicEditLineRange } from "./symbolic-edits";
import type { SymbolicEditRequest } from "./symbolic-edits";
import { computeAnchorDelta, formatAnchorDeltaForModel, ANCHOR_CHURN_THRESHOLD, type AnchorDelta } from "./anchor-registry";
import { isAstGrepAvailable, findWithPattern, replaceWithPattern } from "./astgrep-anchor";
import { createPatchTool, type PatchToolDeps, type PatchToolDetails } from "./patch.js";
import { createRpcClient, RPC_CHANNELS } from "@rhinos0608/pi-workspace-protocol";

import type {
  EditTarget,
  EditItem,
  EditInput,
  EditResult,
  EditCapability,
  MatchSpan,
  SearchScope,
} from "./core/types";
import { MatchTier } from "./core/types";

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

// ─── Schema ───────────────────────────────────────────────────────
// Rich edit metadata is validated directly. Legacy path-encoded metadata
// remains decode-only compatibility input during migration.


const editItemSchema = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "File path for this edit. Required on every item in a multi-file call." })),
    oldText: Type.Optional(Type.String()),
    newText: Type.Optional(Type.String()),
    description: Type.Optional(Type.String({ description: "Optional label echoed in diagnostics for self-reference." })),
    replaceAll: Type.Optional(Type.Boolean({
      description: "Replace every non-overlapping occurrence for this edit. Overrides top-level replaceAll.",
    })),
    hashline: Type.Optional(Type.Object(
      {
        range: Type.Object({
          pos: Type.String({ description: "Start hashline anchor, optionally with :before or :after." }),
          end: Type.String({ description: "End hashline anchor." }),
        }),
        content: Type.Optional(Type.Union([
          Type.Array(Type.String()),
          Type.String(),
          Type.Null(),
        ])),
        symbol: Type.Optional(Type.Object({
          name: Type.String(),
          kind: Type.Optional(Type.String()),
          line: Type.Optional(Type.Number()),
        })),
      },
      { description: "Freshness-checked hashline edit metadata." },
    )),
    target: Type.Optional(Type.Object(
      {
        name: Type.Optional(Type.String({ description: "Symbol name to target (e.g., function name, class name)." })),
        namePath: Type.Optional(Type.String({ description: "Qualified symbol path; the final component is matched by AST name (e.g., 'MyClass.myMethod')." })),
        kind: Type.Optional(Type.String({ description: "AST node kind hint (e.g., 'function_declaration', 'class_declaration')." })),
        line: Type.Optional(Type.Number({ description: "1-based line hint for disambiguation when multiple symbols share a name." })),
        replaceBody: Type.Optional(Type.String({ description: "Replace the entire AST symbol definition with this text." })),
        insertBefore: Type.Optional(Type.String({ description: "Insert this text immediately before the AST symbol definition." })),
        insertAfter: Type.Optional(Type.String({ description: "Insert this text immediately after the AST symbol definition." })),
        description: Type.Optional(Type.String({ description: "Optional target label for diagnostics." })),
        pattern: Type.Optional(Type.String({ description: "ast-grep structural pattern." })),
        replacement: Type.Optional(Type.String({ description: "Replacement for ast-grep pattern matches." })),
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
    path: Type.Optional(Type.String({
      description: "Default file path for single-file edits. May be omitted when each edit includes its own path.",
    })),
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

export function resolveEditPath(cwd: string, targetPath: string): string {
  return resolve(cwd, targetPath);
}

type EditRenderArgs = {
  path?: unknown;
  edits?: unknown;
};

type EditRenderResult = {
  content: Array<{ type: string; text?: string }>;
  details?: PatchToolDetails;
};

class EditTextComponent implements Component {
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

function renderEditDiff(diff: string, theme: Theme): string {
  return diff.split("\n").map((line) => {
    if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
    if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
    return theme.fg("toolDiffContext", line);
  }).join("\n");
}

export function getEditDisplayPaths(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const input = args as EditRenderArgs;
  const defaultPath = typeof input.path === "string" ? input.path : undefined;
  const edits = Array.isArray(input.edits) ? input.edits : [];
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
    const output = diffs
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

type ToolEditResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: EditResult["details"];
};

export function combineMultiFileEditResults(results: ToolEditResult[]): ToolEditResult {
  const details: EditResult["details"] = {};
  const diffs: string[] = [];
  const matchNotes: string[] = [];
  const conflictWarnings: string[] = [];
  const mutatedPaths = new Set<string>();
  const diagnostics: NonNullable<EditResult["details"]["diagnostics"]> = [];
  const editCapabilities = new Set<EditCapability>();
  const scopedDiagnostics: NonNullable<EditResult["details"]["scopedDiagnostics"]> = [];

  for (const result of results) {
    const childDetails = result.details;
    if (!childDetails) continue;
    if (childDetails.diff) diffs.push(childDetails.diff);
    matchNotes.push(...(childDetails.matchNotes ?? []));
    conflictWarnings.push(...(childDetails.conflictWarnings ?? []));
    for (const path of childDetails.mutatedPaths ?? []) mutatedPaths.add(path);
    diagnostics.push(...(childDetails.diagnostics ?? []));
    for (const capability of childDetails.editCapabilities ?? []) editCapabilities.add(capability);
    scopedDiagnostics.push(...(childDetails.scopedDiagnostics ?? []));
  }

  if (diffs.length > 0) details.diff = diffs.join("\n");
  if (matchNotes.length > 0) details.matchNotes = matchNotes;
  if (conflictWarnings.length > 0) details.conflictWarnings = conflictWarnings;
  if (mutatedPaths.size > 0) details.mutatedPaths = [...mutatedPaths];
  if (diagnostics.length > 0) details.diagnostics = diagnostics;
  if (editCapabilities.size > 0) details.editCapabilities = [...editCapabilities].sort();
  if (scopedDiagnostics.length > 0) details.scopedDiagnostics = scopedDiagnostics;

  return {
    content: results.flatMap((result) => result.content),
    details,
  };
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

    // ── Shared single-file read+record+validation helper ──
    // Used by both write and edit post-processing paths. Returns undefined when
    // the file is empty, validation passed, or no feedback was produced.
    const validateFileAndBuildFeedback = async (
      filePath: string,
      cwd: string,
    ): Promise<
      | {
          path: string;
          feedback: string;
          retryCount: number;
          shouldDecompose: boolean;
        }
      | undefined
    > => {
      const resolvedPath = resolve(cwd, filePath);
      const content = (await fsReadFile(resolvedPath)).toString("utf-8");
      if (!content) {
        // Empty files are recorded as reads but skip validation; this matches
        // the existing write-path behavior and makes edit-path behavior consistent.
        return undefined;
      }

      recordRead(filePath, cwd, content);
      const lines = content.split("\n");
      recordReadSession(filePath, cwd, 1, -1, lines.length, "edit");

      // ── Auto-validation hook (SmallCode-inspired) ──
      // After a write/edit, run structural + compiler/linter validation.
      // Feed errors back as structured data on the event for the model to see.
      //
      // VALIDATION IS ADVISORY: runAutoValidation runs asynchronously and may
      // complete after this handler returns. Consumers MUST NOT rely on
      // event.validationFeedback being present synchronously. The promise is
      // intentionally fire-and-forget so write/edit results are not blocked by
      // validation overhead — the model receives diagnostics as a later signal
      // rather than a blocking response. See formatValidationFeedback for the
      // shape of validation feedback that gets attached to the event object.
      const validationResult = await runAutoValidation(filePath, content, {
        cwd,
        maxRetries: 3,
        enabled: true,
      });
      if (validationResult.passed) return undefined;
      const feedback = formatValidationFeedback(validationResult);
      if (!feedback) return undefined;
      return {
        path: filePath,
        feedback,
        retryCount: validationResult.retryCount,
        shouldDecompose: validationResult.shouldDecompose,
      };
    };

    // ── Track writes so write-then-edit flow doesn't trigger stale-file guard ──
    const writePath = (event.input as { path?: string } | undefined)?.path;
    if (
      event.toolName === "write" &&
      !event.isError &&
      writePath
    ) {
      try {
        validateFileAndBuildFeedback(writePath, toolCwd)
          .then((entry) => {
            if (!entry) return;
            const ev = event as unknown as Record<string, unknown>;
            ev.validationFeedback = entry.feedback;
            ev.validationRetries = entry.retryCount;
            ev.shouldDecompose = entry.shouldDecompose;
          })
          .catch(() => {
            // Validation is advisory — silent degradation
          });
      } catch {
        // File might not exist yet or can't be read — skip silently
      }
    }

    // ── Track edits so edit-then-edit flow doesn't trigger stale-file guard ──
    // Also mirrors the write advisory auto-validation hook for multi-file edits.
    if (
      event.toolName === "edit" &&
      !event.isError
    ) {
      try {
        const details = (event as unknown as { details?: PatchToolDetails }).details;
        if (
          details?.status?.kind === "applied" &&
          Array.isArray(details.diffs) &&
          details.diffs.length > 0
        ) {
          const uniquePaths = [
            ...new Set(
              details.diffs
                .map((d) => d.path)
                .filter((p): p is string => typeof p === "string"),
            ),
          ];
          if (uniquePaths.length > 0) {
            Promise.allSettled(uniquePaths.map((p) => validateFileAndBuildFeedback(p, toolCwd)))
              .then((results) => {
                const entries = results
                  .map((r) => (r.status === "fulfilled" ? r.value : undefined))
                  .filter(
                    (
                      v,
                    ): v is {
                      path: string;
                      feedback: string;
                      retryCount: number;
                      shouldDecompose: boolean;
                    } => !!v,
                  );
                if (entries.length === 0) return;
                const ev = event as unknown as Record<string, unknown>;
                if (entries.length === 1) {
                  ev.validationFeedback = entries[0].feedback;
                } else {
                  ev.validationFeedback = entries
                    .map((e) => `${e.path}:\n${e.feedback}`)
                    .join("\n\n");
                }
                ev.validationRetries = Math.max(...entries.map((e) => e.retryCount));
                ev.shouldDecompose = entries.some((e) => e.shouldDecompose);
              })
              .catch(() => {
                // Validation is advisory — silent degradation
              });
          }
        }
      } catch {
        // Edit post-validation is advisory — silent degradation
      }
    }
  });

  // ── Initialize per-session state ──
  let currentSessionFilePath: string | null = null;
  let currentCanonicalWorkspaceRoot: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
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

    // Capture the real session file path and canonical workspace root.
    // We require a REAL (non-ephemeral) session file for `patch` authorization.
    try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined)
        ?.sessionManager;
      const p = typeof sm?.getSessionFile === "function" ? sm.getSessionFile() : undefined;
      currentSessionFilePath = typeof p === "string" && p.length > 0 ? p : null;
    } catch {
      currentSessionFilePath = null;
    }
    try {
      // canonical workspace root = realpath of cwd, no trailing slash
      const { realpathSync } = await import("node:fs");
      let r = realpathSync(sessionCwd);
      if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
      currentCanonicalWorkspaceRoot = r;
    } catch {
      currentCanonicalWorkspaceRoot = null;
    }
  });

  // ── Shutdown on session end ──
  pi.on("session_shutdown", async () => {
    await lspManager?.shutdown();
    lspManager = null;
  });


  // ── Register `edit` tool (overrides native built-in edit) ──
  // v3: workspace-evidence gated. Uses patch implementation under the hood.
  // Rejects ephemeral session identity.
  if (pi.events && typeof pi.events.on === "function") {
    const bus = pi.events as {
      emit: (c: string, d: unknown) => void;
      on: (c: string, h: (d: unknown) => void) => () => void;
    };
    const patchDeps: PatchToolDeps = {
      getRpcClient: () => createRpcClient({ bus, channel: RPC_CHANNELS.inspectPatch, timeoutMs: 2000 }),
      getSessionFilePath: () => currentSessionFilePath,
      getCanonicalWorkspaceRoot: () => currentCanonicalWorkspaceRoot ?? "",
    };
    const patchTool = createPatchTool(patchDeps);
    (pi.registerTool as (t: unknown) => void)({
      ...patchTool,
      name: "edit",
      label: "edit",
      renderShell: "self",
      renderCall: renderEditCall,
      renderResult: renderEditResult,

      // Compatibility shim for resumed sessions with stored `edit` calls
      // using flat oldText/newText instead of edits array.
      prepareArguments(args: Record<string, unknown> | undefined): Record<string, unknown> {
        if (!args || typeof args !== "object") return args ?? {};
        const input = args as { oldText?: unknown; newText?: unknown };
        if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
          return args;
        }
        // Migrate flat single oldText/newText to edits array.
        return { ...args, edits: [{ oldText: input.oldText, newText: input.newText }] };
      },
    } as unknown);
  }
}

// ── Exports for testing ─────────────────────────────────────────────
// These are used by test/error-handling.test.ts only.
// At runtime, only the default export is consumed by Pi.
export {
  prepareArguments,
  formatEditError,
  validateInput,
};
