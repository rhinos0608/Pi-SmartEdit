/**
 * Edit planner unit tests — Task 3 capability slice.
 *
 * Verifies the planner routes text edits through applyEdits (fuzzy tiers,
 * closest-match diagnostics, replaceAll, literal `$` replacement, AST target
 * scope, lineRange scope, AST+lineRange intersection) and returns actual
 * resolved spans without writing files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planTextEdits } from "../src/edit-planner.js";
import { resolvePatternEdits } from "../src/astgrep-anchor.js";
import { initHashline, formatLineHash } from "../src/core/hashline.js";
import type { FileSnapshot } from "../src/core/types.js";
import type { AstResolverLike } from "../src/anchor-resolution.js";

type Anchor = { symbolName?: string; symbolNamePath?: string; symbolKind?: string; symbolLine?: number };

function rowOfIndex(content: string, byte: number): number {
  // 0-based row for a byte offset: newlines strictly before `byte`.
  return content.slice(0, byte).split("\n").length - 1;
}

function mockAstResolver(
  resolve: (anchor: Anchor) => { startIndex: number; endIndex: number } | null,
): AstResolverLike {
  // parseFile runs before findSymbolNode in both the anchor and symbolic paths,
  // so capturing parsed content here lets rows derive purely from it without a
  // module-level mutable global.
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
        startPosition: { row: rowOfIndex(parsedContent, r.startIndex), column: 0 },
        endPosition: { row: rowOfIndex(parsedContent, r.endIndex), column: 0 },
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

test("fuzzy similarity applies and reports actual span", async () => {
  const r = await planTextEdits({
    content: SIM_BLOCK,
    edits: [{ oldText: SIM_OLD, newText: "REPLACED" }],
    filePath: "x.ts",
    astResolver: null,
  });
  assert.equal(r.newContent, "REPLACED");
  assert.equal(r.matchSpans[0].tier, "similarity");
  assert.deepEqual(r.preimageLineRanges, [{ startLine: 1, endLine: 6 }]);
  assert.ok(r.capabilities.includes("oldText"));
});

test("closest-match failure diagnostic on near-miss", async () => {
  await assert.rejects(
    planTextEdits({
      content: "alpha\nbeta\ngamma\n",
      edits: [{ oldText: "betta", newText: "B" }],
      filePath: "x.ts",
      astResolver: null,
    }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.match(msg, /Closest match/i);
      return true;
    },
  );
});

test("lineRange selects a duplicate occurrence", async () => {
  const r = await planTextEdits({
    content: "foo\nbar\nfoo\n",
    edits: [{ oldText: "foo", newText: "FOO", lineRange: { startLine: 3, endLine: 3 } }],
    filePath: "x.ts",
    astResolver: null,
  });
  assert.equal(r.newContent, "foo\nbar\nFOO\n");
  assert.deepEqual(r.preimageLineRanges, [{ startLine: 3, endLine: 3 }]);
});

test("lineRange constrains similarity ambiguity checks", async () => {
  const content = `${SIM_BLOCK}\nseparator\n${SIM_BLOCK}`;
  const r = await planTextEdits({
    content,
    edits: [{
      oldText: SIM_OLD,
      newText: "REPLACED",
      lineRange: { startLine: 8, endLine: 13 },
    }],
    filePath: "x.ts",
    astResolver: null,
  });
  assert.equal(r.newContent, `${SIM_BLOCK}\nseparator\nREPLACED`);
  assert.deepEqual(r.preimageLineRanges, [{ startLine: 8, endLine: 13 }]);
});

test("lineRange does not accept idempotency evidence outside its scope", async () => {
  await assert.rejects(
    planTextEdits({
      content: "fooFOO\nbar\n",
      edits: [{
        oldText: "foo",
        newText: "FOO",
        lineRange: { startLine: 2, endLine: 2 },
      }],
      filePath: "x.ts",
      astResolver: null,
    }),
    /not found|closest match/i,
  );
});

test("lineRange out-of-range fails before write", async () => {
  await assert.rejects(
    planTextEdits({
      content: "foo\nbar\nfoo\n",
      edits: [{ oldText: "foo", newText: "FOO", lineRange: { startLine: 10, endLine: 10 } }],
      filePath: "x.ts",
      astResolver: null,
    }),
    /out of range/i,
  );
});

test("AST target selects a duplicate occurrence", async () => {
  const content = "foo\nbar\nfoo\n";
  const r = await planTextEdits({
    content,
    edits: [{ oldText: "foo", newText: "FOO", target: { name: "foo" } }],
    filePath: "x.ts",
    astResolver: mockAstResolver(() => ({ startIndex: 8, endIndex: 11 })),
  });
  assert.equal(r.newContent, "foo\nbar\nFOO\n");
  assert.deepEqual(r.preimageLineRanges, [{ startLine: 3, endLine: 3 }]);
  assert.ok(r.capabilities.includes("astAnchor"));
});

test("AST namePath preserves its full qualified identity", async () => {
  const content = "class Foo { bar() { return 1; } }\nclass Baz { bar() { return 2; } }\n";
  const fooStart = content.indexOf("bar()");
  const r = await planTextEdits({
    content,
    edits: [{ oldText: "return 1", newText: "return 10", target: { namePath: "Foo.bar" } }],
    filePath: "x.ts",
    astResolver: mockAstResolver((anchor) => {
      assert.equal(anchor.symbolNamePath, "Foo.bar");
      return { startIndex: fooStart, endIndex: content.indexOf("}", fooStart) + 1 };
    }),
  });
  assert.match(r.newContent, /return 10/);
  assert.match(r.newContent, /return 2/);
});

test("AST target unresolved fails before write", async () => {
  await assert.rejects(
    planTextEdits({
      content: "foo\nbar\n",
      edits: [{ oldText: "foo", newText: "FOO", target: { name: "missing" } }],
      filePath: "x.ts",
      astResolver: mockAstResolver(() => null),
    }),
    /could not resolve AST target/i,
  );
});

test("AST+lineRange intersection works", async () => {
  const content = [
    "function foo() {",
    "  return 1;",
    "}",
    "function bar() {",
    "  return 2;",
    "}",
  ].join("\n");
  const r = await planTextEdits({
    content,
    edits: [
      {
        oldText: "return 1",
        newText: "return 10",
        target: { name: "foo" },
        lineRange: { startLine: 2, endLine: 2 },
      },
    ],
    filePath: "x.ts",
    astResolver: mockAstResolver((a) => (a.symbolName === "foo" ? functionRange(content, "foo") : null)),
  });
  assert.equal(r.newContent, content.replace("return 1", "return 10"));
  assert.deepEqual(r.preimageLineRanges, [{ startLine: 2, endLine: 2 }]);
});

test("AST+lineRange disjoint intersection rejects before write", async () => {
  const content = [
    "function foo() {",
    "  return 1;",
    "}",
    "function bar() {",
    "  return 2;",
    "}",
  ].join("\n");
  await assert.rejects(
    planTextEdits({
      content,
      edits: [
        {
          oldText: "return 2",
          newText: "return 20",
          target: { name: "foo" },
          lineRange: { startLine: 4, endLine: 6 },
        },
      ],
      filePath: "x.ts",
      astResolver: mockAstResolver((a) => (a.symbolName === "foo" ? functionRange(content, "foo") : null)),
    }),
    /do not intersect/i,
  );
});

test("replaceAll returns every actual span", async () => {
  const r = await planTextEdits({
    content: "foo\nbar\nfoo\nqux\nfoo\n",
    edits: [{ oldText: "foo", newText: "FOO", replaceAll: true }],
    filePath: "x.ts",
    astResolver: null,
  });
  assert.equal(r.newContent, "FOO\nbar\nFOO\nqux\nFOO\n");
  assert.deepEqual(r.preimageLineRanges, [
    { startLine: 1, endLine: 1 },
    { startLine: 3, endLine: 3 },
    { startLine: 5, endLine: 5 },
  ]);
  assert.ok(r.capabilities.includes("replaceAll"));
});

test("literal replacement containing $&, $', $` remains literal", async () => {
  const r = await planTextEdits({
    content: "alpha\nbeta\ngamma\n",
    edits: [{ oldText: "beta", newText: "B$&$'$`" }],
    filePath: "x.ts",
    astResolver: null,
  });
  assert.equal(r.newContent, "alpha\nB$&$'$`\ngamma\n");
});

test("overlapping edits reject before write", async () => {
  await assert.rejects(
    planTextEdits({
      content: "alpha\nbeta\ngamma\n",
      edits: [
        { oldText: "alpha\nbeta", newText: "X" },
        { oldText: "beta\ngamma", newText: "Y" },
      ],
      filePath: "x.ts",
      astResolver: null,
    }),
    /overlap/i,
  );
});

test("BOM and CRLF are preserved", async () => {
  const content = "\uFEFFalpha\r\nbeta\r\ngamma\r\n";
  const r = await planTextEdits({
    content,
    edits: [{ oldText: "beta", newText: "BETA" }],
    filePath: "x.ts",
    astResolver: null,
  });
  assert.equal(r.newContent, "\uFEFFalpha\r\nBETA\r\ngamma\r\n");
});

test("missing oldText/newText fails before write", async () => {
  await assert.rejects(
    planTextEdits({
      content: "alpha\nbeta\n",
      edits: [{ description: "noop" } as never],
      filePath: "x.ts",
      astResolver: null,
    }),
    /missing oldText\/newText/i,
  );
});

test("hashline fast path applies through the planner", async () => {
  await initHashline();
  const content = "alpha\nbeta\ngamma\n";
  const anchor = formatLineHash(2, "beta");
  const r = await planTextEdits({
    content,
    edits: [{ hashline: { range: { pos: anchor, end: anchor }, content: ["BETA"] } }],
    filePath: "x.ts",
    astResolver: null,
  });
  assert.equal(r.newContent, "alpha\nBETA\ngamma\n");
  assert.ok(r.capabilities.includes("hashline"));
  assert.deepEqual(r.preimageLineRanges, [{ startLine: 2, endLine: 2 }]);
});

test("hashline full fuzzy fallback reconstructs oldText from snapshot", async () => {
  await initHashline();
  const content = "alpha\nbeta\ngamma\n";
  const staleAnchor = formatLineHash(99, "nonexistent");
  const snapshot: FileSnapshot = {
    path: "x.ts",
    mtimeMs: 0,
    size: content.length,
    contentHash: "",
    readAt: 0,
    readOffset: 1,
    hashline: { anchors: new Map([[staleAnchor, { text: "beta", line: 2 }]]), formattedLines: [] },
  };
  const r = await planTextEdits({
    content,
    edits: [{ hashline: { range: { pos: staleAnchor, end: staleAnchor }, content: ["BETA"] } }],
    filePath: "x.ts",
    astResolver: null,
    getSnapshot: () => snapshot,
  });
  assert.equal(r.newContent, "alpha\nBETA\ngamma\n");
  assert.deepEqual(r.preimageLineRanges, [{ startLine: 2, endLine: 2 }]);
});

test("hashline mismatch rejects when oldText cannot be reconstructed", async () => {
  await initHashline();
  const content = "alpha\nbeta\ngamma\n";
  const staleAnchor = formatLineHash(99, "nonexistent");
  await assert.rejects(
    planTextEdits({
      content,
      edits: [{ hashline: { range: { pos: staleAnchor, end: staleAnchor }, content: ["BETA"] } }],
      filePath: "x.ts",
      astResolver: null,
      // no getSnapshot → snapshot null → cannot reconstruct → mismatch reject
    }),
    /changed since the last read/i,
  );
});

test("hashline rebase applies a shifted anchor within the window", async () => {
  await initHashline();
  const content = "alpha\nbeta\ngamma\n";
  // Anchor claims line 1 but carries gamma's hash (line 3) → rebase to line 3.
  const shiftedAnchor = formatLineHash(1, "gamma");
  const r = await planTextEdits({
    content,
    edits: [{ hashline: { range: { pos: shiftedAnchor, end: shiftedAnchor }, content: ["GAMMA"] } }],
    filePath: "x.ts",
    astResolver: null,
  });
  assert.equal(r.newContent, "alpha\nbeta\nGAMMA\n");
  assert.deepEqual(r.preimageLineRanges, [{ startLine: 3, endLine: 3 }]);
});

test("mixed no-op text + hashline applies the hashline without aborting on the no-op", async () => {
  await initHashline();
  const content = "alpha\nbeta\ngamma\n";
  const anchor = formatLineHash(2, "beta");
  const r = await planTextEdits({
    content,
    edits: [
      { oldText: "beta", newText: "beta" }, // idempotent → text no-op
      { hashline: { range: { pos: anchor, end: anchor }, content: ["BETA"] } },
    ],
    filePath: "x.ts",
    astResolver: null,
  });
  assert.equal(r.newContent, "alpha\nBETA\ngamma\n");
  assert.ok(r.capabilities.includes("hashline"));
});

test("no-op hashline in a mixed batch is skipped (no spurious span)", async () => {
  await initHashline();
  const content = "alpha\nbeta\ngamma\n";
  const anchor = formatLineHash(2, "beta"); // line 2 already equals the target content
  const r = await planTextEdits({
    content,
    edits: [
      { hashline: { range: { pos: anchor, end: anchor }, content: ["beta"] } },
      { oldText: "gamma", newText: "GAMMA" },
    ],
    filePath: "x.ts",
    astResolver: null,
  });
  assert.equal(r.newContent, "alpha\nbeta\nGAMMA\n");
  // The no-op hashline must not contribute an empty mutation or match span.
  assert.ok(!r.matchSpans.some((s) => s.editIndex === 0), "no-op hashline span must be skipped");
});

// ── Task 4: symbolic and structural operations ────────────────────────

test("symbolic replaceBody replaces the whole symbol", async () => {
  const content = "function keep() { return 1; }\nfunction target() { return 1; }\n";
  const r = await planTextEdits({
    content,
    edits: [{ target: { name: "target", replaceBody: "function target() { return 2; }" } }],
    filePath: "x.ts",
    astResolver: mockAstResolver((a) =>
      a.symbolName === "target" ? functionRange(content, "target") : null,
    ),
  });
  assert.equal(r.newContent, "function keep() { return 1; }\nfunction target() { return 2; }\n");
  assert.ok(r.capabilities.includes("symbolicEdit"));
  assert.deepEqual(r.preimageLineRanges, [{ startLine: 2, endLine: 2 }]);
});

test("symbolic insertBefore and insertAfter preserve order", async () => {
  const content = "function alpha() { return 1; }\nfunction beta() { return 2; }\n";
  const r = await planTextEdits({
    content,
    edits: [
      { target: { name: "alpha", insertBefore: "const before = true;\n" } },
      { target: { name: "beta", insertAfter: "\nconst after = true;" } },
    ],
    filePath: "x.ts",
    astResolver: mockAstResolver((a) =>
      a.symbolName === "alpha"
        ? functionRange(content, "alpha")
        : a.symbolName === "beta"
          ? functionRange(content, "beta")
          : null,
    ),
  });
  assert.equal(
    r.newContent,
    "const before = true;\nfunction alpha() { return 1; }\nfunction beta() { return 2; }\nconst after = true;\n",
  );
});

test("symbolic namePath preserves qualified identity", async () => {
  const content = "class Foo { bar() { return 1; } }\nclass Baz { bar() { return 2; } }\n";
  const start = content.indexOf("bar()");
  const end = content.indexOf("}", start) + 1;
  const r = await planTextEdits({
    content,
    edits: [{ target: { namePath: "Foo.bar", replaceBody: "bar() { return 10; }" } }],
    filePath: "x.ts",
    astResolver: mockAstResolver((anchor) => {
      assert.equal(anchor.symbolNamePath, "Foo.bar");
      return { startIndex: start, endIndex: end };
    }),
  });
  assert.match(r.newContent, /return 10/);
  assert.match(r.newContent, /return 2/);
});

test("symbolic replacement must fit explicit lineRange scope", async () => {
  const content = "function target() {\n  return 1;\n}\n";
  await assert.rejects(
    planTextEdits({
      content,
      edits: [{
        target: { name: "target", replaceBody: "function target() { return 2; }" },
        lineRange: { startLine: 2, endLine: 2 },
      }],
      filePath: "x.ts",
      astResolver: mockAstResolver(() => functionRange(content, "target")),
    }),
    /symbolic replaceBody.*outside the explicit scope/i,
  );
});

test("symbolic unresolved target fails before write", async () => {
  const content = "function keep() { return 1; }\n";
  await assert.rejects(
    planTextEdits({
      content,
      edits: [{ target: { name: "nonexistent", replaceBody: "x" } }],
      filePath: "x.ts",
      astResolver: mockAstResolver(() => null),
    }),
    /could not resolve AST target/i,
  );
});

test("symbolic missing identifier fails before write", async () => {
  const content = "function keep() { return 1; }\n";
  await assert.rejects(
    planTextEdits({
      content,
      edits: [{ target: { replaceBody: "x" } as never }],
      filePath: "x.ts",
      astResolver: mockAstResolver(() => null),
    }),
    /needs an identifier/i,
  );
});

test("symbolic requires AST support when resolver is null", async () => {
  await assert.rejects(
    planTextEdits({
      content: "function keep() { return 1; }\n",
      edits: [{ target: { name: "keep", replaceBody: "x" } }],
      filePath: "x.ts",
      astResolver: null,
    }),
    /AST support/i,
  );
});

test("structural success applies resolved pattern edits", async () => {
  const content = "console.log(1);\nconsole.log(2);\n";
  const r = await planTextEdits({
    content,
    edits: [{ target: { pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" } }],
    filePath: "x.ts",
    astResolver: null,
    structuralResolver: {
      async resolve(_c, _f, _p, _r) {
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
  assert.equal(r.newContent, "logger.info(1);\nlogger.info(2);\n");
  assert.ok(r.capabilities.includes("astGrepAnchor"));
});

test("real structural resolution handles Unicode offsets and captured dollar text literally", async (t) => {
  const content = 'const emoji = "😀"; console.log("$&");\n';
  const edits = await resolvePatternEdits(
    content,
    "typescript",
    "console.log($ARG)",
    "logger.info($ARG)",
  );
  if (!edits) {
    t.skip("ast-grep native addon unavailable on this platform");
    return;
  }
  assert.equal(edits.length, 1);
  assert.equal(edits[0].startByte, content.indexOf("console.log"));
  assert.equal(edits[0].text, 'logger.info("$&")');
});

test("structural unavailable engine yields actionable diagnostic", async () => {
  await assert.rejects(
    planTextEdits({
      content: "console.log(1);\n",
      edits: [{ target: { pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" } }],
      filePath: "x.ts",
      astResolver: null,
      structuralResolver: {
        async resolve() {
          return { ok: false, error: "ast-grep engine is unavailable in this session" };
        },
      },
    }),
    /ast-grep engine is unavailable/i,
  );
});

test("structural malformed pattern yields actionable diagnostic", async () => {
  await assert.rejects(
    planTextEdits({
      content: "console.log(1);\n",
      edits: [{ target: { pattern: "(((", replacement: "x" } }],
      filePath: "x.ts",
      astResolver: null,
      structuralResolver: {
        async resolve() {
          return { ok: false, error: "structural pattern failed to match; check the pattern syntax" };
        },
      },
    }),
    /structural pattern failed to match/i,
  );
});

test("structural no matches fails before write", async () => {
  await assert.rejects(
    planTextEdits({
      content: "console.log(1);\n",
      edits: [{ target: { pattern: "foo($$$ARGS)", replacement: "bar($$$ARGS)" } }],
      filePath: "x.ts",
      astResolver: null,
      structuralResolver: {
        async resolve() {
          return { ok: true, edits: [] };
        },
      },
    }),
    /matched nothing/i,
  );
});

test("structural explicit scope filters matches outside scope", async () => {
  const content = "console.log(1);\nconsole.log(2);\n";
  const r = await planTextEdits({
    content,
    edits: [{
      target: { pattern: "console.log($ARG)", replacement: "logger.info($ARG)" },
      lineRange: { startLine: 2, endLine: 2 },
    }],
    filePath: "x.ts",
    astResolver: null,
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
  assert.equal(r.newContent, "console.log(1);\nlogger.info(2);\n");
  assert.deepEqual(r.preimageLineRanges, [{ startLine: 2, endLine: 2 }]);
});

test("structural match outside explicit scope rejects unchanged", async () => {
  const content = "function foo() {\n  console.log(1);\n}\nfunction bar() {\n  console.log(2);\n}\n";
  // foo spans bytes 0..36; a match extending past the scope must be rejected,
  // never silently applied via whole-file fallback.
  await assert.rejects(
    planTextEdits({
      content,
      edits: [
        {
          target: { name: "foo", pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" },
        },
      ],
      filePath: "x.ts",
      astResolver: mockAstResolver((a) =>
        a.symbolName === "foo" ? functionRange(content, "foo") : null,
      ),
      structuralResolver: {
        async resolve() {
          return {
            ok: true,
            edits: [{ startByte: 0, endByte: 40, text: "logger.info(1);" }],
          };
        },
      },
    }),
    /matched nothing.*explicit scope/i,
  );
});

test("structural scope disjoint rejects unchanged", async () => {
  const content = "function foo() {\n  return 1;\n}\nfunction bar() {\n  return 2;\n}\n";
  await assert.rejects(
    planTextEdits({
      content,
      edits: [
        {
          target: { name: "foo", pattern: "return $X", replacement: "return $X + 1" },
          lineRange: { startLine: 4, endLine: 6 },
        },
      ],
      filePath: "x.ts",
      astResolver: mockAstResolver((a) =>
        a.symbolName === "foo" ? functionRange(content, "foo") : null,
      ),
      structuralResolver: {
        async resolve() {
          return { ok: true, edits: [{ startByte: 0, endByte: 5, text: "return 1 + 1" }] };
        },
      },
    }),
    /do not intersect/i,
  );
});

test("mixed text+symbolic non-overlap applies", async () => {
  const content = "function alpha() { return 1; }\nfunction beta() { return 2; }\n";
  const r = await planTextEdits({
    content,
    edits: [
      { oldText: "return 1", newText: "return 10" },
      { target: { name: "beta", replaceBody: "function beta() { return 20; }" } },
    ],
    filePath: "x.ts",
    astResolver: mockAstResolver((a) =>
      a.symbolName === "beta" ? functionRange(content, "beta") : null,
    ),
  });
  assert.equal(
    r.newContent,
    "function alpha() { return 10; }\nfunction beta() { return 20; }\n",
  );
});

test("mixed text+symbolic overlap rejects before write", async () => {
  const content = "function alpha() { return 1; }\n";
  await assert.rejects(
    planTextEdits({
      content,
      edits: [
        { oldText: "return 1", newText: "return 10" },
        { target: { name: "alpha", replaceBody: "function alpha() { return 20; }" } },
      ],
      filePath: "x.ts",
      astResolver: mockAstResolver((a) =>
        a.symbolName === "alpha" ? functionRange(content, "alpha") : null,
      ),
    }),
    /overlap/i,
  );
});

test("same-position zero-length inserts preserve request order", async () => {
  const content = "function alpha() { return 1; }\n";
  const r = await planTextEdits({
    content,
    edits: [
      { target: { name: "alpha", insertBefore: "A" } },
      { target: { name: "alpha", insertBefore: "B" } },
    ],
    filePath: "x.ts",
    astResolver: mockAstResolver((a) =>
      a.symbolName === "alpha" ? functionRange(content, "alpha") : null,
    ),
  });
  assert.ok(r.newContent.startsWith("ABfunction alpha"), r.newContent);
});

test("symbolic multiline replacement normalizes CRLF before restoration", async () => {
  const raw = "function alpha() {\r\n  return 1;\r\n}\r\n";
  const normalized = "function alpha() {\n  return 1;\n}\n";
  const r = await planTextEdits({
    content: raw,
    edits: [{ target: { name: "alpha", replaceBody: "function alpha() {\r\n  return 2;\r\n}" } }],
    filePath: "x.ts",
    astResolver: mockAstResolver(() => functionRange(normalized, "alpha")),
  });
  assert.equal(r.newContent, "function alpha() {\r\n  return 2;\r\n}\r\n");
});

test("symbolic edits preserve BOM and CRLF", async () => {
  const raw = "\uFEFFfunction alpha() { return 1; }\r\nfunction beta() { return 2; }\r\n";
  const normalized = "function alpha() { return 1; }\nfunction beta() { return 2; }\n";
  const r = await planTextEdits({
    content: raw,
    edits: [{ target: { name: "beta", replaceBody: "function beta() { return 20; }" } }],
    filePath: "x.ts",
    astResolver: mockAstResolver((a) =>
      a.symbolName === "beta" ? functionRange(normalized, "beta") : null,
    ),
  });
  assert.equal(
    r.newContent,
    "\uFEFFfunction alpha() { return 1; }\r\nfunction beta() { return 20; }\r\n",
  );
});
