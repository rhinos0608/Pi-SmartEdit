/** Kernel-native mutation types. Tool-neutral: neither `edit` nor
 *  `transfer` owns the transaction, verification, rollback, undo,
 *  invalidation, or post-mutation evidence lifecycle. Tool frontends plan
 *  `MutationGroup` batches plus `MutationResourceIntent`s and lower them to
 *  `MutationOperation`s; the kernel owns everything from evidence
 *  acquisition through finalization. */
import type {
    CheckRecord,
    EvidenceRef,
    LineRange,
    MutationDetails,
    PostEditEvidence,
    ResourceInvalidation,
    WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";
import type { PriorAuthorityStore } from "../context/evidence-authority.js";
import type { EditTarget, HashlineEditMetadata } from "../core/types.js";
import type { EditTransaction } from "./edit-transaction.js";
import type { MutationResourceIntent } from "./resource-intent.js";
import type { RepairLoopResult } from "../verification/repair-loop.js";

/** Tool identity carried through the whole mutation lifecycle so terminal
 *  results report the tool that actually ran. */
export type MutationToolIdentity = "edit" | "transfer";

/** Every tool that mutates the workspace through the shared kernel. */
export const MUTATION_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "transfer"]);

/** Single predicate for mutation-tool classification. Use instead of
 *  scattered `toolName === "edit"` string comparisons. */
export function isMutationTool(toolName: string | undefined): boolean {
    return typeof toolName === "string" && MUTATION_TOOLS.has(toolName);
}

/** Check-bucket accumulator shared by every mutation lane. */
export interface MutableChecks {
    blocking: CheckRecord[];
    completed: CheckRecord[];
    advisory: CheckRecord[];
    skipped: CheckRecord[];
    timedOut: CheckRecord[];
}

/** One file handed to the post-commit success lanes. */
export interface FinalSuccessFile {
    readonly path: string;
    readonly oldContent: string;
    readonly content: string;
    readonly changedLineRanges: ReadonlyArray<LineRange>;
}

/** Renderable per-file diff for the final result. */
export interface MutationDisplayDiff {
    readonly path: string;
    readonly diff: string;
}

/** Tool result envelope. `details` is the shared workspace-protocol
 *  mutation lifecycle contract. */
export type MutationResult = { content: Array<{ type: "text"; text: string }>; details: MutationDetails };

/** One planned text mutation inside a group. Owned here so frontends lower
 *  to kernel operations without importing patch types. */
export interface MutationEdit {
    readonly oldText?: string;
    readonly newText?: string;
    readonly description?: string;
    readonly replaceAll?: boolean;
    readonly target?: EditTarget;
    readonly lineRange?: LineRange;
    readonly hashline?: HashlineEditMetadata;
}

/** Topology-only (non-text) mutation for a group. */
export type MutationTopology =
    | { kind: "add"; path: string; content: string }
    | { kind: "delete"; path: string }
    | { kind: "rename"; oldPath: string; newPath: string };

/** One file's planned mutations. */
export interface MutationGroup {
    /** Resolved absolute path (cwd-relative input has been resolved). */
    readonly absolutePath: string;
    /** Original input path string (used for diagnostics). */
    readonly rawPath: string;
    readonly edits: ReadonlyArray<MutationEdit>;
    readonly topology?: MutationTopology;
}

/** Mutable accumulator bag threaded through the whole lifecycle. All
 *  array/map references are the caller's live instances — never cloned —
 *  so terminal results and the transaction finally observe the same state. */
export interface MutationState {
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
    displayDiffs: MutationDisplayDiff[];
}

/** Context handed to each planned `MutationOperation`. */
export interface MutationOperationContext {
    readonly transaction: EditTransaction;
    readonly groups: MutationGroup[];
    readonly priorStore: PriorAuthorityStore | null;
    readonly envelope: WorkspaceEvidenceEnvelope | null;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly toolCallId: string;
    readonly tool: MutationToolIdentity;
    readonly checks: MutableChecks;
    readonly diagnostics: string[];
    readonly usedEvidence: string[];
    readonly invalidations: MutationState["invalidations"];
}

/** One domain-planned mutation step (e.g. transfer materialization).
 *  Runs inside the transaction try so a rejection still triggers the
 *  outer rollback finally. */
export type MutationOperation = (
    context: MutationOperationContext,
) => { ok: true } | { ok: false; result: MutationResult };

/** What a tool frontend hands the kernel after its own validation,
 *  planning, and evidence acquisition. */
export interface MutationPreparation {
    readonly groups: MutationGroup[];
    readonly resourceIntents: ReadonlyArray<MutationResourceIntent>;
    readonly operations: ReadonlyArray<MutationOperation>;
    readonly envelope: WorkspaceEvidenceEnvelope | null;
    readonly priorStore: PriorAuthorityStore | null;
    readonly evidenceRefForDetails: EvidenceRef;
    readonly canonicalRoot: string;
    readonly autoInspected: boolean;
    readonly state: MutationState;
}
