'use strict';
// renderer/flows-*.js (window.PLFlows) over a scripted fake api and scripted dialogs, plus the
// DOM behaviour of Components.dialog.prompt / choose and Components.menu on a minimal fake DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const err = H.errOf;
const { scriptedApi, scriptDialogs } = H;

const REPO = { root: '/r', name: 'r' };

function baseData({ branch = 'main', upstream = 'origin/main', dirty = false, local, stashes = [], undoState, remotes, worktrees } = {}) {
  const st = H.status({ oid: 'a'.repeat(40), branch, dirty });
  st.upstream = upstream;
  return {
    status: st,
    refs: H.refs({ local: local || [{ name: 'main', oid: 'a'.repeat(40), upstream: upstream, current: branch === 'main' }] }),
    stashes,
    log: { commits: [H.commit('a'.repeat(40))], hasMore: false, next: null },
    undoState: undoState === undefined ? { undo: null, redo: null, busy: false, undoBlocked: null, redoBlocked: null } : undoState,
    remotes,
    worktrees,
  };
}

/** Loaded store + PLFlows over a scripted api; toasts and notices are collected. */
async function setup(dataOpts = {}, handlers = {}, answers = []) {
  H.setLocalStorage(H.memoryStorage());
  const win = H.loadFlows();
  const data = baseData(dataOpts);
  const api = scriptedApi(data, handlers);
  win.api = api;
  const store = win.Store.create(api);
  const toasts = [];
  store.setToast((e) => toasts.push(e));
  await store.actions.loadRepo(REPO);
  await H.flush();
  const dialogs = scriptDialogs(win, answers);
  const errors = () => toasts.filter((t) => t.level !== 'info');
  const notices = () => toasts.filter((t) => t.level === 'info').map((t) => t.message);
  return { win, api, store, F: win.PLFlows, dialogs, toasts, errors, notices, data };
}

const writeOps = (api) => api.writes().map((c) => c.op);

// ------------------------------------------------------------------ guards

test('flows do nothing while busy', async () => {
  const { F, store, api, dialogs } = await setup({}, { fetch: () => ({ tagConflicts: [] }) });
  store.set({ busy: true });
  assert.equal(await F.fetch(store), false);
  assert.equal(await F.createBranch(store, {}), false);
  assert.deepEqual(writeOps(api), []);
  assert.equal(dialogs.length, 0);
  store.set({ busy: false });
  assert.equal(await F.fetch(store), true, 'runs once idle');
});

test('one flow at a time: a second flow while the first waits on a dialog returns false', async () => {
  const { F, store, api, win } = await setup({}, { createBranch: (name) => ({ name, sha: 'a'.repeat(40) }), fetch: () => ({ tagConflicts: [] }) });
  let release;
  win.Components.dialog.prompt = () => new Promise((r) => { release = r; });
  const first = F.createBranch(store, {});
  await H.flush();
  assert.equal(F.isRunning(store), true);
  assert.equal(await F.fetch(store), false, 'refused while createBranch is open');
  release('topic');
  assert.equal(await first, true);
  assert.equal(F.isRunning(store), false);
  assert.deepEqual(writeOps(api), ['createBranch']);
  assert.equal(await F.fetch(store), true, 'free again');
});

test('flows never throw: a failing dialog or op is reported and resolves false', async () => {
  const { F, store, win, errors } = await setup({}, { fetch: () => { throw err('boom', 'network down'); } });
  win.Components.dialog.prompt = () => { throw new Error('dialog exploded'); };
  assert.equal(await F.createBranch(store, {}), false);
  assert.equal(await F.fetch(store), false);
  assert.deepEqual(errors().map((e) => e.message), ['dialog exploded', 'network down'], 'each shown once');
  assert.equal(await F.fetch(null), false);
});

// ------------------------------------------------------------------ undo / redo

/** Load a component script into the flows' window and return its node exports (index.html order). */
function componentExports(file) {
  const p = require.resolve(`../renderer/components/${file}`);
  delete require.cache[p];
  return require(p);
}

test('a rebase / merge in progress: double-clicks, ref pills and shortcuts are refused with the menus\' reason, before any write', async () => {
  for (const [state, name] of [['rebasing', 'rebase'], ['merging', 'merge']]) {
    const handlers = { checkout: () => true, stashApply: () => true, createBranch: () => ({}) };
    const s = await setup({ stashes: [{ index: 0, ref: 'stash@{0}', hash: 'd'.repeat(40), message: 'WIP' }] }, handlers);
    const st = { ...s.store.state.status, state, ...(state === 'rebasing' ? { rebase: H.rebaseState(), branch: null } : { merge: { head: 'e'.repeat(40), name: 'feat', message: 'Merge feat' } }) };
    s.store.set({ status: st });
    const A = s.win.Components.actions;
    const { doubleClickAction } = componentExports('sidebar.js');
    const { pillAction } = componentExports('graph-view.js');

    const branch = doubleClickAction({ kind: 'local', name: 'feat', oid: 'b'.repeat(40), current: false }, s.store.state);
    assert.equal(await A.runFlow(branch, s.store), false, `${name}: branch double-click`);
    const stash = doubleClickAction({ kind: 'stash', entry: s.store.state.stashes[0] }, s.store.state);
    assert.equal(await A.runFlow(stash, s.store), false, `${name}: stash double-click`);
    const pill = pillAction({ kind: 'local', ref: 'feat', current: false }, s.store.state);
    assert.equal(await A.runFlow(pill, s.store), false, `${name}: pill double-click`);
    // ⌘B: the toolbar's rule already turns the key into a notice; the flow it runs refuses on its own too.
    const key = s.win.Components.util.IS_MAC ? { key: 'b', metaKey: true } : { key: 'b', ctrlKey: true };
    assert.equal(s.F.shortcutFor(key, s.store.state, {}), null, `${name}: ⌘B is gated off`);
    assert.equal(s.F.shortcutBlocked(key, s.store.state, {}), `Branch — finish or abort the ${name} first`);
    assert.equal(await s.F.createBranch(s.store, {}), false, `${name}: createBranch`);
    assert.deepEqual(writeOps(s.api), [], `${name}: nothing written`);
    assert.equal(s.dialogs.length, 0, `${name}: no dialog`);
    assert.deepEqual(s.notices(), [
      `Checkout — finish or abort the ${name} first`,
      `Apply stash — finish or abort the ${name} first`,
      `Checkout — finish or abort the ${name} first`,
      `Branch — finish or abort the ${name} first`,
    ]);
    assert.equal(A.opBlocked(s.store.state, 'pull', ['fetch']), null, 'Fetch All still runs');
    assert.equal(A.opBlocked(s.store.state, 'push', [{}]), `Push — a ${name} is in progress`);
    assert.equal(A.opBlocked(s.store.state, 'fetch', []), null);
  }
});

// B1 parity: the backend (src/ops.js notInProgress) refuses checkout, stashApply, stashPop and
// createBranch {checkout: true} with 'in-progress' in every status.state but 'clean' that
// repo-dirs.repoState reports, so the renderer gates the same states, each with its op's name.
test('every in-progress state the backend reports gates the B1 flows, each titled with its op', async () => {
  const { STATE_FILES } = require('../src/repo-dirs.js')._internal;
  const states = [...new Set(STATE_FILES.map(([, st]) => st))];
  assert.deepEqual(states.sort(), ['am', 'bisecting', 'cherry-picking', 'merging', 'rebasing', 'reverting', 'sequencer']); // NOSONAR(S2871): ASCII names
  for (const state of states) {
    const s = await setup({ stashes: [{ index: 0, ref: 'stash@{0}', hash: 'd'.repeat(40), message: 'WIP' }] }, { checkout: () => true });
    s.store.set({ status: { ...s.store.state.status, state } });
    const A = s.win.Components.actions;
    const name = s.win.PLOp.opName(s.store.state.status);
    assert.notEqual(name, 'operation', `op-model names ${state}`);
    for (const [flow, what] of [['checkout', 'Checkout'], ['stashApply', 'Apply stash'], ['stashPop', 'Pop stash'], ['createBranch', 'Branch']]) {
      assert.equal(A.opBlocked(s.store.state, flow, []), `${what} — finish or abort the ${name} first`, `${state}: ${flow}`);
    }
    const { doubleClickAction } = componentExports('sidebar.js');
    const branch = doubleClickAction({ kind: 'local', name: 'feat', oid: 'b'.repeat(40), current: false }, s.store.state);
    assert.equal(await A.runFlow(branch, s.store), false, `${state}: branch double-click`);
    assert.deepEqual(writeOps(s.api), [], `${state}: nothing written`);
    assert.deepEqual(s.notices(), [`Checkout — finish or abort the ${name} first`]);
  }
  const clean = await setup();
  for (const flow of ['checkout', 'stashApply', 'stashPop', 'createBranch']) {
    assert.equal(clean.win.Components.actions.opBlocked(clean.store.state, flow, []), null, `clean: ${flow}`);
  }
});

test('undo: nothing to undo / blocked / busy just say so; success runs undo and names it', async () => {
  let s = await setup();
  assert.equal(await s.F.undo(s.store), false);
  assert.deepEqual(s.notices(), ['Nothing to undo']);
  assert.deepEqual(writeOps(s.api), []);

  s = await setup({ undoState: { undo: null, redo: null, busy: false, undoBlocked: 'Files changed since the discard', redoBlocked: null } });
  assert.equal(await s.F.undo(s.store), false);
  assert.deepEqual(s.notices(), ["Can't undo: Files changed since the discard"]);

  s = await setup({ undoState: { undo: null, redo: null, busy: true, undoBlocked: null, redoBlocked: null } });
  assert.equal(await s.F.redo(s.store), false);
  assert.match(s.notices()[0], /Redo is unavailable while a merge/);

  const target = { action: 'commit', description: "Undo commit 'x'", entry: {} };
  s = await setup({ undoState: { undo: target, redo: null, busy: false, undoBlocked: null, redoBlocked: null } },
    { undo: () => ({ action: 'commit', description: "Undo commit 'x'" }) });
  assert.equal(await s.F.undo(s.store), true);
  assert.deepEqual(writeOps(s.api), ['undo']);
  assert.deepEqual(s.notices(), ["Undid commit 'x'"]);
});

test('redo: success, upstream note, and a failing redo is toasted once', async () => {
  const target = { action: 'delete_branch', description: 'Redo delete of branch b', entry: {} };
  const u = { undo: null, redo: target, busy: false, undoBlocked: null, redoBlocked: null };
  let s = await setup({ undoState: u }, { redo: () => ({ action: 'delete_branch', description: 'Redo delete of branch b', upstreamRestored: false }) });
  assert.equal(await s.F.redo(s.store), true);
  assert.deepEqual(s.notices(), ['Redid delete of branch b (its upstream could not be restored)']);
  s = await setup({ undoState: u }, { redo: () => { throw err('nothing', 'Nothing to redo'); } });
  assert.equal(await s.F.redo(s.store), false);
  assert.deepEqual(s.errors().map((e) => e.message), ['Nothing to redo']);
});

// ------------------------------------------------------------------ fetch / cancel

test('fetch: cancellable (remoteOp while running, cancel aborts it), tag conflicts alert', async () => {
  let finish;
  const s = await setup({}, { fetch: () => new Promise((r) => { finish = r; }) });
  const p = s.F.fetch(s.store);
  await H.flush();
  const call = s.api.calls.find((c) => c.op === 'fetch');
  assert.ok(call.opId, 'ran with an op id');
  assert.deepEqual(s.store.state.remoteOp, { op: 'fetch', opId: call.opId });
  assert.equal(await s.F.cancel(s.store), true);
  assert.deepEqual(s.api.app.cancelled, [call.opId]);
  finish({ tagConflicts: ['v1', 'v2'] });
  assert.equal(await p, true);
  assert.equal(s.store.state.remoteOp, null, 'cleared afterwards');
  assert.equal(s.dialogs[0].type, 'alert');
  assert.match(s.dialogs[0].opts.message, /2 local tags differ/);
  assert.equal(s.dialogs[0].opts.detail, 'v1\nv2');
  assert.equal(await s.F.cancel(s.store), false, 'nothing running');
});

test('fetch: aborted is a notice, auth explains credential helpers, others are toasted', async () => {
  let s = await setup({}, { fetch: () => { throw err('aborted', 'Operation was cancelled'); } });
  assert.equal(await s.F.fetch(s.store), false);
  assert.deepEqual(s.notices(), ['Fetch cancelled']);
  assert.equal(s.errors().length, 0);
  s = await setup({}, { fetch: () => { throw err('auth', 'fatal: Authentication failed'); } });
  assert.equal(await s.F.fetch(s.store), false);
  assert.equal(s.dialogs[0].opts.title, 'Authentication failed');
  assert.match(s.dialogs[0].opts.message, /credential helper/);
  assert.match(s.dialogs[0].opts.message, /ssh-agent/);
  assert.equal(s.errors().length, 0);
});

test('auth message: a credential helper for the platform (osxkeychain on macOS, GCM on Windows, libsecret / GCM on Linux)', async () => {
  const { win, dialogs, F, store } = await setup({}, { fetch: () => { throw err('auth', 'fatal: Authentication failed'); } });
  const { authMessage } = win.PLFlowKit._internal;
  assert.match(authMessage('darwin'), /credential\.helper osxkeychain/);
  assert.doesNotMatch(authMessage('darwin'), /Credential Manager|libsecret/);
  assert.match(authMessage('win32'), /Git Credential Manager, which Git for Windows installs/);
  assert.doesNotMatch(authMessage('win32'), /osxkeychain|libsecret/);
  for (const p of ['linux', 'freebsd']) {
    assert.match(authMessage(p), /Git Credential Manager, or git config --global credential\.helper libsecret/, p);
    assert.doesNotMatch(authMessage(p), /osxkeychain|Git for Windows/, p);
  }
  // The dialog uses the running platform's.
  await F.fetch(store);
  assert.equal(dialogs[0].opts.message, authMessage(win.Components.util.PLATFORM));
});

test("util.PLATFORM / IS_MAC: the preload's window.api.platform, never the user agent; without a preload, linux", () => {
  const file = require.resolve('../renderer/components.js');
  const load = (win) => {
    globalThis.window = win;
    delete require.cache[file];
    require(file);
    return win.Components.util;
  };
  try {
    for (const p of ['darwin', 'win32', 'linux']) {
      const u = load({ api: { platform: p } });
      assert.deepEqual([u.PLATFORM, u.IS_MAC], [p, p === 'darwin'], p);
    }
    for (const win of [{}, { api: {} }, { api: { platform: 7 } }]) assert.equal(load(win).PLATFORM, 'linux', JSON.stringify(win));
    assert.equal(load({}).detectPlatform, undefined, 'no user agent sniffing left');
  } finally {
    H.loadRenderer();
  }
});

test('fetch: {remote} fetches only that remote; no argument (or junk) fetches all', async () => {
  const s = await setup({}, { fetch: () => ({ tagConflicts: [] }) });
  assert.equal(await s.F.fetch(s.store, { remote: 'fork' }), true);
  assert.equal(await s.F.fetch(s.store), true);
  assert.equal(await s.F.fetch(s.store, { remote: '' }), true);
  assert.equal(await s.F.fetch(s.store, { remote: 42 }), true);
  assert.deepEqual(s.api.calls.filter((c) => c.op === 'fetch').map((c) => c.args), [[{ remote: 'fork' }], [{}], [{}], [{}]]);
});

// ------------------------------------------------------------------ pull

test('pullMode: per-repo default, ff-if-possible at first; setPullMode validates and publishes state.pullMode', async () => {
  const s = await setup({}, { pull: (o) => ({ mode: o.mode, before: 'a', after: 'a', fastForward: false, tagConflicts: [] }) });
  assert.equal(s.F.pullMode(s.store), 'ff-if-possible');
  assert.equal(s.F.setPullMode(s.store, 'bogus'), false);
  assert.equal(s.F.setPullMode(s.store, 'rebase'), true);
  assert.equal(s.store.state.pullMode, 'rebase');
  assert.equal(s.F.pullMode(s.store), 'rebase');
  assert.equal(await s.F.pull(s.store), true);
  assert.deepEqual(s.api.calls.find((c) => c.op === 'pull').args, [{ mode: 'rebase' }]);
  assert.equal(await s.F.pull(s.store, 'ff-only'), true);
  assert.deepEqual(s.api.calls.filter((c) => c.op === 'pull')[1].args, [{ mode: 'ff-only' }], 'explicit mode');
  assert.equal(s.F.pullMode(s.store), 'rebase', 'an explicit mode does not change the default');
  assert.match(s.notices()[0], /already up to date/);
  // Another repo has its own default.
  await s.store.actions.loadRepo({ root: '/other', name: 'other' });
  assert.equal(s.F.pullMode(s.store), 'ff-if-possible');
});

test('pull: success messages per outcome', async () => {
  const results = [
    { before: 'a', after: 'b', fastForward: true },
    { before: 'a', after: 'c', fastForward: false },
  ];
  const s = await setup({}, { pull: () => ({ mode: 'ff-if-possible', tagConflicts: [], ...results.shift() }) });
  await s.F.pull(s.store);
  await s.F.pull(s.store);
  assert.deepEqual(s.notices(), ['Fast-forwarded main to origin/main', 'Merged origin/main into main']);
});

test('pull: each error kind gets its explanation; detached HEAD never calls pull', async () => {
  const cases = [
    ['conflicts', /stopped with conflicts/, { stashKept: true, stash: 'f'.repeat(40) }, /safe in a stash \(fffffff\)/],
    ['not-fast-forward', /diverged/],
    ['stash-conflict', /could not be re-applied/, { stashKept: true, stash: 'e'.repeat(40) }, /eeeeeee/],
    ['no-upstream', /Push it first/],
    ['auth', /credential helper/],
  ];
  for (const [kind, re, extra, re2] of cases) {
    const s = await setup({}, { pull: () => { throw err(kind, `git says ${kind}`, extra); } });
    assert.equal(await s.F.pull(s.store), false, kind);
    assert.equal(s.dialogs.length, 1, kind);
    assert.match(s.dialogs[0].opts.message, re, kind);
    if (re2) assert.match(s.dialogs[0].opts.message, re2, kind);
    assert.equal(s.errors().length, 0, `${kind} not toasted`);
  }
  const s = await setup({ branch: null });
  assert.equal(await s.F.pull(s.store), false);
  assert.match(s.dialogs[0].opts.message, /detached/);
  assert.equal(s.api.calls.filter((c) => c.op === 'pull').length, 0);
  // Fetch mode works detached.
  s.api.handlers.pull = () => ({ mode: 'fetch', before: 'a', after: 'a', fastForward: false, tagConflicts: [] });
  assert.equal(await s.F.pull(s.store, 'fetch'), true);
});

// ------------------------------------------------------------------ push

const pushed = (o) => ({ remote: o.remote || 'origin', branch: o.branch, remoteBranch: o.branch, forced: o.force || false });

test('push with an upstream: pushes the current branch, cancellable, and says where', async () => {
  const s = await setup({}, { push: pushed });
  assert.equal(await s.F.push(s.store), true);
  const c = s.api.calls.find((x) => x.op === 'push');
  assert.deepEqual(c.args, [{ branch: 'main' }]);
  assert.ok(c.opId);
  assert.deepEqual(s.notices(), ['Pushed main to origin/main']);
});

test('push without an upstream: confirm "Push and set upstream to origin/<b>?", push, then setUpstream', async () => {
  const s = await setup({ upstream: null, remotes: ['origin'] }, { push: pushed, setUpstream: () => undefined }, [true]);
  assert.equal(await s.F.push(s.store), true);
  assert.equal(s.dialogs[0].type, 'confirm');
  assert.match(s.dialogs[0].opts.message, /Push and set upstream to origin\/main\?/);
  assert.deepEqual(writeOps(s.api), ['push', 'setUpstream']);
  assert.deepEqual(s.api.calls.find((x) => x.op === 'push').args, [{ remote: 'origin', branch: 'main' }]);
  assert.deepEqual(s.api.calls.find((x) => x.op === 'setUpstream').args, ['main', 'origin', 'main']);
});

test('push without an upstream: cancel, several remotes (origin preferred, else chosen), no remotes', async () => {
  let s = await setup({ upstream: null }, { push: pushed }, [false]);
  assert.equal(await s.F.push(s.store), false);
  assert.deepEqual(writeOps(s.api), []);

  s = await setup({ upstream: null, remotes: ['fork', 'origin'] }, { push: pushed, setUpstream: () => undefined }, [true]);
  assert.equal(await s.F.push(s.store), true);
  assert.equal(s.api.calls.find((x) => x.op === 'push').args[0].remote, 'origin');

  s = await setup({ upstream: null, remotes: ['a', 'b'] }, { push: pushed, setUpstream: () => undefined }, ['b', true]);
  assert.equal(await s.F.push(s.store), true);
  assert.equal(s.dialogs[0].type, 'choose');
  assert.deepEqual(s.dialogs[0].opts.choices.map((c) => c.value), ['a', 'b']);
  assert.equal(s.api.calls.find((x) => x.op === 'push').args[0].remote, 'b');

  s = await setup({ upstream: null, remotes: [] }, { push: pushed });
  assert.equal(await s.F.push(s.store), false);
  assert.equal(s.dialogs[0].opts.title, 'No remotes');
});

test('push of another branch uses that branch; its upstream comes from refs', async () => {
  const local = [
    { name: 'main', oid: 'a'.repeat(40), upstream: 'origin/main', current: true },
    { name: 'feat', oid: 'b'.repeat(40), upstream: 'origin/feat', current: false },
  ];
  const s = await setup({ local }, { push: pushed });
  assert.equal(await s.F.push(s.store, { branch: 'feat' }), true);
  assert.deepEqual(s.api.calls.find((x) => x.op === 'push').args, [{ branch: 'feat' }]);
});

test('push rejected-behind: Pull & Push pulls (ff-if-possible) then pushes again', async () => {
  let n = 0;
  const s = await setup({}, {
    push: (o) => { if (++n === 1) throw err('rejected-behind', 'rejected', { reason: 'non-fast-forward' }); return pushed(o); },
    pull: () => ({ mode: 'ff-if-possible', before: 'a', after: 'b', fastForward: false, tagConflicts: [] }),
  }, ['pull']);
  assert.equal(await s.F.push(s.store), true);
  assert.equal(s.dialogs[0].type, 'choose');
  assert.deepEqual(s.dialogs[0].opts.choices.map((c) => c.value).sort(), ['force', 'pull']);
  assert.deepEqual(writeOps(s.api), ['push', 'pull', 'push']);
  assert.deepEqual(s.api.calls.find((x) => x.op === 'pull').args, [{ mode: 'ff-if-possible' }]);
  assert.equal(s.errors().length, 0);
});

test('push rejected-behind: Force Push asks again (danger) and pushes with lease; cancel does nothing', async () => {
  let n = 0;
  const s = await setup({}, {
    push: (o) => { if (++n === 1) throw err('rejected-behind', 'rejected'); return pushed(o); },
  }, ['force', (o) => { assert.equal(o.danger, true); return true; }]);
  assert.equal(await s.F.push(s.store), true);
  assert.deepEqual(s.api.calls.filter((x) => x.op === 'push')[1].args, [{ branch: 'main', force: 'lease' }]);
  assert.deepEqual(s.notices(), ['Force pushed main to origin/main']);

  const c = await setup({}, { push: () => { throw err('rejected-behind', 'rejected'); } }, [null]);
  assert.equal(await c.F.push(c.store), false);
  assert.deepEqual(writeOps(c.api), ['push']);
  assert.equal(c.errors().length, 0);
});

test('push rejected-behind for a branch that is not checked out offers no pull', async () => {
  const local = [
    { name: 'main', oid: 'a'.repeat(40), upstream: 'origin/main', current: true },
    { name: 'feat', oid: 'b'.repeat(40), upstream: 'origin/feat', current: false },
  ];
  const s = await setup({ local }, { push: () => { throw err('rejected-behind', 'rejected'); } }, [null]);
  await s.F.push(s.store, { branch: 'feat' });
  assert.deepEqual(s.dialogs[0].opts.choices.map((c) => c.value), ['force']);
});

test('push: stale lease offers Fetch; hook rejection shows the remote message; auth; other kinds toast', async () => {
  let s = await setup({}, { push: () => { throw err('rejected-stale', 'stale', { reason: 'stale info' }); }, fetch: () => ({ tagConflicts: [] }) }, ['fetch']);
  assert.equal(await s.F.push(s.store), false);
  assert.deepEqual(s.dialogs[0].opts.choices.map((c) => c.value), ['fetch']);
  assert.deepEqual(writeOps(s.api), ['push', 'fetch']);

  s = await setup({}, { push: () => { throw err('rejected-hook', 'hook', { remoteMessage: 'protected branch' }); } });
  assert.equal(await s.F.push(s.store), false);
  assert.equal(s.dialogs[0].opts.title, 'Push rejected by the remote');
  assert.equal(s.dialogs[0].opts.detail, 'protected branch');

  s = await setup({}, { push: () => { throw err('auth', 'Permission denied (publickey)'); } });
  assert.equal(await s.F.push(s.store), false);
  assert.equal(s.dialogs[0].opts.title, 'Authentication failed');
  assert.equal(s.dialogs[0].opts.detail, 'Permission denied (publickey)', "git's own message");

  s = await setup({}, { push: () => { throw err('rejected', 'weird'); } });
  assert.equal(await s.F.push(s.store), false);
  assert.deepEqual(s.errors().map((e) => e.message), ['weird']);

  s = await setup({}, { push: () => { throw err('aborted', 'cancelled'); } });
  assert.equal(await s.F.push(s.store), false);
  assert.deepEqual(s.notices(), ['Push cancelled']);
});

test('push rejected-stale "fetch first" offers Fetch only, never Force Push', async () => {
  const s = await setup({}, { push: () => { throw err('rejected-stale', 'rejected', { reason: 'fetch first' }); }, fetch: () => ({ tagConflicts: [] }) }, ['fetch']);
  assert.equal(await s.F.push(s.store), false);
  assert.equal(s.dialogs.length, 1);
  assert.deepEqual(s.dialogs[0].opts.choices.map((c) => c.value), ['fetch']);
  assert.ok(!s.dialogs[0].opts.choices.some((c) => c.danger));
  assert.match(s.dialogs[0].opts.message, /haven't fetched yet/);
  assert.doesNotMatch(s.dialogs[0].opts.message, /force/i);
  assert.deepEqual(writeOps(s.api), ['push', 'fetch']);
  assert.equal(s.errors().length, 0);
});

test('push without an upstream: a failing setUpstream after the push is toasted once; the push still counts', async () => {
  const s = await setup({ upstream: null, remotes: ['origin'] }, {
    push: pushed,
    setUpstream: () => { throw err('config', 'could not lock config file'); },
  }, [true]);
  assert.equal(await s.F.push(s.store), true, 'the push went through');
  assert.deepEqual(writeOps(s.api), ['push', 'setUpstream']);
  assert.deepEqual(s.errors().map((e) => e.message), ['could not lock config file']);
  assert.deepEqual(s.notices(), ['Pushed main to origin/main']);
});

test('push without an upstream: a failed remotes read says so, not "no remotes"', async () => {
  const logged = [];
  const saved = console.error;
  console.error = (...a) => logged.push(a);
  try {
    const s = await setup({ upstream: null }, { remotes: () => { throw err('boom', 'fatal: bad config line 3'); }, push: pushed });
    assert.equal(s.store.state.remotesError, 'fatal: bad config line 3', 'the first load recorded it');
    assert.equal(await s.F.push(s.store), false);
    assert.equal(s.dialogs[0].opts.title, "Couldn't read remotes");
    assert.equal(s.dialogs[0].opts.message, "Couldn't read remotes: fatal: bad config line 3");
    assert.deepEqual(writeOps(s.api), []);
    assert.ok(logged.length >= 2 && logged.every((a) => /could not read the remotes/.test(a[0])), 'logged');
    // Readable again: the error clears and an empty list is "no remotes".
    s.api.handlers.remotes = () => [];
    assert.equal(await s.F.push(s.store), false);
    assert.equal(s.store.state.remotesError, null);
    assert.equal(s.dialogs[1].opts.title, 'No remotes');
  } finally {
    console.error = saved;
  }
});

test('push: detached HEAD alerts; an upstream that turns out missing goes to the set-upstream path', async () => {
  let s = await setup({ branch: null });
  assert.equal(await s.F.push(s.store), false);
  assert.match(s.dialogs[0].opts.message, /detached/);
  let n = 0;
  s = await setup({}, {
    push: (o) => { if (++n === 1) throw err('no-upstream', 'no upstream'); return pushed(o); },
    setUpstream: () => undefined,
  }, [true]);
  assert.equal(await s.F.push(s.store), true);
  assert.deepEqual(writeOps(s.api), ['push', 'push', 'setUpstream']);
});

test('setUpstream: picks the remote and asks for the remote branch', async () => {
  const s = await setup({ remotes: ['origin'] }, { setUpstream: () => undefined }, [(o) => { assert.equal(o.value, 'feat'); assert.equal(o.validate(''), 'Enter a branch name'); return ' feat2 '; }]);
  assert.equal(await s.F.setUpstream(s.store, 'feat'), true);
  assert.deepEqual(s.api.calls.find((x) => x.op === 'setUpstream').args, ['feat', 'origin', 'feat2']);
});

// ------------------------------------------------------------------ checkout

test('checkout: local branch, the current branch is a no-op', async () => {
  const s = await setup({}, { checkout: () => ({ branch: 'dev', oid: 'x' }) });
  assert.equal(await s.F.checkout(s.store, { target: 'main', kind: 'local' }), false);
  assert.equal(await s.F.checkout(s.store, { target: 'dev', kind: 'local' }), true);
  assert.deepEqual(s.api.calls.filter((c) => c.op === 'checkout').map((c) => c.args), [['dev', { kind: 'local' }]]);
  assert.equal(s.dialogs.length, 0);
});

test('checkout of a commit confirms the detached HEAD first', async () => {
  const sha = 'c'.repeat(40);
  let s = await setup({}, { checkout: () => ({ branch: null, oid: sha }) }, [false]);
  assert.equal(await s.F.checkout(s.store, { target: sha, kind: 'commit' }), false);
  assert.match(s.dialogs[0].opts.message, /detached HEAD/);
  assert.deepEqual(writeOps(s.api), []);
  s = await setup({}, { checkout: () => ({ branch: null, oid: sha }) }, [true]);
  assert.equal(await s.F.checkout(s.store, { target: sha, kind: 'commit' }), true);
  assert.deepEqual(s.api.calls.find((c) => c.op === 'checkout').args, [sha, { kind: 'commit' }]);
});

test('checkout remote: local-exists offers the local branch; stash-conflict explains where the changes are', async () => {
  let s = await setup({}, {
    checkout: (t, o) => { if (o.kind === 'remote') throw err('local-exists', 'exists', { branch: 'feat' }); return { branch: t }; },
  }, [true]);
  assert.equal(await s.F.checkout(s.store, { target: 'origin/feat', kind: 'remote' }), true);
  assert.deepEqual(s.api.calls.filter((c) => c.op === 'checkout').map((c) => c.args), [['origin/feat', { kind: 'remote' }], ['feat', { kind: 'local' }]]);
  assert.match(s.dialogs[0].opts.message, /already exists/);

  s = await setup({}, { checkout: () => { throw err('local-exists', 'exists', { branch: 'feat' }); } }, [false]);
  assert.equal(await s.F.checkout(s.store, { target: 'origin/feat', kind: 'remote' }), false);
  assert.equal(s.api.calls.filter((c) => c.op === 'checkout').length, 1);

  s = await setup({}, { checkout: () => { throw err('stash-conflict', 'conflict', { stashKept: true, stash: 'd'.repeat(40) }); } });
  assert.equal(await s.F.checkout(s.store, { target: 'dev' }), false);
  assert.match(s.dialogs[0].opts.message, /ddddddd/);
  assert.equal(s.errors().length, 0);
});

// ------------------------------------------------------------------ branches

test('branchNameError: empty, spaces, leading dash, git syntax, existing and prefix clashes', async () => {
  const { F } = await setup();
  const refs = { local: [{ name: 'main' }, { name: 'feat/a' }] };
  assert.equal(F.branchNameError('', refs), 'Enter a branch name');
  assert.match(F.branchNameError('my branch', refs), /spaces/);
  assert.match(F.branchNameError('-x', refs), /start with '-'/);
  for (const bad of ['a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', '@', 'HEAD', 'a@{1}', 'a/', '/a', 'a//b', 'a.', '.a', 'a/.b', 'x.lock']) {
    assert.ok(F.branchNameError(bad, refs), bad);
  }
  assert.match(F.branchNameError('main', refs), /already exists/);
  assert.match(F.branchNameError('feat', refs), /conflicts with the existing branch 'feat\/a'/);
  assert.match(F.branchNameError('main/x', refs), /conflicts/);
  assert.equal(F.branchNameError('feature/new-thing', refs), null);
});

test('createBranch: prompt validates against the loaded refs; creates and checks out by default', async () => {
  const s = await setup({}, { createBranch: (name) => ({ name, sha: 'a'.repeat(40) }) }, [
    (o) => { assert.match(o.validate('main'), /already exists/); assert.equal(o.validate(' ok '), null); return ' topic '; },
    'other',
    null,
  ]);
  assert.equal(await s.F.createBranch(s.store), true);
  assert.deepEqual(s.api.calls.find((c) => c.op === 'createBranch').args, ['topic', { checkout: true }]);
  const start = 'b'.repeat(40);
  assert.equal(await s.F.createBranch(s.store, { start, checkout: false }), true);
  assert.deepEqual(s.api.calls.filter((c) => c.op === 'createBranch')[1].args, ['other', { start, checkout: false }]);
  assert.match(s.dialogs[1].opts.message, /bbbbbbb/);
  assert.equal(await s.F.createBranch(s.store, {}), false, 'cancelled');
  assert.equal(s.api.calls.filter((c) => c.op === 'createBranch').length, 2);
});

test('createBranch at a start commit: the message names it, args carry start and checkout', async () => {
  const start = 'c'.repeat(40);
  const s = await setup({}, { createBranch: (name) => ({ name, sha: start }) }, [
    (o) => { assert.equal(o.okLabel, 'Create & Check Out'); return 'at-c'; },
    (o) => { assert.equal(o.okLabel, 'Create'); return 'at-c2'; },
  ]);
  assert.equal(await s.F.createBranch(s.store, { start }), true);
  assert.equal(s.dialogs[0].opts.message, 'The new branch starts at ccccccc and is checked out.');
  assert.deepEqual(s.api.calls.find((c) => c.op === 'createBranch').args, ['at-c', { start, checkout: true }]);
  assert.equal(await s.F.createBranch(s.store, { start, checkout: false }), true);
  assert.equal(s.dialogs[1].opts.message, 'The new branch starts at ccccccc.');
  assert.deepEqual(s.api.calls.filter((c) => c.op === 'createBranch')[1].args, ['at-c2', { start, checkout: false }]);
});

test('createBranch with local changes: stash-conflict and a kept stash are explained like checkout', async () => {
  let s = await setup({ dirty: true }, { createBranch: () => { throw err('stash-conflict', 'conflict', { stashKept: true, stash: 'e'.repeat(40) }); } }, ['topic']);
  assert.equal(await s.F.createBranch(s.store, { start: 'b'.repeat(40) }), false);
  assert.equal(s.dialogs[1].type, 'alert');
  assert.equal(s.dialogs[1].opts.title, 'Branch created, but your changes conflicted');
  assert.match(s.dialogs[1].opts.message, /new branch topic/);
  assert.match(s.dialogs[1].opts.message, /eeeeeee/);
  assert.equal(s.errors().length, 0, 'quiet: not toasted');

  s = await setup({ dirty: true }, { createBranch: () => { throw err('hook-failed', 'post-checkout hook failed', { stashKept: true, stash: 'f'.repeat(40) }); } }, ['topic']);
  assert.equal(await s.F.createBranch(s.store, {}), false);
  assert.equal(s.dialogs[1].opts.title, 'Create branch failed');
  assert.match(s.dialogs[1].opts.message, /post-checkout hook failed[\s\S]*fffffff/);

  s = await setup({}, { createBranch: () => { throw err('invalid-args', "Invalid branch name: 'x'"); } }, ['x']);
  assert.equal(await s.F.createBranch(s.store, {}), false);
  assert.deepEqual(s.errors().map((e) => e.message), ["Invalid branch name: 'x'"], 'other errors are toasted once');
  assert.equal(s.dialogs.length, 1);
});

test('deleteBranch: current branch refused; confirm (danger); not merged asks to force', async () => {
  let s = await setup();
  assert.equal(await s.F.deleteBranch(s.store, 'main'), false);
  assert.match(s.dialogs[0].opts.title, /current branch/);

  s = await setup({}, { deleteBranch: (n) => ({ name: n, sha: 'a'.repeat(40), upstream: null }) }, [false]);
  assert.equal(await s.F.deleteBranch(s.store, 'old'), false);
  assert.equal(s.dialogs[0].opts.danger, true);
  assert.deepEqual(writeOps(s.api), []);

  let n = 0;
  s = await setup({}, {
    deleteBranch: (name, o) => { if (++n === 1) throw err('not-merged', 'not fully merged'); return { name, sha: 'a'.repeat(40), upstream: null, forced: o.force }; },
  }, [true, true]);
  assert.equal(await s.F.deleteBranch(s.store, 'old'), true);
  assert.deepEqual(s.api.calls.filter((c) => c.op === 'deleteBranch').map((c) => c.args), [['old', {}], ['old', { force: true }]]);
  assert.equal(s.dialogs[1].opts.confirmLabel, 'Force Delete');
  assert.equal(s.errors().length, 0);
  assert.match(s.notices()[0], /Deleted branch old/);

  s = await setup({}, { deleteBranch: () => { throw err('not-merged', 'x'); } }, [true, false]);
  assert.equal(await s.F.deleteBranch(s.store, 'old'), false);
  assert.equal(s.api.calls.filter((c) => c.op === 'deleteBranch').length, 1);

  s = await setup({}, { deleteBranch: (name) => ({ name, sha: 'a', upstream: null, undoRecorded: false, warning: 'could not record' }) }, [true]);
  assert.equal(await s.F.deleteBranch(s.store, 'old'), true);
  assert.equal(s.dialogs[1].opts.message, 'could not record');
});

// ------------------------------------------------------------------ stash

const STASHES = [
  { index: 0, ref: 'stash@{0}', hash: '1'.repeat(40), message: 'On main: newest' },
  { index: 1, ref: 'stash@{1}', hash: '2'.repeat(40), message: 'On main: older' },
];

test('stashSave: refuses politely when clean; optional message', async () => {
  let s = await setup();
  assert.equal(await s.F.stashSave(s.store), false);
  assert.deepEqual(s.notices(), ['There are no local changes to stash']);
  assert.equal(s.dialogs.length, 0);

  s = await setup({ dirty: true }, { stashPush: () => '9'.repeat(40) }, [' my work ', '', null]);
  assert.equal(await s.F.stashSave(s.store), true);
  assert.equal(await s.F.stashSave(s.store), true);
  assert.equal(await s.F.stashSave(s.store), false, 'cancelled');
  assert.deepEqual(s.api.calls.filter((c) => c.op === 'stashPush').map((c) => c.args), [['my work'], []]);

  s = await setup({ dirty: true }, { stashPush: () => null }, ['']);
  assert.equal(await s.F.stashSave(s.store), false);
  assert.deepEqual(s.notices(), ['Nothing was stashed']);
});

test('stashPop / stashApply: newest by default; accepts a hash, an index or a stash item', async () => {
  const s = await setup({ stashes: STASHES }, { stashPop: (r) => ({ hash: r, indexRestored: true, dropped: true }), stashApply: (r) => ({ hash: r, indexRestored: false }) });
  assert.equal(await s.F.stashPop(s.store), true);
  assert.equal(await s.F.stashPop(s.store, STASHES[1].hash), true);
  assert.equal(await s.F.stashPop(s.store, 1), true);
  assert.equal(await s.F.stashApply(s.store, STASHES[1]), true);
  assert.deepEqual(s.api.calls.filter((c) => /^stash(Pop|Apply)$/.test(c.op)).map((c) => c.args[0]),
    [STASHES[0].hash, STASHES[1].hash, STASHES[1].hash, STASHES[1].hash]);
  assert.match(s.notices()[0], /Popped stash@\{0\}: On main: newest/);
  assert.match(s.notices()[3], /staged changes could not be restored/);
});

test('stash pop conflicts alert (stash kept); no stashes is a notice; drop confirms (danger)', async () => {
  let s = await setup({ stashes: STASHES }, { stashPop: () => { throw err('conflicts', 'CONFLICT (content)'); } });
  assert.equal(await s.F.stashPop(s.store), false);
  assert.match(s.dialogs[0].opts.message, /stash was kept/);
  assert.equal(s.errors().length, 0);

  s = await setup();
  assert.equal(await s.F.stashPop(s.store), false);
  assert.equal(await s.F.stashDrop(s.store), false);
  assert.deepEqual(s.notices(), ['There are no stashes', 'There are no stashes']);

  s = await setup({ stashes: STASHES }, { stashDrop: () => undefined }, [false, true]);
  assert.equal(await s.F.stashDrop(s.store, STASHES[1].hash), false);
  assert.equal(s.dialogs[0].opts.danger, true);
  assert.match(s.dialogs[0].opts.message, /older/);
  assert.equal(await s.F.stashDrop(s.store, STASHES[1].hash), true);
  assert.deepEqual(s.api.calls.filter((c) => c.op === 'stashDrop').map((c) => c.args), [[STASHES[1].hash]]);
  assert.deepEqual(s.notices(), ['Dropped stash@{1}: On main: older']);
});

test('stashDrop: an entry that is already gone is a notice and resolves false', async () => {
  let s = await setup({ stashes: STASHES }, { stashDrop: () => false }, [true]);
  assert.equal(await s.F.stashDrop(s.store), false);
  assert.deepEqual(s.notices(), ['stash@{0}: On main: newest was already gone']);
  s = await setup({ stashes: STASHES }, { stashDrop: () => { throw err('no-stash', 'No stash entry'); } }, [true]);
  assert.equal(await s.F.stashDrop(s.store), false);
  assert.deepEqual(s.notices(), ['stash@{0}: On main: newest was already gone']);
  assert.equal(s.errors().length, 0);
  s = await setup({ stashes: STASHES }, { stashDrop: () => { throw err('boom', 'disk full'); } }, [true]);
  assert.equal(await s.F.stashDrop(s.store), false);
  assert.deepEqual(s.errors().map((e) => e.message), ['disk full']);
});

// ------------------------------------------------------------------ terminal

test('openTerminal: app-level call, allowed while busy; failures are toasted', async () => {
  const s = await setup();
  s.store.set({ busy: true });
  assert.equal(await s.F.openTerminal(s.store), true);
  assert.equal(s.api.app.terminals, 1);
  s.api.app.openTerminal = () => Promise.reject({ message: 'Could not open a terminal', kind: 'no-terminal' });
  assert.equal(await s.F.openTerminal(s.store), false);
  assert.deepEqual(s.errors().map((e) => e.message), ['Could not open a terminal']);
});

// ------------------------------------------------------------------ store additions

test('store: remotes are read on the first load and when refs change, not on idle refreshes', async () => {
  const s = await setup({ remotes: ['origin', 'fork'] });
  assert.deepEqual(s.store.state.remotes, ['origin', 'fork']);
  const count = () => s.api.calls.filter((c) => c.op === 'remotes').length;
  assert.equal(count(), 1);
  await s.store.actions.refresh();
  await H.flush();
  assert.equal(count(), 1, 'idle refresh');
  s.data.refs = H.refs({ local: [{ name: 'main', oid: 'a'.repeat(40), upstream: 'origin/main', current: true }, { name: 'x', oid: 'a'.repeat(40), upstream: null }] });
  await s.store.actions.refresh();
  await H.flush();
  assert.equal(count(), 2, 'refs changed');
  const logged = [];
  const saved = console.error;
  console.error = (...a) => logged.push(a);
  try {
    s.api.handlers.remotes = () => { throw err('boom'); };
    assert.deepEqual(await s.store.actions.loadRemotes(), ['origin', 'fork'], 'kept on failure');
    assert.equal(s.store.state.remotesError, 'boom');
    assert.equal(logged.length, 1, 'logged, not swallowed');
  } finally {
    console.error = saved;
  }
  s.api.handlers.remotes = () => ['origin'];
  assert.deepEqual(await s.store.actions.loadRemotes(), ['origin']);
  assert.equal(s.store.state.remotesError, null, 'cleared by the next read');
});

test('store: notify sends an info notice through the toast hook', async () => {
  const s = await setup();
  s.store.actions.notify('hello');
  assert.deepEqual(s.toasts.at(-1), { message: 'hello', level: 'info' });
});

// ------------------------------------------------------------------ DOM: dialogs and menus

function domSetup() {
  const dom = H.fakeDom().install();
  const win = H.loadFlows();
  dom.attach(win);
  return { dom, win, C: win.Components };
}

const buttonsOf = (dom) => dom.document.body.findAll((n) => n.tagName === 'BUTTON');
const byClass = (dom, cls) => dom.document.body.findAll((n) => n.classList && n.classList.contains(cls));

test('prompt: validate shows the error inline and blocks OK; Enter submits; Esc cancels', async () => {
  const { dom, C } = domSetup();
  const p = C.dialog.prompt({ title: 'Name', label: 'Branch name', validate: (v) => (v.trim() ? (v.includes(' ') ? 'no spaces' : null) : 'required') });
  assert.equal(C.dialog.isOpen(), true);
  const input = dom.document.activeElement;
  assert.equal(input.tagName, 'INPUT', 'the field is focused');
  const [cancel, ok] = buttonsOf(dom);
  assert.equal(ok.disabled, true, 'empty initial value: OK disabled');
  const error = byClass(dom, 'dlg-error')[0];
  assert.equal(error.hidden, true, 'no message before typing');
  input.value = 'a b';
  dom.dispatch(input, 'input');
  assert.equal(error.textContent, 'no spaces');
  assert.equal(error.hidden, false);
  dom.key('Enter');
  assert.equal(C.dialog.isOpen(), true, 'Enter blocked while invalid');
  ok.click();
  assert.equal(C.dialog.isOpen(), true, 'OK blocked while invalid');
  input.value = 'good';
  dom.dispatch(input, 'input');
  assert.equal(error.hidden, true);
  assert.equal(ok.disabled, false);
  dom.key('Enter');
  assert.equal(await p, 'good');
  assert.equal(C.dialog.isOpen(), false);
  assert.equal(dom.document.body.children.length, 0, 'removed');
  void cancel;

  const p2 = C.dialog.prompt({ title: 'x', value: 'pre' });
  dom.key('Escape');
  assert.equal(await p2, null);
  const p3 = C.dialog.prompt({ title: 'x', value: 'pre' });
  buttonsOf(dom)[0].click();
  assert.equal(await p3, null, 'Cancel button');
});

test('choose: returns the picked value, null on Esc; a danger dialog focuses Cancel', async () => {
  const { dom, C } = domSetup();
  const p = C.dialog.choose({ title: 'Push rejected', choices: [{ value: 'force', label: 'Force', danger: true }, { value: 'pull', label: 'Pull', primary: true }] });
  const [cancel, force, pull] = buttonsOf(dom);
  assert.equal(dom.document.activeElement, pull, 'primary focused');
  assert.deepEqual([cancel.textContent, force.textContent, pull.textContent], ['Cancel', 'Force', 'Pull']);
  force.click();
  assert.equal(await p, 'force');
  const p2 = C.dialog.choose({ title: 't', danger: true, choices: [{ value: 'x', label: 'X' }] });
  assert.equal(dom.document.activeElement.textContent, 'Cancel');
  dom.key('Escape');
  assert.equal(await p2, null);
});

test('choose: a danger choice is never focused by default; when every choice is danger, Enter cancels', async () => {
  const { dom, C } = domSetup();
  let p = C.dialog.choose({ title: 'Push rejected', choices: [{ value: 'force', label: 'Force Push…', danger: true }] });
  assert.equal(dom.document.activeElement.textContent, 'Cancel');
  dom.key('Enter');
  assert.equal(await p, null, 'Enter cancelled');
  p = C.dialog.choose({ title: 't', choices: [{ value: 'a', label: 'A' }, { value: 'x', label: 'X', danger: true, primary: true }] });
  assert.equal(dom.document.activeElement.textContent, 'Cancel', 'a danger primary is not focused either');
  dom.key('Enter');
  assert.equal(await p, null);
  p = C.dialog.choose({ title: 't', choices: [{ value: 'x', label: 'X', danger: true }, { value: 'a', label: 'A' }] });
  assert.equal(dom.document.activeElement.textContent, 'A', 'the last (safe) choice by default');
  dom.key('Enter');
  assert.equal(await p, 'a');
});

test('confirm (danger): Enter only confirms on the confirm button; Enter on Cancel cancels', async () => {
  const { dom, C } = domSetup();
  let p = C.dialog.confirm({ title: 'Delete?', danger: true, confirmLabel: 'Delete' });
  const [cancel, ok] = buttonsOf(dom);
  assert.equal(dom.document.activeElement, cancel);
  dom.key('Enter');
  assert.equal(await p, false);
  p = C.dialog.confirm({ title: 'Delete?', danger: true });
  buttonsOf(dom)[1].focus();
  dom.key('Enter');
  assert.equal(await p, true);
  p = C.dialog.confirm({ title: 'Plain' });
  dom.key('Enter');
  assert.equal(await p, true);
  void ok;
});

test('confirm (defaultCancel): Cancel focused and Enter cancels like a danger dialog, without the danger style', async () => {
  const { dom, C } = domSetup();
  let p = C.dialog.confirm({ title: 'Rewrite pushed commits?', confirmLabel: 'Rebase Anyway', defaultCancel: true });
  const [cancel, ok] = buttonsOf(dom);
  assert.equal(dom.document.activeElement, cancel);
  assert.equal(ok.classList.contains('btn-primary'), true);
  assert.equal(byClass(dom, 'dlg-danger').length, 0);
  dom.key('Enter');
  assert.equal(await p, false, 'Enter cancelled');
  p = C.dialog.confirm({ title: 't', defaultCancel: true });
  buttonsOf(dom)[1].focus();
  dom.key('Enter');
  assert.equal(await p, true, 'Enter on the confirm button confirms');
});

test('menu: roles, textContent labels, arrows skip disabled/separators, Enter runs after closing', async () => {
  const { dom, C } = domSetup();
  const ran = [];
  const root = C.menu.open({ x: 10, y: 20 }, [
    { label: '<b>Check out</b>', action: () => ran.push(['a', C.menu.isOpen()]) },
    { separator: true },
    { label: 'Disabled', action: () => ran.push('x'), disabled: true },
    { label: 'Delete', action: () => ran.push('c'), danger: true },
  ]);
  assert.equal(root.getAttribute('role'), 'menu');
  const items = root.children.filter((n) => n.getAttribute('role') === 'menuitem');
  assert.equal(items.length, 3);
  assert.equal(items[0].textContent, '<b>Check out</b>', 'text, not markup');
  assert.equal(items[1].getAttribute('aria-disabled'), 'true');
  assert.ok(items[2].classList.contains('pl-menu-danger'));
  assert.equal(root.style.left, '10px');
  assert.equal(root.style.top, '20px');
  assert.equal(dom.document.activeElement, items[0], 'first enabled item focused');
  dom.key('ArrowDown');
  assert.equal(dom.document.activeElement, items[2], 'skips separator and disabled');
  dom.key('ArrowDown');
  assert.equal(dom.document.activeElement, items[0], 'wraps');
  dom.key('ArrowUp');
  assert.equal(dom.document.activeElement, items[2]);
  dom.key('Home');
  dom.key('Enter');
  assert.deepEqual(ran, [['a', false]], 'action ran once the menu was closed');
  assert.equal(C.menu.isOpen(), false);
  assert.equal(dom.document.body.children.length, 0);
});

test('menu: a disabled item shows its reason (title) under the label, aria-hidden and as the row\'s aria-description', () => {
  const { C } = domSetup();
  const root = C.menu.open({ x: 0, y: 0 }, [
    { label: 'Merge', action: () => {}, title: 'Merge main into feat' },
    { label: 'Rebase feat onto main', action: () => {}, disabled: true, title: 'feat is already based on <main>' },
    { label: 'Checkout', action: () => {}, disabled: true },
    { label: 'Checked', action: () => {}, disabled: true, checked: true, title: 'why' },
  ]);
  const rows = root.children;
  const hintOf = (row) => row.children.find((n) => n.classList.contains('pl-menu-hint'));
  assert.equal(hintOf(rows[0]), undefined, 'an enabled item keeps its title as a tooltip only');
  assert.equal(rows[0].getAttribute('aria-description'), null);
  const hint = hintOf(rows[1]);
  assert.equal(hint.textContent, 'feat is already based on <main>', 'text, not markup');
  assert.equal(hint.getAttribute('aria-hidden'), 'true');
  assert.equal(rows[1].getAttribute('aria-description'), 'feat is already based on <main>');
  assert.equal(rows[1].getAttribute('aria-disabled'), 'true');
  assert.ok(rows[1].classList.contains('pl-menu-has-hint'));
  assert.equal(rows[1].children.find((n) => n.classList.contains('pl-menu-label')).textContent, 'Rebase feat onto main', 'the label is unchanged');
  assert.equal(hintOf(rows[2]), undefined, 'no title: no hint');
  assert.ok(hintOf(rows[3]).classList.contains('pl-menu-hint-indent'), 'lined up past the check column');
  C.menu.close();
});

test('menu: Esc, outside mousedown, blur and a second menu close it; clicks on disabled items do nothing', async () => {
  const { dom, C } = domSetup();
  const before = new dom.El('button');
  dom.document.body.append(before);
  before.focus();
  let ran = 0;
  C.menu.open({ x: 0, y: 0 }, [{ label: 'A', action: () => ran++ }, { label: 'B', disabled: true, action: () => ran++ }]);
  dom.key('Escape');
  assert.equal(C.menu.isOpen(), false);
  assert.equal(dom.document.activeElement, before, 'focus restored');

  const root = C.menu.open({ x: 0, y: 0 }, [{ label: 'A', action: () => ran++ }, { label: 'B', disabled: true, action: () => ran++ }]);
  root.children[1].click();
  assert.equal(C.menu.isOpen(), true, 'disabled click ignored');
  dom.dispatch(before, 'mousedown');
  assert.equal(C.menu.isOpen(), false, 'outside mousedown');

  C.menu.open({ x: 0, y: 0 }, [{ label: 'A', action: () => ran++ }]);
  dom.dispatch(dom.window, 'blur');
  assert.equal(C.menu.isOpen(), false, 'window blur');

  const first = C.menu.open({ x: 0, y: 0 }, [{ label: 'A', action: () => ran++ }]);
  C.menu.open({ x: 0, y: 0 }, [{ label: 'B', action: () => ran++ }]);
  assert.equal(first.parentNode, null, 'one menu at a time');
  C.menu.close();
  assert.equal(C.menu.isOpen(), false);
  assert.equal(ran, 0);
});

test('menu: an element anchor opens below it and is clamped into the window; checked items', () => {
  const { dom, C } = domSetup();
  const btn = new dom.El('button');
  btn.rect = { left: 1150, top: 10, right: 1190, bottom: 40, width: 40, height: 30 };
  dom.document.body.append(btn);
  const root = C.menu.open(btn, [{ label: 'FF if possible', checked: true, action() {} }, { label: 'Rebase', checked: false, action() {} }]);
  assert.equal(root.style.top, '42px');
  assert.equal(root.children[0].getAttribute('role'), 'menuitemcheckbox');
  assert.equal(root.children[0].getAttribute('aria-checked'), 'true');
  C.menu.close();
  const { place } = C.menu;
  assert.deepEqual(place({ x: 1150, y: 42 }, 200, 100, 1200, 800), { left: 996, top: 42 }, 'clamped left');
  assert.deepEqual(place({ x: 10, y: 790, below: { top: 760 } }, 100, 100, 1200, 800), { left: 10, top: 660 }, 'flipped above');
});

test('menu.filter: case-insensitive label substring; pinned items stay; separators only between shown items', () => {
  const { C } = domSetup();
  const items = [
    { label: 'main' }, { label: 'feat/Login' }, { label: 'fix/login-typo' }, { separator: true }, { label: 'New branch…', pinned: true },
  ];
  assert.deepEqual(C.menu.filter(items, ''), { shown: [0, 1, 2, 3, 4], matched: [] }, 'no query: everything, nothing matched');
  assert.deepEqual(C.menu.filter(items, '  LOGIN '), { shown: [1, 2, 3, 4], matched: [1, 2] }, 'trimmed, any case');
  assert.deepEqual(C.menu.filter(items, 'nothing'), { shown: [4], matched: [] }, 'no leading separator before the pinned item');
  assert.deepEqual(C.menu.filter(items, 'NEW'), { shown: [4], matched: [4] }, 'a pinned item that matches counts');
  assert.deepEqual(C.menu.filter([{ label: 'a' }, { separator: true }, { separator: true }, { label: 'ab' }, { separator: true }], 'a').shown, [0, 1, 3], 'no double or trailing separator');
  assert.deepEqual(C.menu.filter(null, 'x'), { shown: [], matched: [] });
});

test('menu search mode: the field takes focus; typing filters, highlights the first match, empty state; arrows, Enter', async () => {
  const { dom, C } = domSetup();
  const ran = [];
  const root = C.menu.open({ x: 0, y: 0 }, [
    { label: 'main', checked: true, action: () => ran.push('main') },
    { label: 'feat/login', checked: false, action: () => ran.push('feat/login') },
    { label: 'fix/login-typo', checked: false, disabled: true, title: 'busy', action: () => ran.push('x') },
    { label: 'feat/<b>ui</b>', checked: false, action: () => ran.push('ui') },
    { separator: true },
    { label: 'New branch…', pinned: true, action: () => ran.push('new') },
  ], { search: { label: 'Filter branches', placeholder: 'Filter branches', empty: 'No branches match' } });
  const input = root.findAll((n) => n.tagName === 'INPUT')[0];
  const listbox = root.findAll((n) => n.getAttribute('role') === 'listbox')[0];
  const options = listbox.children.filter((n) => n.getAttribute('role') === 'option');
  const empty = root.children.find((n) => n.classList.contains('pl-menu-empty'));
  const shown = () => options.filter((o) => !o.hidden).map((o) => o.children.find((n) => n.classList.contains('pl-menu-label')).textContent);
  const activeId = () => input.getAttribute('aria-activedescendant');
  const type = (text) => { input.value = text; dom.dispatch(input, 'input'); };

  assert.equal(root.getAttribute('role'), 'dialog');
  assert.equal(root.getAttribute('aria-label'), 'Filter branches');
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-controls'), listbox.id);
  assert.equal(input.getAttribute('aria-label'), 'Filter branches');
  assert.equal(input.placeholder, 'Filter branches');
  assert.equal(dom.document.activeElement, input, 'autofocused');
  assert.equal(input.value, '');
  assert.equal(options.length, 5);
  assert.equal(options[0].getAttribute('aria-checked'), 'true', 'the current item keeps its check');
  assert.equal(activeId(), options[0].id);
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  assert.equal(empty.getAttribute('role'), 'status', 'the empty state: a status beside the field, not in the listbox');
  assert.equal(listbox.contains(empty), false);
  assert.equal(empty.hidden, false, 'always in the accessibility tree');
  assert.equal(empty.textContent, '', 'silent while something matches');
  assert.ok(listbox.children.every((n) => ['option', 'presentation'].includes(n.getAttribute('role'))), 'the listbox holds options (separators are presentational)');
  assert.ok(options.every((o) => o.tabIndex === undefined), 'the rows are not focusable');
  assert.equal(root.tabIndex, undefined);

  type('LOGIN');
  assert.deepEqual(shown(), ['feat/login', 'fix/login-typo', 'New branch…']);
  assert.equal(activeId(), options[1].id, 'the first match is highlighted');
  assert.equal(options[0].getAttribute('aria-selected'), 'false');
  dom.key('ArrowDown');
  assert.equal(activeId(), options[4].id, 'skips the disabled match and the hidden separator');
  dom.key('ArrowDown');
  assert.equal(activeId(), options[1].id, 'wraps over the shown items only');
  dom.key('ArrowUp');
  assert.equal(activeId(), options[4].id);
  assert.equal(dom.document.activeElement, input, 'the field keeps focus');

  type('<b>');
  assert.deepEqual(shown(), ['feat/<b>ui</b>', 'New branch…'], 'plain text match');
  type('zzz');
  assert.deepEqual(shown(), ['New branch…']);
  assert.equal(empty.textContent, 'No branches match');
  assert.equal(activeId(), null, 'nothing highlighted: Enter does nothing');
  dom.key('Enter');
  assert.equal(C.menu.isOpen(), true);

  const space = dom.key(' ');
  assert.equal(space.defaultPrevented, false, 'Space types into the query');
  assert.equal(dom.key('Home', { shiftKey: true }).defaultPrevented, false, 'Shift+Home / Shift+End select in the field');
  assert.equal(dom.key('End', { shiftKey: true }).defaultPrevented, false);
  type('');
  assert.equal(empty.textContent, '');
  assert.equal(dom.key('End').defaultPrevented, true);
  assert.equal(activeId(), options[4].id, 'End: the last shown item');
  dom.key('Home');
  assert.equal(activeId(), options[0].id, 'Home: the first');

  type('feat');
  dom.key('ArrowDown');
  dom.key('Enter');
  assert.equal(C.menu.isOpen(), false);
  assert.deepEqual(ran, ['ui'], 'Enter runs the highlighted item after closing');
});

test('menu search mode: Esc clears the query, then closes; reopening starts empty; Tab closes; clicks run', () => {
  const { dom, C } = domSetup();
  const before = new dom.El('button');
  dom.document.body.append(before);
  before.focus();
  const ran = [];
  const items = [{ label: 'main', action: () => ran.push('main') }, { label: 'dev', action: () => ran.push('dev') }];
  const opts = { search: { label: 'Filter' } };
  const inputOf = (root) => root.findAll((n) => n.tagName === 'INPUT')[0];
  let root = C.menu.open({ x: 0, y: 0 }, items, opts);
  let input = inputOf(root);
  input.value = 'dev';
  dom.dispatch(input, 'input');
  dom.key('Escape');
  assert.equal(C.menu.isOpen(), true, 'the first Esc clears the query');
  assert.equal(input.value, '');
  assert.equal(root.findAll((n) => n.getAttribute('role') === 'option' && !n.hidden).length, 2, 'every item is back');
  dom.key('Escape');
  assert.equal(C.menu.isOpen(), false, 'an empty query: Esc closes');
  assert.equal(dom.document.activeElement, before, 'focus restored');

  root = C.menu.open({ x: 0, y: 0 }, items, opts);
  input = inputOf(root);
  assert.equal(input.value, '', 'a new menu starts with an empty query');
  dom.key('Tab');
  assert.equal(C.menu.isOpen(), false);

  root = C.menu.open({ x: 0, y: 0 }, items, opts);
  root.findAll((n) => n.getAttribute('role') === 'option')[1].click();
  assert.equal(C.menu.isOpen(), false);
  assert.deepEqual(ran, ['dev']);
});

/** A search-mode menu over `items` with helpers: input, options, the empty status, type(text), activeId(). */
function searchMenu(dom, C, items, extra = {}) {
  const root = C.menu.open({ x: 0, y: 0 }, items, { search: { label: 'Filter branches', empty: 'No branches match' }, ...extra });
  const input = root.findAll((n) => n.tagName === 'INPUT')[0];
  const options = root.findAll((n) => n.getAttribute('role') === 'option');
  const empty = root.children.find((n) => n.classList.contains('pl-menu-empty'));
  const type = (text) => { input.value = text; dom.dispatch(input, 'input'); };
  const activeId = () => input.getAttribute('aria-activedescendant');
  return { root, input, options, empty, type, activeId };
}

test('menu search mode: a press in the popup (disabled row, empty state, padding) keeps focus in the field; onClose runs once', () => {
  const { dom, C } = domSetup();
  const ran = [];
  let closes = 0;
  const m = searchMenu(dom, C, [
    { label: 'main', action: () => ran.push('main') },
    { label: 'fix/x', disabled: true, title: 'busy', action: () => ran.push('x') },
  ], { onClose: () => { closes++; } });
  const label = m.options[1].children.find((n) => n.classList.contains('pl-menu-label'));
  for (const target of [m.options[1], label, m.empty, m.root, m.options[0]]) {
    const e = dom.dispatch(target, 'mousedown');
    assert.equal(e.defaultPrevented, true, 'no focus change');
    assert.equal(C.menu.isOpen(), true);
    assert.equal(dom.document.activeElement, m.input);
  }
  assert.equal(dom.dispatch(m.input, 'mousedown').defaultPrevented, false, 'a press in the field places the caret');
  m.options[1].click();
  assert.equal(C.menu.isOpen(), true, 'a disabled row does nothing');
  m.type('zzz');
  m.empty.click();
  assert.equal(C.menu.isOpen(), true, 'nor does the empty state');
  assert.equal(dom.document.activeElement, m.input, 'typing still filters');
  assert.equal(closes, 0);
  m.type('');
  m.options[0].click();
  assert.deepEqual(ran, ['main']);
  assert.equal(closes, 1);
});

test('menu search mode: Enter while an IME composes, or a held Enter, does not run the item', () => {
  const { dom, C } = domSetup();
  const ran = [];
  const m = searchMenu(dom, C, [{ label: 'main', action: () => ran.push('main') }, { label: 'dev', action: () => ran.push('dev') }]);
  const composing = dom.key('Enter', { isComposing: true });
  assert.equal(composing.defaultPrevented, false, 'the IME gets the key');
  assert.equal(C.menu.isOpen(), true);
  dom.key('ArrowDown', { isComposing: true });
  assert.equal(m.activeId(), m.options[0].id, 'no highlight move mid-composition either');
  const held = dom.key('Enter', { repeat: true });
  assert.equal(held.defaultPrevented, true);
  assert.equal(C.menu.isOpen(), true, 'a held Enter does nothing');
  assert.deepEqual(ran, []);
  dom.key('Enter');
  assert.deepEqual(ran, ['main']);
});

test('menu search mode: a query matching only disabled items highlights nothing (Enter a no-op); a matching pinned item is picked', () => {
  const { dom, C } = domSetup();
  const ran = [];
  const items = [
    { label: 'main', action: () => ran.push('main') },
    { label: 'fix/x', disabled: true, action: () => ran.push('x') },
    { separator: true },
    { label: 'New branch…', pinned: true, action: () => ran.push('new') },
  ];
  let m = searchMenu(dom, C, items);
  m.type('fix');
  assert.equal(m.activeId(), null, 'the disabled match is not highlighted, nor the pinned row that does not match');
  assert.equal(m.empty.textContent, '', 'something matches: no empty state');
  dom.key('Enter');
  assert.equal(C.menu.isOpen(), true);
  assert.deepEqual(ran, []);

  m.type('NEW');
  assert.equal(m.empty.textContent, '', 'the pinned item matches: no "No branches match"');
  assert.equal(m.activeId(), m.options[2].id, 'nothing else matches: the pinned item is highlighted');
  dom.key('Enter');
  assert.deepEqual(ran, ['new']);

  m = searchMenu(dom, C, [{ label: 'renew', action: () => ran.push('renew') }, ...items.slice(1)]);
  m.type('new');
  assert.equal(m.activeId(), m.options[0].id, 'an unpinned match comes first');
  C.menu.close();
});

test('menu search mode: hovering highlights without scrolling; the keyboard scrolls the highlight into view', () => {
  const { dom, C } = domSetup();
  const m = searchMenu(dom, C, [{ label: 'a' }, { label: 'b' }, { label: 'c' }]);
  const scrolled = [];
  m.options.forEach((o, i) => { o.scrollIntoView = () => scrolled.push(i); });
  dom.dispatch(m.options[2], 'mousemove');
  assert.equal(m.activeId(), m.options[2].id);
  assert.deepEqual(scrolled, [], 'hover: no scroll');
  dom.key('ArrowUp');
  assert.deepEqual(scrolled, [1], 'keyboard: scrolled');
  m.type('c');
  assert.deepEqual(scrolled, [1, 2], 'filtering: scrolled');
  C.menu.close();
});

// ------------------------------------------------------------------ rebase / merge in progress (docs/plans/rebase.md R1)

const RB = (o = {}) => H.rebaseState(o);
const conflictedFile = [H.conflict('w.txt')];

/** setup() with status replaced by `st` fields (a rebase / merge in progress), re-read by a refresh. */
async function setupOp(st, handlers = {}, answers = []) {
  const s = await setup({}, handlers, answers);
  s.data.status = { ...s.data.status, branch: null, ...st };
  await s.store.actions.refresh();
  await H.flush();
  return s;
}
const midRebase = (o = {}, extra = {}) => ({ state: 'rebasing', rebase: RB({ conflicted: 0, ...o }), conflicted: [], ...extra });
const opCalls = (s, op) => s.api.calls.filter((c) => c.op === op);

test('rebaseContinue: done — continues without a message, cancellable, and names what was rebased and dropped', async () => {
  const s = await setupOp(midRebase(), {
    rebaseContinue: () => ({ status: 'done', branch: 'feat', before: 'c', after: 'e', fastForward: false, dropped: ['x', 'y'], skippedCherryPicks: 1, published: 0, undoRecorded: true }),
  });
  assert.equal(await s.F.rebaseContinue(s.store), true);
  const [c] = opCalls(s, 'rebaseContinue');
  assert.deepEqual(c.args, [{}]);
  assert.ok(c.opId, 'started cancellable (state.remoteOp)');
  assert.deepEqual(s.notices(), ['Rebased feat onto main. 2 commits became empty and were dropped. 1 commit was already in main and was skipped']);
  assert.equal(s.errors().length, 0);
});

test('rebaseContinue: stopped again at the next conflict or an edit stop resolves true with a notice and shows WIP', async () => {
  const next = RB({ current: { cmd: 'pick', sha: 'f'.repeat(40), subject: 'next one' }, step: { done: 3, total: 3 }, conflicted: 2 });
  const s = await setupOp(midRebase(), { rebaseContinue: () => ({ status: 'stopped', state: next }) });
  s.store.actions.select({ kind: 'commit', sha: 'a'.repeat(40) });
  assert.equal(await s.F.rebaseContinue(s.store), true);
  assert.deepEqual(s.notices(), ['Rebase stopped: 2 conflicted files']);
  assert.deepEqual(s.store.state.selection, { kind: 'wip' });
  s.api.handlers.rebaseContinue = () => ({ status: 'stopped', state: RB({ stop: 'edit', conflicted: 0, current: { cmd: 'edit', sha: 'a'.repeat(40), subject: 'tweak' } }) });
  assert.equal(await s.F.rebaseContinue(s.store), true);
  assert.equal(s.notices()[1], 'Rebase stopped to edit aaaaaaa "tweak": amend or continue');
});

test('rebaseContinue: conflicts remaining are refused before the op; not rebasing is a notice', async () => {
  const s = await setupOp(midRebase({ conflicted: 1 }, { conflicted: conflictedFile }), { rebaseContinue: () => ({ status: 'done' }) });
  assert.equal(await s.F.rebaseContinue(s.store), false);
  assert.deepEqual(s.notices(), ['Resolve and mark all 1 conflicted file resolved first']);
  assert.equal(opCalls(s, 'rebaseContinue').length, 0);

  const clean = await setup({}, { rebaseContinue: () => ({ status: 'done' }) });
  for (const f of ['rebaseContinue', 'rebaseSkip', 'rebaseAbort']) assert.equal(await clean.F[f](clean.store), false, f);
  assert.deepEqual(clean.notices(), ['No rebase is in progress', 'No rebase is in progress', 'No rebase is in progress']);
  assert.equal(clean.dialogs.length, 0, 'no confirm for skip / abort');
  assert.deepEqual(writeOps(clean.api), []);
});

test('rebaseContinue: the error kinds — conflicts (count), dirty (paths), not-rebasing, hook-failed, rebase-exec, cancelled, others toasted', async () => {
  const cases = [
    [err('conflicts', 'needs merge', { count: 3 }), { notice: 'Resolve and mark all 3 conflicted files resolved first' }],
    [err('rebase-exec', 'runs commands'), { alert: /runs commands \(exec lines in its todo\), which Pasta Lite never runs/, message2: /continue the rebase in a terminal \(git rebase --continue\); otherwise abort it/ }],
    [err('dirty', 'unstaged', { paths: ['a.txt', 'b.txt'] }), { alert: /Stage or discard your unstaged changes/, detail: /a\.txt/ }],
    [err('not-rebasing'), { notice: 'No rebase is in progress' }],
    [err('hook-failed', 'pre-commit: lint failed'), { alert: /commit hook failed/, detail: /lint failed/ }],
    [err('aborted', 'cancelled', { rebase: RB() }), { notice: 'Rebase stopped: continue or abort it' }],
  ];
  for (const [e, want] of cases) {
    const s = await setupOp(midRebase(), { rebaseContinue: () => { throw e; } });
    assert.equal(await s.F.rebaseContinue(s.store), false, e.kind);
    assert.equal(s.errors().length, 0, `${e.kind} not toasted`);
    if (want.notice) assert.deepEqual(s.notices(), [want.notice], e.kind);
    if (want.alert) {
      assert.equal(s.dialogs.length, 1, e.kind);
      assert.equal(s.dialogs[0].type, 'alert');
      assert.match(s.dialogs[0].opts.message, want.alert, e.kind);
      if (want.detail) assert.match(s.dialogs[0].opts.detail, want.detail, e.kind);
      if (want.message2) assert.match(s.dialogs[0].opts.message, want.message2, e.kind);
    }
  }
  const s = await setupOp(midRebase(), { rebaseContinue: () => { throw err('in-progress', 'another op'); } });
  assert.equal(await s.F.rebaseContinue(s.store), false);
  assert.equal(s.errors().length, 1, 'an unexplained kind is toasted once');
});

test('rebaseContinue: sends the composer draft for this stop only; an explicit message wins; none at an edit stop', async () => {
  const s = await setupOp(midRebase(), { rebaseContinue: () => ({ status: 'done' }) });
  const key = `rebase:${'d'.repeat(40)}`;
  s.store.set({ continueDraft: { key: 'rebase:other', message: 'stale' } });
  await s.F.rebaseContinue(s.store);
  s.store.set({ continueDraft: { key, message: 'edited\n\nbody' } });
  await s.F.rebaseContinue(s.store);
  assert.equal(s.store.state.continueDraft, null, 'cleared once continued');
  await s.F.rebaseContinue(s.store, { message: 'explicit' });
  s.store.set({ continueDraft: { key, message: 'edited' } });
  await s.F.rebaseContinue(s.store, { message: null });
  assert.deepEqual(opCalls(s, 'rebaseContinue').map((c) => c.args[0]), [{}, { message: 'edited\n\nbody' }, { message: 'explicit' }, {}]);

  const e = await setupOp(midRebase({ stop: 'edit' }), { rebaseContinue: () => ({ status: 'done' }) });
  await e.F.rebaseContinue(e.store, { message: 'not allowed here' });
  assert.deepEqual(opCalls(e, 'rebaseContinue')[0].args, [{}], 'the backend takes a message only at a conflict stop');
});

test('rebaseContinue: the toolbar Cancel aborts it (PLFlows.cancel with its op id)', async () => {
  let fail;
  const s = await setupOp(midRebase(), { rebaseContinue: () => new Promise((_, rej) => { fail = rej; }) });
  const p = s.F.rebaseContinue(s.store);
  await H.flush();
  assert.equal(s.store.state.remoteOp.op, 'rebaseContinue');
  assert.equal(await s.F.cancel(s.store), true);
  assert.deepEqual(s.api.app.cancelled, [s.store.state.remoteOp.opId]);
  fail(err('aborted', 'cancelled', { rebase: RB() }));
  assert.equal(await p, false);
  assert.equal(s.store.state.remoteOp, null);
  assert.deepEqual(s.notices(), ['Rebase stopped: continue or abort it']);
});

test('rebaseContinue: done with the autostash kept (re-apply conflicted) explains where the changes are', async () => {
  const s = await setupOp(midRebase(), { rebaseContinue: () => ({ status: 'done', dropped: [], stash: { kept: true, sha: '8'.repeat(40), reason: 'conflict' } }) });
  assert.equal(await s.F.rebaseContinue(s.store), true);
  assert.equal(s.dialogs[0].type, 'alert');
  assert.equal(s.dialogs[0].opts.title, 'Rebased, but your changes conflicted');
  assert.match(s.dialogs[0].opts.message, /safe in a stash \(8888888\)/);
  assert.deepEqual(s.notices(), []);
});

test('rebaseSkip: danger confirm naming the commit (Cancel is the default); cancellable; its result', async () => {
  const s = await setupOp(midRebase({ conflicted: 1 }, { conflicted: conflictedFile }), { rebaseSkip: () => ({ status: 'stopped', state: RB({ stop: 'edit', conflicted: 0 }) }) }, [false, true]);
  assert.equal(await s.F.rebaseSkip(s.store), false, 'declined');
  assert.equal(opCalls(s, 'rebaseSkip').length, 0);
  const c = s.dialogs[0];
  assert.equal(c.type, 'confirm');
  assert.equal(c.opts.danger, true);
  assert.equal(c.opts.confirmLabel, 'Skip Commit');
  assert.equal(c.opts.message, "Skip 'add the widget'? Its changes will be left out of the rebased branch. Your edits to its conflicted files are discarded.");
  assert.equal(await s.F.rebaseSkip(s.store), true, 'skips with conflicts still listed');
  const [call] = opCalls(s, 'rebaseSkip');
  assert.deepEqual(call.args, []);
  assert.ok(call.opId, 'cancellable');
  assert.deepEqual(s.notices(), ['Rebase stopped to edit ddddddd "add the widget": amend or continue']);
  s.api.handlers.rebaseSkip = () => ({ status: 'done', dropped: [] });
  s.dialogs.length = 0;
  scriptDialogs(s.win, [true]);
  assert.equal(await s.F.rebaseSkip(s.store), true);
  assert.equal(s.notices()[1], 'Rebased feat onto main');
});

test('rebaseAbort: danger confirm with where the branch goes back to; not cancellable; notice or kept stash', async () => {
  const s = await setupOp(midRebase({ autostash: '7'.repeat(40) }), { rebaseAbort: () => ({ status: 'aborted' }) }, [false, true]);
  assert.equal(await s.F.rebaseAbort(s.store), false);
  assert.equal(opCalls(s, 'rebaseAbort').length, 0);
  const c = s.dialogs[0].opts;
  assert.equal(c.danger, true);
  assert.equal(c.confirmLabel, 'Abort Rebase');
  assert.match(c.message, /^Abort the rebase\? feat goes back to where it was before the rebase \(ccccccc\)\./);
  assert.match(c.message, /re-applied/, 'mentions the autostash');
  s.store.set({ continueDraft: { key: 'x', message: 'y' } });
  assert.equal(await s.F.rebaseAbort(s.store), true);
  const [call] = opCalls(s, 'rebaseAbort');
  assert.equal(call.opId, null, 'never cancellable (§4.4)');
  assert.deepEqual(s.notices(), ['Rebase aborted: feat is back at ccccccc']);
  assert.equal(s.store.state.continueDraft, null);

  const k = await setupOp(midRebase({ branch: null, origHead: null }), { rebaseAbort: () => ({ status: 'aborted', stash: { kept: true, sha: '6'.repeat(40) } }) }, [true]);
  assert.equal(await k.F.rebaseAbort(k.store), true);
  assert.match(k.dialogs[0].opts.message, /^Abort the rebase\? HEAD goes back to where it was before the rebase\./);
  assert.equal(k.dialogs[1].opts.title, 'Rebase aborted, but your changes conflicted');
  assert.match(k.dialogs[1].opts.message, /6666666/);
  assert.deepEqual(k.notices(), []);

  const f = await setupOp(midRebase(), { rebaseAbort: () => { throw err('not-rebasing'); } }, [true]);
  assert.equal(await f.F.rebaseAbort(f.store), false);
  assert.deepEqual(f.notices(), ['No rebase is in progress']);
});

const midMerge = (o = {}, extra = {}) => ({ state: 'merging', branch: 'main', merge: { head: 'f'.repeat(40), name: 'topic', message: "Merge branch 'topic'", ...o }, conflicted: [], ...extra });

test('mergeCommit: commits with the draft for this merge, names the merge; conflicts and hooks are explained', async () => {
  const s = await setupOp(midMerge(), { mergeCommit: () => ({ status: 'done', sha: 'e'.repeat(40) }) });
  assert.equal(await s.F.mergeCommit(s.store), true);
  s.store.set({ continueDraft: { key: `merge:${'f'.repeat(40)}`, message: 'Merge topic, carefully' } });
  assert.equal(await s.F.mergeCommit(s.store), true);
  assert.deepEqual(opCalls(s, 'mergeCommit').map((c) => [c.args[0], c.opId]), [[{}, null], [{ message: 'Merge topic, carefully' }, null]]);
  assert.deepEqual(s.notices(), ['Merged topic into main', 'Merged topic into main']);
  assert.equal(s.store.state.continueDraft, null);

  const c = await setupOp(midMerge({}, { conflicted: conflictedFile }), { mergeCommit: () => ({ status: 'done' }) });
  assert.equal(await c.F.mergeCommit(c.store), false);
  assert.deepEqual(c.notices(), ['Resolve and mark all 1 conflicted file resolved first']);
  assert.equal(opCalls(c, 'mergeCommit').length, 0);

  const h = await setupOp(midMerge({ name: null }), { mergeCommit: () => { throw err('hook-failed', 'commit-msg says no'); } });
  assert.equal(await h.F.mergeCommit(h.store), false);
  assert.match(h.dialogs[0].opts.message, /so the merge stopped/);
  assert.match(h.dialogs[0].opts.detail, /commit-msg says no/);

  const none = await setup({}, { mergeCommit: () => ({}) });
  assert.equal(await none.F.mergeCommit(none.store), false);
  assert.equal(await none.F.mergeAbort(none.store), false);
  assert.deepEqual(none.notices(), ['No merge is in progress', 'No merge is in progress']);
});

test('mergeAbort: danger confirm, then aborts; a kept stash is explained', async () => {
  const s = await setupOp(midMerge(), { mergeAbort: () => ({ status: 'aborted' }) }, [false, true]);
  assert.equal(await s.F.mergeAbort(s.store), false);
  assert.equal(s.dialogs[0].opts.danger, true);
  assert.equal(s.dialogs[0].opts.message, 'Abort the merge of topic? main goes back to where it was before the merge. Changes made while resolving conflicts are discarded.');
  assert.equal(await s.F.mergeAbort(s.store), true);
  assert.deepEqual(writeOps(s.api), ['mergeAbort']);
  assert.deepEqual(s.notices(), ['Merge aborted']);
  const k = await setupOp(midMerge(), { mergeAbort: () => ({ status: 'aborted', stash: { kept: true, sha: '5'.repeat(40) } }) }, [true]);
  assert.equal(await k.F.mergeAbort(k.store), true);
  assert.equal(k.dialogs[1].opts.title, 'Merge aborted, but your changes conflicted');
});

test('restoreAutostash: restore / keep, nothing pending, conflicts on re-apply', async () => {
  const sha = '9'.repeat(40);
  const s = await setupOp({ state: 'clean', branch: 'main', pendingAutostash: sha }, { restoreAutostash: (o) => ({ restored: !o.keep }) });
  assert.equal(await s.F.restoreAutostash(s.store, { keep: false }), true);
  assert.equal(await s.F.restoreAutostash(s.store, { keep: true }), true);
  assert.deepEqual(opCalls(s, 'restoreAutostash').map((c) => c.args), [[{ keep: false }], [{ keep: true }]]);
  assert.deepEqual(s.notices(), [
    'Restored your changes from before the rebase',
    "Your changes stay in the stash (9999999): pop it from the Stashes list when you're ready",
  ]);
  assert.equal(await s.F.restoreAutostash(s.store), true, 'default: restore');
  assert.deepEqual(opCalls(s, 'restoreAutostash')[2].args, [{ keep: false }]);

  const none = await setup({}, { restoreAutostash: () => ({}) });
  assert.equal(await none.F.restoreAutostash(none.store), false);
  assert.deepEqual(none.notices(), ['There is no stash left over from a rebase']);
  assert.deepEqual(writeOps(none.api), []);

  const k = await setupOp({ state: 'clean', pendingAutostash: sha }, { restoreAutostash: () => ({ restored: false, stash: { kept: true, sha } }) });
  assert.equal(await k.F.restoreAutostash(k.store), true);
  assert.equal(k.dialogs[0].opts.title, "Couldn't restore your changes");
});

test('pull (rebase) with conflicts leads into the banner: Continue Rebase, the autostash note, WIP selected', async () => {
  const s = await setup({}, { pull: () => { throw err('conflicts', 'CONFLICT (content)', { stashKept: true, stash: 'f'.repeat(40) }); } });
  s.store.actions.select({ kind: 'commit', sha: 'a'.repeat(40) });
  assert.equal(await s.F.pull(s.store, 'rebase'), false);
  const a = s.dialogs[0].opts;
  assert.equal(a.title, 'Rebase stopped with conflicts');
  assert.match(a.message, /Resolve them in the WIP panel, then click Continue Rebase in the banner\./);
  assert.doesNotMatch(a.message, /terminal/);
  assert.match(a.message, /safe in a stash \(fffffff\) and come back when the rebase finishes or is aborted/);
  assert.equal(a.detail, 'CONFLICT (content)');
  assert.deepEqual(s.store.state.selection, { kind: 'wip' });
  assert.equal(s.errors().length, 0);

  // a backend that resolves the stop instead of rejecting
  const r = await setup({}, { pull: () => ({ mode: 'rebase', status: 'stopped', state: RB({ autostash: '4'.repeat(40) }) }) });
  assert.equal(await r.F.pull(r.store, 'rebase'), false);
  assert.match(r.dialogs[0].opts.message, /Continue Rebase in the banner/);
  assert.match(r.dialogs[0].opts.message, /4444444/);
  assert.deepEqual(r.notices(), []);

  // a merge pull that conflicts points at Commit and Merge
  const m = await setup({}, { pull: () => { throw err('conflicts', 'CONFLICT'); } });
  assert.equal(await m.F.pull(m.store, 'ff-if-possible'), false);
  assert.equal(m.dialogs[0].opts.title, 'Merge conflicts');
  assert.match(m.dialogs[0].opts.message, /Commit and Merge in the banner/);
});

// ------------------------------------------------------------------ merge / rebase from the menus (docs/plans/rebase.md R2)

const A40 = 'a'.repeat(40);
const B40 = 'b'.repeat(40);
const C40 = 'c'.repeat(40);

/**
 * setup() with main (current) at a tracking origin/main, feat at b tracking origin/feat, tag v1 at c.
 * graph 'diverged': a -> c, b -> c; 'ff': b -> a (main can fast-forward to feat).
 */
async function setupR2({ graph = 'diverged', dirty = false, handlers = {}, answers = [] } = {}) {
  const s = await setup({ dirty }, handlers, answers);
  s.data.refs = H.refs({
    head: { branch: 'main', oid: A40, detached: false },
    local: [
      { name: 'main', oid: A40, upstream: 'origin/main', ahead: 0, behind: 0, gone: false, current: true },
      { name: 'feat', oid: B40, upstream: 'origin/feat', ahead: 0, behind: 0, gone: false, current: false },
    ],
    remote: [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: A40 }, { name: 'origin/feat', remote: 'origin', branch: 'feat', oid: B40 }],
    tags: [{ name: 'v1', oid: C40 }],
  });
  s.data.log = {
    commits: graph === 'ff' ? [H.commit(B40, [A40]), H.commit(A40)] : [H.commit(B40, [C40]), H.commit(A40, [C40]), H.commit(C40)],
    hasMore: false, next: null,
  };
  await s.store.actions.refresh();
  await H.flush();
  return s;
}
const plan = (o = {}) => ({ head: A40, branch: 'main', upstream: B40, onto: B40, commits: [{ sha: A40 }], mergeBase: C40, isAncestor: false, published: [], limit: 500, truncated: false, ...o });

test('merge: confirm names both sides; the op gets [target, {ff, expectHead}]; done and fast-forward notices', async () => {
  const s = await setupR2({ handlers: { merge: () => ({ status: 'done', fastForward: false, sha: 'e'.repeat(40) }) }, answers: [false, true] });
  const args = { target: 'refs/heads/feat', expectHead: A40 };
  assert.equal(await s.F.merge(s.store, args), false, 'declined');
  assert.equal(opCalls(s, 'merge').length, 0);
  const c = s.dialogs[0];
  assert.equal(c.type, 'confirm');
  assert.equal(c.opts.title, 'Merge feat into main?');
  assert.equal(c.opts.confirmLabel, 'Merge');
  assert.doesNotMatch(c.opts.message, /stashed/);
  assert.equal(await s.F.merge(s.store, args), true);
  assert.deepEqual(opCalls(s, 'merge')[0].args, ['refs/heads/feat', { ff: 'ff', expectHead: A40 }]);
  assert.equal(opCalls(s, 'merge')[0].opId, null, 'a merge is not cancellable');
  assert.deepEqual(s.notices(), ['Merged feat into main']);

  // dirty: the confirm says the changes are stashed and come back
  const d = await setupR2({ dirty: true, handlers: { merge: () => ({ status: 'done', fastForward: false }) }, answers: [true] });
  assert.equal(await d.F.merge(d.store, { target: 'refs/remotes/origin/feat' }), true);
  assert.match(d.dialogs[0].opts.message, /stashed first and re-applied after the merge/);
  assert.equal(d.dialogs[0].opts.title, 'Merge origin/feat into main?');
  assert.deepEqual(d.notices(), ['Merged origin/feat into main']);
});

test('merge: a possible fast-forward offers Fast-forward (default) or Create Merge Commit; an explicit ff skips the choice', async () => {
  const s = await setupR2({ graph: 'ff', handlers: { merge: (t, o) => ({ status: 'done', fastForward: o.ff === 'ff' }) }, answers: [null, 'no-ff', 'ff'] });
  assert.equal(await s.F.merge(s.store, { target: 'refs/heads/feat' }), false, 'cancelled');
  const ch = s.dialogs[0];
  assert.equal(ch.type, 'choose');
  assert.deepEqual(ch.opts.choices.map((x) => [x.value, x.label, !!x.primary]), [['no-ff', 'Create Merge Commit', false], ['ff', 'Fast-forward', true]]);
  assert.match(ch.opts.message, /can simply be fast-forwarded to feat/);
  assert.equal(await s.F.merge(s.store, { target: 'refs/heads/feat' }), true);
  assert.equal(await s.F.merge(s.store, { target: 'refs/heads/feat' }), true);
  assert.deepEqual(opCalls(s, 'merge').map((c) => c.args[1].ff), ['no-ff', 'ff']);
  assert.deepEqual(s.notices(), ['Merged feat into main', 'Fast-forwarded main to feat']);

  const x = await setupR2({ graph: 'ff', handlers: { merge: () => ({ status: 'done', fastForward: false }) }, answers: [true] });
  assert.equal(await x.F.merge(x.store, { target: 'refs/heads/feat', ff: 'no-ff' }), true);
  assert.equal(x.dialogs[0].type, 'confirm', 'no ff choice when the caller chose');
  assert.match(x.dialogs[0].opts.message, /with a merge commit/);
  assert.equal(opCalls(x, 'merge')[0].args[1].ff, 'no-ff');
});

test('merge: up-to-date and stopped results; a conflicts error is a stop too; the banner takes over (WIP selected)', async () => {
  const s = await setupR2({ handlers: { merge: () => ({ status: 'up-to-date' }) }, answers: [true, true, true, undefined, true] }); // the alert takes one
  assert.equal(await s.F.merge(s.store, { target: 'refs/heads/feat' }), true);
  assert.deepEqual(s.notices(), ['main is already up to date with feat']);

  s.api.handlers.merge = () => ({ status: 'stopped', conflicted: 2 });
  s.store.actions.select({ kind: 'commit', sha: A40 });
  assert.equal(await s.F.merge(s.store, { target: 'refs/heads/feat' }), true);
  assert.equal(s.notices()[1], 'Merge stopped: 2 conflicted files');
  assert.deepEqual(s.store.state.selection, { kind: 'wip' });

  // no conflicts, but a hook refused the merge commit: explained, the banner concludes it
  s.api.handlers.merge = () => ({ status: 'stopped', stop: 'hook', conflicted: 0, hookOutput: 'pre-merge-commit: no' });
  assert.equal(await s.F.merge(s.store, { target: 'refs/heads/feat' }), true);
  const hook = s.dialogs.at(-1);
  assert.equal(hook.type, 'alert');
  assert.equal(hook.opts.title, 'A hook refused the merge commit');
  assert.equal(hook.opts.detail, 'pre-merge-commit: no');
  s.dialogs.length = 0;
  s.api.handlers.merge = () => { throw err('conflicts', 'CONFLICT (content)', { count: 1 }); };
  assert.equal(await s.F.merge(s.store, { target: 'refs/heads/feat' }), false);
  assert.equal(s.notices().at(-1), 'Merge stopped: 1 conflicted file');
  assert.equal(s.errors().length, 0);
});

test('merge: nothing to do, stale menu, in progress and unborn are refused before any dialog; backend refusals explained', async () => {
  const s = await setupR2({ handlers: { merge: () => ({ status: 'done' }) } });
  assert.equal(await s.F.merge(s.store, { target: 'refs/tags/v1' }), false, 'v1 (c) is in main already');
  assert.equal(await s.F.merge(s.store, { target: A40 }), false, 'HEAD itself');
  assert.equal(await s.F.merge(s.store, { target: 'refs/heads/feat', expectHead: 'f'.repeat(40) }), false, 'the menu saw another HEAD');
  assert.equal(await s.F.merge(s.store, {}), false);
  assert.deepEqual(s.notices(), ['main already contains v1', 'main already contains aaaaaaa', 'The branch moved since you opened this; review and try again']);
  assert.equal(s.dialogs.length, 0);
  assert.equal(opCalls(s, 'merge').length, 0);

  const busy = await setupOp({ state: 'merging', merge: { head: B40, name: 'feat', message: 'm' } }, { merge: () => ({ status: 'done' }) });
  assert.equal(await busy.F.merge(busy.store, { target: 'refs/heads/feat' }), false);
  assert.deepEqual(busy.notices(), ['Merge — finish or abort the merge first']);
  const pending = await setupOp({ branch: 'main', pendingAutostash: '9'.repeat(40) }, { merge: () => ({ status: 'done' }) });
  assert.equal(await pending.F.merge(pending.store, { target: 'refs/heads/feat' }), false);
  assert.match(pending.notices()[0], /restore or keep the stash left over/);

  const unborn = await setup({}, { merge: () => ({ status: 'done' }), rebase: () => ({ status: 'done' }) });
  unborn.data.status = { ...unborn.data.status, oid: null };
  await unborn.store.actions.refresh();
  assert.equal(await unborn.F.merge(unborn.store, { target: 'refs/heads/feat' }), false);
  assert.equal(await unborn.F.rebase(unborn.store, { onto: 'refs/heads/feat' }), false);
  assert.deepEqual(unborn.dialogs.map((d) => d.opts.title), ['Cannot merge', 'Cannot rebase']);
  assert.deepEqual(writeOps(unborn.api), []);

  const cases = [
    [err('stale', 'moved'), { notice: 'The branch moved since you opened this; review and try again' }],
    [err('in-progress', 'Finish or abort the rebase first'), { notice: 'Finish or abort the rebase first' }],
    [err('hook-failed', 'pre-merge-commit: nope'), { alert: /A git hook refused the merge/, detail: /nope/ }],
    [err('unrelated-histories', 'refusing to merge unrelated histories'), { alert: /no commit in common/ }],
    [err('ambiguous', "'feat' names more than one ref (refs/heads/feat, refs/tags/feat); pick one"), { alert: /names more than one ref/ }],
  ];
  for (const [e, want] of cases) {
    const r = await setupR2({ handlers: { merge: () => { throw e; } }, answers: [true] });
    assert.equal(await r.F.merge(r.store, { target: 'refs/heads/feat' }), false, e.kind);
    assert.equal(r.errors().length, 0, `${e.kind} not toasted`);
    if (want.notice) assert.deepEqual(r.notices(), [want.notice], e.kind);
    if (want.alert) {
      assert.equal(r.dialogs[1].type, 'alert', e.kind);
      assert.match(r.dialogs[1].opts.message, want.alert, e.kind);
      if (want.detail) assert.match(r.dialogs[1].opts.detail, want.detail, e.kind);
    }
  }
});

test('rebase: nothing published — no warning; plan read with {upstream: onto}; cancellable rebase with expectHead; done notice', async () => {
  const s = await setupR2({
    handlers: {
      rebasePlan: () => plan(),
      rebase: () => ({ status: 'done', branch: 'main', before: A40, after: 'e'.repeat(40), fastForward: false, dropped: [], skippedCherryPicks: 0, published: 0 }),
    },
  });
  assert.equal(await s.F.rebase(s.store, { onto: 'refs/heads/feat', expectHead: A40 }), true);
  assert.deepEqual(opCalls(s, 'rebasePlan')[0].args, [{ upstream: 'refs/heads/feat' }]);
  const [c] = opCalls(s, 'rebase');
  assert.deepEqual(c.args, ['refs/heads/feat', { expectHead: A40, expectBranch: 'main' }]);
  assert.ok(c.opId, 'cancellable (the toolbar Cancel)');
  assert.equal(s.dialogs.length, 0, 'no confirm without published commits');
  assert.deepEqual(s.notices(), ['Rebased main onto feat']);
});

test('rebase: the published warning (warn only) — Cancel is the default; Rebase goes on; then the force-push follow-up with Later as the default', async () => {
  const published = [{ sha: A40, remoteRefs: ['origin/main'] }];
  const done = { status: 'done', branch: 'main', before: A40, after: 'e'.repeat(40), fastForward: false, dropped: [], skippedCherryPicks: 0, published: 1 };
  const s = await setupR2({ handlers: { rebasePlan: () => plan({ published, commits: [{ sha: A40 }, { sha: C40 }] }), rebase: () => done }, answers: [false, true, null] });
  assert.equal(await s.F.rebase(s.store, { onto: 'refs/tags/v1' }), false, 'declined');
  assert.equal(opCalls(s, 'rebase').length, 0);
  const w = s.dialogs[0];
  assert.equal(w.type, 'confirm');
  assert.equal(w.opts.title, 'Rewrite pushed commits?');
  assert.equal(w.opts.confirmLabel, 'Rebase');
  assert.equal(w.opts.defaultCancel, true, 'Cancel focused');
  assert.match(w.opts.message, /^1 of your 2 commits is already pushed to origin\/main\. Rebasing replaces it with a new copy, so you'll need to force push main afterwards to update origin\/main\./);
  // main is a main branch: danger style and the extra line
  assert.equal(w.opts.danger, true);
  assert.match(w.opts.message, /main is the main branch of origin: others probably build on it\./);

  assert.equal(await s.F.rebase(s.store, { onto: 'refs/tags/v1' }), true);
  assert.equal(opCalls(s, 'rebase').length, 1);
  const f = s.dialogs[2];
  assert.equal(f.type, 'choose');
  assert.equal(f.opts.title, 'Force push main?');
  assert.match(f.opts.message, /^origin\/main still has the commits from before the rebase\. A force push replaces them/);
  assert.equal(f.opts.cancelLabel, 'Later', 'Later is the cancel button, focused (the only choice is danger)');
  assert.deepEqual(f.opts.choices.map((x) => [x.value, x.label, !!x.danger]), [['force', 'Force Push…', true]]);
  assert.equal(opCalls(s, 'push').length, 0, 'Later: nothing pushed');
  assert.deepEqual(s.notices(), ['Rebased main onto v1']);
});

test('rebase: Force Push… from the follow-up runs the lease force push after its own danger confirm', async () => {
  const s = await setupR2({
    handlers: {
      rebasePlan: () => plan({ published: [{ sha: B40, remoteRefs: ['origin/feat'] }] }),
      rebase: () => ({ status: 'done', branch: 'feat', dropped: [], published: 1 }),
      checkout: () => undefined,
      push: (a) => ({ remote: 'origin', branch: a.branch, remoteBranch: 'feat', forced: true }),
    },
    answers: [true, 'force', true],
  });
  assert.equal(await s.F.rebase(s.store, { onto: 'refs/heads/main', branch: 'feat', expectHead: B40 }), true);
  const types = s.dialogs.map((d) => [d.type, d.opts.title]);
  assert.deepEqual(types, [
    ['confirm', 'Check out branch?'], ['choose', 'Force push feat?'], ['confirm', 'Force push?'],
  ], "feat's commits are only on its own upstream: no published warning, just the force-push offer");
  assert.equal(s.dialogs[0].opts.danger, undefined, 'feat is not a main branch: no danger style');
  assert.equal(s.dialogs[2].opts.danger, true);
  assert.deepEqual(opCalls(s, 'push')[0].args, [{ branch: 'feat', force: 'lease' }]);
  assert.deepEqual(s.notices(), ['Rebased feat onto main', 'Force pushed feat to origin/feat']);
});

test('rebase: checkout first for another branch — confirm, checkout, then plan and rebase with that branch tip as expectHead', async () => {
  const order = [];
  const s = await setupR2({
    dirty: true,
    handlers: {
      checkout: (t, o) => { order.push(['checkout', t, o]); },
      rebasePlan: (o) => { order.push(['rebasePlan', o]); return plan(); },
      rebase: (o, x) => { order.push(['rebase', o, x]); return { status: 'done', dropped: [], published: 0 }; },
    },
    answers: [false, true],
  });
  const args = { onto: 'refs/heads/main', branch: 'feat', expectHead: B40 };
  assert.equal(await s.F.rebase(s.store, args), false, 'declined the checkout');
  assert.deepEqual(order, []);
  // feat's own commit b is only on its own upstream origin/feat (loaded history): the plain checkout confirm
  const c = s.dialogs[0].opts;
  assert.equal(c.title, 'Check out branch?');
  assert.match(c.message, /^To rebase feat onto main it must be checked out first\. Check it out now\?/);
  assert.match(c.message, /Your local changes will be stashed and re-applied\./);
  assert.doesNotMatch(c.message, /pushed/);
  assert.equal(c.confirmLabel, 'Check Out');

  assert.equal(await s.F.rebase(s.store, args), true);
  assert.deepEqual(order, [
    ['checkout', 'feat', { kind: 'local' }],
    ['rebasePlan', { upstream: 'refs/heads/main' }],
    ['rebase', 'refs/heads/main', { expectHead: B40, expectBranch: 'feat' }],
  ]);
  assert.deepEqual(s.notices(), ['Rebased feat onto main']);

  // nothing of feat's on a remote: the plain checkout confirm
  const u = await setupR2({ handlers: { checkout: () => undefined, rebasePlan: () => plan(), rebase: () => ({ status: 'done', dropped: [], published: 0 }) }, answers: [true] });
  u.data.refs = { ...u.data.refs, remote: [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: A40 }, { name: 'origin/feat', remote: 'origin', branch: 'feat', oid: C40 }] };
  await u.store.actions.refresh();
  assert.equal(await u.F.rebase(u.store, args), true);
  assert.deepEqual([u.dialogs[0].opts.title, u.dialogs[0].opts.confirmLabel, u.dialogs.length], ['Check out branch?', 'Check Out', 1]);
  assert.doesNotMatch(u.dialogs[0].opts.message, /already on/);

  // the branch moved since the menu was built: nothing asked, nothing run
  const m = await setupR2({ handlers: { checkout: () => undefined } });
  assert.equal(await m.F.rebase(m.store, { ...args, expectHead: 'f'.repeat(40) }), false);
  assert.deepEqual(m.notices(), ['The branch moved since you opened this; review and try again']);
  assert.equal(m.dialogs.length, 0);
  // a failed checkout stops there (checkout explains it)
  const f = await setupR2({ handlers: { checkout: () => { throw err('checked-out-elsewhere', 'feat is already used by worktree at /x'); }, rebase: () => ({ status: 'done' }) }, answers: [true] });
  assert.equal(await f.F.rebase(f.store, args), false);
  assert.equal(opCalls(f, 'rebase').length, 0);
  assert.equal(opCalls(f, 'rebasePlan').length, 0);
});

test('rebase: stopped hands over to the banner; up to date (plan or result); stale; hook-failed; cancelled before it started', async () => {
  const s = await setupR2({ handlers: { rebasePlan: () => plan(), rebase: () => ({ status: 'stopped', state: RB({ branch: 'main', conflicted: 2 }) }) } });
  s.store.actions.select({ kind: 'commit', sha: A40 });
  assert.equal(await s.F.rebase(s.store, { onto: 'refs/heads/feat' }), true);
  assert.deepEqual(s.notices(), ['Rebase stopped: 2 conflicted files']);
  assert.deepEqual(s.store.state.selection, { kind: 'wip' });
  assert.equal(s.dialogs.length, 0, 'no force-push follow-up for a stop');

  s.api.handlers.rebase = () => ({ status: 'up-to-date', branch: 'main', head: A40 });
  assert.equal(await s.F.rebase(s.store, { onto: 'refs/heads/feat' }), true);
  assert.equal(s.notices()[1], 'main is already up to date with feat');

  s.api.handlers.rebasePlan = () => plan({ isAncestor: true });
  const before = opCalls(s, 'rebase').length;
  assert.equal(await s.F.rebase(s.store, { onto: 'refs/heads/feat' }), false, 'the plan says onto is in HEAD already');
  assert.equal(opCalls(s, 'rebase').length, before);
  assert.equal(s.notices()[2], 'main is already up to date with feat');

  const cases = [
    [err('stale', 'moved'), { notice: 'The branch moved since you opened this; review and try again' }],
    [err('aborted', 'cancelled'), { notice: 'Rebase cancelled' }],
    [err('aborted', 'cancelled', { rebase: RB() }), { notice: 'Rebase stopped: continue or abort it' }],
    [err('hook-failed', 'pre-rebase: protected'), { alert: /refused the rebase before it started, so nothing changed/, detail: /protected/ }],
  ];
  for (const [e, want] of cases) {
    const r = await setupR2({ handlers: { rebasePlan: () => plan(), rebase: () => { throw e; } } });
    assert.equal(await r.F.rebase(r.store, { onto: 'refs/heads/feat' }), false, e.kind);
    assert.equal(r.errors().length, 0, `${e.kind} not toasted`);
    if (want.notice) assert.deepEqual(r.notices(), [want.notice], e.kind);
    if (want.alert) {
      assert.match(r.dialogs[0].opts.message, want.alert);
      assert.match(r.dialogs[0].opts.detail, want.detail);
    }
  }
  const stale = await setupR2({ handlers: { rebasePlan: () => plan(), rebase: () => ({ status: 'done' }) } });
  assert.equal(await stale.F.rebase(stale.store, { onto: 'refs/heads/feat', expectHead: 'f'.repeat(40) }), false);
  assert.equal(opCalls(stale, 'rebasePlan').length, 0, 'refused before reading the plan');
});

test('rebase: an unreadable plan hedges the warning when the branch has an upstream; an invalid target is reported', async () => {
  const s = await setupR2({ handlers: { rebasePlan: () => { throw err('too-many', 'too many'); }, rebase: () => ({ status: 'done', dropped: [], published: 0 }) }, answers: [true] });
  const warns = [];
  s.win.Components.util.log.warn = (...a) => warns.push(a);
  assert.equal(await s.F.rebase(s.store, { onto: 'refs/heads/feat' }), true);
  assert.equal(s.dialogs[0].opts.title, 'Rewrite pushed commits?');
  assert.match(s.dialogs[0].opts.message, /may already be pushed to origin\/main \(they couldn't be checked\)/);
  assert.equal(warns.length, 1);

  const bad = await setupR2({ handlers: { rebasePlan: () => { throw err('invalid-args', 'not a commit'); }, rebase: () => ({ status: 'done' }) } });
  assert.equal(await bad.F.rebase(bad.store, { onto: 'refs/heads/nope' }), false);
  assert.equal(bad.errors().length, 1);
  assert.equal(opCalls(bad, 'rebase').length, 0);
});

test('resolveWith: keeps a side named after the branch / commit (danger confirm), one op per path; refuses without a rebase or merge', async () => {
  const conflicted = [H.conflict('w.txt'), H.conflict('x.txt')];
  const s = await setupOp(midRebase({ conflicted: 2 }, { conflicted }), { resolveWith: (p, side) => ({ path: p, side, deleted: false }) }, [false, true, true]);
  assert.equal(await s.F.resolveWith(s.store, { paths: ['w.txt'], side: 'ours' }), false, 'declined');
  const c = s.dialogs[0].opts;
  assert.equal(c.title, "Keep main's version?");
  assert.equal(c.confirmLabel, "Keep main's version");
  assert.equal(c.danger, true);
  assert.match(c.message, /w\.txt/);
  assert.equal(opCalls(s, 'resolveWith').length, 0);
  assert.equal(await s.F.resolveWith(s.store, { paths: ['w.txt'], side: 'ours' }), true);
  assert.equal(await s.F.resolveWith(s.store, { paths: ['w.txt', 'x.txt', 'gone.txt'], side: 'theirs' }), true);
  assert.deepEqual(opCalls(s, 'resolveWith').map((x) => x.args), [['w.txt', 'ours'], ['w.txt', 'theirs'], ['x.txt', 'theirs']]);
  assert.equal(s.dialogs[2].opts.title, "Keep ddddddd's version of 2 files?");
  assert.equal(s.dialogs[2].opts.detail, "Keep w.txt (ddddddd's version)\nKeep x.txt (ddddddd's version)");
  assert.deepEqual(s.notices(), ["Kept main's version of w.txt", "Kept ddddddd's version of 2 files"]);

  assert.equal(await s.F.resolveWith(s.store, { paths: ['nope.txt'], side: 'ours' }), false);
  assert.equal(await s.F.resolveWith(s.store, { paths: ['w.txt'], side: 'mine' }), false, 'unknown side');
  assert.equal(s.notices()[2], 'nope.txt is no longer conflicted');

  // the backend's result: a side that deleted the file removed it; a file resolved meanwhile is skipped
  const d = await setupOp(midRebase({ conflicted: 2 }, { conflicted }), {
    resolveWith: (p, side) => { if (p === 'x.txt') throw err('not-conflicted', "'x.txt' is not a conflicted file"); return { path: p, side, deleted: true }; },
  }, [true, true]);
  assert.equal(await d.F.resolveWith(d.store, { paths: ['w.txt'], side: 'theirs' }), true);
  assert.equal(await d.F.resolveWith(d.store, { paths: ['x.txt'], side: 'theirs' }), false);
  assert.deepEqual(d.notices(), ['Deleted w.txt', 'x.txt is no longer conflicted']);
  assert.equal(d.errors().length, 0);

  const m = await setupOp({ state: 'merging', branch: 'main', merge: { head: B40, name: 'refs/heads/feat', message: 'm' }, conflicted }, { resolveWith: () => ({ deleted: false }) }, [true]);
  assert.equal(await m.F.resolveWith(m.store, { paths: ['x.txt'], side: 'theirs' }), true);
  assert.equal(m.dialogs[0].opts.title, "Keep feat's version?", 'merge: theirs is what is merged in');

  const clean = await setup({}, { resolveWith: () => undefined });
  clean.data.status = { ...clean.data.status, conflicted };
  await clean.store.actions.refresh();
  assert.equal(await clean.F.resolveWith(clean.store, { paths: ['w.txt'], side: 'ours' }), false);
  assert.deepEqual(clean.notices(), ['Keeping one version is only available while a rebase or merge is in progress']);
});

// ------------------------------------------------------------------ review fixes: outcomes, keep-a-side, published

test('every flow that can get the autostash fields reports them through the one outcome helper: kept stash (by reason), reset failure, lost index split', async () => {
  const SHA9 = '9'.repeat(40);
  const kept = (reason) => ({ stash: { kept: true, sha: SHA9, ...(reason ? { reason } : {}) } });
  // [flow, status, op, result base, answers before the op, done title prefix]
  const flows = [
    ['rebaseContinue', midRebase(), 'rebaseContinue', { status: 'done', branch: 'feat', dropped: [] }, [], 'Rebased'],
    ['rebaseSkip', midRebase(), 'rebaseSkip', { status: 'done', branch: 'feat', dropped: [] }, [true], 'Rebased'],
    ['rebaseAbort', midRebase(), 'rebaseAbort', { status: 'aborted' }, [true], 'Rebase aborted'],
    ['mergeCommit', midMerge(), 'mergeCommit', { status: 'done', sha: 'e'.repeat(40) }, [], 'Merged'],
    ['mergeAbort', midMerge(), 'mergeAbort', { status: 'aborted' }, [true], 'Merge aborted'],
  ];
  for (const [name, st, op, base, answers, done] of flows) {
    for (const [fields, want] of [
      [kept(), { title: `${done}, but your changes conflicted`, message: /could not be re-applied without conflicts, so the working tree was left clean\.\n\nThey are safe in a stash \(9999999\)/ }],
      [kept('conflict'), { title: `${done}, but your changes conflicted`, message: /without conflicts/ }],
      [kept('index'), { title: `${done}, but your changes weren't re-applied`, message: /^Your local changes from before could not be re-applied, so the working tree was left clean/ }],
      [kept('dirty'), { title: `${done}, but your changes weren't re-applied`, message: /because the working tree has other changes now \(it was left as it is\)/ }],
      [{ ...kept('conflict'), resetFailed: true }, { title: `${done}, but your changes conflicted`, message: /couldn't be reset afterwards: check your files for conflict markers/ }],
      [{ indexRestored: false }, { notice: /their staged part could not be restored, so all of them are unstaged$/ }],
    ]) {
      const s = await setupOp(st, { [op]: () => ({ ...base, ...fields }) }, [...answers]);
      assert.equal(await s.F[name](s.store), true, `${name} ${JSON.stringify(fields)}`);
      const alert = s.dialogs.find((d) => d.type === 'alert');
      if (want.title) {
        assert.equal(alert && alert.opts.title, want.title, `${name} ${JSON.stringify(fields)}`);
        assert.match(alert.opts.message, want.message, name);
        assert.deepEqual(s.notices(), [], `${name}: the alert replaces the notice`);
      } else {
        assert.equal(alert, undefined, name);
        assert.equal(s.notices().length, 1, name);
        assert.match(s.notices()[0], want.notice, name);
      }
    }
  }
});

test('merge, rebase and restoreAutostash results go through the same helper; restoreAutostash explains a dirty refusal', async () => {
  const SHA9 = '9'.repeat(40);
  const m = await setupR2({ handlers: { merge: () => ({ status: 'done', fastForward: false, stash: { kept: true, sha: SHA9, reason: 'dirty' } }) }, answers: [true] });
  assert.equal(await m.F.merge(m.store, { target: 'refs/heads/feat' }), true);
  assert.equal(m.dialogs[1].opts.title, "Merged, but your changes weren't re-applied");
  const r = await setupR2({ handlers: { rebasePlan: () => plan(), rebase: () => ({ status: 'done', dropped: [], published: 0, indexRestored: false }) } });
  assert.equal(await r.F.rebase(r.store, { onto: 'refs/heads/feat' }), true);
  assert.match(r.notices()[0], /^Rebased main onto feat\. Your local changes came back, but their staged part could not be restored/);

  const pending = { pendingAutostash: SHA9 };
  const a = await setupOp(pending, { restoreAutostash: () => ({ restored: false, stash: { kept: true, sha: SHA9, reason: 'conflict' }, resetFailed: true }) });
  assert.equal(await a.F.restoreAutostash(a.store), true);
  assert.equal(a.dialogs[0].opts.title, "Couldn't restore your changes");
  assert.match(a.dialogs[0].opts.message, /couldn't be reset afterwards/);
  const i = await setupOp(pending, { restoreAutostash: () => ({ restored: true, indexRestored: false }) });
  assert.equal(await i.F.restoreAutostash(i.store), true);
  assert.match(i.notices()[0], /^Restored your changes from before the rebase\. Your local changes came back, but their staged part/);
  const d = await setupOp(pending, { restoreAutostash: () => { throw err('dirty', 'dirty', { paths: ['a.txt'], count: 1 }); } });
  assert.equal(await d.F.restoreAutostash(d.store), false);
  assert.equal(d.errors().length, 0, 'not toasted');
  assert.equal(d.dialogs[0].opts.title, "Couldn't restore your changes");
  assert.match(d.dialogs[0].opts.message, /The working tree has changes now, so the stash \(9999999\) was not re-applied\. Commit or stash them first/);
  assert.equal(d.dialogs[0].opts.detail, 'a.txt');
  // mergeCommit refused with dirty: the unstaged-changes explanation
  const mc = await setupOp(midMerge(), { mergeCommit: () => { throw err('dirty', 'dirty', { paths: ['b.txt'], count: 1 }); } });
  assert.equal(await mc.F.mergeCommit(mc.store), false);
  assert.match(mc.dialogs[0].opts.message, /^Stage or discard your unstaged changes before committing the merge: your local changes from before the merge are in a stash and come back then/);
  assert.equal(mc.dialogs[0].opts.detail, 'b.txt');
});

test('resolveWith on real modify/delete entries: the confirm names the deletion, labels per entry, the notice counts deletions', async () => {
  const real = H.realConflicts().conflicted; // aa.txt AA, both.txt UU, du.txt DU, ud.txt UD
  const mg = { state: 'merging', branch: 'main', merge: { head: B40, name: 'refs/heads/side', message: 'm' }, conflicted: real };
  const s = await setupOp(mg, { resolveWith: (p, side) => ({ path: p, side, deleted: p === 'ud.txt' && side === 'theirs' }) }, [false, true, true]);
  // one deletion: "Delete ud.txt?" (danger), Delete File
  assert.equal(await s.F.resolveWith(s.store, { paths: ['ud.txt'], side: 'theirs' }), false, 'declined');
  const c = s.dialogs[0].opts;
  assert.deepEqual([c.title, c.confirmLabel, c.danger], ['Delete ud.txt?', 'Delete File', true]);
  assert.equal(c.message, "ud.txt is deleted from the working tree and the deletion is marked resolved (side deleted it). main's version of it and your edits are discarded.");
  assert.equal(await s.F.resolveWith(s.store, { paths: ['ud.txt'], side: 'theirs' }), true);
  assert.deepEqual(opCalls(s, 'resolveWith').map((x) => x.args), [['ud.txt', 'theirs']]);
  assert.equal(s.notices()[0], 'Deleted ud.txt');
  // several files, theirs: du.txt keeps side's changes, ud.txt is deleted, both.txt takes side's version
  assert.equal(await s.F.resolveWith(s.store, { paths: ['both.txt', 'du.txt', 'ud.txt'], side: 'theirs' }), true);
  const m = s.dialogs[2].opts;
  assert.equal(m.title, "Resolve 3 files with side's side?");
  assert.equal(m.confirmLabel, 'Resolve Files');
  assert.match(m.message, /^1 file is deleted, as side has no version of it\./);
  assert.equal(m.detail, "Keep both.txt (side's version)\nKeep du.txt (with side's changes; main deleted it)\nDelete ud.txt (side deleted it)");
  assert.equal(s.notices()[1], 'Resolved 3 files: 1 deleted, 2 kept');
  // the single keep of a modify/delete file
  const k = await setupOp(mg, { resolveWith: (p, side) => ({ path: p, side, deleted: false }) }, [true]);
  assert.equal(await k.F.resolveWith(k.store, { paths: ['du.txt'], side: 'theirs' }), true);
  assert.deepEqual([k.dialogs[0].opts.title, k.dialogs[0].opts.confirmLabel], ['Keep du.txt?', 'Keep du.txt']);
  assert.equal(k.notices()[0], 'Kept du.txt');
});

test('resolveWith: a failure part-way names the files resolved before it; nothing resolved is a plain toast', async () => {
  const conflicted = [H.conflict('w.txt'), H.conflict('x.txt', 'UD'), H.conflict('y.txt')];
  const s = await setupOp(midRebase({ conflicted: 3 }, { conflicted }), {
    resolveWith: (p, side) => { if (p === 'y.txt') throw err('boom', 'index.lock exists'); return { path: p, side, deleted: p === 'x.txt' }; },
  }, [true]);
  assert.equal(await s.F.resolveWith(s.store, { paths: ['w.txt', 'x.txt', 'y.txt'], side: 'theirs' }), false);
  const a = s.dialogs[1].opts;
  assert.equal(a.title, 'Resolved 2 of 3 files');
  assert.match(a.message, /resolved before an error stopped the rest:\n\nindex\.lock exists/);
  assert.equal(a.detail, 'Kept w.txt\nDeleted x.txt');
  assert.deepEqual(s.notices(), []);
  const f = await setupOp(midRebase({ conflicted: 3 }, { conflicted }), { resolveWith: () => { throw err('boom', 'nope'); } }, [true]);
  assert.equal(await f.F.resolveWith(f.store, { paths: ['w.txt', 'y.txt'], side: 'ours' }), false);
  assert.deepEqual(f.dialogs.map((d) => d.type), ['confirm']);
  assert.equal(f.errors().length, 1, 'toasted once (by write)');
  // a DD entry has one choice (a deletion) whichever side the key asked for
  const dd = await setupOp(midRebase({ conflicted: 1 }, { conflicted: [H.conflict('z.txt', 'DD')] }), { resolveWith: (p, side) => ({ path: p, side, deleted: true }) }, [true]);
  assert.equal(await dd.F.resolveWith(dd.store, { paths: ['z.txt'], side: 'theirs' }), true);
  assert.deepEqual(opCalls(dd, 'resolveWith')[0].args, ['z.txt', 'ours']);
  assert.equal(dd.dialogs[0].opts.title, 'Delete z.txt?');
});

test('rebase: the force-push follow-up only when the result counts rewritten published commits (published > 0)', async () => {
  const published = [{ sha: A40, remoteRefs: ['origin/main'] }];
  for (const [res, offered] of [[{ published: 0 }, false], [{}, false], [{ published: 2 }, true]]) {
    const s = await setupR2({ handlers: { rebasePlan: () => plan({ published }), rebase: () => ({ status: 'done', dropped: [], ...res }) }, answers: [true, null] });
    assert.equal(await s.F.rebase(s.store, { onto: 'refs/heads/feat' }), true);
    assert.equal(s.dialogs.some((d) => d.type === 'choose'), offered, JSON.stringify(res));
  }
  // onto already in the branch: nothing rewritten, no warning (and nothing to do)
  const up = await setupR2({ handlers: { rebasePlan: () => plan({ published, isAncestor: true }), rebase: () => ({ status: 'done' }) } });
  assert.equal(await up.F.rebase(up.store, { onto: 'refs/heads/feat' }), false);
  assert.equal(up.dialogs.length, 0);
});

test('rebase of another branch: a stop after the checkout says you are on it now (warning declined, up to date, plan error)', async () => {
  const args = { onto: 'refs/heads/main', branch: 'feat', expectHead: B40 };
  const moreThanLoaded = plan({ head: B40, branch: 'feat', published: [{ sha: B40, remoteRefs: ['origin/feat', 'origin/shared'] }, { sha: C40, remoteRefs: ['origin/shared'] }] });
  // the plan finds the commits on another remote branch too (not only feat's upstream): warned; declined
  const s = await setupR2({ handlers: { checkout: () => undefined, rebasePlan: () => moreThanLoaded, rebase: () => ({ status: 'done' }) }, answers: [true, false] });
  assert.equal(await s.F.rebase(s.store, args), false);
  assert.deepEqual(s.dialogs.map((d) => d.opts.title), ['Check out branch?', 'Rewrite pushed commits?']);
  assert.match(s.dialogs[1].opts.message, /^2 commits are already pushed to origin\/feat\. Rebasing replaces them with new copies/);
  assert.deepEqual(s.notices(), ["The rebase didn't start. You're now on feat"]);
  assert.equal(opCalls(s, 'rebase').length, 0);
  // up to date once checked out
  const u = await setupR2({ handlers: { checkout: () => undefined, rebasePlan: () => plan({ isAncestor: true }) }, answers: [true] });
  assert.equal(await u.F.rebase(u.store, args), false);
  assert.deepEqual(u.notices(), ["feat is already up to date with main. You're now on feat"]);
  // the plan can't be read (invalid target): an alert, not a toast the notice would hide
  const e = await setupR2({ handlers: { checkout: () => undefined, rebasePlan: () => { throw err('invalid-args', 'onto is not a commit'); } }, answers: [true] });
  assert.equal(await e.F.rebase(e.store, args), false);
  assert.equal(e.dialogs[1].opts.title, "Checked out feat, but the rebase didn't start");
  assert.equal(e.dialogs[1].opts.message, 'onto is not a commit');
  assert.equal(e.errors().length, 0);
});

// ------------------------------------------------------------------ second review: keep a side, skip, stashes, repo switch

test('resolveWith on AU / UA entries: keeping the side without the file is a deletion, named in the danger confirm', async () => {
  const mg = { state: 'merging', branch: 'main', merge: { head: B40, name: 'side', message: 'm' }, conflicted: [H.conflict('au.txt', 'AU'), H.conflict('ua.txt', 'UA')] };
  const s = await setupOp(mg, { resolveWith: (p, side) => ({ path: p, side, deleted: true }) }, [true, true]);
  // AU: only main (ours) added it; theirs (side) has no version
  assert.equal(await s.F.resolveWith(s.store, { paths: ['au.txt'], side: 'theirs' }), true);
  const c = s.dialogs[0].opts;
  assert.deepEqual([c.title, c.confirmLabel, c.danger], ['Delete au.txt?', 'Delete File', true]);
  assert.equal(c.message, "au.txt is deleted from the working tree and the deletion is marked resolved (side doesn't have it). main's version of it and your edits are discarded.");
  assert.equal(s.notices()[0], 'Deleted au.txt');
  // UA: only side (theirs) added it; keeping main's side deletes it
  assert.equal(await s.F.resolveWith(s.store, { paths: ['ua.txt'], side: 'ours' }), true);
  assert.equal(s.dialogs[1].opts.title, 'Delete ua.txt?');
  assert.match(s.dialogs[1].opts.message, /\(main doesn't have it\)/);
  assert.deepEqual(opCalls(s, 'resolveWith').map((x) => x.args), [['au.txt', 'theirs'], ['ua.txt', 'ours']]);
});

test('rebaseSkip: no skip at an edit stop; the confirm says what each stop loses; dirty and invalid-args refusals explained', async () => {
  const edit = await setupOp(midRebase({ stop: 'edit' }), { rebaseSkip: () => ({ status: 'done' }) });
  assert.equal(await edit.F.rebaseSkip(edit.store), false);
  assert.deepEqual(edit.notices(), ['At an edit stop the commit is already made: continue the rebase to keep it, or abort the rebase']);
  assert.deepEqual([edit.dialogs.length, opCalls(edit, 'rebaseSkip').length], [0, 0]);

  const confirmOf = async (o, extra) => {
    const s = await setupOp(midRebase(o, extra), { rebaseSkip: () => ({ status: 'done' }) });
    await s.F.rebaseSkip(s.store);
    return s.dialogs[0].opts;
  };
  const conflict = await confirmOf({ conflicted: 1 }, { conflicted: [H.conflict('w.txt')] });
  assert.deepEqual([conflict.message, conflict.danger], ["Skip 'add the widget'? Its changes will be left out of the rebased branch. Your edits to its conflicted files are discarded.", true]);
  const empty = await confirmOf({ stop: 'empty' });
  assert.deepEqual([empty.message, empty.danger], ["Skip 'add the widget'? It has become empty (its changes are already in the branch), so nothing is lost.", false]);
  const hook = await confirmOf({ stop: 'hook' });
  assert.match(hook.message, /Its changes will be left out of the rebased branch\. The changes staged for it are discarded\.$/);

  const dirty = await setupOp(midRebase({ stop: 'hook' }), { rebaseSkip: () => { throw err('dirty', 'unrelated changes', { paths: ['x.txt', 'y.txt'], count: 5 }); } }, [true]);
  assert.equal(await dirty.F.rebaseSkip(dirty.store), false);
  assert.equal(dirty.errors().length, 0, 'not toasted');
  const a = dirty.dialogs[1].opts;
  assert.equal(a.title, "Can't skip the commit");
  assert.match(a.message, /would throw away the changes below/);
  assert.equal(a.detail, 'x.txt\ny.txt\nand 3 more');

  const inv = await setupOp(midRebase({ stop: 'other' }), { rebaseSkip: () => { throw err('invalid-args', 'cannot skip at an edit stop'); } }, [true]);
  assert.equal(await inv.F.rebaseSkip(inv.store), false);
  assert.equal(inv.errors().length, 0);
  assert.deepEqual(inv.notices(), ['cannot skip at an edit stop']);
});

test('pull: a Pull (rebase) whose changes came back unstaged says so; kept stashes explain their reason (dirty, untracked) and where to restore them', async () => {
  const s = await setup({}, { pull: () => ({ mode: 'rebase', before: 'a', after: 'c', fastForward: false, tagConflicts: [], indexRestored: false }) });
  assert.equal(await s.F.pull(s.store, 'rebase'), true);
  assert.deepEqual(s.notices(), ['Rebased main onto origin/main. Your local changes came back, but their staged part could not be restored, so all of them are unstaged']);

  const sha = 'e'.repeat(40);
  const cases = [
    ['ff-if-possible', 'dirty', "Pulled, but your changes weren't re-applied", /other changes now \(it was left as it is\)\.\n\nThey are safe in a stash \(eeeeeee\): pop it from the Stashes list/],
    ['rebase', 'dirty', "Pulled, but your changes weren't re-applied", /click Restore in the banner\.$/],
    ['ff-if-possible', 'untracked', "Pulled, but your changes weren't re-applied", /untracked files in the working tree are in the way.*move or delete the untracked files that are in the way, then pop the stash from the Stashes list\.$/s],
    ['rebase', 'untracked', "Pulled, but your changes weren't re-applied", /move or delete the untracked files that are in the way, then click Restore in the banner\.$/],
    ['ff-if-possible', undefined, 'Pulled, but your changes conflicted', /without conflicts, so the working tree was left as pulled/],
  ];
  for (const [mode, reason, title, re] of cases) {
    const p = await setup({}, { pull: () => { throw err('stash-conflict', 'kept', { stashKept: true, stash: sha, ...(reason ? { reason } : {}) }); } });
    assert.equal(await p.F.pull(p.store, mode), false);
    const d = p.dialogs[0].opts;
    assert.equal(d.title, title, `${mode} ${reason}`);
    assert.match(d.message, re, `${mode} ${reason}`);
    assert.doesNotMatch(d.message, /left clean/, 'a pull never says clean');
    assert.equal(d.detail, '');
  }
  // a failed reset without its message: no dangling "reset: "
  const r = await setup({}, { pull: () => { throw err('stash-conflict', 'kept', { stashKept: true, stash: sha, resetFailed: true }); } });
  await r.F.pull(r.store);
  assert.match(r.dialogs[0].opts.message, /couldn't be reset afterwards/);
  assert.equal(r.dialogs[0].opts.detail, '');
  const r2 = await setup({}, { pull: () => { throw err('stash-conflict', 'kept', { stashKept: true, stash: sha, resetFailed: true, resetError: 'index.lock exists' }); } });
  await r2.F.pull(r2.store);
  assert.equal(r2.dialogs[0].opts.detail, 'The working tree could not be reset: index.lock exists');
});

test('checkout / create branch: a kept stash is explained by its reason (dirty, untracked, conflict)', async () => {
  const sha = 'e'.repeat(40);
  const cases = [
    ['dirty', "Checked out, but your changes weren't re-applied", /other changes now/],
    ['untracked', "Checked out, but your changes weren't re-applied", /untracked files .* in the way.*move or delete/s],
    [undefined, 'Checked out, but your changes conflicted', /without conflicts, so the working tree was left clean/],
  ];
  for (const [reason, title, re] of cases) {
    const s = await setup({ local: [{ name: 'main', oid: A40, current: true }, { name: 'feat', oid: B40 }] }, { checkout: () => { throw err('stash-conflict', 'kept', { stashKept: true, stash: sha, ...(reason ? { reason } : {}) }); } });
    assert.equal(await s.F.checkout(s.store, { target: 'feat', kind: 'local' }), false);
    assert.equal(s.dialogs[0].opts.title, title);
    assert.match(s.dialogs[0].opts.message, /^Switched to feat\. Your local changes /);
    assert.match(s.dialogs[0].opts.message, re);
    assert.match(s.dialogs[0].opts.message, /safe in a stash \(eeeeeee\)/);
  }
  const b = await setup({}, { createBranch: () => { throw err('stash-conflict', 'kept', { stashKept: true, stash: sha, reason: 'dirty' }); } }, ['topic']);
  assert.equal(await b.F.createBranch(b.store, {}), false);
  assert.equal(b.dialogs[1].opts.title, "Branch created, but your changes weren't re-applied");
});

test('a merge / rebase that finished before an error: the outcome (kept stash) is reported, then the error', async () => {
  const sha = '7'.repeat(40);
  const failed = err('boom', 'could not write the undo record', { result: { status: 'done', fastForward: false, sha: 'e'.repeat(40) }, stashKept: true, stash: sha, reason: 'dirty' });
  const s = await setupR2({ handlers: { merge: () => { throw failed; } }, answers: [true] });
  assert.equal(await s.F.merge(s.store, { target: 'refs/heads/feat' }), true, 'the merge happened');
  assert.equal(s.dialogs[1].opts.title, "Merged, but your changes weren't re-applied");
  assert.match(s.dialogs[1].opts.message, /safe in a stash \(7777777\): commit, stash or discard your other changes, then click Restore in the banner/);
  assert.deepEqual(s.errors().map((e) => e.message), ['could not write the undo record'], 'the error, toasted once');

  const r = await setupR2({ handlers: { rebasePlan: () => plan(), rebase: () => { throw err('boom', 'late failure', { result: { status: 'done', branch: 'main', dropped: [], published: 0 } }); } } });
  assert.equal(await r.F.rebase(r.store, { onto: 'refs/heads/feat' }), true);
  assert.deepEqual(r.notices(), ['Rebased main onto feat']);
  assert.equal(r.errors().length, 1);
});

async function onFeat(s) {
  s.data.refs = H.refs({
    head: { branch: 'feat', oid: B40, detached: false },
    local: [
      { name: 'main', oid: A40, upstream: 'origin/main', ahead: 0, behind: 0, gone: false, current: false },
      { name: 'feat', oid: B40, upstream: 'origin/feat', ahead: 0, behind: 0, gone: false, current: true },
    ],
    remote: [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: A40 }, { name: 'origin/feat', remote: 'origin', branch: 'feat', oid: B40 }],
    tags: [],
  });
  s.data.status = { ...s.data.status, branch: 'feat', oid: B40, upstream: 'origin/feat' };
  await s.store.actions.refresh();
  await H.flush();
  return s;
}

test('rebase of a feature branch pushed only to its own upstream: no warning first, then "Force push feat?"', async () => {
  const own = plan({ head: B40, branch: 'feat', commits: [{ sha: B40 }], published: [{ sha: B40, remoteRefs: ['origin/feat'] }] });
  const s = await onFeat(await setupR2({ handlers: { rebasePlan: () => own, rebase: () => ({ status: 'done', branch: 'feat', dropped: [], published: 1 }) }, answers: [null] }));
  const r0 = await s.F.rebase(s.store, { onto: 'refs/heads/main' });
  assert.equal(r0, true);
  assert.deepEqual(s.dialogs.map((d) => [d.type, d.opts.title]), [['choose', 'Force push feat?']]);
  assert.equal(opCalls(s, 'rebase').length, 1);
  assert.equal(opCalls(s, 'push').length, 0, 'Later: nothing pushed');

  // the commit is on another remote branch as well: asked first, in plain words
  const shared = plan({ head: B40, branch: 'feat', commits: [{ sha: B40 }], published: [{ sha: B40, remoteRefs: ['origin/shared'] }] });
  const t = await onFeat(await setupR2({ handlers: { rebasePlan: () => shared, rebase: () => ({ status: 'done', branch: 'feat', dropped: [], published: 1 }) }, answers: [false] }));
  assert.equal(await t.F.rebase(t.store, { onto: 'refs/heads/main' }), false);
  assert.equal(t.dialogs[0].opts.title, 'Rewrite pushed commits?');
  assert.equal(t.dialogs[0].opts.message, 'Your commit is already pushed to origin/shared. Rebasing replaces it with a new copy, so anyone who already has it will see different commits.');
  assert.equal(t.dialogs[0].opts.danger, false, 'feat is not a main branch');
  assert.equal(opCalls(t, 'rebase').length, 0);
});

test('the force-push follow-up names the branch the rebase ran on (the result), none for a detached result', async () => {
  const published = [{ sha: A40, remoteRefs: ['origin/main'] }];
  const s = await setupR2({ handlers: { rebasePlan: () => plan({ published }), rebase: () => ({ status: 'done', branch: 'feat', dropped: [], published: 1 }) }, answers: [true, null] });
  assert.equal(await s.F.rebase(s.store, { onto: 'refs/tags/v1' }), true);
  assert.equal(s.dialogs[1].opts.title, 'Force push feat?');
  const d = await setupR2({ handlers: { rebasePlan: () => plan({ published }), rebase: () => ({ status: 'done', branch: null, dropped: [], published: 1 }) }, answers: [true, null] });
  assert.equal(await d.F.rebase(d.store, { onto: 'refs/tags/v1' }), true);
  assert.equal(d.dialogs.some((x) => x.type === 'choose'), false, 'nothing to push from a detached HEAD');
});

test('another repository opened mid-flow: the old flow\'s follow-ups (force push offer, abort, notices) stand down', async () => {
  const published = [{ sha: A40, remoteRefs: ['origin/main'] }];
  let finish;
  const s = await setupR2({
    handlers: {
      rebasePlan: () => plan({ published }),
      rebase: () => new Promise((r) => { finish = r; }),
      push: () => ({ remote: 'origin', branch: 'main', remoteBranch: 'main', forced: true }),
    },
    answers: [true, 'force', true],
  });
  const running = s.F.rebase(s.store, { onto: 'refs/tags/v1' });
  await H.flush();
  await s.store.actions.loadRepo({ root: '/other', name: 'other' }); // File > Open while git runs
  await H.flush();
  finish({ status: 'done', branch: 'main', dropped: [], published: 1 });
  assert.equal(await running, true);
  assert.deepEqual(s.dialogs.map((d) => d.opts.title), ['Rewrite pushed commits?'], 'no follow-up dialog for the old repo');
  assert.deepEqual(s.notices(), [], 'no notice either');
  assert.equal(opCalls(s, 'push').length, 0, 'nothing pushed to the new repo');
  assert.equal(s.F.isRunning(s.store), false, 'the lock is released');

  // an abort confirmed after the switch never runs in the new repo
  let answer;
  const a = await setupOp(midRebase(), { rebaseAbort: () => ({ status: 'aborted' }) });
  a.win.Components.dialog.confirm = () => new Promise((r) => { answer = r; });
  const aborting = a.F.rebaseAbort(a.store);
  await H.flush();
  await a.store.actions.loadRepo({ root: '/other', name: 'other' });
  await H.flush();
  answer(true);
  assert.equal(await aborting, false);
  assert.equal(opCalls(a, 'rebaseAbort').length, 0);
  assert.equal(a.errors().length, 0, 'nothing shown');
  assert.equal(a.store.state.repo.root, '/other');
});

test('mergeAbort / the merge banner mention the merge autostash (status.merge.autostash); rebaseResult of an empty stop suggests Skip', async () => {
  const s = await setupOp(midMerge({ autostash: '7'.repeat(40) }), { mergeAbort: () => ({ status: 'aborted' }) }, [true]);
  assert.equal(await s.F.mergeAbort(s.store), true);
  assert.match(s.dialogs[0].opts.message, /\n\nYour local changes from before the merge are re-applied\.$/);
  const n = await setupOp(midMerge(), { mergeAbort: () => ({ status: 'aborted' }) }, [true]);
  await n.F.mergeAbort(n.store);
  assert.doesNotMatch(n.dialogs[0].opts.message, /re-applied/);

  const e = await setupOp(midRebase({ conflicted: 1 }, { conflicted: [H.conflict('w.txt')] }), { rebaseSkip: () => ({ status: 'stopped', state: RB({ stop: 'empty', conflicted: 0 }) }) }, [true]);
  assert.equal(await e.F.rebaseSkip(e.store), true);
  assert.match(e.notices()[0], /has become empty: skip it to leave it out, or abort the rebase$/);
});

// ------------------------------------------------------------------ working tree (flows-worktree.js)

/** setup() with a WIP status: `unstaged`, `staged`, `conflicted` entries. */
async function setupWip({ unstaged = [], staged = [], conflicted = [] } = {}, handlers = {}, answers = []) {
  const s = await setup({}, handlers, answers);
  s.store.set({ status: { ...s.store.state.status, unstaged, staged, conflicted } });
  return s;
}

test('worktree flows: stage / unstage the given paths; stageAll stages only the listed files while conflicted; unstageAll', async () => {
  const ok = () => true;
  let s = await setupWip({ unstaged: [{ path: 'a.txt', status: 'M' }, { path: 'n.txt', status: '?' }], staged: [{ path: 'b.txt', status: 'M' }] },
    { stage: ok, unstage: ok, stageAll: ok, unstageAll: ok });
  assert.equal(await s.F.stage(s.store, ['a.txt']), true);
  assert.equal(await s.F.unstage(s.store, ['b.txt', 'old.txt']), true);
  assert.equal(await s.F.stageAll(s.store), true);
  assert.equal(await s.F.unstageAll(s.store), true);
  assert.equal(await s.F.stage(s.store, []), false, 'nothing to stage');
  assert.deepEqual(s.api.writes().map((c) => [c.op, ...c.args]), [['stage', ['a.txt']], ['unstage', ['b.txt', 'old.txt']], ['stageAll'], ['unstageAll']]);

  s = await setupWip({ unstaged: [{ path: 'a.txt', status: 'M' }], conflicted: [H.conflict('c.txt')] }, { stage: ok });
  assert.equal(await s.F.stageAll(s.store), true);
  assert.deepEqual(s.api.writes().map((c) => [c.op, ...c.args]), [['stage', ['a.txt']]], 'add -A would mark c.txt resolved');
  const clean = await setupWip();
  assert.equal(await clean.F.stageAll(clean.store), false, 'no unstaged changes');
});

test('worktree flows: discard confirms, re-checks the entries after the confirm, then discards; markResolved confirms', async () => {
  const entries = [{ path: 'a.txt', status: 'M' }, { path: 'n.txt', status: '?' }];
  let s = await setupWip({ unstaged: entries }, { discard: () => true }, [true]);
  assert.equal(await s.F.discard(s.store, entries, { all: true }), true);
  assert.equal(s.dialogs[0].type, 'confirm');
  assert.equal(s.dialogs[0].opts.title, 'Discard all changes?');
  assert.deepEqual(s.api.writes().map((c) => [c.op, ...c.args]), [['discard', [{ path: 'a.txt', status: 'M' }, { path: 'n.txt', status: '?' }]]]);

  s = await setupWip({ unstaged: entries }, { discard: () => true }, [false]);
  assert.equal(await s.F.discard(s.store, entries), false, 'cancelled');
  assert.deepEqual(s.api.writes(), []);

  s = await setupWip({ unstaged: entries }, { discard: () => true }, [() => { s.store.set({ status: { ...s.store.state.status, unstaged: [{ path: 'a.txt', status: 'D' }] } }); return true; }]);
  assert.equal(await s.F.discard(s.store, [entries[0]]), false, 'the file changed during the confirm');
  assert.deepEqual(s.api.writes(), []);
  assert.deepEqual(s.errors().map((e) => e.message), ['The file changed meanwhile — please retry']);

  s = await setupWip({ conflicted: [H.conflict('w.txt'), H.conflict('x.txt')] }, { markAllResolved: () => { throw err('nothing', 'nothing'); }, stage: () => true }, [true, true]);
  assert.equal(await s.F.markResolved(s.store, s.store.state.status.conflicted, { all: true }), true, 'nothing left: still fine');
  assert.equal(s.dialogs[0].opts.title, 'Mark 2 files as resolved?');
  assert.equal(await s.F.markResolved(s.store, [H.conflict('w.txt')]), true);
  assert.equal(s.dialogs[1].opts.title, 'Mark as resolved?');
  assert.deepEqual(s.api.writes().map((c) => [c.op, ...c.args]), [['markAllResolved'], ['stage', ['w.txt']]]);
  assert.equal(s.errors().length, 0);
});

test('worktree flows: commit / commitAll with amend; a hook refusal gets its alert with the hook output', async () => {
  let s = await setupWip({ staged: [{ path: 'b.txt', status: 'M' }] }, { commit: () => ({}), commitAll: () => ({}) });
  assert.equal(await s.F.commit(s.store, { message: 'fix: it', amend: true }), true);
  assert.equal(await s.F.commit(s.store, { message: 'feat: all', all: true }), true);
  assert.equal(await s.F.commit(s.store, { message: '  ' }), false, 'no message');
  assert.deepEqual(s.api.writes().map((c) => [c.op, ...c.args]), [['commit', 'fix: it', { amend: true }], ['commitAll', 'feat: all', { amend: false }]]);

  s = await setupWip({ staged: [{ path: 'b.txt', status: 'M' }] }, { commit: () => { throw err('hook-failed', 'lint failed\n'); } });
  assert.equal(await s.F.commit(s.store, { message: 'wip' }), false);
  assert.equal(s.dialogs[0].type, 'alert');
  assert.equal(s.dialogs[0].opts.title, 'Commit rejected by a hook');
  assert.equal(s.dialogs[0].opts.detail, 'lint failed');
  assert.equal(s.errors().length, 0, 'not toasted as well');
});

test('worktree flows: selections send the fingerprint; a stale file reloads the diff and tells the ui; discard asks; the ui hooks run in order', async () => {
  const target = { file: 'a.txt', selection: [{ hunk: 0, lines: [1, 2] }], fingerprint: 'fp1' };
  let s = await setupWip({ unstaged: [{ path: 'a.txt', status: 'M' }] }, { stageSelection: () => true, discardSelection: () => true }, [true]);
  const seen = [];
  const ui = Object.fromEntries(['begin', 'sending', 'hold', 'end', 'stale', 'fail'].map((k) => [k, () => seen.push(k)]));
  assert.equal(await s.F.stageSelection(s.store, target, ui), true);
  assert.deepEqual(seen, ['begin', 'sending', 'hold']);
  assert.equal(await s.F.discardSelection(s.store, { ...target, selection: [{ hunk: 1 }] }), true);
  assert.equal(s.dialogs[0].opts.title, 'Discard hunk?');
  assert.deepEqual(s.api.writes().map((c) => [c.op, ...c.args]), [
    ['stageSelection', 'a.txt', [{ hunk: 0, lines: [1, 2] }], { fingerprint: 'fp1' }],
    ['discardSelection', 'a.txt', [{ hunk: 1 }], { fingerprint: 'fp1' }],
  ]);

  s = await setupWip({ unstaged: [{ path: 'a.txt', status: 'M' }] }, { unstageSelection: () => { throw err('stale', 'changed'); } });
  let reloads = 0;
  s.store.actions.reloadDiff = () => { reloads++; return Promise.resolve(); };
  seen.length = 0;
  assert.equal(await s.F.unstageSelection(s.store, target, ui), false);
  assert.deepEqual(seen, ['begin', 'sending', 'stale', 'end']);
  assert.equal(reloads, 1);
  assert.equal(s.errors().length, 0, 'stale is explained by the diff view, not toasted');

  s = await setupWip({ unstaged: [{ path: 'a.txt', status: 'M' }] }, { discardSelection: () => true }, [false]);
  seen.length = 0;
  assert.equal(await s.F.discardSelection(s.store, target, ui), false);
  assert.equal(s.dialogs[0].opts.title, 'Discard 2 lines?');
  assert.deepEqual(seen, ['begin', 'end'], 'cancelled: nothing sent');
});

test('worktree flows share the flow lock and the bare refusal: a stage while another flow waits on a dialog, and in a bare repository', async () => {
  const s = await setupWip({ unstaged: [{ path: 'a.txt', status: 'M' }] }, { stage: () => true, createBranch: () => ({}) });
  let release;
  s.win.Components.dialog.prompt = () => new Promise((r) => { release = r; });
  const first = s.F.createBranch(s.store, {});
  await H.flush();
  assert.equal(await s.F.stage(s.store, ['a.txt']), false, 'refused while createBranch asks for a name');
  release(null);
  await first;
  assert.equal(await s.F.stage(s.store, ['a.txt']), true, 'free again');

  s.store.set({ repo: { ...s.store.state.repo, bare: true } });
  for (const [f, args] of [['stage', [['a.txt']]], ['stageAll', []], ['unstageAll', []], ['commit', [{ message: 'x' }]], ['discard', [[{ path: 'a.txt', status: 'M' }]]],
    ['stageSelection', [{ file: 'a.txt', selection: [{ hunk: 0 }], fingerprint: 'f' }]]]) {
    assert.equal(await s.F[f](s.store, ...args), false, f);
  }
  assert.deepEqual(s.api.writes().map((c) => c.op), ['stage'], 'nothing else was written');
  assert.match(s.notices().at(-1), /needs a working tree \(bare repository\)$/);
});

// ------------------------------------------------------------------ deleteBranches (bulk)

const bulkLocal = () => [
  { name: 'main', oid: 'a'.repeat(40), upstream: 'origin/main', current: true },
  { name: 'chore/a', oid: 'b'.repeat(40), upstream: null, current: false },
  { name: 'chore/b', oid: 'c'.repeat(40), upstream: null, current: false },
  { name: 'chore/c', oid: 'd'.repeat(40), upstream: null, current: false },
];
/** A deleteBranches handler: `fail` maps a name to [kind, message] (unless forced, for 'not-merged'). */
const bulkDelete = (fail = {}) => (names, o) => {
  const out = { deleted: [], failed: [] };
  for (const name of names) {
    const f = fail[name];
    if (f && !(o.force && f[0] === 'not-merged')) out.failed.push({ name, kind: f[0], message: f[1] });
    else out.deleted.push({ name, sha: 'b'.repeat(40), upstream: null });
  }
  return out;
};

test('deleteBranches: one confirmation listing the branches; the current branch is left out and named; one write', async () => {
  const { F, store, api, dialogs, notices } = await setup({ local: bulkLocal() }, { deleteBranches: bulkDelete() }, [true]);
  assert.equal(await F.deleteBranches(store, ['chore/a', 'main', 'chore/b', 'chore/a']), true);
  assert.equal(dialogs.length, 1);
  const { opts } = dialogs[0];
  assert.equal(opts.title, 'Delete 2 branches?');
  assert.equal(opts.confirmLabel, 'Delete 2 branches');
  assert.equal(opts.danger, true);
  assert.equal(opts.detail, 'chore/a\nchore/b');
  assert.match(opts.message, /Not deleted: main \(checked out\)/);
  assert.deepEqual(api.writes().map((c) => [c.op, ...c.args]), [['deleteBranches', ['chore/a', 'chore/b'], {}]]);
  assert.deepEqual(notices(), ['Deleted 2 branches']);
});

test('deleteBranches: a long list is listed in full (the detail box scrolls)', async () => {
  const local = [bulkLocal()[0], ...Array.from({ length: 15 }, (_, i) => ({ name: `b${i}`, oid: 'b'.repeat(40), upstream: null, current: false }))];
  const { F, store, dialogs } = await setup({ local }, { deleteBranches: bulkDelete() }, [false]);
  assert.equal(await F.deleteBranches(store, local.slice(1).map((b) => b.name)), false, 'cancelled');
  assert.equal(dialogs[0].opts.detail.split('\n').length, 15);
});

test('deleteBranches: only the current branch -> an alert, no write; cancel -> no write', async () => {
  const { F, store, api, dialogs } = await setup({ local: bulkLocal() }, { deleteBranches: bulkDelete() });
  assert.equal(await F.deleteBranches(store, ['main']), false);
  assert.equal(dialogs[0].type, 'alert');
  assert.equal(dialogs[0].opts.title, 'Nothing to delete');
  assert.equal(await F.deleteBranches(store, ['chore/a']), false, 'confirm answered no');
  assert.equal(await F.deleteBranches(store, []), false);
  assert.equal(await F.deleteBranches(store, 'chore/a'), false);
  assert.deepEqual(api.writes(), []);
});

test('deleteBranches: unmerged branches are offered for a force delete together; other failures are listed, the rest deleted', async () => {
  const fail = { 'chore/a': ['not-merged', 'not fully merged'], 'chore/b': ['checked-out-elsewhere', "cannot delete branch 'chore/b' used by worktree at '/w'"] };
  const { F, store, api, dialogs } = await setup({ local: bulkLocal() }, { deleteBranches: bulkDelete(fail) }, [true, true, undefined]);
  assert.equal(await F.deleteBranches(store, ['chore/a', 'chore/b', 'chore/c']), true);
  assert.deepEqual(api.writes().map((c) => [c.op, ...c.args]), [
    ['deleteBranches', ['chore/a', 'chore/b', 'chore/c'], {}],
    ['deleteBranches', ['chore/a'], { force: true }],
  ]);
  assert.deepEqual(dialogs.map((d) => d.type), ['confirm', 'confirm', 'alert']);
  assert.equal(dialogs[1].opts.title, 'Branch not fully merged');
  assert.equal(dialogs[1].opts.confirmLabel, 'Force Delete');
  assert.match(dialogs[1].opts.message, /^chore\/a has commits that aren't merged/, 'one branch: named, as deleteBranch does');
  assert.equal(dialogs[1].opts.detail, undefined);
  assert.equal(dialogs[2].opts.title, '1 branch could not be deleted');
  assert.equal(dialogs[2].opts.message, 'Deleted 2 branches. Not deleted:');
  assert.equal(dialogs[2].opts.detail, "chore/b: cannot delete branch 'chore/b' used by worktree at '/w'");
});

test('deleteBranches: declining the force delete keeps the unmerged ones and says so', async () => {
  const fail = { 'chore/a': ['not-merged', 'x'], 'chore/b': ['not-merged', 'y'] };
  const { F, store, api, dialogs, notices } = await setup({ local: bulkLocal() }, { deleteBranches: bulkDelete(fail) }, [true, false]);
  assert.equal(await F.deleteBranches(store, ['chore/a', 'chore/b', 'chore/c']), true);
  assert.equal(api.writes().length, 1);
  assert.equal(dialogs[1].opts.title, '2 branches not fully merged');
  assert.equal(dialogs[1].opts.detail, 'chore/a\nchore/b');
  assert.deepEqual(notices(), ['Deleted 1 branch (kept 2 not fully merged)']);
});

test('deleteBranches: declining the force delete when nothing else was deleted says "No branches deleted"', async () => {
  const fail = { 'chore/a': ['not-merged', 'x'], 'chore/b': ['not-merged', 'y'] };
  const { F, store, notices } = await setup({ local: bulkLocal() }, { deleteBranches: bulkDelete(fail) }, [true, false]);
  assert.equal(await F.deleteBranches(store, ['chore/a', 'chore/b']), false);
  assert.deepEqual(notices(), ['No branches deleted (kept 2 not fully merged)']);
});

test('deleteBranches: more than the backend accepts in one write -> an alert before the confirmation, no write', async () => {
  const local = [bulkLocal()[0], ...Array.from({ length: 1001 }, (_, i) => ({ name: `b${i}`, oid: 'b'.repeat(40), upstream: null, current: false }))];
  const { F, store, api, dialogs } = await setup({ local }, { deleteBranches: bulkDelete() });
  assert.equal(await F.deleteBranches(store, local.slice(1).map((b) => b.name)), false);
  assert.deepEqual(dialogs.map((d) => [d.type, d.opts.title]), [['alert', 'Too many branches (1001)']]);
  assert.match(dialogs[0].opts.message, /At most 1000 branches/);
  assert.deepEqual(api.writes(), []);
});

test('deleteBranches: a branch checked out in a linked worktree of a normal repository is left out (the worktrees are re-read)', async () => {
  const worktrees = [{ path: '/r', branch: 'main', bare: false }, { path: '/w/b', branch: 'chore/b', bare: false }];
  const { F, store, api, dialogs } = await setup({ local: bulkLocal(), worktrees }, { deleteBranches: bulkDelete() }, [true]);
  assert.deepEqual(store.state.worktrees, worktrees, 'the store keeps them for every repository');
  const before = api.calls.length;
  assert.equal(await F.deleteBranches(store, ['chore/a', 'chore/b']), true);
  assert.equal(api.calls.slice(before).filter((c) => c.op === 'worktrees').length, 1, 'the flow re-reads them');
  assert.equal(dialogs[0].opts.detail, 'chore/a');
  assert.match(dialogs[0].opts.message, /Not deleted: chore\/b \(checked out in the worktree \/w\/b\)/);
  assert.deepEqual(api.writes().map((c) => [c.op, ...c.args]), [['deleteBranches', ['chore/a'], {}]]);
});

test('deleteBranch: a branch checked out in a linked worktree is refused before the confirmation; a failed worktrees read still asks', async () => {
  const worktrees = [{ path: '/w/b', branch: 'chore/b', bare: false }];
  let s = await setup({ local: bulkLocal(), worktrees }, { deleteBranch: (name) => ({ name, sha: 'c'.repeat(40), upstream: null }) });
  assert.equal(await s.F.deleteBranch(s.store, 'chore/b'), false);
  assert.deepEqual(s.dialogs.map((d) => [d.type, d.opts.title, d.opts.message]), [
    ['alert', 'Cannot delete this branch', 'chore/b is checked out in the worktree /w/b: it can’t be deleted'],
  ]);
  assert.deepEqual(s.api.writes(), []);

  s = await setup({ local: bulkLocal() }, { worktrees: () => { throw err('boom', 'no worktrees'); }, deleteBranch: (name) => ({ name, sha: 'c'.repeat(40), upstream: null }) }, [true]);
  assert.equal(await s.F.deleteBranch(s.store, 'chore/b'), true);
  assert.equal(s.dialogs[0].opts.title, 'Delete branch?');
});

test('deleteBranches: a delete whose undo record failed is deleted, and its warning is shown', async () => {
  const handler = (names) => ({ deleted: names.map((name) => ({ name, sha: 'b'.repeat(40), upstream: null, ...(name === 'chore/b' ? { undoRecorded: false, warning: 'could not record' } : {}) })), failed: [] });
  const { F, store, dialogs, notices } = await setup({ local: bulkLocal() }, { deleteBranches: handler }, [true]);
  assert.equal(await F.deleteBranches(store, ['chore/a', 'chore/b']), true);
  assert.deepEqual(dialogs.map((d) => d.type), ['confirm', 'alert']);
  assert.equal(dialogs[1].opts.title, 'Deleted 2 branches');
  assert.equal(dialogs[1].opts.message, 'Deleted 2 branches.');
  assert.equal(dialogs[1].opts.detail, 'chore/b: could not record');
  assert.deepEqual(notices(), []);
});

test('deleteBranches: a force write that rejects still gets the summary, with the unmerged branches listed as not deleted', async () => {
  const handler = (names, o) => {
    if (o.force) throw err('boom', 'disk full');
    return bulkDelete({ 'chore/a': ['not-merged', 'x'] })(names, o);
  };
  const { F, store, api, dialogs, errors } = await setup({ local: bulkLocal() }, { deleteBranches: handler }, [true, true]);
  assert.equal(await F.deleteBranches(store, ['chore/a', 'chore/b']), true);
  assert.equal(api.writes().length, 2);
  assert.deepEqual(dialogs.map((d) => d.type), ['confirm', 'confirm', 'alert']);
  assert.equal(dialogs[2].opts.title, '1 branch could not be deleted');
  assert.equal(dialogs[2].opts.message, 'Deleted 1 branch. Not deleted:');
  assert.equal(dialogs[2].opts.detail, 'chore/a: disk full');
  assert.deepEqual(errors().map((e) => e.message), ['disk full'], 'toasted once by the write');
});

test('deleteBranches: another repository opened before the force question: no question, no force write, nothing shown', async () => {
  let finish;
  const handler = (names, o) => (o.force ? bulkDelete()(names, o) : new Promise((r) => { finish = () => r(bulkDelete({ 'chore/a': ['not-merged', 'x'] })(names, o)); }));
  const { F, store, api, dialogs, notices, errors } = await setup({ local: bulkLocal() }, { deleteBranches: handler }, [true, true]);
  const running = F.deleteBranches(store, ['chore/a', 'chore/b']);
  await H.flush();
  await store.actions.loadRepo({ root: '/other', name: 'other' });
  await H.flush();
  finish();
  assert.equal(await running, true, 'chore/b was deleted');
  assert.deepEqual(dialogs.map((d) => d.opts.title), ['Delete 2 branches?']);
  assert.equal(api.writes().filter((c) => c.op === 'deleteBranches').length, 1);
  assert.deepEqual(notices(), []);
  assert.deepEqual(errors(), []);
  assert.equal(F.isRunning(store), false);
});
