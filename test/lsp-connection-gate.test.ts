import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildSpawnTarget, buildPersistentSpawnTarget } from "../src/lsp/spawn-utils.js";

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("LSPConnection win32 cmd gate (persistent spawn)", () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    setPlatform("win32");
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it("maps a .cmd shim through cmd.exe via the real platform gate", () => {
    const target = buildPersistentSpawnTarget("C:\\tools\\server.cmd", ["--stdio"]);
    const expected = buildSpawnTarget("C:\\tools\\server.cmd", ["--stdio"], "win32");
    assert.equal(target.command, expected.command);
    assert.deepEqual(target.args, expected.args);
    assert.equal(target.windowsVerbatimArguments, true);
  });

  it("maps a .bat shim through cmd.exe via the real platform gate", () => {
    const target = buildPersistentSpawnTarget("C:\\tools\\server.bat", ["--stdio"]);
    assert.equal(target.command, "cmd.exe");
    assert.equal(target.windowsVerbatimArguments, true);
  });

  it("passes non-batch commands through unchanged", () => {
    const target = buildPersistentSpawnTarget("typescript-language-server", ["--stdio"]);
    assert.equal(target.command, "typescript-language-server");
    assert.deepEqual(target.args, ["--stdio"]);
    assert.equal(target.windowsVerbatimArguments, undefined);
  });
});
