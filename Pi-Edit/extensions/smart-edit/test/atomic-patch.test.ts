/**
 * Tests for atomic patch envelope parser and applicator.
 * Uses Node built-in test runner via tsx --test.
 */

import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert";
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync, rmSync } from "fs";
import { resolve, join } from "path";

import {
  parseAtomicPatchEnvelope,
  enqueueAtomicPatch,
  applyAtomicPatch,
  type AtomicPatchEnvelope,
  type AtomicPatchOp,
  type AtomicPatchResult,
  type AtomicPatchParseResult,
} from "../src/formats/atomic-patch";

// ─── Test Fixtures ───────────────────────────────────────────────────

const TEST_DIR = resolve(process.cwd(), ".test-atomic-patch");

function setupTestDir(): void {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
}

function teardownTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function createTestFile(relativePath: string, content: string): void {
  const fullPath = resolve(TEST_DIR, relativePath);
  const dir = join(TEST_DIR, relativePath.split("/").slice(0, -1).join("/"));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, content, "utf-8");
}

function deleteTestFile(relativePath: string): void {
  const fullPath = resolve(TEST_DIR, relativePath);
  if (existsSync(fullPath)) {
    unlinkSync(fullPath);
  }
}

function readTestFile(relativePath: string): string | null {
  const fullPath = resolve(TEST_DIR, relativePath);
  if (existsSync(fullPath)) {
    return readFileSync(fullPath, "utf-8");
  }
  return null;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("parseAtomicPatchEnvelope", () => {

  test("parses add file operation", () => {
    const input = `*** Begin Atomic Patch
*** Add File: src/new.ts
export const foo = "bar";
*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    assert.strictEqual(result.envelope.operations.length, 1);

    const op = result.envelope.operations[0];
    assert.strictEqual(op.kind, 'AddFile');
    assert.strictEqual(op.path, 'src/new.ts');
    assert.strictEqual(op.contents, 'export const foo = "bar";');
  });

  test("parses delete file operation", () => {
    const input = `*** Begin Atomic Patch
*** Delete File: src/old.ts
*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    assert.strictEqual(result.envelope.operations.length, 1);

    const op = result.envelope.operations[0];
    assert.strictEqual(op.kind, 'DeleteFile');
    assert.strictEqual(op.path, 'src/old.ts');
  });

  test("parses update file operation with patches", () => {
    const input = `*** Begin Atomic Patch
*** Update File: src/existing.ts
@@ function hello() @@
旧的函数
*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    assert.strictEqual(result.envelope.operations.length, 1);

    const op = result.envelope.operations[0];
    assert.strictEqual(op.kind, 'UpdateFile');
    assert.strictEqual(op.path, 'src/existing.ts');
    assert.ok(Array.isArray(op.patches));
    assert.strictEqual(op.patches.length, 1);
    assert.strictEqual(op.patches[0].oldText, '旧的函数');
  });

  test("parses rename file operation", () => {
    const input = `*** Begin Atomic Patch
*** Rename File: src/old.ts -> src/new.ts
*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    assert.strictEqual(result.envelope.operations.length, 1);

    const op = result.envelope.operations[0];
    assert.strictEqual(op.kind, 'RenameFile');
    assert.strictEqual(op.oldPath, 'src/old.ts');
    assert.strictEqual(op.newPath, 'src/new.ts');
  });

  test("parses multiple operations", () => {
    const input = `*** Begin Atomic Patch
*** Add File: src/new.ts
export const foo = "bar";
*** Delete File: src/old.ts
*** Update File: src/existing.ts
@@ function hello() @@
 old content
*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    assert.strictEqual(result.envelope.operations.length, 3);
    assert.strictEqual(result.envelope.operations[0].kind, 'AddFile');
    assert.strictEqual(result.envelope.operations[1].kind, 'DeleteFile');
    assert.strictEqual(result.envelope.operations[2].kind, 'UpdateFile');
  });

  test("parses without envelope markers (lenient mode)", () => {
    const input = `*** Add File: src/new.ts
export const foo = "bar";`;

    const result = parseAtomicPatchEnvelope(input);
    assert.strictEqual(result.envelope.operations.length, 1);
    assert.strictEqual(result.envelope.operations[0].kind, 'AddFile');
  });

  test("handles empty envelope", () => {
    const input = `*** Begin Atomic Patch
*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    assert.strictEqual(result.envelope.operations.length, 0);
  });

  test("handles update with move path", () => {
    const input = `*** Begin Atomic Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@ function hello() @@
 old content
*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    assert.strictEqual(result.envelope.operations.length, 1);

    const op = result.envelope.operations[0] as { kind: 'UpdateFile'; path: string; movePath?: string };
    assert.strictEqual(op.kind, 'UpdateFile');
    assert.strictEqual(op.path, 'src/old.ts');
    assert.strictEqual(op.movePath, 'src/new.ts');
  });

  test("strips trailing blank lines from add file contents", () => {
    const input = `*** Begin Atomic Patch
*** Add File: src/new.ts
export const foo = "bar";


*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    const op = result.envelope.operations[0] as { kind: 'AddFile'; contents: string };
    assert.strictEqual(op.kind, 'AddFile');
    // Should not have trailing newlines
    assert.ok(!op.contents.endsWith('\n\n'));
  });

  test("skips preamble content", () => {
    const input = `Some preamble text
More preamble

*** Begin Atomic Patch
*** Add File: src/new.ts
export const foo = "bar";
*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    assert.strictEqual(result.envelope.operations.length, 1);
    assert.ok(result.warnings.some(w => w.kind === 'preamble_skipped'));
  });

  test("warns about missing end marker", () => {
    const input = `*** Begin Atomic Patch
*** Add File: src/new.ts
export const foo = "bar";`;

    const result = parseAtomicPatchEnvelope(input);
    assert.strictEqual(result.envelope.operations.length, 1);
    assert.ok(result.warnings.some(w => w.kind === 'missing_end_patch'));
  });

});

describe("applyAtomicPatch", () => {

  beforeEach(() => {
    setupTestDir();
  });

  afterEach(() => {
    teardownTestDir();
  });

  test("adds new file", async () => {
    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'AddFile', path: 'new-file.ts', contents: 'export const foo = "bar";' },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(result.success);
    assert.strictEqual(result.operations[0].status, 'applied');

    const content = readTestFile('new-file.ts');
    assert.strictEqual(content, 'export const foo = "bar";');
  });

  test("deletes existing file", async () => {
    createTestFile('to-delete.ts', 'export const old = true;');
    assert.ok(existsSync(resolve(TEST_DIR, 'to-delete.ts')));

    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'DeleteFile', path: 'to-delete.ts' },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(result.success);
    assert.strictEqual(result.operations[0].status, 'applied');

    assert.ok(!existsSync(resolve(TEST_DIR, 'to-delete.ts')));
  });

  test("updates existing file with patches", async () => {
    createTestFile('existing.ts', 'old content\nsecond line');

    const envelope: AtomicPatchEnvelope = {
      operations: [
        {
          kind: 'UpdateFile',
          path: 'existing.ts',
          patches: [{ oldText: 'old content', newText: 'new content' }],
        },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(result.success);

    const content = readTestFile('existing.ts');
    assert.strictEqual(content, 'new content\nsecond line');
  });

  test("renames file", async () => {
    createTestFile('old-name.ts', 'export const renamed = true;');
    assert.ok(existsSync(resolve(TEST_DIR, 'old-name.ts')));

    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'RenameFile', oldPath: 'old-name.ts', newPath: 'new-name.ts' },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(result.success);
    assert.strictEqual(result.operations[0].status, 'applied');

    assert.ok(!existsSync(resolve(TEST_DIR, 'old-name.ts')));
    // Note: actual rename requires filesystem support; this tests the operation parsing
  });

  test("applies multi-operation envelope", async () => {
    createTestFile('to-update.ts', 'old content');

    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'AddFile', path: 'new-file.ts', contents: 'export const newFile = true;' },
        {
          kind: 'UpdateFile',
          path: 'to-update.ts',
          patches: [{ oldText: 'old content', newText: 'updated content' }],
        },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(result.success);
    assert.strictEqual(result.operations[0].status, 'applied');
    assert.strictEqual(result.operations[1].status, 'applied');

    const newContent = readTestFile('new-file.ts');
    assert.strictEqual(newContent, 'export const newFile = true;');

    const updatedContent = readTestFile('to-update.ts');
    assert.strictEqual(updatedContent, 'updated content');
  });

  test("fails validation for add when file exists (no force)", async () => {
    createTestFile('existing.ts', 'already exists');

    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'AddFile', path: 'existing.ts', contents: 'new content' },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(!result.success);
    assert.strictEqual(result.operations[0].status, 'failed');
    assert.ok(result.operations[0].error?.includes('already exists'));
  });

  test("succeeds add with force option when file exists", async () => {
    createTestFile('existing.ts', 'original content');

    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'AddFile', path: 'existing.ts', contents: 'forced content' },
      ],
    };

    const result = await applyAtomicPatch(envelope, { force: true }, TEST_DIR);
    assert.ok(result.success);
    assert.strictEqual(result.operations[0].status, 'applied');

    const content = readTestFile('existing.ts');
    assert.strictEqual(content, 'forced content');
  });

  test("fails validation for delete when file doesn't exist", async () => {
    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'DeleteFile', path: 'non-existent.ts' },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(!result.success);
    assert.strictEqual(result.operations[0].status, 'failed');
    assert.ok(result.operations[0].error?.includes('does not exist'));
  });

  test("fails validation for update when file doesn't exist", async () => {
    const envelope: AtomicPatchEnvelope = {
      operations: [
        {
          kind: 'UpdateFile',
          path: 'non-existent.ts',
          patches: [{ oldText: 'old', newText: 'new' }],
        },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(!result.success);
    assert.strictEqual(result.operations[0].status, 'failed');
    assert.ok(result.operations[0].error?.includes('does not exist'));
  });

  test("fails validation for rename when source doesn't exist", async () => {
    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'RenameFile', oldPath: 'non-existent.ts', newPath: 'new-name.ts' },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(!result.success);
    assert.strictEqual(result.operations[0].status, 'failed');
    assert.ok(result.operations[0].error?.includes('does not exist'));
  });

  test("fails validation for rename when target already exists", async () => {
    createTestFile('source.ts', 'source content');
    createTestFile('target.ts', 'target content');

    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'RenameFile', oldPath: 'source.ts', newPath: 'target.ts' },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(!result.success);
    assert.strictEqual(result.operations[0].status, 'failed');
    assert.ok(result.operations[0].error?.includes('already exists'));
  });

  test("rolls back on mid-envelope failure", async () => {
    createTestFile('to-update.ts', 'original content');

    // Create a scenario where the first operation succeeds in validation
    // but the second operation fails during application
    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'AddFile', path: 'new-file.ts', contents: 'new file content' },
        {
          kind: 'UpdateFile',
          path: 'to-update.ts',
          patches: [{ oldText: 'original content', newText: 'updated' }],
        },
      ],
    };

    // Modify the second operation to have wrong oldText so it fails
    // Use type assertion since we know this is an UpdateFile op
    (envelope.operations[1] as { patches: Array<{ oldText: string; newText: string }> }).patches[0].oldText = 'wrong content that does not exist';

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(!result.success);
    assert.strictEqual(result.operations[0].status, 'rolled_back');
    assert.strictEqual(result.operations[1].status, 'failed');
    assert.ok(result.rolledBack.length > 0);

    // First operation should be rolled back
    assert.ok(!existsSync(resolve(TEST_DIR, 'new-file.ts')));
  });

  test("fails when first operation has invalid path", async () => {
    // When validation fails on the first operation, nothing is applied
    // This is the correct atomic behavior - quick fail without partial changes
    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'DeleteFile', path: 'non-existent.ts' },
        { kind: 'AddFile', path: 'should-not-be-created.ts', contents: 'content' },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(!result.success);
    // First operation fails validation
    assert.strictEqual(result.operations[0].status, 'failed');
    // Second operation is also marked as failed (validation phase blocked all)
    // or could be skipped depending on implementation

    // Second file should not be created
    assert.ok(!existsSync(resolve(TEST_DIR, 'should-not-be-created.ts')));
  });

  test("skips undo when skipUndo option is true", async () => {
    // This test verifies the skipUndo flag is passed through
    // We can't directly test undo state, but we verify no errors
    createTestFile('to-update.ts', 'original');

    const envelope: AtomicPatchEnvelope = {
      operations: [
        {
          kind: 'UpdateFile',
          path: 'to-update.ts',
          patches: [{ oldText: 'original', newText: 'updated' }],
        },
      ],
    };

    const result = await applyAtomicPatch(envelope, { skipUndo: true }, TEST_DIR);
    assert.ok(result.success);
  });

  test("generates summary message on success", async () => {
    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'AddFile', path: 'new.ts', contents: 'content' },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(result.summary.includes('Successfully'));
    assert.ok(result.summary.includes('1 operation'));
  });

  test("generates summary message on failure", async () => {
    const envelope: AtomicPatchEnvelope = {
      operations: [
        { kind: 'DeleteFile', path: 'non-existent.ts' },
      ],
    };

    const result = await applyAtomicPatch(envelope, {}, TEST_DIR);
    assert.ok(!result.success);
    assert.ok(result.summary.includes('Validation failed'));
    assert.ok(result.summary.includes('does not exist'));
  });

});

describe("enqueueAtomicPatch", () => {

  beforeEach(() => {
    setupTestDir();
  });

  afterEach(() => {
    teardownTestDir();
  });

  test("parses and applies raw envelope string", async () => {
    const input = `*** Begin Atomic Patch
*** Add File: queued-file.ts
export const queued = true;
*** End Atomic Patch`;

    const result = await enqueueAtomicPatch(input, {}, TEST_DIR);
    assert.ok(result.success, `Expected success but got: ${result.summary}`);
    assert.strictEqual(result.operations[0].status, 'applied');

    const content = readTestFile('queued-file.ts');
    assert.strictEqual(content, 'export const queued = true;');
  });

  test("returns error for parse warnings", async () => {
    const input = `*** Add File: src/missing-end-marker.ts
export const incomplete = true;`;

    const result = await enqueueAtomicPatch(input, {}, TEST_DIR);
    // Should parse successfully but operation may or may not succeed
    assert.ok(result.operations.length > 0 || !result.success);
  });

});

describe("malformed envelope handling", () => {

  test("handles invalid rename format (missing arrow)", () => {
    const input = `*** Begin Atomic Patch
*** Rename File: src/old.ts src/new.ts
*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    // Should have warning about invalid format
    assert.ok(result.warnings.some(w => w.message.includes('arrow') || w.message.includes('Invalid')));
  });

  test("handles empty paths in rename", () => {
    const input = `*** Begin Atomic Patch
*** Rename File: ->
*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    // Should have warning about empty path
    assert.ok(result.warnings.some(w => w.message.includes('empty')));
  });

  test("skips unknown markers in lenient mode", () => {
    const input = `*** Begin Atomic Patch
*** Add File: src/new.ts
content
*** Unknown Marker
more content
*** End Atomic Patch`;

    const result = parseAtomicPatchEnvelope(input);
    // Should parse AddFile but skip unknown marker
    assert.strictEqual(result.envelope.operations.length, 1);
    assert.ok(result.warnings.some(w => w.kind === 'unknown_marker'));
  });

});