'use strict';
// Bare repositories, renderer half: the availability titles, the worktree-needing items
// of every menu (sidebar rows, graph rows and ref pills, stashes) and double-clicks, the flow
// wrapper's refusal, createBranch without checkout, Pull as Fetch All, openWorktree, the bare banner
// model, and the store (no WIP row, HEAD selected, state.worktrees). The mounted toolbar and banner
// are in toolbar.test.js / rebase-banner.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const ACTIONS = require.resolve('../renderer/actions.js');
const SHA = (c) => c.repeat(40);
const BARE = { root: '/w/myproject/.bare', name: 'myproject/.bare', bare: true };
const NEEDS = / — needs a working tree \(bare repository\)$/;

function loadInto(win, file) {
  delete require.cache[ACTIONS];
  const A = require(ACTIONS);
  const p = require.resolve(`../renderer/components/${file}`);
  delete require.cache[p];
  return { A, mod: require(p) };
}

/** main's synthetic clean status of a bare repository (the CONTRACT's shape). */
const bareStatus = (o = {}) => ({
  ...H.status({ oid: SHA('a'), branch: 'main' }), upstream: 'origin/main', ahead: 1, behind: 0,
  state: 'clean', rebase: null, merge: null, pendingAutostash: null, bare: true, ...o,
});

/** A bare repo: main (HEAD) at a tracking origin/main (at b), feat at e; a -> b, e -> b; tag v1 at b. */
function state(extra = {}) {
  return {
    repo: BARE, busy: false, remotes: ['origin'],
    status: bareStatus(),
    refs: H.refs({
      head: { branch: 'main', oid: SHA('a'), detached: false },
      local: [
        { name: 'main', oid: SHA('a'), upstream: 'origin/main', ahead: 1, behind: 0, gone: false, current: true },
        { name: 'feat', oid: SHA('e'), upstream: null, ahead: 0, behind: 0, gone: false, current: false },
      ],
      remote: [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: SHA('b') }],
      tags: [{ name: 'v1', oid: SHA('b') }],
    }),
    commits: [H.commit(SHA('e'), [SHA('b')]), H.commit(SHA('a'), [SHA('b')]), H.commit(SHA('b'))],
    refsBySha: new Map(),
    stashes: [],
    undo: { undo: { action: 'delete_branch', description: 'Undo delete branch old' }, redo: null, busy: false, undoBlocked: null, redoBlocked: null },
    ...extra,
  };
}

const FLOWS = ['checkout', 'createBranch', 'deleteBranch', 'push', 'pull', 'fetch', 'setUpstream', 'merge', 'rebase', 'interactiveRebase', 'stashApply', 'stashPop', 'stashDrop'];
const flows = Object.fromEntries(FLOWS.map((n) => [n, async () => true]));
const byFlow = (items, flow) => items.filter((d) => !d.separator && d.flow === flow);
const WORKTREE = new Set(['checkout', 'merge', 'rebase', 'interactiveRebase', 'stashApply', 'stashPop', 'stashDrop']);

/** Every worktree-needing item is disabled with the bare title; every other item is enabled. */
function assertGated(items, what) {
  assert.ok(items.length, `${what}: has items`);
  for (const d of items) {
    if (d.separator) continue;
    if (WORKTREE.has(d.flow)) {
      assert.equal(d.disabled, true, `${what}: ${d.label} disabled`);
      assert.match(d.title, NEEDS, `${what}: ${d.label} says why`);
    }
  }
}

// ------------------------------------------------------------------ availability

test('availability in a bare repository: Pull only as Fetch All, no Stash / Pop, Branch without checkout; push, fetch, undo stay', () => {
  H.loadRenderer();
  delete require.cache[ACTIONS];
  const A = require(ACTIONS);
  const s = state();
  const m = A.availability(s, { pullMode: 'ff-if-possible', pullLabel: 'Pull (fast-forward if possible)' });
  assert.deepEqual(m.pull, { disabled: true, title: 'Pull (fast-forward if possible) — needs a working tree (bare repository)' });
  assert.equal(m.pullMenu.disabled, false);
  assert.deepEqual(A.availability(s, { pullMode: 'fetch' }).pull, { disabled: false, title: 'Fetch All: fetch every remote' });
  assert.deepEqual(m.stash, { disabled: true, title: 'Stash — needs a working tree (bare repository)' });
  assert.deepEqual(m.pop, { disabled: true, title: 'Pop — needs a working tree (bare repository)' });
  assert.deepEqual(m.branch, { disabled: false, title: 'Create a branch at main (not checked out)' });
  assert.equal(m.switcher.disabled, false);
  assert.match(m.switcher.title, /^main \(HEAD of the bare repository\)/);
  assert.deepEqual(m.push, { disabled: false, title: 'Push main to origin/main (1 commit ahead)' });
  assert.deepEqual(m.fetch, { disabled: false, title: 'Fetch all remotes' });
  assert.deepEqual(m.undo, { disabled: false, title: 'Undo delete branch old' });
  assert.equal(m.terminal.disabled, false);
  // stashes can't exist, but even a listed one isn't popped; busy still wins
  assert.equal(A.availability(state({ stashes: [{ hash: SHA('9'), ref: 'stash@{0}', message: 'x' }] })).pop.disabled, true);
  assert.equal(A.availability(state({ busy: true })).push.title, 'Push — Working…');
  // without remotes the usual reason stays
  assert.match(A.availability(state({ remotes: [], refs: H.refs() })).pull.title, /no remotes configured/);
  // a normal repository is unchanged
  const normal = A.availability(state({ repo: { root: '/r', name: 'r' }, status: { ...bareStatus(), bare: undefined, unstaged: [{ path: 'a', status: 'M' }] } }), { dirty: true });
  assert.equal(normal.stash.disabled, false);
  assert.equal(normal.branch.title, 'Create a branch at main');
});

test('bareBlocked / isBare / WORKTREE_FLOWS: the flows that need a working tree, and pull in any mode but fetch', () => {
  H.loadRenderer();
  delete require.cache[ACTIONS];
  const A = require(ACTIONS);
  const s = state();
  assert.equal(A.isBare(s), true);
  assert.equal(A.isBare({ repo: { root: '/r' } }), false);
  assert.equal(A.isBare(null), false);
  assert.equal(A.bareTitle('Checkout'), 'Checkout — needs a working tree (bare repository)');
  for (const f of ['checkout', 'stashSave', 'stashPop', 'stashApply', 'stashDrop', 'merge', 'rebase', 'interactiveRebase',
    'startInteractiveRebase', 'rebaseContinue', 'rebaseSkip', 'rebaseAbort', 'mergeCommit', 'mergeAbort', 'restoreAutostash', 'resolveWith']) {
    assert.ok(Object.hasOwn(A.WORKTREE_FLOWS, f), f);
    assert.match(A.bareBlocked(s, f, []), NEEDS, f);
    assert.equal(A.bareBlocked({ ...s, repo: { root: '/r' } }, f, []), null, `${f} runs in a normal repo`);
  }
  assert.equal(A.bareBlocked(s, 'pull', ['ff-only']), 'Pull — needs a working tree (bare repository)');
  for (const [f, args] of [['pull', ['fetch']], ['pull', []], ['fetch', []], ['push', [{}]], ['createBranch', [{}]], ['deleteBranch', ['x']],
    ['setUpstream', ['x']], ['undo', []], ['redo', []], ['openTerminal', []], ['openWorktree', ['/w/main']], ['cancel', []]]) {
    assert.equal(A.bareBlocked(s, f, args), null, f);
  }
  assert.ok(A.FREE_FLOWS.has('openWorktree'), 'the banner buttons work while busy');
});

// ------------------------------------------------------------------ menus

test('refMenuItems in a bare repository: checkout / merge / rebase disabled with the reason; push, branch, upstream, delete, fetch stay', () => {
  const win = H.loadRenderer();
  const { A } = loadInto(win, 'sidebar.js');
  const s = state();
  const feat = A.refMenuItems({ kind: 'local', name: 'feat', oid: SHA('e'), current: false }, s, flows);
  assertGated(feat, 'feat');
  assert.deepEqual(byFlow(feat, 'checkout').map((d) => d.title), ['Checkout — needs a working tree (bare repository)']);
  assert.deepEqual(byFlow(feat, 'merge').map((d) => d.title), ['Merge — needs a working tree (bare repository)']);
  assert.deepEqual(byFlow(feat, 'interactiveRebase').map((d) => d.title), ['Interactive rebase — needs a working tree (bare repository)']);
  for (const f of ['push', 'createBranch', 'setUpstream', 'deleteBranch']) assert.equal(byFlow(feat, f)[0].disabled, undefined, f);

  const main = A.refMenuItems({ kind: 'local', name: 'main', oid: SHA('a'), current: true }, s, flows);
  assertGated(main, 'main');
  assert.equal(byFlow(main, 'checkout')[0].title, 'Checkout — needs a working tree (bare repository)', 'the bare reason wins over "Already checked out"');
  assert.deepEqual(byFlow(main, 'rebase').map((d) => d.label), ['Rebase main onto origin/main'], 'onto its upstream, disabled');
  assert.equal(byFlow(main, 'deleteBranch')[0].disabled, true);
  assert.match(byFlow(main, 'deleteBranch')[0].title, /HEAD of the bare repository points at this branch/);
  assert.equal(byFlow(main, 'push')[0].disabled, undefined);

  const remote = A.refMenuItems({ kind: 'remote', name: 'origin/main', oid: SHA('b'), current: false, remote: 'origin' }, s, flows);
  assertGated(remote, 'origin/main');
  assert.equal(byFlow(remote, 'fetch')[0].disabled, undefined);
  assert.equal(byFlow(remote, 'createBranch')[0].disabled, undefined);
  const tag = A.refMenuItems({ kind: 'tag', name: 'v1', oid: SHA('b'), current: false }, s, flows);
  assertGated(tag, 'v1');
  assert.equal(byFlow(tag, 'createBranch')[0].disabled, undefined);
});

test('refMenuItems: Delete is off for a branch checked out in a linked worktree (state.worktrees)', () => {
  const win = H.loadRenderer();
  const { A } = loadInto(win, 'sidebar.js');
  const worktrees = [
    { path: '/w/myproject/.bare', head: SHA('a'), branch: 'main', bare: true, detached: false, locked: false, prunable: false },
    { path: '/w/myproject/feat', head: SHA('e'), branch: 'feat', bare: false, detached: false, locked: false, prunable: false },
  ];
  const del = byFlow(A.refMenuItems({ kind: 'local', name: 'feat', oid: SHA('e'), current: false }, state({ worktrees }), flows), 'deleteBranch')[0];
  assert.deepEqual([del.disabled, del.title], [true, 'feat is checked out in the worktree /w/myproject/feat: it can’t be deleted']);
});

test('graph row and pill menus, stash menus and double-clicks in a bare repository', () => {
  const win = H.loadRenderer();
  const { A, mod: G } = loadInto(win, 'graph-view.js');
  const s = state();
  // a commit outside HEAD's history: checkout, rebase, merge off; create branch on
  const row = { kind: 'commit', commit: s.commits[0] };
  const items = G.commitMenuItems(row, s, flows);
  assertGated(items, 'commit e');
  assert.ok(byFlow(items, 'rebase').length && byFlow(items, 'merge').length);
  assert.equal(byFlow(items, 'createBranch')[0].disabled, undefined);
  // pills: the same menu as the sidebar; double-click checks nothing out
  const pill = { kind: 'local', ref: 'feat', current: false };
  assertGated(G.pillMenuItems(pill, row, s, flows), 'feat pill');
  assert.equal(G.pillAction(pill, s), null);
  assert.deepEqual(G.pillAction(pill, { ...s, repo: { root: '/r', name: 'r' } }).flow, 'checkout', 'a normal repo still checks out');

  const { mod: S } = loadInto(win, 'sidebar.js');
  const entry = { hash: SHA('9'), ref: 'stash@{0}', message: 'x', index: 0 };
  const stash = S.stashMenuItems(entry, s, flows);
  assertGated(stash, 'stash');
  assert.ok(stash.filter((d) => !d.separator).every((d) => d.disabled));
  assert.equal(S.doubleClickAction({ kind: 'local', name: 'feat', oid: SHA('e'), current: false }, s), null);
  assert.equal(S.doubleClickAction({ kind: 'remote', name: 'origin/main', oid: SHA('b'), current: false, remote: 'origin' }, s), null);
  assert.equal(S.doubleClickAction({ kind: 'stash', entry }, s), null);
  assert.equal(S.doubleClickAction({ kind: 'local', name: 'feat', current: false }, { ...s, repo: { root: '/r', name: 'r' } }).flow, 'checkout');
  void A;
});

// ------------------------------------------------------------------ flows

function baseData() {
  return {
    status: bareStatus(),
    refs: state().refs,
    stashes: [],
    log: { commits: state().commits, hasMore: false, next: null },
    undoState: { undo: null, redo: null, busy: false, undoBlocked: 'Needs a working tree (bare repository)', redoBlocked: null },
    remotes: ['origin'],
  };
}

async function setup(handlers = {}, answers = [], repo = BARE) {
  H.setLocalStorage(H.memoryStorage());
  const win = H.loadFlows();
  const api = H.scriptedApi(baseData(), { worktrees: () => [], ...handlers });
  const opened = [];
  api.app.openWorktree = async (p, o) => { opened.push([p, o]); return { root: p }; };
  win.api = api;
  const store = win.Store.create(api);
  const toasts = [];
  store.setToast((e) => toasts.push(e));
  await store.actions.loadRepo(repo);
  await H.flush();
  const dialogs = H.scriptDialogs(win, answers);
  const notices = () => toasts.filter((t) => t.level === 'info').map((t) => t.message);
  const errors = () => toasts.filter((t) => t.level !== 'info');
  const writes = () => api.writes().map((c) => c.op).filter((op) => op !== 'worktrees');
  return { win, api, store, F: win.PLFlows, dialogs, notices, errors, writes, opened };
}

test('flow wrapper: every flow that needs a working tree refuses in a bare repository with a notice, before any dialog or write', async () => {
  const t = await setup();
  const calls = [
    ['checkout', { target: 'feat', kind: 'local' }], ['stashSave'], ['stashPop'], ['stashApply', 0], ['stashDrop', 0],
    ['merge', { target: 'refs/heads/feat' }], ['rebase', { onto: 'refs/heads/feat' }], ['interactiveRebase', { upstream: 'refs/heads/feat' }],
    ['startInteractiveRebase'], ['rebaseContinue'], ['rebaseSkip'], ['rebaseAbort'], ['mergeCommit'], ['mergeAbort'],
    ['restoreAutostash', { keep: false }], ['resolveWith', { paths: ['a'], side: 'ours' }], ['pull', 'ff-only'], ['pull', 'rebase'],
  ];
  for (const [name, ...args] of calls) assert.equal(await t.F[name](t.store, ...args), false, name);
  assert.deepEqual(t.writes(), []);
  assert.equal(t.dialogs.length, 0);
  assert.equal(t.notices().length, calls.length);
  assert.ok(t.notices().every((n) => NEEDS.test(n)), t.notices().join('\n'));
  assert.equal(t.notices()[0], 'Checkout — needs a working tree (bare repository)');
  assert.equal(t.F.isRunning(t.store), false, 'a refusal takes no lock');
});

test('pull in a bare repository: the default mode is Fetch All (the stored default is kept)', async () => {
  const t = await setup({ pull: () => ({ status: 'fetched', tagConflicts: [] }) });
  t.win.Components.util.storage.set(`pl.pullMode.${t.win.Components.util.repoKey(BARE.root)}`, 'rebase');
  assert.equal(t.F.pullMode(t.store), 'fetch');
  assert.equal(await t.F.pull(t.store), true);
  assert.equal(await t.F.pull(t.store, 'fetch'), true);
  assert.deepEqual(t.api.writes().filter((c) => c.op === 'pull').map((c) => c.args), [[{ mode: 'fetch' }], [{ mode: 'fetch' }]]);
  assert.equal(t.win.Components.util.storage.get(`pl.pullMode.${t.win.Components.util.repoKey(BARE.root)}`), 'rebase');
});

test('createBranch in a bare repository never checks out (even when asked to)', async () => {
  const t = await setup({ createBranch: (name) => ({ name, sha: SHA('a') }) }, [
    (o) => { assert.equal(o.okLabel, 'Create'); assert.doesNotMatch(o.message, /checked out/); return 'topic'; },
    'other',
  ]);
  assert.equal(await t.F.createBranch(t.store, {}), true);
  assert.equal(await t.F.createBranch(t.store, { start: SHA('e'), checkout: true }), true);
  assert.deepEqual(t.api.writes().filter((c) => c.op === 'createBranch').map((c) => c.args), [
    ['topic', { checkout: false }], ['other', { start: SHA('e'), checkout: false }],
  ]);
});

test('push, fetch, deleteBranch still run in a bare repository', async () => {
  const t = await setup({
    fetch: () => ({ tagConflicts: [] }),
    push: () => ({ remote: 'origin', remoteBranch: 'main' }),
    deleteBranch: () => ({ sha: SHA('e') }),
  }, [true]);
  assert.equal(await t.F.fetch(t.store), true);
  assert.equal(await t.F.push(t.store), true);
  assert.equal(await t.F.deleteBranch(t.store, 'feat'), true);
  assert.deepEqual(t.writes(), ['fetch', 'push', 'deleteBranch']);
});

test('openWorktree: opens the path through window.api.app.openWorktree (main picks its tab), also while busy; errors are shown', async () => {
  const t = await setup();
  assert.equal(await t.F.openWorktree(t.store, '/w/myproject/main'), true);
  assert.deepEqual(t.opened, [['/w/myproject/main', undefined]], 'no newTab: main focuses a tab that has it open');
  t.store.set({ busy: true });
  assert.equal(await t.F.openWorktree(t.store, '/w/x'), true, 'free while busy');
  t.store.set({ busy: false });
  assert.equal(await t.F.openWorktree(t.store, ''), false);
  assert.equal(t.opened.length, 2);
  t.win.api.app.openWorktree = async () => { throw { message: 'Not a worktree of this repository', kind: 'not-a-worktree' }; };
  assert.equal(await t.F.openWorktree(t.store, '/etc'), false);
  assert.deepEqual(t.errors().map((e) => e.message), ['Not a worktree of this repository']);
  delete t.win.api.app.openWorktree;
  assert.equal(await t.F.openWorktree(t.store, '/w/x'), false);
  assert.match(t.errors().at(-1).message, /not available/);
});

test('flows in a normal repository are unchanged: checkout runs, createBranch checks out', async () => {
  const t = await setup({ checkout: () => ({}), createBranch: (name) => ({ name }) }, ['topic'], { root: '/r', name: 'r' });
  assert.equal(t.api.calls.filter((c) => c.op === 'worktrees').length, 1, 'worktrees are read for every repository');
  assert.equal(await t.F.checkout(t.store, { target: 'feat', kind: 'local' }), true);
  assert.equal(await t.F.createBranch(t.store, {}), true);
  assert.deepEqual(t.api.writes().filter((c) => c.op === 'createBranch').map((c) => c.args), [['topic', { checkout: true }]]);
});

// ------------------------------------------------------------------ banner model

test('bannerModel: a bare repository gets its banner with one "Open worktree" button per openable worktree', () => {
  const win = H.loadRenderer();
  const Op = win.PLOp;
  const worktrees = [
    { path: '/w/myproject/.bare', head: SHA('a'), branch: 'main', bare: true, detached: false, locked: false, prunable: false },
    { path: '/w/myproject/main', head: SHA('a'), branch: 'main', bare: false, detached: false, locked: false, prunable: false },
    { path: '/w/myproject/review', head: SHA('e'), branch: null, bare: false, detached: true, locked: true, prunable: false },
    { path: '/w/gone', head: SHA('b'), branch: 'old', bare: false, detached: false, locked: false, prunable: true },
    { path: '/w/usb', head: SHA('b'), branch: 'usb', bare: false, detached: false, locked: true, prunable: false, missing: true },
  ];
  const m = Op.bannerModel(state({ worktrees }));
  assert.equal(m.kind, 'bare');
  assert.equal(m.title, 'Bare repository — no working tree');
  assert.deepEqual(m.lines, ['Commit, checkout, stash, merge and rebase need a worktree.']);
  assert.deepEqual(m.buttons.map((b) => [b.label, b.flow, b.args, !!b.primary]), [
    ['Open worktree main', 'openWorktree', ['/w/myproject/main'], true],
    ['Open worktree review', 'openWorktree', ['/w/myproject/review'], false],
  ]);
  assert.equal(m.buttons[1].title, 'Open /w/myproject/review in a new tab (locked)');
  assert.equal(new Set(m.buttons.map((b) => b.id)).size, 2, 'unique ids');
  assert.deepEqual(Op.bareWorktrees(worktrees).map((w) => w.path), ['/w/myproject/main', '/w/myproject/review']);

  const none = Op.bannerModel(state({ worktrees: [worktrees[0]] }));
  assert.equal(none.buttons.length, 0);
  assert.match(none.lines[1], /git worktree add/);
  const unknown = Op.bannerModel(state({ worktrees: null }));
  assert.deepEqual([unknown.buttons.length, unknown.lines.length], [0, 1], 'not read yet: no hint');
  assert.equal(Op.bannerModel(state({ repo: { root: '/r', name: 'r' } })), null, 'a clean normal repo has no banner');
  // hostile names reach the labels display-safe
  const odd = Op.bannerModel(state({ worktrees: [{ path: '/w/x', branch: 'x\u202e', bare: false, prunable: false }] }));
  assert.equal(odd.buttons[0].label, 'Open worktree x\\u{202E}');
});

test('bannerModel: a detached worktree is named by its folder, with Windows separators too', () => {
  const Op = H.loadRenderer().PLOp;
  const wt = (p) => ({ path: p, head: SHA('e'), branch: null, bare: false, detached: true, locked: false, prunable: false });
  const labels = (paths) => Op.bannerModel(state({ worktrees: paths.map(wt) })).buttons.map((b) => b.label);
  assert.deepEqual(labels(['C:\\w\\proj\\review', 'C:\\w\\proj\\fix\\', 'C:/w/proj/spike', '/w/proj/next/']), [
    'Open worktree review', 'Open worktree fix', 'Open worktree spike', 'Open worktree next',
  ]);
});

test('fsBaseName splits on / and \\; baseName (git paths) on / only', () => {
  const Op = H.loadRenderer().PLOp;
  for (const [p, want] of [['C:\\a\\b', 'b'], ['C:\\a\\b\\\\', 'b'], ['/a/b/', 'b'], ['a/b\\c', 'c'], ['b', 'b'], ['', ''], [null, '']]) {
    assert.equal(Op.fsBaseName(p), want, JSON.stringify(p));
  }
  assert.equal(Op.baseName('dir/a\\b.txt'), 'a\\b.txt', 'a POSIX file name may hold a backslash');
  assert.equal(Op.baseName('dir/sub/'), 'sub');
  assert.equal(Op.baseName('/'), '/', 'nothing but separators: kept as is');
  assert.equal(Op.fsBaseName('\\'), '\\');
});

// ------------------------------------------------------------------ store

test('store: a bare repository has no WIP row, selects HEAD, and reads its worktrees with each full refresh', async () => {
  const commits = [H.commit(SHA('a'), [SHA('b')]), H.commit(SHA('b'))];
  const { win, api, store } = await H.loadedStore(H.repoData({ commits, status: bareStatus(), refs: state().refs }), { repo: BARE });
  const logged = [];
  win.Components.util.log = { ...win.Components.util.log, error: (...a) => logged.push(a) };
  assert.equal(store.hasWip(), false);
  assert.deepEqual(store.state.rows.map((r) => r.kind), ['commit', 'commit']);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: SHA('a') });
  assert.equal(store.state.repo.name, 'myproject/.bare');
  const wts = [{ path: '/w/myproject/main', head: SHA('a'), branch: 'main', bare: false, detached: false, locked: false, prunable: false }];
  api.take('worktrees').resolve(wts);
  await H.flush();
  assert.deepEqual(store.state.worktrees, wts);

  // a full refresh re-reads them; a failed read keeps the last list
  const p = store.actions.refresh();
  await H.flush(1);
  await H.answerRefresh(api, H.repoData({ commits, status: bareStatus(), refs: state().refs }));
  await p;
  api.take('worktrees').reject({ message: 'boom' });
  await H.flush();
  assert.deepEqual(store.state.worktrees, wts);
  assert.match(String(logged[0][0]), /could not read the worktrees/, 'logged');

  // a watcher 'refs' event (the bare watcher's kind for worktrees/<name> changes) is a full refresh: re-read
  const wts2 = [...wts, { path: '/w/myproject/new', head: SHA('a'), branch: 'new', bare: false, detached: false, locked: false, prunable: false }];
  store.actions.watchEvent({ repo: BARE.root, kinds: ['refs'] });
  await H.flush(1);
  await H.answerRefresh(api, H.repoData({ commits, status: bareStatus(), refs: state().refs }));
  api.take('worktrees').resolve(wts2);
  await H.flush();
  assert.deepEqual(store.state.worktrees, wts2, 'a refs event re-reads the worktrees');

  // a partial (watcher) refresh doesn't
  store.actions.watchEvent({ repo: BARE.root, kinds: ['status'] });
  await H.flush(1);
  api.take('status').resolve(bareStatus());
  api.take('undoState').resolve({ entries: [] });
  await H.flush();
  assert.equal(api.pending('worktrees').length, 0);

  // another repo: cleared, then read for the normal one too
  const q = store.actions.loadRepo({ root: '/r', name: 'r' });
  assert.equal(store.state.worktrees, null);
  await H.flush(1);
  await H.answerRefresh(api, H.repoData({ commits: H.chain([SHA('c')]) }));
  await q;
  const normal = [{ path: '/r', head: SHA('c'), branch: 'main', bare: false, detached: false, locked: false, prunable: false, main: true, current: true }];
  api.take('worktrees').resolve(normal);
  await H.flush();
  assert.deepEqual(store.state.worktrees, normal);
});
