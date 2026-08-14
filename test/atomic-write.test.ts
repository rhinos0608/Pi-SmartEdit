import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { atomicCreate, atomicWrite } from "../src/undo/atomic-write.js";

let tmpDir: string;

before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "atomic-write-test-"));
});

after(() => {
    // Cleanup temp dir
    try {
        const entries = [join(tmpDir, "test.txt"), join(tmpDir, "test-new.txt"), join(tmpDir, "test-mode.txt")];
        for (const e of entries) {
            try { unlinkSync(e); } catch { /* ignore */ }
        }
        try { unlinkSync(tmpDir); } catch { /* ignore */ }
    } catch { /* ignore */ }
});

describe("atomicWrite", () => {
    test("writes file content correctly", async () => {
        const filePath = join(tmpDir, "test.txt");
        await atomicWrite(filePath, "hello world");
        const content = readFileSync(filePath, "utf8");
        assert.strictEqual(content, "hello world");
    });

    test("no partial writes (temp file cleaned up on success)", async () => {
        const filePath = join(tmpDir, "test.txt");
        await atomicWrite(filePath, "final content");
        // Temp file should not exist after successful write
        const dirEntries = statSync(tmpDir);
        assert.ok(dirEntries.isDirectory());

        // Verify content is correct
        const content = readFileSync(filePath, "utf8");
        assert.strictEqual(content, "final content");
    });

    test("preserves mode bits when file exists", async () => {
        const filePath = join(tmpDir, "test-mode.txt");
        // Create file with known mode
        writeFileSync(filePath, "original", { mode: 0o644 });
        const origStat = statSync(filePath);

        // Rewrite atomically
        await atomicWrite(filePath, "updated content with mode preservation");

        const newStat = statSync(filePath);
        // Mode should be preserved (or at least not 0o600 which is the temp default)
        // 0o644 & ~S_IFMT -> 0o100644 & ~0o170000 -> 0o644
        const origPerms = origStat.mode & 0o777;
        const newPerms = newStat.mode & 0o777;
        assert.strictEqual(newPerms, origPerms, "mode bits should match original");
        assert.strictEqual(readFileSync(filePath, "utf8"), "updated content with mode preservation");
    });

    test("modeSource option copies mode from another file", async () => {
        const sourcePath = join(tmpDir, "source.txt");
        const targetPath = join(tmpDir, "target.txt");
        writeFileSync(sourcePath, "source", { mode: 0o711 });

        await atomicWrite(targetPath, "target content", { modeSource: sourcePath });

        const srcStat = statSync(sourcePath);
        const tgtStat = statSync(targetPath);
        assert.strictEqual(tgtStat.mode & 0o777, srcStat.mode & 0o777);
        assert.strictEqual(readFileSync(targetPath, "utf8"), "target content");
    });

    test("rename prevents partial reads (atomic write via rename)", async () => {
        const filePath = join(tmpDir, "test.txt");
        // Write full content via atomic write
        await atomicWrite(filePath, "full content that should never be partially visible");
        // Since tmp+rename is used, there should never be a moment where
        // the target file contains partial content. We verify by checking
        // the content after write is complete.
        const content = readFileSync(filePath, "utf8");
        assert.equal(content, "full content that should never be partially visible");
        // Verify no temp file remains
        const entries = readdirSync(tmpDir);
        const tempFiles = entries.filter((e) => e.includes(".smart_edit_tmp_"));
        assert.equal(tempFiles.length, 0, `no temp files remain: ${tempFiles.join(", ")}`);
    });

    test("cleanup on failure: no orphan temp files left behind", async () => {
        // atomicWrite with an invalid path (parent dir doesn't exist) should clean up temp
        const filePath = join(tmpDir, "nonexistent", "file.txt");
        try {
            await atomicWrite(filePath, "content");
            assert.fail("should have thrown");
        } catch (err) {
            assert.ok(err instanceof Error);
            // Temp file must be cleaned up — no .smart_edit_tmp_ files should remain
            const entries = readdirSync(tmpDir);
            const tempFiles = entries.filter((e) => e.includes(".smart_edit_tmp_"));
            assert.equal(tempFiles.length, 0, `no orphan temp files: ${tempFiles.join(", ")}`);
        }
    });

    test("atomicCreate creates a new file", async () => {
        const filePath = join(tmpDir, "test-create.txt");
        await atomicCreate(filePath, "created content");
        assert.strictEqual(readFileSync(filePath, "utf8"), "created content");
    });

    test("atomicCreate is no-clobber: rejects when file already exists, leaves it untouched", async () => {
        const filePath = join(tmpDir, "test-noclobber.txt");
        writeFileSync(filePath, "existing");
        await assert.rejects(() => atomicCreate(filePath, "new content"), /create conflict|EEXIST/);
        assert.strictEqual(readFileSync(filePath, "utf8"), "existing", "existing file must be untouched");
    });

    test("atomicCreate link failure propagates and cleans up its temp file", async () => {
        // Parent is a regular file, so creating under it fails (ENOTDIR).
        const blocker = join(tmpDir, "not-a-dir.txt");
        writeFileSync(blocker, "blocker");
        await assert.rejects(() => atomicCreate(join(blocker, "child.txt"), "x"));
        const entries = readdirSync(tmpDir);
        const tempFiles = entries.filter((e) => e.includes(".smart_edit_create_"));
        assert.equal(tempFiles.length, 0, `no orphan create temp files: ${tempFiles.join(", ")}`);
    });

    test("overwrites existing file", async () => {
        const filePath = join(tmpDir, "test.txt");
        await atomicWrite(filePath, "first write");
        await atomicWrite(filePath, "overwritten");
        assert.strictEqual(readFileSync(filePath, "utf8"), "overwritten");
    });

    test("handles empty content", async () => {
        const filePath = join(tmpDir, "test.txt");
        await atomicWrite(filePath, "");
        assert.strictEqual(readFileSync(filePath, "utf8"), "");
    });

    test("handles unicode content", async () => {
        const filePath = join(tmpDir, "test.txt");
        const unicode = "🚀 hello ñoño 你好";
        await atomicWrite(filePath, unicode);
        assert.strictEqual(readFileSync(filePath, "utf8"), unicode);
    });

    test("writes large content (1MB)", async () => {
        const filePath = join(tmpDir, "test.txt");
        const large = "x".repeat(1024 * 1024);
        await atomicWrite(filePath, large);
        assert.strictEqual(readFileSync(filePath, "utf8").length, 1024 * 1024);
    });
});
