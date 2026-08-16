import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CONTENT_DIAGNOSTICS,
  formatBoundedDiagnostics,
  appendDiagnosticsToContent,
} from "../src/post-mutation.js";

test("formatBoundedDiagnostics: returns empty string for no diagnostics", () => {
  assert.equal(formatBoundedDiagnostics([]), "");
});

test("formatBoundedDiagnostics: renders each diagnostic as a bullet line", () => {
  const block = formatBoundedDiagnostics(["a.ts:1: oops", "b.ts:2: also oops"]);
  assert.match(block, /Post-edit diagnostics:/);
  assert.match(block, /  • a\.ts:1: oops/);
  assert.match(block, /  • b\.ts:2: also oops/);
});

test("formatBoundedDiagnostics: truncates at the max and reports the remainder count", () => {
  const diagnostics = Array.from({ length: MAX_CONTENT_DIAGNOSTICS + 5 }, (_, i) => `diag-${i}`);
  const block = formatBoundedDiagnostics(diagnostics);
  const bulletLines = block.split("\n").filter((l) => l.startsWith("  • diag-"));
  assert.equal(bulletLines.length, MAX_CONTENT_DIAGNOSTICS);
  assert.match(block, /\.\.\. and 5 more diagnostic\(s\)/);
});

test("formatBoundedDiagnostics: respects a custom max", () => {
  const block = formatBoundedDiagnostics(["a", "b", "c"], 1);
  assert.match(block, /  • a/);
  assert.doesNotMatch(block, /  • b/);
  assert.match(block, /\.\.\. and 2 more diagnostic\(s\)/);
});

test("appendDiagnosticsToContent: returns content unchanged when block is empty", () => {
  const content = [{ type: "text", text: "hello" }];
  const result = appendDiagnosticsToContent(content, "");
  assert.equal(result, content);
});

test("appendDiagnosticsToContent: appends to an existing text block", () => {
  const content = [{ type: "text", text: "applied 1 edit" }];
  const result = appendDiagnosticsToContent(content, "\n\nmore info");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, "applied 1 edit\n\nmore info");
  // original content array must not be mutated
  assert.equal(content[0]!.text, "applied 1 edit");
});

test("appendDiagnosticsToContent: pushes a new text block when none exists", () => {
  const content = [{ type: "image", text: undefined }];
  const result = appendDiagnosticsToContent(content, "diagnostics here");
  assert.equal(result.length, 2);
  assert.equal(result[1]!.type, "text");
  assert.equal(result[1]!.text, "diagnostics here");
});

test("appendDiagnosticsToContent: coerces a non-string existing text value", () => {
  const content = [{ type: "text", text: 42 as unknown }];
  const result = appendDiagnosticsToContent(content, " tail");
  assert.equal(result[0]!.text, "42 tail");
});
