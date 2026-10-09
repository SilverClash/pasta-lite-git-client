'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { git, initRepo, write, read, hostileConfig } = require('./helpers');
const { run, DIFF_OPTS, LITERAL_ENV } = require('../src/exec');
const {
  parsePatch, applySelection, fingerprint, decodeForDisplay, stageSelection, unstageSelection, discardSelection,
} = require('../src/hunks');

const lines = (n, f = (i) => `line${i}`) => Array.from({ length: n }, (_, i) => `${f(i + 1)}\n`).join('');
const patchOf = (a, b) => {
  // Real git diff between two texts via --no-index.
  const dir = initRepo({ commits: false });
  write(dir, 'a', a);
  write(dir, 'b', b);
  let text = '';
  try { git(dir, 'diff', '--no-index', '-U3', 'a', 'b'); } catch (e) { text = e.stdout; }
  return parsePatch(text)[0];
};

// ---------------------------------------------------------------- parsePatch

test('parsePatch: multiple files, line numbers, function context', () => {
  const [a, b] = parsePatch([
    'diff --git a/x.txt b/x.txt',
    'index 1111111..2222222 100644',
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -1,3 +1,3 @@ fn()',
    ' one',
    '-two',
    '+TWO',
    ' three',
    'diff --git a/y.txt b/y.txt',
    'index 3333333..4444444 100755',
    '--- a/y.txt',
    '+++ b/y.txt',
    '@@ -2,0 +3,2 @@',
    '+a',
    '+b',
    '',
  ].join('\n'));
  assert.equal(a.oldPath, 'x.txt');
  assert.equal(a.newPath, 'x.txt');
  assert.equal(a.oldMode, '100644');
  assert.equal(a.hunks[0].header, '@@ -1,3 +1,3 @@ fn()');
  assert.deepEqual(a.hunks[0].lines.map((l) => [l.type, l.text, l.oldNo, l.newNo]), [
    ['context', 'one', 1, 1], ['del', 'two', 2, null], ['add', 'TWO', null, 2], ['context', 'three', 3, 3],
  ]);
  assert.equal(b.newMode, '100755');
  assert.deepEqual(b.hunks[0].lines.map((l) => l.newNo), [3, 4]);
  assert.equal(b.hunks[0].oldLines, 0);
});

test('parsePatch: omitted counts, no newline markers, lines that look like headers', () => {
  const [f] = parsePatch([
    'diff --git a/n b/n',
    '--- a/n',
    '+++ b/n',
    '@@ -1 +1,2 @@',
    '--- not a header',
    '\\ No newline at end of file',
    '+++ neither',
    '+x',
    '\\ No newline at end of file',
  ].join('\n'));
  const h = f.hunks[0];
  assert.equal(h.oldLines, 1);
  assert.equal(h.newLines, 2);
  assert.deepEqual(h.lines.map((l) => [l.type, l.text, l.noNewlineAtEof]), [
    ['del', '-- not a header', true], ['add', '++ neither', false], ['add', 'x', true],
  ]);
});

test('parsePatch: rename, copy, mode change, binary', () => {
  const files = parsePatch([
    'diff --git a/old name.txt b/new name.txt',
    'similarity index 90%',
    'rename from old name.txt',
    'rename to new name.txt',
    'index 1..2 100644',
    '--- a/old name.txt\t',
    '+++ b/new name.txt\t',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/c1 b/c2',
    'similarity index 100%',
    'copy from c1',
    'copy to c2',
    'diff --git a/run.sh b/run.sh',
    'old mode 100644',
    'new mode 100755',
    'diff --git a/img.png b/img.png',
    'index 1..2 100644',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n'));
  assert.equal(files.length, 4);
  assert.equal(files[0].isRename, true);
  assert.equal(files[0].oldPath, 'old name.txt');
  assert.equal(files[0].newPath, 'new name.txt');
  assert.equal(files[0].hunks.length, 1);
  assert.equal(files[1].isCopy, true);
  assert.deepEqual([files[1].oldPath, files[1].newPath], ['c1', 'c2']);
  assert.deepEqual([files[2].oldMode, files[2].newMode, files[2].hunks.length], ['100644', '100755', 0]);
  assert.equal(files[3].isBinary, true);
  assert.equal(files[3].newPath, 'img.png');
});

test('parsePatch: real --no-index /dev/null diff, deleted file, unicode and quoted paths', () => {
  const dir = initRepo({ commits: false });
  write(dir, 'ünï cødé.txt', 'héllo 🌍\nwörld\n');
  let text;
  try { git(dir, '-c', 'core.quotePath=false', 'diff', '--no-index', '--', '/dev/null', 'ünï cødé.txt'); } catch (e) { text = e.stdout; }
  const [f] = parsePatch(text);
  assert.equal(f.isNew, true);
  assert.equal(f.oldPath, null);
  assert.equal(f.newPath, 'ünï cødé.txt');
  assert.equal(f.newMode, '100644');
  assert.deepEqual(f.hunks[0].lines.map((l) => l.text), ['héllo 🌍', 'wörld']);

  const [d] = parsePatch([
    'diff --git "a/tab\\there" "b/tab\\there"',
    'deleted file mode 100644',
    'index 1..0',
    '--- "a/tab\\there"',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
  ].join('\n'));
  assert.equal(d.isDeleted, true);
  assert.equal(d.oldPath, 'tab\there');
  assert.equal(d.newPath, null);
  assert.equal(d.hunks[0].lines[0].type, 'del');
  assert.deepEqual(parsePatch(''), []);
});

// ---------------------------------------------------------------- applySelection

const BASE = lines(12);
const TARGET = BASE.replace('line2\n', 'LINE2\n').replace('line11\n', 'line11\nnew\n');

test('applySelection: whole hunk, multiple hunks, nothing', () => {
  const p = patchOf(BASE, TARGET);
  assert.equal(p.hunks.length, 2);
  assert.equal(applySelection(BASE, p, [{ hunk: 0 }]), BASE.replace('line2\n', 'LINE2\n'));
  assert.equal(applySelection(BASE, p, [{ hunk: 1 }]), BASE.replace('line11\n', 'line11\nnew\n'));
  assert.equal(applySelection(BASE, p, [{ hunk: 0 }, { hunk: 1 }]), TARGET);
  assert.equal(applySelection(BASE, p, []), BASE);
});

test('applySelection: single add line, single del line, mixed', () => {
  const p = patchOf(BASE, TARGET);
  const h = p.hunks[0];
  const del = h.lines.findIndex((l) => l.type === 'del');
  const add = h.lines.findIndex((l) => l.type === 'add');
  // Only the add: old line stays, new one is inserted after it.
  assert.equal(applySelection(BASE, p, [{ hunk: 0, lines: [add] }]), BASE.replace('line2\n', 'line2\nLINE2\n'));
  // Only the del: line removed, nothing added.
  assert.equal(applySelection(BASE, p, [{ hunk: 0, lines: [del] }]), BASE.replace('line2\n', ''));
  assert.equal(applySelection(BASE, p, [{ hunk: 0, lines: [del, add] }]), BASE.replace('line2\n', 'LINE2\n'));

  const base = 'a\nb\nc\nd\n';
  const q = patchOf(base, 'a\nB\nC\nd\n');
  const idx = (t) => q.hunks[0].lines.findIndex((l) => l.text === t);
  // Unselected dels stay in place as context; selected adds land at their diff position
  // (after the -b -c block), matching `git add -p` line-edit semantics.
  assert.equal(applySelection(base, q, [{ hunk: 0, lines: [idx('b'), idx('B')] }]), 'a\nc\nB\nd\n');
  assert.equal(applySelection(base, q, [{ hunk: 0, lines: [idx('c'), idx('C')] }]), 'a\nb\nC\nd\n');
});

test('applySelection: reverse undoes selected changes from the target', () => {
  const p = patchOf(BASE, TARGET);
  assert.equal(applySelection(TARGET, p, [{ hunk: 0 }], { reverse: true }), BASE.replace('line11\n', 'line11\nnew\n'));
  assert.equal(applySelection(TARGET, p, [{ hunk: 0 }, { hunk: 1 }], { reverse: true }), BASE);
  const add = p.hunks[0].lines.findIndex((l) => l.type === 'add');
  const del = p.hunks[0].lines.findIndex((l) => l.type === 'del');
  assert.equal(applySelection(TARGET, p, [{ hunk: 0, lines: [add] }], { reverse: true }), TARGET.replace('LINE2\n', ''));
  assert.equal(applySelection(TARGET, p, [{ hunk: 0, lines: [del] }], { reverse: true }), TARGET.replace('LINE2\n', 'line2\nLINE2\n'));
  assert.equal(applySelection(TARGET, p, [], { reverse: true }), TARGET);
});

test('applySelection: CRLF preserved', () => {
  const base = 'a\r\nb\r\nc\r\n';
  const target = 'a\r\nB\r\nc\r\nd\r\n';
  const p = patchOf(base, target);
  assert.equal(applySelection(base, p, p.hunks.map((_, hunk) => ({ hunk }))), target);
  const addD = p.hunks[0].lines.findIndex((l) => l.text === 'd\r');
  assert.equal(applySelection(base, p, [{ hunk: 0, lines: [addD] }]), 'a\r\nb\r\nc\r\nd\r\n');
  assert.equal(applySelection(target, p, [{ hunk: 0 }], { reverse: true }), base);
  // Patch lines without CR applied to a CRLF base (autocrlf-smudged working file).
  const lf = patchOf('a\nb\n', 'a\n');
  assert.equal(applySelection('a\r\n', lf, [{ hunk: 0 }], { reverse: true }), 'a\r\nb\r\n');
});

test('applySelection: no newline at EOF on either side', () => {
  // Adding a trailing newline.
  let p = patchOf('a\nb', 'a\nb\n');
  assert.equal(applySelection('a\nb', p, [{ hunk: 0 }]), 'a\nb\n');
  assert.equal(applySelection('a\nb\n', p, [{ hunk: 0 }], { reverse: true }), 'a\nb');
  // Removing it.
  p = patchOf('a\nb\n', 'a\nb');
  assert.equal(applySelection('a\nb\n', p, [{ hunk: 0 }]), 'a\nb');
  assert.equal(applySelection('a\nb', p, [{ hunk: 0 }], { reverse: true }), 'a\nb\n');
  // Appending after a newline-less last line, taking only the new line.
  p = patchOf('x\na', 'x\na\nb');
  const addB = p.hunks[0].lines.findIndex((l) => l.text === 'b');
  assert.equal(applySelection('x\na', p, [{ hunk: 0, lines: [addB] }]), 'x\na\nb');
  assert.equal(applySelection('x\na', p, [{ hunk: 0 }]), 'x\na\nb');
  // Both sides lack it.
  p = patchOf('a\nb', 'a\nc');
  assert.equal(applySelection('a\nb', p, [{ hunk: 0 }]), 'a\nc');
  assert.equal(applySelection('a\nc', p, [{ hunk: 0 }], { reverse: true }), 'a\nb');
});

test('applySelection: stale on bad indices or mismatched base, binary', () => {
  const p = patchOf(BASE, TARGET);
  assert.throws(() => applySelection(BASE, p, [{ hunk: 5 }]), { kind: 'stale' });
  assert.throws(() => applySelection(BASE, p, [{ hunk: 0, lines: [99] }]), { kind: 'stale' });
  assert.throws(() => applySelection('other\n', p, [{ hunk: 0 }]), { kind: 'stale' });
  assert.throws(() => applySelection('', { isBinary: true, hunks: [] }, []), { kind: 'binary' });
});

// ---------------------------------------------------------------- git-backed

function repoWith(file, content, mode) {
  const dir = initRepo();
  write(dir, file, content);
  if (mode) fs.chmodSync(path.join(dir, file), mode);
  git(dir, 'add', '--', file);
  git(dir, 'commit', '-q', '-m', 'add');
  return dir;
}
const cachedDiff = (dir) => git(dir, 'diff', '--cached', '--no-color');
const wtDiff = (dir) => git(dir, 'diff', '--no-color');
const indexText = (dir, f) => git(dir, 'show', `:${f}`);
const indexBytes = (dir, f) => execFileSync('git', ['show', `:${f}`], { cwd: dir });
const fileBytes = (dir, f) => fs.readFileSync(path.join(dir, f));

// The diff the UI would display (same args as git.js diffWorkdir), parsed from latin1.
async function shownDiff(dir, file, { cached = false, untracked = false } = {}) {
  const args = untracked ? ['diff', '--no-index', ...DIFF_OPTS, '--', '/dev/null', file]
    : ['diff', ...(cached ? ['--cached'] : []), ...DIFF_OPTS, '--', file];
  const { stdout } = await run(dir, args, { diff: true, env: LITERAL_ENV, encoding: 'latin1', okCodes: [0, 1] });
  return parsePatch(stdout, { encoding: 'latin1' })[0];
}

test('stageSelection: one hunk of two', async () => {
  const dir = repoWith('f.txt', BASE);
  write(dir, 'f.txt', TARGET);
  await stageSelection(dir, 'f.txt', [{ hunk: 1 }]);
  assert.equal(indexText(dir, 'f.txt'), BASE.replace('line11\n', 'line11\nnew\n'));
  const cached = cachedDiff(dir);
  assert.match(cached, /^\+new$/m);
  assert.doesNotMatch(cached, /LINE2/);
  const wt = wtDiff(dir);
  assert.match(wt, /^\+LINE2$/m);
  assert.doesNotMatch(wt, /^\+new$/m);
});

test('stageSelection: single line', async () => {
  const dir = repoWith('f.txt', 'a\nb\nc\n');
  write(dir, 'f.txt', 'a\nB\nC\n');
  const h = (await shownDiff(dir, 'f.txt')).hunks[0];
  const iB = h.lines.findIndex((l) => l.text === 'B');
  await stageSelection(dir, 'f.txt', [{ hunk: 0, lines: [iB] }]);
  assert.equal(indexText(dir, 'f.txt'), 'a\nb\nc\nB\n'); // add lands after the kept dels
  assert.equal(read(dir, 'f.txt'), 'a\nB\nC\n');
});

test('unstageSelection: one hunk', async () => {
  const dir = repoWith('f.txt', BASE);
  write(dir, 'f.txt', TARGET);
  git(dir, 'add', 'f.txt');
  await unstageSelection(dir, 'f.txt', [{ hunk: 0 }]);
  assert.equal(indexText(dir, 'f.txt'), BASE.replace('line11\n', 'line11\nnew\n'));
  assert.match(wtDiff(dir), /^\+LINE2$/m);
  // Unstaging the rest restores the HEAD entry exactly.
  await unstageSelection(dir, 'f.txt', [{ hunk: 0 }]);
  assert.equal(cachedDiff(dir), '');
  assert.equal(read(dir, 'f.txt'), TARGET);
});

test('unstageSelection: everything of a new file removes it from the index (also in an empty repo)', async () => {
  for (const commits of [true, false]) {
    const dir = initRepo({ commits });
    write(dir, 'n.txt', 'one\ntwo\n');
    git(dir, 'add', 'n.txt');
    await unstageSelection(dir, 'n.txt', [{ hunk: 0 }]);
    assert.equal(git(dir, 'ls-files', '--', 'n.txt'), '');
    assert.equal(read(dir, 'n.txt'), 'one\ntwo\n');
  }
  // Partial unstage keeps the rest staged.
  const dir = initRepo({ commits: false });
  write(dir, 'n.txt', 'one\ntwo\n');
  git(dir, 'add', 'n.txt');
  await unstageSelection(dir, 'n.txt', [{ hunk: 0, lines: [0] }]);
  assert.equal(indexText(dir, 'n.txt'), 'two\n');
});

test('stageSelection: lines of an untracked file (empty repo)', async () => {
  const dir = initRepo({ commits: false });
  write(dir, 'u.txt', 'a\nb\nc\n');
  await stageSelection(dir, 'u.txt', [{ hunk: 0, lines: [0, 2] }]);
  assert.equal(indexText(dir, 'u.txt'), 'a\nc\n');
  assert.match(git(dir, 'ls-files', '-s', 'u.txt'), /^100644 /);
  assert.match(wtDiff(dir), /^\+b$/m);
});

test('discardSelection: one hunk leaves the others', async () => {
  const dir = repoWith('f.txt', BASE);
  write(dir, 'f.txt', TARGET);
  await discardSelection(dir, 'f.txt', [{ hunk: 0 }]);
  assert.equal(read(dir, 'f.txt'), BASE.replace('line11\n', 'line11\nnew\n'));
  assert.equal(cachedDiff(dir), '');
  // Discard a single added line of an untracked file.
  write(dir, 'u.txt', 'keep\ndrop\n');
  await discardSelection(dir, 'u.txt', [{ hunk: 0, lines: [1] }]);
  assert.equal(read(dir, 'u.txt'), 'keep\n');
});

test('executable file keeps 100755 through stage and discard', { skip: process.platform === 'win32' && 'no executable bit on Windows (git there has core.fileMode=false)' }, async () => {
  const dir = repoWith('run.sh', '#!/bin/sh\necho a\n', 0o755);
  write(dir, 'run.sh', '#!/bin/sh\necho a\necho b\necho c\n');
  await stageSelection(dir, 'run.sh', [{ hunk: 0, lines: [2] }]);
  assert.match(git(dir, 'ls-files', '-s', 'run.sh'), /^100755 /);
  await discardSelection(dir, 'run.sh', [{ hunk: 0 }]);
  assert.ok(fs.statSync(path.join(dir, 'run.sh')).mode & 0o100);
  // New untracked executable.
  write(dir, 'new.sh', 'x\n');
  fs.chmodSync(path.join(dir, 'new.sh'), 0o755);
  await stageSelection(dir, 'new.sh', [{ hunk: 0 }]);
  assert.match(git(dir, 'ls-files', '-s', 'new.sh'), /^100755 /);
});

test('binary files are refused', async () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 1, 2, 3]));
  git(dir, 'add', 'b.bin');
  git(dir, 'commit', '-q', '-m', 'bin');
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 9, 9, 9]));
  await assert.rejects(stageSelection(dir, 'b.bin', [{ hunk: 0 }]), { kind: 'binary' });
  await assert.rejects(discardSelection(dir, 'b.bin', [{ hunk: 0 }]), { kind: 'binary' });
  git(dir, 'add', 'b.bin');
  await assert.rejects(unstageSelection(dir, 'b.bin', [{ hunk: 0 }]), { kind: 'binary' });
  fs.writeFileSync(path.join(dir, 'u.bin'), Buffer.from([0, 1]));
  await assert.rejects(stageSelection(dir, 'u.bin', [{ hunk: 0 }]), { kind: 'binary' });
});

test('stale selection is refused', async () => {
  const dir = repoWith('f.txt', 'a\n');
  write(dir, 'f.txt', 'b\n');
  await assert.rejects(stageSelection(dir, 'f.txt', [{ hunk: 1 }]), { kind: 'stale' });
  await assert.rejects(unstageSelection(dir, 'f.txt', [{ hunk: 0 }]), { kind: 'stale' });
  assert.equal(indexText(dir, 'f.txt'), 'a\n');
});

// ---------------------------------------------------------------- non-UTF-8 content

const ENCODINGS = {
  latin1: Buffer.from('caf\xe9', 'latin1'),
  // "日本語表": 0x5c ('\') and 0x7b ('{') appear as trail bytes.
  shiftJis: Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x95, 0x5c]),
  invalidUtf8: Buffer.from([0xc3, 0x28, 0xff, 0x80, 0xe2, 0x82]),
};
const bline = (s, tag) => Buffer.concat([Buffer.from(`${s} `), tag, Buffer.from('\n')]);
const bfile = (tag, { mod = false, add = false } = {}) => Buffer.concat(
  Array.from({ length: 12 }, (_, i) => i + 1).flatMap((i) => [
    bline(i === 2 && mod ? 'LINE2' : `line${i}`, tag),
    ...(i === 11 && add ? [bline('new', tag)] : []),
  ]),
);

for (const [name, tag] of Object.entries(ENCODINGS)) {
  test(`non-UTF-8 bytes survive stage/unstage/discard (${name})`, async () => {
    const base = bfile(tag);
    const target = bfile(tag, { mod: true, add: true });
    const onlyAdd = bfile(tag, { add: true });
    const dir = repoWith('f.txt', base);
    fs.writeFileSync(path.join(dir, 'f.txt'), target);

    const shown = await shownDiff(dir, 'f.txt');
    assert.equal(shown.hunks.length, 2);
    await stageSelection(dir, 'f.txt', []);
    assert.deepEqual(indexBytes(dir, 'f.txt'), base);
    await stageSelection(dir, 'f.txt', [{ hunk: 1 }], { fingerprint: fingerprint(shown) });
    assert.deepEqual(indexBytes(dir, 'f.txt'), onlyAdd);
    assert.deepEqual(fileBytes(dir, 'f.txt'), target);

    await unstageSelection(dir, 'f.txt', [{ hunk: 0 }]);
    assert.deepEqual(indexBytes(dir, 'f.txt'), base);

    // Single added line, then discards.
    const add = (await shownDiff(dir, 'f.txt')).hunks[1].lines.findIndex((l) => l.type === 'add');
    await stageSelection(dir, 'f.txt', [{ hunk: 1, lines: [add] }]);
    assert.deepEqual(indexBytes(dir, 'f.txt'), onlyAdd);
    await discardSelection(dir, 'f.txt', []);
    assert.deepEqual(fileBytes(dir, 'f.txt'), target);
    await discardSelection(dir, 'f.txt', [{ hunk: 0 }]);
    assert.deepEqual(fileBytes(dir, 'f.txt'), onlyAdd);
    assert.deepEqual(indexBytes(dir, 'f.txt'), onlyAdd);
  });
}

test('decodeForDisplay: UTF-8 when valid, Latin-1 otherwise', () => {
  assert.equal(decodeForDisplay(Buffer.from('héllo 🌍', 'utf8').toString('latin1')), 'héllo 🌍');
  assert.equal(decodeForDisplay('caf\xe9'), 'café');
  assert.equal(decodeForDisplay(''), '');
});

test('parsePatch latin1: paths decoded, line text stays bytes; fingerprint is encoding-independent for UTF-8', () => {
  const dir = initRepo({ commits: false });
  write(dir, 'ü.txt', 'héllo\n');
  let raw;
  try {
    execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-index', '--', '/dev/null', 'ü.txt'], { cwd: dir });
  } catch (e) { raw = e.stdout; }
  const [u] = parsePatch(raw.toString('utf8'));
  const [l] = parsePatch(raw.toString('latin1'), { encoding: 'latin1' });
  assert.equal(l.newPath, 'ü.txt');
  assert.equal(l.encoding, 'latin1');
  assert.equal(decodeForDisplay(l.hunks[0].lines[0].text), 'héllo');
  assert.equal(fingerprint(u), fingerprint(l));
  // Quoted path (core.quotePath=true) with octal UTF-8 escapes.
  const [q] = parsePatch('diff --git "a/\\303\\274.txt" "b/\\303\\274.txt"\n', { encoding: 'latin1' });
  assert.equal(q.newPath, 'ü.txt');
});

// ---------------------------------------------------------------- line endings

test('applySelection: inserted lines keep their own ending in mixed-EOL files', () => {
  const base = 'a\r\nb\nc\n';
  let p = patchOf(base, 'a\r\nb\nNEW\nc\n');
  assert.equal(applySelection(base, p, [{ hunk: 0 }]), 'a\r\nb\nNEW\nc\n');
  p = patchOf(base, 'a\r\nX\r\nb\nc\n');
  assert.equal(applySelection(base, p, [{ hunk: 0 }]), 'a\r\nX\r\nb\nc\n');
  // Reverse restoring an LF line into a mixed file.
  p = patchOf(base, 'a\r\nc\n');
  assert.equal(applySelection('a\r\nc\n', p, [{ hunk: 0 }], { reverse: true }), base);
  // "No newline at EOF" terminator takes the ending of the adjacent line.
  p = patchOf('x\r\na', 'x\r\na\r\nb');
  const addB = p.hunks[0].lines.findIndex((l) => l.text === 'b');
  assert.equal(applySelection('x\r\na', p, [{ hunk: 0, lines: [addB] }]), 'x\r\na\r\nb');
});

test('stageSelection: LF line added to a file containing CRLF is staged as LF', async () => {
  const dir = repoWith('m.txt', 'a\r\nb\nc\n');
  write(dir, 'm.txt', 'a\r\nb\nc\nNEW\n');
  await stageSelection(dir, 'm.txt', [{ hunk: 0 }]);
  assert.deepEqual(indexBytes(dir, 'm.txt'), Buffer.from('a\r\nb\nc\nNEW\n'));
  // CRLF-only file round-trips.
  const d2 = repoWith('c.txt', 'a\r\nb\r\n');
  write(d2, 'c.txt', 'a\r\nB\r\nb\r\nc\r\n');
  await stageSelection(d2, 'c.txt', [{ hunk: 0 }]);
  assert.deepEqual(indexBytes(d2, 'c.txt'), Buffer.from('a\r\nB\r\nb\r\nc\r\n'));
  await discardSelection(d2, 'c.txt', []);
  assert.deepEqual(fileBytes(d2, 'c.txt'), Buffer.from('a\r\nB\r\nb\r\nc\r\n'));
});

test('discardSelection: core.autocrlf working file gets CRLF lines back', async () => {
  const dir = initRepo();
  git(dir, 'config', 'core.autocrlf', 'true');
  write(dir, 'w.txt', 'a\r\nb\r\nc\r\nd\r\n');
  git(dir, 'add', 'w.txt');
  git(dir, 'commit', '-q', '-m', 'crlf');
  assert.deepEqual(indexBytes(dir, 'w.txt'), Buffer.from('a\nb\nc\nd\n'));
  write(dir, 'w.txt', 'a\r\nX\r\nc\r\n');
  await discardSelection(dir, 'w.txt', [{ hunk: 0 }]);
  assert.deepEqual(fileBytes(dir, 'w.txt'), Buffer.from('a\r\nb\r\nc\r\nd\r\n'));
});

// ---------------------------------------------------------------- untracked discard, subdirectories

test('discardSelection: discarding every line of an untracked file deletes it', async () => {
  const dir = initRepo();
  write(dir, 'u.txt', 'a\nb\n');
  await discardSelection(dir, 'u.txt', [{ hunk: 0, lines: [0] }]);
  assert.equal(read(dir, 'u.txt'), 'b\n');
  await discardSelection(dir, 'u.txt', [{ hunk: 0 }]);
  assert.equal(fs.existsSync(path.join(dir, 'u.txt')), false);
  // An empty untracked file with an empty selection is left alone.
  write(dir, 'e.txt', '');
  await discardSelection(dir, 'e.txt', []);
  assert.equal(fs.existsSync(path.join(dir, 'e.txt')), true);
  // A tracked file emptied by discard stays (as an empty file).
  const d2 = repoWith('t.txt', '');
  write(d2, 't.txt', 'x\n');
  await discardSelection(d2, 't.txt', [{ hunk: 0 }]);
  assert.equal(read(d2, 't.txt'), '');
});

test('operations work from a subdirectory cwd (paths are root-relative)', async () => {
  const dir = repoWith('sub/f.txt', BASE);
  const sub = path.join(dir, 'sub');
  write(dir, 'sub/f.txt', TARGET);
  await stageSelection(sub, 'sub/f.txt', [{ hunk: 1 }]);
  assert.equal(indexText(dir, 'sub/f.txt'), BASE.replace('line11\n', 'line11\nnew\n'));
  await unstageSelection(sub, 'sub/f.txt', [{ hunk: 0 }]);
  assert.equal(cachedDiff(dir), '');
  await discardSelection(sub, 'sub/f.txt', [{ hunk: 0 }]);
  assert.equal(read(dir, 'sub/f.txt'), BASE.replace('line11\n', 'line11\nnew\n'));
  // Untracked, executable, from the subdirectory. Windows has no executable bit (chmod only
  // toggles read-only), so there the file is staged as a regular one, as `git add` does.
  write(dir, 'sub/u.sh', 'a\nb\n');
  fs.chmodSync(path.join(dir, 'sub/u.sh'), 0o755);
  await stageSelection(sub, 'sub/u.sh', [{ hunk: 0, lines: [1] }]);
  assert.match(git(dir, 'ls-files', '-s', 'sub/u.sh'), process.platform === 'win32' ? /^100644 / : /^100755 /);
  assert.equal(indexText(dir, 'sub/u.sh'), 'b\n');
  write(dir, 'sub/v.txt', 'v\n');
  await discardSelection(sub, 'sub/v.txt', [{ hunk: 0 }]);
  assert.equal(fs.existsSync(path.join(dir, 'sub/v.txt')), false);
});

// ---------------------------------------------------------------- fingerprints

test('fingerprint: a changed file with the same hunk layout is refused as stale', async () => {
  const dir = repoWith('f.txt', BASE);
  write(dir, 'f.txt', TARGET);
  const fp = fingerprint(await shownDiff(dir, 'f.txt'));
  assert.equal(fp, fingerprint(await shownDiff(dir, 'f.txt')));
  write(dir, 'f.txt', TARGET.replace('LINE2', 'XINE2'));
  assert.equal((await shownDiff(dir, 'f.txt')).hunks.length, 2);
  await assert.rejects(stageSelection(dir, 'f.txt', [{ hunk: 0 }], { fingerprint: fp }), { kind: 'stale' });
  await assert.rejects(discardSelection(dir, 'f.txt', [{ hunk: 0 }], { fingerprint: fp }), { kind: 'stale' });
  assert.equal(indexText(dir, 'f.txt'), BASE);
  assert.equal(read(dir, 'f.txt'), TARGET.replace('LINE2', 'XINE2'));

  // Matching fingerprint proceeds; the staged diff has its own fingerprint.
  const now = fingerprint(await shownDiff(dir, 'f.txt'));
  await stageSelection(dir, 'f.txt', [{ hunk: 0 }], { fingerprint: now });
  assert.equal(indexText(dir, 'f.txt'), BASE.replace('line2\n', 'XINE2\n'));
  const staged = fingerprint(await shownDiff(dir, 'f.txt', { cached: true }));
  await assert.rejects(unstageSelection(dir, 'f.txt', [{ hunk: 0 }], { fingerprint: now }), { kind: 'stale' });
  await unstageSelection(dir, 'f.txt', [{ hunk: 0 }], { fingerprint: staged });
  assert.equal(cachedDiff(dir), '');

  // Untracked file diff.
  write(dir, 'u.txt', 'a\nb\n');
  const ufp = fingerprint(await shownDiff(dir, 'u.txt', { untracked: true }));
  await assert.rejects(stageSelection(dir, 'u.txt', [{ hunk: 0 }], { fingerprint: 'nope' }), { kind: 'stale' });
  await stageSelection(dir, 'u.txt', [{ hunk: 0 }], { fingerprint: ufp });
  assert.equal(indexText(dir, 'u.txt'), 'a\nb\n');
});

test('conflicted paths are refused with kind conflict', async () => {
  const dir = repoWith('c.txt', 'base\n');
  git(dir, 'checkout', '-q', '-b', 'other');
  write(dir, 'c.txt', 'other\n');
  git(dir, 'commit', '-q', '-am', 'other');
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'c.txt', 'main\n');
  git(dir, 'commit', '-q', '-am', 'main');
  try { git(dir, 'merge', '-q', 'other'); } catch { /* conflict expected */ }
  await assert.rejects(stageSelection(dir, 'c.txt', [{ hunk: 0 }]), { kind: 'conflict' });
});

// ---------------------------------------------------------------- hostile config

test('hostile config: hunk boundaries, parsing and results are unchanged', async () => {
  const dir = repoWith('f.txt', BASE);
  hostileConfig(dir);
  write(dir, 'f.txt', TARGET);
  const shown = await shownDiff(dir, 'f.txt');
  assert.equal(shown.hunks.length, 2); // diff.context=5 / interHunkContext=10 would merge them
  assert.equal(shown.newPath, 'f.txt'); // diff.noprefix ignored
  assert.doesNotMatch(shown.hunks[0].header, /\x1b/); // no color
  await stageSelection(dir, 'f.txt', [{ hunk: 1 }], { fingerprint: fingerprint(shown) });
  assert.equal(indexText(dir, 'f.txt'), BASE.replace('line11\n', 'line11\nnew\n'));
  await unstageSelection(dir, 'f.txt', [{ hunk: 0 }]);
  assert.equal(indexText(dir, 'f.txt'), BASE);
  await discardSelection(dir, 'f.txt', [{ hunk: 1 }]);
  assert.equal(read(dir, 'f.txt'), BASE.replace('line2\n', 'LINE2\n'));
  // Untracked lines too.
  write(dir, 'u.txt', lines(12));
  await stageSelection(dir, 'u.txt', [{ hunk: 0, lines: [0, 11] }]);
  assert.equal(indexText(dir, 'u.txt'), 'line1\nline12\n');
  await discardSelection(dir, 'f.txt', [{ hunk: 0 }]);
  assert.equal(read(dir, 'f.txt'), BASE);
});

// ---------------------------------------------------------------- symlink / worktree guard

const { worktreeGuard, writeNoFollow, readNoFollow, testHooks } = require('../src/hunks');

function outsideDir() {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pl-out-')));
  fs.writeFileSync(path.join(d, 'secret.txt'), 'outside\n');
  fs.writeFileSync(path.join(d, 'f.txt'), 'b\n');
  return d;
}
const snapshotDir = (d) => Object.fromEntries(fs.readdirSync(d).map((n) => [n, fs.readFileSync(path.join(d, n), 'utf8')]));
const isKind = (kind) => (e) => e.kind === kind;

// Repo with tracked sub/f.txt, then `sub` replaced by a symlink to `target`.
function repoWithLinkedSub(target) {
  const dir = repoWith('sub/f.txt', 'a\n');
  fs.rmSync(path.join(dir, 'sub'), { recursive: true });
  fs.symlinkSync(target, path.join(dir, 'sub'));
  return dir;
}

test('discardSelection refuses a symlinked file', async () => {
  const outside = outsideDir();
  const before = snapshotDir(outside);
  const dir = initRepo();
  // git tracks the link itself; fs would follow it.
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
  git(dir, 'add', 'link.txt');
  git(dir, 'commit', '-q', '-m', 'link');
  fs.unlinkSync(path.join(dir, 'link.txt'));
  fs.symlinkSync(path.join(outside, 'other.txt'), path.join(dir, 'link.txt'));
  await assert.rejects(discardSelection(dir, 'link.txt', [{ hunk: 0 }]), isKind('symlink'));
  assert.deepEqual(snapshotDir(outside), before);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('discardSelection refuses a symlinked parent: valid, dangling, inside the repo, to .git', async () => {
  const outside = outsideDir();
  const before = snapshotDir(outside);
  // Valid link to a directory outside.
  let dir = repoWithLinkedSub(outside);
  await assert.rejects(discardSelection(dir, 'sub/f.txt', [{ hunk: 0 }]), isKind('symlink'));
  // Dangling link: used to walk up, pass, then fail with a raw ENOENT from mkdir.
  dir = repoWithLinkedSub(path.join(outside, 'missing-dir'));
  await assert.rejects(discardSelection(dir, 'sub/f.txt', [{ hunk: 0 }]), isKind('symlink'));
  assert.equal(fs.existsSync(path.join(outside, 'missing-dir')), false);
  // Link to another directory inside the worktree is refused too (any link component).
  dir = repoWith('sub/f.txt', 'a\n');
  write(dir, 'other/f.txt', 'x\n');
  fs.rmSync(path.join(dir, 'sub'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'other'), path.join(dir, 'sub'));
  await assert.rejects(discardSelection(dir, 'sub/f.txt', [{ hunk: 0 }]), isKind('symlink'));
  assert.equal(read(dir, 'other/f.txt'), 'x\n');
  // `g -> .git`: a write through it would land in the git dir.
  dir = repoWith('g/config', 'a\n');
  const config = read(dir, '.git/config');
  fs.rmSync(path.join(dir, 'g'), { recursive: true });
  fs.symlinkSync('.git', path.join(dir, 'g'));
  await assert.rejects(discardSelection(dir, 'g/config', [{ hunk: 0 }]), isKind('symlink'));
  assert.equal(read(dir, '.git/config'), config);
  assert.deepEqual(snapshotDir(outside), before);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('worktreeGuard: real paths into the git dir or out of the worktree are kind outside', async () => {
  const dir = initRepo();
  const guard = await worktreeGuard(dir);
  assert.equal(guard.check('sub/new.txt'), path.join(fs.realpathSync.native(dir), 'sub', 'new.txt'));
  for (const rel of ['.git/config', '.GIT/config', 'a/../../x', '/etc/passwd', '']) {
    assert.throws(() => guard.check(rel), isKind('outside'), rel);
  }
  // A separate git dir (as in linked worktrees / --separate-git-dir) reached without a '.git' segment.
  const wt = initRepo({ commits: false });
  const gd = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pl-gd-')));
  fs.rmSync(path.join(wt, '.git'), { recursive: true });
  git(wt, 'init', '-q', `--separate-git-dir=${path.join(gd, 'g')}`);
  // Nest the git dir inside the worktree: a real directory, so only the git-dir check stops it.
  const inner = path.join(wt, 'meta');
  fs.renameSync(path.join(gd, 'g'), inner);
  // Rewritten in place: Git for Windows hides the .git file `init --separate-git-dir` writes (even
  // with core.hideDotFiles=false), and Node can't open a hidden file with 'w' (CREATE_ALWAYS: EPERM).
  fs.truncateSync(path.join(wt, '.git'));
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${inner}\n`, { flag: 'r+' });
  const g2 = await worktreeGuard(wt);
  assert.throws(() => g2.check('meta/config'), isKind('outside'));
  assert.throws(() => g2.check('meta/objects/new'), isKind('outside'));
  assert.ok(g2.check('other.txt'));
  fs.rmSync(gd, { recursive: true, force: true });
});

test('worktreeGuard on Windows: NTFS aliases of .git (8.3 name, trailing dots / spaces, streams) are kind outside', async () => {
  // A linked worktree: its '.git' is a pointer file outside any git dir, so only the name stops it.
  const dir = initRepo();
  git(dir, 'branch', 'side');
  const wt = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pl-wt-'))), 'wt');
  git(dir, 'worktree', 'add', '-q', wt, 'side');
  const guard = await worktreeGuard(wt, { platform: 'win32' });
  for (const rel of ['GIT~1', 'git~2', 'sub/GIT~1/x', 'sub\\Git~1', '.git.', '.git ', '.GIT. .', 'a/.git ./b',
    'a.', 'a ', 'f.txt:s', '.git::$INDEX_ALLOCATION', 'sub\\..\\..\\x', 'nul', 'sub/COM1', 'aux.txt', 'Con .x/y']) {
    assert.throws(() => guard.check(rel), isKind('outside'), rel);
  }
  // Ordinary names, a '~' that is no 8.3 alias of .git, and '\' as a separator are fine.
  assert.ok(guard.check('sub\\new.txt'));
  for (const rel of ['git~1x', 'xgit~1', '.gitignore', '.git~1', 'a.b', '.x']) assert.ok(guard.check(rel), rel);
  // On POSIX those are ordinary names ('.git.' is not '.git' there), but '.git' itself never is.
  // (Not on Windows itself, where 'GIT~1' may really be the .git file's short name.)
  if (process.platform !== 'win32') {
    const posix = await worktreeGuard(wt, { platform: 'linux' });
    for (const rel of ['GIT~1', '.git.', 'a.']) assert.ok(posix.check(rel), rel);
    assert.throws(() => posix.check('.git'), isKind('outside'));
  }
  fs.rmSync(path.dirname(wt), { recursive: true, force: true });
});

test('throughDotGit: the canonical path is checked for a .git component (an alias realpath expanded)', () => {
  const { throughDotGit, isDotGitName } = require('../src/worktree-fs')._internal;
  const win = { platform: 'win32' };
  // What realpath makes of 'GIT~1\\x' / 'GI8F2A~1' in a repo at C:\r: the long name.
  assert.equal(throughDotGit('C:\\r\\.git', 'C:\\r', win), true);
  assert.equal(throughDotGit('C:\\r\\sub\\.GIT\\x', 'C:\\r', win), true);
  assert.equal(throughDotGit('C:/r/.git/x', 'C:\\r', win), true, "'/' too");
  assert.equal(throughDotGit('C:\\r\\sub\\f.txt', 'C:\\r', win), false);
  assert.equal(throughDotGit('C:\\r', 'C:\\r', win), false);
  assert.equal(throughDotGit('C:\\.git\\r\\f', 'C:\\.git\\r', win), false, 'only components below the root');
  assert.equal(throughDotGit('/r/sub/.git', '/r', { platform: 'linux' }), true);
  assert.equal(throughDotGit('/r/sub/.Git/x', '/r', { platform: 'darwin' }), true);
  assert.equal(throughDotGit('/r/a\\.git', '/r', { platform: 'linux' }), false, "'\\' is a name character on POSIX");
  assert.equal(throughDotGit('/.git/r/f', '/.git/r', { platform: 'linux' }), false);
  for (const n of ['.git', '.GIT', 'GIT~1', 'git~12', '.git.', '.git  ', 'git~1. ']) assert.equal(isDotGitName(n, win), true, n);
  for (const n of ['.gitx', 'git', 'git~', 'git~1x', '.git~1', 'x.git']) assert.equal(isDotGitName(n, win), false, n);
  assert.equal(isDotGitName('GIT~1', { platform: 'linux' }), false);
  assert.equal(isDotGitName('.Git', { platform: 'linux' }), true);
});

test('worktreeGuard on Windows: reserved device names (any case, an extension, trailing spaces) are refused', () => {
  const { refusedName } = require('../src/worktree-fs')._internal;
  const devices = ['nul', 'NUL', 'Nul.txt', 'nul.tar.gz', 'nul ', 'nul  .txt', 'CON', 'con.log', 'prn', 'aux', 'AUX.c',
    'COM1', 'com9.txt', 'lpt1', 'LPT9.x', 'com0', 'lpt0', 'COM\u00b9', 'lpt\u00b2.txt', 'COM\u00b3', 'conin$', 'CONOUT$.x'];
  for (const n of devices) assert.equal(refusedName(n, 'win32'), true, n);
  // Only the whole name before the extension: these open the file they spell.
  for (const n of ['null', 'nul_', 'nulx.txt', 'xnul', 'con1', 'console.log', 'com', 'com10', 'lpt', 'auxiliary', 'prn2', 'conin', 'f.nul', 'a.con.txt']) {
    assert.equal(refusedName(n, 'win32'), false, n);
  }
  for (const n of ['nul', 'COM1', 'aux.txt']) assert.equal(refusedName(n, 'linux'), false, `${n}: an ordinary name on POSIX`);
});

test('discardSelection: a symlink swapped in between guard and write is refused', async (t) => {
  const outside = outsideDir();
  const before = snapshotDir(outside);
  t.after(() => { testHooks.beforeWrite = null; fs.rmSync(outside, { recursive: true, force: true }); });
  // Final component swapped: the re-check (and O_NOFOLLOW) refuse it.
  const dir = repoWith('f.txt', BASE);
  write(dir, 'f.txt', TARGET);
  testHooks.beforeWrite = (abs) => { fs.unlinkSync(abs); fs.symlinkSync(path.join(outside, 'secret.txt'), abs); };
  await assert.rejects(discardSelection(dir, 'f.txt', [{ hunk: 0 }]), isKind('symlink'));
  // Parent swapped.
  const d2 = repoWith('sub/f.txt', BASE);
  write(d2, 'sub/f.txt', TARGET);
  testHooks.beforeWrite = () => {
    fs.rmSync(path.join(d2, 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(d2, 'sub'));
  };
  await assert.rejects(discardSelection(d2, 'sub/f.txt', [{ hunk: 0 }]), isKind('symlink'));
  // Untracked delete path, parent swapped.
  const d3 = initRepo();
  write(d3, 'sub/secret.txt', 'outside\n');
  testHooks.beforeWrite = () => {
    fs.rmSync(path.join(d3, 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(d3, 'sub'));
  };
  await assert.rejects(discardSelection(d3, 'sub/secret.txt', [{ hunk: 0 }]), isKind('symlink'));
  assert.deepEqual(snapshotDir(outside), before);
});

test('writeNoFollow / readNoFollow refuse a final symlink (O_NOFOLLOW)', { skip: !fs.constants.O_NOFOLLOW }, () => {
  const outside = outsideDir();
  const link = path.join(outside, 'link');
  fs.symlinkSync(path.join(outside, 'secret.txt'), link);
  assert.throws(() => writeNoFollow(link, Buffer.from('pwned\n')), isKind('symlink'));
  assert.throws(() => writeNoFollow(link, Buffer.from('pwned\n'), { create: true }));
  assert.throws(() => readNoFollow(link), isKind('symlink'));
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside\n');
  // Plain files work: truncate keeps content exact, create honours the mode, missing reads null.
  const f = path.join(outside, 'f.txt');
  writeNoFollow(f, Buffer.from('xy'));
  assert.equal(readNoFollow(f).toString(), 'xy');
  writeNoFollow(path.join(outside, 'x.sh'), Buffer.from('#!\n'), { create: true, mode: 0o755 });
  assert.equal(fs.statSync(path.join(outside, 'x.sh')).mode & 0o111, 0o111);
  assert.equal(readNoFollow(path.join(outside, 'nope')), null);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('writeNoFollow on Windows: opens without O_TRUNC (libuv: TRUNCATE_EXISTING, EINVAL) and truncates the descriptor', () => {
  const { writeFlags } = require('../src/worktree-fs')._internal;
  const { O_WRONLY, O_TRUNC, O_CREAT, O_EXCL } = fs.constants;
  const win = { platform: 'win32' };
  assert.equal(writeFlags(win) & (O_WRONLY | O_TRUNC | O_CREAT | O_EXCL), O_WRONLY, 'OPEN_EXISTING: plain O_WRONLY');
  assert.equal(writeFlags({ ...win, create: true }) & (O_CREAT | O_EXCL | O_TRUNC), O_CREAT | O_EXCL, 'CREATE_NEW');
  assert.equal(writeFlags({ platform: 'linux' }) & (O_TRUNC | O_CREAT), O_TRUNC, 'POSIX keeps O_TRUNC');
  // The Windows branch, run here: a shorter write leaves no tail, the mode and exec bit work as on
  // POSIX, a missing file is ENOENT (never created), create still refuses an existing file.
  const outside = outsideDir();
  const f = path.join(outside, 'long.txt');
  fs.writeFileSync(f, 'a much longer old content\n', { mode: 0o600 });
  writeNoFollow(f, Buffer.from('xy'), win);
  assert.equal(fs.readFileSync(f, 'utf8'), 'xy');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'an existing file keeps its mode');
    writeNoFollow(f, Buffer.from('#!\n'), { ...win, exec: true });
    assert.equal(fs.statSync(f).mode & 0o777, 0o700);
  }
  assert.throws(() => writeNoFollow(path.join(outside, 'nope'), Buffer.from('x'), win), { code: 'ENOENT' });
  assert.equal(fs.existsSync(path.join(outside, 'nope')), false);
  assert.throws(() => writeNoFollow(f, Buffer.from('x'), { ...win, create: true }), { code: 'EEXIST' });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('opts.checkPatch sees the fresh raw diff, parsed patch and selection; throwing refuses before any write', async () => {
  const dir = initRepo();
  write(dir, 'f.txt', 'a\nb\nc\n');
  git(dir, 'add', 'f.txt');
  git(dir, 'commit', '-q', '-m', 'f');
  write(dir, 'f.txt', 'a\nB\nc\n');
  const calls = [];
  const refuse = (raw, patch, sel) => {
    calls.push({ raw, hunks: patch.hunks.length, sel });
    throw Object.assign(new Error('no'), { kind: 'invalid-args' });
  };
  const sel = [{ hunk: 0, lines: [1] }];
  await assert.rejects(stageSelection(dir, 'f.txt', sel, { checkPatch: refuse }), { kind: 'invalid-args' });
  await assert.rejects(discardSelection(dir, 'f.txt', sel, { checkPatch: refuse }), { kind: 'invalid-args' });
  assert.equal(read(dir, 'f.txt'), 'a\nB\nc\n');
  assert.equal(git(dir, 'diff', '--cached').trim(), '');
  git(dir, 'add', 'f.txt');
  await assert.rejects(unstageSelection(dir, 'f.txt', sel, { checkPatch: refuse }), { kind: 'invalid-args' });
  assert.match(git(dir, 'diff', '--cached'), /^\+B$/m);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.match(c.raw, /^-b\n\+B$/m);
    assert.equal(c.hunks, 1);
    assert.deepEqual(c.sel, sel);
  }
  // a fingerprint mismatch is reported first ('stale'), before checkPatch runs
  await assert.rejects(unstageSelection(dir, 'f.txt', sel, { fingerprint: 'x', checkPatch: refuse }), { kind: 'stale' });
  assert.equal(calls.length, 3);
  // passing checkPatch lets the op proceed
  await unstageSelection(dir, 'f.txt', [{ hunk: 0 }], { checkPatch: () => {} });
  assert.equal(git(dir, 'diff', '--cached').trim(), '');
});

// ---------------------------------------------------------------- path spelling, symlinks, typechanges

test('a case variant or non-canonical spelling of a tracked path is stale, never an untracked delete', async () => {
  const dir = repoWith('Notes.md', 'one\ntwo\n');
  write(dir, 'a/b.txt', 'one\n');
  git(dir, 'add', 'a/b.txt');
  git(dir, 'commit', '-q', '-m', 'ab');
  write(dir, 'Notes.md', 'one\ntwo\nthree\n');
  write(dir, 'a/b.txt', 'one\nmine\n');
  // On a case-insensitive disk 'NOTES.md' opens Notes.md, but it is not in the index.
  for (const [file, real] of [['NOTES.md', 'Notes.md'], ['notes.md', 'Notes.md'], ['a/./b.txt', 'a/b.txt'], ['a//b.txt', 'a/b.txt']]) {
    await assert.rejects(discardSelection(dir, file, [{ hunk: 0 }]), isKind('stale'), file);
    await assert.rejects(stageSelection(dir, file, [{ hunk: 0 }]), isKind('stale'), file);
    await assert.rejects(unstageSelection(dir, file, [{ hunk: 0 }]), isKind('stale'), file);
    assert.ok(fs.existsSync(path.join(dir, real)), `${file}: ${real} still exists`);
  }
  assert.equal(read(dir, 'Notes.md'), 'one\ntwo\nthree\n');
  assert.equal(read(dir, 'a/b.txt'), 'one\nmine\n');
  assert.equal(cachedDiff(dir), '');
});

test('stageSelection / discardSelection refuse untracked paths through a symlinked folder (stale)', async () => {
  const outside = outsideDir();
  const before = snapshotDir(outside);
  const dir = initRepo();
  fs.symlinkSync(outside, path.join(dir, 'lnk'));
  for (const fn of [stageSelection, discardSelection]) {
    await assert.rejects(fn(dir, 'lnk/secret.txt', [{ hunk: 0 }]), isKind('stale'), fn.name);
  }
  assert.equal(git(dir, 'ls-files', '-s').includes('lnk'), false);
  assert.deepEqual(snapshotDir(outside), before);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('hunk and line actions refuse symlinks (tracked or untracked) and submodules', async () => {
  const dir = initRepo();
  fs.symlinkSync('target-a', path.join(dir, 'lnk'));
  git(dir, 'add', 'lnk');
  git(dir, 'commit', '-q', '-m', 'link');
  // Deleted tracked link: discarding its hunk used to recreate it as a regular file.
  fs.unlinkSync(path.join(dir, 'lnk'));
  await assert.rejects(discardSelection(dir, 'lnk', [{ hunk: 0 }]), isKind('symlink'));
  assert.equal(fs.lstatSync(path.join(dir, 'lnk'), { throwIfNoEntry: false }), undefined);
  // Retargeted tracked link: stage / discard / unstage refuse.
  fs.symlinkSync('target-b', path.join(dir, 'lnk'));
  await assert.rejects(stageSelection(dir, 'lnk', [{ hunk: 0 }]), isKind('symlink'));
  await assert.rejects(discardSelection(dir, 'lnk', [{ hunk: 0 }]), isKind('symlink'));
  git(dir, 'add', 'lnk');
  await assert.rejects(unstageSelection(dir, 'lnk', [{ hunk: 0 }]), isKind('symlink'));
  assert.equal(fs.readlinkSync(path.join(dir, 'lnk')), 'target-b');
  // Untracked link: used to be staged as a regular file holding the link text.
  fs.symlinkSync('some/where', path.join(dir, 'new-link'));
  await assert.rejects(stageSelection(dir, 'new-link', [{ hunk: 0 }]), isKind('symlink'));
  await assert.rejects(discardSelection(dir, 'new-link', [{ hunk: 0 }]), isKind('symlink'));
  assert.equal(git(dir, 'ls-files', '--', 'new-link'), '');
  assert.equal(fs.readlinkSync(path.join(dir, 'new-link')), path.normalize('some/where'), 'on Windows Node writes the target with \\');
  // Submodule (gitlink) entry.
  const head = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
  for (const fn of [stageSelection, discardSelection, unstageSelection]) {
    await assert.rejects(fn(dir, 'sub', [{ hunk: 0 }]), isKind('submodule'), fn.name);
  }
});

test('type changes (file <-> symlink) are refused: kind unsupported, or symlink when the index has the link', async () => {
  // tracked file replaced by a symlink: the diff has two sections (deletion + new link)
  const dir = repoWith('f', 'a\n');
  fs.rmSync(path.join(dir, 'f'));
  fs.symlinkSync('elsewhere', path.join(dir, 'f'));
  await assert.rejects(stageSelection(dir, 'f', [{ hunk: 0 }]), isKind('unsupported'));
  await assert.rejects(discardSelection(dir, 'f', [{ hunk: 0 }]), isKind('unsupported'));
  assert.match(git(dir, 'ls-files', '-s', 'f'), /^100644 /);
  assert.equal(fs.readlinkSync(path.join(dir, 'f')), 'elsewhere');
  // staged typechange
  git(dir, 'add', 'f');
  await assert.rejects(unstageSelection(dir, 'f', [{ hunk: 0 }]), (e) => ['unsupported', 'symlink'].includes(e.kind));
  // tracked symlink replaced by a regular file with real work in it
  const d2 = initRepo();
  fs.symlinkSync('tgt', path.join(d2, 'lnk'));
  git(d2, 'add', 'lnk');
  git(d2, 'commit', '-q', '-m', 'link');
  fs.unlinkSync(path.join(d2, 'lnk'));
  write(d2, 'lnk', 'my precious\nwork\n');
  await assert.rejects(discardSelection(d2, 'lnk', [{ hunk: 0 }]), isKind('symlink'));
  assert.equal(read(d2, 'lnk'), 'my precious\nwork\n');
});

// ---------------------------------------------------------------- property test

test('property: staging a line selection S equals discarding its complement; staging the rest reaches the target', async () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const text = (cr) => {
    const n = Math.floor(rnd() * 8);
    const ls = Array.from({ length: n }, () => 'abcde'[Math.floor(rnd() * 5)] + (cr && rnd() < 0.3 ? '\r' : ''));
    return ls.join('\n') + (n && rnd() < 0.6 ? '\n' : '');
  };
  const A = initRepo();
  const B = initRepo();
  for (const d of [A, B]) git(d, 'config', 'core.autocrlf', 'false');
  let runs = 0;
  for (let t = 0; t < 12; t++) {
    const base = text(t % 2 === 1);
    const target = text(t % 2 === 1);
    if (base === target) continue;
    for (const d of [A, B]) {
      fs.writeFileSync(path.join(d, 'f'), base, 'latin1');
      git(d, 'add', 'f');
      git(d, 'commit', '-q', '--allow-empty', '-m', 'x');
      fs.writeFileSync(path.join(d, 'f'), target, 'latin1');
    }
    const diff = await shownDiff(A, 'f');
    if (!diff || !diff.hunks.length) continue;
    const sel = [];
    const comp = [];
    diff.hunks.forEach((h, hi) => {
      const s = [];
      const c = [];
      h.lines.forEach((l, li) => { if (l.type !== 'context') (rnd() < 0.5 ? s : c).push(li); });
      if (s.length) sel.push({ hunk: hi, lines: s });
      if (c.length) comp.push({ hunk: hi, lines: c });
    });
    if (!sel.length) continue;
    runs++;
    const fp = { fingerprint: fingerprint(diff) };
    const ctx = JSON.stringify({ base, target, sel });
    await stageSelection(A, 'f', sel, fp);
    if (comp.length) await discardSelection(B, 'f', comp, fp);
    assert.equal(indexBytes(A, 'f').toString('latin1'), fileBytes(B, 'f').toString('latin1'), ctx);
    const rest = await shownDiff(A, 'f');
    if (rest && rest.hunks.length) {
      await stageSelection(A, 'f', rest.hunks.map((_, i) => ({ hunk: i })), { fingerprint: fingerprint(rest) });
    }
    assert.equal(indexBytes(A, 'f').toString('latin1'), target, ctx);
  }
  assert.ok(runs >= 5, `only ${runs} runs`);
});
