/**
 * Crash-recovery journal — correctness feature, NOT an LSP gate.
 *
 * A crash (SIGKILL, power loss) between mutations leaves partial writes on
 * disk with no live transaction to roll them back. This module keeps a small
 * per-transaction journal at a per-user persistent directory
 * (`~/.pi/smart-edit/recovery/`, surviving restarts) so the next transaction
 * can finish the interrupted one's cleanup before starting new mutations.
 *
 * Ordering (see runPatchTransaction wiring):
 *   locks -> snapshot -> write PREPARED durably -> per-mutation
 *   (intent durable, then fs op) -> capture undo -> mark COMMITTED ->
 *   release locks -> delete journal -> persist undo (advisory).
 * A prepare failure fails the transaction before the first mutation.
 *
 * Recovery (before new mutations): scan journals whose owner PID is dead,
 * reacquire locks sorted, then per preimage compare disk against preimage vs
 * expected post (from intents). Third-party drift (matches neither) is NEVER
 * overwritten: the current bytes are quarantined and a conflict is reported.
 * A committed-not-deleted journal means the writes were durable: preserve
 * disk, just remove the journal. Recovery is idempotent.
 *
 * No mutation-containment rule here: a journal may name paths in any repo;
 * recovery restores whatever the preimage records.
 */
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";

export type JournalState = "prepared" | "committed";

export interface JournalPreimage {
    path: string;
    existed: boolean;
    /** Base64 of exact pre-transaction bytes (when existed). */
    contentBase64?: string;
    mode?: number;
    /** sha256 hex of pre-transaction bytes ("" when absent). */
    beforeSha: string;
}

export interface JournalIntent {
    op: string;
    paths: string[];
    /** sha256 hex the mutation intended to leave at paths[0]; null when it should be absent. */
    expectedPostSha?: string | null;
    expectedExists?: boolean;
}

export interface RecoveryJournal {
    transactionId: string;
    ownerPid: number;
    createdAt: string;
    state: JournalState;
    preimages: JournalPreimage[];
    intents: JournalIntent[];
}

export interface RecoveryReport {
    scanned: number;
    recovered: string[];
    preserved: string[];
    conflicts: Array<{ transactionId: string; path: string; quarantinePath?: string }>;
    removed: string[];
}

export function sha256Hex(data: Buffer | string): string {
    return createHash("sha256").update(data).digest("hex");
}

/** Per-user persistent journal dir. Survivies restart by design. */
export function journalDir(): string {
    const override = process.env.PI_SMARTEDIT_RECOVERY_DIR;
    if (override && override.length > 0) return override;
    return join(homedir(), ".pi", "smart-edit", "recovery");
}

export function journalPath(transactionId: string): string {
    return join(journalDir(), `${transactionId}.json`);
}

/** Durable write: content + fsync before close so PREPARED survives a kill. */
async function durableWriteJson(path: string, value: unknown): Promise<void> {
    await mkdir(journalDir(), { recursive: true }).catch(() => {});
    // dirname(), not a "/" split: journal paths carry the platform
    // separator ("\" on Windows), where lastIndexOf("/") misses.
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    const handle = await open(tmp, "w");
    try {
        await handle.writeFile(JSON.stringify(value));
        // Best-effort: file fsync is unreliable on some Windows setups
        // (EPERM from filter drivers), and a sync-only failure must not fail
        // the edit — content is written regardless. Genuine write errors
        // (open/write/rename) still throw. Dir fsync below is likewise lax.
        await handle.sync().catch(() => {});
    } finally {
        await handle.close().catch(() => {});
    }
    await rename(tmp, path);
    // Directory fsync is best-effort by design (the open above already
    // tolerates failure): on Windows an opened directory handle's sync()
    // throws EPERM, which must degrade durability, never fail the edit.
    const dirHandle = await open(dir, "r").catch(() => null);
    if (dirHandle) {
        try { await dirHandle.sync().catch(() => {}); } finally { await dirHandle.close().catch(() => {}); }
    }
}

export async function readJournal(transactionId: string): Promise<RecoveryJournal | null> {
    try {
        return JSON.parse(await readFile(journalPath(transactionId), "utf8")) as RecoveryJournal;
    } catch {
        return null;
    }
}

export async function writePreparedJournal(journal: RecoveryJournal): Promise<void> {
    await durableWriteJson(journalPath(journal.transactionId), { ...journal, state: "prepared" satisfies JournalState });
}

/** Append one intent durably (read-modify-write under no lock; single writer = owner). */
export async function appendIntent(transactionId: string, intent: JournalIntent): Promise<void> {
    const existing = await readJournal(transactionId);
    if (!existing) throw new Error(`recovery journal missing for ${transactionId}`);
    existing.intents.push(intent);
    await durableWriteJson(journalPath(transactionId), existing);
}

export async function markCommitted(transactionId: string): Promise<void> {
    const existing = await readJournal(transactionId);
    if (!existing) throw new Error(`recovery journal missing for ${transactionId}`);
    existing.state = "committed";
    await durableWriteJson(journalPath(transactionId), existing);
}

export async function deleteJournal(transactionId: string): Promise<void> {
    await rm(journalPath(transactionId), { force: true }).catch(() => {});
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Same lock-file scheme as EditTransaction (O_EXCL in per-user temp dir). */
const LOCK_DIR = join(tmpdir(), "pi-smartedit-locks");
function lockFilePath(key: string): string {
    return join(LOCK_DIR, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.lock`);
}

async function acquireRecoveryLocks(paths: string[]): Promise<() => Promise<void>> {
    await mkdir(LOCK_DIR, { recursive: true });
    const keys = [...new Set(paths.map((p) => resolve(p)))].sort();
    const releases: Array<() => Promise<void>> = [];
    const deadline = Date.now() + 30_000;
    for (const key of keys) {
        const lockPath = lockFilePath(key);
        for (;;) {
            let handle: Awaited<ReturnType<typeof open>> | undefined;
            try {
                handle = await open(lockPath, "wx");
                await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
                const h = handle;
                releases.push(async () => {
                    await h.close().catch(() => {});
                    await rm(lockPath, { force: true }).catch(() => {});
                });
                break;
            } catch (err) {
                if (handle) await handle.close().catch(() => {});
                if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
                // Reclaim only dead-owner locks; live owners are never stolen.
                let reclaim = false;
                try {
                    const info = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number };
                    if (typeof info.pid === "number" && !isProcessAlive(info.pid)) reclaim = true;
                } catch { reclaim = false; }
                if (reclaim) {
                    await rm(lockPath, { force: true }).catch(() => {});
                    continue;
                }
                if (Date.now() > deadline) throw new Error(`timed out acquiring recovery lock for ${key}`);
                await new Promise((r) => setTimeout(r, 25));
            }
        }
    }
    return async () => {
        for (const r of releases.reverse()) await r();
    };
}

async function readDisk(path: string): Promise<{ exists: boolean; sha: string }> {
    try {
        const buf = await readFile(path);
        return { exists: true, sha: sha256Hex(buf) };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, sha: "" };
        throw err;
    }
}

function expectedPostFor(intents: JournalIntent[], path: string): { known: boolean; sha: string | null; exists: boolean } {
    for (let i = intents.length - 1; i >= 0; i--) {
        const intent = intents[i];
        if (intent.paths.includes(path)) {
            return {
                known: intent.expectedPostSha !== undefined || intent.expectedExists !== undefined,
                sha: intent.expectedPostSha ?? null,
                exists: intent.expectedExists ?? (intent.expectedPostSha != null),
            };
        }
    }
    return { known: false, sha: null, exists: false };
}

async function restorePreimage(pre: JournalPreimage): Promise<void> {
    if (pre.existed) {
        const buf = Buffer.from(pre.contentBase64 ?? "", "base64");
        const { chmod } = await import("node:fs/promises");
        const { atomicWrite } = await import("../undo/atomic-write.js");
        await atomicWrite(pre.path, buf, { mode: pre.mode });
        if (pre.mode !== undefined) await chmod(pre.path, pre.mode).catch(() => {});
    } else {
        await rm(pre.path, { force: true });
    }
}

/**
 * Scan for journals whose owner PID is dead and recover them.
 * Committed journals: preserve disk, remove journal. Prepared journals:
 * roll back paths matching preimage-mismatch/post-match; quarantine drift.
 * Idempotent: a second run finds no journals (or no-ops on matches).
 */
export async function recoverStaleJournals(): Promise<RecoveryReport> {
    const report: RecoveryReport = { scanned: 0, recovered: [], preserved: [], conflicts: [], removed: [] };
    let files: string[] = [];
    try {
        files = (await readdir(journalDir())).filter((f) => f.endsWith(".json"));
    } catch {
        return report;
    }
    for (const file of files) {
        const full = join(journalDir(), file);
        let journal: RecoveryJournal;
        try {
            journal = JSON.parse(await readFile(full, "utf8")) as RecoveryJournal;
        } catch {
            continue;
        }
        report.scanned++;
        if (!journal || !journal.transactionId || typeof journal.ownerPid !== "number") continue;
        if (isProcessAlive(journal.ownerPid)) continue; // live owner: hands off
        const paths = journal.preimages.map((p) => p.path);
        let release: (() => Promise<void>) | undefined;
        try {
            release = await acquireRecoveryLocks(paths);
        } catch {
            continue; // live holder elsewhere; retry next cycle
        }
        try {
            if (journal.state === "committed") {
                report.preserved.push(journal.transactionId);
                await rm(full, { force: true }).catch(() => {});
                report.removed.push(journal.transactionId);
                continue;
            }
            let conflicted = false;
            for (const pre of journal.preimages) {
                const disk = await readDisk(pre.path);
                const preMatch = disk.exists === pre.existed && disk.sha === pre.beforeSha;
                if (preMatch) continue; // crashed before this write landed
                const expected = expectedPostFor(journal.intents, pre.path);
                if (expected.known) {
                    const postMatch = disk.exists === expected.exists && (expected.sha == null || disk.sha === expected.sha);
                    if (postMatch) {
                        await restorePreimage(pre); // our partial write: roll back
                        if (!report.recovered.includes(pre.path)) report.recovered.push(pre.path);
                        continue;
                    }
                    // Matches neither preimage nor our postimage: third-party drift.
                    conflicted = true;
                    const quarantineDir = join(journalDir(), "quarantine");
                    await mkdir(quarantineDir, { recursive: true });
                    let quarantinePath: string | undefined;
                    if (disk.exists) {
                        quarantinePath = join(quarantineDir, `${journal.transactionId}-${basename(pre.path)}`);
                        await writeFile(quarantinePath, await readFile(pre.path)).catch(() => { quarantinePath = undefined; });
                    }
                    report.conflicts.push({ transactionId: journal.transactionId, path: pre.path, quarantinePath });
                    continue;
                }
                // No intent recorded for this path: only safe action is to
                // restore when disk differs (our write is the sole writer under
                // lock). With zero intents and zero post knowledge, a bare
                // mismatch is still our partial write — but if the caller
                // recorded intents for OTHER paths and none for this one, this
                // path never got a mutation attempt: leave it.
                if (journal.intents.length === 0) {
                    await restorePreimage(pre);
                    if (!report.recovered.includes(pre.path)) report.recovered.push(pre.path);
                }
            }
            if (!conflicted) {
                await rm(full, { force: true }).catch(() => {});
                report.removed.push(journal.transactionId);
            }
        } finally {
            await release?.().catch(() => {});
        }
    }
    return report;
}

/** Build a journal record for a fresh transaction from begin-time snapshots. */
export function buildJournalRecord(
    transactionId: string,
    snapshots: ReadonlyArray<{ path: string; exists: boolean; content?: Buffer; mode?: number }>,
): RecoveryJournal {
    return {
        transactionId,
        ownerPid: process.pid,
        createdAt: new Date().toISOString(),
        state: "prepared",
        preimages: snapshots.map((s) => ({
            path: resolve(s.path),
            existed: s.exists,
            contentBase64: s.exists ? (s.content ?? Buffer.alloc(0)).toString("base64") : undefined,
            mode: s.mode,
            beforeSha: s.exists ? sha256Hex(s.content ?? Buffer.alloc(0)) : "",
        })),
        intents: [],
    };
}
