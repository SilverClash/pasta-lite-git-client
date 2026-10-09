'use strict';
// "Rebase <cur> onto <x>" from the menus (docs/plans/rebase.md §3.2, §4, §9.1, R2): the rebase
// op and rebasePlan (the published check), stops with Skip / Abort, up-to-date and
// fast-forward, dropped / skipped commits, resolveWith in the rebase direction, detached HEAD,
// the checkout-first sequence, and target resolution. Every repo runs under
// helpers.hostileConfig (rebase.backend=apply, rebase.updateRefs=true, core.commentChar=; ...).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const g = require('../src/git');
const ops = require('../src/ops');
const rebase = require('../src/rebase');

after(h.cleanup);

const ALICE = 'Alice <alice@example.com>';
const head = (dir) => h.git(dir, 'rev-parse', 'HEAD').trim();
const rev = (dir, r) => h.git(dir, 'rev-parse', r).trim();
const subjects = (dir, range) => h.git(dir, 'log', '--format=%s', range).trim().split('\n').filter(Boolean);
const authors = (dir, range) => h.git(dir, 'log', '--format=%an <%ae>', range).trim().split('\n').filter(Boolean);
const stashList = (dir) => h.git(dir, 'stash', 'list', '--format=%H').trim().split('\n').filter(Boolean);
const autostashRef = (dir) => {
  try {
    return h.git(dir, 'rev-parse', '-q', '--verify', 'refs/worktree/pasta-lite/autostash').trim();
  } catch {
    return null;
  }
};
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
const split = async (dir) => {
  const st = await g.status(dir);
  return { staged: st.staged, unstaged: st.unstaged };
};

function commitAs(dir, file, content, message) {
  h.write(dir, file, content);
  h.git(dir, 'add', '--', file);
  h.git(dir, 'commit', '-q', `--author=${ALICE}`, '-m', message);
  return head(dir);
}

/**
 * main gets "main edit" (README) after the fork; feat has three commits by Alice: one (a.txt),
 * two (README when `conflict`, else b.txt), three (c.txt). feat is checked out. A branch
 * `stack` points at "one" (rebase.updateRefs=true must not move it).
 */
function setup({ conflict = false } = {}) {
  const dir = h.initRepo();
  h.hostileConfig(dir);
  h.git(dir, 'checkout', '-q', '-b', 'feat');
  const c1 = commitAs(dir, 'a.txt', 'a\n', 'one');
  h.git(dir, 'branch', 'stack');
  const c2 = conflict ? commitAs(dir, 'README.md', 'feat side\n', 'two') : commitAs(dir, 'b.txt', 'b\n', 'two');
  const c3 = commitAs(dir, 'c.txt', 'c\n', 'three');
  h.git(dir, 'checkout', '-q', 'main');
  const main = h.commitFile(dir, 'README.md', 'main side\n', 'main edit');
  h.git(dir, 'checkout', '-q', 'feat');
  return { dir, main, c1, c2, c3 };
}

describe('rebase onto a branch', () => {
  test('clean: new base, subjects and authors kept, other branches untouched, state folder gone', async () => {
    const { dir, main, c1, c3 } = setup();
    const runner = ops.createRunner();
    const events = [];
    runner.on('changed', (e) => events.push(e.op));
    const res = await runner.run(dir, 'rebase', ['main', { expectHead: c3 }]);
    assert.equal(res.status, 'done');
    assert.equal(res.branch, 'feat');
    assert.equal(res.before, c3);
    assert.equal(res.after, head(dir));
    assert.equal(res.fastForward, false);
    assert.deepEqual(res.dropped, []);
    assert.equal(res.skippedCherryPicks, 0);
    assert.equal(res.published, 0);
    assert.equal(res.undoRecorded, false);
    assert.deepEqual(events, ['rebase']);
    assert.deepEqual(subjects(dir, 'main..feat'), ['three', 'two', 'one']);
    assert.deepEqual(authors(dir, 'main..feat'), [ALICE, ALICE, ALICE]);
    assert.equal(rev(dir, 'feat~3'), main);
    assert.equal(rev(dir, 'stack'), c1); // not moved despite rebase.updateRefs=true
    assert.equal(h.git(dir, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/feat');
    assert.equal(exists(dir, '.git/pasta-lite/rebase'), false);
    assert.equal((await g.status(dir)).state, 'clean');
    // The branch log records the rebase as git does (undo, R5, builds on it).
    assert.match(h.git(dir, 'reflog', '-1', '--format=%gs', 'refs/heads/feat'), /^rebase \(finish\): refs\/heads\/feat onto /);
  });

  test('conflict at step 2 of 3: stopped (ours, ontoName), Keep versions in the rebase direction, then continue', async () => {
    const { dir, main, c2 } = setup({ conflict: true });
    const runner = ops.createRunner();
    const res = await runner.run(dir, 'rebase', ['main']);
    assert.equal(res.status, 'stopped');
    const r = res.state;
    assert.equal(r.stop, 'conflict');
    assert.equal(r.ours, true);
    assert.equal(r.branch, 'feat');
    assert.equal(r.onto, main);
    assert.equal(r.ontoName, 'main');
    assert.deepEqual(r.step, { done: 2, total: 3 });
    assert.deepEqual(r.current, { cmd: 'pick', sha: c2, subject: 'two' });
    assert.equal(r.stoppedSha, c2);
    assert.equal(r.stopMessage, 'two');
    assert.deepEqual((await g.status(dir)).rebase, r);

    // ours = the commit being built on (main's side), theirs = the commit being replayed (feat's).
    await runner.run(dir, 'resolveWith', ['README.md', 'ours']);
    assert.equal(h.read(dir, 'README.md'), 'main side\n');
    h.git(dir, 'checkout', '-m', '--', 'README.md'); // conflict again
    assert.equal((await g.status(dir)).conflicted.length, 1);
    await runner.run(dir, 'resolveWith', ['README.md', 'theirs']);
    assert.equal(h.read(dir, 'README.md'), 'feat side\n');

    const done = await runner.run(dir, 'rebaseContinue', []);
    assert.equal(done.status, 'done');
    assert.deepEqual(subjects(dir, 'main..feat'), ['three', 'two', 'one']);
    assert.deepEqual(authors(dir, 'main..feat'), [ALICE, ALICE, ALICE]);
    assert.equal(h.git(dir, 'show', 'feat:README.md'), 'feat side\n');
  });

  test('conflict, then Skip: the commit is left out, the rest applied', async () => {
    const { dir } = setup({ conflict: true });
    const runner = ops.createRunner();
    assert.equal((await runner.run(dir, 'rebase', ['main'])).status, 'stopped');
    const res = await runner.run(dir, 'rebaseSkip', []);
    assert.equal(res.status, 'done');
    assert.deepEqual(subjects(dir, 'main..feat'), ['three', 'one']);
    assert.equal(h.read(dir, 'README.md'), 'main side\n');
  });

  test('conflict, then Abort: branch, tree and the autostash split back exactly', async () => {
    const { dir, c3 } = setup({ conflict: true });
    h.write(dir, 'staged.txt', 'st\n');
    h.git(dir, 'add', 'staged.txt');
    h.write(dir, 'a.txt', 'a\ndirty\n');
    h.write(dir, 'u.txt', 'untracked\n');
    const before = await split(dir);
    const runner = ops.createRunner();
    const res = await runner.run(dir, 'rebase', ['main']);
    assert.equal(res.status, 'stopped');
    assert.equal(autostashRef(dir), res.state.autostash);
    assert.match(h.git(dir, 'stash', 'list', '--format=%s'), /pasta-lite autostash before rebase of feat/);
    const ab = await runner.run(dir, 'rebaseAbort', []);
    assert.equal(ab.status, 'aborted');
    assert.equal(head(dir), c3);
    assert.equal(h.git(dir, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/feat');
    assert.deepEqual(await split(dir), before);
    assert.deepEqual(stashList(dir), []);
    assert.equal(autostashRef(dir), null);
    assert.equal(exists(dir, '.git/pasta-lite/rebase'), false);
  });

  test('autostash, clean finish: the split restored, no stash or ref left', async () => {
    const { dir } = setup();
    h.write(dir, 'staged.txt', 'st\n');
    h.git(dir, 'add', 'staged.txt');
    h.write(dir, 'staged.txt', 'st2\n');
    h.write(dir, 'u.txt', 'untracked\n');
    const before = await split(dir);
    const res = await ops.OPS.rebase(dir, 'main');
    assert.equal(res.status, 'done');
    assert.deepEqual(await split(dir), before);
    assert.deepEqual(stashList(dir), []);
    assert.equal(autostashRef(dir), null);
  });

  test('autostash: false with local changes is refused before anything runs', async () => {
    const { dir, c3 } = setup();
    h.write(dir, 'a.txt', 'changed\n');
    await assert.rejects(ops.OPS.rebase(dir, 'main', { autostash: false }), { kind: 'dirty' });
    assert.equal(head(dir), c3);
  });
});

describe('up to date, fast-forward, dropped and skipped commits', () => {
  test('onto an ancestor: up-to-date without running pre-rebase', async () => {
    const { dir, c1, c3 } = setup();
    const marker = path.join(h.tmpDir(), 'ran');
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-rebase'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    for (const onto of [c1, 'stack', 'feat', c3]) {
      assert.deepEqual(await ops.OPS.rebase(dir, onto), { status: 'up-to-date', branch: 'feat', head: c3 });
    }
    assert.equal(fs.existsSync(marker), false);
    assert.equal(head(dir), c3);
  });

  test('HEAD an ancestor of onto: fast-forward', async () => {
    const { dir, main } = setup();
    h.git(dir, 'checkout', '-q', '-b', 'old', 'main~1');
    const res = await ops.OPS.rebase(dir, 'main');
    assert.equal(res.status, 'done');
    assert.equal(res.fastForward, true);
    assert.equal(res.after, main);
    assert.equal(res.branch, 'old');
  });

  test('a commit already in onto is skipped; one that becomes empty is dropped (both reported)', async () => {
    const { dir, c2 } = setup();
    // main gets the same patch as "one" (cherry-pick: skipped) and a bigger commit that
    // includes "three"'s change (so "three" becomes empty: dropped).
    h.git(dir, 'checkout', '-q', 'main');
    h.git(dir, 'cherry-pick', rev(dir, 'feat~2'));
    h.write(dir, 'c.txt', 'c\n');
    h.write(dir, 'other.txt', 'o\n');
    h.git(dir, 'add', 'c.txt', 'other.txt');
    h.git(dir, 'commit', '-q', '-m', 'c and more');
    h.git(dir, 'checkout', '-q', 'feat');
    const c3 = head(dir);
    const res = await ops.OPS.rebase(dir, 'main');
    assert.equal(res.status, 'done');
    assert.equal(res.skippedCherryPicks, 1);
    assert.deepEqual(res.dropped, [c3]);
    assert.deepEqual(subjects(dir, 'main..feat'), ['two']);
    assert.equal(h.git(dir, 'log', '-1', '--format=%an <%ae>', 'feat'), `${ALICE}\n`);
    assert.notEqual(rev(dir, 'feat'), c2);
  });
});

describe('published commits and rebasePlan', () => {
  function published() {
    const { local, seed } = h.repoWithRemote();
    h.hostileConfig(local);
    h.git(local, 'checkout', '-q', '-b', 'feat');
    const p1 = commitAs(local, 'a.txt', 'a\n', 'pushed one');
    const p2 = commitAs(local, 'b.txt', 'b\n', 'pushed two');
    h.git(local, 'push', '-q', '-u', 'origin', 'feat');
    const u1 = commitAs(local, 'c.txt', 'c\n', 'local only');
    h.commitFile(seed, 'README.md', 'upstream\n', 'upstream work');
    h.git(seed, 'push', '-q', 'origin', 'main');
    h.git(local, 'fetch', '-q');
    h.git(local, 'remote', 'set-head', 'origin', 'main');
    return { local, seed, p1, p2, u1 };
  }

  test('rebasePlan lists the range oldest first and which commits are on a remote', async () => {
    const { local, p1, p2, u1 } = published();
    const plan = await ops.OPS.rebasePlan(local, { upstream: 'refs/remotes/origin/main' });
    const onto = rev(local, 'origin/main');
    assert.equal(plan.head, u1);
    assert.equal(plan.branch, 'feat');
    assert.equal(plan.upstream, onto);
    assert.equal(plan.onto, onto);
    assert.deepEqual(plan.commits.map((c) => c.sha), [p1, p2, u1]);
    assert.deepEqual(plan.commits[0], {
      sha: p1, parents: [rev(local, 'main')], subject: 'pushed one', message: 'pushed one',
      author: 'Alice', email: 'alice@example.com', date: plan.commits[0].date, isMerge: false,
    });
    assert.equal(plan.mergeBase, rev(local, 'main'));
    assert.equal(plan.isAncestor, false);
    assert.equal(plan.fastForward, false);
    assert.equal(plan.hasMerges, false);
    assert.equal(plan.hasRoot, false);
    assert.deepEqual(plan.published, [{ sha: p1, remoteRefs: ['origin/feat'] }, { sha: p2, remoteRefs: ['origin/feat'] }]);
    assert.deepEqual(plan.publishedRefs, ['origin/feat']);
    assert.equal(plan.upstreamRef, 'origin/feat');
    assert.equal(plan.defaultBranchOf, null);
    assert.equal(plan.limit, 500);
    assert.equal(plan.truncated, false);

    // The branch the remote's HEAD points at is "the main branch of origin".
    h.git(local, 'checkout', '-q', 'main');
    h.commitFile(local, 'm.txt', 'm\n', 'local main');
    const mp = await ops.OPS.rebasePlan(local, { upstream: 'refs/remotes/origin/main' });
    assert.equal(mp.defaultBranchOf, 'origin');
    assert.deepEqual(mp.published, []);
  });

  test('the rebase result counts the rewritten commits that were on the upstream', async () => {
    const { local } = published();
    const res = await ops.OPS.rebase(local, 'refs/remotes/origin/main');
    assert.equal(res.status, 'done');
    assert.equal(res.published, 2);
    assert.deepEqual(subjects(local, 'origin/main..feat'), ['local only', 'pushed two', 'pushed one']);
  });

  test('rebasePlan: onto an ancestor, branchesInRange, onto differing from upstream, refusals', async () => {
    const { dir, c1, c3 } = setup();
    const plan = await ops.OPS.rebasePlan(dir, { upstream: c1 });
    assert.deepEqual(plan.commits.map((c) => c.subject), ['two', 'three']);
    assert.equal(plan.isAncestor, true);
    assert.equal(plan.head, c3);
    const all = await ops.OPS.rebasePlan(dir, { upstream: 'refs/heads/main', onto: 'main' });
    assert.deepEqual(all.commits.map((c) => c.subject), ['one', 'two', 'three']);
    assert.deepEqual(all.branchesInRange, ['stack']);
    assert.deepEqual(all.published, []);
    await assert.rejects(ops.OPS.rebasePlan(dir, {}), { kind: 'invalid-args' });
    await assert.rejects(ops.OPS.rebasePlan(dir, { upstream: 'main..feat' }), { kind: 'invalid-args' });
    await assert.rejects(ops.OPS.rebasePlan(dir, { upstream: 'main', onto: '--exec=x' }), { kind: 'invalid-args' });
  });
});

describe('validation, detached HEAD, checkout first', () => {
  test('expectHead stale, in-progress and a pending autostash are refused before anything runs', async () => {
    const { dir, c2, c3 } = setup({ conflict: true });
    const runner = ops.createRunner();
    const events = [];
    runner.on('busy', (e) => events.push(e));
    await assert.rejects(runner.run(dir, 'rebase', ['main', { expectHead: c2 }]), (e) => e.kind === 'stale' && e.head === c3);
    await assert.rejects(runner.run(dir, 'rebase', ['main', { expectHead: 'HEAD' }]), { kind: 'invalid-args' });
    assert.deepEqual(events, []);
    assert.equal(head(dir), c3);

    h.write(dir, 'u.txt', 'untracked\n');
    assert.equal((await runner.run(dir, 'rebase', ['main'])).status, 'stopped');
    await assert.rejects(runner.run(dir, 'rebase', ['main']), { kind: 'in-progress', state: 'rebasing' });
    await assert.rejects(runner.run(dir, 'merge', ['main']), { kind: 'in-progress', state: 'rebasing' });
    // Finished in a terminal: our autostash now waits to be restored, and new starts are refused.
    h.git(dir, 'rebase', '--abort');
    await assert.rejects(runner.run(dir, 'rebase', ['main']), { kind: 'in-progress', state: 'autostash' });
    await assert.rejects(runner.run(dir, 'merge', ['main']), { kind: 'in-progress', state: 'autostash' });
    await runner.run(dir, 'restoreAutostash', []);
    assert.equal(h.read(dir, 'u.txt'), 'untracked\n');
  });

  test('a branch named like a remote branch never confuses the onto target', async () => {
    const { local, seed } = h.repoWithRemote();
    h.hostileConfig(local);
    const remoteTip = h.commitFile(seed, 'r.txt', 'r\n', 'remote work');
    h.git(seed, 'push', '-q', 'origin', 'main');
    h.git(local, 'fetch', '-q');
    h.git(local, 'checkout', '-q', '-b', 'origin/main');
    const localTip = h.commitFile(local, 'l.txt', 'l\n', 'local origin/main');
    h.git(local, 'checkout', '-q', '-b', 'feat', 'main');
    commitAs(local, 'f.txt', 'f\n', 'feat work');

    await assert.rejects(ops.OPS.rebase(local, 'origin/main'), { kind: 'ambiguous' });
    await assert.rejects(ops.OPS.rebasePlan(local, { upstream: 'origin/main' }), { kind: 'ambiguous' });
    const res = await ops.OPS.rebase(local, 'refs/remotes/origin/main');
    assert.equal(res.status, 'done');
    assert.equal(rev(local, 'feat~1'), remoteTip);
    const r2 = await ops.OPS.rebase(local, 'refs/heads/origin/main');
    assert.equal(r2.status, 'done');
    assert.equal(rev(local, 'feat~2'), localTip); // remote work and feat work replayed onto it
  });

  test('detached HEAD: rebased and still detached, branch null', async () => {
    const { dir, main, c3 } = setup();
    h.git(dir, 'checkout', '-q', '--detach', c3);
    const res = await ops.OPS.rebase(dir, main);
    assert.equal(res.status, 'done');
    assert.equal(res.branch, null);
    assert.equal(res.before, c3);
    assert.equal(rev(dir, 'HEAD~3'), main);
    assert.throws(() => h.git(dir, 'symbolic-ref', '-q', 'HEAD'));
    assert.equal(rev(dir, 'feat'), c3); // the branch itself stays
    assert.equal((await g.status(dir)).branch, null);
  });

  test('a pre-rebase hook refusal: hook-failed with its output, nothing changed, autostash back', async () => {
    const { dir, c3 } = setup();
    h.write(dir, 'u.txt', 'untracked\n');
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-rebase'), '#!/bin/sh\necho "not today" >&2\nexit 1\n', { mode: 0o755 });
    await assert.rejects(ops.OPS.rebase(dir, 'main'), (e) => e.kind === 'hook-failed' && /not today/.test(e.message) && !e.stashKept);
    assert.equal(head(dir), c3);
    assert.equal(exists(dir, '.git/rebase-merge'), false);
    assert.equal(exists(dir, '.git/pasta-lite/rebase'), false);
    assert.equal(h.read(dir, 'u.txt'), 'untracked\n');
    assert.deepEqual(stashList(dir), []);
    assert.equal(autostashRef(dir), null);
  });

  test('checkout first, then rebase (two queued writes); a branch of another worktree is refused', async () => {
    const { dir, main } = setup();
    h.git(dir, 'checkout', '-q', 'main');
    h.git(dir, 'branch', 'side', 'feat~1');
    const runner = ops.createRunner();
    const [co, res] = await Promise.all([
      runner.run(dir, 'checkout', ['feat']),
      runner.run(dir, 'rebase', ['main']),
    ]);
    assert.equal(co.branch, 'feat');
    assert.equal(res.status, 'done');
    assert.equal(res.branch, 'feat');
    assert.equal(rev(dir, 'feat~3'), main);
    assert.equal(rev(dir, 'side~2'), rev(dir, 'main~1')); // untouched

    const wt = path.join(h.tmpDir(), 'wt');
    h.git(dir, 'worktree', 'add', '-q', wt, 'side');
    await assert.rejects(runner.run(dir, 'checkout', ['side']), { kind: 'checked-out-elsewhere' });
    assert.equal(h.git(dir, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/feat');
  });

  test('rebase.start refuses a non-sha onto (the op layer resolves names)', async () => {
    const { dir } = setup();
    await assert.rejects(rebase.start(dir, { onto: 'main' }), { kind: 'invalid-args' });
    await assert.rejects(rebase.plan(dir, { upstream: 'main' }), { kind: 'invalid-args' });
  });
});

describe('cancelling a rebase', () => {
  test('cancelled during a slow hook of a pick: rejects aborted with the stopped state; abort restores', async () => {
    const { dir, c3 } = setup();
    h.write(dir, 'u.txt', 'untracked\n');
    const marker = path.join(h.tmpDir(), 'started');
    // Each pick runs prepare-commit-msg. exec: no fork after the marker (see rebase.test.js).
    const hook = path.join(dir, '.git', 'hooks', 'prepare-commit-msg');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexec sleep 30\n`, { mode: 0o755 });
    const runner = ops.createRunner();
    const p = runner.run(dir, 'rebase', ['main'], { opId: 'r1' });
    // The wait is for a hook that never starts, not a speed limit: on a loaded machine the
    // rebase's autostash and plan can take well over 10 s to reach the first pick.
    const t0 = Date.now();
    while (!fs.existsSync(marker)) {
      assert.ok(Date.now() - t0 < 60000, 'the hook never started');
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(runner.cancel('r1'), true);
    let error;
    await assert.rejects(p, (e) => {
      error = e;
      return e.kind === 'aborted';
    });
    assert.equal(error.rebase.branch, 'feat');
    assert.equal(ops.serializeError(error).rebase.ours, true);
    assert.equal(exists(dir, '.git/index.lock'), false);
    assert.equal((await g.status(dir)).state, 'rebasing');
    fs.rmSync(hook);
    const res = await runner.run(dir, 'rebaseAbort', []);
    assert.equal(res.status, 'aborted');
    assert.equal(head(dir), c3);
    assert.equal(h.read(dir, 'u.txt'), 'untracked\n');
    assert.equal(autostashRef(dir), null);
  });

  test('an unborn HEAD is refused', async () => {
    const dir = h.initRepo({ commits: false });
    await assert.rejects(ops.OPS.rebase(dir, 'main'), { kind: 'invalid-args' });
  });
});
