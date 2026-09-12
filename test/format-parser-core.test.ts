import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePatchText, PatchCursor } from '../src/formats/patch-parser-core';
import { parseCodexPatch } from '../src/formats/codex-patch';
import { parseAtomicPatchEnvelope } from '../src/formats/atomic-patch';
import { parseOpenAIPatch } from '../src/formats/openai-patch';

describe('patch-parser-core: normalizePatchText', () => {
  it('normalizes CRLF to LF', () => {
    assert.equal(normalizePatchText('a\r\nb\r\n'), 'a\nb\n');
  });
  it('normalizes lone CR to LF', () => {
    assert.equal(normalizePatchText('a\rb\r'), 'a\nb\n');
  });
  it('strips BOM only when stripBOM:true', () => {
    assert.equal(normalizePatchText('\uFEFFabc'), '\uFEFFabc');
    assert.equal(normalizePatchText('\uFEFFabc', { stripBOM: true }), 'abc');
  });
  it('combines CRLF + BOM handling', () => {
    assert.equal(
      normalizePatchText('\uFEFFa\r\nb\rc\n', { stripBOM: true }),
      'a\nb\nc\n',
    );
  });
});

describe('patch-parser-core: PatchCursor', () => {
  it('tracks line/col on advance', () => {
    const c = new PatchCursor('ab\ncd');
    assert.equal(c.lineNumber, 1);
    assert.equal(c.columnNumber, 1);
    c.advance(); // a
    assert.equal(c.columnNumber, 2);
    c.advance(); // b
    c.advance(); // \n
    assert.equal(c.lineNumber, 2);
    assert.equal(c.columnNumber, 1);
  });
  it('consumeLine returns text without newline and advances line', () => {
    const c = new PatchCursor('foo\nbar');
    assert.equal(c.consumeLine(), 'foo');
    assert.equal(c.lineNumber, 2);
    assert.equal(c.peekLine(), 'bar');
  });
  it('peekLine does not consume', () => {
    const c = new PatchCursor('hello\nworld');
    assert.equal(c.peekLine(), 'hello');
    assert.equal(c.peekLine(), 'hello');
    assert.equal(c.lineNumber, 1);
  });
  it('skipHorizontalWs skips spaces/tabs only', () => {
    const c = new PatchCursor('  \t x');
    c.skipHorizontalWs();
    assert.equal(c.peek(), 'x');
  });
  it('skipBlankLines skips blanks and restores cursor on non-blank', () => {
    const c = new PatchCursor('  \n\n  key: val');
    c.skipBlankLines();
    assert.equal(c.peekLine(), '  key: val');
    assert.equal(c.lineNumber, 3);
  });
  it('done reports end of input', () => {
    const c = new PatchCursor('');
    assert.equal(c.done(), true);
    const c2 = new PatchCursor('x');
    assert.equal(c2.done(), false);
    c2.consumeLine();
    assert.equal(c2.done(), true);
  });
});

describe('parser integration: shared core preserves behavior', () => {
  it('codex parses CRLF input with correct error line/col', () => {
    const bad = '*** Begin Patch\r\n*** Update File: a.txt\r\n@@\r\n??? bad line\r\n';
    // strict: the bad hunk line surfaces as a parse error at line 4, column 1
    try {
      parseCodexPatch(bad, 'strict');
      assert.fail('expected strict parse of bad CRLF input to throw');
    } catch (e: any) {
      assert.equal(e.line, 4);
      assert.equal(e.column, 1);
    }
    const res = parseCodexPatch(
      '*** Begin Patch\r\n*** Add File: n.txt\r\nhello\r\n*** End Patch\r\n',
      'lenient',
    );
    assert.equal(res.hunks.length, 1);
    assert.equal(res.hunks[0].kind, 'AddFile');
  });
  it('codex strict error preserves line/col', () => {
    assert.throws(() => parseCodexPatch('garbage', 'strict'), (e: any) => {
      assert.equal(e.line, 1);
      assert.equal(e.column, 1);
      return true;
    });
  });
  it('atomic strips BOM, codex does not (explicit option)', () => {
    const withBom =
      '\uFEFF*** Begin Atomic Patch\n*** Add File: f.txt\nbody\n*** End Atomic Patch\n';
    const a = parseAtomicPatchEnvelope(withBom);
    assert.equal(a.envelope.operations.length, 1);
    // codex keeps BOM: the BOM-prefixed Begin marker is unrecognized, so the
    // input is treated as preamble (0 hunks + preamble_skipped warnings).
    const c = parseCodexPatch(
      '\uFEFF*** Begin Patch\n*** Add File: f.txt\nbody\n*** End Patch\n',
      'lenient',
    );
    assert.equal(c.hunks.length, 0);
    assert.ok(c.warnings.some((w) => w.kind === 'preamble_skipped'));
  });
  it('openai parses CRLF update patch', () => {
    const patches = parseOpenAIPatch(
      '*** Begin Patch\r\n*** Update File: a.txt\r\n@@ foo\r\n-old\r\n+new\r\n*** End Patch\r\n',
    );
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].removedLines, ['old']);
    assert.deepEqual(patches[0].addedLines, ['new']);
  });
  it('atomic parses CRLF envelope', () => {
    const r = parseAtomicPatchEnvelope(
      '*** Begin Atomic Patch\r\n*** Add File: f.txt\r\nbody\r\n*** End Atomic Patch\r\n',
    );
    assert.equal(r.envelope.operations.length, 1);
  });
});
