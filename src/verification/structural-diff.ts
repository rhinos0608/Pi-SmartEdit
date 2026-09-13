/**
 * GumTree-Simplified structural diff on tree-sitter CSTs for post-edit verification.
 *
 * Algorithm (GumTree-Simplified, Falleri 2024, no RTED recovery):
 *
 * 1. Top-down phase: Match nodes with identical types and labels (function names,
 *    variable names). Use a container heuristic — if two nodes have the same parent
 *    type and position, they're likely the same.
 *
 * 2. Bottom-up phase: For unmatched nodes, propagate mappings upward. If a node's
 *    children are mostly matched, the node itself is likely a match.
 *
 * 3. Edit script: From the mappings, compute insert/delete/update/move operations.
 *
 * This is advisory only — never throws. Returns a safe default on any failure.
 */

import type Parser from "web-tree-sitter";

// ─── Exported types ──────────────────────────────────────────────────

export type StructuralEditOp =
  | { kind: "insert"; nodeType: string; parentType: string; line: number }
  | { kind: "delete"; nodeType: string; parentType: string; line: number }
  | { kind: "update"; nodeType: string; oldLabel: string; newLabel: string; line: number }
  | { kind: "move"; nodeType: string; oldLine: number; newLine: number };

export interface StructuralDiffResult {
  /** Whether the edit script looks structurally sound */
  passed: boolean;
  /** Human-readable errors describing structural issues */
  errors: string[];
  /** All structural edit operations computed */
  editOps: StructuralEditOp[];
  /** Number of matched node pairs between old and new trees */
  matchCount: number;
  /** Total named nodes across both trees (max of old/new) */
  totalNodes: number;
}

// ─── Internal types ──────────────────────────────────────────────────

interface NodeInfo {
  id: number;
  type: string;
  label: string;       // function name, variable name, identifier text
  startLine: number;
  endLine: number;
  parentType: string;
  children: number[];   // child node ids (named children only)
  hash: string;         // structural hash: type + label + childCount
}

interface Match {
  oldNode: Parser.SyntaxNode;
  newNode: Parser.SyntaxNode;
}

interface MatchState {
  matchedOld: Set<number>;
  matchedNew: Set<number>;
}

/** Bundled lookup state shared by the match phases (keeps arity low). */
interface MatchContext {
  oldInfos: Map<number, NodeInfo>;
  newInfos: Map<number, NodeInfo>;
  state: MatchState;
}

// ─── Constants ────────────────────────────────────────────────────────

import {
  COMMENT_TYPE_RE,
  MATCH_CANDIDATE_LIMIT,
  MAX_BOTTOM_UP_UNMATCHED,
  MAX_TOTAL_NODES,
} from "./structural-diff-constants.js";

export {
  COMMENT_TYPE_RE,
  MATCH_CANDIDATE_LIMIT,
  MAX_BOTTOM_UP_UNMATCHED,
  MAX_TOTAL_NODES,
} from "./structural-diff-constants.js";

// ─── Label extraction ────────────────────────────────────────────────

function isCommentNode(node: Parser.SyntaxNode): boolean {
  return COMMENT_TYPE_RE.test(node.type);
}

/**
 * Extract a meaningful label from a node.
 * For declarations/definitions tries name/identifier child nodes.
 * For leaf nodes returns trimmed text. Falls back to empty string.
 */
const LABEL_CHILD_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "name",
  "property_identifier",
  "type_identifier",
]);

function isLabelChildType(type: string): boolean {
  return LABEL_CHILD_TYPES.has(type);
}

/** Return trimmed text when it fits the label budget, else null. */
function validLabelText(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length >= 80) return null;
  return text;
}

function firstLabelChildText(node: Parser.SyntaxNode): string | null {
  for (const child of node.namedChildren) {
    if (!isLabelChildType(child.type)) continue;
    const text = validLabelText(child.text);
    if (text !== null) return text;
  }
  return null;
}

function leafLabelText(node: Parser.SyntaxNode): string {
  if (node.namedChildCount !== 0) return "";
  return validLabelText(node.text) ?? "";
}

function getLabel(node: Parser.SyntaxNode): string {
  return firstLabelChildText(node) ?? leafLabelText(node);
}

/**
 * Build structural hash: type + label + childCount.
 * Enables O(1) lookup for identical structure.
 */
function structuralHash(node: Parser.SyntaxNode, label: string): string {
  return `${node.type}|${label}|${node.namedChildCount}`;
}

// ─── Node collection & flattening ────────────────────────────────────

interface CollectedNodes {
  nodes: Parser.SyntaxNode[];
  infos: Map<number, NodeInfo>;
}

/**
 * Recursively walk the CST and extract all named, non-comment nodes.
 * Computes NodeInfo for each. Traverses via namedChildren array.
 */
function collectNodes(root: Parser.SyntaxNode): CollectedNodes {
  const nodes: Parser.SyntaxNode[] = [];
  const infos = new Map<number, NodeInfo>();

  function walk(node: Parser.SyntaxNode): void {
    if (!isCommentNode(node) && node.isNamed) {
      nodes.push(node);
      const label = getLabel(node);
      const childIds: number[] = [];
      for (const child of node.namedChildren) {
        childIds.push(child.id);
      }
      infos.set(node.id, {
        id: node.id,
        type: node.type,
        label,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        parentType: node.parent ? node.parent.type : "",
        children: childIds,
        hash: structuralHash(node, label),
      });
    }
    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(root);
  return { nodes, infos };
}

// ─── Top-down matching ──────────────────────────────────────────────

function groupNodesByHash(
  nodes: Parser.SyntaxNode[],
  infos: Map<number, NodeInfo>,
): Map<string, Parser.SyntaxNode[]> {
  const byHash = new Map<string, Parser.SyntaxNode[]>();
  for (const node of nodes) {
    const info = infos.get(node.id);
    if (!info) continue;
    const list = byHash.get(info.hash) ?? [];
    list.push(node);
    byHash.set(info.hash, list);
  }
  return byHash;
}

function sortByPosition(nodes: Parser.SyntaxNode[]): void {
  nodes.sort((a, b) => a.startIndex - b.startIndex);
}

function treeSpan(a: Parser.SyntaxNode, b: Parser.SyntaxNode): number {
  return Math.max(a.tree.rootNode.endIndex, b.tree.rootNode.endIndex, 1);
}

function proximityScore(posDelta: number, totalLen: number): number {
  return 1 - Math.min(posDelta / totalLen, 1);
}

/** Score: parent match (weight 0.4) + position proximity (weight 0.6). */
function scoreTopDownCandidate(
  oc: Parser.SyntaxNode,
  nc: Parser.SyntaxNode,
  oldInfo: NodeInfo,
  newInfo: NodeInfo,
): number {
  const parentBonus = oldInfo.parentType === newInfo.parentType ? 0.4 : 0;
  const posDelta = Math.abs(oc.startIndex - nc.startIndex);
  return parentBonus + proximityScore(posDelta, treeSpan(oc, nc)) * 0.6;
}

function isMatchablePair(
  oc: Parser.SyntaxNode,
  nc: Parser.SyntaxNode,
  state: MatchState,
): boolean {
  return !state.matchedOld.has(oc.id) && !state.matchedNew.has(nc.id);
}

function recordMatch(
  oc: Parser.SyntaxNode,
  nc: Parser.SyntaxNode,
  state: MatchState,
  matches: Match[],
): void {
  state.matchedOld.add(oc.id);
  state.matchedNew.add(nc.id);
  matches.push({ oldNode: oc, newNode: nc });
}

function matchSinglePair(
  oc: Parser.SyntaxNode,
  nc: Parser.SyntaxNode,
  ctx: MatchContext,
  matches: Match[],
): void {
  if (!isMatchablePair(oc, nc, ctx.state)) return;
  if (!tryMatchPair(oc, nc, ctx.oldInfos, ctx.newInfos)) return;
  recordMatch(oc, nc, ctx.state, matches);
}

function findBestTopDownMatch(
  oc: Parser.SyntaxNode,
  newList: Parser.SyntaxNode[],
  ctx: MatchContext,
  usedNew: Set<number>,
): { node: Parser.SyntaxNode; score: number } | null {
  const oldInfo = ctx.oldInfos.get(oc.id);
  if (!oldInfo) return null;
  let best: { node: Parser.SyntaxNode; score: number } | null = null;
  for (const nc of newList) {
    if (ctx.state.matchedNew.has(nc.id) || usedNew.has(nc.id)) continue;
    const newInfo = ctx.newInfos.get(nc.id);
    if (!newInfo) continue;
    const score = scoreTopDownCandidate(oc, nc, oldInfo, newInfo);
    if (best === null || score > best.score) best = { node: nc, score };
  }
  return best;
}

function matchMultiCandidates(
  oldList: Parser.SyntaxNode[],
  newList: Parser.SyntaxNode[],
  ctx: MatchContext,
  matches: Match[],
): void {
  const usedNew = new Set<number>();
  for (const oc of oldList) {
    if (ctx.state.matchedOld.has(oc.id)) continue;
    const best = findBestTopDownMatch(oc, newList, ctx, usedNew);
    if (best === null || best.score < 0.5) continue;
    recordMatch(oc, best.node, ctx.state, matches);
    usedNew.add(best.node.id);
  }
}

function matchHashGroup(
  oldList: Parser.SyntaxNode[],
  newList: Parser.SyntaxNode[],
  ctx: MatchContext,
  matches: Match[],
): void {
  sortByPosition(oldList);
  sortByPosition(newList);
  if (oldList.length === 1 && newList.length === 1) {
    matchSinglePair(oldList[0], newList[0], ctx, matches);
    return;
  }
  matchMultiCandidates(oldList, newList, ctx, matches);
}

/**
 * Phase 1: Top-down hash matching.
 * Build a hash→node map for the old tree and match by structural hash.
 * Container heuristic: prefer same parent type. Position proximity for tie-breaking.
 */
function topDownHashMatch(
  oldNodes: Parser.SyntaxNode[],
  newNodes: Parser.SyntaxNode[],
  ctx: MatchContext,
): Match[] {
  const matches: Match[] = [];
  const oldByHash = groupNodesByHash(oldNodes, ctx.oldInfos);
  const newByHash = groupNodesByHash(newNodes, ctx.newInfos);
  for (const [hash, oldList] of oldByHash) {
    const newList = newByHash.get(hash);
    if (!newList || newList.length === 0) continue;
    matchHashGroup(oldList, newList, ctx, matches);
  }
  return matches;
}

/** Try to match a single old/new pair using container heuristic + position proximity. */
function tryMatchPair(
  oc: Parser.SyntaxNode,
  nc: Parser.SyntaxNode,
  oldInfos: Map<number, NodeInfo>,
  newInfos: Map<number, NodeInfo>,
): boolean {
  const oldInfo = oldInfos.get(oc.id);
  const newInfo = newInfos.get(nc.id);
  if (!oldInfo || !newInfo) return false;

  // Same parent type → likely match
  if (oldInfo.parentType === newInfo.parentType) return true;

  // Different parent types — check position proximity
  const totalLen = Math.max(
    oc.tree.rootNode.endIndex,
    nc.tree.rootNode.endIndex,
    1,
  );
  const posDelta = Math.abs(oc.startIndex - nc.startIndex);
  const posRatio = posDelta / totalLen;

  return posRatio < 0.3;
}

// ─── Bottom-up propagation ──────────────────────────────────────────

function unmatchedNamed(
  nodes: Parser.SyntaxNode[],
  matched: Set<number>,
): Parser.SyntaxNode[] {
  return nodes.filter((n) => !matched.has(n.id) && n.isNamed && !isCommentNode(n));
}

function groupNodesByType(nodes: Parser.SyntaxNode[]): Map<string, Parser.SyntaxNode[]> {
  const byType = new Map<string, Parser.SyntaxNode[]>();
  for (const node of nodes) {
    const list = byType.get(node.type) ?? [];
    list.push(node);
    byType.set(node.type, list);
  }
  return byType;
}

function childMatchRatio(info: NodeInfo, matched: Set<number>): number {
  let matchedCount = 0;
  for (const cid of info.children) {
    if (matched.has(cid)) matchedCount++;
  }
  return matchedCount / info.children.length;
}

function bottomUpPositionScore(oldNode: Parser.SyntaxNode, newNode: Parser.SyntaxNode): number {
  const posDelta = Math.abs(oldNode.startIndex - newNode.startIndex);
  return proximityScore(posDelta, treeSpan(oldNode, newNode));
}

function labelBonus(oldLabel: string, newLabel: string): number {
  return oldLabel && oldLabel === newLabel ? 0.2 : 0;
}

/** Old-side candidate for one bottom-up propagation step. */
interface BottomUpOld {
  node: Parser.SyntaxNode;
  info: NodeInfo;
  ratio: number;
}

/** Score a bottom-up candidate pair; null when the new side is ineligible. */
function scoreBottomUpPair(
  old: BottomUpOld,
  newNode: Parser.SyntaxNode,
  ctx: MatchContext,
): number | null {
  if (ctx.state.matchedNew.has(newNode.id)) return null;
  const newInfo = ctx.newInfos.get(newNode.id);
  if (!newInfo || newInfo.children.length === 0) return null;
  const newRatio = childMatchRatio(newInfo, ctx.state.matchedNew);
  if (newRatio <= 0.5) return null;
  const avgRatio = (old.ratio + newRatio) / 2;
  return (
    avgRatio * 0.6 +
    bottomUpPositionScore(old.node, newNode) * 0.4 +
    labelBonus(old.info.label, newInfo.label)
  );
}

function findBestBottomUpMatch(
  old: BottomUpOld,
  candidates: Parser.SyntaxNode[],
  ctx: MatchContext,
): { node: Parser.SyntaxNode; score: number } | null {
  let best: { node: Parser.SyntaxNode; score: number } | null = null;
  for (const newNode of candidates) {
    const score = scoreBottomUpPair(old, newNode, ctx);
    if (score === null) continue;
    if (best === null || score > best.score) best = { node: newNode, score };
  }
  return best;
}

function candidatesForType(
  type: string,
  newByType: Map<string, Parser.SyntaxNode[]>,
): Parser.SyntaxNode[] | null {
  const candidates = newByType.get(type);
  if (!candidates || candidates.length > MATCH_CANDIDATE_LIMIT) return null;
  return candidates;
}

/** Try one bottom-up propagation step; true when a new match was recorded. */
function tryPropagateOne(
  oldNode: Parser.SyntaxNode,
  newByType: Map<string, Parser.SyntaxNode[]>,
  ctx: MatchContext,
  matches: Match[],
): boolean {
  if (ctx.state.matchedOld.has(oldNode.id)) return false;
  const oldInfo = ctx.oldInfos.get(oldNode.id);
  if (!oldInfo || oldInfo.children.length === 0) return false;
  const oldRatio = childMatchRatio(oldInfo, ctx.state.matchedOld);
  if (oldRatio <= 0.5) return false;
  const candidates = candidatesForType(oldNode.type, newByType);
  if (!candidates) return false;
  const best = findBestBottomUpMatch({ node: oldNode, info: oldInfo, ratio: oldRatio }, candidates, ctx);
  if (!best || best.score < 0.55) return false;
  recordMatch(oldNode, best.node, ctx.state, matches);
  return true;
}

/**
 * Phase 2: Bottom-up propagation.
 * For unmatched nodes, if >50% of named children are matched,
 * attempt to match the node itself using type + position proximity.
 * Iterates until stable (max 5 passes).
 */
function bottomUpPropagation(
  allOldNodes: Parser.SyntaxNode[],
  allNewNodes: Parser.SyntaxNode[],
  ctx: MatchContext,
): Match[] {
  const matches: Match[] = [];
  const oldUnmatched = unmatchedNamed(allOldNodes, ctx.state.matchedOld);
  const newUnmatched = unmatchedNamed(allNewNodes, ctx.state.matchedNew);

  if (
    oldUnmatched.length > MAX_BOTTOM_UP_UNMATCHED ||
    newUnmatched.length > MAX_BOTTOM_UP_UNMATCHED
  ) {
    return matches;
  }

  const newByType = groupNodesByType(newUnmatched);
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 5) {
    changed = false;
    iterations++;
    for (const oldNode of oldUnmatched) {
      if (tryPropagateOne(oldNode, newByType, ctx, matches)) changed = true;
    }
  }
  return matches;
}

// ─── Edit script generation ──────────────────────────────────────────

function isUnmatchedNamed(node: Parser.SyntaxNode, matched: Set<number>): boolean {
  return !matched.has(node.id) && node.isNamed && !isCommentNode(node);
}

function deleteOpFor(node: Parser.SyntaxNode, infos: Map<number, NodeInfo>): StructuralEditOp {
  const info = infos.get(node.id);
  return {
    kind: "delete",
    nodeType: node.type,
    parentType: info?.parentType ?? "",
    line: info?.startLine ?? 1,
  };
}

function insertOpFor(node: Parser.SyntaxNode, infos: Map<number, NodeInfo>): StructuralEditOp {
  const info = infos.get(node.id);
  return {
    kind: "insert",
    nodeType: node.type,
    parentType: info?.parentType ?? "",
    line: info?.startLine ?? 1,
  };
}

function collectDeletes(oldNodes: Parser.SyntaxNode[], ctx: MatchContext): StructuralEditOp[] {
  const ops: StructuralEditOp[] = [];
  for (const node of oldNodes) {
    if (isUnmatchedNamed(node, ctx.state.matchedOld)) ops.push(deleteOpFor(node, ctx.oldInfos));
  }
  return ops;
}

function collectInserts(newNodes: Parser.SyntaxNode[], ctx: MatchContext): StructuralEditOp[] {
  const ops: StructuralEditOp[] = [];
  for (const node of newNodes) {
    if (isUnmatchedNamed(node, ctx.state.matchedNew)) ops.push(insertOpFor(node, ctx.newInfos));
  }
  return ops;
}

function hasLabelChange(oldLabel: string, newLabel: string): boolean {
  return oldLabel !== newLabel && oldLabel.length > 0 && newLabel.length > 0;
}

function updateOpForPair(
  nodeType: string,
  oldInfo: NodeInfo,
  newInfo: NodeInfo,
): StructuralEditOp | null {
  if (!hasLabelChange(oldInfo.label, newInfo.label)) return null;
  return {
    kind: "update",
    nodeType,
    oldLabel: oldInfo.label,
    newLabel: newInfo.label,
    line: newInfo.startLine,
  };
}

function hasRelocated(oldInfo: NodeInfo, newInfo: NodeInfo): boolean {
  if (oldInfo.parentType !== newInfo.parentType) return true;
  return Math.abs(oldInfo.startLine - newInfo.startLine) > 10;
}

function moveOpForPair(
  nodeType: string,
  oldInfo: NodeInfo,
  newInfo: NodeInfo,
): StructuralEditOp | null {
  if (!hasRelocated(oldInfo, newInfo)) return null;
  return {
    kind: "move",
    nodeType,
    oldLine: oldInfo.startLine,
    newLine: newInfo.startLine,
  };
}

function collectPairOps(matches: Match[], ctx: MatchContext): StructuralEditOp[] {
  const ops: StructuralEditOp[] = [];
  for (const m of matches) {
    const oldInfo = ctx.oldInfos.get(m.oldNode.id);
    const newInfo = ctx.newInfos.get(m.newNode.id);
    if (!oldInfo || !newInfo) continue;
    const update = updateOpForPair(m.oldNode.type, oldInfo, newInfo);
    if (update) ops.push(update);
    const move = moveOpForPair(m.oldNode.type, oldInfo, newInfo);
    if (move) ops.push(move);
  }
  return ops;
}

function generateEditOps(
  allOldNodes: Parser.SyntaxNode[],
  allNewNodes: Parser.SyntaxNode[],
  matches: Match[],
  ctx: MatchContext,
): StructuralEditOp[] {
  return [
    ...collectDeletes(allOldNodes, ctx),
    ...collectInserts(allNewNodes, ctx),
    ...collectPairOps(matches, ctx),
  ];
}

// ─── Anomaly detection ──────────────────────────────────────────────

/**
 * Check if a structural diff result indicates a problem.
 * Returns true if the edit script contains unexpected operations
 * (e.g., deleted a sibling function when only intending to modify one).
 */
function isAccidentalDeletion(deletes: number, inserts: number): boolean {
  return deletes > 3 && inserts < 2;
}

function isAccidentalInsertion(inserts: number, deletes: number): boolean {
  return inserts > 3 && deletes < 2;
}

function hasFarMove(moves: Extract<StructuralEditOp, { kind: "move" }>[]): boolean {
  for (const op of moves) {
    if (Math.abs(op.oldLine - op.newLine) > 50) return true;
  }
  return false;
}

export function hasStructuralAnomalies(result: StructuralDiffResult): boolean {
  if (!result.passed) return true;
  const deletes = result.editOps.filter((op) => op.kind === "delete");
  const inserts = result.editOps.filter((op) => op.kind === "insert");
  const moves = result.editOps.filter((op) => op.kind === "move");
  if (isAccidentalDeletion(deletes.length, inserts.length)) return true;
  if (isAccidentalInsertion(inserts.length, deletes.length)) return true;
  if (hasFarMove(moves)) return true;
  return result.editOps.length > 100;
}

// ─── Main API ────────────────────────────────────────────────────────

const safeResult: StructuralDiffResult = {
  passed: true,
  errors: [],
  editOps: [],
  matchCount: 0,
  totalNodes: 0,
};

/**
 * Compute structural diff between pre-edit and post-edit tree-sitter CSTs.
 *
 * Uses GumTree-Simplified algorithm:
 * 1. Top-down: match by structural hash (type+label+childCount) + container heuristic
 * 2. Bottom-up: propagate child matches upward if >50% children matched
 * 3. Edit script: classify as insert/delete/update/move
 *
 * Advisory only — never throws. Returns safe default on any failure.
 *
 * @param oldTree Pre-edit tree-sitter parse tree
 * @param newTree Post-edit tree-sitter parse tree
 * @param expectedChangeKind What kind of change was intended (for verification context)
 * @param languageId Language identifier for node type filtering
 */
export function computeStructuralDiff(
  oldTree: Parser.Tree,
  newTree: Parser.Tree,
  _expectedChangeKind?: "insert" | "delete" | "replace" | "unknown",
  _languageId?: string,
): StructuralDiffResult {
  try {
    const oldRoot = oldTree.rootNode;
    const newRoot = newTree.rootNode;

    // Early termination for large trees
    const oldCount = countNamedNodes(oldRoot);
    const newCount = countNamedNodes(newRoot);
    if (oldCount > MAX_TOTAL_NODES || newCount > MAX_TOTAL_NODES) {
      return {
        ...safeResult,
        errors: [
          `Trees too large (old: ${oldCount}, new: ${newCount} nodes). Skipping structural diff.`,
        ],
        totalNodes: Math.max(oldCount, newCount),
      };
    }

    const { nodes: allOldNodes, infos: oldInfos } = collectNodes(oldRoot);
    const { nodes: allNewNodes, infos: newInfos } = collectNodes(newRoot);

    const totalNodes = Math.max(allOldNodes.length, allNewNodes.length);

    const ctx: MatchContext = {
      oldInfos,
      newInfos,
      state: {
        matchedOld: new Set<number>(),
        matchedNew: new Set<number>(),
      },
    };

    // ── Phase 1: Top-down matching ───────────────────────────────────

    const hashMatches = topDownHashMatch(allOldNodes, allNewNodes, ctx);

    // ── Phase 2: Bottom-up propagation ──────────────────────────────

    const bottomUpMatches = bottomUpPropagation(allOldNodes, allNewNodes, ctx);

    // Combine all matches
    const allMatches = [...hashMatches, ...bottomUpMatches];
    const matchCount = allMatches.length;

    // ── Phase 3: Edit script generation ─────────────────────────────

    const editOps = generateEditOps(allOldNodes, allNewNodes, allMatches, ctx);

    // ── Determine pass/fail ─────────────────────────────────────────

    const errors: string[] = [];
    const passed = editOps.length <= 50;

    if (!passed) {
      const deleteCount = editOps.filter((op) => op.kind === "delete").length;
      const insertCount = editOps.filter((op) => op.kind === "insert").length;
      const updateCount = editOps.filter((op) => op.kind === "update").length;
      errors.push(
        `Structural diff has ${editOps.length} operations ` +
          `(${deleteCount} deletes, ${insertCount} inserts, ${updateCount} updates). ` +
          "May indicate a significant structural change.",
      );
    }

    return { passed, errors, editOps, matchCount, totalNodes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: true,
      errors: [`Structural diff failed: ${message}`],
      editOps: [],
      matchCount: 0,
      totalNodes: 0,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function countNamedNodes(root: Parser.SyntaxNode): number {
  let count = 0;
  function walk(node: Parser.SyntaxNode): void {
    if (node.isNamed) count++;
    for (const child of node.namedChildren) {
      walk(child);
    }
  }
  walk(root);
  return count;
}
