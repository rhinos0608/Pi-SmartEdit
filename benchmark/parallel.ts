#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let count = 3;
const countIndex = args.indexOf("--count");
if (countIndex !== -1) {
  const raw = Number(args[countIndex + 1]);
  if (!Number.isInteger(raw) || raw < 1 || raw > 16) {
    throw new Error("--count must be an integer from 1 to 16");
  }
  count = raw;
  args.splice(countIndex, 2);
}

function startSlot(index: number): Promise<number> {
  const child = spawn(
    process.execPath,
    ["run", join(here, "compare.ts"), ...args],
    {
      cwd: join(here, ".."),
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    },
   );
  console.log(`parallel benchmark slot ${index + 1}/${count}: pid=${child.pid ?? "unknown"}`);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(signal === null ? (code ?? 1) : 1);
    });
  });
}

const exitCodes = await Promise.all(
  Array.from({ length: count }, (_, index) => startSlot(index)),
);
if (exitCodes.some((code) => code !== 0)) process.exitCode = 1;
