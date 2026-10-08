'use strict';
// Rebase / merge in progress (docs/plans/rebase.md §9.1, R1): Pull (rebase) stops, Continue /
// Skip / Abort through the ops runner, our persistent autostash, rebases and merges started in
// a terminal, the commit refusal at a conflict stop, cancellation. Every repo runs under
// helpers.hostileConfig (rebase.backend=apply, core.commentChar=;, commit.cleanup=verbatim ...).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const h = require('./helpers');
const g = require('../src/git');
const ops = require('../src/ops');
const autostash = require('../src/autostash');
const rebaseState = require('../src/rebase-state');
const gitfiles = require('../src/gitfiles');

after(h.cleanup);

const ALICE = 'Alice <alice@example.com>';
const head = (dir) => h.git(dir, 'rev-parse', 'HEAD').trim();
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
const subjects = (dir, range) => h.git(dir, 'log', '--format=%s', range).trim().split('\n');
const stashList = (dir) => h.git(dir, 'stash', 'list', '--format=%H').trim().split('\n').filter(Boolean);
const autostashRef = (dir) => {
  try {
    return h.git(dir, 'rev-parse', '-q', '--verify', 'refs/worktree/pasta-lite/autostash').trim();
  } catch {
    return null;
  }
};
const split = async (dir) => {
  const st = await g.status(dir);
  return { staged: st.staged, unstaged: st.unstaged };
};

/** git as a terminal user would run it (who accepts every editor: GIT_EDITOR=true). */
function term(dir, args, env = {}) {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_EDITOR: 'true', ...env },
  });
}

function commitAs(dir, file, content, message) {
  h.write(dir, file, content);
  h.git(dir, 'add', '--', file);
  h.git(dir, 'commit', '-q', `--author=${ALICE}`, '-m', message);
  return head(dir);
}

/**
 * origin/main has "theirs" in README; local main has three commits by Alice on the old base:
 * one (a.txt), two (README: conflicts at step 2 of 3), three (c.txt).
 * `dirty`: staged, staged+unstaged, unstaged and untracked changes on top.
 */
function setup({ dirty = false } = {}) {
  const { local, seed } = h.repoWithRemote();
  h.hostileConfig(local);
  const theirs = h.commitFile(seed, 'README.md', 'theirs\n', 'theirs');
  h.git(seed, 'push', '-q', 'origin', 'main');
  const c1 = commitAs(local, 'a.txt', 'a\n', 'one');
  const c2 = commitAs(local, 'README.md', 'ours\n', 'two');
  const c3 = commitAs(local, 'c.txt', 'c\n', 'three');
  if (dirty) {
    h.write(local, 'staged.txt', 'st\n');
    h.write(local, 'both.txt', 'v1\n');
    h.git(local, 'add', 'staged.txt', 'both.txt');
    h.write(local, 'both.txt', 'v2\n');
    h.write(local, 'a.txt', 'a\ndirty\n');
    h.write(local, 'u.txt', 'untracked\n');
  }
  return { local, seed, theirs, c1, c2, c3 };
}

const DIRTY_SPLIT = {
  staged: [{ path: 'both.txt', status: 'A' }, { path: 'staged.txt', status: 'A' }],
  unstaged: [{ path: 'a.txt', status: 'M' }, { path: 'both.txt', status: 'M' }, { path: 'u.txt', status: '?' }],
};

/** Pull (rebase) that stops at "two"; returns the error. */
async function pullStop(local) {
  let error;
  await assert.rejects(g.pull(local, { mode: 'rebase' }), (e) => {
    error = e;
    return e.kind === 'conflicts';
  });
  return error;
}

const stateDir = (dir) => path.join(dir, '.git', 'pasta-lite', 'rebase');

describe('Pull (rebase) stops and is finished in the app', () => {
  test('conflict at step 2 of 3: RebaseState, autostash kept, then continue restores the split', async () => {
    const { local, theirs, c2 } = setup({ dirty: true });
    const err = await pullStop(local);
    assert.equal(err.stashKept, true);
    const stash = err.stash;
    assert.equal(autostashRef(local), stash);
    assert.deepEqual(stashList(local), [stash]);
    assert.match(h.git(local, 'stash', 'list', '--format=%s'), /pasta-lite autostash before rebase of main/);

    const st = await g.status(local);
    assert.equal(st.state, 'rebasing');
    assert.equal(st.branch, null); // HEAD is detached mid-rebase
    assert.equal(st.merge, null);
    assert.equal(st.pendingAutostash, null);
    const r = st.rebase;
    assert.deepEqual(err.rebase, r);
    assert.equal(r.backend, 'merge'); // not rebase.backend=apply
    assert.equal(r.interactive, true);
    assert.equal(r.ours, true);
    assert.equal(r.branch, 'main');
    assert.equal(r.onto, theirs);
    assert.equal(r.ontoName, 'origin/main');
    assert.deepEqual(r.step, { done: 2, total: 3 });
    assert.deepEqual(r.current, { cmd: 'pick', sha: c2, subject: 'two' });
    assert.equal(r.stop, 'conflict');
    assert.equal(r.stopMessage, 'two'); // no "# Conflicts:" lines
    assert.equal(r.conflicted, 1);
    assert.equal(r.todoEditable, true);
    assert.equal(r.autostash, stash);
    assert.equal(r.stoppedSha, c2);
    assert.equal(r.hookOutput, null);
    assert.equal(r.gitAutostash, false);
    assert.ok(fs.existsSync(path.join(stateDir(local), 'meta.json')));

    const runner = ops.createRunner();
    await assert.rejects(runner.run(local, 'rebaseContinue', []), (e) => e.kind === 'conflicts' && e.count === 1);
    h.write(local, 'README.md', 'resolved\n');
    h.git(local, 'add', 'README.md');
    h.write(local, 'c.txt', 'x\n'); // staged, then changed again: an unstaged change to a tracked file
    h.git(local, 'add', 'c.txt');
    h.write(local, 'c.txt', 'y\n');
    await assert.rejects(runner.run(local, 'rebaseContinue', []), (e) => e.kind === 'dirty' && e.paths.includes('c.txt'));
    h.git(local, 'rm', '-q', '-f', '--cached', 'c.txt');
    fs.rmSync(path.join(local, 'c.txt'));

    const events = [];
    runner.on('changed', (e) => events.push(e));
    const res = await runner.run(local, 'rebaseContinue', [{}]);
    assert.equal(res.status, 'done');
    assert.equal(res.branch, 'main');
    assert.equal(res.after, head(local));
    assert.deepEqual(res.dropped, []);
    assert.equal(res.stash, undefined);
    assert.deepEqual(events.map((e) => [e.op, e.ok]), [['rebaseContinue', true]]);
    assert.deepEqual(subjects(local, 'origin/main..HEAD'), ['three', 'two', 'one']);
    assert.equal(h.git(local, 'log', '-1', '--format=%an <%ae>', 'HEAD~1').trim(), ALICE); // original author kept
    assert.equal(h.git(local, 'log', '-1', '--format=%B', 'HEAD~1'), 'two\n\n'); // no "; Conflicts" / "# Conflicts"
    assert.equal(h.git(local, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
    assert.deepEqual(await split(local), DIRTY_SPLIT);
    assert.equal(h.read(local, 'both.txt'), 'v2\n');
    assert.equal(h.git(local, 'show', ':both.txt'), 'v1\n');
    assert.deepEqual(stashList(local), []);
    assert.equal(autostashRef(local), null);
    assert.equal(fs.existsSync(stateDir(local)), false);
    const after = await g.status(local);
    assert.equal(after.rebase, null);
    assert.equal(after.pendingAutostash, null);
  });

  test('continue with an edited message: used through the editor helper, author kept', async () => {
    const { local } = setup();
    await pullStop(local);
    h.write(local, 'README.md', 'resolved\n');
    h.git(local, 'add', 'README.md');
    const runner = ops.createRunner();
    await assert.rejects(runner.run(local, 'rebaseContinue', [{ message: '  \n' }]), { kind: 'empty-message' });
    await assert.rejects(runner.run(local, 'rebaseContinue', [{ message: 'a\0b' }]), { kind: 'invalid-args' });
    await assert.rejects(runner.run(local, 'rebaseContinue', [{ message: 'x'.repeat(64 * 1024 + 1) }]), { kind: 'invalid-args' });
    const res = await runner.run(local, 'rebaseContinue', [{ message: 'two, resolved\n\nWhy it was resolved this way.\n' }]);
    assert.equal(res.status, 'done');
    assert.equal(h.git(local, 'log', '-1', '--format=%B', 'HEAD~1'), 'two, resolved\n\nWhy it was resolved this way.\n\n');
    assert.equal(h.git(local, 'log', '-1', '--format=%an <%ae>', 'HEAD~1').trim(), ALICE);
    assert.equal(h.git(local, 'log', '-1', '--format=%s', 'HEAD').trim(), 'three'); // the next pick kept its message
    assert.equal(fs.existsSync(stateDir(local)), false);
  });

  test('a message is refused at a stop that is not a conflict stop', async () => {
    const { local } = setup();
    await pullStop(local);
    h.git(local, 'checkout', '-q', 'HEAD', '--', 'README.md'); // resolved to onto's version: nothing to commit
    const st = await g.status(local);
    assert.equal(st.rebase.stop, 'empty');
    await assert.rejects(ops.createRunner().run(local, 'rebaseContinue', [{ message: 'm' }]), { kind: 'invalid-args' });
  });

  test('a resolution identical to onto drops the commit: dropped [sha]', async () => {
    const { local, c2 } = setup();
    await pullStop(local);
    h.write(local, 'README.md', 'theirs\n');
    h.git(local, 'add', 'README.md');
    const res = await ops.createRunner().run(local, 'rebaseContinue', []);
    assert.equal(res.status, 'done');
    assert.deepEqual(res.dropped, [c2]);
    assert.deepEqual(subjects(local, 'origin/main..HEAD'), ['three', 'one']);
  });

  test('skip: the commit is left out, the rest applied, untracked files kept', async () => {
    const { local } = setup();
    await pullStop(local);
    h.write(local, 'later.txt', 'made during the stop\n');
    const res = await ops.createRunner().run(local, 'rebaseSkip', []);
    assert.equal(res.status, 'done');
    assert.deepEqual(subjects(local, 'origin/main..HEAD'), ['three', 'one']);
    assert.equal(h.read(local, 'README.md'), 'theirs\n');
    assert.equal(h.read(local, 'later.txt'), 'made during the stop\n');
    assert.equal(fs.existsSync(stateDir(local)), false);
  });

  test('abort restores the branch, the tree and the autostash split exactly', async () => {
    const { local, c3 } = setup({ dirty: true });
    const tree = h.git(local, 'rev-parse', 'HEAD^{tree}').trim();
    await pullStop(local);
    const runner = ops.createRunner();
    const res = await runner.run(local, 'rebaseAbort', []);
    assert.deepEqual(res, { status: 'aborted', branch: 'main', head: c3 });
    assert.equal(head(local), c3);
    assert.equal(h.git(local, 'rev-parse', 'HEAD^{tree}').trim(), tree);
    assert.equal(h.git(local, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/main');
    assert.equal(exists(local, '.git/rebase-merge'), false);
    assert.equal(fs.existsSync(stateDir(local)), false);
    assert.deepEqual(await split(local), DIRTY_SPLIT);
    assert.deepEqual(stashList(local), []);
    assert.equal(autostashRef(local), null);
    await assert.rejects(runner.run(local, 'rebaseAbort', []), { kind: 'not-rebasing' });
    await assert.rejects(runner.run(local, 'rebaseContinue', []), { kind: 'not-rebasing' });
    await assert.rejects(runner.run(local, 'rebaseSkip', []), { kind: 'not-rebasing' });
  });

  test('continue whose autostash re-apply conflicts: done, the clean tree reset to HEAD, stash kept', async () => {
    const { local } = setup();
    h.write(local, 'README.md', 'dirty\n'); // README changes again during the rebase
    const err = await pullStop(local);
    h.write(local, 'README.md', 'resolved\n');
    h.git(local, 'add', 'README.md');
    h.write(local, 'later.txt', 'untracked, made during the stop\n');
    const res = await ops.createRunner().run(local, 'rebaseContinue', []);
    assert.equal(res.status, 'done');
    assert.deepEqual(res.stash, { kept: true, sha: err.stash, reason: 'conflict' });
    const st = await g.status(local);
    assert.deepEqual([st.staged, st.unstaged, st.conflicted], [[], [{ path: 'later.txt', status: '?' }], []]);
    assert.equal(h.read(local, 'README.md'), 'resolved\n');
    assert.equal(h.read(local, 'later.txt'), 'untracked, made during the stop\n'); // the reset only met a clean tree
    assert.deepEqual(stashList(local), [err.stash]);
    assert.equal(autostashRef(local), null);
    assert.equal(st.pendingAutostash, null);
  });

  test('continue that leaves changes to tracked files (a hook): the autostash is not applied, nothing reset', async () => {
    const { local } = setup({ dirty: true });
    const err = await pullStop(local);
    h.write(local, 'README.md', 'resolved\n');
    h.git(local, 'add', 'README.md');
    // A post-rewrite hook (run at the end of the rebase) that edits a tracked file.
    fs.writeFileSync(path.join(local, '.git', 'hooks', 'post-rewrite'), '#!/bin/sh\necho formatted >> a.txt\n', { mode: 0o755 });
    const res = await ops.createRunner().run(local, 'rebaseContinue', []);
    assert.equal(res.status, 'done');
    assert.deepEqual(res.stash, { kept: true, sha: err.stash, reason: 'dirty' });
    assert.equal(h.read(local, 'a.txt'), 'a\nformatted\n');
    assert.deepEqual(stashList(local), [err.stash]);
    assert.equal(autostashRef(local), err.stash); // Restore can be tried again from the banner
    assert.equal((await g.status(local)).pendingAutostash, err.stash);
  });

  test('a rebase finished in a terminal leaves a pending autostash; restoreAutostash brings it back', async () => {
    const { local } = setup({ dirty: true });
    const err = await pullStop(local);
    h.write(local, 'README.md', 'resolved\n');
    h.git(local, 'add', 'README.md');
    term(local, ['rebase', '--continue']);
    const st = await g.status(local);
    assert.equal(st.state, 'clean');
    assert.equal(st.pendingAutostash, err.stash);
    const runner = ops.createRunner();
    // No new Pull (rebase) while it waits.
    await assert.rejects(runner.run(local, 'pull', [{ mode: 'rebase' }]), (e) => e.kind === 'in-progress' && e.state === 'autostash');
    const res = await runner.run(local, 'restoreAutostash', []);
    assert.deepEqual(res, { restored: true, indexRestored: true });
    assert.deepEqual(await split(local), DIRTY_SPLIT);
    assert.deepEqual(stashList(local), []);
    assert.equal(autostashRef(local), null);
    await assert.rejects(runner.run(local, 'restoreAutostash', []), { kind: 'nothing' });
  });

  test('restoreAutostash {keep}: the ref goes, the stash stays; a stash dropped by hand: the next write op clears the ref', async () => {
    const { local } = setup({ dirty: true });
    const err = await pullStop(local);
    const runner = ops.createRunner();
    await assert.rejects(runner.run(local, 'restoreAutostash', []), (e) => e.kind === 'in-progress' && e.state === 'rebasing');
    term(local, ['rebase', '--abort']);
    const res = await runner.run(local, 'restoreAutostash', [{ keep: true }]);
    assert.deepEqual(res, { restored: false, stash: { kept: true, sha: err.stash } });
    assert.deepEqual(stashList(local), [err.stash]);
    assert.equal(autostashRef(local), null);

    h.git(local, 'update-ref', 'refs/worktree/pasta-lite/autostash', err.stash);
    assert.equal((await g.status(local)).pendingAutostash, err.stash);
    h.git(local, 'stash', 'drop', '-q');
    assert.equal((await g.status(local)).pendingAutostash, null);
    assert.equal(autostashRef(local), err.stash, 'status only reads');
    assert.deepEqual(await autostash.restoreAutostash(local), { restored: false }); // a write op tidies it up
    assert.equal(autostashRef(local), null);
  });

  test('a symlinked .git/pasta-lite is refused before anything changes', async () => {
    const { local, c3 } = setup({ dirty: true });
    const elsewhere = h.tmpDir();
    fs.symlinkSync(elsewhere, path.join(local, '.git', 'pasta-lite'));
    await assert.rejects(g.pull(local, { mode: 'rebase' }), { kind: 'symlink' });
    assert.equal(head(local), c3);
    assert.equal((await g.status(local)).state, 'clean');
    assert.deepEqual(await split(local), DIRTY_SPLIT);
    assert.deepEqual(stashList(local), []);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });

  test('a clean Pull (rebase) leaves no state behind; pull is refused mid-rebase', async () => {
    const { local, seed } = h.repoWithRemote();
    h.hostileConfig(local);
    h.commitFile(seed, 's.txt', 's\n', 's');
    h.git(seed, 'push', '-q', 'origin', 'main');
    commitAs(local, 'l.txt', 'l\n', 'local');
    const res = await g.pull(local, { mode: 'rebase' });
    assert.equal(res.fastForward, false);
    assert.equal(fs.existsSync(stateDir(local)), false);
    assert.equal(autostashRef(local), null);
    // other refs untouched despite rebase.updateRefs=true
    const s2 = setup();
    h.git(s2.local, 'branch', 'side', s2.c2);
    await pullStop(s2.local);
    await assert.rejects(ops.createRunner().run(s2.local, 'pull', [{ mode: 'ff-if-possible' }]), (e) => e.kind === 'in-progress' && e.state === 'rebasing');
    await ops.createRunner().run(s2.local, 'rebaseSkip', []);
    assert.equal(h.git(s2.local, 'rev-parse', 'side').trim(), s2.c2);
  });
});

describe('the commit refusal at a conflict stop', () => {
  test('commit / commitAll: kind rebasing at a conflict stop, resolved or not', async () => {
    const { local } = setup();
    await pullStop(local);
    const runner = ops.createRunner();
    await assert.rejects(runner.run(local, 'commit', ['mine']), { kind: 'rebasing' });
    h.write(local, 'README.md', 'resolved\n');
    h.git(local, 'add', 'README.md');
    await assert.rejects(runner.run(local, 'commit', ['mine']), { kind: 'rebasing' });
    await assert.rejects(runner.run(local, 'commitAll', ['mine']), { kind: 'rebasing' });
    assert.equal((await g.status(local)).rebase.stop, 'conflict');
  });

  test('allowed at an edit stop (amend), then continue finishes', async () => {
    const dir = h.initRepo();
    h.hostileConfig(dir);
    const base = head(dir);
    const c1 = commitAs(dir, 'a.txt', 'a\n', 'one');
    commitAs(dir, 'b.txt', 'b\n', 'two');
    const editor = path.join(h.tmpDir(), 'edit-first.js');
    fs.writeFileSync(editor, "const fs = require('fs'); const f = process.argv[2];\n"
      + "fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^(p|pick) /m, 'edit '));\n");
    term(dir, ['rebase', '-i', base], { GIT_SEQUENCE_EDITOR: `"${process.execPath}" "${editor}"` });
    const st = await g.status(dir);
    assert.equal(st.rebase.stop, 'edit');
    assert.equal(st.rebase.ours, false);
    assert.equal(st.rebase.current.sha, c1);
    h.write(dir, 'a.txt', 'a amended\n');
    h.git(dir, 'add', 'a.txt');
    const runner = ops.createRunner();
    await runner.run(dir, 'commit', ['one (amended)', { amend: true }]);
    const res = await runner.run(dir, 'rebaseContinue', []);
    assert.equal(res.status, 'done');
    assert.deepEqual(subjects(dir, `${base}..HEAD`), ['two', 'one (amended)']);
    assert.equal(h.read(dir, 'a.txt'), 'a amended\n');
  });
});

describe('rebases started in a terminal', () => {
  test('merge backend: readable (abbreviated todo, ; comments), continue through ops', async () => {
    const { local, c2 } = setup();
    h.git(local, 'fetch', '-q');
    assert.throws(() => term(local, ['-c', 'rebase.backend=merge', 'rebase', 'origin/main']));
    const r = (await g.status(local)).rebase;
    assert.equal(r.backend, 'merge');
    assert.equal(r.ours, false);
    assert.equal(r.ontoName, null);
    assert.equal(r.todoEditable, false);
    assert.equal(r.branch, 'main');
    assert.deepEqual(r.step, { done: 2, total: 3 });
    assert.deepEqual(r.current, { cmd: 'pick', sha: c2, subject: 'two' });
    assert.equal(r.stop, 'conflict');
    assert.equal(r.stopMessage, 'two'); // "; Conflicts:" lines stripped with the repo's comment char
    h.write(local, 'README.md', 'resolved\n');
    h.git(local, 'add', 'README.md');
    const res = await ops.createRunner().run(local, 'rebaseContinue', []);
    assert.equal(res.status, 'done');
    assert.equal(h.git(local, 'log', '-1', '--format=%B', 'HEAD~1'), 'two\n\n');
    assert.deepEqual(subjects(local, 'origin/main..HEAD'), ['three', 'two', 'one']);
  });

  test('apply backend (rebase.backend=apply): readable, continue and abort work', async () => {
    const { local, c1, c3 } = setup();
    h.git(local, 'fetch', '-q');
    assert.throws(() => term(local, ['rebase', 'origin/main']));
    assert.ok(exists(local, '.git/rebase-apply'));
    let r = (await g.status(local)).rebase;
    assert.equal(r.backend, 'apply');
    assert.equal(r.interactive, false);
    assert.equal(r.todoEditable, false);
    assert.equal(r.branch, 'main');
    assert.deepEqual(r.step, { done: 2, total: 3 });
    assert.equal(r.stop, 'conflict');
    const runner = ops.createRunner();
    const res = await runner.run(local, 'rebaseAbort', []);
    assert.equal(res.status, 'aborted');
    assert.equal(head(local), c3);

    assert.throws(() => term(local, ['rebase', 'origin/main']));
    h.write(local, 'README.md', 'resolved\n');
    h.git(local, 'add', 'README.md');
    r = (await g.status(local)).rebase;
    assert.equal(r.stop, 'conflict');
    const done = await runner.run(local, 'rebaseContinue', []);
    assert.equal(done.status, 'done');
    assert.deepEqual(subjects(local, 'origin/main..HEAD'), ['three', 'two', 'one']);
    assert.notEqual(h.git(local, 'rev-parse', 'HEAD~2').trim(), c1);
  });

  test('a continue that stops again resolves stopped with the new state', async () => {
    const dir = h.initRepo();
    h.hostileConfig(dir);
    h.commitFile(dir, 'f.txt', '1\n', 'base');
    h.git(dir, 'checkout', '-q', '-b', 'feat');
    const c1 = commitAs(dir, 'f.txt', 'feat 1\n', 'f1');
    const c2 = commitAs(dir, 'f.txt', 'feat 2\n', 'f2');
    h.git(dir, 'checkout', '-q', 'main');
    h.commitFile(dir, 'f.txt', 'main\n', 'main');
    h.git(dir, 'checkout', '-q', 'feat');
    assert.throws(() => term(dir, ['-c', 'rebase.backend=merge', 'rebase', 'main']));
    assert.equal((await g.status(dir)).rebase.current.sha, c1);
    h.write(dir, 'f.txt', 'feat 1 on main\n');
    h.git(dir, 'add', 'f.txt');
    const res = await ops.createRunner().run(dir, 'rebaseContinue', []);
    assert.equal(res.status, 'stopped');
    assert.equal(res.state.stop, 'conflict');
    assert.equal(res.state.current.sha, c2);
    assert.deepEqual(res.state.step, { done: 2, total: 2 });
    assert.equal(res.state.branch, 'feat');
  });
});

describe('merges started by Pull or a terminal', () => {
  function mergeSetup() {
    const { local, seed } = h.repoWithRemote();
    h.hostileConfig(local);
    const theirs = h.commitFile(seed, 'README.md', 'theirs\n', 'theirs');
    h.git(seed, 'push', '-q', 'origin', 'main');
    h.git(local, 'fetch', '-q');
    const ours = h.commitFile(local, 'README.md', 'ours\n', 'ours');
    assert.throws(() => term(local, ['merge', 'origin/main']));
    return { local, theirs, ours };
  }

  test('status.merge, mergeCommit refused with conflicts, then Commit and Merge with MERGE_MSG', async () => {
    const { local, theirs, ours } = mergeSetup();
    const st = await g.status(local);
    assert.equal(st.state, 'merging');
    assert.equal(st.rebase, null);
    assert.deepEqual(st.merge, { head: theirs, name: 'origin/main', message: "Merge remote-tracking branch 'origin/main'", autostash: null });
    const runner = ops.createRunner();
    await assert.rejects(runner.run(local, 'mergeCommit', []), (e) => e.kind === 'conflicts' && e.count === 1);
    await assert.rejects(runner.run(local, 'rebaseContinue', []), { kind: 'not-rebasing' });
    h.write(local, 'README.md', 'both\n');
    h.git(local, 'add', 'README.md');
    const res = await runner.run(local, 'mergeCommit', []);
    assert.equal(res.status, 'done');
    assert.equal(res.sha, head(local));
    assert.equal(res.summary, "Merge remote-tracking branch 'origin/main'");
    assert.equal(h.git(local, 'log', '-1', '--format=%B'), "Merge remote-tracking branch 'origin/main'\n\n"); // no "; Conflicts"
    assert.deepEqual([h.git(local, 'rev-parse', 'HEAD^1').trim(), h.git(local, 'rev-parse', 'HEAD^2').trim()], [ours, theirs]);
    await assert.rejects(runner.run(local, 'mergeCommit', []), { kind: 'not-merging' });
  });

  test('mergeCommit with an edited message; mergeAbort goes back', async () => {
    let { local, ours } = mergeSetup();
    const runner = ops.createRunner();
    const res = await runner.run(local, 'mergeAbort', []);
    assert.deepEqual(res, { status: 'aborted', head: ours });
    assert.equal((await g.status(local)).state, 'clean');
    assert.equal(h.read(local, 'README.md'), 'ours\n');
    await assert.rejects(runner.run(local, 'mergeAbort', []), { kind: 'not-merging' });

    ({ local } = mergeSetup());
    h.write(local, 'README.md', 'both\n');
    h.git(local, 'add', 'README.md');
    await runner.run(local, 'mergeCommit', [{ message: 'Merge upstream work\n\n# kept like a normal commit\n' }]);
    assert.equal(h.git(local, 'log', '-1', '--format=%B'), 'Merge upstream work\n\n# kept like a normal commit\n\n');
  });

  test('a conflicted Pull (ff-if-possible) is concluded with mergeCommit', async () => {
    const { local, seed } = h.repoWithRemote();
    h.hostileConfig(local);
    h.commitFile(seed, 'README.md', 'theirs\n', 'theirs');
    h.git(seed, 'push', '-q', 'origin', 'main');
    h.commitFile(local, 'README.md', 'ours\n', 'ours');
    await assert.rejects(g.pull(local), { kind: 'conflicts' });
    assert.equal((await g.status(local)).merge.name, 'main');
    h.write(local, 'README.md', 'both\n');
    h.git(local, 'add', 'README.md');
    const res = await ops.createRunner().run(local, 'mergeCommit', []);
    assert.equal(res.summary, "Merge branch 'main' of origin");
  });
});

describe('cancellation and the runner', () => {
  test('cancelling rebaseContinue during a slow hook leaves a stopped rebase; abort restores', { skip: process.platform === 'win32' && 'cancelling does not stop git on Windows yet (src/git-process.js signals the pid only, no process group)' }, async () => {
    const { local, c3 } = setup({ dirty: true });
    await pullStop(local);
    h.write(local, 'README.md', 'resolved\n');
    h.git(local, 'add', 'README.md');
    const marker = path.join(h.tmpDir(), 'started');
    // At a conflict stop, continue runs prepare-commit-msg and post-commit (not pre-commit).
    const hook = path.join(local, '.git', 'hooks', 'prepare-commit-msg');
    // exec: no fork after the marker, so the group SIGTERM can't race a child being forked.
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexec sleep 30\n`, { mode: 0o755 });
    const runner = ops.createRunner();
    const p = runner.run(local, 'rebaseContinue', [], { opId: 'c1' });
    const t0 = Date.now();
    while (!fs.existsSync(marker)) {
      assert.ok(Date.now() - t0 < 60000, 'the hook never started'); // not a speed limit (loaded runs)
      await new Promise((r) => setTimeout(r, 20));
    }
    const cancelledAt = Date.now();
    assert.equal(runner.cancel('c1'), true);
    let error;
    await assert.rejects(p, (e) => {
      error = e;
      return e.kind === 'aborted';
    });
    assert.ok(Date.now() - cancelledAt < 10000, 'the hook was killed, not waited for');
    assert.equal(error.rebase.stop, 'conflict');
    assert.equal(ops.serializeError(error).rebase.stop, 'conflict');
    assert.equal(exists(local, '.git/index.lock'), false);
    const st = await g.status(local);
    assert.equal(st.state, 'rebasing');
    assert.ok(autostashRef(local));
    fs.rmSync(hook);
    const res = await runner.run(local, 'rebaseAbort', []);
    assert.equal(res.status, 'aborted');
    assert.equal(head(local), c3);
    assert.deepEqual(await split(local), DIRTY_SPLIT);
  });

  test('rebaseAbort is not cut short by a cancel once it started', async () => {
    const { local, c3 } = setup();
    await pullStop(local);
    const runner = ops.createRunner();
    runner.on('busy', (e) => { if (e.running) runner.cancelAll(); });
    const res = await runner.run(local, 'rebaseAbort', [], { opId: 'a1' });
    assert.equal(res.status, 'aborted');
    assert.equal(head(local), c3);
  });

  test('a hook that fails during continue: stopped with stop hook and its output', async () => {
    const { local } = setup();
    await pullStop(local);
    h.write(local, 'README.md', 'resolved\n');
    h.git(local, 'add', 'README.md');
    const hook = path.join(local, '.git', 'hooks', 'prepare-commit-msg');
    fs.writeFileSync(hook, '#!/bin/sh\necho "no commits today" >&2\nexit 1\n', { mode: 0o755 });
    const runner = ops.createRunner();
    const res = await runner.run(local, 'rebaseContinue', []);
    assert.equal(res.status, 'stopped');
    assert.equal(res.state.stop, 'hook');
    assert.match(res.hookOutput, /no commits today/);
    assert.match(res.state.hookOutput, /no commits today/);
    fs.rmSync(hook);
    const done = await runner.run(local, 'rebaseContinue', []);
    assert.equal(done.status, 'done');
  });

  test('serializeError carries the rebase fields', () => {
    const s = ops.serializeError(Object.assign(new Error('x'), {
      kind: 'dirty', paths: ['a'], count: 1, rebase: { stop: 'conflict' }, hookOutput: 'h', dropped: ['d'],
    }));
    assert.deepEqual(s, { message: 'x', kind: 'dirty', exitCode: null, count: 1, rebase: { stop: 'conflict' }, dropped: ['d'], hookOutput: 'h', paths: ['a'] });
  });
});

describe('state readers', () => {
  test('a clean repo: rebase, merge and pendingAutostash are null', async () => {
    const dir = h.initRepo();
    const st = await g.status(dir);
    assert.deepEqual([st.rebase, st.merge, st.pendingAutostash], [null, null, null]);
  });

  test('todoLines and stripComments read defensively', () => {
    const sha = 'a'.repeat(40);
    assert.deepEqual(rebaseState.todoLines(`# c\n\np ${sha} x\nfixup -C ${sha} # y\nexec make\nbreak\n`), [
      { cmd: 'pick', sha }, { cmd: 'fixup', sha }, { cmd: 'exec', sha: null }, { cmd: 'break', sha: null },
    ]);
    assert.equal(gitfiles.stripComments('\nsubj\n\n# Conflicts:\n#\tf\n'), 'subj');
    assert.equal(gitfiles.stripComments('subj\n; c\n', ';'), 'subj');
    assert.equal(gitfiles.stripComments('# only\n'), null);
  });
});
