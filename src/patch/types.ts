/**
 * Patch shared type kernel — pure type definitions plus the shared verifier
 * timeout constant. Zero logic: no functions, no runtime behavior beyond the
 * constant. Moved verbatim from src/patch.ts (MS1 of patch.ts split) so the
 * orchestrator, envelope helpers, and future lanes can share one spelling
 * per concept. src/patch.ts re-exports the public surface so existing
 * importers keep working untouched.
 */
import type {
    RpcMethod,
    MutationDetails,
    EvidenceRef,
    LineRange,
    CheckRecord,
    ResourceInvalidation,
    PostEditEvidence,
} from "@rhinos0608/pi-workspace-protocol";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";
import type {
    FinalSuccessFile as KernelFinalSuccessFile,
    MutableChecks as KernelMutableChecks,
    MutationDisplayDiff as KernelMutationDisplayDiff,
    MutationEdit as KernelMutationEdit,
    MutationGroup as KernelMutationGroup,
    MutationTopology as KernelMutationTopology,
} from "../mutation/types.js";
export type {
    FinalSuccessFile as KernelFinalSuccessFile,
    MutableChecks as KernelMutableChecks,
} from "../mutation/types.js";
import type { AstResolverLike } from "../anchor/anchor-resolution.js";
import type { StructuralResolver } from "../core/edit-planner.js";
import type { EditTarget, FileSnapshot, HashlineEditMetadata } from "../core/types.js";
import type { RepairLoopResult } from "../verification/repair-loop.js";
import type { EditOperation } from "../edit-contract.js";

export interface RpcClientLike {
    request(rpc: RpcMethod, payload: unknown, options?: { signal?: AbortSignal }): Promise<{
        kind: "reply";
        schemaVersion: number;
        requestId: string;
        ok: boolean;
        payload?: unknown;
        error?: string;
    }>;
    dispose(): void;
}

export interface PatchToolDeps {
    readonly getBus?: () => { emit: (c: string, d: unknown) => void; on: (c: string, h: (d: unknown) => void) => () => void };
    readonly getRpcClient: () => RpcClientLike;
    readonly getSessionFilePath: () => string | null;
    readonly getCanonicalWorkspaceRoot: () => string;
    readonly getVerificationChecks?: () => ReadonlyArray<VerificationCheck>;
    /** Per-session prior-authority store (tool-owned evidence policy B). When
     *  present, a strong prior authority for a target path is selected before
     *  RPC envelope resolution; missing prior authority for existing files is
     *  rejected with actionable read guidance. */
    readonly getPriorAuthority?: () => PriorAuthorityStore | null;
    /** Per-session AST resolver for target/lineRange scoping. null when
     *  tree-sitter is unavailable. */
    readonly getAstResolver?: () => AstResolverLike | null;
    /** Per-session structural (ast-grep) resolver. Defaults to the real
     *  ast-grep engine when absent. */
    readonly getStructuralResolver?: () => StructuralResolver | null;
    /** Per-session snapshot lookup for hashline oldText reconstruction.
     *  Tool-owned; never exposed in the agent schema. When absent, hashline
     *  fallback cannot reconstruct oldText and falls through to mismatch
     *  rejection (fast path and rebase still work). */
    readonly getSnapshot?: (path: string) => FileSnapshot | null;
    /** Runs the advisory repair loop against the staged candidate.  It never
     * writes itself; accepted repaired content is re-authorized below. */
    readonly runRepair?: (args: { path: string; content: string; cwd: string }) => Promise<RepairLoopResult>;
    /** Runs advisory, filesystem-dependent lanes only after the transaction is
     * committed. It is deliberately not invoked on rollback or rejection. */
    readonly runFinalSuccessLanes?: (args: FinalSuccessInput) => Promise<FinalSuccessResult>;
}

export type FinalSuccessFile = KernelFinalSuccessFile;
export interface FinalSuccessInput {
    readonly cwd: string;
    readonly toolCallId: string;
    readonly files: ReadonlyArray<FinalSuccessFile>;
}
export interface FinalSuccessResult {
    readonly diagnostics?: ReadonlyArray<string>;
    readonly checks?: ReadonlyArray<{ id: string; outcome: CheckOutcome["outcome"]; detail?: string }>;
    readonly evidence?: unknown;
}

export interface VerificationCheck {
    readonly id: string;
    readonly kind: "blocking" | "advisory";
    /** precommit runs before writes; postwrite runs while transaction locks remain held. */
    readonly phase?: "precommit" | "postwrite";
    readonly run: (ctx: { path: string; content: string; toolCallId: string }) => Promise<CheckOutcome>;
}

export interface CheckOutcome {
    readonly outcome: "pass" | "fail" | "skipped" | "timeout";
    readonly detail?: string;
}

export type MutableChecks = KernelMutableChecks;

/** Shared timeout budget for both the pre-commit and post-write verifier
 *  loops, so a verifier cannot hold the transaction lock (post-write runs
 *  before commit()) or block the write indefinitely (pre-commit). */
export const VERIFIER_TIMEOUT_MS = 5000;

export type GroupedEdit = KernelMutationEdit;

export type EditGroup = KernelMutationGroup;

export type RawTopology = KernelMutationTopology;

export interface RefactorRequestFields {
    readonly kind: string;
    readonly path?: string;
    readonly line?: number;
    readonly character?: number;
    readonly newName?: string;
    readonly previewId?: string;
    readonly tabSize?: number;
    readonly insertSpaces?: boolean;
    readonly endLine?: number;
    readonly endCharacter?: number;
    readonly diagnostics?: unknown;
    readonly only?: unknown;
}

export type PatchResult = { content: Array<{ type: "text"; text: string }>; details: PatchToolDetails };

export interface BusPreviewResponse {
    readonly ok: boolean;
    readonly workspaceEdit?: unknown;
    readonly serverDescriptorId?: unknown;
    readonly error?: string;
}

export type StagedPreviewFile = { filePath: string; originalContent: string; newContent: string; edits: Array<{ range: { start: { line: number }; end: { line: number } } }> };

// ── Stage 2 execution-state types (internal-only; not re-exported by the ──
// patch.ts public facade). PatchInvocation mirrors the execute() args of
// createPatchTool; PatchExecutionState is the mutable accumulator bag execute
// currently threads through as locals. Pure type move: zero logic change.
export interface PatchInvocation {
    readonly toolCallId: string;
    readonly params: Record<string, unknown>;
    readonly signal: AbortSignal | undefined;
    readonly onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined;
    readonly ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown };
}

export interface PatchExecutionState {
    checks: MutableChecks;
    diagnostics: string[];
    usedEvidence: string[];
    invalidations: ResourceInvalidation[];
    postEditEvidenceByPath: Map<string, PostEditEvidence>;
    repairsByPath: Map<string, RepairLoopResult>;
    finalizedFiles: FinalSuccessFile[];
    appliedFiles: string[];
    appliedCanonical: string[];
    appliedSummaries: string[];
    displayDiffs: PatchDisplayDiff[];
}

export interface PreparedPatchRequest {
    requestEvidenceRef: EvidenceRef | undefined;
    sessionFilePath: string;
    canonicalRoot: string;
    textOps: EditOperation[];
    groups: EditGroup[];
    checks: MutableChecks;
    diagnostics: string[];
}

export type PatchDisplayDiff = KernelMutationDisplayDiff;

export type PatchToolDetails = MutationDetails & {
    /** Exact classic-text match failure; used only for bounded retry guidance. */
    readonly matchFailure?: "NOT_FOUND" | "AMBIGUOUS";
    readonly diff?: string;
    readonly diffs?: ReadonlyArray<PatchDisplayDiff>;
    /** Advisory repair results for staged candidates, keyed by canonical path. */
    readonly repairs?: Readonly<Record<string, RepairLoopResult>>;
    readonly finalization?: unknown;
};

export interface PatchTool {
    readonly name: "patch";
    readonly label: "patch";
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: ((u: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
        ctx: { cwd: string; hasUI?: boolean; ui?: unknown; [k: string]: unknown },
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: PatchToolDetails }>;
}
