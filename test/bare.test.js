'use strict';
// Bare repositories, against real repos: opening every spelling of the "bare +
// worktrees" layout, the runner's refusal of working-tree ops, the synthetic clean status, and the
// writes that work without a working tree (branch create / delete and its undo, push, fetch with
// and without a fetch refspec, setUpstream).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const ops = require('../src/ops');
const git = require('../src/git');
const exec = require('../src/exec');

const rev = (dir, r) => h.git(dir, 'rev-parse', r).trim();

/** A runner plus every busy / changed event it emitted. */
function runnerWithEvents() {
  const runner = ops.createRunner();
  const events = [];
  runner.on('busy', (e) => events.push(['busy', e]));
  runner.on('changed', (e) => events.push(['changed', e]));
  return { runner, events, run: (repo, name, ...args) => runner.run(repo, name, args) };
}

test('openRepo: the layout folder, the bare git dir and a folder inside it all open the bare repo; the worktree opens as a worktree', async () => {
  const { top, bare, wt } = h.bareWithWorktree();
  const want = { root: bare, name: `${path.basename(top)}/.bare`, head: { sha: rev(bare, 'main'), branch: 'main' }, bare: true, linkedWorktree: null };
  for (const dir of [top, bare, path.join(bare, 'refs'), path.join(bare, 'refs', 'heads')]) {
    assert.deepEqual(await ops.openRepo(dir), want, dir);
  }
  const w = await ops.openRepo(wt);
  assert.deepEqual(w, {
    root: wt, name: 'main', head: { sha: rev(wt, 'HEAD'), branch: 'main' }, bare: false,
    linkedWorktree: { mainPath: bare, mainName: path.basename(top), title: `${path.basename(top)} · main` },
  });
  // summary (app:getState's fresh head) agrees.
  assert.deepEqual(await ops.summary(bare), want);
  // An unborn bare repo: HEAD names its branch, no commit.
  const unborn = h.initRepo({ bare: true, commits: false });
  assert.deepEqual(await ops.openRepo(unborn), { root: unborn, name: path.basename(unborn), head: { sha: null, branch: 'main' }, bare: true, linkedWorktree: null });
  // A .git folder of a normal repo is not bare: still not-a-repo.
  const normal = h.initRepo();
  await assert.rejects(ops.openRepo(path.join(normal, '.git')), { kind: 'not-a-repo' });
});

test('repoName: a hidden bare git dir shows its parent; anything else its basename', () => {
  assert.equal(ops.repoName('/x/proj/.bare', true), 'proj/.bare');
  assert.equal(ops.repoName('/x/proj.git', true), 'proj.git');
  assert.equal(ops.repoName('/x/.dotfiles', false), '.dotfiles');
});

test('safe.bareRepository=explicit: the bare dir is refused with git\'s message, and so is its layout folder', async (t) => {
  const { top, bare } = h.bareWithWorktree({ worktree: false });
  const cfg = path.join(h.tmpDir(), 'gitconfig');
  fs.writeFileSync(cfg, '[safe]\n\tbareRepository = explicit\n');
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  t.after(() => { process.env.GIT_CONFIG_GLOBAL = prev; });
  await assert.rejects(ops.openRepo(bare), (e) => e.kind === 'not-a-repo' && /cannot use bare repository/.test(e.message));
  // top/.git names the repo explicitly, but every command would run in the bare dir itself.
  await assert.rejects(ops.openRepo(top), (e) => e.kind === 'not-a-repo' && /cannot use bare repository/.test(e.message));
});

test('exec.isBare: bare dirs true (cached), worktrees / non-repos / missing folders false', async () => {
  const { bare, wt } = h.bareWithWorktree();
  assert.equal(await exec.isBare(bare), true);
  assert.equal(await exec.isBare(path.join(bare, 'refs')), true);
  assert.equal(await exec.isBare(wt), false);
  assert.equal(await exec.isBare(h.tmpDir()), false);
  assert.equal(await exec.isBare(path.join(h.tmpDir(), 'missing')), false);
  assert.equal(await exec.resolveRoot(bare), bare);
  // Cached: git would no longer recognise the folder without HEAD, the answer stays.
  fs.renameSync(path.join(bare, 'HEAD'), path.join(bare, 'HEAD.moved'));
  try {
    assert.equal(await exec.isBare(bare), true);
  } finally {
    fs.renameSync(path.join(bare, 'HEAD.moved'), path.join(bare, 'HEAD'));
  }
});

test('status in a bare repo: the synthetic clean status, same fields as a worktree\'s, with the upstream and ahead / behind', async () => {
  const { bare, wt } = h.bareWithWorktree();
  const normal = await git.status(wt);
  const st = await ops.OPS.status(bare);
  assert.deepEqual(Object.keys(st).sort(), [...Object.keys(normal), 'bare'].sort(), 'every field status() returns');
  assert.deepEqual(st, {
    branch: 'main', oid: rev(bare, 'main'), upstream: null, ahead: 0, behind: 0,
    staged: [], unstaged: [], conflicted: [], state: 'clean', rebase: null, merge: null, pendingAutostash: null, bare: true,
  });
  assert.equal(normal.bare, undefined, 'a worktree\'s status has no bare field');
  // With an upstream: a commit in the linked worktree moves main ahead of origin/main.
  await ops.createRunner().run(bare, 'setUpstream', ['main', 'origin', 'main']);
  h.commitFile(wt, 'wt.txt', 'x\n', 'from the worktree');
  const up = await git.status(bare);
  assert.equal(up.upstream, 'origin/main');
  assert.equal(up.ahead, 1);
  assert.equal(up.behind, 0);
  assert.equal(up.oid, rev(wt, 'HEAD'));
  // Detached bare HEAD: branch null, no upstream.
  h.git(bare, 'update-ref', '--no-deref', 'HEAD', rev(bare, 'main'));
  const det = await git.status(bare);
  assert.equal(det.branch, null);
  assert.equal(det.upstream, null);
  assert.equal(det.oid, rev(bare, 'main'));
});

test('every op is classified: WORKTREE_OPS xor BARE_OK', () => {
  for (const name of Object.keys(ops.OPS)) {
    assert.ok(ops.WORKTREE_OPS.has(name) !== ops.BARE_OK.has(name), `${name}: exactly one of WORKTREE_OPS / BARE_OK`);
  }
  for (const name of [...ops.WORKTREE_OPS, ...ops.BARE_OK]) assert.ok(Object.hasOwn(ops.OPS, name), `${name} is an op`);
  for (const name of ops.WRITE_OPS) assert.ok(ops.WORKTREE_OPS.has(name) || ops.BARE_OK.has(name), name);
});

test('working-tree ops are refused in a bare repo (kind bare-repo) before validation: no git, no events', async () => {
  const { bare } = h.bareWithWorktree();
  const before = h.git(bare, 'for-each-ref').trim();
  const { runner, events } = runnerWithEvents();
  for (const name of ops.WORKTREE_OPS) {
    await assert.rejects(runner.run(bare, name, ['anything', { at: 'all' }]), (e) => {
      assert.equal(e.kind, 'bare-repo', name);
      assert.equal(e.message, `${name} needs a working tree: this is a bare repository`);
      assert.deepEqual(ops.serializeError(e), { message: e.message, kind: 'bare-repo', exitCode: null });
      return true;
    });
  }
  // By argument: pull in any mode but fetch (the default merges), createBranch with checkout.
  for (const args of [[], [{}], [{ mode: 'ff-if-possible' }], [{ mode: 'ff-only' }], [{ mode: 'rebase' }], [null]]) {
    await assert.rejects(runner.run(bare, 'pull', args), { kind: 'bare-repo', message: 'pull needs a working tree: this is a bare repository' }, JSON.stringify(args));
  }
  await assert.rejects(runner.run(bare, 'createBranch', ['x', { checkout: true }]), { kind: 'bare-repo', message: 'createBranch with checkout needs a working tree: this is a bare repository' });
  assert.deepEqual(events, [], 'no busy / changed event for a refused op');
  assert.equal(h.git(bare, 'for-each-ref').trim(), before, 'nothing changed');
  assert.equal(fs.existsSync(path.join(bare, 'refs', 'heads', 'x')), false);
});

test('the same ops are not refused in a worktree of it (the gate is per repo)', async () => {
  const { wt } = h.bareWithWorktree();
  const runner = ops.createRunner();
  h.write(wt, 'new.txt', 'n\n');
  await runner.run(wt, 'stage', [['new.txt']]);
  const res = await runner.run(wt, 'commit', ['in the worktree']);
  assert.equal(res.summary, 'in the worktree');
  assert.equal((await runner.run(wt, 'status', [])).bare, undefined);
});

test('reads work in a bare repo: refs, log, commit files and diffs, stashes, remotes, last commit, worktrees', async () => {
  const { top, bare, wt } = h.bareWithWorktree();
  const { run } = runnerWithEvents();
  const refs = await run(bare, 'refs');
  assert.deepEqual(refs.head, { branch: 'main', oid: rev(bare, 'main'), detached: false });
  assert.deepEqual(refs.local.map((b) => [b.name, b.current]), [['main', true]]);
  assert.deepEqual(refs.remote.map((b) => b.name), ['origin/main']);
  const log = await run(bare, 'log', { limit: 10 });
  assert.equal(log.commits[0].hash, rev(bare, 'main'));
  const files = await run(bare, 'commitFiles', log.commits[0].hash);
  assert.deepEqual(files, [{ status: 'A', path: 'README.md' }]);
  const view = await run(bare, 'commitDiffView', log.commits[0].hash, 'README.md');
  assert.equal(view.file.newPath, 'README.md');
  assert.deepEqual(await run(bare, 'stashes'), []);
  assert.deepEqual(await run(bare, 'remotes'), ['origin']);
  assert.equal((await run(bare, 'lastCommitMessage')).sha, rev(bare, 'main'));
  const wts = await run(bare, 'worktrees');
  const none = { detached: false, locked: false, lockReason: null, prunable: false, prunableReason: null, missing: false };
  assert.deepEqual(wts, [
    { path: bare, head: null, branch: null, bare: true, ...none, main: true, current: true },
    { path: wt, head: rev(wt, 'HEAD'), branch: 'main', bare: false, ...none, main: false, current: false },
  ]);
  assert.deepEqual(await run(wt, 'worktrees'), wts.map((w) => ({ ...w, current: !w.current })), 'the same list from the worktree, where it is current');
  assert.equal(path.dirname(bare), top);
});

test('git.worktrees: detached, locked and prunable entries', async () => {
  const { bare, wt } = h.bareWithWorktree();
  const det = path.join(path.dirname(bare), 'det');
  const gone = path.join(path.dirname(bare), 'gone');
  h.git(bare, 'worktree', 'add', '-q', '--detach', det, 'main');
  h.git(bare, 'worktree', 'add', '-q', '-b', 'side', gone, 'main');
  h.git(bare, 'worktree', 'lock', '--reason', 'on a stick', det);
  fs.rmSync(gone, { recursive: true, force: true });
  const list = await git.worktrees(bare);
  const by = Object.fromEntries(list.map((w) => [w.path, w]));
  assert.deepEqual(by[det], {
    path: det, head: rev(bare, 'main'), branch: null, bare: false, detached: true,
    locked: true, lockReason: 'on a stick', prunable: false, prunableReason: null, main: false, current: false, missing: false,
  });
  assert.equal(by[gone].prunable, true);
  assert.equal(by[gone].missing, true);
  assert.equal(by[gone].prunableReason, 'gitdir file points to non-existent location');
  assert.equal(by[gone].branch, 'side');
  assert.equal(by[wt].locked, false);
  // A normal repo: one entry, its own.
  const normal = h.initRepo();
  assert.deepEqual(await git.worktrees(normal), [{
    path: normal, head: rev(normal, 'HEAD'), branch: 'main', bare: false, detached: false,
    locked: false, lockReason: null, prunable: false, prunableReason: null, main: true, current: true, missing: false,
  }]);
});

test('linked worktrees from the bare repo: lock, unlock, remove and prune work; the bare entry is main-worktree', async () => {
  const { bare, wt } = h.bareWithWorktree();
  const other = path.join(path.dirname(bare), 'other');
  const gone = path.join(path.dirname(bare), 'gone');
  h.git(bare, 'worktree', 'add', '-q', '-b', 'other', other, 'main');
  h.git(bare, 'worktree', 'add', '-q', '-b', 'gone', gone, 'main');
  fs.rmSync(gone, { recursive: true, force: true });
  const { run } = runnerWithEvents();
  for (const name of ['removeWorktree', 'lockWorktree', 'unlockWorktree']) {
    await assert.rejects(run(bare, name, bare), { kind: 'main-worktree' }, name);
  }
  // From the worktree too: the bare entry is the main one.
  await assert.rejects(run(wt, 'removeWorktree', bare), { kind: 'main-worktree' });
  await run(bare, 'lockWorktree', other, { reason: 'busy' });
  await assert.rejects(run(bare, 'removeWorktree', other), { kind: 'worktree-locked', reason: 'busy' });
  await run(bare, 'unlockWorktree', other);
  assert.deepEqual(await run(bare, 'removeWorktree', other), { path: other });
  assert.equal(fs.existsSync(other), false);
  assert.deepEqual((await run(bare, 'worktreePrunePreview')).entries.map((e) => e.id), ['worktrees/gone']);
  assert.deepEqual((await run(bare, 'pruneWorktrees')).entries.map((e) => e.id), ['worktrees/gone']);
  assert.deepEqual((await run(bare, 'worktrees')).map((w) => w.path), [bare, wt]);
  assert.deepEqual(await run(bare, 'worktreeDirty'), [{ path: wt, dirty: false }], 'the bare entry is never checked');
  assert.equal(h.git(bare, 'branch', '--list', 'other').trim(), 'other', 'the branch is kept');
  assert.deepEqual((await run(bare, 'worktrees')).map((w) => w.missing), [false, false], 'the bare entry is never missing');
  assert.deepEqual(await run(bare, 'worktreeUnreachable', bare), { count: 0 }, 'the bare entry has no HEAD to lose');
  h.git(wt, 'checkout', '-q', '--detach');
  h.commitFile(wt, 'lost.txt', 'x\n', 'on a detached HEAD');
  assert.deepEqual(await run(bare, 'worktreeUnreachable', wt), { count: 1 });
});

test('createBranch (no checkout) and deleteBranch work in a bare repo; undo recreates the branch, redo deletes it again', async () => {
  const { bare } = h.bareWithWorktree();
  const { runner, events } = runnerWithEvents();
  const tip = rev(bare, 'main');
  assert.deepEqual(await runner.run(bare, 'createBranch', ['feat', { checkout: false }]), { name: 'feat', sha: tip });
  assert.deepEqual(await runner.run(bare, 'createBranch', ['feat2', {}]), { name: 'feat2', sha: tip });
  assert.equal(rev(bare, 'refs/heads/feat'), tip);
  assert.deepEqual(events.map(([k, e]) => [k, e.op, e.ok ?? e.running]).slice(0, 2), [['busy', 'createBranch', true], ['busy', 'createBranch', true]]);
  await runner.run(bare, 'setUpstream', ['feat', 'origin', 'main']);
  const del = await runner.run(bare, 'deleteBranch', ['feat']);
  assert.deepEqual(del, { name: 'feat', sha: tip, upstream: 'origin/main' });
  assert.equal(h.git(bare, 'branch', '--list', 'feat').trim(), '');
  // The deletion is in the bare HEAD reflog (git writes one there, although a bare repo logs no ref updates).
  const st = await runner.run(bare, 'undoState', []);
  assert.equal(st.undo.action, 'delete_branch');
  assert.equal(st.undo.description, 'Undo delete of branch feat');
  assert.equal(st.undoBlocked, null);
  const u = await runner.run(bare, 'undo', []);
  assert.deepEqual(u, { action: 'delete_branch', description: 'Undo delete of branch feat', upstreamRestored: true });
  assert.equal(rev(bare, 'refs/heads/feat'), tip);
  assert.equal(h.git(bare, 'rev-parse', '--abbrev-ref', 'feat@{upstream}').trim(), 'origin/main');
  const st2 = await runner.run(bare, 'undoState', []);
  assert.equal(st2.redo.action, 'delete_branch');
  await runner.run(bare, 'redo', []);
  assert.equal(h.git(bare, 'branch', '--list', 'feat').trim(), '');
});

test('deleteBranch in a bare repo: HEAD\'s branch is current-branch, a branch a linked worktree has checked out is checked-out-elsewhere', async () => {
  const { bare } = h.bareWithWorktree();
  const runner = ops.createRunner();
  await assert.rejects(runner.run(bare, 'deleteBranch', ['main']), { kind: 'current-branch' });
  const other = path.join(path.dirname(bare), 'other');
  h.git(bare, 'worktree', 'add', '-q', '-b', 'wtb', other, 'main');
  await assert.rejects(runner.run(bare, 'deleteBranch', ['wtb', { force: true }]), (e) => {
    assert.equal(e.kind, 'checked-out-elsewhere');
    assert.match(e.message, /used by worktree at|checked out at/);
    return true;
  });
  assert.equal(rev(bare, 'refs/heads/wtb'), rev(bare, 'main'), 'still there');
  // And from a worktree: the same classification for a branch of another worktree.
  const wt = path.join(path.dirname(bare), 'main');
  await assert.rejects(runner.run(wt, 'deleteBranch', ['wtb', { force: true }]), { kind: 'checked-out-elsewhere' });
});

test('deleteBranches in a bare repo: HEAD\'s branch is current-branch, a linked worktree\'s is checked-out-elsewhere, the rest is deleted', async () => {
  const { bare } = h.bareWithWorktree();
  const runner = ops.createRunner();
  h.git(bare, 'worktree', 'add', '-q', '-b', 'wtb', path.join(path.dirname(bare), 'other'), 'main');
  h.git(bare, 'branch', 'feat', 'main');
  const res = await runner.run(bare, 'deleteBranches', [['main', 'wtb', 'feat'], { force: true }]);
  assert.deepEqual(res.deleted.map((d) => d.name), ['feat']);
  assert.deepEqual(res.failed.map((f) => [f.name, f.kind]), [['main', 'current-branch'], ['wtb', 'checked-out-elsewhere']]);
  assert.equal(rev(bare, 'refs/heads/wtb'), rev(bare, 'main'), 'still there');
  assert.equal(h.git(bare, 'branch', '--list', 'feat').trim(), '');
  await runner.run(bare, 'undo', []);
  assert.equal(rev(bare, 'refs/heads/feat'), rev(bare, 'main'), 'undo recreates it');
});

test('undo in a bare repo offers only a branch delete: a commit entry in its HEAD reflog is blocked, never performed', async () => {
  const { bare } = h.bareWithWorktree();
  const runner = ops.createRunner();
  const tip = rev(bare, 'main');
  const parentless = h.git(bare, 'commit-tree', `${tip}^{tree}`, '-m', 'other').trim();
  // A "commit" entry (as a tool, or history from before the repo became bare, may leave there).
  h.git(bare, 'reflog', 'write', 'HEAD', parentless, tip, 'commit: made elsewhere');
  const st = await runner.run(bare, 'undoState', []);
  assert.deepEqual(st, { undo: null, redo: null, busy: false, undoBlocked: 'Needs a working tree (bare repository)', redoBlocked: null });
  await assert.rejects(runner.run(bare, 'undo', []), { kind: 'nothing', blocked: 'Needs a working tree (bare repository)' });
  assert.equal(rev(bare, 'main'), tip, 'main did not move');
  // A branch delete after it is offered again.
  await runner.run(bare, 'createBranch', ['tmp']);
  await runner.run(bare, 'deleteBranch', ['tmp']);
  assert.equal((await runner.run(bare, 'undoState', [])).undo.action, 'delete_branch');
  // Undo of it, then the commit entry is next: blocked again, while redo offers the delete.
  await runner.run(bare, 'undo', []);
  const after = await runner.run(bare, 'undoState', []);
  assert.equal(after.undo, null);
  assert.equal(after.undoBlocked, 'Needs a working tree (bare repository)');
  assert.equal(after.redo.action, 'delete_branch');
});

test('push from a bare repo: a new branch, then with its upstream', async () => {
  const { bare, remote } = h.bareWithWorktree();
  const runner = ops.createRunner();
  await runner.run(bare, 'createBranch', ['topic']);
  await assert.rejects(runner.run(bare, 'push', [{ branch: 'topic' }]), { kind: 'no-upstream' });
  const res = await runner.run(bare, 'push', [{ remote: 'origin', branch: 'topic' }]);
  assert.deepEqual(res, { remote: 'origin', branch: 'topic', remoteBranch: 'topic', forced: false });
  assert.equal(rev(remote, 'refs/heads/topic'), rev(bare, 'topic'));
  await runner.run(bare, 'setUpstream', ['topic', 'origin', 'topic']);
  // HEAD's branch is pushed by default (the bare HEAD names main, which tracks nothing yet).
  await assert.rejects(runner.run(bare, 'push', [{}]), { kind: 'no-upstream' });
  const wt = path.join(path.dirname(bare), 'main');
  h.commitFile(wt, 'more.txt', 'm\n');
  await runner.run(bare, 'setUpstream', ['main', 'origin', 'main']);
  const def = await runner.run(bare, 'push', [{}]);
  assert.equal(def.branch, 'main');
  assert.equal(rev(remote, 'refs/heads/main'), rev(wt, 'HEAD'));
});

test('fetch and pull {mode: fetch} in a bare repo with a fetch refspec update refs/remotes', async () => {
  const { bare, seed } = h.bareWithWorktree();
  const { runner, events } = runnerWithEvents();
  h.commitFile(seed, 'up.txt', 'u\n');
  h.git(seed, 'push', '-q', 'origin', 'main');
  h.git(seed, 'tag', 'v1');
  h.git(seed, 'push', '-q', 'origin', 'v1');
  assert.deepEqual(await runner.run(bare, 'fetch', [{}]), { tagConflicts: [] });
  assert.equal(rev(bare, 'refs/remotes/origin/main'), rev(seed, 'main'));
  assert.equal(rev(bare, 'refs/tags/v1'), rev(seed, 'v1'));
  h.commitFile(seed, 'up2.txt', 'u\n');
  h.git(seed, 'push', '-q', 'origin', 'main');
  const p = await runner.run(bare, 'pull', [{ mode: 'fetch' }]);
  assert.equal(p.mode, 'fetch');
  assert.equal(p.before, p.after, 'nothing merged');
  assert.equal(rev(bare, 'refs/remotes/origin/main'), rev(seed, 'main'));
  assert.ok(events.some(([k, e]) => k === 'changed' && e.op === 'pull' && e.ok));
  // The bare's main (checked out in the worktree) did not move.
  assert.notEqual(rev(bare, 'main'), rev(seed, 'main'));
  // Now behind: the synthetic status says so once main tracks origin/main.
  await runner.run(bare, 'setUpstream', ['main', 'origin', 'main']);
  assert.equal((await git.status(bare)).behind, 2);
});

test('a bare clone without a fetch refspec: fetch succeeds (tags only), setUpstream is refused as unsupported and leaves no ref', async () => {
  const { bare, seed } = h.bareWithWorktree({ refspec: false });
  const runner = ops.createRunner();
  h.git(seed, 'tag', 'v2');
  h.git(seed, 'push', '-q', 'origin', 'v2');
  assert.deepEqual(await runner.run(bare, 'fetch', [{ remote: 'origin' }]), { tagConflicts: [] });
  assert.equal(rev(bare, 'refs/tags/v2'), rev(seed, 'v2'));
  assert.equal(h.git(bare, 'for-each-ref', 'refs/remotes').trim(), '');
  await assert.rejects(runner.run(bare, 'setUpstream', ['main', 'origin', 'main']), (e) => {
    assert.equal(e.kind, 'unsupported');
    assert.match(e.message, /no fetch refspec for refs\/remotes\/origin\//);
    assert.match(e.message, /git config remote\.origin\.fetch '\+refs\/heads\/\*:refs\/remotes\/origin\/\*'/);
    return true;
  });
  assert.equal(h.git(bare, 'for-each-ref', 'refs/remotes').trim(), '', 'the tracking ref it made is removed again');
  // A tag conflict re-fetch needs positive refspecs: git's clone default is used (fetchRemote).
  h.git(bare, 'tag', '-f', 'v2', `${rev(bare, 'main')}`);
  h.commitFile(seed, 'x.txt', 'x\n');
  h.git(seed, 'tag', '-f', 'v2');
  h.git(seed, 'push', '-q', '-f', 'origin', 'main', 'v2');
  assert.deepEqual(await runner.run(bare, 'fetch', [{}]), { tagConflicts: ['v2'] });
});

// ---------------------------------------------------------------- review fixes

test('the gate is an allow-list: an op outside BARE_OK is refused in a bare repo, and runs in a worktree', async () => {
  const { bare, wt } = h.bareWithWorktree();
  const runner = ops.createRunner({ ops: { ...ops.OPS, extra: async () => 'ran' } });
  await assert.rejects(runner.run(bare, 'extra', []), { kind: 'bare-repo', message: 'extra needs a working tree: this is a bare repository' });
  assert.equal(await runner.run(wt, 'extra', []), 'ran');
});

/** A `git clone --mirror` of repoWithRemote's remote: remote.origin.mirror, '+refs/*:refs/*'. */
function mirrorClone() {
  const { remote, seed } = h.repoWithRemote();
  const mirror = path.join(h.tmpDir(), 'mirror.git');
  h.git(path.dirname(mirror), 'clone', '-q', '--mirror', remote, mirror);
  return { remote, seed, mirror };
}

test('a mirror clone: fetch, pull {mode: fetch} and createBranch are refused (kind mirror-repo); a branch made there survives', async () => {
  const { seed, mirror } = mirrorClone();
  assert.deepEqual(await git.mirrorRemotes(mirror), [{ remote: 'origin', why: '+refs/*:refs/*' }]);
  const { runner, events } = runnerWithEvents();
  await assert.rejects(runner.run(mirror, 'createBranch', ['feature']), (e) => {
    assert.equal(e.kind, 'mirror-repo');
    assert.match(e.message, /mirror repository \(\+refs\/\*:refs\/\*\)/);
    assert.match(e.message, /overwritten or deleted by the next fetch of 'origin'/);
    assert.deepEqual(ops.serializeError(e).remotes, ['origin']);
    return true;
  });
  assert.equal(fs.existsSync(path.join(mirror, 'refs', 'heads', 'feature')), false);
  // A branch with a commit of its own, made outside the app: a fetch would prune it (no undo).
  const tip = rev(mirror, 'main');
  const own = h.git(mirror, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'unpushed').trim();
  h.git(mirror, 'update-ref', 'refs/heads/feature', own);
  h.commitFile(seed, 'up.txt', 'u\n');
  h.git(seed, 'push', '-q', 'origin', 'main');
  for (const [name, args] of [['fetch', [{}]], ['fetch', [{ remote: 'origin' }]], ['pull', [{ mode: 'fetch' }]]]) {
    await assert.rejects(runner.run(mirror, name, args), (e) => {
      assert.equal(e.kind, 'mirror-repo', `${name} ${JSON.stringify(args)}`);
      assert.match(e.message, /Fetching 'origin' would overwrite local branches and delete the ones it lacks/);
      return true;
    });
  }
  assert.deepEqual(events, [], 'refused before anything ran');
  assert.equal(rev(mirror, 'refs/heads/feature'), own, 'the branch and its commit are still there');
  assert.equal(rev(mirror, 'main'), tip, 'main was not overwritten');
  // Another remote with an ordinary refspec still fetches; the mirror's reads and pushes of it work.
  const other = h.initRepo({ bare: true });
  h.git(seed, 'push', '-q', other, 'main');
  h.git(mirror, 'remote', 'add', 'other', other);
  assert.deepEqual(await runner.run(mirror, 'fetch', [{ remote: 'other' }]), { tagConflicts: [] });
  assert.equal(rev(mirror, 'refs/remotes/other/main'), rev(seed, 'main'));
  assert.equal((await runner.run(mirror, 'refs', [])).head.branch, 'main');
  // A push of one branch to the mirror remote: git refuses a refspec with remote.<r>.mirror.
  await assert.rejects(runner.run(mirror, 'push', [{ remote: 'origin', branch: 'feature' }]), { kind: 'mirror-repo' });
});

test('git.mirrorRemotes / writesBranches: which fetch refspecs write local branches', async () => {
  for (const [spec, want] of [
    ['+refs/*:refs/*', true], ['+refs/heads/*:refs/heads/*', true], ['refs/heads/a:refs/heads/b', true],
    ['main:main', true], ['+refs/h*:refs/h*', true], ['*:*', true],
    ['+refs/heads/*:refs/remotes/origin/*', false], ['+refs/tags/*:refs/tags/*', false], ['x:tags/x', false],
    ['^refs/heads/x', false], ['refs/heads/x', false], ['refs/heads/x:', false],
  ]) assert.equal(git.writesBranches(spec), want, spec);
  const { local } = h.repoWithRemote();
  assert.deepEqual(await git.mirrorRemotes(local), [], 'an ordinary clone');
  const { bare } = h.bareWithWorktree();
  assert.deepEqual(await git.mirrorRemotes(bare), []);
  h.git(bare, 'remote', 'add', '--mirror=push', 'pm', '/nowhere');
  h.git(bare, 'config', 'remote.odd.name.fetch', '+refs/heads/*:refs/heads/*');
  h.git(bare, 'config', 'remote.odd.name.url', '/nowhere');
  assert.deepEqual(await git.mirrorRemotes(bare), [{ remote: 'pm', why: 'remote.pm.mirror' }, { remote: 'odd.name', why: '+refs/heads/*:refs/heads/*' }]);
  // Only the remotes that write branches are refused: origin's fetch still runs.
  assert.deepEqual(await ops.createRunner().run(bare, 'fetch', [{ remote: 'origin' }]), { tagConflicts: [] });
  await assert.rejects(ops.createRunner().run(bare, 'fetch', [{}]), { kind: 'mirror-repo' });
});

test('fetch into a branch a worktree has checked out is kind checked-out-elsewhere (any repo)', async () => {
  const { local, seed } = h.repoWithRemote();
  h.git(local, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*');
  h.commitFile(seed, 'up.txt', 'u\n');
  h.git(seed, 'push', '-q', 'origin', 'main');
  await assert.rejects(ops.createRunner().run(local, 'fetch', [{}]), (e) => {
    assert.equal(e.kind, 'checked-out-elsewhere');
    assert.match(e.message, /refusing to fetch into (current )?branch/);
    return true;
  });
});

/**
 * The embedded bare repo attack: a project tracks docs/e.git (HEAD, a config with core.bare and an
 * origin of ../.., refs/heads/.keep, objects/.keep and an executable hooks/reference-transaction
 * that creates PWNED at the clone's top). Returns {victim, embedded, marker} of a fresh clone.
 */
function embeddedBareProject() {
  const proj = h.initRepo();
  const e = path.join(proj, 'docs', 'e.git');
  h.write(e, 'HEAD', 'ref: refs/heads/main\n');
  h.write(e, 'config', '[core]\n\tbare = true\n[remote "origin"]\n\turl = ../..\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  h.write(e, 'refs/heads/.keep', '');
  h.write(e, 'objects/.keep', '');
  h.write(e, 'hooks/reference-transaction', '#!/bin/sh\ntouch "$(dirname "$0")/../../../PWNED"\n');
  fs.chmodSync(path.join(e, 'hooks', 'reference-transaction'), 0o755);
  h.git(proj, 'add', '-A');
  h.git(proj, 'commit', '-q', '-m', 'docs');
  const victim = path.join(h.tmpDir(), 'victim');
  h.git(path.dirname(victim), 'clone', '-q', proj, victim);
  return { victim, embedded: path.join(victim, 'docs', 'e.git'), marker: path.join(victim, 'PWNED') };
}

test('a bare repo a project tracks is refused (kind embedded-bare): opening it from the clone runs nothing', async () => {
  const { victim, embedded, marker } = embeddedBareProject();
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(embedded, 'hooks', 'reference-transaction')).mode & 0o111, 0o111, 'checked out executable');
  for (const dir of [embedded, path.join(embedded, 'refs'), path.join(embedded, 'refs', 'heads')]) {
    await assert.rejects(ops.openRepo(dir), (e) => {
      assert.equal(e.kind, 'embedded-bare', dir);
      assert.match(e.message, /is a bare repository inside the working tree of /);
      assert.ok(e.message.includes(fs.realpathSync(victim)), e.message);
      return true;
    });
  }
  assert.equal(await exec.isBare(embedded), true, 'git still calls it bare');
  assert.equal(fs.existsSync(marker), false, 'no hook ran');
  // The clone itself opens as a normal repo, and the hooks would be listed for a bare repo.
  assert.equal((await ops.openRepo(victim)).bare, false);
  assert.deepEqual(await git.riskyHooks(embedded), ['hooks/reference-transaction']);
  // What the refusal prevents: git's own fetch there runs the hook.
  if (process.platform !== 'win32') {
    h.git(embedded, 'fetch', '-q', 'origin');
    assert.equal(fs.existsSync(marker), true, 'the attack is real');
  }
});

test('git.riskyHooks: the executable hooks of a bare repo, not samples or dot-files; core.hooksPath is followed', async () => {
  const { top, bare } = h.bareWithWorktree({ worktree: false });
  assert.ok(fs.readdirSync(path.join(bare, 'hooks')).some((f) => f.endsWith('.sample')), 'a clone has the samples');
  assert.deepEqual(await git.riskyHooks(bare), []);
  h.write(bare, 'hooks/post-update', '#!/bin/sh\n');
  h.write(bare, 'hooks/.hidden', '#!/bin/sh\n');
  fs.chmodSync(path.join(bare, 'hooks', '.hidden'), 0o755);
  h.write(bare, 'hooks/pre-push', '#!/bin/sh\n');
  fs.chmodSync(path.join(bare, 'hooks', 'pre-push'), 0o755);
  assert.deepEqual(await git.riskyHooks(bare), process.platform === 'win32' ? ['hooks/post-update', 'hooks/pre-push'] : ['hooks/pre-push']);
  const other = path.join(top, 'my-hooks');
  h.write(other, 'reference-transaction', '#!/bin/sh\n');
  fs.chmodSync(path.join(other, 'reference-transaction'), 0o755);
  h.git(bare, 'config', 'core.hooksPath', other);
  assert.deepEqual(await git.riskyHooks(bare), ['hooks/reference-transaction']);
  fs.rmSync(other, { recursive: true });
  assert.deepEqual(await git.riskyHooks(bare), [], 'no hooks folder');
});

test('stale caches: a normal repo made where a bare one was opens as normal (openRepo, a subfolder, summary)', async () => {
  const dir = path.join(h.tmpDir(), 'x');
  const remake = (bare) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    h.git(dir, 'init', '-q', '-b', 'main', ...(bare ? ['--bare'] : []));
    if (!bare) {
      h.git(dir, 'config', 'commit.gpgSign', 'false');
      h.commitFile(dir, 'sub/a.txt', 'a\n', 'initial');
    }
  };
  remake(true);
  assert.equal((await ops.openRepo(dir)).bare, true);
  remake(false);
  const info = await ops.openRepo(dir);
  assert.equal(info.bare, false);
  assert.equal(info.root, dir);
  h.write(dir, 'new.txt', 'n\n');
  await ops.createRunner().run(dir, 'stageAll', []);
  assert.deepEqual((await git.status(dir)).staged, [{ path: 'new.txt', status: 'A' }]);
  // Opened through a subfolder: the root git finds is forgotten too.
  remake(true);
  assert.equal((await ops.openRepo(dir)).bare, true);
  remake(false);
  assert.deepEqual(await ops.openRepo(path.join(dir, 'sub')), { root: dir, name: 'x', head: { sha: rev(dir, 'HEAD'), branch: 'main' }, bare: false, linkedWorktree: null });
  // app:getState's summary of a tab whose folder changed underneath it.
  remake(true);
  assert.equal((await ops.openRepo(dir)).bare, true);
  remake(false);
  assert.equal((await ops.summary(dir)).bare, false);
  h.write(dir, 'n2.txt', 'n\n');
  await ops.createRunner().run(dir, 'stageAll', []);
});

test('stale caches: a normal repo replaced by a bare one, or converted to the bare + worktrees layout, opens bare', async () => {
  const { remote } = h.repoWithRemote();
  const dir = path.join(h.tmpDir(), 'y');
  h.git(path.dirname(dir), 'clone', '-q', remote, dir);
  assert.equal((await ops.openRepo(dir)).bare, false);
  assert.equal(await exec.isBare(dir), false); // cached as a worktree root
  fs.rmSync(dir, { recursive: true, force: true });
  h.git(path.dirname(dir), 'clone', '-q', '--bare', remote, dir);
  // The open tab's next getState: bare now, and the runner refuses working-tree ops.
  assert.equal((await ops.summary(dir)).bare, true);
  await assert.rejects(ops.createRunner().run(dir, 'stageAll', []), { kind: 'bare-repo' });
  assert.equal((await ops.openRepo(dir)).bare, true);
  // A normal repo converted in place: top/.git moved to top/.bare (core.bare), top/.git names it.
  const top = h.initRepo();
  assert.equal((await ops.openRepo(top)).bare, false);
  fs.renameSync(path.join(top, '.git'), path.join(top, '.bare'));
  h.git(path.join(top, '.bare'), 'config', 'core.bare', 'true');
  fs.writeFileSync(path.join(top, '.git'), 'gitdir: ./.bare\n');
  const info = await ops.openRepo(top);
  assert.deepEqual([info.root, info.bare], [path.join(top, '.bare'), true]);
  await assert.rejects(ops.createRunner().run(info.root, 'stageAll', []), { kind: 'bare-repo' });
});

test('opening a bare repo through a symlink: the root is the real git dir', { skip: process.platform === 'win32' && 'symlinks need privileges' }, async () => {
  const { top, bare } = h.bareWithWorktree();
  const links = h.tmpDir();
  fs.symlinkSync(bare, path.join(links, 'to-bare'));
  fs.symlinkSync(top, path.join(links, 'to-top'));
  for (const dir of [path.join(links, 'to-bare'), path.join(links, 'to-bare', 'refs'), path.join(links, 'to-top')]) {
    const info = await ops.openRepo(dir);
    assert.deepEqual([info.root, info.bare], [bare, true], dir);
  }
  assert.equal(await exec.isBare(path.join(links, 'to-bare')), true);
  await assert.rejects(ops.createRunner().run(bare, 'stageAll', []), { kind: 'bare-repo' });
});
