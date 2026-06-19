import type { EditItem, EditTarget, SearchScope } from "../lib/types";
import { checkContextGuardSimilarity } from "./safety/context-guard.js";
import { resolveAnchorToScope } from "./anchor-resolution.js";
import type { ParseResult } from "../lib/ast-resolver";

interface AstResolverLike {
  parseFile(content: string, filePath: string): Promise<ParseResult | null>;
  findSymbolNode(tree: { rootNode?: unknown; walk?: () => unknown }, anchor: { symbolName?: string; symbolKind?: string; symbolLine?: number }): unknown;
  disposeParseResult(result: ParseResult): void;
}

/**
 * Compute the containing line range for a set of edits from their oldText.
 * Returns [startLine, endLine] (1-based) or null if oldText can't be located.
 *
 * Used by the range coverage guard to validate that edit targets fall within
 * lines that were actually read this session.
 */
export async function buildContextGuardCheck(
  content: string,
  path: string,
  edits: EditItem[],
  localTargets: unknown[] | null,
  astResolver: AstResolverLike | null,
): Promise<ReturnType<typeof checkContextGuardSimilarity>> {
  const guardEdits: EditItem[] = [];
  const searchScopes: Array<SearchScope | undefined> = [];

  for (let i = 0; i < edits.length; i++) {
    const rawEdit = edits[i] as unknown as Record<string, unknown>;
    if (typeof rawEdit.oldText !== "string" || rawEdit.oldText.length === 0) {
      return { allowed: false, notes: [], reason: `edit #${i + 1} has no oldText to compare` };
    }

    const targetData = localTargets?.[i] as Record<string, unknown> | undefined;
    if (targetData?.replaceBody || targetData?.insertBefore || targetData?.insertAfter) {
      return { allowed: false, notes: [], reason: `edit #${i + 1} is symbolic and has no oldText match target` };
    }

    const guardEdit: EditItem = {
      ...edits[i],
      target: targetData ? targetData as EditTarget : edits[i].target,
    };
    guardEdits.push(guardEdit);

    if (guardEdit.target) {
      const scope = await resolveAnchorToScope(guardEdit, content, path, astResolver);
      searchScopes.push(scope ?? undefined);
    } else {
      searchScopes.push(undefined);
    }
  }

  return checkContextGuardSimilarity(content, guardEdits, searchScopes);
}

export function formatContextGuardRejection(originalReason: string, similarityReason?: string): string {
  if (!similarityReason) return originalReason;
  const prefix = similarityReason.includes("no oldText") || similarityReason.includes("symbolic")
    ? "Context guard bypass unavailable"
    : "Context guard similarity check failed";
  return `${originalReason}\n\n${prefix}: ${similarityReason}.`;
}
