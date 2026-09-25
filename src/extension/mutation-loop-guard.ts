/**
 * Session-scoped repeated no-op guard shared by mutation frontends.
 *
 * One retry of an idempotent request is tolerated. If the exact same request
 * produces no change twice, the third identical call is rejected before the
 * mutation pipeline runs. Any real applied mutation clears the counters.
 */
import { createHash } from "node:crypto";
import type { PatchResult } from "../patch/types.js";
import { freshChecks, makeRejected } from "../patch/result-builders.js";
import type { MutationToolIdentity } from "../mutation/types.js";
import { appendDiagnosticsToContent } from "../mutation/post-mutation.js";

const BLOCK_AFTER_NOOPS = 2;
const MAX_FINGERPRINTS = 64;

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    if (key === "toolCallId" || key === "evidenceRef") continue;
    out[key] = normalize(input[key]);
  }
  return out;
}

function fingerprint(tool: MutationToolIdentity, params: Record<string, unknown>): string {
  return createHash("sha256")
    .update(tool)
    .update("\0")
    .update(JSON.stringify(normalize(params)))
    .digest("hex");
}

function resultText(result: PatchResult): string {
  return result.content.map((entry) => entry.text).join("\n");
}

function isNoopResult(result: PatchResult): boolean {
  const status = result.details?.status?.kind;
  const diagnostics = result.details?.diagnostics ?? [];
  const text = [resultText(result), ...diagnostics].join("\n");
  if (/\bNo changes made\b|\breplacements produced identical content\b|\bidempotent no-op\b/i.test(text)) {
    return true;
  }
  if (status !== "applied") return false;
  const changes = result.details.changedResources ?? [];
  const diffs = result.details.diffs ?? [];
  const emptyDiff = typeof result.details.diff !== "string" || result.details.diff.length === 0;
  const emptyDiffs = diffs.length === 0 || diffs.every((entry) => !entry.diff);
  const identicalResources = changes.length > 0 && changes.every((change) =>
    typeof change.fullFileSha256 === "string"
    && typeof change.newFullFileSha256 === "string"
    && change.fullFileSha256 === change.newFullFileSha256
  );
  return emptyDiff && emptyDiffs && identicalResources;
}

export class MutationLoopGuard {
  private readonly noops = new Map<string, number>();

  reset(): void {
    this.noops.clear();
  }

  preflight(
    tool: MutationToolIdentity,
    params: Record<string, unknown>,
    toolCallId: string,
  ): PatchResult | null {
    const key = fingerprint(tool, params);
    const count = this.noops.get(key) ?? 0;
    if (count < BLOCK_AFTER_NOOPS) return null;
    const diagnostic =
      `repeated no-op loop: this exact ${tool} request already produced no change ${count} times; re-read or change the request before retrying`;
    return {
      content: [{ type: "text", text: `rejected: ${diagnostic}` }],
      details: makeRejected(
        toolCallId,
        "conflict",
        [diagnostic],
        { inspectionId: "", resourceIds: [] },
        freshChecks(),
        [],
        [],
        tool,
      ),
    };
  }

  observe(
    tool: MutationToolIdentity,
    params: Record<string, unknown>,
    result: PatchResult,
  ): PatchResult {
    const key = fingerprint(tool, params);
    if (isNoopResult(result)) {
      const count = (this.noops.get(key) ?? 0) + 1;
      this.noops.delete(key);
      this.noops.set(key, count);
      while (this.noops.size > MAX_FINGERPRINTS) {
        const oldest = this.noops.keys().next().value as string | undefined;
        if (!oldest) break;
        this.noops.delete(oldest);
      }
      if (count === BLOCK_AFTER_NOOPS) {
        const note = "\n\nNo-op loop guard: this exact request has produced no change twice. An identical next call will be rejected; re-read or change the request.";
        return {
          ...result,
          content: appendDiagnosticsToContent(result.content, note) as typeof result.content,
        };
      }
      return result;
    }
    if (result.details?.status?.kind === "applied") {
      this.noops.clear();
    }
    return result;
  }
}
