import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimDiagnosticsOwner,
  releaseDiagnosticsOwner,
  isDiagnosticsClaimed,
  resetDiagnosticsOwnership,
} from "../src/mutation-ownership.js";

test("mutation-ownership: claim marks a toolCallId as claimed", () => {
  resetDiagnosticsOwnership();
  assert.equal(isDiagnosticsClaimed("call-1"), false);
  claimDiagnosticsOwner("call-1");
  assert.equal(isDiagnosticsClaimed("call-1"), true);
});

test("mutation-ownership: release clears a claim", () => {
  resetDiagnosticsOwnership();
  claimDiagnosticsOwner("call-2");
  assert.equal(isDiagnosticsClaimed("call-2"), true);
  releaseDiagnosticsOwner("call-2");
  assert.equal(isDiagnosticsClaimed("call-2"), false);
});

test("mutation-ownership: an unknown toolCallId is never claimed", () => {
  resetDiagnosticsOwnership();
  assert.equal(isDiagnosticsClaimed("never-claimed"), false);
});

test("mutation-ownership: releasing an unclaimed id is a no-op", () => {
  resetDiagnosticsOwnership();
  assert.doesNotThrow(() => {
    releaseDiagnosticsOwner("nonexistent");
  });
  assert.equal(isDiagnosticsClaimed("nonexistent"), false);
});

test("mutation-ownership: claims expire after the TTL", () => {
  resetDiagnosticsOwnership();
  const key = Symbol.for("pi-smart-edit.postMutationDiagnostics.owner.v1");
  claimDiagnosticsOwner("call-ttl");
  assert.equal(isDiagnosticsClaimed("call-ttl"), true);

  // Reach into the shared store to backdate the claim past the 60s TTL
  // rather than sleeping in a test.
  const store = (globalThis as Record<PropertyKey, unknown>)[key] as Map<
    string,
    { at: number }
  >;
  const entry = store.get("call-ttl");
  assert.ok(entry, "expected claim entry to exist");
  entry!.at = Date.now() - 61_000;

  assert.equal(isDiagnosticsClaimed("call-ttl"), false);
});

test("mutation-ownership: bounds total claims, evicting the oldest first", () => {
  resetDiagnosticsOwnership();
  const key = Symbol.for("pi-smart-edit.postMutationDiagnostics.owner.v1");
  const store = (globalThis as Record<PropertyKey, unknown>)[key] as Map<
    string,
    { at: number }
  >;

  // Fill past MAX_CLAIMS (200) with increasing (but still TTL-fresh)
  // timestamps so ordering is deterministic; the oldest (first inserted)
  // should be evicted first. Timestamps must stay within CLAIM_TTL_MS of
  // Date.now() or prune()'s TTL check would delete them all as "expired"
  // before the bound check ever runs.
  const base = Date.now() - 205;
  for (let i = 0; i < 205; i++) {
    claimDiagnosticsOwner(`call-bound-${i}`);
    store.get(`call-bound-${i}`)!.at = base + i; // deterministic ordering, all TTL-fresh
  }

  // prune() runs before the new entry is inserted, so the store can briefly
  // sit at MAX_CLAIMS + 1 right after an insert; it's re-bounded to
  // MAX_CLAIMS on the next claim/check call. Assert the post-insert bound.
  assert.ok(store.size <= 201, `expected store bounded to <=201, got ${store.size}`);
  assert.equal(isDiagnosticsClaimed("call-bound-0"), false, "oldest claim should be evicted");
  assert.equal(isDiagnosticsClaimed("call-bound-204"), true, "newest claim should survive");
});

test("mutation-ownership: resetDiagnosticsOwnership clears all claims", () => {
  claimDiagnosticsOwner("call-a");
  claimDiagnosticsOwner("call-b");
  resetDiagnosticsOwnership();
  assert.equal(isDiagnosticsClaimed("call-a"), false);
  assert.equal(isDiagnosticsClaimed("call-b"), false);
});
