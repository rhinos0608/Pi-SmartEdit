import { fileURLToPath } from "url";
import { resolve } from "path";
import { findReferences } from "../lsp/semantic-nav";
import type { LSPManager } from "../lsp/lsp-manager";
import type { ChangedTarget } from "./types";

export interface DiagnosticLike {
  message: string;
  severity: 1 | 2 | 3 | 4;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  source?: string;
  filePath?: string;
}

export interface ScopedDiagnostic {
  diagnostic: DiagnosticLike;
  scope: "edited-symbol" | "referencing-symbol" | "same-file" | "other-file";
  targetName?: string;
  referenceCount?: number;
}

export interface ScopeDiagnosticsInput {
  cwd: string;
  path: string;
  content: string;
  languageId: string;
  diagnostics: DiagnosticLike[];
  changedTargets: ChangedTarget[];
  lspManager: null | Pick<LSPManager, "getServer">;
}

interface ReferenceIndexEntry {
  target: ChangedTarget;
  locations: Array<{ filePath: string; line: number }>;
}

export async function scopeDiagnosticsToChangedTargets(
  input: ScopeDiagnosticsInput,
): Promise<ScopedDiagnostic[]> {
  const referenceIndex = await buildReferenceIndex(input);

  return input.diagnostics.map((diagnostic) => {
    const diagnosticPath = normalizeDiagnosticPath(diagnostic.filePath, input.path, input.cwd);
    const diagnosticLine = diagnostic.range.start.line;

    const editedTarget = input.changedTargets.find((target) =>
      samePath(target.path, diagnosticPath) &&
      diagnosticLine >= target.lineRange.startLine - 1 &&
      diagnosticLine <= target.lineRange.endLine - 1,
    );
    if (editedTarget) {
      return {
        diagnostic,
        scope: "edited-symbol",
        targetName: editedTarget.name,
      } satisfies ScopedDiagnostic;
    }

    const referenceTarget = referenceIndex.find((entry) =>
      entry.locations.some((location) =>
        samePath(location.filePath, diagnosticPath) && location.line === diagnosticLine,
      ),
    );
    if (referenceTarget) {
      return {
        diagnostic,
        scope: "referencing-symbol",
        targetName: referenceTarget.target.name,
        referenceCount: referenceTarget.locations.length,
      } satisfies ScopedDiagnostic;
    }

    return {
      diagnostic,
      scope: samePath(diagnosticPath, input.path) ? "same-file" : "other-file",
    } satisfies ScopedDiagnostic;
  });
}

async function buildReferenceIndex(input: ScopeDiagnosticsInput): Promise<ReferenceIndexEntry[]> {
  if (!input.lspManager) return [];

  const entries: ReferenceIndexEntry[] = [];
  for (const target of input.changedTargets) {
    const position = findNamePosition(input.content, target);
    if (!position) continue;

    const references = await findReferences(
      input.path,
      position.line,
      position.character,
      input.languageId,
      input.lspManager,
    );

    entries.push({
      target,
      locations: references.map((reference) => ({
        filePath: uriToPath(reference.uri),
        line: reference.range.start.line,
      })),
    });
  }

  return entries;
}

function findNamePosition(
  content: string,
  target: ChangedTarget,
): { line: number; character: number } | null {
  if (!target.name || target.name.startsWith("<")) return null;
  const lines = content.split("\n");
  const start = Math.max(target.lineRange.startLine - 1, 0);
  const end = Math.min(target.lineRange.endLine - 1, lines.length - 1);

  for (let line = start; line <= end; line++) {
    const character = lines[line]?.indexOf(target.name) ?? -1;
    if (character >= 0) return { line, character };
  }

  return { line: start, character: 0 };
}

function normalizeDiagnosticPath(
  filePath: string | undefined,
  fallbackPath: string,
  cwd: string,
): string {
  if (!filePath) return resolve(fallbackPath);
  if (filePath.startsWith("file://")) return uriToPath(filePath);
  return resolve(cwd, filePath);
}

function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return fileURLToPath(uri);
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}
