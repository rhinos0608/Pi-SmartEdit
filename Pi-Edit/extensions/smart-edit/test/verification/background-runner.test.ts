import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { BackgroundRunRegistry } from "../../src/verification/background-runner.js";

describe("background-runner", () => {
  describe("BackgroundRunRegistry", () => {
    // Clean up any active runs after each test to prevent hanging
    const registries: BackgroundRunRegistry[] = [];

    afterEach(() => {
      for (const registry of registries) {
        for (const run of registry.listRuns(false)) {
          registry.cancel(run.runId);
        }
      }
      registries.length = 0;
    });

    function createRegistry(opts?: { maxConcurrent?: number; defaultTimeoutMs?: number; evictAfterMs?: number }): BackgroundRunRegistry {
      const r = new BackgroundRunRegistry(opts);
      registries.push(r);
      return r;
    }
    it("schedules a run and returns runId", async () => {
      const registry = createRegistry({ maxConcurrent: 3 });
      const { runId, promise } = registry.schedule(["echo", "hello"]);
      assert.ok(typeof runId === "string" && runId.length > 0);
      const status = await promise;
      assert.strictEqual(status.runId, runId);
    });

    it("rejects when max concurrent runs reached", async () => {
      const registry = createRegistry({ maxConcurrent: 1 });
      registry.schedule(["sleep", "10"]); // occupies the slot
      assert.throws(() => {
        registry.schedule(["echo", "world"]);
      }, /Max concurrent verification runs/);
    });

    it("getStatus returns running status for active runs", async () => {
      const registry = createRegistry({ maxConcurrent: 3 });
      const { runId } = registry.schedule(["sleep", "30"]);
      const status = registry.getStatus(runId);
      assert.ok(status, "Expected status for active run");
      assert.strictEqual(status.status, "running");
    });

    it("getStatus returns completed status after finalize", async () => {
      const registry = createRegistry({ maxConcurrent: 3 });
      const { runId, promise } = registry.schedule(["echo", "done"]);

      // Wait for completion
      await promise;

      const status = registry.getStatus(runId);
      assert.ok(status, "Expected status after completion");
      assert.ok(
        status.status === "passed" || status.status === "failed" || status.status === "timeout",
        `Expected completed status, got ${status.status}`,
      );
    });

    it("getStatus returns null for unknown runId", async () => {
      const registry = createRegistry({ maxConcurrent: 3 });
      const status = registry.getStatus("nonexistent-id");
      assert.strictEqual(status, null);
    });

    it("listRuns returns active runs", async () => {
      const registry = createRegistry({ maxConcurrent: 3 });
      registry.schedule(["sleep", "30"]);
      const runs = registry.listRuns(false);
      assert.ok(runs.length >= 1);
      assert.ok(runs.every((r) => r.status === "running"));
    });

    it("listRuns with includeCompleted returns completed runs too", async () => {
      const registry = createRegistry({ maxConcurrent: 3 });
      const { runId, promise } = registry.schedule(["echo", "done"]);
      await promise; // wait for completion
      const runs = registry.listRuns(true);
      const completed = runs.find((r) => r.runId === runId);
      assert.ok(completed, "Expected completed run in list");
      assert.notStrictEqual(completed.status, "running");
    });

    it("cancel stops a running verification", async () => {
      const registry = createRegistry({ maxConcurrent: 3 });
      const { runId } = registry.schedule(["sleep", "30"]);
      const cancelled = registry.cancel(runId);
      assert.ok(cancelled, "Expected cancel to return true");

      const status = registry.getStatus(runId);
      assert.ok(status);
      assert.strictEqual(status.status, "failed");
      const msgs = status.diagnostics.map((d) => d.message);
      assert.ok(msgs.some((m) => m.includes("Cancelled")), `Expected cancel message in [${msgs}]`);
    });

    it("cancel returns false for unknown runId", async () => {
      const registry = createRegistry({ maxConcurrent: 3 });
      const cancelled = registry.cancel("nonexistent");
      assert.strictEqual(cancelled, false);
    });

    it("times out long-running commands", async () => {
      const registry = createRegistry({
        maxConcurrent: 3,
        defaultTimeoutMs: 100, // very short timeout
        evictAfterMs: 5000,
      });

      const { runId, promise } = registry.schedule(["sleep", "30"]);
      const status = await promise;
      assert.strictEqual(status.status, "timeout");
      const msgs = status.diagnostics.map((d) => d.message);
      assert.ok(msgs.some((m) => m.includes("timed out")), `Expected timeout message in [${msgs}]`);
    });
  });
});
