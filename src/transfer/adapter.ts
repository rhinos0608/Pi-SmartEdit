/**
 * Legacy edit-op adapter: strict mapping from a raw `edits[]` entry to a
 * `TransferRequest`.
 *
 * Frozen semantics: only op/from/range/to/after/description may be present.
 * path, replaceAll (even false), oldText, newText, target, lineRange, and
 * hashline all reject — mirroring the mutual-exclusivity branch of
 * `validateEditOperation` in `src/edit-contract.ts`. Transfer ops are
 * pathless by design (from/to carry the paths); a top-level `path` is
 * accepted-but-ignored so `{path, edits:[transfer...]}` batches keep
 * working. No behavior change.
 */
import { validateTransferRequest, type TransferRequest } from "./contract.js";

const ALLOWED_KEYS = new Set(["op", "from", "range", "to", "after", "description"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Adapt one raw edit entry to a `TransferRequest`.
 * `_topLevelPath` is accepted-but-ignored (transfer addressing is
 * pathless; from/to carry the paths).
 */
export function adaptTransferOp(
  raw: unknown,
  index = 0,
  _topLevelPath?: string,
): { ok: true; value: TransferRequest } | { ok: false; error: string } {
  void _topLevelPath;
  if (!isPlainObject(raw)) return { ok: false, error: `edit.edits[${index}] must be an object` };
  const unknownKey = Object.keys(raw).find((key) => !ALLOWED_KEYS.has(key));
  if (unknownKey !== undefined) {
    if (
      unknownKey === "path" || unknownKey === "oldText" || unknownKey === "newText"
      || unknownKey === "target" || unknownKey === "lineRange" || unknownKey === "hashline"
      || unknownKey === "replaceAll"
    ) {
      return {
        ok: false,
        error: `edit.edits[${index}]: op is mutually exclusive with path, oldText, newText, replaceAll, target, lineRange, and hashline`,
      };
    }
    return { ok: false, error: `edit.edits[${index}].${unknownKey} is not supported` };
  }
  if (raw.op !== "copy" && raw.op !== "move") {
    return { ok: false, error: `edit.edits[${index}].op must be "copy" or "move"` };
  }
  const validated = validateTransferRequest(raw);
  if (!validated.ok) return { ok: false, error: `edit.edits[${index}]: ${validated.error}` };
  return validated;
}

/**
 * Adapt a batch of raw transfer ops. The top-level path is
 * accepted-but-ignored for every entry.
 */
export function adaptTransferOps(
  rawOps: readonly unknown[],
  topLevelPath?: string,
): { ok: true; value: TransferRequest[] } | { ok: false; error: string } {
  const out: TransferRequest[] = [];
  for (let i = 0; i < rawOps.length; i++) {
    const adapted = adaptTransferOp(rawOps[i], i, topLevelPath);
    if (!adapted.ok) return adapted;
    out.push(adapted.value);
  }
  return { ok: true, value: out };
}
