# smart-edit LSP diagnostics implementation

Repo path: `<project-root>/extensions/smart-edit`

## Build before running dist snippets

If you want to run `./dist/diagnostic-dispatcher.js` directly, build the extension first:

```bash
npm run build  # or the repo's equivalent TypeScript/bundle build step
```

Without that step, `dist/diagnostic-dispatcher.js` will not exist.

## Runtime helpers

```typescript
import { execFileSync, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

interface DiagnosticResult {
  diagnostics: Diagnostic[];
  source: string;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

async function findInNodeModules(packageName: string, cwd: string): Promise<string | null> {
  const isWin = process.platform === "win32";
  let dir = cwd;

  while (true) {
    const candidates = isWin
      ? [
          path.join(dir, "node_modules", ".bin", `${packageName}.cmd`),
          path.join(dir, "node_modules", ".bin", packageName),
        ]
      : [path.join(dir, "node_modules", ".bin", packageName)];

    for (const full of candidates) {
      try {
        await access(full);
        return full;
      } catch {
        // keep walking upward
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function parseCompilerOutput(output: string): DiagnosticResult {
  // Accept compiler stdout + stderr, normalize multiple compiler formats,
  // and return a DiagnosticResult with source "compiler" (or a more
  // specific source if the parser knows it).
  return { diagnostics: [], source: "compiler" };
}
```

## Compiler runners

- `canRun` should use `execFileSync(..., { timeout })` or an async spawn wrapper.
- `checkTscDiagnostics(filePath, cwd)` should pass `filePath` to `tsc`.
- `checkPyrightDiagnostics(filePath, cwd)` should pass `filePath` to `pyright`.
- `checkCargoDiagnostics(filePath, cwd)` should resolve the nearest `Cargo.toml` and run from that package root.
- `checkGoVetDiagnostics(filePath, cwd)` should resolve the nearest `go.mod` and run from that module root.
- Optional future `checkRuffDiagnostics(filePath, cwd)` should map Ruff severities through a helper like:

```typescript
function ruffSeverityToLspSeverity(severity?: string): 1 | 2 | 3 | 4 {
  switch (severity) {
    case "error": return 1;
    case "warning": return 2;
    case "information": return 3;
    case "hint": return 4;
    default: return 3;
  }
}
```

## Cargo / Go / Pyright notes

- Cargo and Go vet are package/module tools, so target the package root, not the whole repo.
- Guard nested JSON fields before reading `inner.message` or `inner.spans[0]`.
- When a range is missing, use a safe default zero range instead of throwing.

## Test snippet

When testing `checkTscDiagnostics('/tmp/test.ts', '/tmp')`, make sure the build step above already ran so the `dist/` entrypoint exists.
