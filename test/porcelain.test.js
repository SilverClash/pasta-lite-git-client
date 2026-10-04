'use strict';
// The pure parsers of src/porcelain.js and the ref / object-id helpers of src/gitref.js: no git runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/porcelain');
const ref = require('../src/gitref');

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(64);

test('gitref: object ids, zeros, abbreviation', () => {
  assert.equal(ref.OID.test(SHA), true);
  assert.equal(ref.OID.test(SHA2), true);
  assert.equal(ref.OID.test('a'.repeat(41)), false);
  assert.equal(ref.OID.test('A'.repeat(40)), false);
  assert.equal(ref.isZero('0'.repeat(40)), true);
  assert.equal(ref.isZero(SHA), false);
  assert.equal(ref.sha7(SHA), 'aaaaaaa');
});

test('gitref: ref names in and out of their namespaces', () => {
  assert.equal(ref.branchOf('refs/heads/feat/x'), 'feat/x');
  assert.equal(ref.branchOf('refs/remotes/origin/x'), null);
  assert.equal(ref.branchOf(undefined), null);
  assert.equal(ref.shortName('refs/heads/a'), 'a');
  assert.equal(ref.shortName('refs/remotes/origin/a'), 'origin/a');
  assert.equal(ref.shortName('refs/tags/v1'), 'refs/tags/v1');
  assert.equal(ref.after('refs/tags/v1', ref.PREFIX.TAGS), 'v1');
  assert.equal(ref.fullBranch('x'), 'refs/heads/x');
  assert.equal(ref.fullRemote('origin/x'), 'refs/remotes/origin/x');
});

test('gitref: parseTrack reads %(upstream:track,nobracket)', () => {
  assert.deepEqual(ref.parseTrack('ahead 2, behind 13'), { ahead: 2, behind: 13, gone: false });
  assert.deepEqual(ref.parseTrack('behind 1'), { ahead: 0, behind: 1, gone: false });
  assert.deepEqual(ref.parseTrack('gone'), { ahead: 0, behind: 0, gone: true });
  assert.deepEqual(ref.parseTrack(''), { ahead: 0, behind: 0, gone: false });
});

test('gitref: isRefspecSafe refuses refspec syntax and a leading + or -', () => {
  for (const ok of ['main', 'feat/x', 'a+b', 'v1.2']) assert.equal(ref.isRefspecSafe(ok), true, ok);
  for (const bad of ['+main', '-x', 'a:b', 'a*', 'a b', 'a^', 'a~1', 'a?', 'a[', 'a\\b', '', 7]) assert.equal(ref.isRefspecSafe(bad), false, String(bad));
});

test('splitN keeps the rest in the last part; parseNulRecords; trimTrailingNewlines', () => {
  assert.deepEqual(p.splitN('a b c d', ' ', 3), ['a', 'b', 'c d']);
  assert.deepEqual(p.splitN('a', ' ', 3), ['a']);
  assert.deepEqual(p.parseNulRecords('a\0b\0\nc\0d\0\n', 2), [['a', 'b'], ['c', 'd']]);
  assert.equal(p.trimTrailingNewlines('x\n\n\n'), 'x');
  assert.equal(p.trimTrailingNewlines('x\n\ny'), 'x\n\ny');
});

test('porcelain v2: branch headers, staged / unstaged, renames with their source, conflicts, untracked', () => {
  const raw = [
    `# branch.oid ${SHA}`, '# branch.head feat', '# branch.upstream origin/feat', '# branch.ab +2 -3',
    `1 M. N... 100644 100644 100644 ${SHA} ${SHA} a file.txt`,
    `1 .M N... 100644 100644 100644 ${SHA} ${SHA} b.txt`,
    `2 R. N... 100644 100644 100644 ${SHA} ${SHA} R100 new name.txt`, 'old name.txt',
    `u UU N... 100644 100644 100644 100644 ${SHA} ${SHA} ${SHA} c.txt`,
    '? d e.txt', '! ignored.txt', '',
  ].join('\0');
  const res = p.parsePorcelainV2(raw, { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicted: [] });
  assert.deepEqual(res, {
    branch: 'feat', oid: SHA, upstream: 'origin/feat', ahead: 2, behind: 3,
    staged: [{ path: 'a file.txt', status: 'M' }, { path: 'new name.txt', status: 'R', orig: 'old name.txt' }],
    unstaged: [{ path: 'b.txt', status: 'M' }, { path: 'd e.txt', status: '?' }],
    conflicted: [{ path: 'c.txt', status: 'U', xy: 'UU' }],
  });
  const initial = p.parsePorcelainV2('# branch.oid (initial)\0# branch.head (detached)\0', { oid: 'x', branch: 'y' });
  assert.deepEqual(initial, { oid: null, branch: null });
  assert.deepEqual(p.v2Records(raw).map((r) => r.type), ['#', '#', '#', '#', '1', '1', '2', 'u', '?', '!']);
});

test('parseStageEntries: ls-files -s / -u records, stage and path (a tab in the path kept)', () => {
  const raw = [`100644 ${SHA} 0\ta.txt`, `160000 ${SHA} 0\tsub`, `100644 ${SHA} 1\tb\tc`, `100755 ${SHA} 3\tb\tc`, 'junk', ''].join('\0');
  assert.deepEqual(p.parseStageEntries(raw), [
    { mode: '100644', sha: SHA, stage: 0, path: 'a.txt' },
    { mode: '160000', sha: SHA, stage: 0, path: 'sub' },
    { mode: '100644', sha: SHA, stage: 1, path: 'b\tc' },
    { mode: '100755', sha: SHA, stage: 3, path: 'b\tc' },
  ]);
});

test('parseWorktrees: main entry first, bare / detached / locked / prunable with their reasons, zero HEAD is null', () => {
  const raw = [
    '/r/.bare', 'bare', '',
    '/r/main', `HEAD ${SHA}`, 'branch refs/heads/main', '',
    '/r/det', `HEAD ${SHA}`, 'detached', 'locked on a stick: keep', '',
    '/r/new', `HEAD ${'0'.repeat(40)}`, 'branch refs/heads/new', 'prunable gitdir file points to non-existent location', '',
  ].map((l) => (l.startsWith('/') ? `worktree ${l}` : l)).join('\0');
  const entry = (o) => ({
    head: null, branch: null, bare: false, detached: false, locked: false, lockReason: null, prunable: false, prunableReason: null, ...o,
  });
  assert.deepEqual(p.parseWorktrees(raw), [
    entry({ path: '/r/.bare', bare: true }),
    entry({ path: '/r/main', head: SHA, branch: 'main' }),
    entry({ path: '/r/det', head: SHA, detached: true, locked: true, lockReason: 'on a stick: keep' }),
    entry({ path: '/r/new', branch: 'new', prunable: true, prunableReason: 'gitdir file points to non-existent location' }),
  ]);
});

test('parseWorktrees: a lock without a reason, a prunable locked entry, an unborn branch, unknown keys, a trailing record', () => {
  const raw = [
    'worktree /r/m', 'HEAD ' + SHA, 'branch refs/heads/main', 'future-key some value', '',
    'worktree /r/l', 'HEAD ' + SHA, 'detached', 'locked', '',
    'worktree /r/both', 'HEAD ' + SHA, 'branch refs/heads/b', 'locked why', 'prunable gone', '',
    'worktree /r/unborn', 'HEAD ' + '0'.repeat(40), 'branch refs/heads/orphan', 'locked ', '',
    // No closing empty field: the last record still counts.
    'worktree /r/last', 'HEAD ' + SHA, 'branch refs/heads/last',
  ].join('\0');
  const list = p.parseWorktrees(raw);
  assert.deepEqual(list.map((w) => w.path), ['/r/m', '/r/l', '/r/both', '/r/unborn', '/r/last']);
  assert.equal(Object.hasOwn(list[0], 'future-key'), false, 'unknown keys are ignored');
  assert.deepEqual([list[1].locked, list[1].lockReason], [true, null], 'no reason: null');
  assert.deepEqual([list[2].locked, list[2].lockReason, list[2].prunable, list[2].prunableReason], [true, 'why', true, 'gone']);
  assert.deepEqual([list[3].head, list[3].branch, list[3].locked, list[3].lockReason], [null, 'orphan', true, null], 'an empty reason is null');
  assert.deepEqual([list[4].branch, list[4].head], ['last', SHA]);
  assert.deepEqual(p.parseWorktrees(''), []);
  assert.deepEqual(p.parseWorktrees('HEAD ' + SHA + '\0\0'), [], 'fields before any worktree line are ignored');
});

test('parseNameStatus: renames and copies carry their source', () => {
  assert.deepEqual(p.parseNameStatus('M\0a\0R100\0old\0new\0C050\0src\0cp\0D\0gone\0'), [
    { status: 'M', path: 'a' }, { status: 'R', orig: 'old', path: 'new' }, { status: 'C', orig: 'src', path: 'cp' }, { status: 'D', path: 'gone' },
  ]);
});
