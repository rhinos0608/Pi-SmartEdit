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

// ─── Constants ────────────────────────────────────────────────────────

const MAX_TOTAL_NODES = 5000;
const MAX_BOTTOM_UP_UNMATCHED = 500;
const MATCH_CANDIDATE_LIMIT = 20;

const COMMENT_TYPE_RE = /^comment$/i;

// ─── Label extraction ────────────────────────────────────────────────

function isCommentNode(node: Parser.SyntaxNode): boolean {
  return COMMENT_TYPE_RE.test(node.type);
}

/**
 * Extract a meaningful label from a node.
 * For declarations/definitions tries name/identifier child nodes.
 * For leaf nodes returns trimmed text. Falls back to empty string.
 */
function getLabel(node: Parser.SyntaxNode): string {
  for (const child of node.namedChildren) {
    if (
      child.type === "identifier" ||
      child.type === "name" ||
      child.type === "property_identifier" ||
      child.type === "type_identifier"
    ) {
      const text = child.text.trim();
      if (text.length > 0 && text.length < 80) return text;
    }
  }
  if (node.namedChildCount === 0) {
    const text = node.text.trim();
    if (text.length > 0 && text.length < 80) return text;
  }
  return "";
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

/**
 * Phase 1: Top-down hash matching.
 * Build a hash→node map for the old tree and match by structural hash.
 * Container heuristic: prefer same parent type. Position proximity for tie-breaking.
 */
function topDownHashMatch(
  oldNodes: Parser.SyntaxNode[],
  newNodes: Parser.SyntaxNode[],
  oldInfos: Map<number, NodeInfo>,
  newInfos: Map<number, NodeInfo>,
  state: MatchState,
): Match[] {
  const matches: Match[] = [];

  // Group old nodes by hash
  const oldByHash = new Map<string, Parser.SyntaxNode[]>();
  for (const node of oldNodes) {
    const info = oldInfos.get(node.id);
    if (!info) continue;
    const list = oldByHash.get(info.hash) ?? [];
    list.push(node);
    oldByHash.set(info.hash, list);
  }

  // Group new nodes by hash
  const newByHash = new Map<string, Parser.SyntaxNode[]>();
  for (const node of newNodes) {
    const info = newInfos.get(node.id);
    if (!info) continue;
    const list = newByHash.get(info.hash) ?? [];
    list.push(node);
    newByHash.set(info.hash, list);
  }

  for (const [hash, oldList] of oldByHash) {
    const newList = newByHash.get(hash);
    if (!newList || newList.length === 0) continue;

    // Sort both by position
    oldList.sort((a, b) => a.startIndex - b.startIndex);
    newList.sort((a, b) => a.startIndex - b.startIndex);

    // Single pair: direct match with container heuristic
    if (oldList.length === 1 && newList.length === 1) {
      const oc = oldList[0];
      const nc = newList[0];
      if (!state.matchedOld.has(oc.id) && !state.matchedNew.has(nc.id)) {
        if (tryMatchPair(oc, nc, oldInfos, newInfos)) {
          state.matchedOld.add(oc.id);
          state.matchedNew.add(nc.id);
          matches.push({ oldNode: oc, newNode: nc });
        }
      }
      continue;
    }

    // Multiple candidates — use position proximity + container match
    const usedNew = new Set<number>();

    for (const oc of oldList) {
      if (state.matchedOld.has(oc.id)) continue;
      const oldInfo = oldInfos.get(oc.id);
      if (!oldInfo) continue;

      let bestMatch: Parser.SyntaxNode | null = null;
      let bestScore = -Infinity;

      for (const nc of newList) {
        if (state.matchedNew.has(nc.id) || usedNew.has(nc.id)) continue;
        const newInfo = newInfos.get(nc.id);
        if (!newInfo) continue;

        // Score: parent match (weight 0.4) + position proximity (weight 0.6)
        const parentBonus = oldInfo.parentType === newInfo.parentType ? 0.4 : 0;

        const totalLen = Math.max(
          oc.tree.rootNode.endIndex,
          nc.tree.rootNode.endIndex,
          1,
        );
        const posDelta = Math.abs(oc.startIndex - nc.startIndex);
        const posScore = 1 - Math.min(posDelta / totalLen, 1);

        const score = parentBonus + posScore * 0.6;

        if (score > bestScore) {
          bestScore = score;
          bestMatch = nc;
        }
      }

      if (bestMatch && bestScore >= 0.5) {
        state.matchedOld.add(oc.id);
        state.matchedNew.add(bestMatch.id);
        usedNew.add(bestMatch.id);
        matches.push({ oldNode: oc, newNode: bestMatch });
      }
    }
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

/**
 * Phase 2: Bottom-up propagation.
 * For unmatched nodes, if >50% of named children are matched,
 * attempt to match the node itself using type + position proximity.
 * Iterates until stable (max 5 passes).
 */
function bottomUpPropagation(
  allOldNodes: Parser.SyntaxNode[],
  allNewNodes: Parser.SyntaxNode[],
  oldInfos: Map<number, NodeInfo>,
  newInfos: Map<number, NodeInfo>,
  state: MatchState,
): Match[] {
  const matches: Match[] = [];

  // Filter to unmatched nodes only
  const oldUnmatched = allOldNodes.filter(
    (n) => !state.matchedOld.has(n.id) && n.isNamed && !isCommentNode(n),
  );
  const newUnmatched = allNewNodes.filter(
    (n) => !state.matchedNew.has(n.id) && n.isNamed && !isCommentNode(n),
  );

  if (
    oldUnmatched.length > MAX_BOTTOM_UP_UNMATCHED ||
    newUnmatched.length > MAX_BOTTOM_UP_UNMATCHED
  ) {
    return matches;
  }

  // Group unmatched new nodes by type for fast lookup
  const newByType = new Map<string, Parser.SyntaxNode[]>();
  for (const node of newUnmatched) {
    const list = newByType.get(node.type) ?? [];
    list.push(node);
    newByType.set(node.type, list);
  }

  let changed = true;
  let iterations = 0;

  while (changed && iterations < 5) {
    changed = false;
    iterations++;

    for (const oldNode of oldUnmatched) {
      if (state.matchedOld.has(oldNode.id)) continue;
      const oldInfo = oldInfos.get(oldNode.id);
      if (!oldInfo || oldInfo.children.length === 0) continue;

      // Count matched children
      let matchedCount = 0;
      for (const cid of oldInfo.children) {
        if (state.matchedOld.has(cid)) matchedCount++;
      }

      const ratio = matchedCount / oldInfo.children.length;
      if (ratio <= 0.5) continue;

      // Find best matching new node of same type
      const candidates = newByType.get(oldNode.type);
      if (!candidates || candidates.length > MATCH_CANDIDATE_LIMIT) continue;

      let bestMatch: Parser.SyntaxNode | null = null;
      let bestScore = 0;

      for (const newNode of candidates) {
        if (state.matchedNew.has(newNode.id)) continue;
        const newInfo = newInfos.get(newNode.id);
        if (!newInfo || newInfo.children.length === 0) continue;

        // New node's child match ratio
        let newMatchedCount = 0;
        for (const cid of newInfo.children) {
          if (state.matchedNew.has(cid)) newMatchedCount++;
        }
        const newRatio = newMatchedCount / newInfo.children.length;
        if (newRatio <= 0.5) continue;

        const avgRatio = (ratio + newRatio) / 2;

        // Position proximity
        const maxLen = Math.max(
          oldNode.tree.rootNode.endIndex,
          newNode.tree.rootNode.endIndex,
          1,
        );
        const posDelta = Math.abs(oldNode.startIndex - newNode.startIndex);
        const posScore = 1 - Math.min(posDelta / maxLen, 1);

        let score = avgRatio * 0.6 + posScore * 0.4;

        // Bonus for label match
        if (oldInfo.label && oldInfo.label === newInfo.label) {
          score += 0.2;
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = newNode;
        }
      }

      if (bestMatch && bestScore >= 0.55) {
        state.matchedOld.add(oldNode.id);
        state.matchedNew.add(bestMatch.id);
        matches.push({ oldNode, newNode: bestMatch });
        changed = true;
      }
    }
  }

  return matches;
}

// ─── Edit script generation ──────────────────────────────────────────

function generateEditOps(
  allOldNodes: Parser.SyntaxNode[],
  allNewNodes: Parser.SyntaxNode[],
  oldInfos: Map<number, NodeInfo>,
  newInfos: Map<number, NodeInfo>,
  matches: Match[],
  state: MatchState,
): StructuralEditOp[] {
  const ops: StructuralEditOp[] = [];

  // Deletions: nodes in old but not matched
  for (const node of allOldNodes) {
    if (!state.matchedOld.has(node.id) && node.isNamed && !isCommentNode(node)) {
      const info = oldInfos.get(node.id);
      ops.push({
        kind: "delete",
        nodeType: node.type,
        parentType: info?.parentType ?? "",
        line: info?.startLine ?? 1,
      });
    }
  }

  // Insertions: nodes in new but not matched
  for (const node of allNewNodes) {
    if (!state.matchedNew.has(node.id) && node.isNamed && !isCommentNode(node)) {
      const info = newInfos.get(node.id);
      ops.push({
        kind: "insert",
        nodeType: node.type,
        parentType: info?.parentType ?? "",
        line: info?.startLine ?? 1,
      });
    }
  }

  // Updates and moves: among matched pairs
  for (const m of matches) {
    const oldInfo = oldInfos.get(m.oldNode.id);
    const newInfo = newInfos.get(m.newNode.id);
    if (!oldInfo || !newInfo) continue;

    // Update: different label on same structure
    if (oldInfo.label !== newInfo.label && oldInfo.label.length > 0 && newInfo.label.length > 0) {
      ops.push({
        kind: "update",
        nodeType: m.oldNode.type,
        oldLabel: oldInfo.label,
        newLabel: newInfo.label,
        line: newInfo.startLine,
      });
    }

    // Move: different parent type, or large line shift (>10 lines)
    const parentChanged = oldInfo.parentType !== newInfo.parentType;
    const lineDelta = Math.abs(oldInfo.startLine - newInfo.startLine);

    if (parentChanged || lineDelta > 10) {
      ops.push({
        kind: "move",
        nodeType: m.oldNode.type,
        oldLine: oldInfo.startLine,
        newLine: newInfo.startLine,
      });
    }
  }

  return ops;
}

// ─── Anomaly detection ──────────────────────────────────────────────

/**
 * Check if a structural diff result indicates a problem.
 * Returns true if the edit script contains unexpected operations
 * (e.g., deleted a sibling function when only intending to modify one).
 */
export function hasStructuralAnomalies(result: StructuralDiffResult): boolean {
  if (!result.passed) return true;

  const deletes = result.editOps.filter((op) => op.kind === "delete");
  const inserts = result.editOps.filter((op) => op.kind === "insert");
  const moves = result.editOps.filter((op) => op.kind === "move");

  // Many deletes with few inserts → possible accidental deletion
  if (deletes.length > 3 && inserts.length < 2) return true;

  // Many inserts with few deletes → possible accidental insertion of duplicate symbols
  if (inserts.length > 3 && deletes.length < 2) return true;

  // Large moves (function repositioned far away)
  for (const op of moves) {
    const lineDelta = Math.abs(op.oldLine - op.newLine);
    if (lineDelta > 50) return true;
  }

  // Excessive total ops → unstable parse or massive structural change
  if (result.editOps.length > 100) return true;

  return false;
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

    const state: MatchState = {
      matchedOld: new Set<number>(),
      matchedNew: new Set<number>(),
    };

    // ── Phase 1: Top-down matching ───────────────────────────────────

    const hashMatches = topDownHashMatch(allOldNodes, allNewNodes, oldInfos, newInfos, state);

    // ── Phase 2: Bottom-up propagation ──────────────────────────────

    const bottomUpMatches = bottomUpPropagation(
      allOldNodes,
      allNewNodes,
      oldInfos,
      newInfos,
      state,
    );

    // Combine all matches
    const allMatches = [...hashMatches, ...bottomUpMatches];
    const matchCount = allMatches.length;

    // ── Phase 3: Edit script generation ─────────────────────────────

    const editOps = generateEditOps(
      allOldNodes,
      allNewNodes,
      oldInfos,
      newInfos,
      allMatches,
      state,
    );

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
