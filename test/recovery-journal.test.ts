import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPersistentSpawnTarget } from "../src/lsp/spawn-utils.js";
import { EditTransaction } from "../src/mutation/edit-transaction.js";
import {
    appendIntent,
    buildJournalRecord,
    deleteJournal,
    journalDir,
    markCommitted,
    readJournal,
    recoverStaleJournals,
    writePreparedJournal,
} from "../src/mutation/recovery-journal.js";

const tempDirs = new Set<string>();
async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.add(dir);
    return dir;
}
after(async () => {
    await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
});

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const CHILD = join(process.cwd(), "test", "fixtures", "recovery-crash-child.ts");

async function waitForFile(path: string, label: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
        try {
            await readFile(path);
            return;
        } catch {
            if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
            await new Promise((r) => setTimeout(r, 25));
        }
    }
}

function kill9(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
        child.on("exit", () => { resolve(); });
        try { child.kill("SIGKILL"); } catch { resolve(); }
        setTimeout(() => { resolve(); }, 5000);
    });
}

function pidDead(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return false;
    } catch {
        return true;
    }
}

/**
 * tsx spawns a grandchild node process (the real journal owner). Killing the
 * wrapper orphans it, leaving the owner PID alive and recovery correctly
 * skipping. Read owner PIDs from the journal dir and SIGKILL them too.
 */
async function killTree(child: ChildProcess, jdir: string): Promise<void> {
    await kill9(child);
    const owners: number[] = [];
    try {
        const files = await readdir(jdir);
        for (const f of files) {
            if (!f.endsWith(".json")) continue;
            try {
                const parsed = JSON.parse(await readFile(join(jdir, f), "utf8")) as { ownerPid?: number };
                if (typeof parsed.ownerPid === "number") owners.push(parsed.ownerPid);
            } catch {}
        }
    } catch {}
    for (const pid of owners) {
        try { process.kill(pid, "SIGKILL"); } catch {}
    }
    const deadline = Date.now() + 10_000;
    while (owners.some((p) => !pidDead(p))) {
        if (Date.now() > deadline) throw new Error("timed out waiting for crash-child tree death");
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** Spawn a crash child with an isolated journal dir; returns child + journal dir. */
async function spawnCrash(scenario: string, workDir: string): Promise<{ child: ChildProcess; sentinel: string; jdir: string }> {
    const jdir = await makeTempDir("smartedit-recovery-");
    const sentinel = join(workDir, `${scenario}.sentinel`);
    // npm's .bin/tsx is a POSIX shim: raw-spawning it fails ENOENT on
    // Windows, and raw-spawning tsx.cmd trips the CVE-2024-27980 EINVAL
    // guard. Route through the repo's batch-file gate (cmd.exe + proper
    // escaping); POSIX passes through unchanged.
    const tsxCommand = process.platform === "win32" ? `${TSX}.cmd` : TSX;
    const target = buildPersistentSpawnTarget(tsxCommand, [CHILD, scenario, workDir, sentinel]);
    const child = spawn(target.command, target.args, {
        env: { ...process.env, PI_SMARTEDIT_RECOVERY_DIR: jdir },
        stdio: ["ignore", "pipe", "pipe"],
        ...(target.windowsVerbatimArguments !== undefined
            ? { windowsVerbatimArguments: target.windowsVerbatimArguments }
            : {}),
    });
    return { child, sentinel, jdir };
}

async function withJournalEnv<T>(jdir: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.PI_SMARTEDIT_RECOVERY_DIR;
    process.env.PI_SMARTEDIT_RECOVERY_DIR = jdir;
    try {
        return await fn();
    } finally {
        if (prev === undefined) delete process.env.PI_SMARTEDIT_RECOVERY_DIR;
        else process.env.PI_SMARTEDIT_RECOVERY_DIR = prev;
    }
}

test("kill after 1st of 2 writes: 1st recovered, journal removed", async () => {
    const work = await makeTempDir("rec-w1-");
    await writeFile(join(work, "a.txt"), "A-ORIG");
    await writeFile(join(work, "b.txt"), "B-ORIG");
    const { child, sentinel, jdir } = await spawnCrash("kill-after-first-write", work);
    try {
        await waitForFile(sentinel, "child first write");
        await killTree(child, jdir);
        const report = await withJournalEnv(jdir, () => recoverStaleJournals());
        assert.equal(await readFile(join(work, "a.txt"), "utf8"), "A-ORIG");
        assert.equal(await readFile(join(work, "b.txt"), "utf8"), "B-ORIG");
        assert.ok(report.recovered.some((p) => p.endsWith("a.txt")));
        assert.deepEqual(report.conflicts, []);
        assert.equal((await withJournalEnv(jdir, async () => readdir(journalDir()))).length, 0);
    } finally {
        try { child.kill("SIGKILL"); } catch {}
    }
});

test("create + kill: created file removed", async () => {
    const work = await makeTempDir("rec-c1-");
    const { child, sentinel, jdir } = await spawnCrash("kill-after-create", work);
    try {
        await waitForFile(sentinel, "child create");
        await killTree(child, jdir);
        const report = await withJournalEnv(jdir, () => recoverStaleJournals());
        await assert.rejects(() => readFile(join(work, "b.txt"), "utf8"), /ENOENT/);
        assert.ok(report.recovered.some((p) => p.endsWith("b.txt")));
    } finally {
        try { child.kill("SIGKILL"); } catch {}
    }
});

test("delete + kill: deleted file restored", async () => {
    const work = await makeTempDir("rec-d1-");
    await writeFile(join(work, "a.txt"), "A-ORIG");
    const { child, sentinel, jdir } = await spawnCrash("kill-after-remove", work);
    try {
        await waitForFile(sentinel, "child remove");
        await killTree(child, jdir);
        await withJournalEnv(jdir, () => recoverStaleJournals());
        assert.equal(await readFile(join(work, "a.txt"), "utf8"), "A-ORIG");
    } finally {
        try { child.kill("SIGKILL"); } catch {}
    }
});

test("rename link/remove interleave + kill: both sides restored", async () => {
    const work = await makeTempDir("rec-r1-");
    await writeFile(join(work, "a.txt"), "A-ORIG");
    const { child, sentinel, jdir } = await spawnCrash("kill-after-rename", work);
    try {
        await waitForFile(sentinel, "child rename");
        await killTree(child, jdir);
        const report = await withJournalEnv(jdir, () => recoverStaleJournals());
        assert.equal(await readFile(join(work, "a.txt"), "utf8"), "A-ORIG");
        await assert.rejects(() => readFile(join(work, "b.txt"), "utf8"), /ENOENT/);
        assert.deepEqual(report.conflicts, []);
    } finally {
        try { child.kill("SIGKILL"); } catch {}
    }
});

test("exec mode + kill: fs write rolled back, journal cleared", async () => {
    const work = await makeTempDir("rec-e1-");
    await writeFile(join(work, "a.txt"), "A-ORIG");
    const { child, sentinel, jdir } = await spawnCrash("kill-after-exec", work);
    try {
        await waitForFile(sentinel, "child exec write");
        await killTree(child, jdir);
        await withJournalEnv(jdir, () => recoverStaleJournals());
        assert.equal(await readFile(join(work, "a.txt"), "utf8"), "A-ORIG");
        assert.equal((await withJournalEnv(jdir, async () => readdir(journalDir()))).length, 0);
    } finally {
        try { child.kill("SIGKILL"); } catch {}
    }
});

test("committed-not-deleted: disk preserved, journal removed", async () => {
    const work = await makeTempDir("rec-cnd-");
    await writeFile(join(work, "a.txt"), "A-ORIG");
    const { child, sentinel, jdir } = await spawnCrash("committed-not-deleted", work);
    await new Promise<void>((resolve, reject) => {
        child.on("exit", (code) => { if (code === 0) { resolve(); } else { reject(new Error(`child exit ${code}`)); } });;
        child.on("error", reject);
    });
    await waitForFile(sentinel, "child commit");
    const report = await withJournalEnv(jdir, () => recoverStaleJournals());
    assert.equal(await readFile(join(work, "a.txt"), "utf8"), "A-DONE");
    assert.ok(report.preserved.length === 1);
    assert.deepEqual(report.recovered, []);
    assert.equal((await withJournalEnv(jdir, async () => readdir(journalDir()))).length, 0);
});

test("third-party drift after crash: never overwritten, quarantined + conflict", async () => {
    const work = await makeTempDir("rec-drift-");
    await writeFile(join(work, "a.txt"), "A-ORIG");
    const { child, sentinel, jdir } = await spawnCrash("kill-after-first-write", work);
    try {
        await waitForFile(sentinel, "child first write");
        await killTree(child, jdir);
        // Third party overwrites AFTER the crash with unrelated bytes.
        await writeFile(join(work, "a.txt"), "THIRD-PARTY");
        const report = await withJournalEnv(jdir, () => recoverStaleJournals());
        assert.equal(await readFile(join(work, "a.txt"), "utf8"), "THIRD-PARTY");
        assert.equal(report.conflicts.length, 1);
        assert.ok(report.conflicts[0].path.endsWith("a.txt"));
        assert.ok(report.conflicts[0].quarantinePath);
        assert.equal(await readFile(report.conflicts[0].quarantinePath!, "utf8"), "THIRD-PARTY");
    } finally {
        try { child.kill("SIGKILL"); } catch {}
    }
});

test("prepare-fail blocks mutation: no write lands, live tx untouched", async () => {
    const work = await makeTempDir("rec-pf-");
    const target = join(work, "a.txt");
    await writeFile(target, "A-ORIG");
    // Unmakable journal location: a FILE where the recovery dir should be.
    const blocker = join(work, "blocker");
    await writeFile(blocker, "x");
    const prev = process.env.PI_SMARTEDIT_RECOVERY_DIR;
    process.env.PI_SMARTEDIT_RECOVERY_DIR = join(blocker, "recovery");
    try {
        // Mirrors runner order: prepare BEFORE first mutation. Prepare must throw.
        const tx = await EditTransaction.begin([target]);
        const snap = tx.getSnapshot(target);
        await assert.rejects(
            () => writePreparedJournal(buildJournalRecord(tx.transactionId, [{ path: target, exists: snap?.exists ?? false, content: snap?.content, mode: snap?.mode }])),
            /ENOTDIR|ENOENT|EACCES|EPERM/,
        );
        // Runner contract: on prepare failure the tx rolls back with zero mutations.
        await tx.rollback();
        assert.equal(tx.getSnapshot(target)?.content?.toString(), "A-ORIG");
        assert.equal(await readFile(target, "utf8"), "A-ORIG");
        assert.deepEqual((await readJournal(tx.transactionId)) as unknown, null);
    } finally {
        if (prev === undefined) delete process.env.PI_SMARTEDIT_RECOVERY_DIR;
        else process.env.PI_SMARTEDIT_RECOVERY_DIR = prev;
    }
});

test("per-mutation intent failure blocks the fs op", async () => {
    const work = await makeTempDir("rec-int-");
    const target = join(work, "a.txt");
    await writeFile(target, "A-ORIG");
    const jdir = await makeTempDir("smartedit-recovery-");
    await withJournalEnv(jdir, async () => {
        const tx = await EditTransaction.begin([target]);
        try {
            const snap = tx.getSnapshot(target);
            await writePreparedJournal(buildJournalRecord(tx.transactionId, [{ path: target, exists: true, content: snap?.content, mode: snap?.mode }]));
            // Journal deleted out from under the tx (disk full / operator rm):
            // the intent write must throw BEFORE the fs op runs.
            await deleteJournal(tx.transactionId);
            await assert.rejects(() => appendIntent(tx.transactionId, { op: "write", paths: [target] }), /missing/);
            assert.equal(await readFile(target, "utf8"), "A-ORIG");
        } finally {
            await tx.rollback().catch(() => {});
        }
    });
});

test("recovery is idempotent: second run is a no-op", async () => {
    const work = await makeTempDir("rec-idem-");
    await writeFile(join(work, "a.txt"), "A-ORIG");
    const { child, sentinel, jdir } = await spawnCrash("kill-after-first-write", work);
    try {
        await waitForFile(sentinel, "child first write");
        await killTree(child, jdir);
        const first = await withJournalEnv(jdir, () => recoverStaleJournals());
        assert.ok(first.recovered.length > 0);
        const second = await withJournalEnv(jdir, () => recoverStaleJournals());
        assert.deepEqual(second.recovered, []);
        assert.deepEqual(second.conflicts, []);
        assert.deepEqual(second.preserved, []);
        assert.equal(await readFile(join(work, "a.txt"), "utf8"), "A-ORIG");
    } finally {
        try { child.kill("SIGKILL"); } catch {}
    }
});

test("stale lock + recovery: new tx acquires promptly and restores", async () => {
    const work = await makeTempDir("rec-lock-");
    await writeFile(join(work, "a.txt"), "A-ORIG");
    await writeFile(join(work, "b.txt"), "B-ORIG");
    const { child, sentinel, jdir } = await spawnCrash("stale-lock-holder", work);
    try {
        await waitForFile(sentinel, "child lock hold");
        await killTree(child, jdir);
        // Lock files reference a dead PID: reclaim must be fast, not 30s.
        const started = Date.now();
        const tx = await EditTransaction.begin([join(work, "a.txt"), join(work, "b.txt")]);
        assert.ok(Date.now() - started < 15_000, "lock reclaim took too long");
        await tx.rollback().catch(() => {});
        const report = await withJournalEnv(jdir, () => recoverStaleJournals());
        assert.deepEqual(report.conflicts, []);
        assert.equal((await withJournalEnv(jdir, async () => readdir(journalDir()))).length, 0);
    } finally {
        try { child.kill("SIGKILL"); } catch {}
    }
});

test("out-of-workspace target recovered: no mutation-containment rule", async () => {
    // Journal + work live in unrelated tmp dirs (neither is the repo cwd).
    const work = await makeTempDir("rec-xrepo-");
    assert.ok(!work.startsWith(process.cwd()));
    await writeFile(join(work, "a.txt"), "A-ORIG");
    const { child, sentinel, jdir } = await spawnCrash("kill-after-first-write", work);
    try {
        await waitForFile(sentinel, "child first write");
        await killTree(child, jdir);
        await withJournalEnv(jdir, () => recoverStaleJournals());
        assert.equal(await readFile(join(work, "a.txt"), "utf8"), "A-ORIG");
    } finally {
        try { child.kill("SIGKILL"); } catch {}
    }
});

test("committed journal round-trips state; live-PID journals are skipped", async () => {
    const jdir = await makeTempDir("smartedit-recovery-");
    await withJournalEnv(jdir, async () => {
        const txId = "live-journal-skip";
        await writePreparedJournal({
            transactionId: txId,
            ownerPid: process.pid, // live: recovery must skip
            createdAt: new Date().toISOString(),
            state: "prepared",
            preimages: [],
            intents: [],
        });
        assert.equal((await readJournal(txId))?.state, "prepared");
        await markCommitted(txId);
        assert.equal((await readJournal(txId))?.state, "committed");
        const report = await recoverStaleJournals();
        assert.deepEqual(report.preserved, []);
        assert.notEqual(await readJournal(txId), null); // untouched
        await deleteJournal(txId);
    });
});

test("malformed journal skipped: scan recovers valid records", async () => {
    const work = await makeTempDir("rec-malformed-");
    const target = join(work, "a.txt");
    await writeFile(target, "A-ORIG");
    const jdir = await makeTempDir("smartedit-recovery-");
    const deadPid = 2 ** 30; // no such process: journal reads as stale
    await withJournalEnv(jdir, async () => {
        // Valid stale journal: must still recover.
        const valid = buildJournalRecord("good-tx", [{ path: target, exists: true, content: Buffer.from("A-ORIG") }]);
        valid.ownerPid = deadPid;
        await writePreparedJournal(valid);
        await writeFile(target, "A-PARTIAL"); // simulate crash mid-write
        // Malformed: syntactically valid JSON, missing preimages entirely.
        await writeFile(join(jdir, "bad-missing-preimages.json"), JSON.stringify({
            transactionId: "bad-missing-preimages", ownerPid: deadPid, state: "prepared", intents: [],
        }));
        // Malformed: preimages present but not an array.
        await writeFile(join(jdir, "bad-preimages-string.json"), JSON.stringify({
            transactionId: "bad-preimages-string", ownerPid: deadPid, state: "prepared", preimages: "oops", intents: [],
        }));
        const report = await recoverStaleJournals();
        assert.equal(await readFile(target, "utf8"), "A-ORIG");
        assert.ok(report.recovered.some((p) => p.endsWith("a.txt")));
        assert.ok(report.removed.includes("good-tx"));
        // Bad records skipped, left on disk for operator inspection.
        assert.equal(await readFile(join(jdir, "bad-missing-preimages.json"), "utf8").then(() => true), true);
        assert.equal(await readFile(join(jdir, "bad-preimages-string.json"), "utf8").then(() => true), true);
        assert.equal(report.scanned, 3);
    });
});

test("journal write creates a missing nested recovery dir", async () => {
    // Guards the parent-dir derivation inside the durable writer: the
    // journal directory may not exist yet and must be created recursively.
    const base = await makeTempDir("smartedit-recovery-");
    const nested = join(base, "no", "such", "dir", "yet");
    await withJournalEnv(nested, async () => {
        const txId = "nested-dir-roundtrip";
        await writePreparedJournal({
            transactionId: txId,
            ownerPid: process.pid,
            createdAt: new Date().toISOString(),
            state: "prepared",
            preimages: [],
            intents: [],
        });
        assert.equal((await readJournal(txId))?.state, "prepared");
        await deleteJournal(txId);
    });
});
