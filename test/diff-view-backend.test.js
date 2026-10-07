'use strict';
// The backend's diff display model (src/diff-view.js) on made-up patches: no git runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const dv = require('../src/diff-view');
const hunks = require('../src/hunks');

const patch = (body) => `diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n${body}`;

test('diffView: one section with decoded lines, CR flags and the staging fingerprint', () => {
  const raw = patch('@@ -1,2 +1,2 @@\n a\n-b\r\n+c\r\n');
  const v = dv.diffView(raw, 'f.txt');
  assert.equal(v.sections.length, 1);
  assert.equal(v.file, v.sections[0]);
  assert.equal(v.truncated, false);
  assert.equal(v.maxLines, dv.DIFF_VIEW_MAX_LINES);
  assert.deepEqual(v.file.hunks[0].lines.map((l) => [l.type, l.text, l.cr]), [['context', 'a', false], ['del', 'b', true], ['add', 'c', true]]);
  assert.equal(v.fingerprint, hunks.fingerprint(hunks.parsePatch(raw, { encoding: 'latin1' })[0]));
  assert.equal(dv.diffView(raw, 'f.txt', { fingerprint: false }).fingerprint, null);
  assert.equal(v.conflict, null);
});

test('diffView: UTF-8 is decoded, other bytes stay Latin-1', () => {
  const utf8 = Buffer.from('é', 'utf8').toString('latin1');
  const v = dv.diffView(patch(`@@ -0,0 +1,2 @@\n+${utf8}\n+\xe9\n`));
  assert.deepEqual(v.file.hunks[0].lines.map((l) => l.text), ['é', 'é']);
});

test('diffView: a line past the per-line cap is clipped (UTF-8 boundary kept) and flagged', () => {
  const long = 'x'.repeat(dv.DIFF_VIEW_MAX_LINE_CHARS + 50);
  const [line] = dv.diffView(patch(`@@ -0,0 +1 @@\n+${long}\n`)).file.hunks[0].lines;
  assert.equal(line.clipped, true);
  assert.equal(line.text.length, dv.DIFF_VIEW_MAX_LINE_CHARS);
  const cap = { lines: 10, chars: 1e9, truncated: false };
  const utf = Buffer.from('é'.repeat(dv.DIFF_VIEW_MAX_LINE_CHARS * 3), 'utf8').toString('latin1');
  const r = dv.displayText(utf, cap);
  assert.equal(r.clipped, true);
  assert.ok(!r.text.includes('�'));
  assert.equal(cap.lines, 9);
});

test('diffView: past the line cap the hunk is truncated; refuseTruncated refuses selections past the view', () => {
  const n = dv.DIFF_VIEW_MAX_LINES + 5;
  const body = `@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+l${i}`).join('\n')}\n`;
  const raw = patch(body);
  const v = dv.diffView(raw);
  assert.equal(v.truncated, true);
  assert.equal(v.file.hunks[0].truncated, true);
  assert.equal(dv.mayTruncate(raw), true);
  const parsed = hunks.parsePatch(raw, { encoding: 'latin1' })[0];
  assert.throws(() => dv.refuseTruncated(raw, parsed, [{ hunk: 0 }]), { kind: 'invalid-args' });
  assert.throws(() => dv.refuseTruncated(raw, parsed, [{ hunk: 0, lines: [n - 1] }]), { kind: 'invalid-args' });
  assert.doesNotThrow(() => dv.refuseTruncated(raw, parsed, [{ hunk: 0, lines: [0, 1] }]));
  assert.equal(dv.mayTruncate(patch('@@ -0,0 +1 @@\n+a\n')), false);
});

test('diffView: combined diff of a conflict, and a modify/delete conflict without one', () => {
  const cc = 'diff --cc f.txt\nindex 1,2..3\n--- a/f.txt\n+++ b/f.txt\n@@@ -1,1 -1,1 +1,5 @@@\n++<<<<<<< ours\n+ a\n++=======\n+ b\n++>>>>>>> theirs\n';
  const v = dv.diffView(cc, 'f.txt');
  assert.equal(v.file, null);
  assert.equal(v.fingerprint, null);
  assert.equal(v.conflict.path, 'f.txt');
  assert.deepEqual(v.conflict.hunks[0].lines.map((l) => l.prefix), ['++', '+ ', '++', '+ ', '++']);
  assert.deepEqual(dv.diffView('* Unmerged path g.txt\n', 'g.txt').conflict, { path: 'g.txt', hunks: [] });
  assert.equal(v.conflict.isBinary, undefined, 'a text conflict');
});

test('diffView: a binary conflict (git 2.51: "Binary files differ", no hunks) is flagged isBinary', () => {
  const cc = 'diff --cc a.png\nindex 4f38e14,3b6e4c8..0000000\nBinary files differ\n';
  assert.deepEqual(dv.diffView(cc, 'a.png').conflict, { path: 'a.png', hunks: [], isBinary: true });
});

test('diffView: a typechange is two sections and has no fingerprint; an empty patch has no file', () => {
  const raw = 'diff --git a/l b/l\ndeleted file mode 120000\nindex 1..0\n--- a/l\n+++ /dev/null\n@@ -1 +0,0 @@\n-t\n\\ No newline at end of file\n'
    + 'diff --git a/l b/l\nnew file mode 100644\nindex 0..2\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+x\n';
  const v = dv.diffView(raw);
  assert.equal(v.sections.length, 2);
  assert.equal(v.fingerprint, null);
  assert.equal(v.sections[0].hunks[0].lines[0].noNewlineAtEof, true);
  assert.deepEqual(dv.diffView(''), { file: null, sections: [], fingerprint: null, conflict: null, truncated: false, maxLines: dv.DIFF_VIEW_MAX_LINES, maxLineChars: dv.DIFF_VIEW_MAX_LINE_CHARS });
});
