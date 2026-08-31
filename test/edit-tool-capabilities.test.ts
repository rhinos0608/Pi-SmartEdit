/**
 * Public edit-tool capability tracers — Task 3 slice.
 *
 * Exercises the registered `edit` tool (createPatchTool.execute) end-to-end:
 * fuzzy similarity, closest-match diagnostics, lineRange/AST scoping and
 * intersection, replaceAll actual-span coverage, literal `$` replacement,
 * overlap rejection, CRLF/BOM preservation, and prior-authority fuzzy spans.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, realpathSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import {
  PROTOCOL_SCHEMA_VERSION,
  hashSessionFilePath,
  resourceIdFor,
  type WorkspaceEvidenceEnvelope,
  type InspectedResource,
} from "@rhinos0608/pi-workspace-protocol";

import { createPatchTool, type PatchToolDeps } from "../src/patch.js";
import { createPriorAuthorityStore } from "../src/evidence-authority.js";
import { initHashline, formatLineHash } from "../src/core/hashline.js";
import type { FileSnapshot } from "../src/core/types.js";
import type { AstResolverLike } from "../src/anchor-resolution.js";
import type { StructuralResolver } from "../src/edit-planner.js";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

type Anchor = { symbolName?: string; symbolKind?: string; symbolLine?: number };

function mockAstResolver(
  resolve: (anchor: Anchor) => { startIndex: number; endIndex: number } | null,
): AstResolverLike {
  // Shared helper for every AST-backed tracer. parseFile runs before
  // findSymbolNode in both the anchor and symbolic paths, so the parsed
  // content captured here supplies byte→row positions for symbolic edits.
  let parsedContent = "";
  return {
    parseFile: async (content) => {
      parsedContent = content;
      return {
        tree: { rootNode: {} },
        content,
        hasErrors: false,
        language: ".ts",
        parser: {} as never,
      } as never;
    },
    findSymbolNode: (_tree, anchor) => {
      const r = resolve(anchor);
      if (!r) return null;
      return {
        startIndex: r.startIndex,
        endIndex: r.endIndex,
        type: "function_declaration",
        startPosition: { row: parsedContent.slice(0, r.startIndex).split("\n").length - 1, column: 0 },
        endPosition: { row: parsedContent.slice(0, r.endIndex).split("\n").length - 1, column: 0 },
      };
    },
    disposeParseResult: () => {},
  };
}

function functionRange(content: string, name: string): { startIndex: number; endIndex: number } {
  const start = content.indexOf(`function ${name}`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const open = content.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) return { startIndex: start, endIndex: i + 1 };
    }
  }
  throw new Error("no closing brace");
}

function makeEnvelope(args: {
  sessionFilePath: string;
  canonicalRoot: string;
  resources: InspectedResource[];
}): WorkspaceEvidenceEnvelope {
  const sessionId = hashSessionFilePath(args.sessionFilePath);
  const resourceKey = [...args.resources]
    .map((r) => `${r.canonicalPath}|${r.kind}|${r.allowedRanges.map((x) => `${x.startLine}-${x.endLine}`).join(",")}`)
    .sort()
    .join("\n");
  const inspectionId = createHash("sha256")
    .update(`inspection|${sessionId}|${args.canonicalRoot}\n${resourceKey}`, "utf8")
    .digest("hex");
  return {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    inspectionId,
    sessionId,
    workspaceRoot: args.canonicalRoot,
    canonicalWorkspaceRoot: args.canonicalRoot,
    createdAt: new Date().toISOString(),
    resources: args.resources,
  };
}

function fullFileResource(canonicalFile: string, content: string): InspectedResource {
  return {
    resourceId: resourceIdFor({ canonicalPath: canonicalFile, kind: "full" }),
    canonicalPath: canonicalFile,
    kind: "full",
    coverage: "full-file",
    allowedRanges: [{ startLine: 1, endLine: content.split("\n").length }],
    fullFileSha256: sha256(content),
    fresh: true,
    lineCount: content.split("\n").length,
  };
}

function lineRangeResource(canonicalFile: string, range: { startLine: number; endLine: number }, content: string): InspectedResource {
  return {
    resourceId: resourceIdFor({ canonicalPath: canonicalFile, kind: "range", range }),
    canonicalPath: canonicalFile,
    kind: "range",
    coverage: "line-range",
    allowedRanges: [range],
    fullFileSha256: sha256(content),
    fresh: true,
    lineCount: range.endLine - range.startLine + 1,
  };
}

async function runTool(opts: {
  workdir: string;
  fileContent: string;
  edits?: unknown[];
  raw?: string;
  additionalFiles?: Record<string, string>;
  astResolver?: AstResolverLike | null;
  structuralResolver?: StructuralResolver | null;
  getSnapshot?: (path: string) => FileSnapshot | null;
  runRepair?: PatchToolDeps["runRepair"];
  runFinalSuccessLanes?: PatchToolDeps["runFinalSuccessLanes"];
  prior?: (canonicalFile: string) => InspectedResource[];
}) {
  const file = join(opts.workdir, "a.ts");
  writeFileSync(file, opts.fileContent, "utf8");
  for (const [relativePath, content] of Object.entries(opts.additionalFiles ?? {})) {
    const target = join(opts.workdir, relativePath);
    mkdirSync(dirname(target), { recursive: true });

    writeFileSync(target, content, "utf8");
  }
  const canonicalFile = realpathSync(file);
  const sessionFilePath = "/sessions/cap.jsonl";
  const store = createPriorAuthorityStore({ sessionFilePath, canonicalWorkspaceRoot: opts.workdir });
  const priorResources = opts.prior
    ? opts.prior(canonicalFile)
    : [fullFileResource(canonicalFile, opts.fileContent), ...Object.entries(opts.additionalFiles ?? {}).map(([relativePath, content]) =>
      fullFileResource(realpathSync(join(opts.workdir, relativePath)), content),
    )];
  if (priorResources.length) store.record(makeEnvelope({ sessionFilePath, canonicalRoot: opts.workdir, resources: priorResources }));
  const deps: PatchToolDeps = {
    getRpcClient: () => ({ request: async () => { throw new Error("unused"); }, dispose: () => {} }),
    getSessionFilePath: () => sessionFilePath,
    getCanonicalWorkspaceRoot: () => opts.workdir,
    getPriorAuthority: () => store,
    getAstResolver: () => opts.astResolver ?? null,
    getStructuralResolver: () => opts.structuralResolver ?? null,
    getSnapshot: opts.getSnapshot ?? (() => null),
    runRepair: opts.runRepair,
    runFinalSuccessLanes: opts.runFinalSuccessLanes,
  };
  const res = await createPatchTool(deps).execute(
    "tc",
    opts.raw === undefined
      ? { path: "a.ts", edits: opts.edits ?? [] }
      : { path: "a.ts", raw: opts.raw }, 
    undefined,
    undefined,
    { cwd: opts.workdir },
  );
  return { res, canonicalFile };
}

const SIM_BLOCK = [
  "const a = 1;",
  "const b = 2;",
  "const c = 3;",
  "const d = 4;",
  "const e = 5;",
  "const f = 6;",
].join("\n");

const SIM_OLD = [
  "const a = 1;",
  "const b = 2;",
  "const c = 3;",
  "const d = 4;",
  "const e = 5;",
  "const f = 7;",
].join("\n");

test("public: fuzzy similarity applies through the tool", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-fuzzy-")));
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: SIM_BLOCK,
    edits: [{ oldText: SIM_OLD, newText: "REPLACED" }],
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(readFileSync(canonicalFile, "utf8"), "REPLACED");
});

test("public: closest-match failure diagnostic", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-closest-")));
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: "alpha\nbeta\ngamma\n",
    edits: [{ oldText: "betta", newText: "B" }],
  });
  const d = res.details as any;
  assert.equal(d.status.kind, "failed");
  assert.equal(d.status.phase, "stage");
  assert.match(String(d.diagnostics ?? ""), /Closest match/i);
  assert.equal(readFileSync(canonicalFile, "utf8"), "alpha\nbeta\ngamma\n", "file must be unchanged");
});

test("public: ambiguous edit returns actionable content", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-ambiguous-")));
  const content = "foo\nbar\nfoo\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ oldText: "foo", newText: "FOO" }],
  });
  assert.equal(res.details.status.kind, "failed");
  assert.match(res.content[0]?.text ?? "", /ambiguous.*context|target\/lineRange|replaceAll/i);
  assert.equal(readFileSync(canonicalFile, "utf8"), content);
});

test("public: lineRange selects a duplicate occurrence", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-linerange-")));
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: "foo\nbar\nfoo\n",
    edits: [{ oldText: "foo", newText: "FOO", lineRange: { startLine: 3, endLine: 3 } }],
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(readFileSync(canonicalFile, "utf8"), "foo\nbar\nFOO\n");
});

test("public: lineRange out-of-range fails unchanged", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-linerange-oob-")));
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: "foo\nbar\nfoo\n",
    edits: [{ oldText: "foo", newText: "FOO", lineRange: { startLine: 10, endLine: 10 } }],
  });
  const d = res.details as any;
  assert.equal(d.status.kind, "failed");
  assert.equal(d.status.phase, "stage");
  assert.equal(readFileSync(canonicalFile, "utf8"), "foo\nbar\nfoo\n", "file must be unchanged");
});

test("public: AST target selects a duplicate occurrence", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-ast-")));
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: "foo\nbar\nfoo\n",
    edits: [{ oldText: "foo", newText: "FOO", target: { name: "foo" } }],
    astResolver: mockAstResolver(() => ({ startIndex: 8, endIndex: 11 })),
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(readFileSync(canonicalFile, "utf8"), "foo\nbar\nFOO\n");
});

test("public: AST+lineRange intersection works", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-intersect-")));
  const content = [
    "function foo() {",
    "  return 1;",
    "}",
    "function bar() {",
    "  return 2;",
    "}",
  ].join("\n");
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [
      {
        oldText: "return 1",
        newText: "return 10",
        target: { name: "foo" },
        lineRange: { startLine: 2, endLine: 2 },
      },
    ],
    astResolver: mockAstResolver((a) => (a.symbolName === "foo" ? functionRange(content, "foo") : null)),
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(readFileSync(canonicalFile, "utf8"), content.replace("return 1", "return 10"));
});

test("public: AST+lineRange disjoint intersection rejects unchanged", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-disjoint-")));
  const content = [
    "function foo() {",
    "  return 1;",
    "}",
    "function bar() {",
    "  return 2;",
    "}",
  ].join("\n");
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [
      {
        oldText: "return 2",
        newText: "return 20",
        target: { name: "foo" },
        lineRange: { startLine: 4, endLine: 6 },
      },
    ],
    astResolver: mockAstResolver((a) => (a.symbolName === "foo" ? functionRange(content, "foo") : null)),
  });
  const d = res.details as any;
  assert.equal(d.status.kind, "failed");
  assert.equal(d.status.phase, "stage");
  assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
});

test("public: replaceAll rejects when an actual span falls outside line-range coverage", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-replaceall-")));
  const content = "foo\nbar\nfoo\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ oldText: "foo", newText: "FOO", replaceAll: true }],
    prior: (cf) => [lineRangeResource(cf, { startLine: 1, endLine: 1 }, content)],
  });
  const d = res.details as any;
  assert.equal(d.status.kind, "rejected");
  assert.equal(d.status.reason, "coverage");
  assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
});

test("public: literal replacement containing $&, $', $` remains literal", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-dollar-")));
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: "alpha\nbeta\ngamma\n",
    edits: [{ oldText: "beta", newText: "B$&$'$`" }],
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(readFileSync(canonicalFile, "utf8"), "alpha\nB$&$'$`\ngamma\n");
});

test("public: overlapping edits reject before write", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-overlap-")));
  const content = "alpha\nbeta\ngamma\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [
      { oldText: "alpha\nbeta", newText: "X" },
      { oldText: "beta\ngamma", newText: "Y" },
    ],
  });
  const d = res.details as any;
  assert.equal(d.status.kind, "failed");
  assert.equal(d.status.phase, "stage");
  assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
});

test("public: BOM and CRLF are preserved", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-crlf-")));
  const content = "\uFEFFalpha\r\nbeta\r\ngamma\r\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ oldText: "beta", newText: "BETA" }],
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(readFileSync(canonicalFile, "utf8"), "\uFEFFalpha\r\nBETA\r\ngamma\r\n");
});

test("public: one prior-authority fuzzy span in-range applies", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-prior-in-")));
  const content = "  alpha\nbeta\n  gamma\n  delta\nepsilon\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ oldText: "    alpha", newText: "ALPHA" }],
    prior: (cf) => [lineRangeResource(cf, { startLine: 1, endLine: 2 }, content)],
  });
  assert.equal(res.details.status.kind, "applied");
  assert.match(readFileSync(canonicalFile, "utf8"), /ALPHA/);
});

test("public: fuzzy span out-of-range rejects under prior line-range", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-prior-out-")));
  const content = "  alpha\nbeta\n  gamma\n  delta\nepsilon\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ oldText: "    delta", newText: "DELTA" }],
    prior: (cf) => [lineRangeResource(cf, { startLine: 1, endLine: 2 }, content)],
  });
  const d = res.details as any;
  assert.equal(d.status.kind, "rejected");
  assert.equal(d.status.reason, "coverage");
  assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
});

// ── Task 4: symbolic and structural public tool tracers ────────────────

// Resolve by symbol name against a fixed content string, reusing `functionRange`.
function nameResolver(content: string) {
  return (anchor: Anchor) => {
    const name = anchor.symbolName;
    if (!name) return null;
    return functionRange(content, name);
  };
}

test("public: symbolic replaceBody reaches registered execute lifecycle", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-sym-replace-")));
  const content = "function keep() { return 1; }\nfunction target() { return 1; }\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ target: { name: "target", replaceBody: "function target() { return 2; }" } }],
    astResolver: mockAstResolver(nameResolver(content)),
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(readFileSync(canonicalFile, "utf8"), "function keep() { return 1; }\nfunction target() { return 2; }\n");
});

test("public: symbolic insertBefore and insertAfter reach execute lifecycle", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-sym-insert-")));
  const content = "function alpha() { return 1; }\nfunction beta() { return 2; }\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [
      { target: { name: "alpha", insertBefore: "const before = true;\n" } },
      { target: { name: "beta", insertAfter: "\nconst after = true;" } },
    ],
    astResolver: mockAstResolver(nameResolver(content)),
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(
    readFileSync(canonicalFile, "utf8"),
    "const before = true;\nfunction alpha() { return 1; }\nfunction beta() { return 2; }\nconst after = true;\n",
  );
});

test("public: structural edit reaches execute lifecycle via injected resolver", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-struct-")));
  const content = "console.log(1);\nconsole.log(2);\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ target: { pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" } }],
    structuralResolver: {
      async resolve() {
        return {
          ok: true,
          edits: [
            { startByte: 0, endByte: 15, text: "logger.info(1);" },
            { startByte: 16, endByte: 31, text: "logger.info(2);" },
          ],
        };
      },
    },
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(readFileSync(canonicalFile, "utf8"), "logger.info(1);\nlogger.info(2);\n");
});

test("public: prior line-range blocks a resolved symbol span outside authority", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-sym-out-")));
  const content = "function alpha() { return 1; }\nfunction beta() { return 2; }\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ target: { name: "beta", replaceBody: "function beta() { return 20; }" } }],
    astResolver: mockAstResolver(nameResolver(content)),
    prior: (cf) => [lineRangeResource(cf, { startLine: 1, endLine: 1 }, content)],
  });
  const d = res.details as any;
  assert.equal(d.status.kind, "rejected");
  assert.equal(d.status.reason, "coverage");
  assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
});

test("public: structural unavailable engine reports explicit failure not silent success", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-struct-unavailable-")));
  const content = "console.log(1);\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ target: { pattern: "console.log($ARG)", replacement: "logger.info($ARG)" } }],
    structuralResolver: {
      async resolve() {
        return { ok: false, error: "ast-grep engine is unavailable in this session; install @ast-grep/napi or use text/symbolic edits" };
      },
    },
  });
  const d = res.details as any;
  assert.equal(d.status.kind, "failed");
  assert.equal(d.status.phase, "stage");
  assert.match(`${d.diagnostics ?? ""}`.toLowerCase() + (res.content[0]?.text ?? "").toLowerCase(), /ast-grep.*unavailable/);
  assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged on unavailable backend");
});

test("public: structural zero matches reports explicit failure not silent success", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-struct-zero-")));
  const content = "console.log(1);\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ target: { pattern: "foo($$$ARGS)", replacement: "bar($$$ARGS)" } }],
    structuralResolver: {
      async resolve() {
        return { ok: true, edits: [] };
      },
    },
  });
  const d = res.details as any;
  assert.equal(d.status.kind, "failed");
  assert.equal(d.status.phase, "stage");
  assert.match(`${d.diagnostics ?? ""}`.toLowerCase() + (res.content[0]?.text ?? "").toLowerCase(), /matched nothing/);
  assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged when pattern matches nothing");
});

test("public: structural freshness mismatch rejects before any write, same as plain text", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-struct-stale-")));
  const content = "console.log(1);\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ target: { pattern: "console.log($ARG)", replacement: "logger.info($ARG)" } }],
    structuralResolver: {
      async resolve() {
        return { ok: true, edits: [{ startByte: 0, endByte: 15, text: "logger.info(1);" }] };
      },
    },
    // prior line-range authority covers the file but carries a stale SHA (different content)
    prior: (cf) => [lineRangeResource(cf, { startLine: 1, endLine: 3 }, "STALE CONTENT\n")],
  });
  const d = res.details as any;
  assert.equal(d.status.kind, "rejected");
  assert.equal(d.status.reason, "stale");
  assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged on stale structural edit");
});

test("public: prior line-range blocks a resolved structural span outside authority", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-struct-out-")));
  const content = "function alpha() { return 1; }\nfunction beta() { return 2; }\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: content,
    edits: [{ target: { pattern: "return $X", replacement: "return $X + 1" } }],
    structuralResolver: {
      async resolve() {
        return { ok: true, edits: [{ startByte: 0, endByte: 5, text: "return 1 + 1" }] };
      },
    },
    prior: (cf) => [lineRangeResource(cf, { startLine: 2, endLine: 2 }, content)],
  });
  const d = res.details as any;
  assert.equal(d.status.kind, "rejected");
  assert.equal(d.status.reason, "coverage");
  assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
});

describe("hashline operations through public execute", () => {
  test("fast path applies a valid anchor", async () => {
    await initHashline();
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-hash-fast-")));
    const content = "alpha\nbeta\ngamma\n";
    const anchor = formatLineHash(2, "beta");
    const { res, canonicalFile } = await runTool({
      workdir,
      fileContent: content,
      edits: [{ hashline: { range: { pos: anchor, end: anchor }, content: ["BETA"] } }],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied");
    assert.equal(readFileSync(canonicalFile, "utf8"), "alpha\nBETA\ngamma\n");
  });

  test("lineRange rejects a valid hashline anchor outside its explicit scope", async () => {
    await initHashline();
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-hash-line-scope-")));
    const content = "alpha\nbeta\ngamma\n";
    const anchor = formatLineHash(2, "beta");
    const { res, canonicalFile } = await runTool({
      workdir,
      fileContent: content,
      edits: [{
        hashline: { range: { pos: anchor, end: anchor }, content: ["BETA"] },
        lineRange: { startLine: 1, endLine: 1 },
      }],
    });
    const details = res.details as { status: { kind: string; phase?: string } };
    assert.equal(details.status.kind, "failed");
    assert.equal(details.status.phase, "stage");
    assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
  });

  test("rebase applies a shifted anchor within the rebase window", async () => {
    await initHashline();
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-hash-rebase-")));
    const content = "alpha\nbeta\ngamma\n";
    const shiftedAnchor = formatLineHash(1, "gamma");
    const { res, canonicalFile } = await runTool({
      workdir,
      fileContent: content,
      edits: [{ hashline: { range: { pos: shiftedAnchor, end: shiftedAnchor }, content: ["GAMMA"] } }],
    });
    assert.equal(res.details.status.kind, "applied");
    assert.equal(readFileSync(canonicalFile, "utf8"), "alpha\nbeta\nGAMMA\n");
  });

  test("AST-scoped fallback applies a stale hashline edit within its symbol", async () => {
    await initHashline();
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-hash-scoped-")));
    const content = "function foo() {\n  return 1;\n}\n";
    const staleAnchor = formatLineHash(99, "nonexistent");
    const snapshot: FileSnapshot = {
      path: "",
      mtimeMs: 0,
      size: content.length,
      contentHash: "",
      readAt: 0,
      readOffset: 1,
      hashline: { anchors: new Map([[staleAnchor, { text: "  return 1;", line: 2 }]]), formattedLines: [] },
    };
    const { res, canonicalFile } = await runTool({
      workdir,
      fileContent: content,
      edits: [{
        hashline: {
          range: { pos: staleAnchor, end: staleAnchor },
          content: ["  return 2;"],
          symbol: { name: "foo" },
        },
      }],
      astResolver: mockAstResolver((anchor) =>
        anchor.symbolName === "foo" ? functionRange(content, "foo") : null,
      ),
      getSnapshot: () => snapshot,
    });
    assert.equal(res.details.status.kind, "applied");
    assert.equal(readFileSync(canonicalFile, "utf8"), "function foo() {\n  return 2;\n}\n");
  });

  test("full fuzzy fallback reconstructs oldText from snapshot", async () => {
    await initHashline();
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-hash-fuzzy-")));
    const content = "alpha\nbeta\ngamma\n";
    const staleAnchor = formatLineHash(99, "nonexistent");
    const snapshot: FileSnapshot = {
      path: "",
      mtimeMs: 0,
      size: content.length,
      contentHash: "",
      readAt: 0,
      readOffset: 1,
      hashline: { anchors: new Map([[staleAnchor, { text: "beta", line: 2 }]]), formattedLines: [] },
    };
    const { res, canonicalFile } = await runTool({
      workdir,
      fileContent: content,
      edits: [{ hashline: { range: { pos: staleAnchor, end: staleAnchor }, content: ["BETA"] } }],
      getSnapshot: () => snapshot,
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "applied");
    assert.equal(readFileSync(canonicalFile, "utf8"), "alpha\nBETA\ngamma\n");
  });

  test("mismatch fails during planning when oldText cannot be reconstructed", async () => {
    await initHashline();
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-hash-mismatch-")));
    const content = "alpha\nbeta\ngamma\n";
    const staleAnchor = formatLineHash(99, "nonexistent");
    const { res, canonicalFile } = await runTool({
      workdir,
      fileContent: content,
      edits: [{ hashline: { range: { pos: staleAnchor, end: staleAnchor }, content: ["BETA"] } }],
      // no getSnapshot → cannot reconstruct → mismatch reject
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "failed");
    assert.equal(d.status.phase, "stage");
    assert.match((d.diagnostics as string[]).join("\n"), /changed since the last read/i);
    assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
  });

  test("prior line-range blocks a resolved hashline fallback span outside authority", async () => {
    await initHashline();
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-hash-out-")));
    const content = "alpha\nbeta\ngamma\n";
    const staleAnchor = formatLineHash(99, "nonexistent");
    const snapshot: FileSnapshot = {
      path: "",
      mtimeMs: 0,
      size: content.length,
      contentHash: "",
      readAt: 0,
      readOffset: 1,
      hashline: { anchors: new Map([[staleAnchor, { text: "beta", line: 2 }]]), formattedLines: [] },
    };
    const { res, canonicalFile } = await runTool({
      workdir,
      fileContent: content,
      edits: [{ hashline: { range: { pos: staleAnchor, end: staleAnchor }, content: ["BETA"] } }],
      getSnapshot: () => snapshot,
      // Prior authority covers only line 1; the fallback's actual changed span
      // is line 2, so it must be rejected rather than broadening authority.
      prior: (cf) => [lineRangeResource(cf, { startLine: 1, endLine: 1 }, content)],
    });
    const d = res.details as any;
    assert.equal(d.status.kind, "rejected");
    assert.equal(d.status.reason, "coverage");
    assert.equal(readFileSync(canonicalFile, "utf8"), content, "file must be unchanged");
  });
});

test("public: repair outside line-range authority is skipped", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-repair-authority-")));
  const before = "const x = 1;\nconst y = 2;\n";
  const { res, canonicalFile } = await runTool({
    workdir,
    fileContent: before,
    edits: [{ oldText: "x = 1", newText: "x = 3", lineRange: { startLine: 1, endLine: 1 } }],
    prior: (file) => [lineRangeResource(file, { startLine: 1, endLine: 1 }, before)],
    runRepair: async () => ({
      passed: true,
      attempts: [],
      finalValidation: null,
      summary: "synthetic repair",
      repairedContent: "const x = 3;\nconst y = 4;\n",
    }),
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(readFileSync(canonicalFile, "utf8"), "const x = 3;\nconst y = 2;\n");
  const details = res.details;
  assert.ok(details.checks.advisory.some((check) => check.id === "repair:a.ts" && check.outcome === "skipped"));
});

test("public: final advisory lanes appear only after a committed transaction", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-final-lanes-")));
  let calls = 0;
  const { res } = await runTool({
    workdir,
    fileContent: "const x = 1;\n",
    edits: [{ oldText: "x = 1", newText: "x = 2" }],
    runFinalSuccessLanes: async ({ files }) => {
      calls++;
      assert.equal(files.length, 1);
      assert.equal(files[0].content, "const x = 2;\n");
      return {
        diagnostics: ["synthetic final diagnostic"],
        checks: [{ id: "synthetic-final", outcome: "pass", detail: "ran after commit" }],
        evidence: { lane: "synthetic" },
      };
    },
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(calls, 1);
  assert.ok(res.details.checks.advisory.some((check) => check.id === "synthetic-final"));
  assert.ok(res.details.diagnostics.includes("synthetic final diagnostic"));
  assert.deepEqual((res.details as { finalization?: unknown }).finalization, { lane: "synthetic" });
});

test("public: final-lane diagnostics are also surfaced in model-visible content, not just details", async () => {
  const { res } = await runTool({
    workdir: realpathSync(mkdtempSync(join(tmpdir(), "cap-final-lanes-content-"))),
    fileContent: "const x = 1;\n",
    edits: [{ oldText: "x = 1", newText: "x = 2" }],
    runFinalSuccessLanes: async () => ({
      diagnostics: ["a.ts:1: type error TS2322"],
      checks: [],
      evidence: null,
    }),
  });
  assert.equal(res.details.status.kind, "applied");
  const text = res.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
  assert.match(text, /Post-edit diagnostics:/);
  assert.match(text, /a\.ts:1: type error TS2322/);
});

test("public: no diagnostics block in content when the final lane reports nothing", async () => {
  const { res } = await runTool({
    workdir: realpathSync(mkdtempSync(join(tmpdir(), "cap-final-lanes-empty-"))),
    fileContent: "const x = 1;\n",
    edits: [{ oldText: "x = 1", newText: "x = 2" }],
    runFinalSuccessLanes: async () => ({ diagnostics: [], checks: [], evidence: null }),
  });
  assert.equal(res.details.status.kind, "applied");
  const text = res.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
  assert.doesNotMatch(text, /Post-edit diagnostics:/);
});

test("public: a failed edit (no match found, never committed) does not get a diagnostics block appended", async () => {
  const { res } = await runTool({
    workdir: realpathSync(mkdtempSync(join(tmpdir(), "cap-final-lanes-failed-"))),
    fileContent: "alpha\nbeta\ngamma\n",
    edits: [{ oldText: "betta", newText: "B" }],
    runFinalSuccessLanes: async () => {
      throw new Error("final lanes must not run for a failed/never-committed edit");
    },
  });
  assert.equal(res.details.status.kind, "failed");
  const text = res.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
  assert.doesNotMatch(text, /Post-edit diagnostics:/);
});

describe("raw formats through public execute", () => {
  test("normalizes every update syntax through the edit lifecycle", async () => {
    const rawFormats = [
      { raw: "a.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE", before: "old\n", after: "new\n" },
      { raw: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new", before: "old\n", after: "new\n" },
      {
        raw: "*** Begin Patch\n*** Update File: a.ts\n@@ context\n-old\n+new\n*** End Patch",
        before: "context\nold\n",
        after: "context\nnew\n",
      },
      { raw: "*** Begin Atomic Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Atomic Patch", before: "old\n", after: "new\n" },
      { raw: '[{"path":"a.ts","oldText":"old","newText":"new",}]', before: "old\n", after: "new\n" },
    ];
    for (const { raw, before, after } of rawFormats) {
      const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-raw-update-")));
      const { res, canonicalFile } = await runTool({ workdir, fileContent: before, raw });
      assert.equal(res.details.status.kind, "applied", raw);
      assert.equal(readFileSync(canonicalFile, "utf8"), after, raw);
    }
  });

  test("preserves embedded paths for multi-file raw updates", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-raw-multi-")));
    const raw = [
      "a.ts", "<<<<<<< SEARCH", "old-a", "=======", "new-a", ">>>>>>> REPLACE",
      "b.ts", "<<<<<<< SEARCH", "old-b", "=======", "new-b", ">>>>>>> REPLACE",
    ].join("\n");
    const { res, canonicalFile } = await runTool({
      workdir,
      fileContent: "old-a\n",
      additionalFiles: { "b.ts": "old-b\n" },
      raw,
    });
    assert.equal(res.details.status.kind, "applied");
    assert.equal(readFileSync(canonicalFile, "utf8"), "new-a\n");
    assert.equal(readFileSync(join(workdir, "b.ts"), "utf8"), "new-b\n");
  });

  test("rejects malformed raw input before writing", async () => {
    const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-raw-malformed-")));
    const { res, canonicalFile } = await runTool({ workdir, fileContent: "old\n", raw: "not json" });
    const details = res.details as { status: { kind: string; phase?: string }; diagnostics: readonly string[] };
    assert.equal(details.status.kind, "failed");
    assert.equal(details.status.phase, "stage");
    assert.ok(details.diagnostics.length > 0);
    assert.equal(readFileSync(canonicalFile, "utf8"), "old\n");
  });

  test("executes raw topology changes through the transaction lifecycle", async () => {
    const cases = [
      { raw: "*** Begin Atomic Patch\n*** Add File: new.ts\nnew\n*** End Atomic Patch", path: "new.ts", content: "new", removesSource: false },
      { raw: "*** Begin Atomic Patch\n*** Delete File: a.ts\n*** End Atomic Patch", path: "a.ts", content: null, removesSource: true },
      { raw: "*** Begin Atomic Patch\n*** Rename File: a.ts -> moved.ts\n*** End Atomic Patch", path: "moved.ts", content: "old\n", removesSource: true },
      { raw: "*** Begin Atomic Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Rename File: a.ts -> moved.ts\n*** End Atomic Patch", path: "moved.ts", content: "new\n", removesSource: true },
      { raw: "*** Begin Patch\n*** Add File: new.ts\nnew\n*** End Patch", path: "new.ts", content: "new", removesSource: false },
      { raw: "*** Begin Patch\n*** Delete File: a.ts\n*** End Patch", path: "a.ts", content: null, removesSource: true },
      { raw: "*** Begin Patch\n*** Update File: a.ts\n*** Move to: moved.ts\n@@ old\n-old\n+new\n*** End Patch", path: "moved.ts", content: "new\n", removesSource: true },
    ];
    for (const { raw, path, content, removesSource } of cases) {
      const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-raw-topology-")));
      const { res } = await runTool({ workdir, fileContent: "old\n", raw });
      const details = res.details as {
        status: { kind: string; phase?: string };
        diagnostics: readonly string[];
        changedResources: ReadonlyArray<{ canonicalPath: string; newFullFileSha256?: string }>;
      };
      assert.equal(details.status.kind, "applied", raw);
      const target = join(workdir, path);
      assert.equal(existsSync(target), content !== null, raw);
      if (content !== null) assert.equal(readFileSync(target, "utf8"), content, raw);
      if (removesSource) assert.equal(existsSync(join(workdir, "a.ts")), false, raw);
      if (raw.includes("Rename File") || raw.includes("Move to:")) {
        assert.equal(details.changedResources.length, 2, "rename must invalidate both paths");
        assert.ok(details.changedResources.some((resource) => resource.canonicalPath === join(workdir, "a.ts") && resource.newFullFileSha256 === undefined));
        assert.ok(details.changedResources.some((resource) => resource.canonicalPath === target && resource.newFullFileSha256 !== undefined));
      }
    }
  });
});

// ── Topology ops flow through the same pipeline as text edits ───────

test("public: raw add of a new file flows through the full pipeline (finalization, evidence, applied count)", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-topo-add-")));
  let finalizationCalls = 0;
  const raw = "*** Begin Atomic Patch\n*** Add File: new.ts\nconst x = 1;\nconst y = 2;\n*** End Atomic Patch";
  const { res } = await runTool({
    workdir,
    fileContent: "unrelated\n",
    raw,
    runFinalSuccessLanes: async ({ files }) => {
      finalizationCalls++;
      assert.equal(files.length, 1);
      assert.equal(files[0].path, join(workdir, "new.ts"));
      assert.equal(files[0].content, "const x = 1;\nconst y = 2;");
      assert.equal(files[0].oldContent, "");
      assert.ok(files[0].changedLineRanges.length > 0, "added content must carry a non-empty changed range for scoping");
      return { diagnostics: [], checks: [], evidence: { lane: "add-test" } };
    },
  });
  const details = res.details as {
    status: { kind: string };
    changedResources: readonly unknown[];
    diffs?: ReadonlyArray<{ path: string; diff: string }>;
    finalization?: unknown;
  };
  assert.equal(details.status.kind, "applied");
  assert.equal(finalizationCalls, 1, "runFinalSuccessLanes must run for a topology-only add, not be skipped");
  assert.equal(details.changedResources.length, 1, "add must be counted in changedResources");
  assert.ok(details.diffs && details.diffs.length === 1);
  assert.equal(details.diffs![0].path, "new.ts");
  assert.match(details.diffs![0].diff, /const x = 1/);
  assert.deepEqual(details.finalization, { lane: "add-test" });
  assert.doesNotMatch(res.content[0].text, /applied 0 edit/, "a topology-only add must not report 'applied 0 edit(s)'");
  assert.match(res.content[0].text, /add/i);
});

test("public: topology delete emits an invalidation and diff entry but skips evidence/finalization", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-topo-delete-")));
  let finalizationCalls = 0;
  const raw = "*** Begin Atomic Patch\n*** Delete File: a.ts\n*** End Atomic Patch";
  const { res } = await runTool({
    workdir,
    fileContent: "old\n",
    raw,
    runFinalSuccessLanes: async () => {
      finalizationCalls++;
      return { diagnostics: [], checks: [], evidence: null };
    },
  });
  const details = res.details as {
    status: { kind: string };
    changedResources: readonly { canonicalPath: string; newFullFileSha256?: string }[];
    diffs?: ReadonlyArray<{ path: string; diff: string }>;
  };
  assert.equal(details.status.kind, "applied");
  assert.equal(finalizationCalls, 0, "delete has no post-edit content to lint/typecheck — finalization must not run");
  assert.equal(details.changedResources.length, 1, "delete must still be counted as a changed resource");
  assert.equal(details.changedResources[0].newFullFileSha256, undefined);
  assert.ok(details.diffs && details.diffs.length === 1);
  assert.equal(details.diffs![0].path, "a.ts");
  assert.match(details.diffs![0].diff, /-\d+ old/, "diff must show the deleted content as removed");
  assert.match(res.content[0].text, /delete/i);
});

test("public: rename + text edit finalizes evidence/diagnostics against the new path, not the deleted old path", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-topo-rename-edit-")));
  let finalizationCalls = 0;
  const raw = "*** Begin Atomic Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Rename File: a.ts -> moved.ts\n*** End Atomic Patch";
  const { res } = await runTool({
    workdir,
    fileContent: "old\n",
    raw,
    runFinalSuccessLanes: async ({ files }) => {
      finalizationCalls++;
      assert.equal(files.length, 1);
      assert.equal(files[0].path, join(workdir, "moved.ts"), "finalization must reference the NEW path, not the deleted old path");
      assert.equal(files[0].content, "new\n");
      return { diagnostics: [], checks: [], evidence: null };
    },
  });
  assert.equal(res.details.status.kind, "applied");
  assert.equal(finalizationCalls, 1, "rename+edit must still finalize exactly once, against the new path");
  assert.equal(existsSync(join(workdir, "a.ts")), false);
  assert.equal(readFileSync(join(workdir, "moved.ts"), "utf8"), "new\n");
  const details = res.details as { diffs?: ReadonlyArray<{ path: string; diff: string }> };
  assert.ok(details.diffs && details.diffs.length === 1);
  assert.equal(details.diffs![0].path, "moved.ts", "displayed diff path should reflect the renamed destination, not the old path");
});

test("public: conflicting topology operations on the same path are rejected before any write", async () => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cap-topo-conflict-")));
  const raw = [
    "*** Begin Atomic Patch",
    "*** Add File: new.ts",
    "hello",
    "*** Delete File: old.ts",
    "*** Rename File: old.ts -> moved.ts",
    "*** End Atomic Patch",
  ].join("\n");
  const { res } = await runTool({
    workdir,
    fileContent: "a-content\n",
    additionalFiles: { "old.ts": "old-content\n" },
    raw,
  });
  const details = res.details as { status: { kind: string; reason?: string }; diagnostics: readonly string[] };
  assert.equal(details.status.kind, "rejected");
  assert.equal(details.status.reason, "conflict");
  const diagnosticText = details.diagnostics.join("\n");
  assert.match(diagnosticText, /old\.ts/);
  assert.match(diagnosticText, /delete/i);
  assert.match(diagnosticText, /rename/i);
  // Rejection must be atomic and clean: nothing on disk was touched.
  assert.equal(readFileSync(join(workdir, "old.ts"), "utf8"), "old-content\n");
  assert.equal(existsSync(join(workdir, "new.ts")), false);
  assert.equal(existsSync(join(workdir, "moved.ts")), false);
});
