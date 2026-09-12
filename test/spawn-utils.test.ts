import { describe, it } from "node:test";
import assert from "node:assert";
import { buildSpawnTarget, buildSpawnTargets, safeSpawnAsync } from "../src/lsp/spawn-utils.js";

describe("buildSpawnTarget", () => {
  it("routes .cmd through cmd.exe on win32 with one verbatim /c string", () => {
    assert.deepStrictEqual(buildSpawnTarget("npx.cmd", ["--no-install", "eslint"], "win32"), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"npx.cmd ^"--no-install^" ^"eslint^""'],
      windowsVerbatimArguments: true,
    });
  });

  it("routes .bat case-insensitively on win32", () => {
    const target = buildSpawnTarget("TOOL.BAT", [], "win32");
    assert.strictEqual(target.command, "cmd.exe");
    assert.deepStrictEqual(target.args, ["/d", "/s", "/c", '"TOOL.BAT"']);
    assert.strictEqual(target.windowsVerbatimArguments, true);
  });

  it("neutralizes cmd chaining in args", () => {
    const target = buildSpawnTarget("npx.cmd", ["x&whoami.ts"], "win32");
    assert.strictEqual(
      target.args[3],
      '"npx.cmd ^"x^&whoami.ts^""',
      "metachars must be caret-escaped inside quotes",
    );
  });

  it("quotes spaced paths and doubles embedded quotes", () => {
    const target = buildSpawnTarget("eslint.cmd", ["C:\\my dir\\app.ts", 'a"b'], "win32");
    assert.ok(target.args[3].includes('^"C:\\my^ dir\\app.ts^"'));
    assert.ok(target.args[3].includes('^"a\\^"b^"'), `got: ${target.args[3]}`);
  });

  it("leaves extensionless names alone on win32", () => {
    assert.deepStrictEqual(buildSpawnTarget("npx", ["tsc"], "win32"), {
      command: "npx",
      args: ["tsc"],
    });
  });

  it("chains bare names through .cmd/.bat fallbacks on win32", () => {
    const targets = buildSpawnTargets("pyright", ["--outputjson"], "win32");
    assert.strictEqual(targets.length, 3);
    assert.deepStrictEqual(targets[0], { command: "pyright", args: ["--outputjson"] });
    assert.strictEqual(targets[1].command, "cmd.exe");
    assert.ok(targets[1].args[3].startsWith('"pyright.cmd '));
    assert.strictEqual(targets[2].command, "cmd.exe");
    assert.ok(targets[2].args[3].startsWith('"pyright.bat '));
  });

  it("emits one target for extended names on win32", () => {
    assert.strictEqual(buildSpawnTargets("npx.cmd", [], "win32").length, 1);
    assert.strictEqual(buildSpawnTargets("tool.exe", [], "win32").length, 1);
  });

  it("treats dotted directories and version-like names as extensionless on win32", () => {
    for (const command of ["../bin/tool", "../my.dir/tool", "tool-1.2"]) {
      const targets = buildSpawnTargets(command, [], "win32");
      assert.strictEqual(targets.length, 3, command);
      assert.strictEqual(targets[0].command, command);
    }
  });

  it("trims trailing dots before suffixing on win32", () => {
    const targets = buildSpawnTargets("tool.", [], "win32");
    assert.strictEqual(targets.length, 3);
    assert.strictEqual(targets[1].command, "cmd.exe");
    assert.ok(targets[1].args[3].startsWith('"tool.cmd"'));
    assert.ok(targets[1].args[3].includes("tool.cmd") && !targets[1].args[3].includes("tool..cmd"));
    assert.ok(targets[2].args[3].startsWith('"tool.bat"'));
  });

  it("emits one target for executable suffixes on win32", () => {
    for (const command of ["tool.exe", "tool.com"]) {
      assert.strictEqual(buildSpawnTargets(command, [], "win32").length, 1, command);
    }
  });

  it("emits one target off win32", () => {
    assert.strictEqual(buildSpawnTargets("pyright", [], "darwin").length, 1);
  });
});

describe("safeSpawnAsync", () => {
  it("resolves status 0 for an existing executable", async () => {
    const result = await safeSpawnAsync(process.execPath, ["--version"], {
      cwd: process.cwd(),
      timeout: 30_000,
    });
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /v\d+\.\d+/);
  });

  it("resolves status -1 for a missing executable on any OS", async () => {
    const result = await safeSpawnAsync("definitely-missing-binary-xyz-123", [], {
      cwd: process.cwd(),
      timeout: 30_000,
    });
    assert.strictEqual(result.status, -1);
  });

  it("walks the win32 suffix chain for a missing shim", async () => {
    // POSIX: single attempt, ENOENT. Windows: bare ENOENT, then cmd-gated
    // `.cmd` (9009 lookup failure, empty stdout) advances to `.bat`, which
    // also misses — terminal -1 either way.
    const result = await safeSpawnAsync("definitely-missing-shim-xyz-123", [], {
      cwd: process.cwd(),
      timeout: 30_000,
    });
    assert.strictEqual(result.status, -1);
  });

  it("times out a long-running command", async () => {
    const result = await safeSpawnAsync(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      { cwd: process.cwd(), timeout: 500 },
    );
    assert.strictEqual(result.status, -1);
  });

  it("leaves .cmd alone off win32", () => {
    for (const platform of ["darwin", "linux"]) {
      assert.deepStrictEqual(buildSpawnTarget("npx.cmd", ["a"], platform), {
        command: "npx.cmd",
        args: ["a"],
      });
    }
  });
});
