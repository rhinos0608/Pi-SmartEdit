import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    findTextLineRange,
    getHashlineAnchorLine,
    computeEditContainingRange,
} from "../src/anchor-resolution.js";
import { findSymbolNode } from "../src/core/ast-resolver.js";

type FakeNode = {
    type: string;
    text: string;
    isNamed: boolean;
    hasError: boolean;
    startIndex: number;
    endIndex: number;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    parent: FakeNode | null;
    childCount: number;
    child(index: number): FakeNode | null;
    childForFieldName(name: string): FakeNode | null;
};

function fakeNode(type: string, text: string, row: number, children: FakeNode[] = [], symbolName?: string): FakeNode {
    const nameNode = symbolName
        ? fakeNode("identifier", symbolName, row)
        : null;
    const allChildren = nameNode ? [nameNode, ...children] : children;
    const node: FakeNode = {
        type,
        text,
        isNamed: true,
        hasError: false,
        startIndex: row * 10,
        endIndex: row * 10 + Math.max(text.length, 1),
        startPosition: { row, column: 0 },
        endPosition: { row, column: text.length },
        parent: null,
        childCount: allChildren.length,
        child: (index) => allChildren[index] ?? null,
        childForFieldName: (name) => name === "name" ? nameNode : null,
    };
    for (const child of allChildren) child.parent = node;
    return node;
}

describe("findSymbolNode", () => {
    const fooBar = fakeNode("method_definition", "bar() {}", 1, [], "bar");
    const bazBar = fakeNode("method_definition", "bar() {}", 10, [], "bar");
    const foo = fakeNode("class_declaration", "class Foo", 0, [fooBar], "Foo");
    const baz = fakeNode("class_declaration", "class Baz", 9, [bazBar], "Baz");
    const root = fakeNode("program", "", 0, [foo, baz]);
    const tree = { rootNode: root } as never;

    test("rejects an ambiguous duplicate symbol name without a line hint", () => {
        assert.equal(findSymbolNode(tree, { symbolName: "bar" }), null);
    });

    test("uses full namePath to select a qualified symbol", () => {
        assert.equal(
            findSymbolNode(tree, { symbolName: "bar", symbolNamePath: "Foo.bar" }),
            fooBar,
        );
    });

    test("uses line hint to disambiguate duplicate names", () => {
        assert.equal(findSymbolNode(tree, { symbolName: "bar", symbolLine: 11 }), bazBar);
    });

    test("matches trailing ancestor component sequence (Outer.Foo.bar → Foo.bar)", () => {
        const innerBar = fakeNode("method_definition", "bar() {}", 2, [], "bar");
        const fooNested = fakeNode("class_declaration", "class Foo", 1, [innerBar], "Foo");
        const outer = fakeNode("class_declaration", "class Outer", 0, [fooNested], "Outer");
        const deepRoot = fakeNode("program", "", 0, [outer]);
        const deepTree = { rootNode: deepRoot } as never;
        assert.equal(
            findSymbolNode(deepTree, { symbolName: "bar", symbolNamePath: "Foo.bar" }),
            innerBar,
        );
    });

    test("dedupes same-name ancestor wrappers in the qualified path", () => {
        const innerArrow = fakeNode("arrow_function", "() => {}", 2, [], "a");
        const methodA = fakeNode("method_definition", "a() {}", 1, [innerArrow], "a");
        const classA = fakeNode("class_declaration", "class A", 0, [methodA], "A");
        const dupRoot = fakeNode("program", "", 0, [classA]);
        const dupTree = { rootNode: dupRoot } as never;
        // Without dedupe the inner arrow's path is "A.a.a" and would not match
        // the qualified anchor "A.a"; dedupe collapses it to "A.a". Line hint
        // picks the innermost (line 3).
        assert.equal(
            findSymbolNode(dupTree, { symbolName: "a", symbolNamePath: "A.a", symbolLine: 3 }),
            innerArrow,
        );
    });

    test("line-only resolution picks innermost symbol containing the line", () => {
        const methodBar = fakeNode("method_definition", "bar() {}", 1, [], "bar");
        const classOuter = fakeNode("class_declaration", "class Outer", 0, [methodBar], "Outer");
        const lineRoot = fakeNode("program", "", 0, [classOuter]);
        const lineTree = { rootNode: lineRoot } as never;
        assert.equal(
            findSymbolNode(lineTree, { symbolKind: "method_definition", symbolLine: 2 }),
            methodBar,
        );
    });
});

describe("findTextLineRange", () => {
    test("finds single-line oldText", () => {
        const content = "line1\nline2\nline3\nline4";
        const result = findTextLineRange(content, "line2");
        assert(result !== null);
        assert.strictEqual(result.startLine, 2);
        assert.strictEqual(result.endLine, 2);
    });

    test("finds multiline oldText", () => {
        const content = "line1\nline2\nline3\nline4\nline5";
        const result = findTextLineRange(content, "line2\nline3");
        assert(result !== null);
        assert.strictEqual(result.startLine, 2);
        assert.strictEqual(result.endLine, 3);
    });

    test("returns null for absent oldText", () => {
        const content = "line1\nline2";
        const result = findTextLineRange(content, "line42");
        assert.strictEqual(result, null);
    });

    test("returns null for empty oldText", () => {
        const content = "line1\nline2";
        const result = findTextLineRange(content, "");
        assert.strictEqual(result, null);
    });

    test("first line match startLine=1", () => {
        const content = "first\nsecond\nthird";
        const result = findTextLineRange(content, "first");
        assert(result !== null);
        assert.strictEqual(result.startLine, 1);
        assert.strictEqual(result.endLine, 1);
    });

    test("last line match endLine correct", () => {
        const content = "a\nb\nc\nd";
        const result = findTextLineRange(content, "d");
        assert(result !== null);
        assert.strictEqual(result.startLine, 4);
        assert.strictEqual(result.endLine, 4);
    });
});

describe("getHashlineAnchorLine", () => {
    test("parses numeric anchor", () => {
        assert.strictEqual(getHashlineAnchorLine("42", 100), 42);
    });

    test("parses LINE+HASH numeric prefix", () => {
        // "12ab" → extracts "12"
        const result = getHashlineAnchorLine("12ab", 100);
        assert.strictEqual(result, 12);
    });

    test("returns null for out-of-range numeric", () => {
        assert.strictEqual(getHashlineAnchorLine("999", 50), null);
    });

    test("handles EOF anchor", () => {
        assert.strictEqual(getHashlineAnchorLine("EOF", 100), 100);
    });

    test("handles end anchor", () => {
        assert.strictEqual(getHashlineAnchorLine("end", 42), 42);
    });

    test("handles start anchor", () => {
        assert.strictEqual(getHashlineAnchorLine("start", 100), 1);
    });

    test("handles BOF anchor", () => {
        assert.strictEqual(getHashlineAnchorLine("BOF", 100), 1);
    });

    test("strips :after suffix", () => {
        assert.strictEqual(getHashlineAnchorLine("7:after", 100), 7);
    });

    test("strips :before suffix", () => {
        assert.strictEqual(getHashlineAnchorLine("7:before", 100), 7);
    });

    test("null for non-numeric, non-special anchor", () => {
        assert.strictEqual(getHashlineAnchorLine("hello", 100), null);
    });

    test("null for empty string", () => {
        assert.strictEqual(getHashlineAnchorLine("", 100), null);
    });

    test("trims whitespace before parsing", () => {
        assert.strictEqual(getHashlineAnchorLine("  42  ", 100), 42);
    });

    test("lower bound (1) is valid", () => {
        assert.strictEqual(getHashlineAnchorLine("1", 100), 1);
    });

    test("upper bound (totalLines) is valid", () => {
        assert.strictEqual(getHashlineAnchorLine("100", 100), 100);
    });

    test("returns null for zero anchor", () => {
        assert.strictEqual(getHashlineAnchorLine("0", 100), null);
    });

    test("returns null for out-of-range above totalLines", () => {
        assert.strictEqual(getHashlineAnchorLine("101", 100), null);
    });
});

describe("computeEditContainingRange", () => {
    test("returns correct range for single edit", () => {
        const content = "a\nb\nc\nd\ne";
        const edits = [{ oldText: "b\nc" }];
        const result = computeEditContainingRange(content, edits as any);
        assert(result !== null);
        assert.strictEqual(result[0], 2);
        assert.strictEqual(result[1], 3);
    });

    test("returns correct range for multiple edits", () => {
        const content = "a\nb\nc\nd\ne\nf";
        const edits = [{ oldText: "b\nc" }, { oldText: "e" }];
        const result = computeEditContainingRange(content, edits as any);
        assert(result !== null);
        assert.strictEqual(result[0], 2);
        assert.strictEqual(result[1], 5);
    });

    test("returns null for edits with no match", () => {
        const content = "a\nb\nc";
        const edits = [{ oldText: "x" }];
        const result = computeEditContainingRange(content, edits as any);
        assert.strictEqual(result, null);
    });

    test("skips edits with empty oldText", () => {
        const content = "a\nb\nc";
        const edits = [{ oldText: "" }, { oldText: "b" }];
        const result = computeEditContainingRange(content, edits as any);
        assert(result !== null);
        assert.strictEqual(result[0], 2);
        assert.strictEqual(result[1], 2);
    });

    test("returns null for empty edits array", () => {
        const content = "a\nb\nc";
        const result = computeEditContainingRange(content, []);
        assert.strictEqual(result, null);
    });

    test("matches first occurrence only", () => {
        const content = "a\nb\na\nb";
        const edits = [{ oldText: "a\nb" }];
        const result = computeEditContainingRange(content, edits as any);
        assert(result !== null);
        assert.strictEqual(result[0], 1);
        assert.strictEqual(result[1], 2);
    });
});
