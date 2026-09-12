/**
 * Transfer contract: the frozen wire shape for copy/move transfer requests.
 *
 * Pure extraction of the validation semantics already enforced by
 * `validateEditOperation` in `src/edit-contract.ts` (transfer branch).
 * No behavior change — this module only names the request type, its
 * agent-visible schema fragment, and a standalone shape validator.
 */

export interface TransferRequest {
  op: "copy" | "move";
  from: string;
  range: { pos: string; end: string };
  to: string;
  after?: string;
  description?: string;
}

/** Agent-visible schema fragment for a transfer edit item. Mirrors the
 *  transfer fields of `EDIT_PARAMETERS` in `src/edit-contract.ts`. */
export const TRANSFER_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    op: {
      type: "string",
      enum: ["copy", "move"],
      description:
        "Relocate existing observed text by reference instead of reproducing it in newText: `copy` leaves the source intact, `move` deletes it after transfer. `to` is always required; `after` is required when `to` is an existing file (omit it when creating a new file; `start` prepends).",
    },
    from: { type: "string", description: "Source file path for a transfer op." },
    range: {
      type: "object",
      additionalProperties: false,
      description: "Transfer op source anchor range in `from`, pre-edit coordinates from the last read.",
      properties: {
        pos: { type: "string", minLength: 1, description: "Start hashline anchor of the source span." },
        end: { type: "string", minLength: 1, description: "End hashline anchor of the source span." },
      },
      required: ["pos", "end"],
    },
    to: { type: "string", description: "Destination file path for a transfer op." },
    after: {
      type: "string",
      minLength: 1,
      description: "Destination hashline anchor to insert after, or `start` to prepend. Omit when `to` is a new file.",
    },
    description: { type: "string", description: "Optional label echoed in diagnostics for self-reference." },
  },
  required: ["op", "from", "range", "to"],
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate an unknown value as a `TransferRequest`.
 * Mirrors the transfer branch of `validateEditOperation`: op must be
 * copy/move, from/to non-empty, range a {pos,end} pair of non-empty
 * strings, after (when present) a bare anchor or `start` — EOF/end/BOF/
 * before sentinels and `:`-suffix tricks are rejected.
 */
export function validateTransferRequest(
  input: unknown,
): { ok: true; value: TransferRequest } | { ok: false; error: string } {
  if (!isPlainObject(input)) return { ok: false, error: "transfer request must be an object" };
  for (const key of Object.keys(input)) {
    if (key !== "op" && key !== "from" && key !== "range" && key !== "to" && key !== "after" && key !== "description")
      return { ok: false, error: `transfer.${key} is not supported` };
  }
  const { op, from, range, to, after, description } = input;
  if (op !== "copy" && op !== "move") return { ok: false, error: `transfer op must be "copy" or "move"` };
  if (typeof from !== "string" || from.length === 0) return { ok: false, error: "transfer.from must be a non-empty string" };
  if (typeof to !== "string" || to.length === 0) return { ok: false, error: "transfer.to must be a non-empty string" };
  if (after !== undefined && (typeof after !== "string" || after.length === 0)) {
    return { ok: false, error: "transfer.after must be a non-empty string if present" };
  }
  if (typeof after === "string") {
    if (after === "EOF" || after === "end" || after === "BOF" || after === "before" || after.includes(":")) {
      return { ok: false, error: `transfer after "${after}" is not accepted: supply a destination anchor or \`start\`` };
    }
  }
  if (!isPlainObject(range)) return { ok: false, error: "transfer.range must be an object" };
  for (const key of Object.keys(range)) {
    if (key !== "pos" && key !== "end") return { ok: false, error: `transfer.range.${key} is not supported` };
  }
  if (typeof range.pos !== "string" || range.pos.length === 0) {
    return { ok: false, error: "transfer.range.pos must be a non-empty string" };
  }
  if (typeof range.end !== "string" || range.end.length === 0) {
    return { ok: false, error: "transfer.range.end must be a non-empty string" };
  }
  if (description !== undefined && typeof description !== "string") {
    return { ok: false, error: "transfer.description must be a string if present" };
  }
  return {
    ok: true,
    value: {
      op,
      from,
      range: { pos: range.pos, end: range.end },
      to,
      ...(after === undefined ? {} : { after }),
      ...(description === undefined ? {} : { description }),
    },
  };
}
