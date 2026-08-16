/**
 * Cross-extension post-mutation diagnostics ownership protocol.
 *
 * Both SmartEdit and SmartRead run in the same Pi process. SmartEdit claims
 * ownership of post-mutation LSP/compiler diagnostics for its `edit` tool and
 * the native `write` tool; SmartRead must then skip its own fallback so the
 * model never sees double diagnostics, regardless of extension load order.
 *
 * The protocol is keyed by `toolCallId` and stored on a shared `Symbol.for`
 * key on globalThis, so the two repos never need runtime imports between
 * them. Entries are TTL-expired and size-bounded to avoid unbounded growth.
 */

/** Stable cross-repo key. Keep identical in Pi-SmartRead/src/mutation-ownership.ts. */
const OWNERSHIP_KEY = Symbol.for("pi-smart-edit.postMutationDiagnostics.owner.v1");

interface ClaimEntry {
  at: number;
}

const CLAIM_TTL_MS = 60_000;
const MAX_CLAIMS = 200;

function store(): Map<string, ClaimEntry> {
  const g = globalThis as Record<PropertyKey, unknown>;
  let m = g[OWNERSHIP_KEY] as Map<string, ClaimEntry> | undefined;
  if (!m) {
    m = new Map<string, ClaimEntry>();
    Object.defineProperty(g, OWNERSHIP_KEY, {
      value: m,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  return m;
}

function prune(now: number): void {
  const s = store();
  for (const [id, entry] of s) {
    if (now - entry.at > CLAIM_TTL_MS) s.delete(id);
  }
  // Bound the map: evict oldest claims until under the cap.
  while (s.size > MAX_CLAIMS) {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, entry] of s) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestId = id;
      }
    }
    if (oldestId === null) break;
    s.delete(oldestId);
  }
}

/** SmartEdit claims ownership for a mutation (edit/write) when it fires tool_call. */
export function claimDiagnosticsOwner(toolCallId: string): void {
  const now = Date.now();
  prune(now);
  store().set(toolCallId, { at: now });
}

/** Release a claim (e.g. the mutation failed — SmartEdit must not own failures). */
export function releaseDiagnosticsOwner(toolCallId: string): void {
  store().delete(toolCallId);
}

/** SmartRead checks this on tool_result; true ⇒ skip its fallback. */
export function isDiagnosticsClaimed(toolCallId: string): boolean {
  const now = Date.now();
  prune(now);
  const entry = store().get(toolCallId);
  if (!entry) return false;
  return now - entry.at <= CLAIM_TTL_MS;
}

/** Test hook: drop all claims. */
export function resetDiagnosticsOwnership(): void {
  store().clear();
}
