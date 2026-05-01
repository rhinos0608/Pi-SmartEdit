/**
 * Tests for the stale-file read cache (Phase 2).
 *
 * Run: npx tsx test/read-cache.test.ts
 */

import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

// Import the module under test
import { recordRead, checkStale, clearCache } from "../.pi/extensions/smart-edit/lib/read-cache";

// ─── Helpers ────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

let testDir: string;
let testFile: string;

function setup() {
  testDir = join(tmpdir(), `smart-edit-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(testDir, { recursive: true });
  testFile = join(testDir, "test.ts");
  clearCache();
}

function teardown() {
  try { unlinkSync(testFile); } catch { /* ok */ }
  try { unlinkSync(join(testDir, "package.json")); } catch { /* ok */ }
}

// ─── Tests ──────────────────────────────────────────────────────────

console.log("\n=== Phase 2: Stale-file guard ===\n");

setup();
const content = "const x = 1;\nconst y = 2;\n";

// Test 1: File not cached — should be rejected
async function testFileNotCached() {
  const err = await checkStale("never-read.ts", testDir);
  assert(err !== null, "Unread file detected as stale");
  assert(err!.includes("not been read"), "Error message mentions unread file");
  console.log();
}
testFileNotCached();

// Test 2: Record read, then check — should be fresh
async function testFreshFile() {
  writeFileSync(testFile, content);
  recordRead("test.ts", testDir, content);

  const err = await checkStale("test.ts", testDir);
  assert(err === null, "Unchanged file is fresh");
  console.log();
}
testFreshFile();

// Test 3: File modified — should be detected
async function testModifiedFile() {
  writeFileSync(testFile, content);
  recordRead("test.ts", testDir, content);

  // Modify the file
  writeFileSync(testFile, "const x = 999;\nconst y = 2;\n");

  const err = await checkStale("test.ts", testDir);
  assert(err !== null, "Modified file detected as stale");
  assert(err!.includes("modified"), "Error mentions modification");
  console.log();
}
testModifiedFile();

// Test 4: File deleted after read — should not trigger stale error (let tool handle not-found)
async function testFileDeleted() {
  const tmpFile = join(testDir, "temp.ts");
  writeFileSync(tmpFile, "content");
  recordRead("temp.ts", testDir, "content");
  unlinkSync(tmpFile);

  const err = await checkStale("temp.ts", testDir);
  assert(err === null, "Deleted file does not trigger stale error");
  console.log();
}
testFileDeleted();

// Test 5: Clear cache
async function testClearCache() {
  writeFileSync(testFile, "content");
  recordRead("test.ts", testDir, "content");
  clearCache();

  const err = await checkStale("test.ts", testDir);
  assert(err !== null, "After clear, file treated as unread");
  console.log();
}
testClearCache();

// Test 6: Simulate write-then-edit flow — file created by write tool, recorded, then edited
async function testWriteThenEdit() {
  // Simulate write tool creating a new file
  writeFileSync(testFile, "const z = 3;\n");
  recordRead("test.ts", testDir, "const z = 3;\n");

  // Now edit should see it as fresh (no stale error)
  let err = await checkStale("test.ts", testDir);
  assert(err === null, "Write-then-edit: file recorded after write is fresh");

  // Simulate write tool OVERWRITING an existing file
  writeFileSync(testFile, "const newContent = true;\n");
  recordRead("test.ts", testDir, "const newContent = true;\n");

  // Edit should still be fresh after the overwrite
  err = await checkStale("test.ts", testDir);
  assert(err === null, "Write-then-edit: overwritten file recorded after write is fresh");
  console.log();
}
testWriteThenEdit();

teardown();

console.log("=== All stale-file tests completed ===\n");
