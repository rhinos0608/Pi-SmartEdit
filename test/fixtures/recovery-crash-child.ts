/**
 * Crash-child helper for recovery-journal kill tests. Runs ONE scenario, then
 * hangs until the parent SIGKILLs it (simulating a crash mid-transaction).
 *
 * Usage: tsx recovery-crash-child.ts <scenario> <workDir> <sentinel>
 * Env: PI_SMARTEDIT_RECOVERY_DIR (journal dir override).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EditTransaction } from "../../src/mutation/edit-transaction.js";
import {
    appendIntent,
    buildJournalRecord,
    markCommitted,
    writePreparedJournal,
} from "../../src/mutation/recovery-journal.js";
import { createHash } from "node:crypto";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

async function ready(sentinel: string): Promise<void> {
    await writeFile(sentinel, "ready");
    await new Promise(() => {}); // hang until killed
}

async function preparedTx(paths: string[]): Promise<EditTransaction> {
    const tx = await EditTransaction.begin(paths);
    const snapshots = paths.map((path) => {
        const snap = tx.getSnapshot(path);
        return { path, exists: snap?.exists ?? false, content: snap?.content, mode: snap?.mode };
    });
    await writePreparedJournal(buildJournalRecord(tx.transactionId, snapshots));
    return tx;
}

async function main(): Promise<void> {
    const [scenario, workDir, sentinel] = process.argv.slice(2);
    const fileA = join(workDir, "a.txt");
    const fileB = join(workDir, "b.txt");
    switch (scenario) {
        case "kill-after-first-write": {
            const tx = await preparedTx([fileA, fileB]);
            await appendIntent(tx.transactionId, { op: "write", paths: [fileA], expectedPostSha: sha("A-CHANGED"), expectedExists: true });
            await tx.write(fileA, "A-CHANGED");
            await ready(sentinel);
            break;
        }
        case "kill-after-create": {
            const tx = await preparedTx([fileB]);
            await appendIntent(tx.transactionId, { op: "create", paths: [fileB], expectedPostSha: sha("NEW"), expectedExists: true });
            await tx.create(fileB, "NEW");
            await ready(sentinel);
            break;
        }
        case "kill-after-remove": {
            const tx = await preparedTx([fileA]);
            await appendIntent(tx.transactionId, { op: "remove", paths: [fileA], expectedPostSha: null, expectedExists: false });
            await tx.remove(fileA);
            await ready(sentinel);
            break;
        }
        case "kill-after-rename": {
            const tx = await preparedTx([fileA, fileB]);
            await appendIntent(tx.transactionId, { op: "rename", paths: [fileA], expectedPostSha: null, expectedExists: false });
            await appendIntent(tx.transactionId, { op: "rename", paths: [fileB], expectedPostSha: sha("A-ORIG"), expectedExists: true });
            await tx.rename(fileA, fileB);
            await ready(sentinel);
            break;
        }
        case "kill-after-exec": {
            const tx = await preparedTx([fileA]);
            await appendIntent(tx.transactionId, { op: "exec", paths: [fileA], expectedExists: true });
            await appendIntent(tx.transactionId, { op: "write", paths: [fileA], expectedPostSha: sha("A-EXEC"), expectedExists: true });
            await tx.write(fileA, "A-EXEC");
            await ready(sentinel);
            break;
        }
        case "committed-not-deleted": {
            const tx = await preparedTx([fileA]);
            await appendIntent(tx.transactionId, { op: "write", paths: [fileA], expectedPostSha: sha("A-DONE"), expectedExists: true });
            await tx.write(fileA, "A-DONE");
            await tx.getUndoRecords().catch(() => []);
            await markCommitted(tx.transactionId);
            await tx.commit();
            await writeFile(sentinel, "done");
            process.exit(0);
            break;
        }
        case "stale-lock-holder": {
            await preparedTx([fileA, fileB]);
            await ready(sentinel);
            break;
        }
        default:
            console.error(`unknown scenario: ${scenario}`);
            process.exit(2);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
