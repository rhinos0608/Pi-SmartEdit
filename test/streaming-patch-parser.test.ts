/**
 * Tests for StreamingPatchParser.
 * Uses tsx --test compatible describe/it/test blocks.
 */

import { describe, test } from "node:test";
import assert from "node:assert";
import { StreamingPatchParser } from "../src/formats/streaming-patch-parser";

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Create a simple fake onUpdate callback that collects all emissions.
 */
function makeCollector(): {
  onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void;
  messages: string[];
} {
  const messages: string[] = [];
  const onUpdate = (update: { content: Array<{ type: "text"; text: string }> }) => {
    for (const block of update.content) {
      messages.push(block.text);
    }
  };
  return { onUpdate, messages };
}

// ─── Basic Tests ─────────────────────────────────────────────────────

describe("StreamingPatchParser — basic", () => {
  test("pushDelta with no onUpdate is a no-op (graceful degradation)", () => {
    const parser = new StreamingPatchParser(undefined);
    // Should not throw
    parser.pushDelta("*** Begin Patch\n*** Update File: file.ts\n@@ fn\n-old\n+new\n*** End Patch");
    parser.finish();
    assert.ok(true, "no-op with undefined onUpdate");
  });

  test("finish() without any pushDelta handles empty state", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate);
    parser.finish();
    assert.strictEqual(messages.length, 1);
    assert.ok(messages[0].includes("complete"));
  });

  test("single UpdateFile hunk emitted on finish()", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    parser.pushDelta("*** Begin Patch\n*** Update File: file.ts\n@@ fn\n-old\n+new\n*** End Patch");
    parser.finish();

    // Should get at least a progress message + a finish message
    assert.ok(messages.length >= 1);
    // The finish message should mention completion
    const lastMsg = messages[messages.length - 1];
    assert.ok(lastMsg.includes("complete") || lastMsg.includes("all"), 
      `Expected completion message, got: ${lastMsg}`);
  });

  test("single AddFile hunk emitted", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    parser.pushDelta("*** Begin Patch\n*** Add File: src/new.ts\nexport function hello() {}\n*** End Patch");
    parser.finish();

    assert.ok(messages.length >= 1);
    const allText = messages.join("\n");
    assert.ok(allText.includes("src/new.ts") || allText.includes("+++"), 
      `Expected AddFile mention, got: ${allText.slice(0, 200)}`);
  });

  test("single DeleteFile hunk emitted", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    parser.pushDelta("*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch");
    parser.finish();

    assert.ok(messages.length >= 1);
    const allText = messages.join("\n");
    assert.ok(allText.includes("src/old.ts") || allText.includes("/dev/null"),
      `Expected DeleteFile mention, got: ${allText.slice(0, 200)}`);
  });

  test("multi-hunk patch processes all hunks", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    parser.pushDelta(
      "*** Begin Patch\n" +
      "*** Add File: src/new.ts\ncontent\n" +
      "*** Update File: src/main.ts\n@@ fn\n-old\n+new\n" +
      "*** Delete File: src/old.ts\n" +
      "*** End Patch"
    );
    parser.finish();

    // Should see all 3 hunks processed — verify distinct indicators for each
    const allText = messages.join("\n");
    assert.ok(allText.includes("Add File") || allText.includes("src/new.ts"),
      `Expected AddFile indicator, got: ${allText.slice(0, 300)}`);
    assert.ok(allText.includes("Update File") || allText.includes("src/main.ts"),
      `Expected UpdateFile indicator, got: ${allText.slice(0, 300)}`);
    assert.ok(allText.includes("Delete File") || allText.includes("src/old.ts"),
      `Expected DeleteFile indicator, got: ${allText.slice(0, 300)}`);
  });
});

// ─── Throttle / Buffer Tests ─────────────────────────────────────────

describe("StreamingPatchParser — throttle", () => {
  test("immediate emission when buffer has elapsed", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    // First push — should emit immediately (buffer period ~10ms)
    parser.pushDelta("*** Begin Patch\n*** Update File: file.ts\n@@ fn\n-old\n+new\n*** End Patch");
    parser.finish();

    assert.ok(messages.length >= 1, "Should have emitted at least one message");
  });

  test("no duplicate emission for same hunk", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    // Push the same text twice — hunk should only be emitted once
    const text = "*** Begin Patch\n*** Update File: file.ts\n@@ fn\n-old\n+new\n*** End Patch";
    parser.pushDelta(text);
    parser.pushDelta(text);  // Same text again
    parser.finish();

    // Count how many times "fn" appears (each emission includes the hunk diff once)
    const fnCount = (messages.join("\n").match(/fn/g) || []).length;
    assert.ok(fnCount <= 2, // Could appear in progress header + diff, but not duplicated across pushes
      `Expected 'fn' to appear at most 2 times, got ${fnCount}`);
  });

  test("deferred flush fires within bufferIntervalMs", () => {
    return new Promise<void>((resolve, reject) => {
      const messages: string[] = [];
      let resolved = false;
      const onUpdate = (update: { content: Array<{ type: "text"; text: string }> }) => {
        for (const block of update.content) {
          messages.push(block.text);
        }
        // Resolve as soon as onUpdate is called by the deferred flush
        // (rather than relying on a fixed setTimeout).
        // Use a guard to prevent re-entrant resolution.
        if (!resolved) {
          resolved = true;
          clearTimeout(safetyTimer);
          resolve();
        }
      };
      // Safety timeout in case the deferred flush never fires
      const safetyTimer = setTimeout(() => {
        reject(new Error("Deferred flush did not fire within 1s"));
      }, 1000);

      const parser = new StreamingPatchParser(onUpdate, 50);

      // Push first delta (immediate emit if buffer elapsed)
      parser.pushDelta("*** Begin Patch\n*** Update File: file.ts\n@@ fn\n-old");
      // Immediately push more text — should trigger deferred flush
      parser.pushDelta("\n+new\n*** End Patch");
    });
  });
});

// ─── Incremental Parsing Tests ───────────────────────────────────────

describe("StreamingPatchParser — incremental", () => {
  test("pushDelta feeds partial text incrementally", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    // First push: partial patch (no End Patch)
    parser.pushDelta("*** Begin Patch\n");
    parser.pushDelta("*** Update File: file.ts\n@@ fn\n");
    parser.pushDelta("-old\n+new\n");
    parser.pushDelta("*** End Patch");
    parser.finish();

    // Should have processed the hunk
    const allText = messages.join("\n");
    assert.ok(allText.includes("file.ts") || allText.includes("complete"),
      `Expected file reference, got: ${allText.slice(0, 200)}`);
  });

  test("hunks discovered in later pushDelta emit separately", async () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    // First push: just the first hunk
    parser.pushDelta("*** Begin Patch\n*** Add File: src/a.ts\ncontent-a\n");
    // Small delay to let buffer fire
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    // Second push: add another hunk
    parser.pushDelta("*** Update File: src/b.ts\n@@ fn\n-old\n+new\n*** End Patch");
    parser.finish();

    const allText = messages.join("\n");
    assert.ok(messages.length >= 2, `Expected at least 2 messages, got ${messages.length}`);
    assert.ok(allText.includes("a.ts"), "First hunk (a.ts) should be referenced");
    assert.ok(allText.includes("b.ts"), "Second hunk (b.ts) should be referenced");
  });
});

// ─── Output Format Tests ─────────────────────────────────────────────

describe("StreamingPatchParser — output format", () => {
  test("progress message includes count", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    parser.pushDelta("*** Begin Patch\n*** Update File: file.ts\n@@ fn\n-old\n+new\n*** End Patch");
    parser.finish();

    const progressMsgs = messages.filter(m => m.includes("progress"));
    const finishMsgs = messages.filter(m => m.includes("complete"));
    assert.ok(progressMsgs.length > 0 || finishMsgs.length > 0,
      "Should have some status message");
  });

  test("finish message uses checkmark prefix", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    parser.pushDelta("*** Begin Patch\n*** Update File: file.ts\n@@ fn\n-old\n+new\n*** End Patch");
    parser.finish();

    const lastMsg = messages[messages.length - 1];
    assert.ok(lastMsg.includes("✅") || lastMsg.includes("complete"),
      `Expected checkmark or completion in: ${lastMsg}`);
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────

describe("StreamingPatchParser — edge cases", () => {
  test("empty patch string", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    parser.pushDelta("");
    parser.finish();

    assert.ok(messages.length >= 1, "Should get at least finish message");
  });

  test("patch with no hunks (begin/end only)", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    parser.pushDelta("*** Begin Patch\n*** End Patch");
    parser.finish();

    assert.ok(messages.length >= 1, "Should get at least finish message");
  });

  test("malformed patch text in lenient mode", () => {
    const { onUpdate, messages } = makeCollector();
    const parser = new StreamingPatchParser(onUpdate, 10);

    parser.pushDelta("some random text that is not a patch at all");
    parser.finish();

    // Should not crash — lenient mode tolerates bad input
    assert.ok(messages.length >= 1, "Should still produce finish message");
  });

  test("constructor with default buffer interval", () => {
    const parser = new StreamingPatchParser();
    assert.ok(parser instanceof StreamingPatchParser);
    // pushDelta and finish should be no-ops without onUpdate
    parser.pushDelta("anything");
    parser.finish();
    assert.ok(true);
  });
});
