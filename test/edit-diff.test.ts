/**
 * Tests for the smart-edit extension's edit-diff module.
 *
 * Validates Phase 1 (fuzzy matching without corruption) and lays
 * groundwork for later phases.
 *
 * Run: npx tsx test/edit-diff.test.ts
 */

import {
  applyEdits,
  normalizeForFuzzyMatch,
  detectIndentation,
  normalizeIndentation,
  findText,
  findAllMatches,
  findClosestMatch,
  lineRangeToByteRange,
  validateLineRange,
  normalizeToLF,
  detectLineEnding,
  stripBom,
  generateDiffString,
  preserveQuoteStyle,
} from "../.pi/extensions/smart-edit/lib/edit-diff";

import type { SearchScope } from "../.pi/extensions/smart-edit/lib/types";

// ─── Helpers ────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL: ${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${message}`);
}

async function throws(fn: () => void | Promise<void>, message: string): Promise<void> {
  try {
    const result = fn();
    if (result instanceof Promise) { await result; }
    throw new Error(`FAIL: ${message} — expected error but none thrown`);
  } catch (e) {
    console.log(`  ✓ ${message}: ${(e as Error).message}`);
  }
}

// ─── Phase 1: Fuzzy matching does not corrupt content ─────────────

console.log("\n=== Phase 1: Fuzzy matching without file corruption ===\n");

async function testFuzzyMatchDoesNotCorruptFile() {
  const file = `const greeting = "Hello, world!";\nconst farewell = "Goodbye\u2014see you later";\nconst name = 'Alice';\n`;
  const oldText = `const greeting = "Hello, world!";`;
  const newText = `const greeting = "Hi there!";`;

  const result = await applyEdits(file, [{ oldText, newText }], "test.ts");

  // The em-dash in line 2 should be preserved
  assert(result.newContent.includes("\u2014"), "Em-dash preserved in untouched region");

  // Line 2 should remain unchanged
  assert(result.newContent.includes(`"Goodbye\u2014see you later"`), "Line 2 content unchanged");

  console.log();
}
testFuzzyMatchDoesNotCorruptFile();

async function testFuzzyMatchCurlyQuotesPreserved() {
  const file = `const a = "\u201CHello\u201D";\nconst b = "world";\nconst c = "\u2018test\u2019";\n`;
  // Match b with ASCII, but a and c should keep curly quotes
  const oldText = `const b = "world";`;
  const newText = `const b = "earth";`;

  const result = await applyEdits(file, [{ oldText, newText }], "test.ts");

  assert(result.newContent.includes("\u201CHello\u201D"), "Curly double quotes preserved in untouched region");
  assert(result.newContent.includes("\u2018test\u2019"), "Curly single quotes preserved in untouched region");

  console.log();
}
testFuzzyMatchCurlyQuotesPreserved();

async function testFuzzyMatchOnlyAffectsTarget() {
  const file = `line 1\nline 2\nline 3\nline 4\nline 5\n`;
  // Match line 3, ensure lines 1,2,4,5 are unchanged
  const oldText = `line 3`;
  const newText = `line three`;

  const result = await applyEdits(file, [{ oldText, newText }], "test.ts");

  assertEqual(result.newContent, `line 1\nline 2\nline three\nline 4\nline 5\n`, "Only target line changed");
  console.log();
}
testFuzzyMatchOnlyAffectsTarget();

// ─── Phase 1: Exact match works as before ─────────────────────────

console.log("=== Phase 1: Exact match semantics preserved ===\n");

async function testExactMatch() {
  const file = `function foo() {\n  return 42;\n}\n`;
  const result = await applyEdits(file, [{ oldText: "42", newText: "99" }], "test.ts");

  assert(result.newContent.includes("return 99"), "Exact match replacement works");
  console.log();
}
testExactMatch();

async function testMultiEditParallelSemantics() {
  // Two edits applied against same original, not sequentially
  const file = `a = 1\nb = 2\nc = 3\n`;
  const result = await applyEdits(file, [
    { oldText: "a = 1", newText: "a = 10" },
    { oldText: "c = 3", newText: "c = 30" },
  ], "test.ts");

  assert(result.newContent.includes("a = 10"), "First edit applied");
  assert(result.newContent.includes("c = 30"), "Second edit applied");
  assert(result.newContent.includes("b = 2"), "Middle line unchanged");
  console.log();
}
testMultiEditParallelSemantics();

async function testOverlapDetection() {
  const file = `a = 1\nb = 2\nc = 3\n`;

  throws(async () => {
    await applyEdits(file, [
      { oldText: "a = 1\nb = 2", newText: "x" },
      { oldText: "b = 2\nc = 3", newText: "y" },
    ], "test.ts");
  }, "Overlapping edits rejected");
  console.log();
}
testOverlapDetection();

// ─── Phase 3: replaceAll support ────────────────────────────────────

console.log("=== Phase 3: replaceAll ===\n");

async function testReplaceAll() {
  const file = `const x = 1;\nconst y = x + x;\nconst z = x * 2;\n`;
  const result = await applyEdits(file, [
    { oldText: "x", newText: "count", replaceAll: true },
  ], "test.ts");

  // x appears 4 times
  const occurrences = (result.newContent.match(/count/g) || []).length;
  assertEqual(occurrences, 4, "All 4 occurrences of x replaced");
  assert(!result.newContent.includes("x "), "No remaining x references");
  console.log();
}
testReplaceAll();

async function testReplaceAllZeroMatches() {
  const file = `hello world\n`;

  throws(async () => {
    await applyEdits(file, [
      { oldText: "nonexistent", newText: "replaced", replaceAll: true },
    ], "test.ts");
  }, "replaceAll with no matches errors");
  console.log();
}
testReplaceAllZeroMatches();

async function testReplaceAllAndSpecificOverlap() {
  const file = `foo\nfoo\nfoo\n`;

  throws(async () => {
    await applyEdits(file, [
      { oldText: "foo", newText: "bar", replaceAll: true },
      { oldText: "foo", newText: "baz" }, // specific edit targeting same region
    ], "test.ts");
  }, "replaceAll overlapping with specific edit errors");
  console.log();
}
testReplaceAllAndSpecificOverlap();

async function testReplaceAllMultiTier() {
  // First "foo" is exact, second "  foo" is indented — should find both
  const file = `foo
  foo
foo
`;
  const result = await applyEdits(file, [
    { oldText: "foo", newText: "bar", replaceAll: true },
  ], "test.ts");

  // Should replace all 3 occurrences, including the indented one
  assert(!result.newContent.includes("foo"), "All foos replaced");
  assert(result.newContent.includes("bar"), "Replacement present");
  console.log();
}
testReplaceAllMultiTier();

// ─── Phase 4: Indentation normalization ─────────────────────────────

console.log("=== Phase 4: Indentation normalization ===\n");

function testIndentDetectionSpaces() {
  const file = `  const a = 1;\n    const b = 2;\n  const c = 3;\n`;
  const style = detectIndentation(file);
  assertEqual(style.char, " ", "Detected spaces");
  assertEqual(style.width, 2, "Detected 2-space indent");
  console.log();
}
testIndentDetectionSpaces();

function testIndentDetectionTabs() {
  const file = `\tconst a = 1;\n\t\tconst b = 2;\n\tconst c = 3;\n`;
  const style = detectIndentation(file);
  assertEqual(style.char, "\t", "Detected tabs");
  console.log();
}
testIndentDetectionTabs();

async function testIndentationNormalizedMatch() {
  // File uses 4-space indent, model sends 2-space
  const file = `function foo() {\n    const x = 1;\n    return x;\n}\n`;
  const oldText = `  const x = 1;`; // 2-space

  const result = await applyEdits(file, [{ oldText, newText: `    const x = 2;` }], "test.ts");

  assert(result.newContent.includes("const x = 2"), "Indentation-normalized match succeeds");
  console.log();
}
testIndentationNormalizedMatch();

async function testIndentationNormalizedMatchTabs() {
  // File uses tabs, model sends 4-space
  const file = `function foo() {\n\tconst x = 1;\n\treturn x;\n}\n`;
  const oldText = `    const x = 1;`; // 4-space

  const result = await applyEdits(file, [{ oldText, newText: `\tconst x = 2;` }], "test.ts");

  assert(result.newContent.includes("\tconst x = 2"), "Tab-to-space indentation match succeeds");
  console.log();
}
testIndentationNormalizedMatchTabs();

// ─── Phase 5: Closest-match diagnostics ─────────────────────────────

console.log("=== Phase 5: Closest-match diagnostics ===\n");

function testClosestMatchWithIndentDiff() {
  const file = `    const x = 1;\n    const y = 2;\n`;
  const oldText = `  const x = 1;`;

  const diag = findClosestMatch(file, oldText);
  assert(diag !== null, "Closest match found");
  assert(diag!.similarity > 0.5, "Similarity > 50%");
  assert(diag!.hint.includes("ndent"), "Hint mentions indentation");
  console.log();
}
testClosestMatchWithIndentDiff();

async function testNoDiagnosticForVeryDifferentText() {
  const file = `function foo() {\n  return 42;\n}\n`;
  const oldText = `class Bar extends Foobar implements Bazzable, Quuxable {`;

  const diag = findClosestMatch(file, oldText);
  assert(diag === null, "No diagnostic for completely unrelated text");
  console.log();
}
testNoDiagnosticForVeryDifferentText();

// ─── BOM and line endings ────────────────────────────────────────────

console.log("=== BOM and line endings ===\n");

function testBomStripping() {
  const { bom, text } = stripBom("\uFEFFhello");
  assertEqual(bom, "\uFEFF", "BOM detected");
  assertEqual(text, "hello", "BOM stripped from text");
  console.log();
}
testBomStripping();

function testCrlfDetection() {
  const ending = detectLineEnding("hello\r\nworld");
  assertEqual(ending, "\r\n", "CRLF detected");
  console.log();
}
testCrlfDetection();

// ─── Empty oldText ──────────────────────────────────────────────────

console.log("=== Phase 8: Trailing newline ===\n");

async function testDeleteCodeBlockWithoutOrphanLine() {
  // File has "const x = 1;\n" then a blank line, we delete "const x = 1;"
  const file = `const x = 1;
const y = 2;
`;
  const result = await applyEdits(file, [{ oldText: "const x = 1;", newText: "" }], "test.ts");
  // Should not leave a blank line where the deleted code was
  assert(!result.newContent.startsWith("\n"), "No orphan blank line at start");
  assertEqual(result.newContent, "const y = 2;\n", "Clean deletion with no trailing blank line");
  console.log();
}
testDeleteCodeBlockWithoutOrphanLine();

async function testDeleteCodeBlockTrailingNewlineNotConsumed() {
  // File has "const x = 1;" with no trailing \n, we delete it
  const file = `const x = 1;`;
  const result = await applyEdits(file, [{ oldText: "const x = 1;", newText: "" }], "test.ts");
  assertEqual(result.newContent, "", "Complete deletion of single-line file");
  console.log();
}
testDeleteCodeBlockTrailingNewlineNotConsumed();

// ─── Edge cases ────────────────────────────────────────────────────

console.log("=== Edge cases ===\n");

async function testEmptyOldTextRejected() {
  throws(async () => {
    await applyEdits("content", [{ oldText: "", newText: "x" }], "test.ts");
  }, "Empty oldText rejected");
  console.log();
}
testEmptyOldTextRejected();

async function testNoChangeRejected() {
  throws(async () => {
    await applyEdits("content", [{ oldText: "content", newText: "content" }], "test.ts");
  }, "No-change edit rejected");
  console.log();
}
testNoChangeRejected();

// ─── Tier 4: Similarity matching ─────────────────────────────────────

console.log("=== Tier 4: Similarity matching ===\n");

async function testTier4SimilarityRescue() {
  const file = `function calculateTotal(price, quantity) {
  const tax = 0.08;
  const subtotal = price * quantity;
  const total = subtotal * (1 + tax);
  return total;
}`;

  // Old text with slight indentation difference on one line
  const oldText = `function calculateTotal(price, quantity) {
  const tax = 0.08;
    const subtotal = price * quantity;
  const total = subtotal * (1 + tax);
  return total;
}`;

  const newText = `function calculateTotal(price, quantity) {
  const tax = 0.10;
  const subtotal = price * quantity;
  const total = subtotal * (1 + tax);
  return total;
}`;

  const result = await applyEdits(file, [{ oldText, newText }], "test.ts");

  // Should match via Tier 4 (similarity) and apply the edit
  assert(result.newContent.includes("const tax = 0.10;"), "Tier 4 should rescue near-match and apply edit");
  assert(result.matchNotes.some((note: string) => note.includes("similarity") || note.includes("Similarity")), "Should have similarity match note");
  console.log();
}
testTier4SimilarityRescue();

async function testTier4RejectsDifferentContent() {
  const file = `function foo() {
  return 42;
}`;

  // Completely different content
  const oldText = `class Bar {
  constructor() {
    this.value = 100;
  }
}`;

  try {
    await applyEdits(file, [{ oldText, newText: "replaced" }], "test.ts");
    throw new Error("Should have thrown for non-matching text");
  } catch (e: any) {
    assert(e.message.includes("Could not find"), "Should report text not found for low similarity");
  }
  console.log();
}
testTier4RejectsDifferentContent();

// ─── lineRangeToByteRange ──────────────────────────────────────────

console.log("=== lineRangeToByteRange ===\n");

function testLineRangeToByteRangeFirstLine() {
  const content = "abc\ndef\nghi\n";
  const result = lineRangeToByteRange(content, { startLine: 1, endLine: 1 });
  assertEqual(result.startIndex, 0, "First line start is 0");
  assertEqual(result.endIndex, 4, "First line end includes newline");
  console.log();
}
testLineRangeToByteRangeFirstLine();

function testLineRangeToByteRangeSecondLine() {
  const content = "abc\ndef\nghi\n";
  const result = lineRangeToByteRange(content, { startLine: 2, endLine: 2 });
  assertEqual(result.startIndex, 4, "Second line start");
  assertEqual(result.endIndex, 8, "Second line end");
  console.log();
}
testLineRangeToByteRangeSecondLine();

function testLineRangeToByteRangeMultiLine() {
  const content = "abc\ndef\nghi\n";
  const result = lineRangeToByteRange(content, { startLine: 1, endLine: 3 });
  assertEqual(result.startIndex, 0, "Multi-line start is 0");
  assertEqual(result.endIndex, 12, "Multi-line end covers all");
  console.log();
}
testLineRangeToByteRangeMultiLine();

function testLineRangeToByteRangeClamp() {
  const content = "abc\ndef\n";
  const result = lineRangeToByteRange(content, { startLine: 999 });
  assertEqual(result.startIndex, 8, "Clamp to last line");
  console.log();
}
testLineRangeToByteRangeClamp();

function testLineRangeToByteRangeTotalLines() {
  // No trailing newline to avoid an extra empty split element
  const content = "a\nb\nc";
  const result = lineRangeToByteRange(content, { startLine: 1 });
  assertEqual(result.totalLines, 3, "Total lines reported");
  console.log();
}
testLineRangeToByteRangeTotalLines();

// ─── validateLineRange ────────────────────────────────────────────

console.log("=== validateLineRange ===\n");

function testValidateLineRangeValid() {
  const result = validateLineRange({ startLine: 1, endLine: 5 }, 10);
  assertEqual(result, null, "Valid range returns null");
  console.log();
}
testValidateLineRangeValid();

function testValidateLineRangeStartLineTooLow() {
  const result = validateLineRange({ startLine: 0 }, 10);
  assert(result !== null, "startLine < 1 is invalid");
  assert(result!.includes(">= 1"), "Error mentions >= 1");
  console.log();
}
testValidateLineRangeStartLineTooLow();

function testValidateLineRangeStartExceedsFile() {
  const result = validateLineRange({ startLine: 100 }, 10);
  assert(result !== null, "startLine > file length is invalid");
  assert(result!.includes("exceeds"), "Error mentions exceeds");
  console.log();
}
testValidateLineRangeStartExceedsFile();

function testValidateLineRangeEndExceedsFile() {
  const result = validateLineRange({ startLine: 1, endLine: 100 }, 10);
  assert(result !== null, "endLine > file length is invalid");
  assert(result!.includes("exceeds"), "Error mentions exceeds");
  console.log();
}
testValidateLineRangeEndExceedsFile();

function testValidateLineRangeEndLessThanStart() {
  const result = validateLineRange({ startLine: 5, endLine: 3 }, 10);
  assert(result !== null, "endLine < startLine is invalid");
  assert(result!.includes(">= startLine"), "Error mentions end >= start");
  console.log();
}
testValidateLineRangeEndLessThanStart();

// ─── findText with searchScope ────────────────────────────────────

console.log("=== findText with searchScope ===\n");

async function testSearchScopeNarrowsMatch() {
  const content = "function foo() {\n  bar();\n  baz();\n}\n";
  const indentStyle = detectIndentation(content);

  // Find within whole file first
  const matchWhole = findText(content, "bar()", indentStyle);
  assert(matchWhole.found, "bar() found in whole file");

  // Now narrow to bytes 0-10 ("function f") — should NOT find "bar()"
  const narrowScope: SearchScope = {
    startIndex: 0,
    endIndex: 10,
    description: "narrow range without target",
    source: "anchor" as const,
  };
  const matchNarrow = findText(content, "bar()", indentStyle, 0, narrowScope);
  assert(!matchNarrow.found, "bar() not found in narrow scope (0-10)");

  // Scope covering the function signature — should find "foo" but not "bar()"
  // Content: "function foo() {\n  bar();\n  baz();\n}\n"
  // "function foo() {" is 16 chars + \n = 17, so bytes 0-17 is the signature
  const funcSigScope: SearchScope = {
    startIndex: 0,
    endIndex: 17,
    description: "function signature only",
    source: "anchor" as const,
  };
  const matchFoo = findText(content, "foo", indentStyle, 0, funcSigScope);
  assert(matchFoo.found, "foo found within function sig scope");
  const matchBarNarrow = findText(content, "bar()", indentStyle, 0, funcSigScope);
  assert(!matchBarNarrow.found, "bar() not found in func sig scope");
  console.log();
}
testSearchScopeNarrowsMatch();

function testSearchScopeWithinLines() {
  const content = "line1\nline2\nline3\nline4\nline5\n";
  const indentStyle = detectIndentation(content);

  // line1 = "line1\n" = 6 bytes, line2 starts at byte 6
  // Search bytes 6-18 (includes "line2\nline3" but not "line1")
  const scope: SearchScope = {
    startIndex: 6,
    endIndex: 18,
    description: "lines 2-3",
    source: "anchor" as const,
  };

  const matchLine2 = findText(content, "line2", indentStyle, 0, scope);
  assert(matchLine2.found, "line2 found within scope");
  assertEqual(matchLine2.index, 6, "line2 found at correct absolute position");

  const matchLine1 = findText(content, "line1", indentStyle, 0, scope);
  assert(!matchLine1.found, "line1 not found outside scope");
  console.log();
}
testSearchScopeWithinLines();

// ─── findAllMatches with searchScope ──────────────────────────────

console.log("=== findAllMatches with searchScope ===\n");

function testFindAllMatchesWithinScope() {
  const content = "a\na\na\nb\n";
  const indentStyle = { char: " " as const, width: 2 };

  // Find all 'a' in whole file
  // Content: a(0) \n(1) a(2) \n(3) a(4) \n(5) b(6) \n(7)
  const allWhole = findAllMatches(content, "a", indentStyle, 0);
  assertEqual(allWhole.length, 3, "3 'a' matches in whole file");

  // Scope to bytes 2-4 (only the second 'a' at byte 2)
  const scope: SearchScope = {
    startIndex: 2,
    endIndex: 4,
    description: "second a",
    source: "anchor" as const,
  };
  const allScoped = findAllMatches(content, "a", indentStyle, 0, scope);
  // Should only find one 'a' (the one at byte 2)
  assertEqual(allScoped.length, 1, "1 'a' match within scoped range");
  assertEqual(allScoped[0].index, 2, "Match at correct absolute position");
  console.log();
}
testFindAllMatchesWithinScope();

// ─── applyEdits with searchScopes option ─────────────────────────

console.log("=== applyEdits with searchScopes ===\n");

async function testApplyEditsWithSearchScope() {
  const content = "function foo() {\n  const x = 1;\n  const x = 2;\n  return x;\n}\n";
  const indentStyle = detectIndentation(content);

  // Scope to the second 'const x = ...' only
  // "function foo() {\n" = 17 bytes, "  const x = 1;\n" = 16 bytes, total = 33 bytes
  // Second const x starts at byte 33
  const scope: SearchScope = {
    startIndex: 33,
    endIndex: 55,
    description: "second const x",
    source: "anchor" as const,
  };

  const result = await applyEdits(content, [
    { oldText: "const x = 2", newText: "const x = 99" },
  ], "test.ts", { searchScopes: [scope] });

  assert(result.newContent.includes("const x = 99"), "Second x updated via searchScope");
  assert(result.newContent.includes("const x = 1"), "First x unchanged");
  console.log();
}
testApplyEditsWithSearchScope();

async function testApplyEditsSearchScopeReplaceAll() {
  const content = "x = 1\nx = 2\nx = 3\nx = 4\n";
  const indentStyle = { char: " " as const, width: 2 };

  // Scope to bytes 0-6: only "x = 1\n" (x at position 0)
  const scope: SearchScope = {
    startIndex: 0,
    endIndex: 6,
    description: "first x only",
    source: "anchor" as const,
  };

  const result = await applyEdits(content, [
    { oldText: "x", newText: "y", replaceAll: true },
  ], "test.ts", { searchScopes: [scope] });

  // With scope 0-6, only the first "x" should be matched
  const yOccurrences = (result.newContent.match(/y/g) || []).length;
  assertEqual(yOccurrences, 1, "Only first x replaced when searchScope limits replaceAll");
  assert(result.newContent.includes("x = 2"), "Second x unchanged");
  console.log();
}
testApplyEditsSearchScopeReplaceAll();

// ─── onBeforeApply ────────────────────────────────────────────────

console.log("=== onBeforeApply ===\n");

async function testOnBeforeApplyIsCalled() {
  const content = "hello world\n";
  let callCount = 0;
  let capturedSpans: unknown[] = [];

  await applyEdits(content, [
    { oldText: "hello", newText: "hi" },
  ], "test.ts", {
    onBeforeApply: (spans) => {
      callCount++;
      capturedSpans = spans;
    },
  });

  assertEqual(callCount, 1, "onBeforeApply called once");
  assert(capturedSpans.length >= 1, "Spans captured");
  if (capturedSpans.length > 0) {
    const span = (capturedSpans as Array<{ matchIndex: number; matchLength: number; newText: string }>)[0];
    assertEqual(span.matchIndex, 0, "Correct match index");
    assertEqual(span.newText, "hi", "Correct new text");
  }
  console.log();
}
testOnBeforeApplyIsCalled();

async function testOnBeforeApplyMultipleEdits() {
  const content = "a = 1\nb = 2\nc = 3\n";
  let callCount = 0;

  await applyEdits(content, [
    { oldText: "a = 1", newText: "a = 10" },
    { oldText: "c = 3", newText: "c = 30" },
  ], "test.ts", {
    onBeforeApply: () => {
      callCount++;
    },
  });

  assertEqual(callCount, 1, "onBeforeApply called once for multiple edits");
  console.log();
}
testOnBeforeApplyMultipleEdits();

async function testOnBeforeApplyReceivesOriginalContent() {
  const content = "const x = 1;\n";
  let capturedContent = "";

  await applyEdits(content, [
    { oldText: "const x = 1", newText: "const y = 1" },
  ], "test.ts", {
    onBeforeApply: (_spans, content) => {
      capturedContent = content;
    },
  });

  assertEqual(capturedContent, content, "onBeforeApply receives original content");
  console.log();
}
testOnBeforeApplyReceivesOriginalContent();

// ─── Summary ──────────────────────────────────────────────────────

console.log("=== All tests completed ===\n");
