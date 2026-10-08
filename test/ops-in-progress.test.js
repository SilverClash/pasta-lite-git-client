'use strict';
// B1: while a rebase, merge or other operation (cherry-pick, bisect, ...) is stopped, the ops that
// would move HEAD or rewrite the tree under it (checkout, stashApply, stashPop, createBranch
// {checkout: true}) are refused in their check with pull's kind 'in-progress' (and `state`), before
// anything runs. Plus the registry's descriptors against the renderer's bare-repo flow list
// (renderer/policy.js WORKTREE_FLOWS).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const ops = require('../src/ops');

/**
 * A repo stopped with a conflict in `how` ('rebase' | 'merge' | 'cherry-pick'), or mid-bisect
 * ('bisect'), with a stash entry and a branch 'other'.
 */
function stopped(how) {
  const dir = h.initRepo();
  h.git(dir, 'branch', 'other');
  h.write(dir, 'extra.txt', 'x\n');
  h.git(dir, 'stash', 'push', '-u', '-q', '-m', 'kept');
  h.git(dir, 'checkout', '-q', '-b', 'feat');
  h.commitFile(dir, 'README.md', 'feat\n', 'feat edit');
  h.git(dir, 'checkout', '-q', 'main');
  h.commitFile(dir, 'README.md', 'main\n', 'main edit');
  if (how === 'rebase') {
    h.git(dir, 'checkout', '-q', 'feat');
    assert.throws(() => h.git(dir, 'rebase', 'main'));
  } else if (how === 'merge') {
    assert.throws(() => h.git(dir, 'merge', 'feat'));
  } else if (how === 'cherry-pick') {
    assert.throws(() => h.git(dir, 'cherry-pick', 'feat'));
  } else {
    h.git(dir, 'bisect', 'start');
  }
  return dir;
}

// Any state but 'clean' (pull's check): the cherry-pick and bisect rows stand for the others.
for (const [how, state] of [['rebase', 'rebasing'], ['merge', 'merging'], ['cherry-pick', 'cherry-picking'], ['bisect', 'bisecting']]) {
  test(`mid-${how}: checkout, stashApply, stashPop and createBranch {checkout: true} are refused (in-progress, ${state})`, async () => {
    const dir = stopped(how);
    const head = h.git(dir, 'rev-parse', 'HEAD');
    const events = [];
    const runner = ops.createRunner();
    runner.on('busy', (e) => events.push(e));
    for (const [op, args] of [
      ['checkout', ['other']],
      ['checkout', [head.trim(), { kind: 'commit' }]],
      ['stashApply', [0]],
      ['stashPop', [0]],
      ['createBranch', ['fresh', { checkout: true }]],
    ]) {
      await assert.rejects(runner.run(dir, op, args), { kind: 'in-progress', state }, `${op} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(events, [], 'refused in check: no busy / changed events');
    assert.equal(h.git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(h.git(dir, 'stash', 'list').trim().split('\n').length, 1, 'the stash is still there');
    assert.equal(fs.existsSync(path.join(dir, 'extra.txt')), false);
    // A branch that isn't checked out is fine mid-operation.
    await runner.run(dir, 'createBranch', ['fresh']);
    assert.match(h.git(dir, 'branch', '--list', 'fresh'), /fresh/);
  });
}

test('the same ops still run in a clean repo (the in-progress check passes)', async () => {
  const dir = h.initRepo();
  h.git(dir, 'branch', 'other');
  h.write(dir, 'extra.txt', 'x\n');
  h.git(dir, 'stash', 'push', '-u', '-q');
  const runner = ops.createRunner();
  await runner.run(dir, 'checkout', ['other']);
  await runner.run(dir, 'stashApply', [0]);
  h.git(dir, 'checkout', '-q', '--', '.');
  fs.rmSync(path.join(dir, 'extra.txt'));
  await runner.run(dir, 'stashPop', [0]);
  fs.rmSync(path.join(dir, 'extra.txt'));
  await runner.run(dir, 'createBranch', ['fresh', { checkout: true }]);
  assert.equal(h.git(dir, 'symbolic-ref', '--short', 'HEAD').trim(), 'fresh');
});

test('descriptors: every op has one; WRITE_OPS / WORKTREE_OPS / BARE_OK are derived from them', () => {
  const d = ops.DESCRIPTORS;
  assert.deepEqual(Object.keys(d).sort(), Object.keys(ops.OPS).sort()); // NOSONAR(S2871): ASCII op names
  for (const [name, desc] of Object.entries(d)) {
    assert.equal(ops.OPS[name], desc.run, name);
    assert.equal(ops.WRITE_OPS.has(name), desc.write, name);
    assert.equal(ops.BARE_OK.has(name), !!desc.bare, name);
    assert.equal(ops.WORKTREE_OPS.has(name), !desc.bare, name);
    assert.equal(typeof desc.act, 'function', name);
  }
  assert.equal(typeof d.pull.bare, 'function');
  assert.equal(d.pull.bare([{ mode: 'fetch' }]), null);
  assert.equal(d.pull.bare([{ mode: 'rebase' }]), 'pull');
  assert.equal(d.createBranch.bare(['x', { checkout: true }]), 'createBranch with checkout');
  assert.deepEqual(Object.keys(d).filter((n) => d[n].mirror).sort(), ['createBranch', 'fetch', 'pull']); // NOSONAR(S2871)
});

// The ops each renderer flow in WORKTREE_FLOWS (renderer/policy.js, PLPolicy) runs, and the
// working-tree ops no flow covers: reads the store invokes directly, which a bare repo never asks
// for (no WIP row, so no working-tree diff). A new flow in WORKTREE_FLOWS needs an entry here.
const FLOW_OPS = {
  checkout: ['checkout'], stashSave: ['stashPush'], stashPop: ['stashPop'], stashApply: ['stashApply'], stashDrop: ['stashDrop'],
  merge: ['merge'], rebase: ['rebase'], interactiveRebase: ['rebaseInteractive'], startInteractiveRebase: ['rebaseInteractive'],
  reloadInteractiveRebase: ['rebasePlan'], rebaseContinue: ['rebaseContinue'], rebaseSkip: ['rebaseSkip'],
  rebaseAbort: ['rebaseAbort'], mergeCommit: ['mergeCommit'], mergeAbort: ['mergeAbort'], restoreAutostash: ['restoreAutostash'],
  resolveWith: ['resolveWith'],
  // renderer/flows-worktree.js (the WIP panel, the composer and the diff view)
  stage: ['stage'], unstage: ['unstage'], stageAll: ['stageAll', 'stage'], unstageAll: ['unstageAll'], discard: ['discard'],
  markResolved: ['markAllResolved', 'stage'], commit: ['commit', 'commitAll'],
  stageSelection: ['stageSelection'], unstageSelection: ['unstageSelection'], discardSelection: ['discardSelection'],
};
const NO_FLOW = new Set(['diffWorkdir', 'workdirDiffView', 'workdirImageSide']);

test("WORKTREE_OPS covers exactly the ops of the renderer's WORKTREE_FLOWS (PLPolicy, loaded through the harness)", () => {
  const H = require('./renderer-harness.js');
  const win = H.loadFlows();
  const flows = Object.keys(win.PLPolicy.WORKTREE_FLOWS);
  assert.ok(flows.length > 10);
  assert.equal(win.Components.actions.WORKTREE_FLOWS, win.PLPolicy.WORKTREE_FLOWS, 'Components.actions re-exports the policy');
  assert.deepEqual(flows.filter((f) => typeof win.PLFlows[f] !== 'function'), [], 'every gated flow is a PLFlows flow');
  assert.deepEqual(flows.filter((f) => !Object.hasOwn(FLOW_OPS, f)), [], 'a new flow: map it to its ops here');
  const covered = new Set(flows.flatMap((f) => FLOW_OPS[f]));
  assert.deepEqual([...covered].filter((op) => !ops.WORKTREE_OPS.has(op)), [], 'a flow the renderer gates runs an op the backend allows in a bare repo');
  assert.deepEqual([...ops.WORKTREE_OPS].filter((op) => !covered.has(op) && !NO_FLOW.has(op)), [], 'a working-tree op no renderer flow gates');
  assert.deepEqual([...NO_FLOW].filter((op) => !ops.WORKTREE_OPS.has(op)), []);
  assert.deepEqual(Object.keys(FLOW_OPS).filter((f) => !flows.includes(f)), [], 'a FLOW_OPS entry the renderer no longer gates');
});
