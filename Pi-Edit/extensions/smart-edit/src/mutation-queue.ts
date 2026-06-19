import { resolve } from "path";

/**
 * Maximum time a single edit operation can hold the mutation queue.
 * Prevents a hung LSP diagnostic call (e.g. unresponsive language server,
 * orphaned document-sync in flight) from blocking all subsequent edits
 * to the same file. The timed-out operation continues executing in the
 * background but its result is discarded. */
export const MUTATION_QUEUE_TIMEOUT_MS = 60_000;

const fileMutationQueues = new Map<string, Promise<void>>();

function getMutationKey(filePath: string): string {
  return resolve(filePath);
}

export async function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = getMutationKey(filePath);
  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((resolveQueue) => {
    releaseNext = resolveQueue;
  });

  // Chain that waits for nextQueue even if currentQueue rejected — prevents
  // a single failed edit from deadlocking all future edits to this file.
  const chainedQueue = currentQueue.then(
    () => nextQueue,
    () => nextQueue,
  );
  fileMutationQueues.set(key, chainedQueue);

  // Wait for previous operations, but don't let their errors block us.
  await currentQueue.catch(() => {});

  try {
    // Race the edit against a timeout so a hung LSP diagnostic call (or any
    // other async stall) can't block the queue indefinitely. The losing
    // promise is abandoned (fire-and-forget) — the next queued operation
    // may edit the file concurrently, which is acceptable over a dead queue.
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Mutation queue timeout after ${MUTATION_QUEUE_TIMEOUT_MS}ms for ${filePath}. ` +
              `The edit may still be completing in the background.`,
            ),
          );
        }, MUTATION_QUEUE_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
