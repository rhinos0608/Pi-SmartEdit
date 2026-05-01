/**
 * Tests for multi-format input parsing.
 *
 * Run: npx tsx test/formats.test.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { detectInputFormat } from '../.pi/extensions/smart-edit/src/formats/format-detector';
import { parseSearchReplace } from '../.pi/extensions/smart-edit/src/formats/search-replace';
import { parseUnifiedDiffToEditItems, parseUnifiedDiff } from '../.pi/extensions/smart-edit/src/formats/unified-diff';
import { parseOpenAIPatch, openAIPatchToEditItem } from '../.pi/extensions/smart-edit/src/formats/openai-patch';

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

function assertMatch(actual: string, regex: RegExp, message: string): void {
  if (!regex.test(actual)) {
    throw new Error(`FAIL: ${message}\n    expected regex: ${regex}\n    actual: ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${message}`);
}

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', 'formats', name), 'utf-8');
}

const FIXTURES = join(__dirname, 'fixtures', 'formats');

// ════════════════════════════════════════════════════════════════════
//  format-detector tests
// ════════════════════════════════════════════════════════════════════

function testFormatDetector() {
  console.log('\n=== format-detector ===\n');

  // Test search_replace detection
  const sr = detectInputFormat('<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE');
  assertEqual(sr, 'search_replace', 'Detects search_replace format');

  // Test unified_diff detection
  const ud = detectInputFormat('--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new');
  assertEqual(ud, 'unified_diff', 'Detects unified_diff format');

  // Test openai_patch detection
  const op = detectInputFormat('*** Begin Patch\n*** Update File: test.ts\n@@ fn() {\n-old\n+new\n*** End Patch');
  assertEqual(op, 'openai_patch', 'Detects openai_patch format (with space)');

  const op2 = detectInputFormat('***Begin Patch\n@@ fn() {\n-old\n+new\n*** End Patch');
  assertEqual(op2, 'openai_patch', 'Detects openai_patch format (no space)');

  // Test raw_edits detection
  const raw = detectInputFormat('[{ "oldText": "a", "newText": "b" }]');
  assertEqual(raw, 'raw_edits', 'Detects raw_edits for JSON input');

  // Test empty string
  const empty = detectInputFormat('');
  assertEqual(empty, 'raw_edits', 'Empty string is raw_edits');
}

// ════════════════════════════════════════════════════════════════════
//  search-replace tests
// ════════════════════════════════════════════════════════════════════

function testSearchReplace() {
  console.log('\n=== search-replace ===\n');

  // Test simple block
  const simple = parseSearchReplace('<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 10;\n>>>>>>> REPLACE');
  assertEqual(simple.length, 1, 'Parses single block');
  assertEqual(simple[0].path, undefined, 'No path when no filename');
  assertEqual(simple[0].oldText, 'const x = 1;', 'Extracts oldText');
  assertEqual(simple[0].newText, 'const x = 10;', 'Extracts newText');

  // Test block with filename
  const withPath = parseSearchReplace('file.ts\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE');
  assertEqual(withPath.length, 1, 'Parses block with filename');
  assertEqual(withPath[0].path, 'file.ts', 'Extracts filename');
  assertEqual(withPath[0].oldText, 'a', 'Extracts oldText');

  // Test multiple blocks
  const multi = parseSearchReplace(
    '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n' +
    '<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE'
  );
  assertEqual(multi.length, 2, 'Parses multiple blocks');
  assertEqual(multi[1].oldText, 'c', 'Second block oldText');

  // Test nested markers
  const nested = parseSearchReplace(
    '<<<<<<< SEARCH\n' +
    '  const str = `<<<<<<< SEARCH\n  old`;\n' +
    '=======\n' +
    '  const str = `<<<<<<< SEARCH\n  new`;\n' +
    '>>>>>>> REPLACE'
  );
  assertEqual(nested.length, 1, 'Nested markers are not confused');
  assert(nested[0].oldText.includes('<<<<<<< SEARCH'), 'Nested marker preserved in oldText');

  // Test empty SEARCH throws
  try {
    parseSearchReplace('<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE');
    assert(false, 'Empty SEARCH should throw');
  } catch (e) {
    assert(true, 'Empty SEARCH throws error: ' + (e as Error).message);
  }

  // Test truncated block (missing REPLACE)
  try {
    parseSearchReplace('<<<<<<< SEARCH\nold\n=======\nnew\n');
    assert(false, 'Truncated block should throw');
  } catch (e) {
    assert(true, 'Truncated block throws error: ' + (e as Error).message);
  }

  // Test CRLF line endings
  const crlf = parseSearchReplace('<<<<<<< SEARCH\r\nold\r\n=======\r\nnew\r\n>>>>>>> REPLACE');
  assertEqual(crlf.length, 1, 'CRLF normalized to LF');
  assertEqual(crlf[0].oldText, 'old', 'CRLF oldText extracted');
}

// ════════════════════════════════════════════════════════════════════
//  unified-diff tests
// ════════════════════════════════════════════════════════════════════

function testUnifiedDiff() {
  console.log('\n=== unified-diff ===\n');

  // Test simple diff
  const simple = parseUnifiedDiffToEditItems(
    '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n const x = 1;\n-const y = 2;\n+const y = 22;\n const z = 3;\n'
  );
  assertEqual(simple.length, 1, 'Single hunk parsed');
  assert(simple[0].oldText.includes('const y = 2'), 'Removed line in oldText');
  assert(simple[0].newText.includes('const y = 22'), 'Added line in newText');
  assert(simple[0].oldText.includes('const x = 1'), 'Context line in oldText');
  assert(simple[0].newText.includes('const x = 1'), 'Context line in newText');

  // Test multi-hunk diff — parsePatch may merge adjacent hunks
  const multi = parseUnifiedDiffToEditItems(fixture('unified-diff-multi-hunk.diff'));
  assert(multi.length >= 1, 'At least one edit parsed from multi-hunk');
  assert(multi[0].newText.includes('console.log'), 'Has new content from patch');
  assert(multi[0].oldText.includes('return temp'), 'Has old content from patch');
  assert(multi[0].oldText.includes('const temp = 1'), 'Second hunk removal');

  // Test new file diff
  const newFile = parseUnifiedDiffToEditItems(fixture('unified-diff-newfile.diff'));
  assertEqual(newFile.length, 1, 'New file hunk parsed');
  assertEqual(newFile[0].oldText, '', 'New file has empty oldText');
  assert(newFile[0].newText.includes('export function newFunc'), 'New file has content');
  assertEqual(newFile[0].path, 'src/newfile.ts', 'Path extracted from +++ line');

  // Test -U0 (no context lines)
  const u0 = parseUnifiedDiffToEditItems(
    '--- a/file.ts\n+++ b/file.ts\n@@ -1,0 +2,1 @@\n+const z = 3;\n'
  );
  assertEqual(u0.length, 1, 'U0 hunk parsed');
  assertEqual(u0[0].oldText, '', 'U0 add-only has empty oldText');
  assertEqual(u0[0].newText, 'const z = 3;', 'U0 newText extracted');

  // Test path stripping
  const pathTest = parseUnifiedDiffToEditItems(
    '--- a/some/dir/file.ts\n+++ b/some/dir/file.ts\n@@ -1 +1 @@\n-a\n+b\n'
  );
  assertEqual(pathTest[0].path, 'some/dir/file.ts', 'b/ prefix stripped from path');
}

// ════════════════════════════════════════════════════════════════════
//  openai-patch tests
// ════════════════════════════════════════════════════════════════════

function testOpenAIPatch() {
  console.log('\n=== openai-patch ===\n');

  // Test simple patch
  const simple = parseOpenAIPatch(fixture('openai-patch-simple.txt'));
  assertEqual(simple.length, 1, 'Single patch parsed');
  assert(simple[0].path.includes('src/file.ts'), 'Path extracted');
  assert(simple[0].removedLines.some(l => l.includes('const response = await fetch')), 'Removed line found');
  assert(simple[0].addedLines.some(l => l.includes('{ headers }')), 'Added line found');

  // Test multi-section patch
  const multi = parseOpenAIPatch(fixture('openai-patch-multi.txt'));
  assertEqual(multi.length, 2, 'Multi-section patch parsed as two results');
  assert(multi[0].removedLines.some(l => l.includes('db.findUser')), 'First section removed line');
  assert(multi[0].addedLines.some(l => l.includes('await db.findUser')), 'First section added line');
  assert(multi[1].removedLines.some(l => l.includes('session.clear')), 'Second section removed line');
  assert(multi[1].addedLines.some(l => l.includes('await session.clear')), 'Second section added line');

  // Test patch without End Patch marker
  const noEnd = parseOpenAIPatch(
    '*** Begin Patch\n*** Update File: test.ts\n@@ fn() {\n-old\n+new\n'
  );
  assertEqual(noEnd.length, 1, 'Parsed without End Patch marker');

  // Test add-only section
  const addOnly = parseOpenAIPatch(
    '*** Begin Patch\n*** Update File: test.ts\n@@ fn() {\n+const x = 1;\n}\n*** End Patch'
  );
  assertEqual(addOnly.length, 1, 'Add-only patch parsed');
  assertEqual(addOnly[0].removedLines.length, 0, 'No removed lines');
  assert(addOnly[0].addedLines.length > 0, 'Has added lines');

  // Test remove-only section
  const removeOnly = parseOpenAIPatch(
    '*** Begin Patch\n*** Update File: test.ts\n@@ fn() {\n-const x = 1;\n}\n*** End Patch'
  );
  assertEqual(removeOnly.length, 1, 'Remove-only patch parsed');
  assert(removeOnly[0].removedLines.length > 0, 'Has removed lines');
  assertEqual(removeOnly[0].addedLines.length, 0, 'No added lines');

  // Test openAIPatchToEditItem conversion
  if (simple.length > 0) {
    const item = openAIPatchToEditItem(simple[0]);
    assert(item.oldText.includes('const response = await fetch'), 'OldText includes removed line');
    assert(item.newText.includes('{ headers }'), 'NewText includes added line');
    assert(item.oldText.includes('function fetchData'), 'OldText includes anchor');
  }
}

// ════════════════════════════════════════════════════════════════════
//  Runner
// ════════════════════════════════════════════════════════════════════

async function main() {
  console.log('=== Format Parser Tests ===');

  testFormatDetector();
  testSearchReplace();
  testUnifiedDiff();
  testOpenAIPatch();

  console.log('\n=== All format tests completed ===\n');
}

void main();
