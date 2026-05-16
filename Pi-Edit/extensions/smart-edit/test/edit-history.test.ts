/**
 * Tests for Edit History / Undo system (src/undo/edit-history.ts).
 *
 * Each test gets its own subdirectory to prevent undo file pollution
 * across tests.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  readdir as fsReaddir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir as fsMkdir,
  rmdir as fsRmdir,
  stat as fsStat,
} from "fs/promises";
import { resolve, join, dirname } from "path";
import { randomBytes } from "crypto";

import {
  saveUndoState,
  restoreUndoState,
  getUndoHistory,
  clearUndoHistory,
} from "../src/undo/edit-history";

// ─── Test helpers ───────────────────────────────────────────────────

const BASE_DIR = resolve(
  __dirname,
  "..",
  ".test-tmp",
  `edit-history-${randomBytes(4).toString("hex")}`,
);

let testIdx = 0;

/**
 * Each test gets an isolated directory. Returns { cwd, undoDir }.
 */
function freshCwd(): { cwd: string; undoDir: string } {
  testIdx++;
  const cwd = resolve(BASE_DIR, `test${testIdx}`);
  return { cwd, undoDir: resolve(cwd, ".smart-edit-undo") };
}

async function writeTestFile(
  cwd: string,
  relPath: string,
  content: string,
): Promise<string> {
  const absPath = resolve(cwd, relPath);
  await fsMkdir(dirname(absPath), { recursive: true });
  await fsWriteFile(absPath, content, "utf-8");
  return absPath;
}

async function undoFileCount(undoDir: string): Promise<number> {
  try {
    const files = await fsReaddir(undoDir);
    return files.filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("edit-history", () => {
  before(async () => {
    // Clean up any leftover from previous runs
    try {
      await fsRmdir(BASE_DIR, { recursive: true });
    } catch {
      /* may not exist */
    }
  });

  after(async () => {
    try {
      await fsRmdir(BASE_DIR, { recursive: true });
    } catch {
      /* best-effort */
    }
  });

  it("saveUndoState creates an undo file", async () => {
    const { cwd, undoDir } = freshCwd();
    const filePath = await writeTestFile(cwd, "test1.ts", "const x = 1;");
    await saveUndoState(cwd, filePath, "const x = 1;", 1);

    const count = await undoFileCount(undoDir);
    assert.equal(count, 1, "should create exactly one undo file");
  });

  it("saveUndoState stores valid JSON with all fields", async () => {
    const { cwd, undoDir } = freshCwd();
    const filePath = await writeTestFile(cwd, "test2.ts", "const y = 2;");
    await saveUndoState(cwd, filePath, "const y = 2;", 2, ["myFunction"]);

    const files = await fsReaddir(undoDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    assert.equal(jsonFiles.length, 1);

    // Read the undo file
    const raw = await fsReadFile(join(undoDir, jsonFiles[0]), "utf-8");
    const entry = JSON.parse(raw);

    assert.equal(entry.path, filePath);
    assert.equal(entry.editCount, 2);
    assert.deepEqual(entry.changedSymbols, ["myFunction"]);
    assert.ok(typeof entry.timestamp === "string");
    assert.ok(entry.timestamp.length > 0);
    assert.ok(typeof entry.snapshotHash === "string");
    assert.equal(entry.snapshotHash.length, 16);

    // Verify base64 encoding is valid and decodes to original content
    const decoded = Buffer.from(entry.originalContent, "base64").toString("utf-8");
    assert.equal(decoded, "const y = 2;");
  });

  it("saveUndoState is fire-and-forget (never throws)", async () => {
    const { cwd } = freshCwd();
    // Should not throw even with invalid args
    await saveUndoState(cwd as unknown as string, "", "", -1);
    // If we got here without throwing, the test passes
    assert.ok(true);
  });

  it("restoreUndoState restores original content", async () => {
    const { cwd } = freshCwd();
    const filePath = await writeTestFile(cwd, "test3.ts", "original content");
    await saveUndoState(cwd, filePath, "original content", 1);

    // Overwrite the file
    await fsWriteFile(filePath, "modified content", "utf-8");
    const afterMod = await fsReadFile(filePath, "utf-8");
    assert.equal(afterMod, "modified content");

    // Restore
    const restored = await restoreUndoState(cwd, filePath);
    assert.equal(restored, true, "restore should succeed");

    const afterRestore = await fsReadFile(filePath, "utf-8");
    assert.equal(afterRestore, "original content");
  });

  it("restoreUndoState returns false for nonexistent file", async () => {
    const { cwd } = freshCwd();
    const result = await restoreUndoState(cwd, "/nonexistent/path.ts");
    assert.equal(result, false);
  });

  it("restoreUndoState deletes the undo file after successful restore", async () => {
    const { cwd, undoDir } = freshCwd();
    const filePath = await writeTestFile(cwd, "test4.ts", "content to restore");
    await saveUndoState(cwd, filePath, "content to restore", 1);

    const countBefore = await undoFileCount(undoDir);

    // Overwrite and restore
    await fsWriteFile(filePath, "different content", "utf-8");
    await restoreUndoState(cwd, filePath);

    const countAfter = await undoFileCount(undoDir);
    assert.equal(countAfter, countBefore - 1, "undo file should be deleted after restore");
  });

  it("getUndoHistory returns all entries sorted by timestamp descending", async () => {
    const { cwd } = freshCwd();
    const filePath1 = await writeTestFile(cwd, "early.ts", "v1");
    await saveUndoState(cwd, filePath1, "v1", 1);

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));

    const filePath2 = await writeTestFile(cwd, "late.ts", "v2");
    await saveUndoState(cwd, filePath2, "v2", 1);

    const allEntries = await getUndoHistory(cwd);
    assert.equal(allEntries.length, 2);

    // Verify descending order (most recent first)
    assert.equal(allEntries[0].path, filePath2);
    assert.equal(allEntries[1].path, filePath1);
  });

  it("getUndoHistory filters by file path", async () => {
    const { cwd } = freshCwd();
    const fileA = await writeTestFile(cwd, "filterA.ts", "content A");
    const fileB = await writeTestFile(cwd, "filterB.ts", "content B");

    await saveUndoState(cwd, fileA, "content A", 1);
    await saveUndoState(cwd, fileB, "content B", 1);

    const aEntries = await getUndoHistory(cwd, fileA);
    assert.equal(aEntries.length, 1);
    assert.equal(aEntries[0].path, fileA);

    const bEntries = await getUndoHistory(cwd, fileB);
    assert.equal(bEntries.length, 1);
    assert.equal(bEntries[0].path, fileB);
  });

  it("restoreUndoState uses most recent entry", async () => {
    const { cwd, undoDir } = freshCwd();
    const filePath = await writeTestFile(cwd, "test7.ts", "original");

    // Save two undo entries for the same file
    await saveUndoState(cwd, filePath, "original", 1);
    await new Promise((r) => setTimeout(r, 10)); // ensure different timestamp
    await saveUndoState(cwd, filePath, "original", 1);

    // Overwrite
    await fsWriteFile(filePath, "modified", "utf-8");

    // Restore — should use the most recent
    const restored = await restoreUndoState(cwd, filePath);
    assert.equal(restored, true);

    // Only the most recent undo file should be consumed; the older one remains
    const count = await undoFileCount(undoDir);
    assert.equal(count, 1, "one undo file should remain (the older entry)");
  });

  it("restoreUndoState verifies snapshot hash", async () => {
    const { cwd, undoDir } = freshCwd();
    const filePath = await writeTestFile(cwd, "test8.ts", "hash check content");

    // Manually create a corrupt undo entry with wrong hash
    await fsMkdir(undoDir, { recursive: true });
    const corruptEntry = JSON.stringify({
      path: filePath,
      originalContent: Buffer.from("wrong content", "utf-8").toString("base64"),
      timestamp: new Date().toISOString(),
      editCount: 1,
      snapshotHash: "0000000000000000", // Wrong hash
      changedSymbols: [],
    });
    const filename = `corrupt-${Date.now()}.json`;
    await fsWriteFile(join(undoDir, filename), corruptEntry, "utf-8");

    // Restore should fail due to hash mismatch
    const result = await restoreUndoState(cwd, filePath);
    assert.equal(result, false);
  });

  it("clearUndoHistory removes all undo files and directory", async () => {
    const { cwd, undoDir } = freshCwd();
    const filePath = await writeTestFile(cwd, "test9.ts", "clear test");
    await saveUndoState(cwd, filePath, "clear test", 1);

    assert.ok((await undoFileCount(undoDir)) >= 1);

    await clearUndoHistory(cwd);

    assert.equal(await undoFileCount(undoDir), 0);

    // Directory should not exist
    try {
      await fsStat(undoDir);
      assert.fail("undo directory should not exist after clear");
    } catch (err) {
      assert.ok((err as NodeJS.ErrnoException).code === "ENOENT");
    }
  });

  it("getUndoHistory returns decoded originalContent", async () => {
    const { cwd } = freshCwd();
    const filePath = await writeTestFile(cwd, "test10.ts", "decoded content check");

    // Content with newlines and unicode
    const multiLineContent = "line1\nline2\nline3\n// unicode: ✓";
    await saveUndoState(cwd, filePath, multiLineContent, 1);

    const entries = await getUndoHistory(cwd, filePath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].originalContent, multiLineContent);
  });

  it("saveUndoState creates undo directory if it doesn't exist", async () => {
    const { cwd, undoDir } = freshCwd();
    const filePath = await writeTestFile(cwd, "nested.ts", "nested file");

    // saveUndoState should create .smart-edit-undo/ under cwd
    await saveUndoState(cwd, filePath, "nested file", 1);

    const count = await undoFileCount(undoDir);
    assert.equal(count, 1, "undo directory should have been auto-created");
  });

  it("handles multiple saves to different files", async () => {
    const { cwd } = freshCwd();
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      const fp = await writeTestFile(cwd, `multi_${i}.ts`, `content_${i}`);
      files.push(fp);
      await saveUndoState(cwd, fp, `content_${i}`, 1);
    }

    const allEntries = await getUndoHistory(cwd);
    assert.equal(allEntries.length, 5);

    // Each entry should have the correct path
    const paths = allEntries.map((e) => e.path);
    for (const fp of files) {
      assert.ok(paths.includes(fp), `should have entry for ${fp}`);
    }
  });
});
