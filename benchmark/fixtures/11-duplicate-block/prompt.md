In src/workers.ts, change productionWorker only: timeoutMs 1000 -> 2500 and retries 2 -> 4. stagingWorker and canaryWorker must remain byte-for-byte unchanged.
