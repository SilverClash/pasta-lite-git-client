'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { git, initRepo, write, read, commitFile, repoWithRemote, cleanup, globalConfig } = require('./helpers');
const undo = require('../src/undo');
const { execFileSync } = require('node:child_process');

const execGit = (cwd, env, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

after(cleanup);

const head = (d) => git(d, 'rev-parse', 'HEAD').trim();
const branch = (d) => git(d, 'symbolic-ref', '-q', '--short', 'HEAD').trim();
const staged = (d) => git(d, 'diff', '--cached', '--name-only').trim();
const reflogCount = (d, ref = 'HEAD') => git(d, 'reflog', 'show', '--format=%H', ref).trim().split('\n').length;
const allRefs = (d) => git(d, 'for-each-ref', '--format=%(refname) %(objectname)') + git(d, 'rev-parse', 'HEAD');

async function rejects(p, kind) {
  await assert.rejects(p, (e) => e.kind === kind);
}
const EMPTY = { undo: null, redo: null, busy: false, undoBlocked: null, redoBlocked: null };
/** Discard via raw git inside withDiscardBackup; returns the backup (after) sha. */
async function discard(d, paths, fn = () => git(d, 'restore', '--', ...paths)) {
  return (await undo.withDiscardBackup(d, paths, async () => fn())).backup;
}

test('commit: undo moves branch back softly, redo moves it forward', async () => {
  const d = initRepo();
  const base = head(d);
  const c = commitFile(d, 'a.txt', 'A\n', 'fix: foo');
  let s = await undo.getState(d);
  assert.equal(s.undo.action, 'commit');
  assert.equal(s.undo.description, "Undo commit 'fix: foo'");
  assert.equal(s.redo, null);

  const r = await undo.undo(d);
  assert.deepEqual(r, { action: 'commit', description: "Undo commit 'fix: foo'" });
  assert.equal(head(d), base);
  assert.equal(branch(d), 'main');
  assert.equal(staged(d), 'a.txt');
  assert.equal(read(d, 'a.txt'), 'A\n');
  assert.match(git(d, 'reflog', '-1', '--format=%gs', 'main'), /^undo: commit: fix: foo/);

  s = await undo.getState(d);
  assert.equal(s.undo, null); // initial commit is next: not undoable
  assert.equal(s.redo.description, "Redo commit 'fix: foo'");

  await undo.redo(d);
  assert.equal(head(d), c);
  assert.equal(staged(d), '');
  s = await undo.getState(d);
  assert.equal(s.undo.description, "Undo commit 'fix: foo'");
  assert.equal(s.redo, null);
});

test('amend undo restores the pre-amend commit', async () => {
  const d = initRepo();
  const c1 = commitFile(d, 'a.txt', '1\n', 'first');
  write(d, 'a.txt', '2\n');
  git(d, 'commit', '-q', '-a', '--amend', '-m', 'first amended');
  const s = await undo.getState(d);
  assert.equal(s.undo.description, "Undo amend of 'first amended'");
  await undo.undo(d);
  assert.equal(head(d), c1);
  assert.equal(staged(d), 'a.txt');
  assert.equal(read(d, 'a.txt'), '2\n');
  assert.equal((await undo.getState(d)).undo.description, "Undo commit 'first'");
});

test('initial commit is not undoable; empty repo has nothing', async () => {
  const d = initRepo();
  assert.deepEqual(await undo.getState(d), EMPTY);
  await rejects(undo.undo(d), 'nothing');
  await rejects(undo.redo(d), 'nothing');
  const e = initRepo({ commits: false });
  assert.equal((await undo.getState(e)).undo, null);
});

test('commit undo is unavailable when the branch tip moved elsewhere', async () => {
  const d = initRepo();
  commitFile(d, 'a.txt', 'A\n', 'x');
  // A message-less update-ref still logs to HEAD, as an unsupported entry.
  git(d, 'update-ref', 'refs/heads/main', 'HEAD~1');
  assert.equal((await undo.getState(d)).undo, null);
});

test('checkout undo/redo between branches and detached HEAD', async () => {
  const d = initRepo();
  git(d, 'branch', 'feat');
  commitFile(d, 'm.txt', 'm\n', 'on main');
  git(d, 'checkout', '-q', 'feat');
  let s = await undo.getState(d);
  assert.equal(s.undo.description, 'Undo checkout of feat');

  await undo.undo(d);
  assert.equal(branch(d), 'main');
  assert.equal(read(d, 'm.txt'), 'm\n');
  s = await undo.getState(d);
  assert.equal(s.redo.description, 'Redo checkout of feat');
  assert.equal(s.undo.description, "Undo commit 'on main'");

  await undo.redo(d);
  assert.equal(branch(d), 'feat');
  assert.ok(!fs.existsSync(path.join(d, 'm.txt')));
  s = await undo.getState(d);
  assert.equal(s.undo.description, 'Undo checkout of feat');
  assert.equal(s.redo, null);

  // Detached: checkout a sha, undo goes back to the branch, redo detaches again.
  const main = git(d, 'rev-parse', 'main').trim();
  git(d, 'checkout', '-q', main);
  await undo.undo(d);
  assert.equal(branch(d), 'feat');
  await undo.redo(d);
  assert.throws(() => git(d, 'symbolic-ref', '-q', 'HEAD'));
  assert.equal(head(d), main);

  // Detached -> branch: undo detaches at the old sha.
  git(d, 'checkout', '-q', 'feat');
  await undo.undo(d);
  assert.throws(() => git(d, 'symbolic-ref', '-q', 'HEAD'));
  assert.equal(head(d), main);
});

test('checkout undo fails cleanly on conflicting local changes', async () => {
  const d = initRepo();
  git(d, 'checkout', '-q', '-b', 'feat');
  commitFile(d, 'README.md', 'feat\n', 'feat edit');
  git(d, 'checkout', '-q', 'main');
  write(d, 'README.md', 'dirty\n');
  // Undo target is the checkout; going back to feat would overwrite README.md.
  await assert.rejects(undo.undo(d), (e) => e.name === 'GitError');
  assert.equal(branch(d), 'main');
  assert.equal(read(d, 'README.md'), 'dirty\n');
  assert.equal((await undo.getState(d)).undo.action, 'checkout');
});

test('discard: backup, undo restores tracked + untracked, redo discards again', async () => {
  const d = initRepo();
  const base = commitFile(d, 'dir/t.txt', 'orig\n', 'add t');
  write(d, 'dir/t.txt', 'changed\n');
  write(d, 'new.txt', 'untracked\n');
  write(d, 'other.txt', 'keep me\n'); // not part of the discard
  git(d, 'add', 'other.txt');
  const indexBefore = git(d, 'ls-files', '-s');
  const refsBefore = allRefs(d);

  const r = await undo.withDiscardBackup(d, ['dir/t.txt', 'new.txt'], async () => {
    git(d, 'restore', '--worktree', '--', 'dir/t.txt');
    git(d, 'clean', '-f', '-q', '--', 'new.txt');
    return 'fn-result';
  });
  const sha = r.backup;
  assert.equal(r.result, 'fn-result');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(git(d, 'ls-files', '-s'), indexBefore, 'real index untouched');
  assert.equal(staged(d), 'other.txt');
  assert.equal(git(d, 'rev-parse', `${sha}^^`).trim(), base, 'after -> before -> HEAD');
  assert.equal(git(d, 'show', `${sha}^:new.txt`), 'untracked\n');
  assert.equal(git(d, 'show', `${sha}:dir/t.txt`), 'orig\n');
  assert.equal(git(d, 'reflog', '-1', '--format=%gs').trim(), `pasta-lite discard [${sha}] 2 file(s)`);
  // Only the backup ref was added.
  assert.equal(allRefs(d).replace(`refs/pasta-lite/backups/${sha} ${sha}\n`, ''), refsBefore);

  let s = await undo.getState(d);
  assert.equal(s.undo.description, 'Undo discard of 2 files');

  await undo.undo(d);
  assert.equal(read(d, 'dir/t.txt'), 'changed\n');
  assert.equal(read(d, 'new.txt'), 'untracked\n');
  assert.equal(git(d, 'ls-files', '-s'), indexBefore);
  s = await undo.getState(d);
  assert.equal(s.redo.description, 'Redo discard of 2 files');

  await undo.redo(d);
  assert.equal(read(d, 'dir/t.txt'), 'orig\n');
  assert.ok(!fs.existsSync(path.join(d, 'new.txt')));
  assert.equal(read(d, 'other.txt'), 'keep me\n');
  s = await undo.getState(d);
  assert.equal(s.undo.description, 'Undo discard of 2 files');
  assert.equal(s.redo, null);

  // And once more round the loop.
  await undo.undo(d);
  assert.equal(read(d, 'new.txt'), 'untracked\n');
});

test('discard redo refused once the restored files were edited', async () => {
  const d = initRepo();
  write(d, 'README.md', 'mine\n');
  await discard(d, ['README.md']);
  await undo.undo(d);
  write(d, 'README.md', 'edited after undo\n');
  const s = await undo.getState(d);
  assert.equal(s.redo, null);
  assert.equal(s.redoBlocked, 'Files changed since the undo');
  await rejects(undo.redo(d), 'nothing');
  assert.equal(read(d, 'README.md'), 'edited after undo\n');
});

test('discard undo refused (blocked) once a discarded modification is edited again', async () => {
  const d = initRepo();
  write(d, 'README.md', 'mine\n');
  await discard(d, ['README.md']);
  write(d, 'README.md', 'new work after the discard\n');
  const s = await undo.getState(d);
  assert.equal(s.undo, null);
  assert.equal(s.undoBlocked, 'Files changed since the discard');
  await assert.rejects(undo.undo(d), (e) => e.kind === 'nothing' && e.blocked === 'Files changed since the discard');
  assert.equal(read(d, 'README.md'), 'new work after the discard\n');
  // Reverting the edit makes it available again.
  write(d, 'README.md', 'hello\n');
  assert.equal((await undo.getState(d)).undoBlocked, null);
  await undo.undo(d);
  assert.equal(read(d, 'README.md'), 'mine\n');
});

test('discard undo refused once a discarded deletion is followed by a new edit', async () => {
  const d = initRepo();
  fs.rmSync(path.join(d, 'README.md'));
  await discard(d, ['README.md']); // restores README.md
  write(d, 'README.md', 'rewritten\n');
  let s = await undo.getState(d);
  assert.equal(s.undo, null);
  assert.equal(s.undoBlocked, 'Files changed since the discard');
  // Deleting it again (a different state from the discard result) also blocks.
  fs.rmSync(path.join(d, 'README.md'));
  s = await undo.getState(d);
  assert.equal(s.undoBlocked, 'Files changed since the discard');
  await rejects(undo.undo(d), 'nothing');
  assert.ok(!fs.existsSync(path.join(d, 'README.md')));
});

test('hunk-level discard: undo restores both regions, redo re-discards exactly one', async () => {
  const d = initRepo();
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const text = (ls) => `${ls.join('\n')}\n`;
  commitFile(d, 'f.txt', text(lines), 'lines');
  const both = [...lines];
  both[2] = 'CHANGED top';
  both[25] = 'CHANGED bottom';
  const oneRegion = [...lines];
  oneRegion[25] = 'CHANGED bottom'; // top hunk discarded, bottom kept
  write(d, 'f.txt', text(both));
  await discard(d, ['f.txt'], () => write(d, 'f.txt', text(oneRegion)));
  assert.equal(read(d, 'f.txt'), text(oneRegion));

  await undo.undo(d);
  assert.equal(read(d, 'f.txt'), text(both));
  await undo.redo(d);
  assert.equal(read(d, 'f.txt'), text(oneRegion), 'other hunk preserved');
});

test('discard: fn throwing records nothing', async () => {
  const d = initRepo();
  commitFile(d, 'a.txt', 'A\n', 'A');
  write(d, 'a.txt', 'dirty\n');
  const reflogBefore = git(d, 'reflog', 'show', '--format=%H %gs', 'HEAD');
  const refs = allRefs(d);
  await assert.rejects(undo.withDiscardBackup(d, ['a.txt'], async () => { throw new Error('boom'); }), /boom/);
  assert.equal(git(d, 'reflog', 'show', '--format=%H %gs', 'HEAD'), reflogBefore);
  assert.equal(allRefs(d), refs, 'no backup ref');
  assert.equal(git(d, 'for-each-ref', 'refs/pasta-lite/'), '');
  assert.equal((await undo.getState(d)).undo.description, "Undo commit 'A'");
});

test('discard of 3000 paths (no argv limits)', async () => {
  const d = initRepo();
  const paths = Array.from({ length: 3000 }, (_, i) => `many/some-longish-directory-name/file-${i}.txt`);
  for (const p of paths) write(d, p, `${p}\n`);
  git(d, 'add', 'many');
  git(d, 'commit', '-q', '-m', 'many');
  for (const p of paths) write(d, p, 'dirty\n');
  await discard(d, paths, () => git(d, 'checkout', '--', 'many'));
  assert.equal(read(d, paths[1234]), `${paths[1234]}\n`);
  assert.equal((await undo.getState(d)).undo.description, 'Undo discard of 3000 files');
  await undo.undo(d);
  assert.equal(read(d, paths[0]), 'dirty\n');
  assert.equal(read(d, paths[2999]), 'dirty\n');
  await undo.redo(d);
  assert.equal(read(d, paths[2999]), `${paths[2999]}\n`);
});

test('discard and undo from a subdirectory cwd', async () => {
  const d = initRepo();
  commitFile(d, 'sub/x.txt', 'x\n', 'x');
  write(d, 'sub/x.txt', 'dirty\n');
  write(d, 'sub/deep/new.txt', 'new\n');
  const sub = path.join(d, 'sub');
  const paths = ['sub/x.txt', 'sub/deep/new.txt']; // root-relative, as status reports them
  await undo.withDiscardBackup(sub, paths, async () => {
    git(d, 'restore', '--', 'sub/x.txt');
    fs.rmSync(path.join(d, 'sub/deep'), { recursive: true });
  });
  assert.equal((await undo.getState(sub)).undo.description, 'Undo discard of 2 files');
  await undo.undo(sub);
  assert.equal(read(d, 'sub/x.txt'), 'dirty\n');
  assert.equal(read(d, 'sub/deep/new.txt'), 'new\n');
  await undo.redo(sub);
  assert.equal(read(d, 'sub/x.txt'), 'x\n');
  assert.ok(!fs.existsSync(path.join(d, 'sub/deep')), 'empty dir pruned');
  // Commit undo from the subdirectory too.
  await undo.undo(sub); // discard
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'sub work');
  await undo.undo(sub);
  assert.equal(staged(d).split('\n').sort().join(','), 'sub/deep/new.txt,sub/x.txt');
});

test('discard backup works with no identity configured', async () => {
  const d = initRepo();
  git(d, 'config', 'user.useConfigOnly', 'true'); // no auto-detected identity either
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    assert.equal(process.env.GIT_CONFIG_GLOBAL, globalConfig); // test/helpers.js: no user.* there
    write(d, 'README.md', 'mine\n');
    const sha = await discard(d, ['README.md']);
    assert.match(git(d, 'log', '-1', '--format=%an <%ae>', sha), /^Pasta Lite <pasta-lite@localhost>/);
    await undo.undo(d);
    assert.equal(read(d, 'README.md'), 'mine\n');
    await undo.redo(d);
    assert.equal(read(d, 'README.md'), 'hello\n');
  } finally {
    for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
});

test('discard of a deleted tracked file: undo deletes it again', async () => {
  const d = initRepo();
  fs.rmSync(path.join(d, 'README.md'));
  await discard(d, ['README.md']);
  assert.equal(read(d, 'README.md'), 'hello\n');
  await undo.undo(d);
  assert.ok(!fs.existsSync(path.join(d, 'README.md')));
  await undo.redo(d);
  assert.equal(read(d, 'README.md'), 'hello\n');
});

test('discard in an empty repo (no HEAD)', async () => {
  const d = initRepo({ commits: false });
  write(d, 'x.txt', 'x\n');
  const sha = await discard(d, ['x.txt'], () => fs.rmSync(path.join(d, 'x.txt')));
  const before = git(d, 'rev-parse', `${sha}^`).trim();
  assert.equal(git(d, 'rev-list', '--parents', '-n1', before).trim(), before); // root commit
  await undo.undo(d);
  assert.equal(read(d, 'x.txt'), 'x\n');
});

test('discard that changes nothing records nothing', async () => {
  const d = initRepo();
  const n = reflogCount(d);
  const r = await undo.withDiscardBackup(d, ['README.md'], async () => {});
  assert.equal(r.backup, null);
  assert.equal(reflogCount(d), n);
});

test('backup commits survive gc --prune=now', async () => {
  const d = initRepo();
  write(d, 'lost.txt', 'precious\n');
  const sha = await discard(d, ['lost.txt'], () => fs.rmSync(path.join(d, 'lost.txt')));
  git(d, 'reflog', 'expire', '--expire=now', '--all');
  git(d, 'gc', '-q', '--prune=now');
  assert.equal(git(d, 'show', `${sha}^:lost.txt`), 'precious\n');
});

test('branch delete: record, undo recreates at the same sha with upstream, redo deletes', async () => {
  const { local } = repoWithRemote();
  const d = local;
  git(d, 'checkout', '-q', '-b', 'feat/x');
  const sha = commitFile(d, 'f.txt', 'f\n', 'feat work');
  git(d, 'push', '-q', '-u', 'origin', 'feat/x');
  git(d, 'checkout', '-q', 'main');
  git(d, 'branch', '-D', 'feat/x');
  const refsBefore = allRefs(d);
  await undo.recordBranchDelete(d, { name: 'feat/x', sha, upstream: 'origin/feat/x' });
  assert.equal(allRefs(d), refsBefore);

  let s = await undo.getState(d);
  assert.equal(s.undo.description, 'Undo delete of branch feat/x');
  await undo.undo(d);
  assert.equal(git(d, 'rev-parse', 'feat/x').trim(), sha);
  assert.equal(git(d, 'rev-parse', '--abbrev-ref', 'feat/x@{upstream}').trim(), 'origin/feat/x');
  s = await undo.getState(d);
  assert.equal(s.redo.description, 'Redo delete of branch feat/x');
  assert.equal(s.undo.description, 'Undo checkout of main');

  await undo.redo(d);
  assert.throws(() => git(d, 'rev-parse', '--verify', '-q', 'refs/heads/feat/x'));
  s = await undo.getState(d);
  assert.equal(s.undo.description, 'Undo delete of branch feat/x');
  assert.equal(s.redo, null);
});

test('branch delete with no upstream', async () => {
  const d = initRepo();
  git(d, 'branch', 'tmp');
  const sha = head(d);
  git(d, 'branch', '-D', 'tmp');
  await undo.recordBranchDelete(d, { name: 'tmp', sha, upstream: null });
  await undo.undo(d);
  assert.equal(git(d, 'rev-parse', 'tmp').trim(), sha);
});

test('multi-step: commit A, B; undo, undo, redo, redo with correct state each step', async () => {
  const d = initRepo();
  const base = head(d);
  const a = commitFile(d, 'a.txt', 'a\n', 'A');
  const b = commitFile(d, 'b.txt', 'b\n', 'B');
  const st = async () => {
    const s = await undo.getState(d);
    return [s.undo && s.undo.description, s.redo && s.redo.description];
  };
  assert.deepEqual(await st(), ["Undo commit 'B'", null]);
  await undo.undo(d);
  assert.equal(head(d), a);
  assert.deepEqual(await st(), ["Undo commit 'A'", "Redo commit 'B'"]);
  await undo.undo(d);
  assert.equal(head(d), base);
  assert.deepEqual(await st(), [null, "Redo commit 'A'"]);
  await undo.redo(d);
  assert.equal(head(d), a);
  assert.deepEqual(await st(), ["Undo commit 'A'", "Redo commit 'B'"]);
  await undo.redo(d);
  assert.equal(head(d), b);
  assert.deepEqual(await st(), ["Undo commit 'B'", null]);
  // Undo a redo, then redo it again.
  await undo.undo(d);
  assert.deepEqual(await st(), ["Undo commit 'A'", "Redo commit 'B'"]);
  await undo.redo(d);
  assert.equal(head(d), b);
  assert.deepEqual(await st(), ["Undo commit 'B'", null]);
  // All the way down again.
  await undo.undo(d);
  await undo.undo(d);
  assert.equal(head(d), base);
  assert.deepEqual(await st(), [null, "Redo commit 'A'"]);
});

test('identical commit subjects are matched newest-first', async () => {
  const d = initRepo();
  const base = head(d);
  const c1 = commitFile(d, 'a.txt', '1\n', 'wip');
  commitFile(d, 'a.txt', '2\n', 'wip');
  await undo.undo(d);
  assert.equal(head(d), c1);
  await undo.undo(d);
  assert.equal(head(d), base);
  await undo.redo(d);
  assert.equal(head(d), c1);
});

test('a new commit after undo clears redo', async () => {
  const d = initRepo();
  commitFile(d, 'a.txt', 'a\n', 'A');
  commitFile(d, 'b.txt', 'b\n', 'B');
  await undo.undo(d);
  git(d, 'commit', '-q', '-m', 'C'); // b.txt is still staged
  const s = await undo.getState(d);
  assert.equal(s.redo, null);
  assert.equal(s.undo.description, "Undo commit 'C'");
  await rejects(undo.redo(d), 'nothing');
  await undo.undo(d);
  // B stays undone, so after undoing C the next target is A.
  const s2 = await undo.getState(d);
  assert.equal(s2.undo.description, "Undo commit 'A'");
  assert.equal(s2.redo.description, "Redo commit 'C'");
});

test('unsupported entry (reset --hard) blocks undo', async () => {
  const d = initRepo();
  commitFile(d, 'a.txt', 'a\n', 'A');
  commitFile(d, 'b.txt', 'b\n', 'B');
  git(d, 'reset', '-q', '--hard', 'HEAD~1');
  assert.deepEqual(await undo.getState(d), EMPTY);
  await rejects(undo.undo(d), 'nothing');
});

test('busy during a bisect', async () => {
  const d = initRepo();
  commitFile(d, 'a.txt', 'a\n', 'A');
  git(d, 'bisect', 'start');
  const s = await undo.getState(d);
  assert.equal(s.busy, true);
  assert.equal(s.undo, null);
  await assert.rejects(undo.undo(d), (e) => e.kind === 'busy' && e.state === 'bisecting');
  git(d, 'bisect', 'reset');
  assert.equal((await undo.getState(d)).busy, false);
});

test('busy during a merge conflict', async () => {
  const d = initRepo();
  git(d, 'checkout', '-q', '-b', 'other');
  commitFile(d, 'README.md', 'other\n', 'other');
  git(d, 'checkout', '-q', 'main');
  commitFile(d, 'README.md', 'main\n', 'main');
  assert.throws(() => git(d, 'merge', 'other'));
  const s = await undo.getState(d);
  assert.equal(s.busy, true);
  assert.equal(s.undo, null);
  await rejects(undo.undo(d), 'busy');
  await rejects(undo.redo(d), 'busy');
  git(d, 'merge', '--abort');
  assert.equal((await undo.getState(d)).undo.description, "Undo commit 'main'");
});

test('reflog append never moves refs and works in detached HEAD', async () => {
  const d = initRepo();
  commitFile(d, 'a.txt', 'a\n', 'A');
  const branchLog = reflogCount(d, 'main');
  const refs = allRefs(d);
  await undo.recordBranchDelete(d, { name: 'gone', sha: head(d), upstream: null });
  assert.equal(allRefs(d), refs);
  assert.equal(branch(d), 'main');
  assert.equal(reflogCount(d, 'main'), branchLog, 'branch reflog untouched');

  git(d, 'checkout', '-q', '--detach');
  const n = reflogCount(d);
  const refs2 = allRefs(d);
  await undo.recordBranchDelete(d, { name: 'gone2', sha: head(d), upstream: null });
  assert.equal(reflogCount(d), n + 1);
  assert.equal(allRefs(d), refs2);
  assert.throws(() => git(d, 'symbolic-ref', '-q', 'HEAD'), 'still detached');
  assert.equal(git(d, 'reflog', '-1', '--format=%gs').trim(), `pasta-lite delete-branch gone2 - [${head(d)}]`);
});

test('commit undo/redo in detached HEAD', async () => {
  const d = initRepo();
  git(d, 'checkout', '-q', '--detach');
  const base = head(d);
  const c = commitFile(d, 'a.txt', 'a\n', 'detached work');
  await undo.undo(d);
  assert.equal(head(d), base);
  assert.throws(() => git(d, 'symbolic-ref', '-q', 'HEAD'));
  assert.equal(git(d, 'rev-parse', 'main').trim(), base);
  await undo.redo(d);
  assert.equal(head(d), c);
});

test('mixed actions undo in reverse order', async () => {
  const d = initRepo();
  git(d, 'branch', 'feat');
  commitFile(d, 'a.txt', 'a\n', 'A');
  git(d, 'checkout', '-q', 'feat');
  write(d, 'README.md', 'dirty\n');
  await discard(d, ['README.md']);
  assert.equal((await undo.undo(d)).action, 'discard');
  assert.equal(read(d, 'README.md'), 'dirty\n');
  git(d, 'stash', '-q'); // stash does not touch the HEAD reflog
  assert.equal((await undo.undo(d)).action, 'checkout');
  assert.equal(branch(d), 'main');
  assert.equal((await undo.undo(d)).action, 'commit');
  const s = await undo.getState(d);
  assert.equal(s.undo, null);
  assert.equal(s.redo.description, "Redo commit 'A'");
});

test('reftable repositories work via the reflog show fallback', async (t) => {
  const d = initRepo({ commits: false });
  fs.rmSync(path.join(d, '.git'), { recursive: true });
  try { git(d, 'init', '-q', '-b', 'main', '--ref-format=reftable'); } catch { return t.skip('no reftable'); }
  git(d, 'config', 'commit.gpgSign', 'false');
  const base = commitFile(d, 'a.txt', '1\n', 'one');
  commitFile(d, 'a.txt', '2\n', 'two');
  await undo.undo(d);
  assert.equal(head(d), base);
  assert.equal((await undo.getState(d)).redo.description, "Redo commit 'two'");
  await undo.recordBranchDelete(d, { name: 'x', sha: base, upstream: null });
  assert.equal((await undo.getState(d)).undo.description, 'Undo delete of branch x');
});

test('no-op checkout entries (bisect reset, re-checkout) do not become undo targets', async () => {
  const d = initRepo();
  commitFile(d, 'a.txt', 'a\n', 'add a');
  git(d, 'bisect', 'start');
  git(d, 'bisect', 'reset');
  git(d, 'checkout', '-q', 'main');
  const s = await undo.getState(d);
  assert.equal(s.undo && s.undo.action, 'commit');
});

test('discard backup sees a same-size edit of a racily clean index entry', async () => {
  // Entry and index share an mtime (edit right after staging, same second). A temp index copy
  // with a fresh mtime made git trust the stale stat data: the backup missed the edit and the
  // discard was recorded as a no-op (lost change, "Nothing to undo").
  const d = initRepo();
  git(d, 'config', 'core.trustctime', 'false');
  const f = path.join(d, 'README.md');
  const t = Math.floor(Date.now() / 1000) - 100;
  fs.utimesSync(f, t, t);
  git(d, 'add', 'README.md');
  fs.utimesSync(path.join(d, '.git', 'index'), t, t);
  fs.writeFileSync(f, 'HELLO\n'); // same size as 'hello\n'
  fs.utimesSync(f, t, t);
  const { backup } = await undo.withDiscardBackup(d, ['README.md'], () => git(d, 'restore', '--worktree', 'README.md'));
  assert.ok(backup);
  await undo.undo(d);
  assert.equal(read(d, 'README.md'), 'HELLO\n');
});

// ---- index copy (racy-clean mtime) -------------------------------------------------------------

/** fs stand-in for copyIndex: statSync returns the queued stats in order and records calls. */
function fakeFs(stats) {
  const calls = [];
  return {
    calls,
    statSync: () => { calls.push('stat'); return stats.shift(); },
    copyFileSync: () => { calls.push('copy'); },
    utimesSync: (p, a, m) => { calls.push(['utimes', a, m]); },
  };
}
const st = (mtimeMs, size = 10, ino = 1) => ({ mtimeMs, size, ino });

test('copyIndex: stats before and after the copy, uses the pre-copy mtime rounded down', () => {
  const f = fakeFs([st(5000_900), st(5000_900)]);
  assert.equal(undo._internal.copyIndex(f, 'src', 'dst'), 5000);
  assert.deepEqual(f.calls, ['stat', 'copy', 'stat', ['utimes', 5000, 5000]]);
});

test('copyIndex: retries when the index changes between copy and stat', () => {
  // Rewritten during the first copy (newer mtime), then replaced by rename (same mtime, new inode).
  const f = fakeFs([st(1000_000), st(2000_500), st(2000_500), st(2000_500, 10, 2), st(3000_000), st(3000_000)]);
  assert.equal(undo._internal.copyIndex(f, 'src', 'dst'), 3000);
  assert.equal(f.calls.filter((c) => c === 'copy').length, 3);
  // Size change alone also counts.
  const g = fakeFs([st(1000_000, 10), st(1000_000, 11), st(1000_000, 11), st(1000_000, 11)]);
  assert.equal(undo._internal.copyIndex(g, 'src', 'dst'), 1000);
});

test('copyIndex: an index that keeps changing gets mtime 1 (every entry racy)', () => {
  const stats = [];
  for (let i = 0; i < 10; i++) stats.push(st(1000_000 + i * 1000));
  const f = fakeFs(stats);
  assert.equal(undo._internal.copyIndex(f, 'src', 'dst', 5), 1);
  assert.equal(f.calls.filter((c) => c === 'copy').length, 5);
  assert.deepEqual(f.calls.at(-1), ['utimes', 1, 1]);
});

test('copyIndex on real files: the mtime-1 fallback still sees a racily clean same-size edit', () => {
  // Entry, index and file share an mtime. Index mtime 0 would be ignored by git (edit missed).
  const d = initRepo();
  git(d, 'config', 'core.trustctime', 'false');
  const f = path.join(d, 'README.md');
  const t = Math.floor(Date.now() / 1000) - 100;
  fs.utimesSync(f, t, t);
  git(d, 'add', 'README.md');
  fs.utimesSync(path.join(d, '.git', 'index'), t, t);
  fs.writeFileSync(f, 'HELLO\n');
  fs.utimesSync(f, t, t);
  const idx = path.join(d, '.git', 'idx-copy');
  const x = fakeFs([st(1), st(2), st(3), st(4)]); // never stable -> fallback
  x.copyFileSync = (a, b) => fs.copyFileSync(a, b);
  x.utimesSync = (p, a, m) => fs.utimesSync(p, a, m);
  assert.equal(undo._internal.copyIndex(x, path.join(d, '.git', 'index'), idx, 2), 1);
  assert.equal(execGit(d, { GIT_INDEX_FILE: idx }, 'diff', '--name-only').trim(), 'README.md');
});

// ---- deletes go through the worktree guard -------------------------------------------------------

test('discard redo refuses to delete through a symlinked directory', async () => {
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pl-out-')));
  fs.writeFileSync(path.join(outside, 'u.txt'), 'keep\n');
  const d = initRepo();
  const { worktreeGuard } = require('../src/hunks');
  const guard = await worktreeGuard(d);
  fs.symlinkSync(outside, path.join(d, 'sub'));
  assert.throws(() => undo._internal.removeFile(guard, 'sub/u.txt'), (e) => e.kind === 'symlink');
  fs.unlinkSync(path.join(d, 'sub'));
  fs.symlinkSync(path.join(outside, 'gone'), path.join(d, 'sub')); // dangling
  assert.throws(() => undo._internal.removeFile(guard, 'sub/u.txt'), (e) => e.kind === 'symlink');
  assert.equal(fs.readFileSync(path.join(outside, 'u.txt'), 'utf8'), 'keep\n');
  // Plain case: deletes the file and prunes empty parents, up to (not including) the root.
  write(d, 'a/b/c.txt', 'x\n');
  undo._internal.removeFile(guard, 'a/b/c.txt');
  assert.equal(fs.existsSync(path.join(d, 'a')), false);
  assert.equal(fs.existsSync(d), true);
  // A final symlink is removed itself, its target stays.
  fs.symlinkSync(path.join(outside, 'u.txt'), path.join(d, 'l.txt'));
  undo._internal.removeFile(guard, 'l.txt');
  assert.equal(fs.existsSync(path.join(d, 'l.txt')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'u.txt'), 'utf8'), 'keep\n');
  fs.rmSync(outside, { recursive: true, force: true });
});

// ---- raw-byte backups (filters, autocrlf), symlinks and modes --------------------------------------

test('discard + undo restores the exact bytes under core.autocrlf=input and clean/smudge filters', async () => {
  const d = initRepo();
  git(d, 'config', 'core.autocrlf', 'input');
  commitFile(d, 'f.txt', 'a\nb\n', 'lf');
  commitFile(d, '.gitattributes', 'up.txt filter=up\n', 'attrs');
  git(d, 'config', 'filter.up.clean', 'tr a-z A-Z');
  git(d, 'config', 'filter.up.smudge', 'cat');
  commitFile(d, 'up.txt', 'base\n', 'up');
  fs.writeFileSync(path.join(d, 'f.txt'), 'a\r\nb\r\nMY WORK\r\n');
  fs.writeFileSync(path.join(d, 'up.txt'), 'lower case work\n');
  await discard(d, ['f.txt', 'up.txt'], () => git(d, 'checkout', '--', 'f.txt', 'up.txt'));
  assert.equal(read(d, 'f.txt'), 'a\nb\n');
  await undo.undo(d);
  assert.deepEqual(fs.readFileSync(path.join(d, 'f.txt')), Buffer.from('a\r\nb\r\nMY WORK\r\n'));
  assert.equal(read(d, 'up.txt'), 'lower case work\n');
  await undo.redo(d);
  assert.equal(read(d, 'f.txt'), 'a\nb\n');
  assert.equal(read(d, 'up.txt'), 'BASE\n');
});

test('discard undo restores symlinks as links and the executable bit', async () => {
  const d = initRepo();
  fs.symlinkSync('target-a', path.join(d, 'lnk'));
  write(d, 'run.sh', 'echo a\n');
  git(d, 'add', 'lnk', 'run.sh');
  git(d, 'commit', '-q', '-m', 'link');
  fs.unlinkSync(path.join(d, 'lnk'));
  fs.symlinkSync('target-b', path.join(d, 'lnk'));
  fs.symlinkSync('new-target', path.join(d, 'new-link'));
  // Windows has no executable bit on disk (Node reports none, Git for Windows sets
  // core.fileMode=false): there the index entry says the file is executable, as for one checked
  // out from a repo where it is, and the backup takes its mode from there.
  const win = process.platform === 'win32';
  if (win) git(d, 'update-index', '--chmod=+x', 'run.sh');
  else fs.chmodSync(path.join(d, 'run.sh'), 0o755);
  write(d, 'run.sh', 'echo b\n');
  const backup = await discard(d, ['lnk', 'new-link', 'run.sh'], () => {
    git(d, 'checkout', '--', 'lnk', 'run.sh');
    fs.unlinkSync(path.join(d, 'new-link'));
  });
  assert.match(git(d, 'ls-tree', `${backup}^`, '--', 'run.sh'), /^100755 /, 'the before commit');
  assert.equal(fs.readlinkSync(path.join(d, 'lnk')), 'target-a');
  assert.equal(fs.statSync(path.join(d, 'run.sh')).mode & 0o111, 0);
  await undo.undo(d);
  assert.equal(fs.readlinkSync(path.join(d, 'lnk')), 'target-b');
  assert.equal(fs.readlinkSync(path.join(d, 'new-link')), 'new-target');
  assert.equal(read(d, 'run.sh'), 'echo b\n');
  if (!win) assert.notEqual(fs.statSync(path.join(d, 'run.sh')).mode & 0o100, 0);
  await undo.redo(d);
  assert.equal(fs.readlinkSync(path.join(d, 'lnk')), 'target-a');
  assert.equal(fs.lstatSync(path.join(d, 'new-link'), { throwIfNoEntry: false }), undefined);
  assert.equal(fs.statSync(path.join(d, 'run.sh')).mode & 0o111, 0);
});

test('discard backup under core.fileMode=false: the executable bit on disk, from the index on Windows (as git add does there)', async () => {
  const d = initRepo();
  write(d, 'x.sh', 'x\n');
  write(d, 'plain.txt', 'p\n');
  git(d, 'add', 'x.sh', 'plain.txt');
  git(d, 'update-index', '--chmod=+x', 'x.sh');
  git(d, 'commit', '-q', '-m', 'modes');
  git(d, 'config', 'core.fileMode', 'false');
  // The bits on disk say the opposite of the index (where a file system has them at all).
  fs.chmodSync(path.join(d, 'x.sh'), 0o644);
  fs.chmodSync(path.join(d, 'plain.txt'), 0o755);
  write(d, 'x.sh', 'x2\n');
  write(d, 'plain.txt', 'p2\n');
  write(d, 'new.sh', 'n\n');
  fs.chmodSync(path.join(d, 'new.sh'), 0o755);
  const backup = await discard(d, ['x.sh', 'plain.txt', 'new.sh'], () => {
    git(d, 'checkout', '--', 'x.sh', 'plain.txt');
    fs.unlinkSync(path.join(d, 'new.sh'));
  });
  const modes = Object.fromEntries(git(d, 'ls-tree', `${backup}^`).trim().split('\n')
    .map((l) => /^(\d+) \w+ \w+\t(.*)$/.exec(l)).map((m) => [m[2], m[1]]));
  if (process.platform === 'win32') {
    // No executable bit on disk: the index entry's mode (an untracked file has none: 100644).
    assert.deepEqual(modes, { 'README.md': '100644', 'new.sh': '100644', 'plain.txt': '100644', 'x.sh': '100755' });
    return;
  }
  // Elsewhere the bits on disk, as before core.fileMode was read at all: undo puts back what was there.
  assert.deepEqual(modes, { 'README.md': '100644', 'new.sh': '100755', 'plain.txt': '100755', 'x.sh': '100644' });
  await undo.undo(d);
  assert.notEqual(fs.statSync(path.join(d, 'plain.txt')).mode & 0o100, 0, 'the +x the discard took away is back');
  assert.notEqual(fs.statSync(path.join(d, 'new.sh')).mode & 0o100, 0);
  assert.equal(fs.statSync(path.join(d, 'x.sh')).mode & 0o111, 0);
});

test('withDiscardBackup refuses paths that match nothing (kind stale) before fn runs', async () => {
  const d = initRepo();
  let ran = false;
  await assert.rejects(undo.withDiscardBackup(d, ['nope.txt', 'gone/dir'], async () => { ran = true; }), (e) => e.kind === 'stale');
  assert.equal(ran, false);
});

// ---- undo/redo are not cancellable once they start changing things ----------------------------

test('undo apply phase ignores cancellation (a slow post-checkout hook finishes)', async () => {
  const exec = require('../src/exec');
  const d = initRepo();
  git(d, 'checkout', '-q', '-b', 'side');
  const marker = path.join(d, '.git', 'hook-started');
  fs.writeFileSync(path.join(d, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch "${marker}"\nsleep 1\ntouch "${marker}.done"\n`, { mode: 0o755 });
  const ctrl = new AbortController();
  const p = exec.withSignal(ctrl.signal, () => undo.undo(d));
  const started = Date.now();
  while (!fs.existsSync(marker)) {
    assert.ok(Date.now() - started < 20000, 'hook never ran');
    await new Promise((r) => setTimeout(r, 20));
  }
  ctrl.abort();
  assert.deepEqual(await p, { action: 'checkout', description: 'Undo checkout of side' });
  assert.ok(fs.existsSync(`${marker}.done`));
  assert.equal(branch(d), 'main');
});

test('a discard undo that fails part way carries the backup sha (err.backup)', { skip: process.getuid && process.getuid() === 0 }, async (t) => {
  const d = initRepo();
  commitFile(d, 'a.txt', 'a\n', 'a');
  commitFile(d, 'ro/b.txt', 'b\n', 'b');
  write(d, 'a.txt', 'mine a\n');
  write(d, 'ro/b.txt', 'mine b\n');
  const sha = await discard(d, ['a.txt', 'ro/b.txt']);
  // b.txt and its folder become read-only: the snapshot still matches `after` (only the
  // executable bit counts), so undo is offered, but writing b.txt back fails.
  fs.chmodSync(path.join(d, 'ro/b.txt'), 0o444);
  fs.chmodSync(path.join(d, 'ro'), 0o555);
  t.after(() => fs.chmodSync(path.join(d, 'ro'), 0o755));
  assert.equal((await undo.getState(d)).undo.action, 'discard');
  const err = await undo.undo(d).then(() => null, (e) => e);
  assert.ok(err, 'undo failed');
  assert.equal(err.backup, sha);
  assert.equal(read(d, 'ro/b.txt'), 'b\n');
});

// ---- entries earlier versions wrote --------------------------------------------------------------

test('the old "discard:" / "delete_branch:" reflog entries still undo and redo', async () => {
  const d = initRepo();
  git(d, 'branch', 'old');
  const sha = head(d);
  git(d, 'branch', '-D', 'old');
  git(d, 'reflog', 'write', 'HEAD', sha, sha, `delete_branch: old - [${sha}]`);
  let s = await undo.getState(d);
  assert.equal(s.undo.action, 'delete_branch');
  assert.equal(s.undo.description, 'Undo delete of branch old');
  await undo.undo(d);
  assert.equal(git(d, 'rev-parse', 'old').trim(), sha);
  assert.equal(git(d, 'reflog', '-1', '--format=%gs').trim(), `undo: delete_branch: old - [${sha}]`, 'the reversal names the entry as written');
  s = await undo.getState(d);
  assert.equal(s.redo.action, 'delete_branch');
  await undo.redo(d);
  assert.throws(() => git(d, 'rev-parse', '--verify', '-q', 'refs/heads/old'));

  // A discard backup logged the old way: made with the new code, then the entry rewritten.
  write(d, 'README.md', 'mine\n');
  const backup = await discard(d, ['README.md']);
  git(d, 'reflog', 'write', 'HEAD', head(d), head(d), `discard: [${backup}] 1 file(s)`);
  s = await undo.getState(d);
  assert.equal(s.undo.action, 'discard');
  assert.equal(s.undo.description, 'Undo discard of 1 file');
  await undo.undo(d);
  assert.equal(read(d, 'README.md'), 'mine\n');
});

// ---- branch names from the reflog are data, never options -------------------------------------

test('a crafted delete-branch reflog entry cannot inject options; recreation never overwrites a branch', async () => {
  const d = initRepo();
  const sha = head(d);
  for (const name of ['--edit-description', '-D', 'a..b', 'x@{1}']) {
    for (const marker of ['pasta-lite delete-branch', 'delete_branch:']) {
      git(d, 'reflog', 'write', 'HEAD', sha, sha, `${marker} ${name} - [${sha}]`);
      const s = await undo.getState(d);
      assert.equal(s.undo, null, `${marker} ${name}`);
      await assert.rejects(undo.undo(d), (e) => e.kind === 'nothing', name);
    }
  }
  assert.equal(git(d, 'for-each-ref', '--format=%(refname)', 'refs/heads').trim(), 'refs/heads/main');
});

test('branch delete undo reports upstreamRestored: false when the upstream is gone', async () => {
  const d = initRepo();
  git(d, 'branch', 'tmp');
  const sha = head(d);
  git(d, 'branch', '-D', 'tmp');
  await undo.recordBranchDelete(d, { name: 'tmp', sha, upstream: 'origin/gone' });
  const r = await undo.undo(d);
  assert.deepEqual(r, { action: 'delete_branch', description: 'Undo delete of branch tmp', upstreamRestored: false });
  assert.equal(git(d, 'rev-parse', 'tmp').trim(), sha);
});

// ---- getState caches the discard snapshot -----------------------------------------------------

test('getState reuses the discard check while the index and the backed-up paths are unchanged', async () => {
  const d = initRepo();
  write(d, 'README.md', 'mine\n');
  await discard(d, ['README.md']);
  const stats = undo._internal.stats;
  const n0 = stats.snapshots;
  assert.equal((await undo.getState(d)).undo.action, 'discard');
  assert.equal(stats.snapshots, n0 + 1);
  assert.equal((await undo.getState(d)).undo.action, 'discard');
  assert.equal(stats.snapshots, n0 + 1, 'second refresh is cached');
  // an edit to a backed-up path invalidates it
  write(d, 'README.md', 'edited!\n');
  assert.equal((await undo.getState(d)).undoBlocked, 'Files changed since the discard');
  assert.equal(stats.snapshots, n0 + 2);
  write(d, 'README.md', 'hello\n');
  assert.equal((await undo.getState(d)).undo.action, 'discard');
  // so does an index change
  const n1 = stats.snapshots;
  write(d, 'other.txt', 'o\n');
  git(d, 'add', 'other.txt');
  await undo.getState(d);
  assert.equal(stats.snapshots, n1 + 1);
  // undo itself never trusts the cache
  await undo.undo(d);
  assert.equal(read(d, 'README.md'), 'mine\n');
});
