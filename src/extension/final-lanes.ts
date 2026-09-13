import { realpathSync } from "fs";
import { resolve } from "path";

import type { LSPManager } from "../lsp/lsp-manager";
import { checkPostEditDiagnostics } from "../lsp/diagnostics";
import type { createSmartReadDiagnosticsClient } from "../lsp/smartread-diagnostics-client.js";
import { getCompilerForLanguage } from "../lsp/diagnostic-dispatcher";
import { detectLanguageFromExtension } from "../lsp/language-id";
import { runPostEditEvidencePipeline } from "../verification/post-edit-evidence";
import { recordBreakage, recordCoChange } from "../context/smartread-bridge";

export function lineRangeToOffsets(content: string, range: { startLine: number; endLine: number }): { startIndex: number; endIndex: number } {
  const lines = content.split("\n");
  const offsetForLine = (line: number): number => lines.slice(0, Math.max(line - 1, 0)).reduce((offset, value) => offset + value.length + 1, 0);
  return {
    startIndex: offsetForLine(range.startLine),
    endIndex: Math.min(offsetForLine(range.endLine + 1), content.length),
  };
}

export type FinalLaneFile = {
  readonly path: string;
  readonly content: string;
  readonly oldContent: string;
  readonly changedLineRanges: ReadonlyArray<{ readonly startLine: number; readonly endLine: number }>;
};

export type FinalLaneContext = {
  cwd: string;
  diagnostics: string[];
  checks: Array<{ id: string; outcome: "pass" | "fail" | "skipped" | "timeout"; detail?: string }>;
  evidence: unknown[];
  editedPaths: string[];
  lspManager: LSPManager | null;
  diagnosticsClient: ReturnType<typeof createSmartReadDiagnosticsClient> | null;
};

/** runFinalSuccessLanes seam: per-file diagnostics + evidence finalization. */
export async function runSingleFileFinalLanes(file: FinalLaneFile, ctx: FinalLaneContext): Promise<void> {
  const languageId = detectLanguageFromExtension(file.path);
  if (!languageId) {
    ctx.checks.push({ id: `diagnostics:${file.path}`, outcome: "skipped", detail: "no language diagnostic lane" });
    return;
  }
  let lspConfirmed = false;
  if (ctx.lspManager) {
    const lsp = ctx.diagnosticsClient
      ? await ctx.diagnosticsClient.checkPostEditDiagnostics(file.path, file.content, languageId, ctx.cwd, ctx.lspManager)
      : await checkPostEditDiagnostics(file.path, file.content, languageId, ctx.lspManager);
    if (lsp.status === "confirmed") {
      lspConfirmed = true;
      const lspHasError = lsp.diagnostics.some((d) => d.severity === 1);
      ctx.checks.push({ id: `lsp:${file.path}`, outcome: lspHasError ? "fail" : "pass", detail: `${lsp.diagnostics.length} diagnostic(s), ${lsp.source}, ${lsp.status}` });
      ctx.diagnostics.push(...lsp.diagnostics.map((d) => `lsp ${file.path}:${d.range.start.line + 1}: ${d.message}`));
    } else {
      ctx.checks.push({ id: `lsp:${file.path}`, outcome: "skipped", detail: `${lsp.diagnostics.length} diagnostic(s), ${lsp.source}, ${lsp.status}` });
    }
  }
  const compiler = !lspConfirmed ? getCompilerForLanguage(languageId) : null;
  if (compiler) {
    const result = await compiler(file.path, ctx.cwd);
    const compilerHasError = result.diagnostics.some((d) => d.severity === 1);
    ctx.checks.push({ id: `compiler:${file.path}`, outcome: compilerHasError ? "fail" : "pass", detail: `${result.diagnostics.length} diagnostic(s), ${result.source}` });
    ctx.diagnostics.push(...result.diagnostics.map((d) => `${d.source} ${file.path}:${d.range.start.line + 1}: ${d.message}`));
    for (const diagnostic of result.diagnostics) {
      if (!diagnostic.filePath) continue;
      let canonicalDiagPath: string;
      try {
        canonicalDiagPath = realpathSync(resolve(ctx.cwd, diagnostic.filePath));
      } catch {
        canonicalDiagPath = resolve(ctx.cwd, diagnostic.filePath);
      }
      if (canonicalDiagPath !== file.path) {
        const bridgeError = recordBreakage(ctx.cwd, file.path, canonicalDiagPath, diagnostic.message);
        if (bridgeError) ctx.diagnostics.push(bridgeError);
      }
    }
  }
  const post = await runPostEditEvidencePipeline({
    cwd: ctx.cwd,
    path: file.path,
    content: file.content,
    oldContent: file.oldContent,
    languageId,
    matchSpans: file.changedLineRanges.map((range) => lineRangeToOffsets(file.content, range)),
    editedPaths: ctx.editedPaths,
    lspManager: ctx.lspManager as unknown as { getServer(languageId: string): unknown } | null,
    config: { repair: { enabled: false, maxRetries: 0, autoRepair: false, notifyOnRetry: false } },
  });
  ctx.evidence.push(post);
  ctx.diagnostics.push(...post.notes);
}

/** runFinalSuccessLanes seam: pairwise co-change recording. */
export function recordFileCoChanges(files: readonly FinalLaneFile[], cwd: string, diagnostics: string[]): void {
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const bridgeError = recordCoChange(cwd, files[i].path, files[j].path, "committed in one SmartEdit transaction");
      if (bridgeError) diagnostics.push(bridgeError);
    }
  }
}
