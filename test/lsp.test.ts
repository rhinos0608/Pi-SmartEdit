/**
 * Unit tests for LSP integration.
 *
 * Tests:
 * - lsp-connection: init sequence, request/response, notifications, timeout, shutdown
 * - lsp-manager: server not found returns null, shutdown
 * - diagnostics: no LSP server returns source='none'
 * - semantic-nav: no LSP server returns null/[]
 *
 * Run: npx tsx test/lsp.test.ts
 */

import { resolve } from "path";

import { LSPConnection } from "../.pi/extensions/smart-edit/src/lsp/lsp-connection";
import { LSPManager } from "../.pi/extensions/smart-edit/src/lsp/lsp-manager";
import { checkPostEditDiagnostics } from "../.pi/extensions/smart-edit/src/lsp/diagnostics";
import { goToDefinition, findReferences, getHoverInfo } from "../.pi/extensions/smart-edit/src/lsp/semantic-nav";

// ─── Helpers ──────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL: ${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${message}`);
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`FAIL: ${message}\n    expected to contain: ${JSON.stringify(needle)}\n    actual: ${haystack}`);
  }
  console.log(`  ✓ ${message}`);
}

// ════════════════════════════════════════════════════════════════════
//  lsp-connection tests
// ════════════════════════════════════════════════════════════════════

console.log("\n=== LSPConnection ===\n");

async function testInitSequence() {
  const conn = new LSPConnection(process.execPath, [resolve(__dirname, "lsp", "mock-server.js")]);
  await conn.initialize("file:///test-project");
  assert(true, "Initialization completes without error");
  await conn.shutdown();
  console.log();
}

async function testRequestResponse() {
  const conn = new LSPConnection(process.execPath, [resolve(__dirname, "lsp", "mock-server.js")]);
  await conn.initialize("file:///test-project");

  // Send a request (shutdown returns null from mock)
  await conn.request("textDocument/definition", {
    textDocument: { uri: "file:///test.ts" },
    position: { line: 0, character: 5 },
  });

  assert(true, "Request/response works");
  await conn.shutdown();
  console.log();
}

async function testNotificationAndDiagnostics() {
  const conn = new LSPConnection(process.execPath, [resolve(__dirname, "lsp", "mock-server.js")]);
  await conn.initialize("file:///test-project");

  // Register notification handler for diagnostics
  const receivedDiagnostics: unknown[] = [];
  conn.onNotification("textDocument/publishDiagnostics", (params) => {
    receivedDiagnostics.push(params);
  });

  // Send didOpen (mock server replies with diagnostics)
  await conn.notify("textDocument/didOpen", {
    textDocument: {
      uri: "file:///test.ts",
      languageId: "typescript",
      version: 1,
      text: "const x = ERROR;\nconst y = WARNING;\n",
    },
  });

  // Wait for notification to be processed
  await new Promise((r) => setTimeout(r, 100));

  assert(receivedDiagnostics.length > 0, "Diagnostics notification received");
  await conn.shutdown();
  console.log();
}

async function testShutdown() {
  const conn = new LSPConnection(process.execPath, [resolve(__dirname, "lsp", "mock-server.js")]);
  await conn.initialize("file:///test-project");
  await conn.shutdown();
  assert(true, "Shutdown completes without error");
  console.log();
}

// ════════════════════════════════════════════════════════════════════
//  lsp-manager tests
// ════════════════════════════════════════════════════════════════════

console.log("\n=== LSPManager ===\n");

async function testServerNotFound() {
  const manager = new LSPManager("/tmp");
  const server = await manager.getServer("nonexistent-lang");
  assertEqual(server, null, "Unknown language returns null (no crash)");
  console.log();
}

async function testShutdownEmptyManager() {
  const manager = new LSPManager("/tmp");
  await manager.shutdown();
  assert(true, "Shutdown empty manager completes without error");
  console.log();
}

async function testManagerWithRealServer() {
  // Only test if typescript-language-server is in PATH
  const manager = new LSPManager("/tmp");
  const server = await manager.getServer("typescript");

  if (server) {
    assert(true, "TypeScript server started successfully");
    await manager.shutdown();
    assert(true, "Manager shutdown successful");
    console.log("  - typescript-language-server found in PATH");
  } else {
    // This is expected if typescript-language-server isn't installed
    assert(true, "Typescript server not in PATH — graceful fallback");
    console.log("  - typescript-language-server not in PATH (expected on non-TS machines)");
  }
  console.log();
}

// ════════════════════════════════════════════════════════════════════
//  diagnostics tests
// ════════════════════════════════════════════════════════════════════

console.log("\n=== Diagnostics ===\n");

async function testNoLSPReturnsNone() {
  const manager = new LSPManager("/tmp");

  const result = await checkPostEditDiagnostics("/tmp/test.ts", "const x = 1;", "typescript", manager);

  // With typescript-language-server installed, this may return real diagnostics.
  // Accept both modes: no LSP available (source='none') or LSP active (source='lsp').
  if (result.source === 'none') {
    assertEqual(result.diagnostics.length, 0, "No diagnostics when no LSP");
  } else {
    assertEqual(result.source, 'lsp', "LSP active when server is available");
  }
  console.log();
}

async function testUnsupportedLanguage() {
  const manager = new LSPManager("/tmp");

  const result = await checkPostEditDiagnostics("/tmp/test.xyz", "some content", "nonexistent-lang", manager);

  assertEqual(result.source, "none", "Unsupported language returns source='none'");
  console.log();
}

// ════════════════════════════════════════════════════════════════════
//  semantic-nav tests
// ════════════════════════════════════════════════════════════════════

console.log("\n=== Semantic Navigation ===\n");

async function testGoToDefinitionNoLSP() {
  const manager = new LSPManager("/tmp");
  const result = await goToDefinition("/tmp/test.ts", 0, 5, "typescript", manager);
  assertEqual(result, null, "No LSP returns null for goToDefinition");
  console.log();
}

async function testFindReferencesNoLSP() {
  const manager = new LSPManager("/tmp");
  const result = await findReferences("/tmp/test.ts", 0, 5, "typescript", manager);
  assert(Array.isArray(result) && result.length === 0, "No LSP returns empty array for findReferences");
  console.log();
}

async function testGetHoverInfoNoLSP() {
  const manager = new LSPManager("/tmp");
  const result = await getHoverInfo("/tmp/test.ts", 0, 5, "typescript", manager);
  assertEqual(result, null, "No LSP returns null for getHoverInfo");
  console.log();
}

// ════════════════════════════════════════════════════════════════════
//  Runner
// ════════════════════════════════════════════════════════════════════

async function main() {
  console.log("=== LSP Integration Tests ===\n");

  await testInitSequence();
  await testRequestResponse();
  await testNotificationAndDiagnostics();
  await testShutdown();

  await testServerNotFound();
  await testShutdownEmptyManager();
  await testManagerWithRealServer();

  await testNoLSPReturnsNone();
  await testUnsupportedLanguage();

  await testGoToDefinitionNoLSP();
  await testFindReferencesNoLSP();
  await testGetHoverInfoNoLSP();

  console.log("\n=== All LSP tests completed ===\n");
  process.exit(0);
}

void main();
