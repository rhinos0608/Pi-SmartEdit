/**
 * Post-edit evidence pipeline orchestrator.
 *
 * Wires together all verification lanes after a successful edit:
 *
 * 1. Build changed targets from edit match spans + AST resolution.
 * 2. Detect concurrency signals within changed ranges.
 * 3. Run concurrency verification tools when signals are present.
 * 4. Run traceability analysis for logic changes.
 * 5. Retrieve historical context for edited symbols.
 *
 * The pipeline is designed to be advisory: lane failures produce notes
 * but never prevent the edit from succeeding.
 */

import { relative } from "path";
import { buildChangedTargets } from "./change-targets";
import { attachConcurrencySignals, hasConcurrencySignals } from "./concurrency-detector";
import { createVerificationTools, selectTool } from "./concurrency-tools";
import { retrieveHistory } from "./history-context";
import { analyzeTraceability } from "./traceability";
import { defaultVerificationConfig } from "./config";
import { isVerificationActive } from "./config";
import type { VerificationConfig } from "./types";
import type { PostEditEvidenceResult, ConcurrencyEvidence } from "./types";
import type { ChangedTarget } from "./types";

// ─── Public API ─────────────────────────────────────────────────────

export interface PostEditEvidenceInput {
  /** Project root directory */
  cwd: string;
  /** Absolute path to the edited file */
  path: string;
  /** Post-edit file content (LF-normalized, BOM-stripped) */
  content: string;
  /** Language ID from the edit pipeline */
  languageId: string;
  /** Byte ranges of actual changes from edit match spans */
  matchSpans: Array<{ startIndex: number; endIndex: number }>;
  /** All file paths edited in this batch */
  editedPaths: string[];
  /** LSP manager (optional — for reference-based traceability) */
  lspManager: null | {
    getServer(languageId: string): unknown;
  };
  /** Verification configuration (defaults used when not provided) */
  config?: Partial<VerificationConfig>;
}

/**
 * Run the full post-edit evidence pipeline.
 *
 * Safe to call after any edit: lane failures produce notes in the
 * result but never throw. The edit result is not affected.
 */
export async function runPostEditEvidencePipeline(
  input: PostEditEvidenceInput,
): Promise<PostEditEvidenceResult> {
  const config = mergeConfig(input.config);
  const notes: string[] = [];
  const changes: ChangedTarget[] = [];
  const concurrency: ConcurrencyEvidence[] = [];
  let traceability = null;
  const history: Awaited<ReturnType<typeof retrieveHistory>> = [];

  if (!isVerificationActive(config)) {
    return { notes, details: { changes, concurrency, traceability, history } };
  }

  // ── Phase A: Build changed targets ──
  try {
    const targets = await buildChangedTargets({
      path: input.path,
      content: input.content,
      languageId: input.languageId,
      matchSpans: input.matchSpans,
      testGlobs: config.traceability.testGlobs,
    });
    changes.push(...targets);
  } catch (err) {
    notes.push(
      `ℹ Evidence (targets): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Phase B: Concurrency detection and verification ──
  if (config.concurrency.enabled && changes.length > 0) {
    try {
      // Attach concurrency signals to targets
      attachConcurrencySignals(input.content, changes);

      // Find targets that have signals
      const signalTargets = changes.filter((t) =>
        hasConcurrencySignals(t.concurrencySignals),
      );

      if (signalTargets.length > 0) {
        // Run concurrency verification tools
        const tools = createVerificationTools(config.concurrency);
        const toolInput = {
          cwd: input.cwd,
          filePath: input.path,
          languageId: input.languageId,
          changedTargets: signalTargets,
          timeoutMs: config.maxInlineMs,
        };

        const selectedTool = await selectTool(tools, toolInput);

        if (selectedTool) {
          const results = await selectedTool.run(toolInput);
          concurrency.push(...results);
        } else {
          // No tool available — emit advisory note per signal target
          const signalCategories = [
            ...new Set(signalTargets.flatMap((t) =>
              t.concurrencySignals.map((s) => s.category),
            )),
          ];

          for (const target of signalTargets) {
            concurrency.push({
              target,
              tool: "none",
              command: [],
              status: "skipped",
              diagnostics: [{
                message: `Concurrency signals detected (${target.concurrencySignals.map((s) => s.token).join(", ")}) but no verification tool configured or available`,
                severity: 3,
              }],
              note: `Edited ${target.kind} \`${target.name}\` with concurrency signals (${signalCategories.join(", ")}). Run a targeted test or configure smartEdit.verification.concurrency.commands.`,
            });
          }

          const first = signalTargets[0];
          notes.push(
            `⚠ Concurrency: edited ${first.kind} \`${first.name}\` with concurrency-sensitive code; no configured verification tool found.`,
          );
        }
      }
    } catch (err) {
      notes.push(
        `ℹ Evidence (concurrency): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Phase C: Traceability analysis ──
  if (config.traceability.enabled && changes.length > 0) {
    try {
      traceability = await analyzeTraceability({
        cwd: input.cwd,
        path: input.path,
        content: input.content,
        changedTargets: changes,
        editedPaths: input.editedPaths,
        lspManager: input.lspManager,
        config: config.traceability,
      });

      // Generate human-readable traceability notes
      for (const t of traceability.targets) {
        if (t.status === "missing") {
          notes.push(
            `⚠ Traceability: changed \`${t.target.name}\`, but no linked test was found.`,
          );
        } else if (t.status === "candidate") {
          if (!t.linkedTests || t.linkedTests.length === 0) {
            notes.push(
              `ℹ Traceability: changed \`${t.target.name}\`. No candidate tests found.`,
            );
            continue;
          }
          const testPath = shortenPath(t.linkedTests[0], input.cwd);
          notes.push(
            `ℹ Traceability: changed \`${t.target.name}\`. ${t.linkedTests.length === 1 ? "Candidate test: " + testPath + ". Consider running it." : "Found " + t.linkedTests.length + " candidate tests."}`,
          );
        }
      }
    } catch (err) {
      notes.push(
        `ℹ Evidence (traceability): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Phase D: Historical context retrieval ──
  if (config.history.enabled && changes.length > 0) {
    try {
      const historyResults = await retrieveHistory({
        cwd: input.cwd,
        changedTargets: changes,
        content: input.content,
        config: config.history,
      });

      if (historyResults.length > 0) {
        for (const h of historyResults) {
          const riskyCommits = h.commits.filter(
            (c) => c.reason === "risky",
          );
          if (riskyCommits.length > 0) {
            const latest = riskyCommits[0];
            const shortHash = latest.hash.slice(0, 8);
            notes.push(
              `ℹ History: \`${h.target.name}\` last changed in commit ${shortHash} "${latest.subject}". Verify this change doesn't reintroduce a known issue.`,
            );
          } else if (h.commits.length > 0) {
            const latest = h.commits[0];
            const shortHash = latest.hash.slice(0, 8);
            notes.push(
              `ℹ History: \`${h.target.name}\` was changed in commit ${shortHash} "${latest.subject}".`,
            );
          }
        }

        history.push(...historyResults);
      }
    } catch (err) {
      notes.push(
        `ℹ Evidence (history): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    notes,
    details: {
      changes,
      concurrency,
      traceability,
      history,
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function mergeConfig(partial?: Partial<VerificationConfig>): VerificationConfig {
  const defaults = defaultVerificationConfig();
  if (!partial) return defaults;

  return {
    ...defaults,
    ...partial,
    concurrency: {
      ...defaults.concurrency,
      ...(partial.concurrency ?? {}),
      commands: partial.concurrency?.commands ?? defaults.concurrency.commands,
    },
    traceability: {
      ...defaults.traceability,
      ...(partial.traceability ?? {}),
      testGlobs: partial.traceability?.testGlobs ?? defaults.traceability.testGlobs,
    },
    history: {
      ...defaults.history,
      ...(partial.history ?? {}),
    },
  };
}

/**
 * Shorten an absolute path to be relative to the project root.
 * Uses path.relative for proper directory-boundary checking.
 */
function shortenPath(absolutePath: string, cwd: string): string {
  const rel = relative(cwd, absolutePath);
  if (!rel.startsWith("..") && !rel.startsWith("/")) {
    return "./" + rel;
  }
  return absolutePath;
}
