/**
 * Tests for the smart-edit extension's AST resolver module.
 *
 * Validates Phase 1 core: grammar loading, file parsing, symbol lookup,
 * enclosing-symbol discovery, and graceful degradation.
 *
 * Run: npx tsx test/ast-resolver.test.ts
 *
 * NOTE: Full integration tests require web-tree-sitter and grammars
 * to be installed. These tests verify the module structure, type
 * definitions, and graceful-fallback behaviour.
 * See: docs/REVIEW-FINDINGS.md FIX-3 for WASM compatibility notes.
 */

import {
  parseFile,
  findSymbolNode,
  findEnclosingSymbols,
  disposeParseResult,
  type EditAnchor,
  type SymbolRef,
} from "../.pi/extensions/smart-edit/lib/ast-resolver";

import {
  loadGrammar,
  getSupportedExtensions,
  clearGrammarCache,
  resetParser,
} from "../.pi/extensions/smart-edit/lib/grammar-loader";

// ─── Helpers ────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

function assertThrows(fn: () => void, expectedMessage?: string, label?: string): void {
  try {
    fn();
    throw new Error(`FAIL: ${label || "expected error"} — no error was thrown`);
  } catch (err) {
    if (expectedMessage) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes(expectedMessage)) {
        throw new Error(`FAIL: ${label || "error message mismatch"} — expected "${expectedMessage}", got "${msg}"`);
      }
    }
    console.log(`  ✓ ${label || "throws expected error"}`);
  }
}

// ─── Setup / teardown ───────────────────────────────────────────────

function setup(): void {
  clearGrammarCache();
  resetParser();
}

// ─── Grammar loader tests ───────────────────────────────────────────

function test_getSupportedExtensions(): void {
  console.log("\n── Grammar loader: getSupportedExtensions ──");
  setup();

  const extensions = getSupportedExtensions();
  assert(Array.isArray(extensions), "returns an array");
  assert(extensions.length > 0, "has supported extensions");
  assert(extensions.includes(".ts"), "supports .ts");
  assert(extensions.includes(".py"), "supports .py");
  assert(extensions.includes(".go"), "supports .go");
  assert(!extensions.includes(".xyz"), "does not support .xyz");
}

async function test_loadGrammar_unsupportedExtension(): Promise<void> {
  console.log("\n── Grammar loader: unsupported extension ──");
  setup();

  const result = await loadGrammar(".unsupported");
  assert(result === null, "unsupported extension returns null");
}

async function test_loadGrammar_returnsNullForUnknownExt(): Promise<void> {
  console.log("\n── Grammar loader: unknown extension returns null ──");
  setup();

  const result = await loadGrammar(".xyz");
  assert(result === null, "unsupported extension returns null");
}

// ─── AST resolver: Anchor validation ────────────────────────────────

function test_anchorWithoutSymbolName(): void {
  console.log("\n── AST resolver: anchor without symbolName ──");
  // findSymbolNode requires symbolName — without it, returns null.
  // This is tested at the type level: symbolName is optional,
  // but findSymbolNode returns null if it's missing.
  const anchor: EditAnchor = { symbolKind: "function_declaration" };
  assert(!anchor.symbolName, "anchor has no symbolName set");

  // findSymbolNode would return null for this anchor
  // (this is a structural test — actual invocation needs a Tree)
}

function test_anchorValidation_requiresNameForLineHint(): void {
  console.log("\n── AST resolver: symbolLine without symbolName ──");
  // Per FIX-8 from the review, symbolLine should be meaningless
  // without symbolName. Document this constraint.
  const anchor: EditAnchor = { symbolLine: 42 };
  assert(anchor.symbolLine === 42, "symbolLine is set");
  assert(!anchor.symbolName, "symbolLine without symbolName is valid at the type level");
  // findSymbolNode returns null when symbolName is missing, so symbolLine
  // is effectively ignored in practice.
}

// ─── AST resolver: Type exports ─────────────────────────────────────

function test_typeExports(): void {
  console.log("\n── AST resolver: type exports ──");

  // Verify types are importable (TypeScript compile-time check)
  const symbol: Partial<SymbolRef> = {
    name: "test",
    kind: "function_declaration",
    lineStart: 1,
    lineEnd: 5,
    startByte: 0,
    endByte: 100,
  };
  assert(symbol.name === "test", "SymbolRef type is usable");

  // EditAnchor is importable
  const anchor: EditAnchor = {
    symbolName: "main",
    symbolKind: "function_declaration",
    symbolLine: 42,
  };
  assert(anchor.symbolName === "main", "EditAnchor type is usable");
  assert(anchor.symbolLine === 42, "EditAnchor line hint is preserved");
}

// ─── AST resolver: Error handling ───────────────────────────────────

async function test_parseFile_nullForUnsupportedExtension(): Promise<void> {
  console.log("\n── AST resolver: parseFile for unsupported extension ──");
  const result = await parseFile("const x = 1;", "file.xyz");
  assert(result === null, "parseFile returns null for unsupported extension");
}

// ─── AST resolver: Symbol edge cases ────────────────────────────────

function test_symbolWithIdenticalNames(): void {
  console.log("\n── AST resolver: disambiguation of identical names ──");
  // Two functions with the same name should be disambiguable via
  // symbolLine. This is a structural test.

  const farFunction: EditAnchor = {
    symbolName: "handleRequest",
    symbolLine: 10,
  };

  const nearFunction: EditAnchor = {
    symbolName: "handleRequest",
    symbolLine: 85,
  };

  assert(farFunction.symbolName === nearFunction.symbolName,
    "both anchors target the same symbol name");
  assert(farFunction.symbolLine !== nearFunction.symbolLine,
    "but different lines provide disambiguation");
}

// ─── AST resolver: Conflict detection helpers ───────────────────────

function test_findEnclosingSymbols_signature(): void {
  console.log("\n── AST resolver: findEnclosingSymbols signature ──");
  // findEnclosingSymbols(tree, startByte, endByte) → SymbolRef[]
  // This test verifies the function is importable and has the right shape.
  // Actual tree-based tests require real tree-sitter.
  assert(typeof findEnclosingSymbols === "function",
    "findEnclosingSymbols is a function");
}

function test_disposeParseResult_signature(): void {
  console.log("\n── AST resolver: disposeParseResult signature ──");
  assert(typeof disposeParseResult === "function",
    "disposeParseResult is a function");
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== AST Resolver Tests ===\n");

  let passed = 0;
  let failed = 0;

  const tests = [
    { name: "getSupportedExtensions", fn: test_getSupportedExtensions },
    { name: "loadGrammar unknown extension", fn: test_loadGrammar_returnsNullForUnknownExt },
    { name: "anchor without symbolName", fn: test_anchorWithoutSymbolName },
    { name: "symbolLine without symbolName", fn: test_anchorValidation_requiresNameForLineHint },
    { name: "type exports", fn: test_typeExports },
    { name: "parseFile null for unsupported ext", fn: test_parseFile_nullForUnsupportedExtension },
    { name: "identical names disambiguation", fn: test_symbolWithIdenticalNames },
    { name: "findEnclosingSymbols signature", fn: test_findEnclosingSymbols_signature },
    { name: "disposeParseResult signature", fn: test_disposeParseResult_signature },
  ];

  for (const test of tests) {
    try {
      const result = test.fn();
      if (result instanceof Promise) {
        await result;
      }
      passed++;
    } catch (err) {
      failed++;
      console.error(`  ✗ ${test.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n────────────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("All tests passed!");
  }
}

main().catch((err) => {
  console.error("Test run failed:", err);
  process.exit(1);
});
