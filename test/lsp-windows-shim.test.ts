import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { LSPManager } from "../src/lsp/lsp-manager.js";

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function neverStart(): never {
  throw new Error("should not start a server during discovery test");
}

describe("LSPManager Windows .cmd shim discovery", () => {
  const realPlatform = process.platform;
  const realPath = process.env.PATH ?? "";
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lsp-shim-"));
  });

  afterEach(() => {
    setPlatform(realPlatform);
    process.env.PATH = realPath;
  });

  it("resolves a bare name when only tool.cmd exists on PATH (win32)", async () => {
    writeFileSync(join(dir, "tool.cmd"), "@echo off\n");
    process.env.PATH = dir + delimiter + realPath;
    setPlatform("win32");
    const manager = new LSPManager("/tmp", {
      serverConfigs: [{ command: "tool", args: [], languageIds: ["typescript"] }],
      connectionFactory: neverStart,
    });
    assert.strictEqual(await manager.hasSuitableServer("typescript"), true);
  });

  it("resolves a bare name when only tool.bat exists on PATH (win32)", async () => {
    writeFileSync(join(dir, "tool.bat"), "@echo off\n");
    process.env.PATH = dir + delimiter + realPath;
    setPlatform("win32");
    const manager = new LSPManager("/tmp", {
      serverConfigs: [{ command: "tool", args: [], languageIds: ["typescript"] }],
      connectionFactory: neverStart,
    });
    assert.strictEqual(await manager.hasSuitableServer("typescript"), true);
  });

  it("does not resolve tool.cmd for a bare name off win32 (POSIX zero change)", async () => {
    writeFileSync(join(dir, "tool.cmd"), "@echo off\n");
    process.env.PATH = dir + delimiter + realPath;
    setPlatform("darwin");
    const manager = new LSPManager("/tmp", {
      serverConfigs: [{ command: "tool", args: [], languageIds: ["typescript"] }],
      connectionFactory: neverStart,
    });
    assert.strictEqual(await manager.hasSuitableServer("typescript"), false);
  });
});
