import test from "node:test";
import assert from "node:assert/strict";

import { MutationLoopGuard } from "../src/extension/mutation-loop-guard.js";

const params = {
  path: "src/example.ts",
  edits: [{ oldText: "const x = 1;", newText: "const x = 1;" }],
};

function noopResult() {
  return {
    content: [{ type: "text", text: "No changes made to src/example.ts. The replacements produced identical content." }],
    details: { status: { kind: "rejected", reason: "conflict" }, diagnostics: [] },
  } as never;
}

function appliedResult() {
  return {
    content: [{ type: "text", text: "applied 1 edit(s) to src/example.ts" }],
    details: { status: { kind: "applied" }, diagnostics: [], changedResources: [] },
  } as never;
}

test("third identical no-op request is blocked before mutation", () => {
  const guard = new MutationLoopGuard();

  assert.equal(guard.preflight("edit", params, "call-1"), null);
  guard.observe("edit", params, noopResult());

  assert.equal(guard.preflight("edit", params, "call-2"), null);
  const second = guard.observe("edit", params, noopResult());
  assert.match(second.content.map((entry) => entry.text).join("\n"), /identical next call will be rejected/i);

  const blocked = guard.preflight("edit", params, "call-3");
  assert.ok(blocked);
  assert.equal(blocked.details.status.kind, "rejected");
  assert.match(blocked.content[0].text, /repeated no-op loop/i);
});

test("a real applied mutation resets accumulated no-op strikes", () => {
  const guard = new MutationLoopGuard();

  guard.observe("edit", params, noopResult());
  guard.observe("edit", params, noopResult());
  assert.ok(guard.preflight("edit", params, "blocked"));

  guard.observe("edit", { path: "other.ts", edits: [{ oldText: "a", newText: "b" }] }, appliedResult());
  assert.equal(guard.preflight("edit", params, "after-real-change"), null);
});

test("edit and transfer fingerprints are independent while sharing one session guard", () => {
  const guard = new MutationLoopGuard();
  guard.observe("edit", params, noopResult());
  guard.observe("edit", params, noopResult());

  assert.equal(guard.preflight("transfer", params, "transfer-1"), null);
  assert.ok(guard.preflight("edit", params, "edit-3"));
});
