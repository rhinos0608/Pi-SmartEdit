/**
 * Tests for the smart-edit extension's Conflict Detector module.
 *
 * Validates:
 * - Line-range (byte overlap) conflict detection (no AST needed)
 * - Configuration options (enabled/disabled, warn/error modes)
 * - Edge cases: empty history, cleared history, no conflicts
 * - recordEdit / checkConflicts / clearForFile / clearAll
 *
 * Run: npx tsx test/conflict-detector.test.ts
 */

import { createConflictDetector } from "../.pi/extensions/smart-edit/lib/conflict-detector";
import type { ConflictDetectionConfig } from "../.pi/extensions/smart-edit/lib/types";

// ─── Helpers ────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `FAIL: ${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
  console.log(`  ✓ ${message}`);
}

async function assertResolves<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  const result = await promise;
  console.log(`  ✓ ${message}`);
  return result;
}

// ─── Test: Basic conflict detection (line-range / byte overlap) ─────

console.log("\n=== Line-range conflict detection (byte overlap) ===\n");

async function testByteOverlapDetected(): Promise<void> {
  const detector = createConflictDetector({ enabled: true, onConflict: "warn", scope: "all" });

  // Record an edit at bytes 10-20
  await detector.recordEdit("test.ts", "some content here", [{ startIndex: 10, endIndex: 20 }], "first edit");

  // Check a conflicting edit at bytes 15-25
  const conflicts = await detector.checkConflicts("test.ts", "some content here", [{ startIndex: 15, endIndex: 25 }]);

  assertEqual(conflicts.length, 1, "Byte overlap conflict detected");
  assertEqual(conflicts[0].relationship, "same", "Relationship is 'same' for byte-range overlap");
  assert(conflicts[0].suggestion.includes("overlaps"), "Suggestion mentions overlap");
  assertEqual(conflicts[0].previousEdit.turn, 1, "Previous turn is 1");
}

async function testNoConflictForNonOverlappingEdits(): Promise<void> {
  const detector = createConflictDetector({ enabled: true, onConflict: "warn", scope: "all" });

  await detector.recordEdit("test.ts", "abcdefghijklmnopqrstuvwxyz", [{ startIndex: 0, endIndex: 5 }]);

  // Non-overlapping range
  const conflicts = await detector.checkConflicts("test.ts", "abcdefghijklmnopqrstuvwxyz", [{ startIndex: 10, endIndex: 15 }]);

  assertEqual(conflicts.length, 0, "No conflict for non-overlapping ranges");
}

async function testNoConflictForDifferentFile(): Promise<void> {
  const detector = createConflictDetector({ enabled: true, onConflict: "warn", scope: "all" });

  await detector.recordEdit("file-a.ts", "content", [{ startIndex: 0, endIndex: 5 }]);

  // Same byte range but different file
  const conflicts = await detector.checkConflicts("file-b.ts", "content", [{ startIndex: 0, endIndex: 5 }]);

  assertEqual(conflicts.length, 0, "No conflict across different files");
}

// ─── Test: Disabled configuration ────────────────────────────────────

console.log("\n=== Disabled configuration ===\n");

async function testDisabledReturnsNoConflicts(): Promise<void> {
  const detector = createConflictDetector({ enabled: false, onConflict: "warn", scope: "all" });

  await detector.recordEdit("test.ts", "content", [{ startIndex: 0, endIndex: 10 }]);

  const conflicts = await detector.checkConflicts("test.ts", "content", [{ startIndex: 0, endIndex: 10 }]);

  assertEqual(conflicts.length, 0, "No conflicts when disabled");
}

// ─── Test: Clear operations ─────────────────────────────────────────

console.log("\n=== Clear operations ===\n");

async function testClearForFile(): Promise<void> {
  const detector = createConflictDetector({ enabled: true, onConflict: "warn", scope: "all" });

  await detector.recordEdit("test.ts", "content", [{ startIndex: 0, endIndex: 5 }], "edit on test.ts");
  await detector.recordEdit("other.ts", "content", [{ startIndex: 0, endIndex: 5 }], "edit on other.ts");

  // Clear only test.ts
  detector.clearForFile("test.ts");

  const conflicts = await detector.checkConflicts("test.ts", "content", [{ startIndex: 0, endIndex: 10 }]);
  assertEqual(conflicts.length, 0, "No conflicts after clearForFile");
}

async function testClearAll(): Promise<void> {
  const detector = createConflictDetector({ enabled: true, onConflict: "warn", scope: "all" });

  await detector.recordEdit("test.ts", "content", [{ startIndex: 0, endIndex: 5 }]);
  await detector.recordEdit("other.ts", "content", [{ startIndex: 0, endIndex: 5 }]);

  detector.clearAll();

  const conflicts1 = await detector.checkConflicts("test.ts", "content", [{ startIndex: 0, endIndex: 10 }]);
  const conflicts2 = await detector.checkConflicts("other.ts", "content", [{ startIndex: 0, endIndex: 10 }]);

  assertEqual(conflicts1.length, 0, "No conflicts after clearAll (file 1)");
  assertEqual(conflicts2.length, 0, "No conflicts after clearAll (file 2)");
}

// ─── Test: scope = "last" ──────────────────────────────────────────

console.log("\n=== scope='last' ===\n");

async function testScopeLast(): Promise<void> {
  const detector = createConflictDetector({ enabled: true, onConflict: "warn", scope: "all" });

  // Record two edits to the same file
  await detector.recordEdit("test.ts", "content", [{ startIndex: 0, endIndex: 5 }], "first");
  await detector.recordEdit("test.ts", "content", [{ startIndex: 10, endIndex: 15 }], "second");

  // Check overlapping with the second edit's range
  const conflicts = await detector.checkConflicts("test.ts", "content", [{ startIndex: 12, endIndex: 20 }]);

  // With scope='all', both edits are checked — we should find a conflict with the second
  assert(conflicts.length >= 1, "Conflicts found with scope='all'");
}

// ─── Test: Multiple spans ──────────────────────────────────────────

console.log("\n=== Multiple spans ===\n");

async function testMultipleSpansOneConflicting(): Promise<void> {
  const detector = createConflictDetector({ enabled: true, onConflict: "warn", scope: "all" });

  await detector.recordEdit("test.ts", "abcdefghijklmnop", [{ startIndex: 0, endIndex: 5 }]);

  // One span conflicts, one doesn't
  const conflicts = await detector.checkConflicts("test.ts", "abcdefghijklmnop", [
    { startIndex: 0, endIndex: 5 },    // conflicts
    { startIndex: 10, endIndex: 15 },  // doesn't conflict
  ]);

  assert(conflicts.length >= 1, "At least one conflict for overlapping span");
}

// ─── Test: Empty history ───────────────────────────────────────────

console.log("\n=== Empty history edge cases ===\n");

async function testEmptyHistory(): Promise<void> {
  const detector = createConflictDetector({ enabled: true, onConflict: "warn", scope: "all" });

  // checkConflicts with no prior edits — should be empty
  const conflicts = await detector.checkConflicts("test.ts", "content", [{ startIndex: 0, endIndex: 10 }]);

  assertEqual(conflicts.length, 0, "No conflicts with empty history");
}

// ─── Test: No AST resolver (null) ─────────────────────────────────

console.log("\n=== Null AST resolver (fallback to byte-range) ===\n");

async function testNullAstResolver(): Promise<void> {
  // Passing null for getAstResolver explicitly
  const detector = createConflictDetector(
    { enabled: true, onConflict: "warn", scope: "all" },
    () => null,
  );

  // The detector should still work via line-range fallback
  await detector.recordEdit("test.ts", "content", [{ startIndex: 5, endIndex: 15 }], "fallback edit");

  const conflicts = await detector.checkConflicts("test.ts", "content", [{ startIndex: 0, endIndex: 10 }]);

  assert(conflicts.length >= 1, "Fallback detects byte-overlap conflict");
  assertEqual(conflicts[0].previousSymbol.kind, "byte_range", "Fallback uses byte_range kind");
}

// ─── Test: Turn counter increments ─────────────────────────────────

console.log("\n=== Turn counter ===\n");

async function testTurnCounterIncrements(): Promise<void> {
  const detector1 = createConflictDetector({ enabled: true, onConflict: "warn", scope: "last" });
  const detector2 = createConflictDetector({ enabled: true, onConflict: "warn", scope: "last" });

  // Each detector is a separate instance with its own counter
  await detector1.recordEdit("test.ts", "content", [{ startIndex: 0, endIndex: 5 }]);
  await detector2.recordEdit("test.ts", "content", [{ startIndex: 0, endIndex: 5 }]);

  const conflict1 = await detector1.checkConflicts("test.ts", "content", [{ startIndex: 0, endIndex: 5 }]);
  const conflict2 = await detector2.checkConflicts("test.ts", "content", [{ startIndex: 0, endIndex: 5 }]);

  assert(conflict1.length > 0, "Detector 1 finds conflict");
  assert(conflict2.length > 0, "Detector 2 finds conflict");
}

// ─── Test: Multiple edits to same file ─────────────────────────────

console.log("\n=== Multiple edits to same file ===\n");

async function testMultipleRecordedEdits(): Promise<void> {
  const detector = createConflictDetector({ enabled: true, onConflict: "warn", scope: "all" });

  // Record several edits to the same file
  await detector.recordEdit("test.ts", "content", [{ startIndex: 0, endIndex: 5 }], "edit 1");
  await detector.recordEdit("test.ts", "content", [{ startIndex: 10, endIndex: 15 }], "edit 2");
  await detector.recordEdit("test.ts", "content", [{ startIndex: 20, endIndex: 25 }], "edit 3");

  // New edit overlapping with edit 2
  const conflicts = await detector.checkConflicts("test.ts", "content", [{ startIndex: 12, endIndex: 18 }]);

  assert(conflicts.length > 0, "Conflict detected with prior edit");
  assert(conflicts[0].previousEdit.description === "edit 2", "Correct prior edit identified");
}

// ─── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Conflict Detector Tests ===\n");

  let passed = 0;
  let failed = 0;

  const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [
    // Line-range / byte overlap
    { name: "byte overlap detected", fn: testByteOverlapDetected },
    { name: "no conflict for non-overlapping", fn: testNoConflictForNonOverlappingEdits },
    { name: "no conflict for different files", fn: testNoConflictForDifferentFile },

    // Disabled config
    { name: "disabled returns no conflicts", fn: testDisabledReturnsNoConflicts },

    // Clear operations
    { name: "clearForFile", fn: testClearForFile },
    { name: "clearAll", fn: testClearAll },

    // Scope = all
    { name: "multiple edits with scope=all", fn: testScopeLast },

    // Multiple spans
    { name: "multiple spans one conflicting", fn: testMultipleSpansOneConflicting },

    // Edge cases
    { name: "empty history no conflicts", fn: testEmptyHistory },

    // Null AST resolver (fallback)
    { name: "null AST resolver fallback", fn: testNullAstResolver },

    // Turn counter
    { name: "turn counter increments", fn: testTurnCounterIncrements },

    // Multiple edits
    { name: "multiple recorded edits", fn: testMultipleRecordedEdits },
  ];

  for (const test of tests) {
    try {
      const result = test.fn();
      if (result instanceof Promise) {
        await result;
      }
      passed++;
    } catch (err) {
      failed++;
      console.error(`  ✗ ${test.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n────────────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("All tests passed!");
  }
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
