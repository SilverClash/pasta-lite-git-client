'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const ops = require('../src/ops');
const { GitError, kindError } = require('../src/exec');

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/**
 * Resolves once `file` exists: the hook, filter or upload-pack a test cancels writes it when it
 * starts, so the cancel lands on the hanging process however slow the run is (a fixed delay can
 * fire before the op even starts on a loaded machine, and then tests something else).
 */
async function waitForFile(file, what, ms = 60000) {
  const t0 = Date.now();
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() - t0 < ms, `${what} never started`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('registry has exactly the documented operations', () => {
  const reads = ['status', 'refs', 'log', 'stashes', 'commitDiffView', 'workdirDiffView', 'commitFiles', 'diffCommitFile', 'diffWorkdir', 'undoState', 'remotes', 'lastCommitMessage', 'rebasePlan', 'worktrees', 'worktreeDirty', 'worktreePrunePreview', 'worktreeUnreachable'];
  const writes = [
    'stage', 'stageAll', 'unstage', 'unstageAll', 'stageSelection', 'unstageSelection', 'discardSelection', 'discard',
    'commit', 'commitAll', 'fetch', 'pull', 'push', 'setUpstream', 'checkout', 'createBranch', 'deleteBranch', 'deleteBranches',
    'stashPush', 'stashApply', 'stashPop', 'stashDrop', 'undo', 'redo',
    'rebaseContinue', 'rebaseSkip', 'rebaseAbort', 'restoreAutostash', 'mergeCommit', 'mergeAbort',
    'merge', 'rebase', 'resolveWith', 'markAllResolved', 'rebaseInteractive',
    'removeWorktree', 'pruneWorktrees', 'lockWorktree', 'unlockWorktree',
  ];
  assert.deepEqual(Object.keys(ops.OPS).sort(), [...reads, ...writes].sort());
  assert.deepEqual([...ops.WRITE_OPS].sort(), [...writes].sort());
  assert.ok(Object.isFrozen(ops.OPS));
  for (const fn of Object.values(ops.OPS)) assert.equal(typeof fn, 'function');
});

test('runner rejects unknown and inherited op names', async () => {
  const runner = ops.createRunner();
  for (const name of ['nope', 'constructor', '__proto__', 'toString']) {
    await assert.rejects(runner.run('/x', name, []), { kind: 'unknown-op' });
  }
  await assert.rejects(runner.run('/x', 'status', 'not-an-array'), { kind: 'invalid-args' });
});

test('read ops work end to end: status, log paging, commitFiles, diffs', async () => {
  const dir = h.initRepo();
  const a = h.commitFile(dir, 'a.txt', 'one\n', 'add a');
  h.commitFile(dir, 'a.txt', 'two\n', 'edit a');
  h.write(dir, 'a.txt', 'three\n');
  const runner = ops.createRunner();
  const st = await runner.run(dir, 'status');
  assert.equal(st.branch, 'main');
  assert.deepEqual(st.unstaged.map((f) => f.path), ['a.txt']);
  const p1 = await runner.run(dir, 'log', [{ limit: 2 }]);
  assert.equal(p1.commits.length, 2);
  const p2 = await runner.run(dir, 'log', [{ limit: 2, ...p1.next }]);
  assert.deepEqual(p2.commits.map((c) => c.subject), ['initial']);
  assert.deepEqual((await runner.run(dir, 'commitFiles', [a])).map((f) => f.path), ['a.txt']);
  assert.match(await runner.run(dir, 'diffCommitFile', [a, 'a.txt']), /\+one/);
  assert.match(await runner.run(dir, 'diffWorkdir', ['a.txt']), /\+three/);
  assert.equal((await runner.run(dir, 'undoState')).busy, false);
  assert.deepEqual(await runner.run(dir, 'remotes'), []);
});

test('paths outside the repo and option-like refs are refused before git runs', async () => {
  const dir = h.initRepo();
  const outside = h.tmpDir();
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'keep\n');
  const runner = ops.createRunner();
  const bad = [
    ['stage', [['../x']]], ['stage', [[path.join(outside, 'victim.txt')]]], ['stage', [['.git/config']]],
    ['stage', [['sub/.GIT/hooks']]], ['stage', [[]]], ['stage', ['README.md']],
    ['discard', [[{ path: `../${path.basename(outside)}/victim.txt`, status: '?' }]]],
    ['discardSelection', ['../../victim.txt', [{ hunk: 0 }]]],
    ['diffWorkdir', ['/etc/passwd', { untracked: true }]],
    ['checkout', ['--orphan']], ['createBranch', ['x', { start: '-f' }]], ['deleteBranch', ['-D']],
    ['log', [{ limit: 0 }]], ['log', [{ tips: ['HEAD'] }]], ['commitFiles', ['HEAD']],
    ['push', [{ force: 'yes' }]], ['stashApply', ['stash@{0}']], ['commit', [42]],
  ];
  for (const [op, args] of bad) {
    await assert.rejects(runner.run(dir, op, args), { kind: 'invalid-args' }, `${op} ${JSON.stringify(args)}`);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'keep\n');
});

test('write ops for one repo run one at a time, in call order; reads do not queue', async () => {
  const order = [];
  const gates = [deferred(), deferred()];
  const fakeOps = {
    w1: async () => { order.push('w1 start'); await gates[0].promise; order.push('w1 end'); return 1; },
    w2: async () => { order.push('w2 start'); await gates[1].promise; order.push('w2 end'); return 2; },
    w3: async () => { order.push('w3'); throw new Error('boom'); },
    w4: async () => { order.push('w4'); return 4; },
    other: async () => { order.push('other repo'); return 'o'; },
    r: async () => { order.push('read'); return 'r'; },
  };
  const runner = ops.createRunner({ ops: fakeOps, writeOps: new Set(['w1', 'w2', 'w3', 'w4', 'other']), remoteOps: new Set() });
  const p1 = runner.run('/repo', 'w1');
  const p2 = runner.run('/repo', 'w2');
  const p3 = runner.run('/repo', 'w3');
  const p4 = runner.run('/repo', 'w4');
  await new Promise((r) => setImmediate(r));
  assert.equal(await runner.run('/repo', 'r'), 'r'); // runs while w1 holds the queue
  assert.equal(await runner.run('/other', 'other'), 'o'); // other repos have their own queue
  assert.deepEqual(order, ['w1 start', 'read', 'other repo']);
  gates[1].resolve(); // w2's gate opening early must not let it start
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['w1 start', 'read', 'other repo']);
  gates[0].resolve();
  assert.deepEqual(await Promise.all([p1, p2, p3.catch((e) => e.message), p4]), [1, 2, 'boom', 4]);
  assert.deepEqual(order, ['w1 start', 'read', 'other repo', 'w1 end', 'w2 start', 'w2 end', 'w3', 'w4']);
});

test('real writes serialize under concurrency: interleaved stage/commit pairs land in call order', async () => {
  const dir = h.initRepo();
  const runner = ops.createRunner();
  const jobs = [];
  for (let i = 0; i < 4; i++) h.write(dir, `f${i}.txt`, `${i}\n`);
  // All enqueued at once, none awaited: without the queue these git processes would race
  // for index.lock and commits would pick up the wrong files.
  for (let i = 0; i < 4; i++) {
    jobs.push(runner.run(dir, 'stage', [[`f${i}.txt`]]), runner.run(dir, 'commit', [`c${i}`]));
  }
  await Promise.all(jobs);
  assert.deepEqual(h.git(dir, 'log', '--format=%s').trim().split('\n'), ['c3', 'c2', 'c1', 'c0', 'initial']);
  for (let i = 0; i < 4; i++) {
    assert.equal(h.git(dir, 'show', '--name-only', '--format=', `HEAD~${3 - i}`).trim(), `f${i}.txt`);
  }
});

test("'busy' and 'changed' events around writes; 'changed' also after a failed write; none for reads or invalid args", async () => {
  const dir = h.initRepo();
  const runner = ops.createRunner();
  const events = [];
  runner.on('busy', (e) => events.push(['busy', e]));
  runner.on('changed', (e) => events.push(['changed', e]));
  h.write(dir, 'x.txt', 'x\n');
  await runner.run(dir, 'status');
  await runner.run(dir, 'stage', [['x.txt']]);
  await assert.rejects(runner.run(dir, 'stage', [['../x']]), { kind: 'invalid-args' }); // rejected before starting
  await assert.rejects(runner.run(dir, 'commit', ['   ']), { kind: 'empty-message' }); // rejected before starting
  await assert.rejects(runner.run(dir, 'commitAll', ['']), { kind: 'empty-message' });
  await runner.run(dir, 'commit', ['m']);
  await assert.rejects(runner.run(dir, 'commit', ['m']), { kind: 'nothing-to-commit' }); // started, then failed
  assert.deepEqual(events, [
    ['busy', { repo: dir, op: 'stage', running: true }],
    ['busy', { repo: dir, op: 'stage', running: false, ok: true }],
    ['changed', { repo: dir, op: 'stage', ok: true }],
    ['busy', { repo: dir, op: 'commit', running: true }],
    ['busy', { repo: dir, op: 'commit', running: false, ok: true }],
    ['changed', { repo: dir, op: 'commit', ok: true }],
    ['busy', { repo: dir, op: 'commit', running: true }],
    ['busy', { repo: dir, op: 'commit', running: false, ok: false }],
    ['changed', { repo: dir, op: 'commit', ok: false }],
  ]);
});

test('discard goes through withDiscardBackup, so undo restores the files', async () => {
  const dir = h.initRepo();
  h.write(dir, 'README.md', 'changed\n');
  h.write(dir, 'new file.txt', 'untracked\n');
  const runner = ops.createRunner();
  const st = await runner.run(dir, 'status');
  const { backup } = await runner.run(dir, 'discard', [st.unstaged]);
  assert.match(backup, /^[0-9a-f]{40}$/);
  assert.equal(h.read(dir, 'README.md'), 'hello\n');
  assert.ok(!fs.existsSync(path.join(dir, 'new file.txt')));
  assert.equal((await runner.run(dir, 'undoState')).undo.action, 'discard');
  await runner.run(dir, 'undo');
  assert.equal(h.read(dir, 'README.md'), 'changed\n');
  assert.equal(h.read(dir, 'new file.txt'), 'untracked\n');
});

test('discardSelection goes through withDiscardBackup; undo and redo are exact', async () => {
  const dir = h.initRepo();
  const base = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');
  h.commitFile(dir, 'f.txt', base);
  const edited = base.replace('line 1\n', 'LINE 1\n').replace('line 18\n', 'LINE 18\n');
  h.write(dir, 'f.txt', edited);
  const runner = ops.createRunner();
  const { fingerprint } = await runner.run(dir, 'workdirDiffView', ['f.txt']);
  const { backup } = await runner.run(dir, 'discardSelection', ['f.txt', [{ hunk: 1 }], { fingerprint }]);
  assert.ok(backup);
  const partial = base.replace('line 1\n', 'LINE 1\n');
  assert.equal(h.read(dir, 'f.txt'), partial);
  await runner.run(dir, 'undo');
  assert.equal(h.read(dir, 'f.txt'), edited);
  await runner.run(dir, 'redo');
  assert.equal(h.read(dir, 'f.txt'), partial);
});

test('deleteBranch records the deletion, so undo recreates the branch', async () => {
  const dir = h.initRepo();
  const runner = ops.createRunner();
  const { sha } = await runner.run(dir, 'createBranch', ['feat/x']);
  const res = await runner.run(dir, 'deleteBranch', ['feat/x']);
  assert.deepEqual(res, { name: 'feat/x', sha, upstream: null });
  assert.equal((await runner.run(dir, 'undoState')).undo.action, 'delete_branch');
  await runner.run(dir, 'undo');
  assert.equal(h.git(dir, 'rev-parse', 'feat/x').trim(), sha);
});

test('deleteBranches: deletes what it can in one write, reports the rest; force; each delete undoable', async () => {
  const dir = h.initRepo();
  const runner = ops.createRunner();
  const events = [];
  runner.on('changed', (e) => events.push(e));
  const { sha: a } = await runner.run(dir, 'createBranch', ['chore/a']);
  await runner.run(dir, 'createBranch', ['chore/wip', { checkout: true }]);
  h.write(dir, 'wip.txt', 'wip\n');
  h.git(dir, 'add', 'wip.txt');
  h.git(dir, 'commit', '-q', '-m', 'wip');
  await runner.run(dir, 'checkout', ['main']);
  await assert.rejects(runner.run(dir, 'deleteBranches', [[]]), { kind: 'invalid-args' });
  await assert.rejects(runner.run(dir, 'deleteBranches', [['ok', '-D']]), { kind: 'invalid-args' });
  await assert.rejects(runner.run(dir, 'deleteBranches', [['a\nb']]), { kind: 'invalid-args' });
  await assert.rejects(runner.run(dir, 'deleteBranches', [Array.from({ length: 1001 }, (_, i) => `b${i}`)]), { kind: 'invalid-args' });
  events.length = 0;
  const res = await runner.run(dir, 'deleteBranches', [['chore/a', 'main', 'chore/wip', 'nope', 'chore/a']]);
  assert.deepEqual(res.deleted, [{ name: 'chore/a', sha: a, upstream: null }]);
  assert.deepEqual(res.failed.map((f) => [f.name, f.kind]), [['main', 'current-branch'], ['chore/wip', 'not-merged'], ['nope', 'not-found']]);
  assert.ok(res.failed.every((f) => typeof f.message === 'string' && f.message));
  assert.equal(events.length, 1, 'one changed event');
  const forced = await runner.run(dir, 'deleteBranches', [['chore/wip'], { force: true }]);
  assert.deepEqual(forced.deleted.map((d) => d.name), ['chore/wip']);
  assert.equal(h.git(dir, 'for-each-ref', 'refs/heads/chore').trim(), '');
  await runner.run(dir, 'undo');
  assert.ok(h.git(dir, 'rev-parse', '--verify', 'chore/wip').trim());
  await runner.run(dir, 'undo');
  assert.equal(h.git(dir, 'rev-parse', 'chore/a').trim(), a);
});

test('deleteBranches: stops between branches once cancelled (the rest fail as aborted); HEAD and the branches are read once', async () => {
  const dir = h.initRepo();
  for (const n of ['x/a', 'x/b', 'x/c']) h.git(dir, 'branch', n);
  const git = require('../src/git');
  const { check, act } = ops.DESCRIPTORS.deleteBranches;
  const args = await check(dir, ['x/a', 'x/b', 'x/c'], {});
  const ctrl = new AbortController();
  const realRemove = git.removeBranch;
  const realTips = git.branchTips;
  let tipsReads = 0;
  git.branchTips = (...a) => { tipsReads++; return realTips(...a); };
  git.removeBranch = async (...a) => { const r = await realRemove(...a); ctrl.abort(); return r; };
  try {
    const res = await act(dir, ...args, ctrl.signal);
    assert.deepEqual(res.deleted.map((d) => d.name), ['x/a']);
    assert.deepEqual(res.failed.map((f) => [f.name, f.kind]), [['x/b', 'aborted'], ['x/c', 'aborted']]);
    assert.equal(tipsReads, 1);
  } finally {
    git.removeBranch = realRemove;
    git.branchTips = realTips;
  }
  assert.equal(h.git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/x').trim(), 'x/b\nx/c');
  const undone = await ops.OPS.undo(dir);
  assert.match(undone.description, /x\/a/);
});

test('stash ops and checkout through the registry', async () => {
  const dir = h.initRepo();
  const runner = ops.createRunner();
  await runner.run(dir, 'createBranch', ['side', { checkout: true }]);
  assert.equal((await runner.run(dir, 'status')).branch, 'side');
  await runner.run(dir, 'checkout', ['main']);
  h.write(dir, 'README.md', 'wip\n');
  const hash = await runner.run(dir, 'stashPush', ['msg']);
  assert.equal((await runner.run(dir, 'stashes'))[0].hash, hash);
  const popped = await runner.run(dir, 'stashPop', [0]);
  assert.equal(popped.dropped, true);
  assert.equal(h.read(dir, 'README.md'), 'wip\n');
});

test('serializeError keeps kind, exitCode, known extras, plain result, nested error messages; drops stack, args, stderr, env', () => {
  const ge = new GitError(['push', 'origin'], 1, 'rejected\n', '');
  Object.assign(ge, {
    kind: 'rejected-behind', refspec: 'refs/heads/a:refs/heads/a', reason: 'non-fast-forward',
    env: { SECRET: 'x' }, resetError: new Error('inner'), result: { big: true },
  });
  const s = ops.serializeError(ge);
  assert.deepEqual(s, {
    message: 'rejected', kind: 'rejected-behind', exitCode: 1,
    reason: 'non-fast-forward', refspec: 'refs/heads/a:refs/heads/a',
    result: { big: true }, resetError: 'inner',
  });
  // result only when it is plain data
  for (const result of [new Map(), { f: () => 1 }, { e: new Error('x') }, { n: NaN }, Buffer.from('x')]) {
    assert.ok(!('result' in ops.serializeError(Object.assign(new Error('m'), { result }))), String(result));
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.ok(!('result' in ops.serializeError(Object.assign(new Error('m'), { result: cyclic }))));
  assert.deepEqual(ops.serializeError(Object.assign(new Error('m'), { result: { mode: 'ff-only', before: null, after: 'a', list: [1, 'b'] } })).result,
    { mode: 'ff-only', before: null, after: 'a', list: [1, 'b'] });
  const sc = ops.serializeError(kindError('stash-conflict', 'reapply failed', {
    stashKept: true, stash: 'a'.repeat(40), resetFailed: true, indexRestored: false,
  }));
  assert.deepEqual(sc, {
    message: 'reapply failed', kind: 'stash-conflict', exitCode: null,
    stashKept: true, stash: 'a'.repeat(40), indexRestored: false, resetFailed: true,
  });
  const more = ops.serializeError(kindError('no-upstream', 'x', { remotes: ['origin'], tagConflicts: ['v1'], blocked: 'why', state: 'merging', remoteMessage: 'hook' }));
  assert.deepEqual(more.remotes, ['origin']);
  assert.deepEqual(more.tagConflicts, ['v1']);
  assert.equal(more.blocked, 'why');
  assert.equal(more.state, 'merging');
  assert.equal(more.remoteMessage, 'hook');
  assert.deepEqual(ops.serializeError(new Error('plain')), { message: 'plain', kind: null, exitCode: null });
  assert.deepEqual(ops.serializeError('str'), { message: 'str', kind: null, exitCode: null });
  for (const v of [s, sc, more]) {
    assert.ok(!('stack' in v) && !('env' in v) && !('args' in v) && !('stderr' in v) && !('stdout' in v));
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
  }
});

/**
 * A repo whose remote 'slow' hangs on fetch: its upload-pack touches `started` (the returned
 * marker path), then is `sleep 30` (the shell comment drops the path git appends; exec: no fork
 * after the marker, so the group kill can't race a child being forked). Not an ext:: remote:
 * git-process.js forbids that transport.
 */
function slowRemoteRepo() {
  const dir = h.initRepo();
  const started = path.join(h.tmpDir(), 'upload-pack-started');
  h.git(dir, 'remote', 'add', 'slow', h.initRepo({ bare: true }));
  h.git(dir, 'config', 'remote.slow.uploadpack', `touch '${started}'; exec sleep 30 #`);
  return { dir, started };
}

test('cancel aborts a hanging fetch (a remote whose upload-pack never answers)', async () => {
  const { dir, started } = slowRemoteRepo();
  const runner = ops.createRunner();
  const p = runner.run(dir, 'fetch', [{ remote: 'slow' }], { opId: 'op-1' });
  await waitForFile(started, 'the remote\'s upload-pack');
  const cancelledAt = Date.now();
  assert.equal(runner.cancel('op-1'), true);
  await assert.rejects(p, { kind: 'aborted' });
  assert.ok(Date.now() - cancelledAt < 10000, 'fetch was killed, not waited for');
  assert.equal(runner.cancel('op-1'), false); // forgotten once settled
});

test('cancel of a queued op rejects it without running; duplicate op ids are refused', async () => {
  const gate = deferred();
  let ran = false;
  const fakeOps = { hold: () => gate.promise, later: async () => { ran = true; } };
  const runner = ops.createRunner({ ops: fakeOps, writeOps: new Set(['hold', 'later']), remoteOps: new Set() });
  const p1 = runner.run('/r', 'hold', [], { opId: 'a' });
  await assert.rejects(runner.run('/r', 'hold', [], { opId: 'a' }), { kind: 'invalid-args' });
  const p2 = runner.run('/r', 'later', [], { opId: 'b' });
  assert.equal(runner.cancel('b'), true);
  gate.resolve('done');
  assert.equal(await p1, 'done');
  await assert.rejects(p2, { kind: 'aborted' });
  assert.equal(ran, false);
});

test('remote ops get the runner signal, never one from the args', async (t) => {
  const git = require('../src/git');
  const { local } = h.repoWithRemote();
  const orig = git.fetch;
  t.after(() => { git.fetch = orig; });
  let got;
  git.fetch = async (repo, o) => { got = o; };
  const fake = new AbortController().signal;
  await ops.createRunner().run(local, 'fetch', [{ remote: 'origin', signal: fake, timeout: 1 }, fake], { opId: 'x' });
  assert.ok(got.signal instanceof AbortSignal);
  assert.notEqual(got.signal, fake);
  assert.deepEqual(Object.keys(got).sort(), ['remote', 'signal']);
  assert.equal(got.remote, 'origin');
});

test('openRepo resolves the root from a subdirectory; non-repos give not-a-repo, missing folders not-found', async () => {
  const dir = h.initRepo();
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  const info = await ops.openRepo(path.join(dir, 'a', 'b'));
  assert.equal(info.root, dir);
  assert.equal(info.name, path.basename(dir));
  assert.equal(info.head.branch, 'main');
  assert.match(info.head.sha, /^[0-9a-f]{40}$/);
  await assert.rejects(ops.openRepo(h.tmpDir()), { kind: 'not-a-repo' });
  await assert.rejects(ops.openRepo(path.join(h.tmpDir(), 'missing')), { kind: 'not-found' });
  await assert.rejects(ops.openRepo(path.join(dir, 'README.md')), { kind: 'not-a-repo' });
  await assert.rejects(ops.openRepo(path.join(dir, 'README.md', 'x')), { kind: 'not-found' });
  // A bare repo opens (test/bare.test.js); a normal repo's .git folder is not bare.
  const bare = h.initRepo({ bare: true });
  assert.deepEqual(await ops.openRepo(bare), { root: bare, name: path.basename(bare), head: { sha: null, branch: 'main' }, bare: true, linkedWorktree: null });
  assert.equal(info.bare, false);
  await assert.rejects(ops.openRepo(path.join(dir, '.git')), { kind: 'not-a-repo' });
  await assert.rejects(ops.openRepo(path.join(dir, '.git', 'refs')), { kind: 'not-a-repo' });
  await assert.rejects(ops.openRepo(''), { kind: 'not-a-repo' });
  const unborn = await ops.openRepo(h.initRepo({ commits: false }));
  assert.deepEqual(unborn.head, { sha: null, branch: 'main' });
});

test('openRepo / summary: linkedWorktree is set only for a linked worktree, from git\'s dirs (main worktree, its subfolder, normal and bare repos: null)', async () => {
  const dir = h.initRepo();
  const wt = path.join(h.tmpDir(), 'feat-wt');
  h.git(dir, 'worktree', 'add', '-q', '-b', 'feat', wt);
  fs.mkdirSync(path.join(wt, 'sub'));
  const want = { mainPath: dir, mainName: path.basename(dir), title: `${path.basename(dir)} · feat-wt` };
  for (const from of [wt, path.join(wt, 'sub')]) {
    const info = await ops.openRepo(from);
    assert.deepEqual([info.root, info.name, info.bare, info.head.branch], [wt, 'feat-wt', false, 'feat'], from);
    assert.deepEqual(info.linkedWorktree, want, from);
  }
  assert.deepEqual((await ops.summary(wt)).linkedWorktree, want, 'app:getState\'s fresh summary agrees');
  // The main worktree (with a linked one), a plain repo and a bare repo are not linked worktrees.
  assert.equal((await ops.openRepo(dir)).linkedWorktree, null);
  assert.equal((await ops.openRepo(h.initRepo())).linkedWorktree, null);
  assert.equal((await ops.openRepo(h.initRepo({ bare: true }))).linkedWorktree, null);
  // The bare + worktrees layout: the main "worktree" is the bare git dir; the project is its parent folder.
  const { top, bare, wt: bareWt } = h.bareWithWorktree();
  assert.deepEqual((await ops.openRepo(bareWt)).linkedWorktree,
    { mainPath: bare, mainName: path.basename(top), title: `${path.basename(top)} · ${path.basename(bareWt)}` });
  assert.equal((await ops.openRepo(top)).linkedWorktree, null, 'the bare repo itself');
});

test('linkedWorktree: a submodule is not linked; a linked worktree of a submodule names the submodule\'s folder (core.worktree), not .git/modules', async () => {
  const lib = h.initRepo();
  const sup = h.initRepo();
  h.git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub');
  const sub = path.join(sup, 'sub');
  assert.equal(fs.lstatSync(path.join(sub, '.git')).isFile(), true, 'a submodule has a .git file, as a linked worktree does');
  assert.equal((await ops.openRepo(sub)).linkedWorktree, null, 'its git dir is its common dir');
  const wt = path.join(h.tmpDir(), 'sub-feat');
  h.git(sub, 'worktree', 'add', '-q', '-b', 'feat', wt);
  // git's own list says .git/modules/sub: the reason core.worktree is read.
  assert.match(h.git(wt, 'worktree', 'list', '--porcelain').split('\n')[0], /\.git[\\/]modules[\\/]sub$/);
  assert.deepEqual((await ops.openRepo(wt)).linkedWorktree, { mainPath: sub, mainName: 'sub', title: `sub · ${path.basename(wt)}` });
});

test('linkedWorktree: a worktree added from a linked worktree, and one opened through a symlink, belong to the main worktree', async () => {
  const dir = h.initRepo();
  const wt = path.join(h.tmpDir(), 'one');
  h.git(dir, 'worktree', 'add', '-q', '-b', 'one', wt);
  const wt2 = path.join(h.tmpDir(), 'two');
  h.git(wt, 'worktree', 'add', '-q', '-b', 'two', wt2);
  const want = (w) => ({ mainPath: dir, mainName: path.basename(dir), title: `${path.basename(dir)} · ${path.basename(w)}` });
  assert.deepEqual((await ops.openRepo(wt2)).linkedWorktree, want(wt2), 'a worktree of a worktree');
  const link = path.join(h.tmpDir(), 'link');
  fs.symlinkSync(wt, link);
  const info = await ops.openRepo(link);
  assert.equal(info.root, wt, 'git resolves the symlink to the real root');
  assert.deepEqual(info.linkedWorktree, want(wt));
});

test('linkedWorktree: a failed `worktree list` (an error, a timeout or a cancellation) never fails the open: git\'s guess, the common dir', async (t) => {
  const x = require('../src/exec');
  const { linkedWorktreeOf } = require('../src/repo-open');
  // The bare + worktrees layout is the one case that needs the list (no .git folder, no core.worktree).
  const { top, bare, wt } = h.bareWithWorktree();
  const want = { mainPath: bare, mainName: path.basename(top), title: `${path.basename(top)} · ${path.basename(wt)}` };
  const realGit = require('node:child_process').execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const marker = path.join(h.tmpDir(), 'listing');
  const fake = (onList) => {
    const bin = path.join(h.tmpDir(), 'git');
    fs.writeFileSync(bin, `#!/bin/sh\ncase " $* " in *" worktree list "*) ${onList} ;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    x.setGitBinary(bin);
  };
  t.after(() => x.setGitBinary(null));
  fake(`touch '${marker}'; echo boom >&2; exit 1`);
  const info = await ops.openRepo(wt);
  assert.deepEqual([info.root, info.head.branch, info.linkedWorktree], [wt, 'main', want], 'git failing');
  assert.equal(fs.existsSync(marker), true, 'the list was asked');
  fs.rmSync(marker);
  // A hung list (a worktree on a dead network volume): cancelled, a GitError with a kind, as a timeout is.
  fake(`touch '${marker}'; exec sleep 30`);
  const ac = new AbortController();
  const lookup = x.withSignal(ac.signal, () => linkedWorktreeOf(wt));
  await waitForFile(marker, 'worktree list');
  ac.abort();
  assert.deepEqual(await lookup, want, 'cancelled');
});

test('openRepo passes other git failures through: dubious ownership -> unsafe-repo with git message', async (t) => {
  const git = require('../src/git');
  const dir = h.tmpDir();
  const msg = `fatal: detected dubious ownership in repository at '${dir}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${dir}`;
  const orig = git.root;
  t.after(() => { git.root = orig; });
  git.root = async () => { throw new GitError(['rev-parse', '--show-toplevel'], 128, msg, ''); };
  await assert.rejects(ops.openRepo(dir), (e) => e.kind === 'unsafe-repo' && /safe\.directory/.test(e.message));
  git.root = async () => { throw new GitError(['rev-parse', '--show-toplevel'], 128, 'fatal: unable to read index', ''); };
  await assert.rejects(ops.openRepo(dir), (e) => e instanceof GitError && e.kind === undefined && /unable to read/.test(e.message));
  git.root = async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); };
  await assert.rejects(ops.openRepo(dir), (e) => e.code === 'ENOENT' && e.kind === undefined);
});

test('remote args must name a configured remote: URLs and paths are refused', async () => {
  const { local } = h.repoWithRemote();
  const other = h.initRepo();
  const otherRefs = h.git(other, 'for-each-ref').trim();
  const tagSource = h.initRepo();
  h.git(tagSource, 'tag', 'evil');
  h.git(local, 'checkout', '-q', '-b', 'feat');
  const runner = ops.createRunner();
  const bad = [
    ['push', [{ remote: other }]], ['push', [{ remote: `file://${other}` }]], ['push', [{ remote: '-o' }]],
    ['push', [{ remote: 'nope' }]], ['fetch', [{ remote: tagSource }]], ['fetch', [{ remote: 'https://example.invalid/x.git' }]],
    ['setUpstream', ['feat', other, 'feat']], ['setUpstream', ['feat', 'nope', 'feat']],
  ];
  for (const [op, args] of bad) {
    await assert.rejects(runner.run(local, op, args), { kind: 'invalid-args' }, `${op} ${JSON.stringify(args)}`);
  }
  assert.equal(h.git(other, 'for-each-ref').trim(), otherRefs);
  assert.equal(h.git(local, 'tag', '-l').trim(), '');
  assert.equal(h.git(local, 'for-each-ref', 'refs/remotes/nope').trim(), ''); // no stray tracking ref
  // the configured remote still works
  await runner.run(local, 'fetch', [{ remote: 'origin' }]);
  await runner.run(local, 'setUpstream', ['feat', 'origin', 'feat']);
  assert.equal(h.git(local, 'rev-parse', '--abbrev-ref', 'feat@{upstream}').trim(), 'origin/feat');
});

test('push refuses wildcard / colon / force refspec branch names and unknown branches', async () => {
  const { local, remote } = h.repoWithRemote();
  h.git(local, 'branch', 'side');
  h.git(local, 'branch', 'a+b');
  const before = h.git(remote, 'for-each-ref').trim();
  const runner = ops.createRunner();
  const bad = [
    { branch: '*' }, { branch: 'refs/heads/*' }, { branch: 'main:side' }, { branch: '+main' },
    { branch: 'nope' }, { branch: '-f' }, { branch: 'main^' }, { branch: 'main~1' }, { branch: 'ma?n' },
    { branch: 'm[a]in' }, { branch: 'ma\\in' }, { branch: '@{-1}' }, { branch: 'HEAD' },
    { remoteBranch: '*' }, { remoteBranch: 'x:y' }, { remoteBranch: '+x' }, { remoteBranch: '-x' },
    { remoteBranch: 'a b' }, { remoteBranch: 'a..b' },
    { branch: '*', force: true },
  ];
  for (const o of bad) {
    await assert.rejects(runner.run(local, 'push', [o]), { kind: 'invalid-args' }, JSON.stringify(o));
  }
  assert.equal(h.git(remote, 'for-each-ref').trim(), before);
  // the git layer refuses them too (defence in depth)
  const g = require('../src/git');
  await assert.rejects(g.push(local, { remote: 'origin', branch: '*' }), { kind: 'invalid-args' });
  await assert.rejects(g.push(local, { remote: 'origin', remoteBranch: 'a:b' }), { kind: 'invalid-args' });
  // a '+' inside a name is legal git and not a force marker
  await runner.run(local, 'push', [{ remote: 'origin', branch: 'a+b' }]);
  assert.match(h.git(remote, 'for-each-ref', 'refs/heads/a+b'), /refs\/heads\/a\+b/);
  const res = await runner.run(local, 'push', [{ remote: 'origin', branch: 'side', remoteBranch: 'side2' }]);
  assert.deepEqual(res, { remote: 'origin', branch: 'side', remoteBranch: 'side2', forced: false });
  assert.deepEqual(h.git(remote, 'for-each-ref', '--format=%(refname)').trim().split('\n'), ['refs/heads/a+b', 'refs/heads/main', 'refs/heads/side2']);
});

test('branch-name validation for createBranch, deleteBranch, checkout and setUpstream', async () => {
  const { local } = h.repoWithRemote();
  const head = h.git(local, 'rev-parse', 'HEAD').trim();
  h.git(local, 'branch', 'keep');
  const runner = ops.createRunner();
  const bad = [
    ['createBranch', ['a:b']], ['createBranch', ['x*']], ['createBranch', ['@{-1}']], ['createBranch', ['HEAD']],
    ['createBranch', ['a..b']], ['createBranch', ['ok', { start: 'nope' }]], ['createBranch', ['ok', { start: '--orphan' }]],
    ['deleteBranch', ['k*']], ['deleteBranch', ['@{-1}']],
    ['checkout', ['nope']], ['checkout', ['origin/main']], ['checkout', ['*']],
    ['checkout', ['main', { kind: 'remote' }]], ['checkout', ['origin/nope', { kind: 'remote' }]],
    ['checkout', ['origin/main@{1}', { kind: 'remote' }]], ['checkout', ['../heads/main', { kind: 'remote' }]],
    ['checkout', ['HEAD', { kind: 'commit' }]], ['checkout', ['a'.repeat(40), { kind: 'commit' }]],
    ['checkout', ['main', { kind: 'nope' }]],
    ['setUpstream', ['nope', 'origin', 'x']], ['setUpstream', ['keep', 'origin', 'x:y']], ['setUpstream', ['k*', 'origin', 'x']],
  ];
  for (const [op, args] of bad) {
    await assert.rejects(runner.run(local, op, args), { kind: 'invalid-args' }, `${op} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(h.git(local, 'for-each-ref', '--format=%(refname)', 'refs/heads').trim().split('\n'), ['refs/heads/keep', 'refs/heads/main']);
  // valid forms still work; start accepts any revision naming a commit
  assert.equal((await runner.run(local, 'createBranch', ['ok', { start: 'origin/main' }])).sha, head);
  assert.equal((await runner.run(local, 'checkout', [head, { kind: 'commit' }])).branch, null);
  assert.equal((await runner.run(local, 'checkout', ['origin/main', { kind: 'remote' }])).branch, 'main');
  assert.equal((await runner.run(local, 'checkout', ['keep'])).branch, 'keep');
  await runner.run(local, 'deleteBranch', ['ok']);
});

test('pull mode is whitelisted: prototype keys never reach git', async () => {
  const dir = h.initRepo();
  h.write(dir, 'README.md', 'wip\n');
  const runner = ops.createRunner();
  for (const mode of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'merge', 42]) {
    await assert.rejects(runner.run(dir, 'pull', [{ mode }]), { kind: 'invalid-args' }, String(mode));
  }
  assert.equal(h.git(dir, 'stash', 'list').trim(), '');
  assert.equal(h.read(dir, 'README.md'), 'wip\n');
  const g = require('../src/git');
  await assert.rejects(g.pull(dir, { mode: 'constructor' }), /Unknown pull mode/);
  assert.equal(h.git(dir, 'stash', 'list').trim(), '');
});

test('untracked diffs refuse paths through symlinked folders (outside dir, .git)', async () => {
  const dir = h.initRepo();
  const outside = h.tmpDir();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
  fs.symlinkSync(outside, path.join(dir, 'lnk'));
  fs.symlinkSync('.git', path.join(dir, 'g'));
  h.write(dir, 'sub/new.txt', 'new\n');
  const runner = ops.createRunner();
  for (const file of ['lnk/secret.txt', 'g/config', 'g/HEAD', 'sub', 'README.md', 'missing.txt']) {
    await assert.rejects(runner.run(dir, 'diffWorkdir', [file, { untracked: true }]), { kind: 'invalid-args' }, file);
  }
  assert.match(await runner.run(dir, 'diffWorkdir', ['sub/new.txt', { untracked: true }]), /\+new/);
  // an untracked symlink to a file diffs as the link text, never the target's content
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'f'));
  const link = await runner.run(dir, 'diffWorkdir', ['f', { untracked: true }]);
  assert.match(link, /new file mode 120000/);
  assert.doesNotMatch(link, /top secret/);
  assert.doesNotMatch(await runner.run(dir, 'diffWorkdir', ['lnk', { untracked: true }]), /top secret/);
});

test('relPath refuses NTFS / 8.3 aliases of .git; colons only on Windows', async () => {
  for (const p of ['.git./config', '.git /config', '.GIT..', 'a/.git. ./x', 'GIT~1/config', 'git~12', '.git::$INDEX_ALLOCATION/config',
    '.git:x/config', 'a/GIT~1:$DATA/x', 'x::$DATA']) {
    assert.throws(() => ops.relPath(p), { kind: 'invalid-args' }, p);
  }
  for (const p of ['.gitignore', 'a/.github/x', 'git~x', '.gitx', 'dir.git/x']) assert.equal(ops.relPath(p), p);
  // ':' is an ordinary file name character on macOS / Linux
  for (const p of ['a:b', 'x/c:y', 'notes 10:30.txt']) {
    if (process.platform === 'win32') assert.throws(() => ops.relPath(p), { kind: 'invalid-args' }, p);
    else assert.equal(ops.relPath(p), p);
  }
});

test("relPath refuses empty and '.' segments and a trailing slash (non-canonical spellings)", () => {
  for (const p of ['a/./b', './a', 'a/.', 'a//b', 'a/', '/', '.', 'a\\.\\b']) {
    assert.throws(() => ops.relPath(p), { kind: 'invalid-args' }, p);
  }
  for (const p of ['a/b', '.a', 'a/..b', 'a/b.']) assert.equal(ops.relPath(p), p);
});

test('a file with a colon in its name can be staged (macOS / Linux)', { skip: process.platform === 'win32' }, async () => {
  const dir = h.initRepo();
  h.write(dir, 'a:b.txt', 'x\n');
  await ops.createRunner().run(dir, 'stage', [['a:b.txt']]);
  assert.equal(h.git(dir, 'diff', '--cached', '--name-only').trim(), 'a:b.txt');
});

test('hunk ops on a non-canonical spelling of a tracked file are refused before git runs', async () => {
  const dir = h.initRepo();
  h.commitFile(dir, 'a/b.txt', 'one\n');
  h.write(dir, 'a/b.txt', 'one\nmine\n');
  const runner = ops.createRunner();
  for (const file of ['a/./b.txt', 'a//b.txt']) {
    for (const name of ['stageSelection', 'unstageSelection', 'discardSelection']) {
      await assert.rejects(runner.run(dir, name, [file, [{ hunk: 0 }], { fingerprint: 'f' }]), { kind: 'invalid-args' }, `${name} ${file}`);
    }
  }
  assert.equal(h.read(dir, 'a/b.txt'), 'one\nmine\n');
});

test('cancel kills a write stuck in a hook; the next queued write then runs', async () => {
  const dir = h.initRepo();
  const marker = path.join(h.tmpDir(), 'hook-started');
  // The marker holds the hook's pid (sleep keeps it: exec, so no fork after the marker, see
  // slowRemoteRepo); mv makes it appear with its content.
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho $$ > '${marker}.tmp'\nmv '${marker}.tmp' '${marker}'\nexec sleep 30\n`, { mode: 0o755 });
  h.write(dir, 'x.txt', 'x\n');
  h.git(dir, 'add', 'x.txt');
  const runner = ops.createRunner();
  const events = [];
  runner.on('changed', (e) => events.push(e));
  const p = runner.run(dir, 'commit', ['msg'], { opId: 'c1' });
  const next = runner.run(dir, 'stage', [['README.md']], { opId: 's1' });
  // Cancel only once the hook runs: a cancel during commit's check (git status) stops it before
  // it starts, which emits no events at all (see 'a write cancelled during its check ...').
  await waitForFile(marker, 'the pre-commit hook');
  const cancelledAt = Date.now();
  assert.equal(runner.cancel('c1'), true);
  assert.equal(runner.cancel('c1'), false); // already cancelled
  await assert.rejects(p, { kind: 'aborted' });
  await next;
  assert.ok(Date.now() - cancelledAt < 10000, 'hook was killed, not waited for');
  assert.equal(runner.cancel('s1'), false);
  assert.equal(runner.cancel('never'), false);
  assert.equal(h.git(dir, 'log', '--format=%s').trim(), 'initial');
  assert.deepEqual(events, [{ repo: dir, op: 'commit', ok: false }, { repo: dir, op: 'stage', ok: true }]);
  // no hook process left behind (the group kill has reached it by now, or very soon)
  const hookPid = Number(fs.readFileSync(marker, 'utf8'));
  assert.ok(hookPid > 0);
  const alive = () => { try { process.kill(hookPid, 0); return true; } catch { return false; } };
  for (const t0 = Date.now(); alive(); await new Promise((r) => setTimeout(r, 20))) {
    assert.ok(Date.now() - t0 < 5000, 'the hook outlived the cancel');
  }
});

test('a write cancelled while queued emits no busy/changed events', async () => {
  const gate = deferred();
  const fakeOps = { hold: () => gate.promise, later: async () => 'x' };
  const runner = ops.createRunner({ ops: fakeOps, writeOps: new Set(['hold', 'later']), remoteOps: new Set() });
  const events = [];
  runner.on('busy', (e) => events.push(['busy', e.op, e.running]));
  runner.on('changed', (e) => events.push(['changed', e.op, e.ok]));
  const p1 = runner.run('/r', 'hold');
  const p2 = runner.run('/r', 'later', [], { opId: 'q' });
  assert.equal(runner.cancel('q'), true);
  gate.resolve();
  await p1;
  await assert.rejects(p2, { kind: 'aborted' });
  assert.deepEqual(events, [['busy', 'hold', true], ['busy', 'hold', false], ['changed', 'hold', true]]);
});

test('a write cancelled during its check never starts: rejects aborted, no busy/changed events', async () => {
  const checking = deferred();
  const release = deferred();
  let acted = false;
  const w = Object.assign(() => {}, {
    check: async () => { checking.resolve(); await release.promise; return ['x']; },
    act: async () => { acted = true; },
  });
  const runner = ops.createRunner({ ops: { w, later: async () => 'l' }, writeOps: new Set(['w', 'later']) });
  const events = [];
  runner.on('busy', (e) => events.push(['busy', e.op, e.running]));
  runner.on('changed', (e) => events.push(['changed', e.op, e.ok]));
  const p = runner.run('/r', 'w', [], { opId: 'w1' });
  const next = runner.run('/r', 'later');
  await checking.promise;
  assert.equal(runner.cancel('w1'), true);
  release.resolve();
  await assert.rejects(p, { kind: 'aborted' });
  assert.equal(await next, 'l');
  assert.equal(acted, false);
  assert.deepEqual(events, [['busy', 'later', true], ['busy', 'later', false], ['changed', 'later', true]]);
});

test('cancelling a discard mid-way never loses changes without an undo entry', async () => {
  const dir = h.initRepo();
  // A smudge filter that hangs makes `git restore` block after it has already removed slow.txt.
  h.commitFile(dir, '.gitattributes', 'slow.txt filter=slow\n');
  h.git(dir, 'config', 'filter.slow.clean', 'cat');
  h.commitFile(dir, 'slow.txt', 'orig\n');
  h.commitFile(dir, 'other.txt', 'o\n');
  const smudging = path.join(h.tmpDir(), 'smudge-started');
  h.git(dir, 'config', 'filter.slow.smudge', `touch '${smudging}'; exec sleep 30`);
  h.write(dir, 'slow.txt', 'mine\n');
  h.write(dir, 'other.txt', 'mine too\n');
  const runner = ops.createRunner();
  const files = [{ path: 'other.txt', status: 'M' }, { path: 'slow.txt', status: 'M' }];
  const p = runner.run(dir, 'discard', [files], { opId: 'd' });
  // Wait until restore is actually blocked in the smudge filter (it removes slow.txt before it
  // runs the filter), not a fixed delay: under a loaded test run the "before" snapshot alone can
  // take longer than that.
  await waitForFile(smudging, 'restore\'s smudge filter');
  assert.ok(!fs.existsSync(path.join(dir, 'slow.txt')));
  const cancelledAt = Date.now();
  assert.equal(runner.cancel('d'), true);
  const err = await p.then(() => null, (e) => e);
  assert.equal(err && err.kind, 'aborted');
  assert.ok(Date.now() - cancelledAt < 10000, 'cancel must kill the hanging filter promptly');
  // half done: other.txt discarded, slow.txt removed by restore before the kill ...
  assert.equal(h.read(dir, 'other.txt'), 'o\n');
  assert.ok(!fs.existsSync(path.join(dir, 'slow.txt')));
  // ... but recorded like any discard, so undo brings both back
  assert.match(err.backup, /^[0-9a-f]{40}$/);
  assert.equal(ops.serializeError(err).backup, err.backup);
  h.git(dir, 'config', '--unset', 'filter.slow.smudge');
  assert.equal((await runner.run(dir, 'undoState')).undo.action, 'discard');
  await runner.run(dir, 'undo');
  assert.equal(h.read(dir, 'slow.txt'), 'mine\n');
  assert.equal(h.read(dir, 'other.txt'), 'mine too\n');
});

test('an aborted discard fn: withDiscardBackup rethrows and writes no reflog entry when nothing changed', async () => {
  const exec = require('../src/exec');
  const undo = require('../src/undo');
  const dir = h.initRepo();
  h.write(dir, 'README.md', 'changed\n');
  const reflog = h.git(dir, 'reflog', '--format=%gs').trim();
  const ctrl = new AbortController();
  await assert.rejects(exec.withSignal(ctrl.signal, () => undo.withDiscardBackup(dir, ['README.md'], async () => {
    ctrl.abort();
    await exec.run(dir, ['restore', '--worktree', '--', 'README.md']);
  })), { kind: 'aborted' });
  assert.equal(h.read(dir, 'README.md'), 'changed\n');
  assert.equal(h.git(dir, 'reflog', '--format=%gs').trim(), reflog);
});

test('workdirDiffView / commitDiffView return decoded, display-ready hunks with a usable fingerprint', async () => {
  const dir = h.initRepo();
  const fsx = require('node:fs');
  const p = require('node:path');
  fsx.writeFileSync(p.join(dir, 'l1.txt'), Buffer.from('caf\xe9\r\nb\n', 'latin1'));
  h.write(dir, 'u.txt', 'héllo\n');
  h.git(dir, 'add', '.');
  h.git(dir, 'commit', '-q', '-m', 'two');
  const sha = h.git(dir, 'rev-parse', 'HEAD').trim();
  fsx.writeFileSync(p.join(dir, 'l1.txt'), Buffer.from('caf\xe9 2\r\nb\n', 'latin1'));
  const runner = ops.createRunner();
  const v = await runner.run(dir, 'workdirDiffView', ['l1.txt']);
  const texts = v.file.hunks[0].lines.map((l) => [l.type, l.text, l.cr]);
  assert.deepEqual(texts[0], ['del', 'café', true]); // latin1 decoded, CR stripped + flagged
  assert.deepEqual(texts[1], ['add', 'café 2', true]);
  assert.equal(typeof v.fingerprint, 'string');
  assert.equal(v.truncated, false);
  assert.equal(v.sections.length, 1);
  assert.equal(v.file, v.sections[0]);
  assert.equal(v.conflict, null);
  assert.equal(v.maxLines, 20000);
  assert.equal(v.maxLineChars, 10000);
  assert.equal(v.file.hunks[0].truncated, undefined);
  // the fingerprint is accepted by the staging op
  await runner.run(dir, 'stageSelection', ['l1.txt', [{ hunk: 0 }], { fingerprint: v.fingerprint }]);
  const c = await runner.run(dir, 'commitDiffView', [sha, 'u.txt']);
  assert.equal(c.file.isNew, true);
  assert.equal(c.file.hunks[0].lines[0].text, 'héllo');
  const none = await runner.run(dir, 'workdirDiffView', ['u.txt']);
  assert.deepEqual(none, { file: null, sections: [], fingerprint: null, conflict: null, truncated: false, maxLines: 20000, maxLineChars: 10000 });
});

test('workdirDiffView on a conflicted file returns the combined diff as `conflict`', async () => {
  const dir = h.initRepo();
  h.commitFile(dir, 'f.txt', 'a\nb\nc\n', 'base');
  h.git(dir, 'checkout', '-q', '-b', 'other');
  h.commitFile(dir, 'f.txt', 'a\nthéirs\r\nc\n', 'theirs');
  h.git(dir, 'checkout', '-q', '-');
  h.commitFile(dir, 'f.txt', 'a\nours\nc\n', 'ours');
  assert.throws(() => h.git(dir, 'merge', '-q', 'other'));
  const runner = ops.createRunner();
  const v = await runner.run(dir, 'workdirDiffView', ['f.txt']);
  assert.equal(v.file, null);
  assert.deepEqual(v.sections, []);
  assert.equal(v.fingerprint, null);
  assert.equal(v.truncated, false);
  assert.equal(v.conflict.path, 'f.txt');
  assert.equal(v.conflict.hunks.length, 1);
  assert.match(v.conflict.hunks[0].header, /^@@@ -1,3 -1,3 \+1,\d+ @@@/);
  const lines = v.conflict.hunks[0].lines.map((l) => [l.prefix, l.text, l.cr]);
  assert.deepEqual(lines[0], ['  ', 'a', false]);
  assert.ok(lines.some(([p, t]) => p === '++' && t.startsWith('<<<<<<<')));
  assert.ok(lines.some(([p, t]) => p === ' +' && t === 'ours'));
  assert.ok(lines.some(([p, t, cr]) => p === '+ ' && t === 'théirs' && cr === true), 'decoded, CR stripped + flagged');
  assert.deepEqual(lines.at(-1), ['  ', 'c', false]);

  // modify/delete: git prints only "* Unmerged path g.txt"
  const d2 = h.initRepo();
  h.commitFile(d2, 'g.txt', 'g\n', 'add g');
  h.git(d2, 'checkout', '-q', '-b', 'other');
  h.git(d2, 'rm', '-q', 'g.txt');
  h.git(d2, 'commit', '-q', '-m', 'rm g');
  h.git(d2, 'checkout', '-q', '-');
  h.commitFile(d2, 'g.txt', 'g2\n', 'edit g');
  assert.throws(() => h.git(d2, 'merge', '-q', 'other'));
  const md = await runner.run(d2, 'workdirDiffView', ['g.txt']);
  assert.deepEqual(md.conflict, { path: 'g.txt', hunks: [] });
  assert.equal(md.fingerprint, null);
});

test('commitDiffView of a typechange (file -> symlink) returns both sections, no fingerprint', async () => {
  const dir = h.initRepo();
  h.commitFile(dir, 't', 'x\n', 'file');
  fs.rmSync(path.join(dir, 't'));
  fs.symlinkSync('README.md', path.join(dir, 't'));
  h.git(dir, 'add', 't');
  h.git(dir, 'commit', '-q', '-m', 'symlink');
  const sha = h.git(dir, 'rev-parse', 'HEAD').trim();
  const v = await ops.createRunner().run(dir, 'commitDiffView', [sha, 't']);
  assert.equal(v.sections.length, 2);
  assert.equal(v.file, v.sections[0]);
  assert.equal(v.sections[0].isDeleted, true);
  assert.equal(v.sections[0].hunks[0].lines[0].text, 'x');
  assert.equal(v.sections[1].isNew, true);
  assert.equal(v.sections[1].newMode, '120000');
  assert.equal(v.sections[1].hunks[0].lines[0].text, 'README.md');
  assert.equal(v.fingerprint, null);
  assert.equal(v.conflict, null);
});

test('diff views of binary files have no fingerprint', async () => {
  const dir = h.initRepo();
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 1, 2, 0, 255]));
  const v = await ops.createRunner().run(dir, 'workdirDiffView', ['b.bin', { untracked: true }]);
  assert.equal(v.sections.length, 1);
  assert.equal(v.file.isBinary, true);
  assert.equal(v.fingerprint, null);
});

test('diff views clip huge lines and cap line count (hunk.truncated)', async () => {
  const dir = h.initRepo();
  const runner = ops.createRunner();
  // one 30 MB line (with a multi-byte char straddling the byte cut point)
  fs.writeFileSync(path.join(dir, 'big.txt'), `${'é'.repeat(20001)}${'x'.repeat(30e6)}\n`);
  const big = await runner.run(dir, 'workdirDiffView', ['big.txt', { untracked: true }]);
  const line = big.file.hunks[0].lines[0];
  assert.equal(line.clipped, true);
  assert.equal(line.text, 'é'.repeat(10000));
  assert.equal(typeof big.fingerprint, 'string'); // display clipping doesn't touch staging
  assert.ok(JSON.stringify(big).length < 100000);

  h.write(dir, 'many.txt', Array.from({ length: 25000 }, (_, i) => `l${i}\n`).join(''));
  const many = await runner.run(dir, 'workdirDiffView', ['many.txt', { untracked: true }]);
  assert.equal(many.truncated, true);
  assert.equal(many.file.hunks[0].truncated, true);
  assert.equal(many.file.hunks[0].lines.length, 20000);
  assert.equal(many.file.hunks[0].newLines, 25000); // header kept as git printed it
  assert.equal(typeof many.fingerprint, 'string');
});

test('diff views cap total display chars and parse at most 50 MB of raw patch', async () => {
  const dir = h.initRepo();
  const runner = ops.createRunner();
  // 1000 lines of 9000 chars = 9M chars > the 5M total cap
  h.write(dir, 'wide.txt', `${'y'.repeat(9000)}\n`.repeat(1000));
  const wide = await runner.run(dir, 'workdirDiffView', ['wide.txt', { untracked: true }]);
  assert.equal(wide.truncated, true);
  const hunk = wide.file.hunks[0];
  assert.equal(hunk.truncated, true);
  assert.ok(hunk.lines.reduce((n, l) => n + l.text.length, 0) <= 5_000_000);
  assert.ok(hunk.lines.length < 1000);
  assert.equal(typeof wide.fingerprint, 'string');

  // > 50 MB of patch: parsed only in part, so no fingerprint
  h.write(dir, 'huge.txt', `${'z'.repeat(1e6)}\n`.repeat(55));
  const huge = await runner.run(dir, 'workdirDiffView', ['huge.txt', { untracked: true }]);
  assert.equal(huge.truncated, true);
  assert.equal(huge.fingerprint, null);
  assert.equal(huge.file.hunks[0].truncated, true);
  assert.ok(huge.file.hunks[0].lines.every((l) => l.clipped && l.text.length === 10000));
});

// ---------------------------------------------------------------- milestone 4: write ops for the UI

const hook = (dir, name, body) => fs.writeFileSync(path.join(dir, '.git', 'hooks', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

test('lastCommitMessage: {message, sha} of HEAD, null in an unborn repo', async () => {
  const runner = ops.createRunner();
  const unborn = h.initRepo({ commits: false });
  assert.equal(await runner.run(unborn, 'lastCommitMessage'), null);
  const dir = h.initRepo();
  h.write(dir, 'a.txt', 'a\n');
  h.git(dir, 'add', 'a.txt');
  h.git(dir, 'commit', '-q', '-m', 'Subject line\n\nBody # kept\n');
  assert.deepEqual(await runner.run(dir, 'lastCommitMessage'), {
    message: 'Subject line\n\nBody # kept', sha: h.git(dir, 'rev-parse', 'HEAD').trim(),
  });
});

test('commit and commitAll return {sha, summary}; commitAll stages everything in the same write', async () => {
  const dir = h.initRepo();
  h.commitFile(dir, 'gone.txt', 'g\n');
  const runner = ops.createRunner();
  h.write(dir, 'x.txt', 'x\n');
  await runner.run(dir, 'stage', [['x.txt']]);
  const c = await runner.run(dir, 'commit', ['Add x\n\nbody']);
  assert.deepEqual(c, { sha: h.git(dir, 'rev-parse', 'HEAD').trim(), summary: 'Add x' });

  h.write(dir, 'README.md', 'changed\n');
  h.write(dir, 'new dir/n.txt', 'n\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  // Enqueued back to back, not awaited: the commit queued after commitAll finds nothing left.
  const all = runner.run(dir, 'commitAll', ['Everything']);
  const after = runner.run(dir, 'commit', ['late']);
  const res = await all;
  await assert.rejects(after, { kind: 'nothing-to-commit' });
  assert.deepEqual(res, { sha: h.git(dir, 'rev-parse', 'HEAD').trim(), summary: 'Everything' });
  assert.deepEqual(h.git(dir, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n').sort(),
    ['D\tgone.txt', 'M\tREADME.md', 'A\tnew dir/n.txt'].sort());
  const st = await runner.run(dir, 'status');
  assert.deepEqual([st.staged, st.unstaged], [[], []]);

  // amend through commitAll: folds new changes into HEAD
  const parent = h.git(dir, 'rev-parse', 'HEAD~1').trim();
  h.write(dir, 'late.txt', 'l\n');
  const am = await runner.run(dir, 'commitAll', ['Everything, amended', { amend: true }]);
  assert.equal(h.git(dir, 'rev-parse', 'HEAD~1').trim(), parent);
  assert.equal(am.summary, 'Everything, amended');
  assert.match(h.git(dir, 'show', '--name-only', '--format=', 'HEAD'), /late\.txt/);

  // validated like commit
  for (const args of [[42], [''], [' \n\t'], ['m', 'nope']]) {
    await assert.rejects(runner.run(dir, 'commitAll', args), (e) => ['invalid-args', 'empty-message'].includes(e.kind), JSON.stringify(args));
  }
  await assert.rejects(runner.run(dir, 'commitAll', ['nothing here']), { kind: 'nothing-to-commit' });
});

test("commit error kinds: nothing-to-commit (also unborn), empty-message; amend with nothing staged is fine", async () => {
  const runner = ops.createRunner();
  const dir = h.initRepo();
  h.write(dir, 'README.md', 'unstaged only\n');
  h.write(dir, 'untracked.txt', 'u\n');
  const e = await runner.run(dir, 'commit', ['m']).catch((x) => x);
  assert.equal(e.kind, 'nothing-to-commit');
  assert.equal(ops.serializeError(e).message, 'Nothing to commit: no changes are staged');
  await assert.rejects(runner.run(h.initRepo({ commits: false }), 'commit', ['first']), { kind: 'nothing-to-commit' });
  await assert.rejects(runner.run(dir, 'commit', ['\n  \n']), { kind: 'empty-message' });
  const am = await runner.run(dir, 'commit', ['reworded', { amend: true }]);
  assert.equal(am.summary, 'reworded');
  assert.equal(h.git(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
});

test('commit error kind hook-failed: pre-commit / commit-msg output in the message, capped at ~4k chars', async () => {
  const git = require('../src/git');
  const runner = ops.createRunner();
  const dir = h.initRepo();
  h.write(dir, 'x.txt', 'x\n');
  h.git(dir, 'add', 'x.txt');
  hook(dir, 'pre-commit', 'echo "lint: 2 problems"\necho "x.txt:1 bad" >&2\nexit 1');
  const e = await runner.run(dir, 'commit', ['m']).catch((x) => x);
  assert.equal(e.kind, 'hook-failed');
  assert.equal(ops.serializeError(e).message, 'lint: 2 problems\nx.txt:1 bad');
  assert.equal(ops.serializeError(e).kind, 'hook-failed');
  // commitAll too (it staged first: the changes stay staged)
  h.write(dir, 'y.txt', 'y\n');
  await assert.rejects(runner.run(dir, 'commitAll', ['m']), { kind: 'hook-failed' });
  assert.deepEqual((await runner.run(dir, 'status')).staged.map((f) => f.path).sort(), ['x.txt', 'y.txt']);

  // long output keeps the tail, ~4k chars
  hook(dir, 'pre-commit', `i=0; while [ $i -lt 1000 ]; do echo "problem number $i"; i=$((i+1)); done; exit 2`);
  const long = await runner.run(dir, 'commit', ['m']).catch((x) => x);
  assert.equal(long.kind, 'hook-failed');
  assert.ok(long.message.length <= git.HOOK_OUTPUT_MAX + 2, String(long.message.length));
  assert.ok(long.message.startsWith('…\nproblem number '));
  assert.ok(long.message.endsWith('problem number 999'));

  // commit-msg hook; a silent failing hook still gets a message
  fs.rmSync(path.join(dir, '.git', 'hooks', 'pre-commit'));
  hook(dir, 'commit-msg', 'exit 1');
  const cm = await runner.run(dir, 'commit', ['m']).catch((x) => x);
  assert.equal(cm.kind, 'hook-failed');
  assert.match(cm.message, /hook failed/);
  // a hook that passes changes nothing; core.hooksPath is honoured
  fs.rmSync(path.join(dir, '.git', 'hooks', 'commit-msg'));
  const hooks = h.tmpDir();
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho nope\nexit 1\n', { mode: 0o755 });
  h.git(dir, 'config', 'core.hooksPath', hooks);
  await assert.rejects(runner.run(dir, 'commit', ['m']), { kind: 'hook-failed', message: 'nope' });
  h.git(dir, 'config', '--unset', 'core.hooksPath');
  assert.equal((await runner.run(dir, 'commit', ['ok'])).summary, 'ok');
});

test("error kinds: stale (fingerprint), conflict (hunks on unmerged paths), conflicts (commit), busy (undo mid-merge)", async () => {
  const runner = ops.createRunner();
  const dir = h.initRepo();
  h.commitFile(dir, 'f.txt', 'a\nb\nc\n', 'base');
  h.write(dir, 'f.txt', 'a\nB\nc\n');
  const v = await runner.run(dir, 'workdirDiffView', ['f.txt']);
  h.write(dir, 'f.txt', 'a\nBB\nc\n');
  for (const name of ['stageSelection', 'discardSelection']) {
    await assert.rejects(runner.run(dir, name, ['f.txt', [{ hunk: 0 }], { fingerprint: v.fingerprint }]), { kind: 'stale' }, name);
  }
  assert.equal(h.read(dir, 'f.txt'), 'a\nBB\nc\n');
  h.git(dir, 'checkout', '--', 'f.txt');

  h.git(dir, 'checkout', '-q', '-b', 'other');
  h.commitFile(dir, 'f.txt', 'a\ntheirs\nc\n', 'theirs');
  h.git(dir, 'checkout', '-q', 'main');
  h.commitFile(dir, 'f.txt', 'a\nours\nc\n', 'ours');
  assert.throws(() => h.git(dir, 'merge', '-q', 'other'));
  for (const name of ['stageSelection', 'unstageSelection', 'discardSelection']) {
    await assert.rejects(runner.run(dir, name, ['f.txt', [{ hunk: 0 }], { fingerprint: v.fingerprint }]), { kind: 'conflict' }, name);
  }
  await assert.rejects(runner.run(dir, 'commit', ['m']), { kind: 'conflicts' }); // commit / commitAll: plural, like pull
  await assert.rejects(runner.run(dir, 'undo'), { kind: 'busy' });
});

test('staged rename: workdirDiffView with orig shows one rename section, no fingerprint', async () => {
  const dir = h.initRepo();
  h.hostileConfig(dir); // diff.renames=false must not matter
  const body = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');
  h.commitFile(dir, 'old name.txt', body);
  h.git(dir, 'mv', 'old name.txt', 'new name.txt');
  h.write(dir, 'new name.txt', body.replace('line 3\n', 'LINE 3\n'));
  h.git(dir, 'add', 'new name.txt');
  const runner = ops.createRunner();
  const st = await runner.run(dir, 'status');
  assert.deepEqual(st.staged, [{ path: 'new name.txt', status: 'R', orig: 'old name.txt' }]);
  const { path: file, orig } = st.staged[0];

  const v = await runner.run(dir, 'workdirDiffView', [file, { staged: true, orig }]);
  assert.equal(v.sections.length, 1);
  assert.equal(v.file.isRename, true);
  assert.equal(v.file.isNew, false);
  assert.equal(v.file.oldPath, 'old name.txt');
  assert.equal(v.file.newPath, 'new name.txt');
  assert.deepEqual(v.file.hunks[0].lines.filter((l) => l.type !== 'context').map((l) => [l.type, l.text]),
    [['del', 'line 3'], ['add', 'LINE 3']]);
  assert.equal(v.fingerprint, null); // line-level unstaging of renames is out of scope
  assert.match(await runner.run(dir, 'diffWorkdir', [file, { staged: true, orig }]), /^rename from old name\.txt$/m);

  // without orig: the old behaviour (a whole new file, with a usable fingerprint)
  const plain = await runner.run(dir, 'workdirDiffView', [file, { staged: true }]);
  assert.equal(plain.file.isNew, true);
  assert.equal(typeof plain.fingerprint, 'string');
  // orig === file is the same as no orig
  assert.equal((await runner.run(dir, 'workdirDiffView', [file, { staged: true, orig: file }])).fingerprint, null);

  // orig is validated; untracked files have no rename source
  for (const o of [{ staged: true, orig: '../x' }, { staged: true, orig: '.git/config' }, { staged: true, orig: 7 }, { untracked: true, orig }]) {
    await assert.rejects(runner.run(dir, 'workdirDiffView', [file, o]), { kind: 'invalid-args' }, JSON.stringify(o));
  }

  // pure rename (no content change): a rename section without hunks
  h.git(dir, 'mv', 'README.md', 'docs.md');
  const pure = await runner.run(dir, 'workdirDiffView', ['docs.md', { staged: true, orig: 'README.md' }]);
  assert.equal(pure.sections.length, 1);
  assert.deepEqual([pure.file.isRename, pure.file.oldPath, pure.file.newPath, pure.file.hunks.length], [true, 'README.md', 'docs.md', 0]);

  // file-level unstage of a rename takes both paths
  await runner.run(dir, 'unstage', [[orig, file]]);
  const after = await runner.run(dir, 'status');
  assert.deepEqual(after.staged.map((f) => f.path), ['docs.md']);
  assert.deepEqual(after.unstaged.map((f) => [f.path, f.status]).sort(), [['new name.txt', '?'], ['old name.txt', 'D']]);
});

test('unstaged rename (intent-to-add): status carries orig; the orig view is a rename section', async () => {
  const dir = h.initRepo();
  const body = Array.from({ length: 20 }, (_, i) => `${i}\n`).join('');
  h.commitFile(dir, 'a.txt', body);
  fs.renameSync(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'));
  h.git(dir, 'add', '-N', 'b.txt');
  const runner = ops.createRunner();
  const st = await runner.run(dir, 'status');
  assert.deepEqual(st.unstaged, [{ path: 'b.txt', status: 'R', orig: 'a.txt' }]);
  const v = await runner.run(dir, 'workdirDiffView', ['b.txt', { orig: 'a.txt' }]);
  assert.equal(v.sections.length, 1);
  assert.deepEqual([v.file.isRename, v.file.oldPath, v.file.newPath], [true, 'a.txt', 'b.txt']);
  assert.equal(v.fingerprint, null);
});

test('hunk actions refuse selections past what the capped view showed (hunk is truncated in the view)', async () => {
  const runner = ops.createRunner();
  const truncated = { kind: 'invalid-args', message: 'hunk is truncated in the view' };
  const dir = h.initRepo();
  // hunk 0: small; hunk 1: 2 x 21000 changed lines (cut by the 20k line cap); hunk 2: never shown
  const base = Array.from({ length: 30000 }, (_, i) => `l${i}\n`);
  h.commitFile(dir, 'big.txt', base.join(''));
  const edited = base.map((l, i) => (i === 1 || (i >= 100 && i < 21100) || i === 29990 ? `X${l}` : l));
  h.write(dir, 'big.txt', edited.join(''));
  const v = await runner.run(dir, 'workdirDiffView', ['big.txt']);
  assert.equal(v.file.hunks.length, 2);
  assert.equal(v.file.hunks[1].truncated, true);
  const shown1 = v.file.hunks[1].lines.length;
  const fp = { fingerprint: v.fingerprint };

  for (const sel of [[{ hunk: 1 }], [{ hunk: 2 }], [{ hunk: 2, lines: [0] }], [{ hunk: 1, lines: [0, shown1] }], [{ hunk: 0 }, { hunk: 1 }]]) {
    for (const name of ['stageSelection', 'discardSelection']) {
      await assert.rejects(runner.run(dir, name, ['big.txt', sel, fp]), truncated, `${name} ${JSON.stringify(sel)}`);
    }
  }
  assert.equal(h.read(dir, 'big.txt'), edited.join('')); // nothing discarded
  assert.equal(h.git(dir, 'diff', '--cached', '--name-only').trim(), ''); // nothing staged
  // indices that don't exist at all stay 'stale'
  await assert.rejects(runner.run(dir, 'stageSelection', ['big.txt', [{ hunk: 9 }], fp]), { kind: 'stale' });
  // what the view showed in full can be acted on: all of hunk 0, lines of hunk 1 it contained
  await runner.run(dir, 'stageSelection', ['big.txt', [{ hunk: 0 }, { hunk: 1, lines: [shown1 - 1] }], fp]);
  const staged = h.git(dir, 'diff', '--cached', '--', 'big.txt');
  assert.match(staged, /^\+Xl1$/m);
  assert.equal((staged.match(/^[+-][^+-]/gm) || []).length, 3); // hunk 0's -/+ pair + one line of hunk 1

  // unstageSelection is guarded the same way (staged diff of the whole file)
  h.git(dir, 'add', 'big.txt');
  const sv = await runner.run(dir, 'workdirDiffView', ['big.txt', { staged: true }]);
  assert.equal(sv.file.hunks[1].truncated, true);
  await assert.rejects(runner.run(dir, 'unstageSelection', ['big.txt', [{ hunk: 1 }], { fingerprint: sv.fingerprint }]), truncated);
  await assert.rejects(runner.run(dir, 'unstageSelection', ['big.txt', [{ hunk: 2 }], { fingerprint: sv.fingerprint }]), truncated);
  await runner.run(dir, 'unstageSelection', ['big.txt', [{ hunk: 0 }], { fingerprint: sv.fingerprint }]);
  assert.doesNotMatch(h.git(dir, 'diff', '--cached', '--', 'big.txt'), /^\+Xl1$/m);
});

test('truncation guard: the total-chars cap truncates too; clipped (over-long) lines stay selectable', async () => {
  const runner = ops.createRunner();
  const dir = h.initRepo();
  // 1000 lines of 9000 chars = 9M chars > the 5M total cap
  h.write(dir, 'wide.txt', `${'y'.repeat(9000)}\n`.repeat(1000));
  const v = await runner.run(dir, 'workdirDiffView', ['wide.txt', { untracked: true }]);
  const shown = v.file.hunks[0].lines.length;
  assert.ok(v.file.hunks[0].truncated && shown < 1000);
  const fp = { fingerprint: v.fingerprint };
  await assert.rejects(runner.run(dir, 'stageSelection', ['wide.txt', [{ hunk: 0 }], fp]), { message: 'hunk is truncated in the view' });
  await assert.rejects(runner.run(dir, 'stageSelection', ['wide.txt', [{ hunk: 0, lines: [shown] }], fp]), { message: 'hunk is truncated in the view' });
  await runner.run(dir, 'stageSelection', ['wide.txt', [{ hunk: 0, lines: [0] }], { fingerprint: v.fingerprint }]);
  assert.equal(h.git(dir, 'show', ':wide.txt'), `${'y'.repeat(9000)}\n`);

  // a single clipped line (12k chars) is shown, flagged clipped: whole-hunk actions allowed
  h.write(dir, 'long.txt', `${'z'.repeat(12000)}\nshort\n`);
  const lv = await runner.run(dir, 'workdirDiffView', ['long.txt', { untracked: true }]);
  assert.equal(lv.file.hunks[0].lines[0].clipped, true);
  assert.equal(lv.truncated, false);
  await runner.run(dir, 'stageSelection', ['long.txt', [{ hunk: 0 }], { fingerprint: lv.fingerprint }]);
  assert.equal(h.git(dir, 'show', ':long.txt'), `${'z'.repeat(12000)}\nshort\n`);
});

test('discard of a file both staged and unstaged drops only the unstaged part (worktree <- index)', async () => {
  const dir = h.initRepo();
  h.commitFile(dir, 'f.txt', 'one\n');
  h.write(dir, 'f.txt', 'two\n');
  h.git(dir, 'add', 'f.txt');
  h.write(dir, 'f.txt', 'three\n');
  h.write(dir, 'n.txt', 'staged new\n');
  h.git(dir, 'add', 'n.txt');
  h.write(dir, 'n.txt', 'staged new, edited\n');
  const runner = ops.createRunner();
  const st = await runner.run(dir, 'status');
  assert.deepEqual(st.staged.map((f) => [f.path, f.status]), [['f.txt', 'M'], ['n.txt', 'A']]);
  assert.deepEqual(st.unstaged.map((f) => [f.path, f.status]), [['f.txt', 'M'], ['n.txt', 'M']]);
  const res = await runner.run(dir, 'discard', [st.unstaged]);
  assert.deepEqual(Object.keys(res), ['backup']);
  assert.equal(h.read(dir, 'f.txt'), 'two\n');
  assert.equal(h.read(dir, 'n.txt'), 'staged new\n');
  const after = await runner.run(dir, 'status');
  assert.deepEqual(after.staged, st.staged); // the index is untouched
  assert.deepEqual(after.unstaged, []);
  await runner.run(dir, 'undo');
  assert.equal(h.read(dir, 'f.txt'), 'three\n');
  assert.equal(h.read(dir, 'n.txt'), 'staged new, edited\n');
  assert.equal(h.git(dir, 'show', ':f.txt'), 'two\n');
});

test('discard all: 200 unstaged entries (modified, deleted, untracked) in one call, undoable', async () => {
  const dir = h.initRepo();
  for (let i = 0; i < 135; i++) h.write(dir, `t/${i % 7} dir/f${i}.txt`, `orig ${i}\n`);
  h.git(dir, 'add', '.');
  h.git(dir, 'commit', '-q', '-m', 'many');
  for (let i = 0; i < 70; i++) h.write(dir, `t/${i % 7} dir/f${i}.txt`, `mod ${i}\n`);
  for (let i = 70; i < 135; i++) fs.rmSync(path.join(dir, `t/${i % 7} dir/f${i}.txt`));
  for (let i = 0; i < 65; i++) h.write(dir, `u/${i % 5}/new ${i}.txt`, `new ${i}\n`);
  const runner = ops.createRunner();
  const st = await runner.run(dir, 'status');
  assert.equal(st.unstaged.length, 200);
  assert.deepEqual([...new Set(st.unstaged.map((f) => f.status))].sort(), ['?', 'D', 'M']);
  const { backup } = await runner.run(dir, 'discard', [st.unstaged]);
  assert.match(backup, /^[0-9a-f]{40}$/);
  const after = await runner.run(dir, 'status');
  assert.deepEqual([after.staged, after.unstaged], [[], []]);
  assert.equal(h.read(dir, 't/3 dir/f80.txt'), 'orig 80\n');
  assert.ok(!fs.existsSync(path.join(dir, 'u/1/new 1.txt')));
  await runner.run(dir, 'undo');
  assert.equal((await runner.run(dir, 'status')).unstaged.length, 200);
  assert.equal(h.read(dir, 't/0 dir/f0.txt'), 'mod 0\n');
  assert.ok(!fs.existsSync(path.join(dir, 't/3 dir/f80.txt')));
  assert.equal(h.read(dir, 'u/4/new 64.txt'), 'new 64\n');
});

test('stage / unstage resolve to nothing; discardSelection to {backup}', async () => {
  const dir = h.initRepo();
  h.write(dir, 'README.md', 'x\n');
  const runner = ops.createRunner();
  assert.equal(await runner.run(dir, 'stage', [['README.md']]), undefined);
  assert.equal(await runner.run(dir, 'unstage', [['README.md']]), undefined);
  const fp = async (o) => ({ fingerprint: (await runner.run(dir, 'workdirDiffView', ['README.md', o])).fingerprint });
  assert.equal(await runner.run(dir, 'stageSelection', ['README.md', [{ hunk: 0 }], await fp()]), undefined);
  assert.equal(await runner.run(dir, 'unstageSelection', ['README.md', [{ hunk: 0 }], await fp({ staged: true })]), undefined);
  const res = await runner.run(dir, 'discardSelection', ['README.md', [{ hunk: 0 }], await fp()]);
  assert.deepEqual(Object.keys(res), ['backup']);
  assert.match(res.backup, /^[0-9a-f]{40}$/);
});

test("commitAll refuses while any path is conflicted (kind 'conflicts'); allowed once resolved mid-merge", async () => {
  const dir = h.initRepo();
  h.commitFile(dir, 'f.txt', 'a\nb\nc\n', 'base');
  h.git(dir, 'checkout', '-q', '-b', 'other');
  h.commitFile(dir, 'f.txt', 'a\ntheirs\nc\n', 'theirs');
  h.git(dir, 'checkout', '-q', 'main');
  h.commitFile(dir, 'f.txt', 'a\nours\nc\n', 'ours');
  assert.throws(() => h.git(dir, 'merge', '-q', 'other'));
  h.write(dir, 'extra.txt', 'e\n');
  const runner = ops.createRunner();
  const events = [];
  runner.on('changed', (e) => events.push(e));
  const head = h.git(dir, 'rev-parse', 'HEAD').trim();
  const err = await runner.run(dir, 'commitAll', ['merge']).catch((e) => e);
  assert.equal(err.kind, 'conflicts');
  assert.match(err.message, /Resolve or mark conflicted files first/);
  assert.deepEqual(ops.serializeError(err).state, 'merging');
  // nothing ran: still unmerged, nothing staged, no events
  const st = await runner.run(dir, 'status');
  assert.deepEqual(st.conflicted.map((f) => f.path), ['f.txt']);
  assert.deepEqual(st.unstaged.map((f) => f.path), ['extra.txt']);
  assert.equal(h.git(dir, 'rev-parse', 'HEAD').trim(), head);
  assert.deepEqual(events, []);
  // resolved (still mid-merge): commitAll concludes the merge
  h.write(dir, 'f.txt', 'a\nboth\nc\n');
  h.git(dir, 'add', 'f.txt');
  const res = await runner.run(dir, 'commitAll', ['Merge other']);
  assert.equal(res.summary, 'Merge other');
  assert.equal(h.git(dir, 'rev-list', '--parents', '-n1', 'HEAD').trim().split(' ').length, 3);
  assert.match(h.git(dir, 'show', '--name-only', '--format=', '-m', '--first-parent', 'HEAD'), /extra\.txt/);
});

test('hunk ops require the fingerprint of the displayed diff (a typechange view has none)', async () => {
  const dir = h.initRepo();
  h.write(dir, 'README.md', 'x\n');
  const runner = ops.createRunner();
  for (const name of ['stageSelection', 'unstageSelection', 'discardSelection']) {
    for (const o of [undefined, {}, { fingerprint: null }, { fingerprint: '' }]) {
      await assert.rejects(runner.run(dir, name, ['README.md', [{ hunk: 0 }], o]), { kind: 'invalid-args' }, `${name} ${JSON.stringify(o)}`);
    }
  }
  assert.equal(h.read(dir, 'README.md'), 'x\n');
  // file -> symlink: two sections, fingerprint null, so line actions are refused up front
  h.commitFile(dir, 't', 'x\n');
  fs.rmSync(path.join(dir, 't'));
  fs.symlinkSync('README.md', path.join(dir, 't'));
  const v = await runner.run(dir, 'workdirDiffView', ['t']);
  assert.equal(v.sections.length, 2);
  assert.equal(v.fingerprint, null);
  await assert.rejects(runner.run(dir, 'stageSelection', ['t', [{ hunk: 0 }], { fingerprint: v.fingerprint }]), { kind: 'invalid-args' });
  // and with any fingerprint, hunks.js refuses the typechange itself
  await assert.rejects(runner.run(dir, 'stageSelection', ['t', [{ hunk: 0 }], { fingerprint: 'x' }]), { kind: 'unsupported' });
  assert.match(h.git(dir, 'ls-files', '-s', 't'), /^100644 /);
});

test("commit {only: true} without amend is refused before git runs", async () => {
  const dir = h.initRepo();
  h.write(dir, 'README.md', 'staged\n');
  h.git(dir, 'add', 'README.md');
  const runner = ops.createRunner();
  const events = [];
  runner.on('changed', (e) => events.push(e));
  await assert.rejects(runner.run(dir, 'commit', ['msg', { only: true }]), { kind: 'invalid-args' });
  assert.deepEqual(events, []);
  assert.equal(h.git(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
  // message-only amend still works
  assert.equal((await runner.run(dir, 'commit', ['reworded', { amend: true, only: true }])).summary, 'reworded');
  assert.equal(h.git(dir, 'diff', '--cached', '--name-only').trim(), 'README.md');
});

test("deleteBranch: kinds current-branch / not-found; an unrecorded delete is reported, not hidden", async (t) => {
  const undo = require('../src/undo');
  const dir = h.initRepo();
  const runner = ops.createRunner();
  const events = [];
  runner.on('changed', (e) => events.push(e));
  await assert.rejects(runner.run(dir, 'deleteBranch', ['main']), { kind: 'current-branch' });
  await assert.rejects(runner.run(dir, 'deleteBranch', ['nope']), { kind: 'not-found' });
  assert.deepEqual(events, []); // refused during validation
  const { sha } = await runner.run(dir, 'createBranch', ['gone']);
  const orig = undo.recordBranchDelete;
  t.after(() => { undo.recordBranchDelete = orig; });
  undo.recordBranchDelete = async () => { throw new Error('reflog is locked'); };
  const res = await runner.run(dir, 'deleteBranch', ['gone']);
  assert.deepEqual(res, {
    name: 'gone', sha, upstream: null, undoRecorded: false,
    warning: 'The branch was deleted, but its deletion could not be recorded for undo: reflog is locked',
  });
  assert.equal(h.git(dir, 'for-each-ref', 'refs/heads/gone').trim(), '');
});

test("discard of a '?' path that is really tracked: stale, no backup ref and no undo entry", async () => {
  const dir = h.initRepo();
  h.write(dir, 'README.md', 'changed\n');
  const runner = ops.createRunner();
  const reflog = h.git(dir, 'reflog', '--format=%gs').trim();
  const err = await runner.run(dir, 'discard', [[{ path: 'README.md', status: '?' }]]).catch((e) => e);
  assert.equal(err.kind, 'stale');
  assert.equal(h.read(dir, 'README.md'), 'changed\n');
  assert.equal(h.git(dir, 'for-each-ref', 'refs/pasta-lite/').trim(), '');
  assert.equal(h.git(dir, 'reflog', '--format=%gs').trim(), reflog);
  assert.equal((await runner.run(dir, 'undoState')).undo, null);
});

test('running() lists queued and running ops (with or without opId); settled() waits for all', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const fakeOps = { w1: () => gates[0].promise, w2: () => gates[1].promise, r: () => gates[2].promise };
  const runner = ops.createRunner({ ops: fakeOps, writeOps: new Set(['w1', 'w2']) });
  assert.deepEqual(runner.running(), []);
  await runner.settled(); // nothing to wait for
  const p1 = runner.run('/r', 'w1');
  const p2 = runner.run('/r', 'w2', [], { opId: 'b' });
  const p3 = runner.run('/r', 'r');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runner.running(), [
    { repo: '/r', op: 'w1', write: true, owner: null, started: true, cancelled: false },
    { repo: '/r', op: 'w2', write: true, owner: null, started: false, cancelled: false }, // queued behind w1
    { repo: '/r', op: 'r', write: false, owner: null, started: true, cancelled: false },
  ]);
  let settled = false;
  const s = runner.settled().then(() => { settled = true; });
  gates[0].resolve(1);
  gates[2].resolve(3);
  await Promise.all([p1, p3]);
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  assert.deepEqual(runner.running().map((e) => e.op), ['w2']);
  gates[1].resolve(2);
  assert.equal(await p2, 2);
  await s;
  assert.deepEqual(runner.running(), []);
});

test('owner (one tab): running / cancelAll / settled with {owner} see only that owner\'s ops', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const fakeOps = { w: (_r, i) => gates[i].promise, r: () => gates[2].promise };
  const runner = ops.createRunner({ ops: fakeOps, writeOps: new Set(['w']) });
  const a = runner.run('/r', 'w', [0], { owner: 1 });
  const b = runner.run('/other', 'w', [1], { owner: 2 });
  const c = runner.run('/r', 'r', [], { owner: 2 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runner.running({ owner: 1 }).map((e) => [e.op, e.owner]), [['w', 1]]);
  assert.deepEqual(runner.running({ owner: 2 }).map((e) => e.op), ['w', 'r']);
  assert.equal(runner.running().length, 3); // no filter: every op
  let settled2 = false;
  const s2 = runner.settled({ owner: 2 }).then(() => { settled2 = true; });
  assert.equal(runner.cancelAll({ owner: 1 }), 1);
  assert.deepEqual(runner.running({ owner: 1 }).map((e) => e.cancelled), [true]);
  gates[0].resolve('a'); // the fake ignores its signal: it finishes anyway
  assert.equal(await a, 'a');
  assert.deepEqual(runner.running({ owner: 1 }), []);
  assert.equal(runner.running({ owner: 2 }).every((e) => !e.cancelled), true);
  gates[1].resolve('b');
  await b;
  assert.equal(settled2, false); // c still runs
  gates[2].resolve('c');
  await c;
  await s2;
  assert.deepEqual(runner.running(), []);
});

test('cancelAll() cancels every queued and running op; an op that ignores its signal stays listed as cancelled', async () => {
  const { dir, started } = slowRemoteRepo();
  const gate = deferred();
  const stubbornRuns = deferred();
  let stuckRan = false;
  // A stand-in for undo's reversal: its work doesn't stop on abort.
  const stubborn = { stubborn: () => { stubbornRuns.resolve(); return gate.promise; }, laterWrite: async () => { stuckRan = true; } };
  const fake = ops.createRunner({ ops: stubborn, writeOps: new Set(['stubborn', 'laterWrite']) });
  const real = ops.createRunner();
  const fetchP = real.run(dir, 'fetch', [{ remote: 'slow' }]); // no opId: cancel(opId) can't reach it
  const queued = real.run(dir, 'stage', [['README.md']]);
  const stuck = fake.run('/r', 'stubborn');
  const later = fake.run('/r', 'laterWrite');
  await waitForFile(started, 'the remote\'s upload-pack');
  await stubbornRuns.promise;
  const cancelledAt = Date.now();
  assert.equal(real.cancelAll(), 2);
  assert.equal(real.cancelAll(), 0); // already cancelled
  await assert.rejects(fetchP, { kind: 'aborted' });
  await assert.rejects(queued, { kind: 'aborted' });
  await real.settled();
  assert.ok(Date.now() - cancelledAt < 10000, 'fetch was killed, not waited for');
  assert.deepEqual(real.running(), []);

  assert.equal(fake.cancelAll(), 2);
  await new Promise((r) => setTimeout(r, 50));
  // The queued write settles only when its turn comes (then it is skipped).
  assert.deepEqual(fake.running(), [
    { repo: '/r', op: 'stubborn', write: true, owner: null, started: true, cancelled: true },
    { repo: '/r', op: 'laterWrite', write: true, owner: null, started: false, cancelled: true },
  ]);
  gate.resolve('finished anyway');
  assert.equal(await stuck, 'finished anyway');
  await assert.rejects(later, { kind: 'aborted' });
  assert.equal(stuckRan, false);
  await fake.settled();
  assert.deepEqual(fake.running(), []);
});

// ---------------------------------------------------------------- linked worktrees

/** A repo with linked worktrees `names` in one folder next to it; returns {dir, parent, wts: {name: path}}. */
function withWorktrees(...names) {
  const dir = h.initRepo();
  const parent = h.tmpDir();
  const wts = {};
  for (const n of names) {
    wts[n] = path.join(parent, n);
    h.git(dir, 'worktree', 'add', '-q', '-b', n, wts[n]);
  }
  return { dir, parent, wts };
}

test('worktree ops refuse before anything runs: unlisted, main, current, containing the tab, locked, prunable, a bad reason', async () => {
  const { dir, parent, wts } = withWorktrees('a', 'l', 'gone');
  // A worktree inside a's folder: a tab there has a's folder around it.
  const inner = path.join(wts.a, 'inner');
  h.git(dir, 'worktree', 'add', '-q', '-b', 'inner', inner);
  h.git(dir, 'worktree', 'lock', '--reason', 'on a stick', wts.l);
  fs.rmSync(wts.gone, { recursive: true, force: true });
  const runner = ops.createRunner();
  const events = [];
  runner.on('changed', (e) => events.push(e));
  const refused = (repo, name, args, kind, message) => assert.rejects(runner.run(repo, name, args), (e) => {
    assert.equal(e.kind, kind, `${name} ${JSON.stringify(args)}`);
    if (message) assert.equal(e.message, message);
    return true;
  });
  for (const name of ['removeWorktree', 'lockWorktree', 'unlockWorktree']) {
    await refused(dir, name, [path.join(parent, 'nowhere')], 'not-found', `Not a worktree of this repository: '${path.join(parent, 'nowhere')}'`);
    await refused(dir, name, [`${wts.a}/`], 'not-found'); // exactly as git prints it: no trailing slash
    await refused(dir, name, [`${wts.a}/../a`], 'not-found'); // another spelling of a listed path
    await refused(dir, name, [''], 'invalid-args');
    await refused(dir, name, [42], 'invalid-args');
  }
  await refused(dir, 'removeWorktree', [dir], 'main-worktree', "The main worktree can't be deleted");
  await refused(dir, 'lockWorktree', [dir], 'main-worktree', "The main worktree can't be locked");
  await refused(dir, 'unlockWorktree', [dir], 'main-worktree', "The main worktree can't be unlocked");
  await refused(wts.a, 'removeWorktree', [dir], 'main-worktree', "The main worktree can't be deleted");
  await refused(wts.a, 'removeWorktree', [wts.a], 'current-worktree', "This tab has this worktree open: it can't be deleted from here");
  await refused(inner, 'removeWorktree', [wts.a], 'current-worktree', "This tab has this worktree open (or one inside it): it can't be deleted from here");
  await refused(dir, 'removeWorktree', [wts.l, { force: true }], 'worktree-locked', `${wts.l} is locked: on a stick. Unlock it first`);
  await assert.rejects(runner.run(dir, 'removeWorktree', [wts.l]), (e) => {
    assert.deepEqual(ops.serializeError(e), { message: e.message, kind: 'worktree-locked', exitCode: null, reason: 'on a stick' });
    return true;
  });
  const dirty = Object.assign(new GitError(['worktree'], 128, 'fatal: working trees containing submodules cannot be moved or removed'), { kind: 'worktree-dirty', submodules: true });
  assert.equal(ops.serializeError(dirty).submodules, true, 'crosses IPC for the force confirm');
  await refused(dir, 'removeWorktree', [wts.gone], 'not-found', 'Its folder is gone: prune it instead');
  for (const reason of ['x'.repeat(201), 'two\nlines', 'tab\there', 7, { r: 1 }]) {
    await refused(dir, 'lockWorktree', [wts.a, { reason }], 'invalid-args', 'reason must be one line of at most 200 characters');
  }
  await refused(dir, 'lockWorktree', [wts.l], 'nothing', 'This worktree is already locked');
  await refused(dir, 'unlockWorktree', [wts.a], 'nothing', 'This worktree is not locked');
  assert.deepEqual(events, [], 'refused during validation: no changed events');
  assert.equal(fs.existsSync(wts.a) && fs.existsSync(wts.l), true);
  assert.equal(h.git(dir, 'worktree', 'list', '--porcelain').includes('prunable'), true, 'the prunable entry is still listed');
});

test('removeWorktree: worktree-busy while a rebase or merge is stopped there, even with force; nothing is deleted', async () => {
  const { dir, wts } = withWorktrees('reb', 'mrg');
  const runner = ops.createRunner();
  const events = [];
  runner.on('changed', (e) => events.push(e));
  // Stopped at an `edit` step of an interactive rebase: the tree is clean, and git itself would remove it.
  h.commitFile(wts.reb, 'r.txt', 'r\n', 'on reb');
  h.git(wts.reb, '-c', 'sequence.editor=sed -i.bak s/^pick/edit/', 'rebase', '-q', '-i', 'HEAD~1');
  const gitDir = h.git(wts.reb, 'rev-parse', '--absolute-git-dir').trim();
  assert.ok(fs.existsSync(path.join(gitDir, 'rebase-merge')), 'the rebase is stopped');
  for (const o of [{}, { force: true }]) {
    await assert.rejects(runner.run(dir, 'removeWorktree', [wts.reb, o]), (e) => {
      assert.equal(e.kind, 'worktree-busy');
      assert.equal(e.message, `A rebase is in progress in ${wts.reb}: finish or abort it first`);
      assert.equal(ops.serializeError(e).state, 'rebasing');
      return true;
    });
  }
  // A conflicted merge.
  h.commitFile(dir, 'm.txt', 'main\n', 'main side');
  h.commitFile(wts.mrg, 'm.txt', 'mrg side\n', 'mrg side');
  assert.throws(() => h.git(wts.mrg, 'merge', '-q', 'main'));
  await assert.rejects(runner.run(dir, 'removeWorktree', [wts.mrg, { force: true }]), {
    kind: 'worktree-busy', message: `A merge is in progress in ${wts.mrg}: finish or abort it first`,
  });
  assert.deepEqual(events, [], 'refused in the check');
  assert.ok(fs.existsSync(wts.reb) && fs.existsSync(gitDir) && fs.existsSync(wts.mrg));
  // Once it is over, it goes.
  h.git(wts.reb, 'rebase', '--abort');
  assert.deepEqual(await runner.run(dir, 'removeWorktree', [wts.reb]), { path: wts.reb });
});

test('removeWorktree: worktree-busy while another tab\'s write runs or waits in that worktree (or inside it); reads don\'t count', async () => {
  const { dir, wts } = withWorktrees('a', 'b');
  const hold = deferred();
  const started = deferred();
  const runner = ops.createRunner({
    ops: { ...ops.OPS, hold: async () => { started.resolve(); await hold.promise; return 'held'; }, peek: async () => { await hold.promise; } },
    writeOps: new Set([...ops.WRITE_OPS, 'hold']),
  });
  const events = [];
  runner.on('changed', (e) => events.push(e.op));
  // A read in b is no reason to wait.
  const peeking = runner.run(wts.b, 'peek', []);
  // A write running in a (the tab that has it open), and a second one queued behind it.
  const running = runner.run(wts.a, 'hold', []);
  const queued = runner.run(wts.a, 'hold', []);
  await started.promise;
  const busy = { kind: 'worktree-busy', message: 'Another tab is running a git operation there: try again when it finishes' };
  await assert.rejects(runner.run(dir, 'removeWorktree', [wts.a]), busy);
  await assert.rejects(runner.run(dir, 'removeWorktree', [wts.a, { force: true }]), busy, 'force doesn\'t override it');
  assert.ok(fs.existsSync(wts.a));
  // A write in a folder inside the worktree counts too (a symlinked spelling of it as well).
  const link = path.join(h.tmpDir(), 'link-a');
  fs.symlinkSync(wts.a, link);
  fs.mkdirSync(path.join(wts.a, 'sub'));
  hold.resolve();
  assert.deepEqual(await Promise.all([running, queued, peeking]), ['held', 'held', undefined]);
  const hold2 = deferred();
  const r2 = ops.createRunner({ ops: { ...ops.OPS, hold: () => hold2.promise }, writeOps: new Set([...ops.WRITE_OPS, 'hold']) });
  const inside = r2.run(path.join(link, 'sub'), 'hold', []);
  await assert.rejects(r2.run(dir, 'removeWorktree', [wts.a]), busy);
  hold2.resolve();
  await inside;
  // b had only a read: it goes; so does a once its writes are over.
  assert.deepEqual(await runner.run(dir, 'removeWorktree', [wts.b]), { path: wts.b });
  assert.deepEqual(await runner.run(dir, 'removeWorktree', [wts.a]), { path: wts.a });
  assert.deepEqual(events, ['hold', 'hold', 'removeWorktree', 'removeWorktree'], 'a refusal emits no events');
});

test('removeWorktree: worktree-busy while another worktree is inside it (ignored or untracked), even with force; nothing is deleted', async () => {
  const { dir, wts } = withWorktrees('ign', 'untr');
  const runner = ops.createRunner();
  const events = [];
  runner.on('changed', (e) => events.push(e.op));
  // (a) .worktrees/ is ignored: git itself would remove ign without force, inner and all.
  h.commitFile(wts.ign, '.gitignore', '.worktrees/\n', 'ignore worktrees');
  const innerIgn = path.join(wts.ign, '.worktrees', 'inner');
  h.git(dir, 'worktree', 'add', '-q', '-b', 'inner-ign', innerIgn);
  h.write(innerIgn, 'precious.txt', 'p\n');
  // (b) not ignored: git's refusal would read as "untracked files", and force would wipe it.
  const innerUntr = path.join(wts.untr, 'inner');
  h.git(dir, 'worktree', 'add', '-q', '-b', 'inner-untr', innerUntr);
  for (const [outer, inner] of [[wts.ign, innerIgn], [wts.untr, innerUntr]]) {
    for (const o of [{}, { force: true }]) {
      await assert.rejects(runner.run(dir, 'removeWorktree', [outer, o]), {
        kind: 'worktree-busy', message: `Another worktree is inside it (${inner}): delete that one first`,
      });
    }
  }
  assert.ok(fs.existsSync(path.join(innerIgn, 'precious.txt')) && fs.existsSync(innerUntr));
  assert.deepEqual(events, [], 'refused in the check');
  // A missing inner one doesn't count (its folder is gone already: prune it).
  fs.rmSync(innerUntr, { recursive: true, force: true });
  assert.deepEqual(await runner.run(dir, 'removeWorktree', [wts.untr, { force: true }]), { path: wts.untr });
  // The inner one first, then the outer one.
  assert.deepEqual(await runner.run(dir, 'removeWorktree', [innerIgn, { force: true }]), { path: innerIgn });
  assert.deepEqual(await runner.run(dir, 'removeWorktree', [wts.ign]), { path: wts.ign });
});

test('removeWorktree: the stopped state is read from git\'s admin folder for it, not through the folder\'s .git file; checked again as it starts', async () => {
  const { dir, wts } = withWorktrees('reb', 'other');
  const runner = ops.createRunner();
  h.commitFile(wts.reb, 'r.txt', 'r\n', 'on reb');
  h.git(wts.reb, '-c', 'sequence.editor=sed -i.bak s/^pick/edit/', 'rebase', '-q', '-i', 'HEAD~1');
  const admin = h.git(wts.reb, 'rev-parse', '--absolute-git-dir').trim();
  // reb's .git file now points at other's (clean) git dir: git run there would see no rebase.
  const otherGitDir = h.git(wts.other, 'rev-parse', '--absolute-git-dir').trim();
  fs.writeFileSync(path.join(wts.reb, '.git'), `gitdir: ${otherGitDir}\n`);
  await assert.rejects(runner.run(dir, 'removeWorktree', [wts.reb, { force: true }]), {
    kind: 'worktree-busy', message: `A rebase is in progress in ${wts.reb}: finish or abort it first`,
  });
  assert.ok(fs.existsSync(path.join(admin, 'rebase-merge')));
  // Stopped after the check passed (a terminal): the act checks again before git runs.
  const { dir: d2, wts: w2 } = withWorktrees('late');
  const checked = await ops.OPS.removeWorktree.check(d2, w2.late, {});
  h.commitFile(w2.late, 'l.txt', 'l\n', 'on late');
  h.git(w2.late, '-c', 'sequence.editor=sed -i.bak s/^pick/edit/', 'rebase', '-q', '-i', 'HEAD~1');
  assert.throws(() => ops.OPS.removeWorktree.act(d2, ...checked), {
    kind: 'worktree-busy', message: `A rebase is in progress in ${w2.late}: finish or abort it first`,
  });
  assert.ok(fs.existsSync(w2.late));
});

test('removeWorktree: while it runs, a write at or inside that folder is refused as being deleted; reads and other folders are not', async () => {
  const { dir, wts } = withWorktrees('a', 'b');
  const hold = deferred();
  const deleting = deferred();
  const real = ops.OPS.removeWorktree;
  // The real check, and an act that holds until released (the delete in progress).
  const removeWorktree = Object.assign(async () => {}, { check: real.check, act: () => { deleting.resolve(); return hold.promise; } });
  const runner = ops.createRunner({
    ops: { ...ops.OPS, removeWorktree, poke: async () => 'poked', peek: async () => 'peeked' },
    writeOps: new Set([...ops.WRITE_OPS, 'poke']),
  });
  const events = [];
  runner.on('changed', (e) => events.push(e.op));
  const removing = runner.run(dir, 'removeWorktree', [wts.a]);
  await deleting.promise;
  const gone = { kind: 'worktree-busy', message: 'This worktree is being deleted' };
  await assert.rejects(runner.run(wts.a, 'poke', []), gone, 'a plain write (no check)');
  await assert.rejects(runner.run(wts.a, 'stage', [['README.md']]), gone, 'a checked write');
  const link = path.join(h.tmpDir(), 'link-a');
  fs.symlinkSync(wts.a, link);
  fs.mkdirSync(path.join(wts.a, 'sub'));
  await assert.rejects(runner.run(path.join(link, 'sub'), 'poke', []), gone, 'inside it, by another spelling');
  assert.equal(await runner.run(wts.a, 'peek', []), 'peeked', 'a read');
  assert.equal(await runner.run(wts.b, 'poke', []), 'poked', 'another worktree');
  hold.resolve({ path: wts.a });
  assert.deepEqual(await removing, { path: wts.a });
  assert.equal(await runner.run(wts.a, 'poke', []), 'poked', 'over: no longer refused');
  // A refused delete leaves no record behind.
  const held = deferred();
  const started = deferred();
  const r2 = ops.createRunner({
    ops: { ...ops.OPS, hold: async () => { started.resolve(); await held.promise; }, poke: async () => 'poked' },
    writeOps: new Set([...ops.WRITE_OPS, 'hold', 'poke']),
  });
  const holding = r2.run(wts.b, 'hold', []);
  await started.promise;
  await assert.rejects(r2.run(dir, 'removeWorktree', [wts.b]), { kind: 'worktree-busy', message: 'Another tab is running a git operation there: try again when it finishes' });
  fs.mkdirSync(path.join(wts.b, 'sub'));
  assert.equal(await r2.run(path.join(wts.b, 'sub'), 'poke', []), 'poked', 'b is not being deleted'); // not behind hold in b's queue
  held.resolve();
  await holding;
  assert.deepEqual(events, ['poke', 'removeWorktree', 'poke'], 'refusals emit no events');
});

test('worktreeUnreachable: listed paths only; 0 without git on a branch; the detached HEAD\'s commits no ref keeps', async () => {
  const { dir, parent, wts } = withWorktrees('a', 'det');
  const runner = ops.createRunner();
  await assert.rejects(runner.run(dir, 'worktreeUnreachable', [path.join(parent, 'nowhere')]), { kind: 'not-found' });
  await assert.rejects(runner.run(dir, 'worktreeUnreachable', [`${wts.a}/`]), { kind: 'not-found' });
  await assert.rejects(runner.run(dir, 'worktreeUnreachable', [42]), { kind: 'invalid-args' });
  assert.deepEqual(await runner.run(dir, 'worktreeUnreachable', [dir]), { count: 0 });
  h.commitFile(wts.a, 'a.txt', 'a\n', 'on a: its branch keeps it');
  assert.deepEqual(await runner.run(dir, 'worktreeUnreachable', [wts.a]), { count: 0 });
  h.git(wts.det, 'checkout', '-q', '--detach');
  assert.deepEqual(await runner.run(dir, 'worktreeUnreachable', [wts.det]), { count: 0 }, 'detached on det\'s tip');
  h.commitFile(wts.det, 'd1.txt', '1\n', 'one');
  h.commitFile(wts.det, 'd2.txt', '2\n', 'two');
  assert.deepEqual(await runner.run(dir, 'worktreeUnreachable', [wts.det]), { count: 2 });
  // Its folder gone: still answered (it runs in the tab's repo).
  fs.rmSync(wts.det, { recursive: true, force: true });
  assert.deepEqual(await runner.run(wts.a, 'worktreeUnreachable', [wts.det]), { count: 2 });
});

test('worktree ops: lock (reason trimmed; the current one may be locked), unlock, remove with force, prune and its preview', async () => {
  const { dir, wts } = withWorktrees('a', 'b', 'gone');
  const runner = ops.createRunner();
  const events = [];
  runner.on('changed', (e) => events.push(e.op));
  const entry = async (p) => (await runner.run(dir, 'worktrees', [])).find((w) => w.path === p);
  assert.deepEqual(await runner.run(dir, 'lockWorktree', [wts.a, { reason: '  on a stick  ' }]), { path: wts.a });
  assert.equal((await entry(wts.a)).lockReason, 'on a stick');
  await runner.run(dir, 'unlockWorktree', [wts.a]);
  await runner.run(dir, 'lockWorktree', [wts.a, { reason: '   ' }]);
  assert.deepEqual([(await entry(wts.a)).locked, (await entry(wts.a)).lockReason], [true, null], 'a blank reason is none');
  await runner.run(wts.a, 'unlockWorktree', [wts.a]); // the current worktree: allowed
  await runner.run(wts.a, 'lockWorktree', [wts.a]);
  await runner.run(dir, 'unlockWorktree', [wts.a]);
  // Remove: dirty needs force (git's refusal, after the check passed).
  h.write(wts.b, 'new.txt', 'n\n');
  await assert.rejects(runner.run(dir, 'removeWorktree', [wts.b]), { kind: 'worktree-dirty' });
  assert.deepEqual(await runner.run(dir, 'removeWorktree', [wts.b, { force: true }]), { path: wts.b });
  assert.equal(fs.existsSync(wts.b), false);
  // The dirty check and the prune preview are reads.
  h.write(wts.a, 'README.md', 'changed\n');
  fs.rmSync(wts.gone, { recursive: true, force: true });
  assert.deepEqual(await runner.run(dir, 'worktreeDirty', []), [{ path: wts.a, dirty: true }]);
  const preview = await runner.run(dir, 'worktreePrunePreview', []);
  assert.deepEqual(preview.entries.map((e) => e.id), ['worktrees/gone']);
  assert.ok(await entry(wts.gone), 'the preview removed nothing');
  assert.deepEqual(await runner.run(dir, 'pruneWorktrees', [{ dryRun: true }]), preview, 'prune takes no arguments: never a dry run from the renderer');
  assert.equal(await entry(wts.gone), undefined);
  assert.deepEqual(events, ['lockWorktree', 'unlockWorktree', 'lockWorktree', 'unlockWorktree', 'lockWorktree', 'unlockWorktree', 'removeWorktree', 'removeWorktree', 'pruneWorktrees']);
});
