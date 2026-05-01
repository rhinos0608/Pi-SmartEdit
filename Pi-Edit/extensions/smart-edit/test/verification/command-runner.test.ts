import { describe, it } from "node:test";
import assert from "node:assert";
import { runCommand } from "../../src/verification/command-runner.js";

describe("command-runner", () => {
  describe("runCommand", () => {
    it("returns stdout for a successful command", async () => {
      const result = await runCommand("echo", ["hello world"]);
      assert.strictEqual(result.stdout.trim(), "hello world");
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.timedOut, false);
    });

    it("returns non-zero status for failed command", async () => {
      const result = await runCommand("sh", ["-c", "exit 42"]);
      assert.strictEqual(result.status, 42);
      assert.strictEqual(result.timedOut, false);
    });

    it("captures stderr output", async () => {
      const result = await runCommand("sh", ["-c", "echo 'error msg' >&2; exit 1"]);
      assert.ok(result.stderr.includes("error msg"));
      assert.strictEqual(result.status, 1);
    });

    it("handles command not found gracefully", async () => {
      const result = await runCommand("nonexistent-command-12345", []);
      assert.strictEqual(result.status, null);
      assert.strictEqual(result.timedOut, false);
    });

    it("truncates long output", async () => {
      const maxChars = 100;
      const result = await runCommand("sh", ["-c", "printf 'a%.0s' {1..1000}"], {
        maxOutputChars: maxChars,
      });
      assert.ok(result.stdout.length <= maxChars + 50, // slight overhead from truncation message
        `Output ${result.stdout.length} exceeds max ${maxChars}`);
    });

    it("uses custom cwd", async () => {
      const { tmpdir } = await import("node:os");
      const tmp = tmpdir();
      const result = await runCommand("pwd", [], { cwd: tmp });
      assert.ok(result.stdout.trim().endsWith(tmp) || result.stdout.trim() === tmp,
        `Expected cwd ${tmp}, got ${result.stdout.trim()}`);
    });
  });
});
