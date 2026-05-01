/**
 * Unit tests for AST-scoped hashline fallback (Phases 3-4).
 *
 * Tests:
 * 1. Symbol anchor parsing — parseSymbolAnchor converts to EditAnchor format
 * 2. Scoped fallback — stale hashes but symbol resolves → scoped 4-tier match
 * 3. Full fuzzy fallback — all hashline paths failed → full 4-tier pipeline
 * 4. Rejection — all tiers failed → HashlineMismatchError thrown
 * 5. Metrics recording — recordFallbackTier tracks usage
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";

import {
  computeLineHashSync,
  initHashline,
} from "../lib/hashline.js";

import {
  resolveHashlineEdits,
  validateHashlineEdits,
  applyHashlineEdits,
  tryRebaseAll,
  HashlineMismatchError,
  parseSymbolAnchor,
  applyHashlinePath,
  recordFallbackTier,
  getHashlineMetrics,
  resetHashlineMetrics,
  type HashlineEditInput,
  type FallbackTier,
} from "../lib/hashline-edit.js";

import type { EditAnchor } from "../lib/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let hashlineInitialized = false;

async function ensureHashline(): Promise<void> {
  if (!hashlineInitialized) {
    await initHashline();
    hashlineInitialized = true;
  }
}

/** Mock scope resolver that always returns a scope */
async function mockResolveScope(
  _anchor: EditAnchor,
  content: string,
): Promise<{ startIndex: number; endIndex: number; description: string } | null> {
  return {
    startIndex: 0,
    endIndex: content.length,
    description: `mock scope for "${_anchor.symbolName}"`,
  };
}

/** Mock scope resolver that always returns null (AST unavailable) */
async function mockResolveScopeNull(
  _anchor: EditAnchor,
  _content: string,
): Promise<null> {
  return null;
}

/** Mock findText that always fails */
function mockFindTextFail(
  _content: string,
  _oldText: string,
  _indent: { char: "\t" | " "; width: number },
  _startOffset?: number,
  _scope?: { startIndex: number; endIndex: number; description: string },
): { found: boolean; index: number; matchLength: number; tier: string; usedFuzzyMatch: boolean; matchedText: string } {
  return { found: false, index: -1, matchLength: 0, tier: "exact", usedFuzzyMatch: false, matchedText: "" };
}

/** Mock detectIndentation */
function mockDetectIndent(_content: string): { char: " "; width: number } {
  return { char: " ", width: 2 };
}

/**
 * Create stale anchors with hashes that WON'T appear in the target file.
 * This forces rebase to fail (no matching hash in ±5 window).
 * Using non-existent text ensures the hash is unique to these anchors.
 */
function makeStaleAnchors(lineNum: number, text: string): { pos: string; end: string } {
  return {
    pos: `${lineNum}${computeLineHashSync(lineNum, text)}`,
    end: `${lineNum}${computeLineHashSync(lineNum + 1, text + " line 2")}`,
  };
}

// ─── parseSymbolAnchor ─────────────────────────────────────────────────────

describe("parseSymbolAnchor", () => {
  before(async () => { await ensureHashline(); });

  it("returns EditAnchor with all fields", () => {
    const result = parseSymbolAnchor({ name: "handleRequest", kind: "function", line: 42 });
    assert.strictEqual(result?.symbolName, "handleRequest");
    assert.strictEqual(result?.symbolKind, "function");
    assert.strictEqual(result?.symbolLine, 42);
  });

  it("returns EditAnchor with name only", () => {
    const result = parseSymbolAnchor({ name: "MyClass" });
    assert.strictEqual(result?.symbolName, "MyClass");
    assert.strictEqual(result?.symbolKind, undefined);
    assert.strictEqual(result?.symbolLine, undefined);
  });

  it("returns undefined when symbol is undefined", () => {
    assert.strictEqual(parseSymbolAnchor(undefined), undefined);
  });
});

// ─── applyHashlinePath — Fast Path ─────────────────────────────────────────

describe("applyHashlinePath — fast path", () => {
  before(async () => { await ensureHashline(); });
  beforeEach(() => { resetHashlineMetrics(); });

  it("applies directly when hashes match", async () => {
    const content = "function hello() {\n  return 'hi';\n}\n";
    const h1 = `${1}${computeLineHashSync(1, "function hello() {")}`;
    const h2 = `${2}${computeLineHashSync(2, "  return 'hi';")}`;

    const result = await applyHashlinePath(
      { anchor: { range: { pos: h1, end: h2 } }, content: ["  return 'hello';"] },
      content,
      null,
      mockResolveScope,
      mockFindTextFail,
      mockDetectIndent,
    );

    assert.strictEqual(result.tier, "hashline-direct");
    assert.ok(!result.warnings.some(w => w.includes("fallback")));
    assert.ok(result.newContent.includes("return 'hello'"));
  });

  it("records hashlineDirect metric", async () => {
    const content = "const x = 1;\n";
    const h1 = `${1}${computeLineHashSync(1, "const x = 1;")}`;

    await applyHashlinePath(
      { anchor: { range: { pos: h1, end: h1 } }, content: ["const y = 2;"] },
      content,
      null,
      mockResolveScope,
      mockFindTextFail,
      mockDetectIndent,
    );

    const m = getHashlineMetrics();
    assert.strictEqual(m.hashlineDirect, 1);
  });

  it("handles null/undefined content (delete)", async () => {
    const content = "line one\nline two\nline three\n";
    const h1 = `${1}${computeLineHashSync(1, "line one")}`;
    const h2 = `${2}${computeLineHashSync(2, "line two")}`;

    const result = await applyHashlinePath(
      { anchor: { range: { pos: h1, end: h2 } }, content: null },
      content,
      null,
      mockResolveScope,
      mockFindTextFail,
      mockDetectIndent,
    );

    assert.strictEqual(result.tier, "hashline-direct");
    assert.strictEqual(result.newContent, "line three\n");
  });
});

// ─── applyHashlinePath — Rebase ─────────────────────────────────────────────

describe("applyHashlinePath — rebase", () => {
  before(async () => { await ensureHashline(); });
  beforeEach(() => { resetHashlineMetrics(); });

  it("rebases when anchor line doesn't match but hash found elsewhere in ±5", async () => {
    // File shifted by 2 lines — hash of "const x = 1;" was at line 1, now at line 3
    const content = "// comment\n// comment\nconst x = 1;\n";
    // Use hash of target content at line 1 (will be at line 3)
    const staleAnchor = `${1}${computeLineHashSync(1, "const x = 1;")}`;

    const result = await applyHashlinePath(
      { anchor: { range: { pos: staleAnchor, end: staleAnchor } }, content: ["const x = 99;"] },
      content,
      null,
      mockResolveScope,
      mockFindTextFail,
      mockDetectIndent,
    );

    assert.strictEqual(result.tier, "hashline-rebased");
    assert.ok(result.warnings.some(w => w.includes("rebased")));
    assert.strictEqual(getHashlineMetrics().hashlineRebased, 1);
  });

  it("throws HashlineMismatchError when rebase window exhausted", async () => {
    const content = "// line 1\n// line 2\n// line 3\n// line 4\n// line 5\n// line 6\n// line 7\n// line 8\n// line 9\nfunction hello() {\n  return 'hi';\n}\n";
    // Hash at line 1, but target moved to line 10 (beyond ±5 window)
    const staleAnchor = `${1}${computeLineHashSync(1, "function hello() {")}`;

    await assert.rejects(
      () => applyHashlinePath(
        { anchor: { range: { pos: staleAnchor, end: staleAnchor } }, content: ["  return 'hello';"] },
        content,
        null,
        mockResolveScope,
        mockFindTextFail,
        mockDetectIndent,
      ),
      HashlineMismatchError,
    );

    assert.strictEqual(getHashlineMetrics().hashMismatchRejects, 1);
  });
});

// ─── applyHashlinePath — Scoped Fallback ────────────────────────────────────

describe("applyHashlinePath — scoped fallback", () => {
  before(async () => { await ensureHashline(); });
  beforeEach(() => { resetHashlineMetrics(); });

  it("uses scoped fallback when hashes stale (no rebase), symbol resolves, and findText succeeds", async () => {
    const content = "function handleRequest(req) {\n  return user.getName();\n}\n";

    // Stale anchor with hash of text that won't appear in current file
    const stalePos = `${1}${computeLineHashSync(1, "this text does not appear anywhere in this file abcxyz123")}`;
    const staleEnd = `${2}${computeLineHashSync(2, "another piece of text that is completely unique defghi456")}`;

    const snapshot = {
      path: "test.ts",
      mtimeMs: Date.now(),
      size: 100,
      contentHash: "abc",
      readAt: Date.now(),
      hashline: {
        anchors: new Map([
          [stalePos, { text: "function handleRequest(req) {", line: 1 }],
          [staleEnd, { text: "  return user.getName();", line: 2 }],
        ]),
        formattedContent: `${stalePos}|function handleRequest(req) {\n${staleEnd}|  return user.getName();`,
      },
    };

    const mockFindText = (
      _content: string,
      _oldText: string,
      _indent: { char: "\t" | " "; width: number },
    ) => ({
      found: true,
      index: 0,
      matchLength: "return user.getName()".length,
      tier: "exact",
      usedFuzzyMatch: false,
      matchedText: "return user.getName()",
      matchNote: "scoped match",
    });

    const result = await applyHashlinePath(
      {
        anchor: {
          symbol: { name: "handleRequest", kind: "function" },
          range: { pos: stalePos, end: staleEnd },
        },
        content: ["  return user.getDisplayName();"],
      },
      content,
      snapshot as any,
      mockResolveScope,
      mockFindText as any,
      mockDetectIndent,
    );

    assert.strictEqual(result.tier, "scoped-fallback");
    assert.ok(result.warnings.some(w => w.includes("scoped")));
    assert.ok(result.warnings.some(w => w.includes("AST scoping")));
    assert.strictEqual(getHashlineMetrics().scopedFallback, 1);
  });

  it("falls through to full fuzzy when symbol resolution returns null", async () => {
    const content = "function hello() {\n  return 'world';\n}\n";

    // Stale anchors
    const stalePos = `${1}${computeLineHashSync(1, "text not in file abcdefghijklmnop")}`;
    const staleEnd = `${2}${computeLineHashSync(2, "more text not in file qrstuvwxyz")}`;

    const snapshot = {
      path: "test.ts",
      mtimeMs: Date.now(),
      size: 100,
      contentHash: "abc",
      readAt: Date.now(),
      hashline: {
        anchors: new Map([
          [stalePos, { text: "function hello() {", line: 1 }],
          [staleEnd, { text: "  return 'world';", line: 2 }],
        ]),
        formattedContent: `${stalePos}|function hello() {\n${staleEnd}|  return 'world';`,
      },
    };

    const mockFindText = (
      _content: string,
      _oldText: string,
      _indent: { char: "\t" | " "; width: number },
    ) => ({
      found: true,
      index: 0,
      matchLength: "return 'world'".length,
      tier: "exact",
      usedFuzzyMatch: false,
      matchedText: "return 'world'",
    });

    const result = await applyHashlinePath(
      {
        anchor: {
          symbol: { name: "hello" },
          range: { pos: stalePos, end: staleEnd },
        },
        content: ["  return 'changed';"],
      },
      content,
      snapshot as any,
      mockResolveScopeNull as any,
      mockFindText as any,
      mockDetectIndent,
    );

    assert.strictEqual(result.tier, "full-fuzzy-fallback");
    assert.ok(result.warnings.some(w => w.includes("fuzzy")));
    assert.strictEqual(getHashlineMetrics().fullFuzzyFallback, 1);
  });

  it("throws HashlineMismatchError when snapshot is null and hashes don't match", async () => {
    const content = "function hello() {\n  return 'changed';\n}\n";

    // Stale anchor with no snapshot → cannot fall back
    const stalePos = `${1}${computeLineHashSync(1, "completely unrelated text never in file")}`;
    const staleEnd = `${2}${computeLineHashSync(2, "another unique text that doesn't exist either")}`;

    await assert.rejects(
      () => applyHashlinePath(
        { anchor: { range: { pos: stalePos, end: staleEnd } }, content: ["  return 'new';"] },
        content,
        null,
        mockResolveScope,
        mockFindTextFail,
        mockDetectIndent,
      ),
      HashlineMismatchError,
    );
  });
});

// ─── applyHashlinePath — Full Fuzzy Fallback ───────────────────────────────

describe("applyHashlinePath — full fuzzy fallback", () => {
  before(async () => { await ensureHashline(); });
  beforeEach(() => { resetHashlineMetrics(); });

  it("runs full fuzzy when scoped fallback fails to find a match", async () => {
    const content = "function hello() {\n  return 'world';\n}\n";

    // Stale anchors with hashes not in file
    const stalePos = `${1}${computeLineHashSync(1, "text not in file at all aaaabbbcccdddeee")}`;
    const staleEnd = `${3}${computeLineHashSync(3, "closing brace text not present ffgghhiijjkk")}`;

    const snapshot = {
      path: "test.ts",
      mtimeMs: Date.now(),
      size: 100,
      contentHash: "abc",
      readAt: Date.now(),
      hashline: {
        anchors: new Map([
          [stalePos, { text: "function hello() {", line: 1 }],
          ["2cd", { text: "  return 'bar';", line: 2 }],
          [staleEnd, { text: "}", line: 3 }],
        ]),
        formattedContent: `${stalePos}|function hello() {\n2cd|  return 'bar';\n${staleEnd}|}`,
      },
    };

    let scopedCalled = false;
    const chainFindText = (
      content: string, oldText: string, indent: any, start?: number, scope?: any,
    ) => {
      if (!scopedCalled) {
        scopedCalled = true;
        // Scoped findText fails
        return { found: false, index: -1, matchLength: 0, tier: "exact", usedFuzzyMatch: false, matchedText: "" };
      }
      // Full findText succeeds
      return {
        found: true,
        index: 0,
        matchLength: "return 'world'".length,
        tier: "indentation",
        usedFuzzyMatch: true,
        matchedText: "return 'world'",
        matchNote: "indentation-normalized",
      };
    };

    const result = await applyHashlinePath(
      {
        anchor: {
          symbol: { name: "hello" },
          range: { pos: stalePos, end: staleEnd },
        },
        content: ["  return 'universe';"],
      },
      content,
      snapshot as any,
      mockResolveScope,
      chainFindText as any,
      mockDetectIndent,
    );

    assert.strictEqual(result.tier, "full-fuzzy-fallback");
    assert.ok(result.warnings.some(w => w.includes("full fuzzy")));
    assert.strictEqual(getHashlineMetrics().fullFuzzyFallback, 1);
  });

  it("throws HashlineMismatchError when even full fuzzy fails", async () => {
    const content = "function hello() {\n  return 'world';\n}\n";

    // Stale anchors with hashes not in file
    const stalePos = `${1}${computeLineHashSync(1, "text not in file xxxxxxxxxxxxxxxxxxxxxx")}`;
    const staleEnd = `${2}${computeLineHashSync(2, "other text not present yyyyyyyyyyyyyyyy")}`;

    const snapshot = {
      path: "test.ts",
      mtimeMs: Date.now(),
      size: 100,
      contentHash: "abc",
      readAt: Date.now(),
      hashline: {
        anchors: new Map([
          [stalePos, { text: "function foo() {", line: 1 }],
          [staleEnd, { text: "  return 'bar';", line: 2 }],
        ]),
        formattedContent: `${stalePos}|function foo() {\n${staleEnd}|  return 'bar';`,
      },
    };

    await assert.rejects(
      () => applyHashlinePath(
        { anchor: { range: { pos: stalePos, end: staleEnd } }, content: ["  return 'baz';"] },
        content,
        snapshot as any,
        mockResolveScope,
        mockFindTextFail,
        mockDetectIndent,
      ),
      HashlineMismatchError,
    );

    assert.strictEqual(getHashlineMetrics().hashMismatchRejects, 1);
  });
});

// ─── Metrics ───────────────────────────────────────────────────────────────

describe("hashline metrics", () => {
  before(async () => { await ensureHashline(); });
  beforeEach(() => { resetHashlineMetrics(); });

  it("resetHashlineMetrics clears all counters", () => {
    recordFallbackTier("hashline-direct");
    recordFallbackTier("hashline-rebased");
    recordFallbackTier("scoped-fallback");
    recordFallbackTier("full-fuzzy-fallback");
    recordFallbackTier("hash-mismatch-reject");

    resetHashlineMetrics();

    const m = getHashlineMetrics();
    assert.strictEqual(m.hashlineDirect, 0);
    assert.strictEqual(m.hashlineRebased, 0);
    assert.strictEqual(m.scopedFallback, 0);
    assert.strictEqual(m.fullFuzzyFallback, 0);
    assert.strictEqual(m.hashMismatchRejects, 0);
  });

  it("getHashlineMetrics returns a copy (mutation-safe)", () => {
    recordFallbackTier("hashline-direct");
    const m1 = getHashlineMetrics();
    m1.hashlineDirect = 999;
    const m2 = getHashlineMetrics();
    assert.strictEqual(m2.hashlineDirect, 1);
  });
});

// ─── End-to-end fallback chain ─────────────────────────────────────────────

describe("fallback chain — end-to-end", () => {
  before(async () => { await ensureHashline(); });
  beforeEach(() => { resetHashlineMetrics(); });

  it("Tier 1 -> direct apply when hashes match", async () => {
    const content = "const x = 1;\n";
    const h1 = `${1}${computeLineHashSync(1, "const x = 1;")}`;

    const result = await applyHashlinePath(
      { anchor: { range: { pos: h1, end: h1 } }, content: ["const x = 2;"] },
      content,
      null,
      mockResolveScope,
      mockFindTextFail,
      mockDetectIndent,
    );

    assert.strictEqual(result.tier, "hashline-direct");
    assert.strictEqual(result.newContent, "const x = 2;\n");
  });

  it("Tier 2 -> rebase when hashes stale within window", async () => {
    // Hash of "const x = 1;" is at line 3 (shifted by 2)
    const content = "// shift\n// shift\nconst x = 1;\n";
    const staleAnchor = `${1}${computeLineHashSync(1, "const x = 1;")}`;

    const result = await applyHashlinePath(
      { anchor: { range: { pos: staleAnchor, end: staleAnchor } }, content: ["const x = 99;"] },
      content,
      null,
      mockResolveScope,
      mockFindTextFail,
      mockDetectIndent,
    );

    assert.strictEqual(result.tier, "hashline-rebased");
    assert.ok(result.warnings.length > 0);
  });

  it("Tier 3 -> scoped fallback when hashes stale and symbol provided", async () => {
    const content = "function foo() {\n  return 1;\n}\n";

    // Stale anchors with hashes not in file
    const stalePos = `${1}${computeLineHashSync(1, "text not present in this file zzzzzzzzzzzzzzz")}`;
    const staleEnd = `${2}${computeLineHashSync(2, "more unique text that doesn't match anything aaaaaaa")}`;

    const snapshot = {
      path: "test.ts",
      mtimeMs: Date.now(),
      size: 100,
      contentHash: "abc",
      readAt: Date.now(),
      hashline: {
        anchors: new Map([
          [stalePos, { text: "function foo() {", line: 1 }],
          [staleEnd, { text: "  return 1;", line: 2 }],
        ]),
        formattedContent: `${stalePos}|function foo() {\n${staleEnd}|  return 1;`,
      },
    };

    const findText = () => ({
      found: true,
      index: 0,
      matchLength: "return 1".length,
      tier: "exact",
      usedFuzzyMatch: false,
      matchedText: "return 1",
    });

    const result = await applyHashlinePath(
      {
        anchor: {
          symbol: { name: "foo" },
          range: { pos: stalePos, end: staleEnd },
        },
        content: ["  return 99;"],
      },
      content,
      snapshot as any,
      mockResolveScope,
      findText as any,
      mockDetectIndent,
    );

    assert.strictEqual(result.tier, "scoped-fallback");
  });

  it("Tier 4 -> full fuzzy when scoped fallback unavailable and findText succeeds", async () => {
    const content = "function foo() {\n  return 1;\n}\n";

    // Stale anchors
    const stalePos = `${1}${computeLineHashSync(1, "text not in file bbbbbbbbbbbbbbbbb")}`;
    const staleEnd = `${2}${computeLineHashSync(2, "unique text not matching ccccccccccccccc")}`;

    const snapshot = {
      path: "test.ts",
      mtimeMs: Date.now(),
      size: 100,
      contentHash: "abc",
      readAt: Date.now(),
      hashline: {
        anchors: new Map([
          [stalePos, { text: "function foo() {", line: 1 }],
          [staleEnd, { text: "  return 1;", line: 2 }],
        ]),
        formattedContent: `${stalePos}|function foo() {\n${staleEnd}|  return 1;`,
      },
    };

    const findText = () => ({
      found: true,
      index: 0,
      matchLength: "return 1".length,
      tier: "indentation",
      usedFuzzyMatch: true,
      matchedText: "return 1",
      matchNote: "indentation",
    });

    const result = await applyHashlinePath(
      {
        anchor: {
          symbol: { name: "foo" },
          range: { pos: stalePos, end: staleEnd },
        },
        content: ["  return 99;"],
      },
      content,
      snapshot as any,
      mockResolveScopeNull as any,
      findText as any,
      mockDetectIndent,
    );

    assert.strictEqual(result.tier, "full-fuzzy-fallback");
    assert.ok(result.warnings.some(w => w.includes("full fuzzy")));
  });

  it("Rejection when all tiers fail", async () => {
    const content = "function foo() {\n  return 1;\n}\n";
    // Stale anchors with no snapshot
    const stalePos = `${99}${computeLineHashSync(99, "text not in file")}`;
    const staleEnd = `${99}${computeLineHashSync(99, "}")}`;

    await assert.rejects(
      () => applyHashlinePath(
        { anchor: { range: { pos: stalePos, end: staleEnd } }, content: ["  return 99;"] },
        content,
        null,
        mockResolveScope,
        mockFindTextFail,
        mockDetectIndent,
      ),
      HashlineMismatchError,
    );
  });
});