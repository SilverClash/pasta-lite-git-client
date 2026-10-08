'use strict';
// Second review of rebase / merge (backend): prepared messages of an earlier rebase never reach a
// later one, dirty submodules never block the autostash, Skip never throws away unrelated work,
// the orphan autostash of another worktree is never adopted, a stash whose untracked files are in
// the way is kept whole, non-hook stops aren't called hook stops, Continue's message where git
// can take one, expectBranch, the autostash fields only while the stash exists, a cancelled
// interactive start, a failed re-apply or merge abort that keeps the autostash, worktrees git
// would prune, a rebase that reads as ours while git starts it, and serializeError's `result`.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const h = require('./helpers');
const g = require('../src/git');
const ops = require('../src/ops');
const rebase = require('../src/rebase');
const autostash = require('../src/autostash');

after(h.cleanup);

const head = (dir) => h.git(dir, 'rev-parse', 'HEAD').trim();
const subjects = (dir, range) => h.git(dir, 'log', '--format=%s', range).trim().split('\n').filter(Boolean);
const stashList = (dir) => h.git(dir, 'stash', 'list', '--format=%H').trim().split('\n').filter(Boolean);
const gitDirOf = (dir) => h.git(dir, 'rev-parse', '--absolute-git-dir').trim();
const exists = (dir, file) => fs.existsSync(path.join(dir, file));
const autostashRef = (dir) => {
  try {
    return h.git(dir, 'rev-parse', '-q', '--verify', autostash.AUTOSTASH_REF).trim();
  } catch {
    return null;
  }
};

/** git as a terminal user would run it (who accepts every editor: GIT_EDITOR=true). */
function term(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true' } });
}

function hook(dir, name, body) {
  fs.writeFileSync(path.join(gitDirOf(dir), 'hooks', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** feat: A (a.txt: conflicts with main), B (b.txt); main: "main change" (a.txt). feat checked out. */
function diverged(dir = h.initRepo()) {
  h.git(dir, 'checkout', '-q', '-b', 'feat');
  const A = h.commitFile(dir, 'a.txt', 'feat\n', 'A original');
  const B = h.commitFile(dir, 'b.txt', 'b\n', 'B');
  h.git(dir, 'checkout', '-q', 'main');
  const M = h.commitFile(dir, 'a.txt', 'main\n', 'main change');
  h.git(dir, 'checkout', '-q', 'feat');
  return { dir, A, B, M };
}

/** A repo whose main has a submodule 'sub' (content can be edited in place). */
function withSubmodule() {
  const sub = h.initRepo();
  const dir = h.initRepo();
  h.git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');
  h.git(dir, 'commit', '-q', '-m', 'add sub');
  return dir;
}

describe('prepared messages of an earlier rebase', () => {
  test("a terminal's rebase continued in the app keeps its commit's message, not one prepared for an aborted rebase", async () => {
    const { dir, A, B, M } = diverged();
    const r = await rebase.startInteractive(dir, {
      upstream: M, todo: [{ cmd: 'reword', sha: A }, { cmd: 'pick', sha: B }], messages: { [A]: 'STALE reworded message' },
    });
    assert.equal(r.state.stop, 'conflict');
    term(dir, ['rebase', '--abort']);
    assert.throws(() => term(dir, ['rebase', 'main']));
    const st = await g.status(dir);
    assert.equal(st.rebase.ours, false);
    h.write(dir, 'a.txt', 'resolved\n');
    h.git(dir, 'add', 'a.txt');
    const c = await ops.createRunner().run(dir, 'rebaseContinue', []);
    assert.equal(c.status, 'done');
    assert.deepEqual(subjects(dir, `${M}..HEAD`), ['B', 'A original']);
    assert.equal(fs.existsSync(path.join(gitDirOf(dir), 'pasta-lite', 'rebase')), false);
  });

  test("a message given in the app to a terminal's rebase is used, and only for that commit", async () => {
    const { dir, A, B, M } = diverged();
    await rebase.startInteractive(dir, { upstream: M, todo: [{ cmd: 'reword', sha: A }, { cmd: 'reword', sha: B }], messages: { [A]: 'STALE A', [B]: 'STALE B' } });
    term(dir, ['rebase', '--abort']);
    assert.throws(() => term(dir, ['rebase', 'main']));
    h.write(dir, 'a.txt', 'resolved\n');
    h.git(dir, 'add', 'a.txt');
    const c = await ops.createRunner().run(dir, 'rebaseContinue', [{ message: 'A from the app' }]);
    assert.equal(c.status, 'done');
    assert.deepEqual(subjects(dir, `${M}..HEAD`), ['B', 'A from the app']);
  });
});

describe('a dirty submodule never keeps the autostash away', () => {
  test('a rebase with autostash finishes with the changes back; the submodule is left as it was', async () => {
    const { dir, M } = diverged(withSubmodule());
    h.git(dir, 'checkout', '-q', 'main');
    h.git(dir, 'reset', '-q', '--hard', `${M}~1`);
    h.commitFile(dir, 'm.txt', 'm\n', 'main change'); // no conflict with feat
    h.git(dir, 'checkout', '-q', 'feat');
    h.write(dir, 'sub/README.md', 'edited inside the submodule\n');
    h.write(dir, 'README.md', 'my local edit\n');
    const r = await ops.OPS.rebase(dir, 'main');
    assert.equal(r.status, 'done');
    assert.equal(r.stash, undefined);
    assert.equal(h.read(dir, 'README.md'), 'my local edit\n');
    assert.equal(h.read(dir, 'sub/README.md'), 'edited inside the submodule\n');
    assert.deepEqual(stashList(dir), []);
    assert.equal(autostashRef(dir), null);
  });

  test("checkout's autostash (withAutostash) and Restore aren't blocked by one either", async () => {
    const dir = withSubmodule();
    h.commitFile(dir, 'x.txt', 'a\nb\nc\n', 'x');
    h.git(dir, 'checkout', '-q', '-b', 'other');
    h.commitFile(dir, 'x.txt', 'A\nb\nc\n', 'other x');
    h.git(dir, 'checkout', '-q', 'main');
    h.write(dir, 'x.txt', 'a\nb\nC\n');
    h.write(dir, 'sub/README.md', 'dirty\n');
    await ops.createRunner().run(dir, 'checkout', ['other']);
    assert.equal(h.read(dir, 'x.txt'), 'A\nb\nC\n');
    assert.deepEqual(stashList(dir), []);

    // A pending autostash (a terminal aborted the rebase) is restored with the submodule dirty.
    h.git(dir, 'checkout', '-q', '-f', 'main');
    const { M } = diverged(dir);
    h.write(dir, 'README.md', 'my local edit\n');
    assert.equal((await ops.OPS.rebase(dir, M)).status, 'stopped');
    term(dir, ['rebase', '--abort']);
    h.write(dir, 'sub/README.md', 'dirty again\n');
    assert.deepEqual(await ops.createRunner().run(dir, 'restoreAutostash', []), { restored: true, indexRestored: true });
    assert.equal(h.read(dir, 'README.md'), 'my local edit\n');
  });
});

describe('Skip', () => {
  test('refused (dirty) while tracked files have other changes, staged or not; nothing is touched', async () => {
    const { dir } = diverged();
    const runner = ops.createRunner();
    assert.equal((await runner.run(dir, 'rebase', ['main'])).state.stop, 'conflict');
    h.write(dir, 'README.md', 'unrelated work typed during the stop\n');
    h.write(dir, 'staged.txt', 'new staged file\n');
    h.git(dir, 'add', 'staged.txt');
    await assert.rejects(runner.run(dir, 'rebaseSkip', []), (e) => e.kind === 'dirty' && e.count === 2
      && [...e.paths].sort().join() === 'README.md,staged.txt');
    assert.equal(h.read(dir, 'README.md'), 'unrelated work typed during the stop\n');
    assert.match(h.git(dir, 'status', '--porcelain'), /^A {2}staged\.txt$/m);
    assert.equal((await g.status(dir)).state, 'rebasing');
  });

  test('with only the conflicted files (and untracked ones) changed, Skip leaves the commit out', async () => {
    const { dir, M } = diverged();
    const runner = ops.createRunner();
    await runner.run(dir, 'rebase', ['main']);
    h.write(dir, 'a.txt', 'half resolved\n');
    h.write(dir, 'notes.txt', 'untracked notes\n');
    const res = await runner.run(dir, 'rebaseSkip', []);
    assert.equal(res.status, 'done');
    assert.deepEqual(subjects(dir, `${M}..HEAD`), ['B']);
    assert.equal(h.read(dir, 'a.txt'), 'main\n');
    assert.equal(h.read(dir, 'notes.txt'), 'untracked notes\n');
  });

  test('refused (invalid-args) at an edit stop, where the commit is already made', async () => {
    const dir = h.initRepo();
    const base = head(dir);
    const A = h.commitFile(dir, 'a.txt', 'a\n', 'A');
    const B = h.commitFile(dir, 'b.txt', 'b\n', 'B');
    const runner = ops.createRunner();
    const r = await runner.run(dir, 'rebaseInteractive', [{ upstream: base }, [{ action: 'edit', sha: A }, { action: 'pick', sha: B }], {}]);
    assert.equal(r.state.stop, 'edit');
    await assert.rejects(runner.run(dir, 'rebaseSkip', []), (e) => e.kind === 'invalid-args' && /edit stop/.test(e.message));
    assert.equal((await g.status(dir)).rebase.stop, 'edit');
  });
});

describe('the orphan autostash and linked worktrees', () => {
  test("another worktree's stash is never taken for this worktree's orphan", async () => {
    const { dir: A, M } = diverged();
    h.git(A, 'checkout', '-q', 'main');
    const B = h.tmpDir('wt-');
    h.git(A, 'worktree', 'add', '-q', B, 'feat');
    // A: the app died after writing its intent file, before `stash push` (an old-format one too).
    const pl = path.join(gitDirOf(A), 'pasta-lite');
    fs.mkdirSync(pl, { recursive: true });
    fs.writeFileSync(path.join(pl, 'autostash-intent'), JSON.stringify({ id: 'aaaaaaaaaaaa', time: Date.now() }));
    h.write(B, 'README.md', 'B local change\n');
    const r = await rebase.start(B, { onto: M });
    assert.equal(r.status, 'stopped');
    assert.ok(r.state.autostash);
    assert.equal((await g.status(A)).pendingAutostash, null);
    fs.writeFileSync(path.join(pl, 'autostash-intent'), JSON.stringify({ before: null }));
    assert.equal((await g.status(A)).pendingAutostash, null, 'an intent without an id finds no orphan');
    await assert.rejects(ops.createRunner().run(A, 'restoreAutostash', []), { kind: 'nothing' });
    h.write(B, 'a.txt', 'resolved\n');
    h.git(B, 'add', 'a.txt');
    const c = await rebase.continue_(B);
    assert.equal(c.status, 'done');
    assert.equal(c.stash, undefined);
    assert.equal(h.read(B, 'README.md'), 'B local change\n');
    assert.equal(h.read(A, 'README.md'), 'hello\n');
  });

  test("an orphan in a linked worktree is found there only, by its id, and not when it is older than the intent", async () => {
    const { dir: A } = diverged();
    h.git(A, 'checkout', '-q', 'main');
    const B = h.tmpDir('wt-');
    h.git(A, 'worktree', 'add', '-q', B, 'feat');
    const pl = path.join(gitDirOf(B), 'pasta-lite');
    fs.mkdirSync(pl, { recursive: true });
    const intent = (time) => fs.writeFileSync(path.join(pl, 'autostash-intent'), JSON.stringify({ id: '0123456789ab', time }));
    intent(Date.now());
    h.write(B, 'b.txt', 'mine\n');
    h.git(B, 'stash', 'push', '-q', '-m', 'pasta-lite autostash before rebase of feat [0123456789ab]');
    const orphan = h.git(B, 'rev-parse', 'refs/stash').trim();
    assert.equal((await g.status(B)).pendingAutostash, orphan);
    assert.equal((await g.status(A)).pendingAutostash, null);
    intent(Date.now() + 60000);
    assert.equal((await g.status(B)).pendingAutostash, null);
  });
});

describe('untracked files of the autostash', () => {
  test("one of them is in the way at the finish: nothing is applied, stash and ref kept (reason 'untracked'), Restore works later", async () => {
    const { dir, M } = diverged();
    h.write(dir, 'README.md', 'tracked local edit\n');
    h.write(dir, 'a-untracked.txt', 'mine A\n');
    h.write(dir, 'z-untracked.txt', 'mine Z\n');
    assert.equal((await rebase.start(dir, { onto: M })).status, 'stopped');
    h.write(dir, 'z-untracked.txt', 'created during the stop\n');
    h.write(dir, 'a.txt', 'resolved\n');
    h.git(dir, 'add', 'a.txt');
    const c = await rebase.continue_(dir);
    assert.equal(c.status, 'done');
    assert.equal(c.stash.reason, 'untracked');
    assert.equal(h.read(dir, 'README.md'), 'hello\n');
    assert.equal(exists(dir, 'a-untracked.txt'), false, 'none of the stash was applied');
    assert.equal(autostashRef(dir), c.stash.sha);
    assert.equal((await g.status(dir)).pendingAutostash, c.stash.sha);
    fs.rmSync(path.join(dir, 'z-untracked.txt'));
    assert.deepEqual(await ops.createRunner().run(dir, 'restoreAutostash', []), { restored: true, indexRestored: true });
    assert.equal(h.read(dir, 'README.md'), 'tracked local edit\n');
    assert.equal(h.read(dir, 'z-untracked.txt'), 'mine Z\n');
    assert.equal(autostashRef(dir), null);
  });

  test('a re-apply that conflicts removes the untracked files it had restored; the stash keeps them', async () => {
    const { dir, M } = diverged();
    h.write(dir, 'a.txt', 'mine\n');
    h.write(dir, 'u.txt', 'untracked\n');
    assert.equal((await rebase.start(dir, { onto: M })).status, 'stopped');
    h.write(dir, 'a.txt', 'resolved\n');
    h.git(dir, 'add', 'a.txt');
    const c = await rebase.continue_(dir);
    assert.equal(c.status, 'done');
    assert.equal(c.stash.reason, 'conflict');
    assert.equal(exists(dir, 'u.txt'), false);
    assert.equal(h.git(dir, 'status', '--porcelain'), '');
    assert.deepEqual(stashList(dir), [c.stash.sha]);
    assert.equal(h.git(dir, 'show', `${c.stash.sha}^3:u.txt`), 'untracked\n');
  });
});

describe('why a rebase or merge stopped', () => {
  test("an untracked file in the way of a pick is not a hook stop, even with a commit hook installed", async () => {
    const dir = h.initRepo();
    h.git(dir, 'checkout', '-q', '-b', 'feat');
    h.commitFile(dir, 'a.txt', 'feat\n', 'A');
    h.commitFile(dir, 'new.txt', 'from B\n', 'B adds new.txt');
    h.git(dir, 'checkout', '-q', 'main');
    const M = h.commitFile(dir, 'a.txt', 'main\n', 'main change');
    h.git(dir, 'checkout', '-q', 'feat');
    hook(dir, 'pre-commit', 'exit 0'); // husky / lint-staged
    await rebase.start(dir, { onto: M, autostash: false });
    h.write(dir, 'a.txt', 'resolved\n');
    h.git(dir, 'add', 'a.txt');
    h.write(dir, 'new.txt', 'my untracked file\n');
    await assert.rejects(ops.createRunner().run(dir, 'rebaseContinue', []), (e) => e.rebase && e.rebase.stop === 'other' && e.rebase.hookOutput === null);
    assert.equal((await g.status(dir)).rebase.stop, 'other');
  });

  test("a merge stopped by a signing failure is 'other' even with a merge hook installed", async () => {
    const dir = h.initRepo();
    h.git(dir, 'branch', 'feat');
    h.commitFile(dir, 'm.txt', 'm\n', 'main');
    h.git(dir, 'checkout', '-q', 'feat');
    h.commitFile(dir, 'f.txt', 'f\n', 'feat');
    h.git(dir, 'checkout', '-q', 'main');
    hook(dir, 'pre-merge-commit', 'exit 0');
    const prog = path.join(h.tmpDir(), 'sign.sh');
    fs.writeFileSync(prog, '#!/bin/sh\necho "signing failed: no key" >&2\nexit 1\n', { mode: 0o755 });
    h.git(dir, 'config', 'gpg.program', prog);
    h.git(dir, 'config', 'commit.gpgSign', 'true');
    const res = await ops.OPS.merge(dir, 'feat', { ff: 'no-ff' });
    assert.equal(res.status, 'stopped');
    assert.equal(res.stop, 'other');
    assert.equal(res.hookOutput, undefined);
  });
});

describe('Continue with a message', () => {
  test("refused (invalid-args) for an apply-backend rebase, which can't take one", async () => {
    const { dir } = diverged();
    assert.throws(() => term(dir, ['rebase', '--apply', 'main']));
    h.write(dir, 'a.txt', 'resolved\n');
    h.git(dir, 'add', 'a.txt');
    await assert.rejects(ops.createRunner().run(dir, 'rebaseContinue', [{ message: 'NEW' }]), { kind: 'invalid-args' });
    assert.equal((await g.status(dir)).rebase.backend, 'apply');
  });

  test('accepted at a hook stop: the commit gets the message given then', async () => {
    const dir = h.initRepo();
    const base = head(dir);
    const c1 = h.commitFile(dir, 'b.txt', 'b\n', 'old subject');
    const flag = path.join(h.tmpDir(), 'ok');
    hook(dir, 'commit-msg', `[ -f '${flag}' ] || { echo "rejected by commit-msg" >&2; exit 1; }`);
    const runner = ops.createRunner();
    const r = await runner.run(dir, 'rebaseInteractive', [{ upstream: base }, [{ action: 'reword', sha: c1 }], { messages: { [c1]: 'FIRST TRY' } }]);
    assert.equal(r.state.stop, 'hook');
    fs.writeFileSync(flag, '');
    const c = await runner.run(dir, 'rebaseContinue', [{ message: 'SECOND TRY' }]);
    assert.equal(c.status, 'done');
    assert.deepEqual(subjects(dir, `${base}..HEAD`), ['SECOND TRY']);
  });
});

test('expectBranch: a different checked-out branch (or a detached HEAD) is stale', async () => {
  const { dir, A, B } = diverged();
  const runner = ops.createRunner();
  await assert.rejects(runner.run(dir, 'rebase', ['main', { expectBranch: 'main' }]), { kind: 'stale' });
  await assert.rejects(runner.run(dir, 'rebase', ['main', { expectBranch: null }]), { kind: 'stale' });
  await assert.rejects(runner.run(dir, 'rebase', ['main', { expectBranch: 7 }]), { kind: 'invalid-args' });
  const todo = [{ action: 'drop', sha: A }, { action: 'pick', sha: B }];
  await assert.rejects(runner.run(dir, 'rebaseInteractive', [{ upstream: 'main' }, todo, { expectBranch: 'other' }]), { kind: 'stale' });
  await assert.rejects(runner.run(dir, 'merge', ['main', { expectBranch: 'main' }]), { kind: 'stale' });
  assert.equal((await g.status(dir)).state, 'clean');
  h.git(dir, 'checkout', '-q', '--detach');
  await assert.rejects(runner.run(dir, 'rebase', ['main', { expectBranch: 'feat' }]), { kind: 'stale' });
  const res = await runner.run(dir, 'rebaseInteractive', [{ upstream: 'main' }, todo, { expectBranch: null, expectHead: B }]);
  assert.equal(res.status, 'done');
});

describe('the autostash fields of status only while the stash exists', () => {
  test('status.merge.autostash; dropped by hand, Commit and Merge no longer refuses unstaged changes', async () => {
    const { dir } = diverged();
    h.git(dir, 'checkout', '-q', 'main');
    h.write(dir, 'README.md', 'local\n');
    const res = await ops.OPS.merge(dir, 'feat');
    assert.equal(res.stop, 'conflict');
    const stash = autostashRef(dir);
    assert.equal((await g.status(dir)).merge.autostash, stash);
    h.write(dir, 'a.txt', 'resolved\n');
    h.git(dir, 'add', 'a.txt');
    h.write(dir, 'README.md', 'typed meanwhile\n');
    await assert.rejects(ops.createRunner().run(dir, 'mergeCommit', []), { kind: 'dirty' });
    h.git(dir, 'stash', 'drop', '-q');
    assert.equal((await g.status(dir)).merge.autostash, null);
    assert.equal((await ops.createRunner().run(dir, 'mergeCommit', [])).status, 'done');
    assert.equal(h.read(dir, 'README.md'), 'typed meanwhile\n');
  });

  test('status.rebase.autostash', async () => {
    const { dir } = diverged();
    h.write(dir, 'README.md', 'local\n');
    const r = await ops.OPS.rebase(dir, 'main');
    assert.equal(r.state.autostash, autostashRef(dir));
    h.git(dir, 'stash', 'drop', '-q');
    assert.equal((await g.status(dir)).rebase.autostash, null);
  });
});

describe('cancel and failed steps keep the autostash', () => {
  test('cancelling an interactive start before its first command: aborted with the stopped rebase (not invalid-todo); Abort restores', { skip: process.platform === 'win32' && 'cancelling does not stop git on Windows yet (src/git-process.js signals the pid only, no process group)' }, async () => {
    const dir = h.initRepo();
    const base = head(dir);
    const c1 = h.commitFile(dir, 'b.txt', 'b\n', 'one');
    const c2 = h.commitFile(dir, 'c.txt', 'c\n', 'two');
    h.write(dir, 'README.md', 'local\n');
    const started = path.join(h.tmpDir(), 'started');
    hook(dir, 'post-checkout', `: > '${started}'\nsleep 10`);
    const runner = ops.createRunner();
    const p = runner.run(dir, 'rebaseInteractive', [{ upstream: base }, [{ action: 'reword', sha: c1 }, { action: 'pick', sha: c2 }], { messages: { [c1]: 'NEW' } }], { opId: 'ir' });
    await waitFor(() => fs.existsSync(started));
    assert.equal(runner.cancel('ir'), true);
    await assert.rejects(p, (e) => e.kind === 'aborted' && !!e.rebase && e.rebase.ours === true);
    fs.rmSync(path.join(gitDirOf(dir), 'hooks', 'post-checkout'));
    const a = await runner.run(dir, 'rebaseAbort', []);
    assert.equal(a.status, 'aborted');
    assert.equal(head(dir), c2);
    assert.equal(h.read(dir, 'README.md'), 'local\n');
  });

  test("a re-apply git gives up on without conflicts (index.lock) keeps the ref: Restore works once it's gone", async () => {
    const { dir } = diverged();
    h.write(dir, 'README.md', 'local\n');
    await ops.OPS.rebase(dir, 'main');
    term(dir, ['rebase', '--abort']);
    const stash = autostashRef(dir);
    const lock = path.join(gitDirOf(dir), 'index.lock');
    fs.writeFileSync(lock, '');
    const res = await autostash.restoreAutostash(dir);
    assert.equal(res.restored, false);
    assert.deepEqual(res.stash, { kept: true, sha: stash, reason: 'index' });
    assert.equal(autostashRef(dir), stash);
    fs.rmSync(lock);
    assert.equal((await ops.createRunner().run(dir, 'restoreAutostash', [])).restored, true);
    assert.equal(h.read(dir, 'README.md'), 'local\n');
  });

  test('a merge --abort that fails keeps the merge and the autostash; a later Abort brings it back', async () => {
    const { dir } = diverged();
    h.git(dir, 'checkout', '-q', 'main');
    h.write(dir, 'README.md', 'local\n');
    await ops.OPS.merge(dir, 'feat');
    const stash = autostashRef(dir);
    const lock = path.join(gitDirOf(dir), 'index.lock');
    fs.writeFileSync(lock, '');
    const runner = ops.createRunner();
    await assert.rejects(runner.run(dir, 'mergeAbort', []), (e) => !!e.merge);
    assert.equal((await g.status(dir)).state, 'merging');
    assert.equal(autostashRef(dir), stash);
    fs.rmSync(lock);
    const a = await runner.run(dir, 'mergeAbort', []);
    assert.equal(a.status, 'aborted');
    assert.equal(h.read(dir, 'README.md'), 'local\n');
  });
});

test('a legacy ref with a worktree git would prune (not locked): pending here, also once packed', async () => {
  const dir = h.initRepo();
  const wt = h.tmpDir('wt-');
  h.git(dir, 'worktree', 'add', '-q', '--detach', wt);
  h.git(dir, 'worktree', 'lock', wt);
  fs.rmSync(wt, { recursive: true, force: true });
  h.write(dir, 'README.md', 'local\n');
  h.git(dir, 'stash', 'push', '-q');
  const stash = h.git(dir, 'rev-parse', 'refs/stash').trim();
  h.git(dir, 'update-ref', autostash.LEGACY_AUTOSTASH_REF, stash);
  assert.equal((await g.status(dir)).pendingAutostash, null, 'a locked worktree is kept');
  h.git(dir, 'worktree', 'unlock', wt);
  assert.equal((await g.status(dir)).pendingAutostash, stash);
  h.git(dir, 'pack-refs', '--all');
  assert.equal(fs.existsSync(path.join(dir, '.git', autostash.LEGACY_AUTOSTASH_REF)), false);
  assert.equal((await g.status(dir)).pendingAutostash, stash);
});

test('a rebase we start reads as ours while git is still starting it', async () => {
  const { dir, M } = diverged();
  h.git(dir, 'checkout', '-q', 'main');
  h.git(dir, 'reset', '-q', '--hard', `${M}~1`);
  h.commitFile(dir, 'm.txt', 'm\n', 'main change');
  h.git(dir, 'checkout', '-q', 'feat');
  const started = path.join(h.tmpDir(), 'started');
  const go = path.join(h.tmpDir(), 'go');
  hook(dir, 'post-checkout', `: > '${started}'\nwhile [ ! -f '${go}' ]; do sleep 0.05; done`);
  const p = ops.OPS.rebase(dir, 'main');
  await waitFor(() => fs.existsSync(started));
  const st = await g.status(dir);
  fs.writeFileSync(go, '');
  assert.equal(st.state, 'rebasing');
  assert.equal(st.rebase.ours, true);
  assert.equal((await p).status, 'done');
});

test("serializeError keeps a finished op's result, stash fields included", () => {
  const err = Object.assign(new Error('could not re-apply'), {
    kind: 'stash-conflict', stashKept: true, stash: 'a'.repeat(40), reason: 'conflict',
    result: { status: 'done', before: 'b'.repeat(40), stash: { kept: true, sha: 'a'.repeat(40), reason: 'conflict' } },
  });
  const s = ops.serializeError(err);
  assert.deepEqual(s.result, err.result);
  assert.equal(s.stash, 'a'.repeat(40));
  assert.equal(s.reason, 'conflict');
});

describe('a rebase whose todo runs commands: only Abort', () => {
  /** A rebase a terminal started with `--exec`, stopped at A's conflict, resolved and staged. */
  function execRebase() {
    const { dir, M } = diverged();
    const marker = path.join(h.tmpDir(), 'ran');
    assert.throws(() => term(dir, ['rebase', '-i', '--exec', `touch '${marker}'`, 'main']));
    h.write(dir, 'a.txt', 'resolved\n');
    h.git(dir, 'add', 'a.txt');
    return { dir, M, marker };
  }

  test("a terminal's rebase with exec lines: Continue and Skip are refused, nothing runs; Abort works", async () => {
    const { dir, marker } = execRebase();
    const st = await g.status(dir);
    assert.equal(st.rebase.ours, false);
    assert.equal(st.rebase.runsCommands, true);
    const runner = ops.createRunner();
    await assert.rejects(runner.run(dir, 'rebaseContinue', []), (e) => e.kind === 'rebase-exec' && /runs commands/.test(e.message));
    await assert.rejects(runner.run(dir, 'rebaseContinue', [{ message: 'A' }]), (e) => e.kind === 'rebase-exec');
    await assert.rejects(runner.run(dir, 'rebaseSkip', []), (e) => e.kind === 'rebase-exec');
    await assert.rejects(rebase.continue_(dir), (e) => e.kind === 'rebase-exec', 'the backend refuses it too');
    await assert.rejects(rebase.skip(dir), (e) => e.kind === 'rebase-exec');
    assert.equal(fs.existsSync(marker), false);
    assert.equal((await g.status(dir)).state, 'rebasing', 'nothing changed');
    assert.equal((await runner.run(dir, 'rebaseAbort', [])).status, 'aborted');
    assert.equal(fs.existsSync(marker), false);
    // What the refusal guards against: a git that continues runs it.
    const again = execRebase();
    term(again.dir, ['rebase', '--continue']);
    assert.equal(fs.existsSync(again.marker), true);
  });

  test('also when the rebase reads as ours: an exec line added to its todo is refused', async () => {
    const { dir } = diverged();
    const marker = path.join(h.tmpDir(), 'ran');
    assert.equal((await ops.OPS.rebase(dir, 'main')).status, 'stopped');
    fs.appendFileSync(path.join(gitDirOf(dir), 'rebase-merge', 'git-rebase-todo'), `  x touch '${marker}'\n`);
    h.write(dir, 'a.txt', 'resolved\n');
    h.git(dir, 'add', 'a.txt');
    const st = await g.status(dir);
    assert.equal(st.rebase.ours, true);
    assert.equal(st.rebase.runsCommands, true);
    await assert.rejects(ops.createRunner().run(dir, 'rebaseContinue', []), (e) => e.kind === 'rebase-exec');
    assert.equal(fs.existsSync(marker), false);
  });

  test('a todo that can\'t be read whole counts as one that runs commands; a plain one doesn\'t', async () => {
    const { dir } = diverged();
    assert.equal((await ops.OPS.rebase(dir, 'main')).status, 'stopped');
    assert.equal((await g.status(dir)).rebase.runsCommands, false);
    const todo = path.join(gitDirOf(dir), 'rebase-merge', 'git-rebase-todo');
    const elsewhere = path.join(h.tmpDir(), 'todo');
    fs.renameSync(todo, elsewhere);
    fs.symlinkSync(elsewhere, todo);
    assert.equal((await g.status(dir)).rebase.runsCommands, true, 'a symlink');
    fs.rmSync(todo);
    fs.writeFileSync(todo, `${'# a comment line\n'.repeat(70000)}pick ${head(dir)}\n`);
    assert.equal((await g.status(dir)).rebase.runsCommands, true, 'over the size we read');
  });
});
