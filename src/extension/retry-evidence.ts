import { realpathSync } from "fs";
import { readFile as fsReadFile } from "fs/promises";
import { resolve } from "path";
import {
  PROTOCOL_SCHEMA_VERSION,
  hashSessionFilePath,
  inspectionIdFor,
  resourceIdFor,
  sha256OfString,
  type LineRange,
  type WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";

export type RetryToolEvent = {
  input?: unknown;
  details?: unknown;
  content?: unknown;
  isError?: boolean;
  toolName?: string;
};

export type RetrySessionState = {
  sessionFilePath: string | null;
  canonicalWorkspaceRoot: string | null;
  priorAuthority: PriorAuthorityStore | null;
};

export type RetryEligibility = {
  canonicalPath: string;
  content: string;
  sha: string;
  resource: NonNullable<ReturnType<PriorAuthorityStore["select"]>>;
  explicitRange?: { startLine: number; endLine: number };
  matchFailure: "NOT_FOUND" | "AMBIGUOUS";
  oldText: string;
};

/** buildRetryEvidence seam: eligibility + target resolution + prior-authority freshness. */
export async function checkRetryEligibility(
  event: RetryToolEvent,
  cwd: string,
  state: RetrySessionState,
): Promise<RetryEligibility | undefined> {
  if (event.toolName !== "edit" || event.isError || !state.sessionFilePath || !state.canonicalWorkspaceRoot) return undefined;
  const details = event.details as { status?: { kind?: string; phase?: string }; matchFailure?: string } | undefined;
  if (details?.status?.kind !== "failed" || details.status.phase !== "stage") return undefined;
  if (details.matchFailure !== "NOT_FOUND" && details.matchFailure !== "AMBIGUOUS") return undefined;
  const input = event.input as { path?: unknown; edits?: unknown; raw?: unknown } | undefined;
  if (!input || input.raw !== undefined || !Array.isArray(input.edits) || input.edits.length !== 1) return undefined;
  const edit = input.edits[0] as { path?: unknown; oldText?: unknown; target?: unknown; lineRange?: unknown; hashline?: unknown };
  if (typeof edit?.oldText !== "string" || edit.target !== undefined || edit.hashline !== undefined) return undefined;
  if (input.path !== undefined && typeof input.path !== "string") return undefined;
  if (edit.path !== undefined && typeof edit.path !== "string") return undefined;
  if (input.path !== undefined && edit.path !== undefined && resolve(cwd, input.path) !== resolve(cwd, edit.path)) return undefined;
  const targetPath = typeof input.path === "string" ? input.path : edit.path;
  if (typeof targetPath !== "string" || targetPath.length === 0) return undefined;
  const lineRange = edit.lineRange as { startLine?: unknown; endLine?: unknown } | undefined;
  const explicitRange = lineRange && Number.isInteger(lineRange.startLine) && Number.isInteger(lineRange.endLine)
    ? { startLine: lineRange.startLine as number, endLine: lineRange.endLine as number } : undefined;
  const resolvedPath = resolve(cwd, targetPath);
  let canonicalPath: string;
  try { canonicalPath = realpathSync(resolvedPath); } catch { return undefined; }
  const resource = state.priorAuthority?.select(canonicalPath);
  if (!resource || (resource.coverage !== "full-file" && resource.coverage !== "line-range") || typeof resource.fullFileSha256 !== "string") return undefined;
  let content: string;
  try { content = (await fsReadFile(canonicalPath)).toString("utf8"); } catch { return undefined; }
  const sha = sha256OfString(content);
  if (sha !== resource.fullFileSha256) return undefined;
  return { canonicalPath, content, sha, resource, explicitRange, matchFailure: details.matchFailure, oldText: edit.oldText };
}

/** buildRetryEvidence seam: context-window collection around the failure site. */
export function collectRetryWindows(
  content: string,
  explicitRange: { startLine: number; endLine: number } | undefined,
  matchFailure: "NOT_FOUND" | "AMBIGUOUS",
  oldText: string,
): LineRange[] | undefined {
  const lines = content.split("\n");
  const ranges: LineRange[] = [];
  const addWindow = (line: number) => {
    if (!Number.isInteger(line) || line < 1 || line > lines.length) return;
    ranges.push({ startLine: Math.max(1, line - 2), endLine: Math.min(lines.length, line + 2) });
  };
  if (explicitRange) addWindow(explicitRange.startLine);
  if (matchFailure === "AMBIGUOUS" && !explicitRange && oldText.length > 0) {
    let from = 0;
    while (ranges.length < 3) {
      const at = content.indexOf(oldText, from);
      if (at < 0) break;
      addWindow(content.slice(0, at).split("\n").length);
      from = at + Math.max(1, oldText.length);
    }
  }
  if (ranges.length === 0) return undefined;
  return ranges;
}

/** buildRetryEvidence seam: intersect candidate windows with prior authority. */
export function authorizeRetryWindows(
  resource: RetryEligibility["resource"],
  ranges: LineRange[],
): LineRange[] {
  const authorized = resource.coverage === "full-file" ? ranges : ranges.flatMap((candidate) => resource.allowedRanges.flatMap((allowed) => {
    const startLine = Math.max(candidate.startLine, allowed.startLine);
    const endLine = Math.min(candidate.endLine, allowed.endLine);
    return startLine <= endLine ? [{ startLine, endLine }] : [];
  }));
  return [...new Map(authorized.map((range) => [`${range.startLine}:${range.endLine}`, range])).values()].slice(0, 3);
}

/** buildRetryEvidence seam: cap windows by count, line budget, byte budget. */
export function applyRetryBudget(unique: LineRange[], lines: string[]): LineRange[] | undefined {
  const selected: LineRange[] = [];
  let bytes = 0;
  for (const range of unique) {
    const source = lines.slice(range.startLine - 1, range.endLine).join("\n");
    const size = Buffer.byteLength(source, "utf8");
    if (selected.length >= 3 || selected.reduce((n, r) => n + r.endLine - r.startLine + 1, 0) + range.endLine - range.startLine + 1 > 24 || bytes + size > 8192) break;
    selected.push(range); bytes += size;
  }
  if (selected.length === 0) return undefined;
  return selected;
}

/** buildRetryEvidence seam: freshness re-read + envelope mint (keeps session/root recheck). */
export async function mintRetryEvidenceFromSelection(
  selected: LineRange[],
  canonicalPath: string,
  sha: string,
  state: RetrySessionState,
): Promise<{ envelope: WorkspaceEvidenceEnvelope; text: string } | undefined> {
  // Re-read after range selection: a concurrent write must never mint retry authority.
  let confirm: string;
  try { confirm = (await fsReadFile(canonicalPath)).toString("utf8"); } catch { return undefined; }
  if (sha256OfString(confirm) !== sha) return undefined;
  const resources = selected.map((range) => ({
    resourceId: resourceIdFor({ canonicalPath, kind: "range", range }), canonicalPath, kind: "range" as const,
    coverage: "line-range" as const, allowedRanges: [range], fullFileSha256: sha,
    fresh: true, byteLength: Buffer.byteLength(confirm, "utf8"), lineCount: confirm.split("\n").length,
  }));
  const sessionFilePath = state.sessionFilePath;
  const workspaceRoot = state.canonicalWorkspaceRoot;
  if (!sessionFilePath || !workspaceRoot) return undefined;
  const sessionId = hashSessionFilePath(sessionFilePath);
  const envelope: WorkspaceEvidenceEnvelope = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    inspectionId: inspectionIdFor({ sessionId, workspaceRoot, resources: resources.map((r) => ({ canonicalPath: r.canonicalPath, allowedRanges: r.allowedRanges })) }),
    sessionId, workspaceRoot, canonicalWorkspaceRoot: workspaceRoot,
    createdAt: new Date().toISOString(), resources, mode: "path",
  };
  const text = selected.map((range) => `lineRange ${range.startLine}-${range.endLine}:\n${confirm.split("\n").slice(range.startLine - 1, range.endLine).join("\n")}`).join("\n");
  return { envelope, text };
}
