'use strict';
// Milestone 5 sidebar / graph actions: the pure menu + double-click builders, and the mounted
// components (double-click, right-click, ContextMenu key / Shift+F10, de-dup) on a local fake DOM.
// Milestone 6: the keybindings of the mounted sidebar, graph and WIP panel (details + composer).
// The shared helpers (runFlow, toMenuItems, finishItems, bindContextMenu) are tested in actions.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const ACTIONS = require.resolve('../renderer/actions.js');

/** Load actions.js + a component script into `win` (index.html order) and return the component's exports. */
function loadInto(win, file) {
  delete require.cache[ACTIONS];
  const A = require(ACTIONS);
  const p = require.resolve(`../renderer/components/${file}`);
  delete require.cache[p];
  return { A, mod: require(p) };
}

/** Load a component script into a fresh renderer and return its node exports. */
function loadComponent(file) {
  const win = H.loadRenderer();
  return { win, ...loadInto(win, file) };
}

const SHA = (c) => c.repeat(40);

/** Fake PLFlows: records every call as [name, ...args] and resolves true. */
function fakeFlows({ withUpstream = true } = {}) {
  const calls = [];
  const names = ['checkout', 'createBranch', 'deleteBranch', 'deleteBranches', 'push', 'pull', 'fetch', 'stashPop', 'stashApply', 'stashDrop'];
  if (withUpstream) names.push('setUpstream');
  const flows = { calls };
  for (const n of names) flows[n] = async (store, ...args) => { calls.push([n, store, ...args]); return true; };
  return flows;
}

const fakeStore = (state = {}) => ({ state: { busy: false, ...state } });
const labels = (items) => items.map((d) => (d.separator ? '---' : d.label));
const byLabel = (items, label) => items.find((d) => d.label === label);

function sampleState(extra = {}) {
  return {
    busy: false,
    refs: H.refs({
      head: { branch: 'main', oid: SHA('a'), detached: false },
      local: [
        { name: 'main', oid: SHA('a'), upstream: 'origin/main', ahead: 0, behind: 0, gone: false, current: true },
        { name: 'feat/x', oid: SHA('b'), upstream: null, ahead: 0, behind: 0, gone: false, current: false },
      ],
      remote: [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: SHA('a') }],
      tags: [{ name: 'v1', oid: SHA('c') }],
    }),
    stashes: [{ index: 0, ref: 'stash@{0}', hash: SHA('d'), parents: [SHA('a')], date: 1700000000, message: 'WIP on main' }],
    ...extra,
  };
}

// ------------------------------------------------------------------ sidebar

test('rowTarget: resolves sidebar row keys to refs / stash entries', () => {
  const { mod: { rowTarget } } = loadComponent('sidebar.js');
  const s = sampleState();
  assert.deepEqual(rowTarget('local:main', s), { kind: 'local', name: 'main', oid: SHA('a'), current: true });
  assert.deepEqual(rowTarget('local:feat/x', s), { kind: 'local', name: 'feat/x', oid: SHA('b'), current: false });
  assert.deepEqual(rowTarget('remote:origin/main', s), { kind: 'remote', name: 'origin/main', oid: SHA('a'), current: false, remote: 'origin' });
  assert.deepEqual(rowTarget('tag:v1', s), { kind: 'tag', name: 'v1', oid: SHA('c'), current: false });
  assert.equal(rowTarget(`stash:${SHA('d')}`, s).entry, s.stashes[0]);
  for (const k of ['head:detached', 'unborn:main', 'dir:local:/feat', 'section:local', 'local:gone', '', null]) {
    assert.equal(rowTarget(k, s), null, String(k));
  }
  assert.equal(rowTarget('local:main', { refs: null, stashes: [] }), null);
});

test('branchMenuItems: local branch items; current branch cannot be checked out or deleted', () => {
  const { mod: { branchMenuItems, rowTarget } } = loadComponent('sidebar.js');
  const s = sampleState();
  const flows = fakeFlows();
  const cur = branchMenuItems(rowTarget('local:main', s), s, flows);
  assert.deepEqual(labels(cur), ['Checkout', 'Push', 'Create branch here…', 'Set upstream…', '---', 'Rebase main onto origin/main', 'Interactive Rebase main onto origin/main', '---', 'Delete']);
  const del = byLabel(cur, 'Delete');
  assert.equal(del.danger, true);
  assert.equal(del.disabled, true);
  assert.match(del.title, /checked-out branch/);
  assert.equal(byLabel(cur, 'Checkout').disabled, true);
  assert.deepEqual(byLabel(cur, 'Push').args, [{}], 'current branch: plain push');
  assert.deepEqual(byLabel(cur, 'Create branch here…').args, [{ start: SHA('a') }]);

  const other = branchMenuItems(rowTarget('local:feat/x', s), s, flows);
  assert.ok(other.every((d) => d.separator || !d.disabled || d.flow === 'merge' || d.flow === 'rebase' || d.flow === 'interactiveRebase'), 'nothing disabled on another branch (fakeFlows has no merge / rebase)');
  assert.deepEqual(byLabel(other, 'Checkout').args, [{ target: 'feat/x', kind: 'local' }]);
  assert.deepEqual(byLabel(other, 'Push').args, [{ branch: 'feat/x' }]);
  assert.deepEqual(byLabel(other, 'Set upstream…').args, ['feat/x']);
  assert.deepEqual(byLabel(other, 'Delete').args, ['feat/x']);

  // setUpstream absent: its item is hidden
  const noUp = branchMenuItems(rowTarget('local:feat/x', s), s, fakeFlows({ withUpstream: false }));
  assert.deepEqual(labels(noUp), ['Checkout', 'Push', 'Create branch here…', '---', 'Merge feat/x into main', 'Rebase main onto feat/x', 'Interactive Rebase main onto feat/x', '---', 'Delete']);
});

test('branchMenuItems: remote and tag items', () => {
  const { mod: { branchMenuItems, rowTarget } } = loadComponent('sidebar.js');
  const s = sampleState();
  const flows = fakeFlows();
  const remote = branchMenuItems(rowTarget('remote:origin/main', s), s, flows);
  assert.deepEqual(labels(remote), ['Checkout', 'Create branch here…', 'Fetch origin', '---', 'Merge origin/main into main', 'Rebase main onto origin/main', 'Interactive Rebase main onto origin/main']);
  assert.deepEqual(byLabel(remote, 'Checkout').args, [{ target: 'origin/main', kind: 'remote' }]);
  assert.deepEqual(byLabel(remote, 'Fetch origin').args, [{ remote: 'origin' }], 'fetches only that remote');
  const odd = { ...s, refs: { ...s.refs, remote: [{ name: 'u\u202ep/x', remote: 'u\u202ep', branch: 'x', oid: SHA('a') }] } };
  const oddItems = branchMenuItems(rowTarget('remote:u\u202ep/x', odd), odd, flows);
  assert.equal(oddItems[2].label, 'Fetch u\\u{202E}p', 'display-safe label');
  assert.deepEqual(oddItems[2].args, [{ remote: 'u\u202ep' }], 'raw remote name to the flow');
  const tag = branchMenuItems(rowTarget('tag:v1', s), s, flows);
  assert.deepEqual(labels(tag), ['Checkout', 'Create branch here…', '---', 'Rebase main onto v1', 'Interactive Rebase main onto v1', 'Merge v1 into main']);
  assert.deepEqual(byLabel(tag, 'Checkout').args, [{ target: SHA('c'), kind: 'commit' }], 'detached at the tagged commit');
  assert.deepEqual(byLabel(tag, 'Create branch here…').args, [{ start: SHA('c') }]);
  assert.deepEqual(branchMenuItems(null, s, flows), []);
});

test('menus: busy disables every item with a "Working…" title; missing PLFlows disables too', () => {
  const { A: { BUSY_TITLE }, mod: { branchMenuItems, stashMenuItems, rowTarget } } = loadComponent('sidebar.js');
  const s = sampleState({ busy: true });
  const flows = fakeFlows();
  for (const key of ['local:main', 'local:feat/x', 'remote:origin/main', 'tag:v1']) {
    for (const d of branchMenuItems(rowTarget(key, s), s, flows)) {
      if (d.separator) continue;
      assert.equal(d.disabled, true, `${key} ${d.label}`);
      assert.equal(d.title, BUSY_TITLE);
    }
  }
  for (const d of stashMenuItems(s.stashes[0], s, flows)) if (!d.separator) assert.deepEqual([d.disabled, d.title], [true, BUSY_TITLE]);
  const none = branchMenuItems(rowTarget('local:feat/x', sampleState()), sampleState(), undefined);
  assert.ok(none.filter((d) => !d.separator).every((d) => d.disabled), 'no PLFlows: nothing runnable');
});

test('stashMenuItems: Apply / Pop / Drop by stash commit hash', () => {
  const { mod: { stashMenuItems } } = loadComponent('sidebar.js');
  const s = sampleState();
  const items = stashMenuItems(s.stashes[0], s, fakeFlows());
  assert.deepEqual(labels(items), ['Apply', 'Pop', '---', 'Drop']);
  assert.deepEqual(items.filter((d) => !d.separator).map((d) => [d.flow, d.args]), [
    ['stashApply', [SHA('d')]], ['stashPop', [SHA('d')]], ['stashDrop', [SHA('d')]],
  ]);
  assert.equal(byLabel(items, 'Drop').danger, true);
  assert.deepEqual(stashMenuItems(null, s), []);
});

test('doubleClickAction: checkout for other branches / remotes, apply for stashes, nothing else', () => {
  const { mod: { doubleClickAction, rowTarget } } = loadComponent('sidebar.js');
  const s = sampleState();
  assert.equal(doubleClickAction(rowTarget('local:main', s), s), null, 'current branch');
  assert.deepEqual(doubleClickAction(rowTarget('local:feat/x', s), s), { flow: 'checkout', args: [{ target: 'feat/x', kind: 'local' }] });
  assert.deepEqual(doubleClickAction(rowTarget('remote:origin/main', s), s), { flow: 'checkout', args: [{ target: 'origin/main', kind: 'remote' }] });
  assert.deepEqual(doubleClickAction(rowTarget(`stash:${SHA('d')}`, s), s), { flow: 'stashApply', args: [SHA('d')] });
  assert.equal(doubleClickAction(rowTarget('tag:v1', s), s), null);
  assert.equal(doubleClickAction(null, s), null);
  const busy = sampleState({ busy: true });
  assert.equal(doubleClickAction(rowTarget('local:feat/x', busy), busy), null);
});

test('sidebar menu descriptors run the right PLFlows calls through actions.toMenuItems / runFlow', async () => {
  const { A: { runFlow, toMenuItems }, mod: { branchMenuItems, stashMenuItems, rowTarget } } = loadComponent('sidebar.js');
  const s = sampleState();
  const store = fakeStore(s);
  const flows = fakeFlows();
  const menu = toMenuItems(branchMenuItems(rowTarget('local:feat/x', s), s, flows), store, flows);
  assert.equal(menu[4].separator, true);
  for (const m of menu) if (!m.separator) m.action();
  await H.flush();
  assert.deepEqual(flows.calls.map(([n, st, ...a]) => [n, st === store, ...a]), [
    ['checkout', true, { target: 'feat/x', kind: 'local' }],
    ['push', true, { branch: 'feat/x' }],
    ['createBranch', true, { start: SHA('b') }],
    ['setUpstream', true, 'feat/x'],
    ['deleteBranch', true, 'feat/x'],
  ]);

  flows.calls.length = 0;
  for (const m of toMenuItems(stashMenuItems(s.stashes[0], s, flows), store, flows)) if (!m.separator) m.action();
  await H.flush();
  assert.deepEqual(flows.calls.map(([n, , ...a]) => [n, ...a]), [['stashApply', SHA('d')], ['stashPop', SHA('d')], ['stashDrop', SHA('d')]]);

  flows.calls.length = 0;
  const del = byLabel(branchMenuItems(rowTarget('local:main', s), s, flows), 'Delete');
  assert.equal(await runFlow(del, store, flows), false, 'disabled descriptor never runs');
  const fetch = byLabel(branchMenuItems(rowTarget('remote:origin/main', s), s, flows), 'Fetch origin');
  assert.equal(await runFlow(fetch, store, flows), true);
  assert.deepEqual(flows.calls.map(([n, , ...a]) => [n, ...a]), [['fetch', { remote: 'origin' }]]);
});

test('sidebar menus use the toolbar availability rules for push / fetch / create branch', () => {
  const { A: { availability }, mod: { branchMenuItems, rowTarget } } = loadComponent('sidebar.js');
  const flows = fakeFlows();
  const withRepo = (extra = {}) => sampleState({ repo: { root: '/r', name: 'r' }, status: H.status({ oid: SHA('a') }), ...extra });
  const item = (s, key, label) => byLabel(branchMenuItems(rowTarget(key, s), s, flows), label);

  const ok = withRepo({ remotes: ['origin'] });
  assert.equal(item(ok, 'local:main', 'Push').disabled, undefined);
  assert.equal(item(ok, 'local:feat/x', 'Push').disabled, undefined);

  const none = withRepo({ remotes: [] });
  for (const key of ['local:main', 'local:feat/x']) {
    const push = item(none, key, 'Push');
    assert.deepEqual([push.disabled, push.title], [true, availability(none).push.title], key);
    assert.equal(push.title, 'Push — no remotes configured');
  }
  const fetch = item(none, 'remote:origin/main', 'Fetch origin');
  assert.deepEqual([fetch.disabled, fetch.title], [true, 'Fetch — no remotes configured']);

  // detached HEAD: the (non-current) branches can still be pushed by name
  const det = withRepo({ remotes: ['origin'], status: { ...H.status({ oid: SHA('e') }), branch: null } });
  det.refs = { ...det.refs, head: { branch: null, oid: SHA('e'), detached: true }, local: det.refs.local.map((b) => ({ ...b, current: false })) };
  assert.equal(item(det, 'local:main', 'Push').disabled, undefined);
  assert.equal(item(det, 'local:main', 'Create branch here…').disabled, undefined);
});

// ------------------------------------------------------------------ graph view

function graphState(extra = {}) {
  const s = sampleState(extra);
  s.refsBySha = new Map([
    [SHA('a'), [{ type: 'local', name: 'main', current: true, upstream: 'origin/main' }, { type: 'remote', name: 'origin/main' }]],
    [SHA('b'), [{ type: 'local', name: 'feat/x', current: false }, { type: 'local', name: 'y\u202ez', current: false }, { type: 'tag', name: 't' }]],
  ]);
  return s;
}
const crow = (hash) => ({ kind: 'commit', commit: { hash, parents: [], subject: 's', author: 'A', date: 1 } });

test('commitMenuItems: detached checkout, create branch, and one checkout per local branch', () => {
  const { A: { BUSY_TITLE }, mod: { commitMenuItems } } = loadComponent('graph-view.js');
  const s = graphState();
  const flows = fakeFlows();
  assert.deepEqual(commitMenuItems({ kind: 'wip' }, s, flows), []);
  assert.deepEqual(commitMenuItems(null, s, flows), []);

  // (HEAD is at a; commits outside its history get Rebase / Merge, see the R2 tests below)
  const plain = commitMenuItems(crow(SHA('e')), s, flows);
  assert.deepEqual(labels(plain), ['Checkout this commit', 'Create branch here…', '---', 'Rebase main onto this commit', 'Interactive Rebase main onto this commit', 'Merge this commit into main']);
  assert.deepEqual(plain.filter((d) => !d.separator).map((d) => [d.flow, d.args]), [
    ['checkout', [{ target: SHA('e'), kind: 'commit' }]], ['createBranch', [{ start: SHA('e') }]],
    ['rebase', [{ onto: SHA('e'), expectHead: SHA('a') }]], ['interactiveRebase', [{ upstream: SHA('e'), expectHead: SHA('a') }]],
    ['merge', [{ target: SHA('e'), expectHead: SHA('a') }]],
  ]);

  const b = commitMenuItems(crow(SHA('b')), s, flows);
  assert.deepEqual(labels(b).slice(6), ['---', 'Checkout feat/x', 'Checkout y\\u{202E}z']);
  assert.deepEqual(b[7].args, [{ target: 'feat/x', kind: 'local' }]);
  assert.deepEqual(b[8].args, [{ target: 'y\u202ez', kind: 'local' }], 'raw name goes to the flow, display-safe name to the label');

  const a = commitMenuItems(crow(SHA('a')), s, flows);
  assert.deepEqual(labels(a), ['Checkout this commit', 'Create branch here…', '---', 'Checkout main'], 'HEAD itself: no merge / rebase');
  assert.equal(a[3].disabled, true, 'current branch');

  const detached = graphState();
  detached.refs.head = { branch: null, oid: SHA('e'), detached: true };
  assert.equal(commitMenuItems(crow(SHA('e')), detached, flows)[0].disabled, true, 'already detached here');

  const busy = graphState({ busy: true });
  for (const d of commitMenuItems(crow(SHA('b')), busy, flows)) if (!d.separator) assert.deepEqual([d.disabled, d.title], [true, BUSY_TITLE]);

  // unborn repo rules (same as the toolbar's Branch button)
  const unborn = { repo: { root: '/r', name: 'r' }, status: H.status(), refs: H.refs({ head: { branch: 'main', oid: null } }), refsBySha: new Map(), busy: false };
  const create = commitMenuItems(crow(SHA('e')), unborn, flows)[1];
  assert.deepEqual([create.disabled, create.title], [true, 'Branch — the repository has no commits yet']);
});

test('commit menu descriptors run the right PLFlows calls', async () => {
  const { A: { runFlow }, mod: { commitMenuItems } } = loadComponent('graph-view.js');
  const s = graphState();
  const store = fakeStore(s);
  const flows = fakeFlows();
  for (const d of commitMenuItems(crow(SHA('b')), s, flows)) if (!d.separator) await runFlow(d, store, flows);
  assert.deepEqual(flows.calls.map(([n, st, ...a]) => [n, st === store, ...a]), [
    ['checkout', true, { target: SHA('b'), kind: 'commit' }],
    ['createBranch', true, { start: SHA('b') }],
    ['checkout', true, { target: 'feat/x', kind: 'local' }],
    ['checkout', true, { target: 'y\u202ez', kind: 'local' }],
  ]);
  assert.equal(await runFlow({ flow: 'checkout', args: [] }, fakeStore({ busy: true }), flows), false);
});

test('pillAction: double-click checks out a non-current local pill only', () => {
  const { mod: { refPills, pillAction } } = loadComponent('graph-view.js');
  const pills = refPills([
    { type: 'local', name: 'main', current: true },
    { type: 'local', name: 'x\u202ey', current: false },
    { type: 'remote', name: 'origin/q' },
    { type: 'tag', name: 't' },
  ], new Map());
  const [cur, other, remote, tag] = pills;
  assert.equal(other.ref, 'x\u202ey', 'pills keep the raw branch name');
  assert.equal(pillAction(cur, {}), null);
  assert.deepEqual(pillAction(other, {}), { flow: 'checkout', args: [{ target: 'x\u202ey', kind: 'local' }] });
  assert.equal(pillAction(other, { busy: true }), null);
  assert.equal(pillAction(remote, {}), null);
  assert.equal(pillAction(tag, {}), null);
  assert.equal(pillAction(null, {}), null);
});

test('graph: a branch checked out in another worktree: no double-click on its pill, its Checkout items disabled (pill and commit menus)', () => {
  const { mod: { refPills, pillAction, pillMenuItems, commitMenuItems } } = loadComponent('graph-view.js');
  const wt = (o) => ({ head: SHA('b'), bare: false, detached: false, locked: false, prunable: false, main: false, current: false, ...o });
  const worktrees = [wt({ path: '/r', branch: 'main', main: true, current: true }), wt({ path: '/w/feat', branch: 'feat/x' })];
  const [cur, feat] = refPills([{ type: 'local', name: 'main', current: true }, { type: 'local', name: 'feat/x', current: false }], new Map());
  const s = { repo: { root: '/r', name: 'r' }, worktrees };
  assert.equal(pillAction(feat, s), null);
  assert.equal(pillAction(cur, s), null, 'current: as before');
  assert.deepEqual(pillAction(feat, { ...s, worktrees: [worktrees[0]] }).flow, 'checkout');
  const flows = { checkout() {}, createBranch() {}, push() {}, deleteBranch() {}, merge() {}, rebase() {}, interactiveRebase() {} };
  const state = {
    ...s, busy: false,
    refs: H.refs({ head: { branch: 'main', oid: SHA('a'), detached: false }, local: [{ name: 'main', oid: SHA('a'), current: true }, { name: 'feat/x', oid: SHA('b') }] }),
    refsBySha: new Map([[SHA('b'), [{ type: 'local', name: 'feat/x', current: false }]]]),
    commits: [{ hash: SHA('a'), parents: [SHA('b')] }, { hash: SHA('b'), parents: [] }],
  };
  const row = { kind: 'commit', commit: { hash: SHA('b') } };
  const fromPill = pillMenuItems(feat, row, state, flows).find((d) => d.flow === 'checkout');
  assert.deepEqual([fromPill.disabled, fromPill.title], [true, 'Checked out in worktree /w/feat']);
  const fromRow = commitMenuItems(row, state, flows).find((d) => d.label === 'Checkout feat/x');
  assert.deepEqual([fromRow.disabled, fromRow.title], [true, 'Checked out in worktree /w/feat']);
});

// ------------------------------------------------------------------ mounted (local fake DOM)
//
// The fake DOM is H.componentDom (test/renderer-harness.js).
const makeDom = H.componentDom;

function recordingMenu() {
  const opened = [];
  return { opened, api: { open: (anchor, items) => opened.push({ anchor, items }), close() {}, isOpen: () => false } };
}

/** Run fn with Date.now pinned to `t`. */
function at(t, fn) {
  const orig = Date.now;
  Date.now = () => t;
  try { return fn(); } finally { Date.now = orig; }
}

/** A loaded store + the component `file` (or [deps..., file]) mounted on the fake DOM, with fake PLFlows and menu. */
async function mountComponent(tc, file, name, data) {
  const { win, api, store } = await H.loadedStore(data);
  const dom = makeDom();
  Object.defineProperty(globalThis, 'document', { value: dom.doc, configurable: true, writable: true });
  H.setLocalStorage(H.memoryStorage());
  win.addEventListener = dom.win.addEventListener;
  win.removeEventListener = dom.win.removeEventListener;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  dom.doc.body.dataset.view = 'repo';
  for (const f of [].concat(file)) loadInto(win, f); // several: dependencies first (index.html order)
  const flows = fakeFlows();
  for (const n of ['stashSave', 'openTerminal', 'setPullMode']) flows[n] = async () => true;
  win.PLFlows = flows;
  const menu = recordingMenu();
  win.Components.menu = menu.api;
  const root = dom.doc.createElement('div');
  root.dataset.component = name;
  dom.doc.body.append(root);
  const unmount = win.Components.mountAll({ querySelectorAll: () => [root], contains: (n) => n === root }, store);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; unmount(); } };
  tc.after(dispose); // also when an assertion fails (the graph keeps a clock interval)
  return { win, api, store, dom, flows, menu, root, dispose };
}

const calls = (flows) => flows.calls.map(([n, , ...a]) => [n, ...a]);

function sidebarData() {
  const s = sampleState();
  return H.repoData({
    commits: H.chain([SHA('a'), SHA('b')]),
    status: { ...H.status({ oid: SHA('a') }), upstream: 'origin/main' },
    refs: s.refs,
    stashes: s.stashes,
  });
}

test('mounted sidebar: double-click checks out other branches / remotes and applies stashes', async (tc) => {
  const t = await mountComponent(tc, 'sidebar.js', 'sidebar', sidebarData());
  const row = (key) => t.root.querySelectorAll('.sb-row').find((r) => r.dataset.key === key);
  assert.ok(row('local:feat/x'), 'rows rendered');
  const name = (key) => row(key).querySelector('.sb-name');
  t.dom.dispatch(name('local:main'), 'dblclick'); // current branch: nothing
  t.dom.dispatch(name('local:feat/x'), 'dblclick');
  t.dom.dispatch(name('remote:origin/main'), 'dblclick');
  t.dom.dispatch(name(`stash:${SHA('d')}`), 'dblclick');
  t.dom.dispatch(name('tag:v1'), 'dblclick'); // tags: nothing
  t.dom.dispatch(t.root.querySelector('.sb-section-header'), 'dblclick'); // not a row
  await H.flush();
  assert.deepEqual(calls(t.flows), [
    ['checkout', { target: 'feat/x', kind: 'local' }],
    ['checkout', { target: 'origin/main', kind: 'remote' }],
    ['stashApply', SHA('d')],
  ]);
  t.store.set({ busy: true });
  t.dom.dispatch(name('local:feat/x'), 'dblclick');
  await H.flush();
  assert.equal(t.flows.calls.length, 3, 'nothing while busy');
  t.dispose();
});

test('mounted sidebar: right-click opens the row menu at the pointer and its items run the flows', async (tc) => {
  const t = await mountComponent(tc, 'sidebar.js', 'sidebar', sidebarData());
  const row = (key) => t.root.querySelectorAll('.sb-row').find((r) => r.dataset.key === key);
  const e = t.dom.dispatch(row('remote:origin/main').querySelector('.sb-name'), 'contextmenu', { clientX: 12, clientY: 34 });
  assert.equal(e.defaultPrevented, true);
  assert.equal(t.menu.opened.length, 1);
  const { anchor, items } = t.menu.opened[0];
  assert.deepEqual(anchor, { x: 12, y: 34 });
  assert.deepEqual(labels(items), ['Checkout', 'Create branch here…', 'Fetch origin', '---', 'Merge origin/main into main', 'Rebase main onto origin/main', 'Interactive Rebase main onto origin/main']);
  assert.equal(t.dom.doc.activeElement, row('remote:origin/main'), 'the row gets focus');
  byLabel(items, 'Fetch origin').action();
  await H.flush();
  assert.deepEqual(calls(t.flows), [['fetch', { remote: 'origin' }]]);

  // remote folders and section headers have no menu (the native one is still suppressed)
  const folder = t.root.querySelectorAll('.sb-folder').find((r) => r.dataset.key === 'dir:remote:origin');
  assert.equal(t.dom.dispatch(folder, 'contextmenu', { clientX: 1, clientY: 1 }).defaultPrevented, true);
  t.dom.dispatch(t.root.querySelector('.sb-section-header'), 'contextmenu', { clientX: 1, clientY: 1 });
  assert.equal(t.menu.opened.length, 1);

  // a pointerless contextmenu anchors on the row
  t.dom.dispatch(row('local:feat/x'), 'contextmenu');
  assert.equal(t.menu.opened[1].anchor, row('local:feat/x'));
  t.dispose();
});

test('mounted sidebar: ContextMenu key / Shift+F10 open the focused row menu; the echoed contextmenu is ignored', async (tc) => {
  const t = await mountComponent(tc, 'sidebar.js', 'sidebar', sidebarData());
  const row = (key) => t.root.querySelectorAll('.sb-row').find((r) => r.dataset.key === key);
  const r = row('local:feat/x');
  r.focus();
  const t0 = 5_000_000;
  const e = at(t0, () => t.dom.key('ContextMenu'));
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.stopped, true);
  assert.equal(t.menu.opened.length, 1);
  assert.equal(t.menu.opened[0].anchor, r, 'anchored on the row');
  assert.deepEqual(labels(t.menu.opened[0].items), ['Checkout', 'Push', 'Create branch here…', 'Set upstream…', '---', 'Merge feat/x into main', 'Rebase main onto feat/x', 'Interactive Rebase main onto feat/x', '---', 'Delete']);

  at(t0 + 50, () => t.dom.dispatch(r, 'contextmenu'));
  assert.equal(t.menu.opened.length, 1, 'keyMenuAt de-dup');

  const stash = row(`stash:${SHA('d')}`);
  stash.focus();
  at(t0 + 1000, () => t.dom.key('F10', { shiftKey: true }));
  assert.equal(t.menu.opened.length, 2);
  assert.equal(t.menu.opened[1].anchor, stash);
  assert.deepEqual(labels(t.menu.opened[1].items), ['Apply', 'Pop', '---', 'Drop']);
  at(t0 + 1700, () => t.dom.dispatch(stash, 'contextmenu', { clientX: 3, clientY: 4 }));
  assert.equal(t.menu.opened.length, 3, 'a right-click later than the de-dup window opens');

  // the list's own keys still work (ArrowDown moves the focus)
  t.dom.doc.activeElement = r;
  const down = t.dom.key('ArrowDown');
  assert.equal(down.defaultPrevented, true);
  assert.notEqual(t.dom.doc.activeElement, r);

  t.dispose();
  assert.equal(t.root.children.length, 0, 'unmounted');
  at(t0 + 9000, () => t.dom.key('ContextMenu', {}, r));
  assert.equal(t.menu.opened.length, 3, 'unbound on dispose');
});

function graphData() {
  const refs = H.refs({
    head: { branch: 'main', oid: SHA('a'), detached: false },
    local: [
      { name: 'main', oid: SHA('a'), upstream: null, ahead: 0, behind: 0, gone: false, current: true },
      { name: 'feat/x', oid: SHA('b'), upstream: null, ahead: 0, behind: 0, gone: false, current: false },
    ],
  });
  return H.repoData({ commits: H.chain([SHA('a'), SHA('b'), SHA('c')]), status: H.status({ oid: SHA('a') }), refs });
}

test('mounted graph: double-click on a local branch pill checks it out; not on the current one or outside pills', async (tc) => {
  const t = await mountComponent(tc, 'graph-view.js', 'graph-view', graphData());
  const rowEl = (i) => t.root.querySelectorAll('.gv-row').find((r) => String(r.dataset.index) === String(i));
  assert.ok(rowEl(1), 'rows rendered');
  t.dom.dispatch(rowEl(0).querySelector('.gv-pill-name'), 'dblclick'); // main: current
  t.dom.dispatch(rowEl(1).querySelector('.gv-pill-name'), 'dblclick');
  t.dom.dispatch(rowEl(1).querySelector('.gv-subject'), 'dblclick'); // not on the pill
  await H.flush();
  assert.deepEqual(calls(t.flows), [['checkout', { target: 'feat/x', kind: 'local' }]]);
  t.dispose();
});

test('mounted graph: right-click selects the row and opens its menu; the items run the flows', async (tc) => {
  const t = await mountComponent(tc, 'graph-view.js', 'graph-view', graphData());
  const rowEl = (i) => t.root.querySelectorAll('.gv-row').find((r) => String(r.dataset.index) === String(i));
  const e = t.dom.dispatch(rowEl(1).querySelector('.gv-subject'), 'contextmenu', { clientX: 50, clientY: 60 });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(t.store.state.selection, { kind: 'commit', sha: SHA('b') });
  assert.equal(t.menu.opened.length, 1);
  assert.deepEqual(t.menu.opened[0].anchor, { x: 50, y: 60 });
  const items = t.menu.opened[0].items;
  assert.deepEqual(labels(items), ['Checkout this commit', 'Create branch here…', '---', 'Interactive Rebase 1 child of bbbbbbb', '---', 'Checkout feat/x']);
  byLabel(items, 'Checkout feat/x').action();
  byLabel(items, 'Create branch here…').action();
  await H.flush();
  assert.deepEqual(calls(t.flows), [['checkout', { target: 'feat/x', kind: 'local' }], ['createBranch', { start: SHA('b') }]]);

  // the column header has its own menu (test/graph-columns.test.js), never a row's
  t.dom.dispatch(t.root.querySelector('.gv-header'), 'contextmenu', { clientX: 1, clientY: 1 });
  assert.equal(t.menu.opened.length, 2);
  assert.deepEqual(labels(t.menu.opened[1].items), ['Reset column widths']);
  assert.deepEqual(t.store.state.selection, { kind: 'commit', sha: SHA('b') }, 'the selection stays');
  t.dispose();
});

test('mounted graph: shown only while state.centre is the graph; back from a diff or the rebase editor it takes the focus unless something has it', async (tc) => {
  const t = await mountComponent(tc, 'graph-view.js', 'graph-view', graphData());
  const scroller = t.root.querySelector('.gv-scroll');
  assert.equal(t.store.state.centre, 'graph');
  assert.equal(t.root.hidden, false);
  t.store.set({ diff: { spec: { kind: 'commit', sha: SHA('a'), file: 'a.txt' }, loading: true, data: null, error: null } });
  assert.equal(t.store.state.centre, 'diff');
  assert.equal(t.root.hidden, true, 'the diff replaces the graph');
  t.dom.doc.activeElement = t.dom.doc.body;
  t.store.actions.closeDiff();
  assert.equal(t.root.hidden, false);
  await Promise.resolve();
  assert.equal(t.dom.doc.activeElement, scroller, 'nothing focused: the graph takes it');

  t.store.set({ rebaseEditor: { plan: {}, model: { rows: [] }, running: false } });
  assert.deepEqual([t.store.state.centre, t.root.hidden], ['rebaseEditor', true]);
  const other = t.dom.doc.createElement('button');
  t.dom.doc.body.append(other);
  other.focus();
  t.store.set({ rebaseEditor: null });
  await Promise.resolve();
  assert.equal(t.root.hidden, false);
  assert.equal(t.dom.doc.activeElement, other, 'something else has the focus: it keeps it');
  t.dispose();
});

test('mounted graph: ContextMenu key / Shift+F10 open the selected row menu; the echoed contextmenu is ignored', async (tc) => {
  const t = await mountComponent(tc, 'graph-view.js', 'graph-view', graphData());
  const rowEl = (i) => t.root.querySelectorAll('.gv-row').find((r) => String(r.dataset.index) === String(i));
  const scroller = t.root.querySelector('.gv-scroll');
  scroller.focus();
  t.store.set({ selection: null });
  t.dom.key('ContextMenu');
  assert.equal(t.menu.opened.length, 0, 'nothing selected: no menu');

  t.store.actions.select({ kind: 'commit', sha: SHA('c') });
  const t0 = 9_000_000;
  const e = at(t0, () => t.dom.key('ContextMenu'));
  assert.equal(e.defaultPrevented, true);
  assert.equal(t.menu.opened.length, 1);
  assert.equal(t.menu.opened[0].anchor, rowEl(2), 'anchored on the selected row');
  assert.deepEqual(labels(t.menu.opened[0].items), ['Checkout this commit', 'Create branch here…', '---', 'Interactive Rebase 2 children of ccccccc']);

  at(t0 + 100, () => t.dom.dispatch(scroller, 'contextmenu'));
  assert.equal(t.menu.opened.length, 1, 'keyMenuAt de-dup');

  at(t0 + 2000, () => t.dom.key('F10', { shiftKey: true }));
  assert.equal(t.menu.opened.length, 2);
  t.menu.opened[1].items[0].action();
  await H.flush();
  assert.deepEqual(calls(t.flows), [['checkout', { target: SHA('c'), kind: 'commit' }]]);

  t.dispose();
  at(t0 + 5000, () => t.dom.key('ContextMenu', {}, scroller));
  assert.equal(t.menu.opened.length, 2, 'unbound on dispose');
});

// ------------------------------------------------------------------ M6 keybindings (mounted)

test('mounted sidebar: ⌘/Ctrl/Alt keys on a row are left to the app shortcuts (⌘↵, ⌘↓ …); plain keys still navigate', async (tc) => {
  const t = await mountComponent(tc, 'sidebar.js', 'sidebar', sidebarData());
  const row = (key) => t.root.querySelectorAll('.sb-row').find((r) => r.dataset.key === key);
  const r = row('local:feat/x');
  r.focus();
  for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true, shiftKey: true }]) {
    for (const k of ['Enter', 'ArrowDown', 'ArrowUp', ' ']) {
      // ⌘/Ctrl+Space toggles the row in the multi-selection (its own test)
      if (k === ' ' && t.win.Components.util.modKey(mods) && !mods.shiftKey) continue;
      const e = t.dom.key(k, mods, r);
      assert.equal(e.defaultPrevented, false, `${k} ${JSON.stringify(mods)}`);
      assert.equal(e.stopped, false, `${k} ${JSON.stringify(mods)} reaches the window`);
      assert.equal(t.dom.doc.activeElement, r);
    }
  }
  await H.flush();
  assert.deepEqual(calls(t.flows), [], 'no checkout from ⌘↵');
  const down = t.dom.key('ArrowDown', {}, r);
  assert.equal(down.defaultPrevented, true);
  assert.notEqual(t.dom.doc.activeElement, r);
  t.dispose();
});

test('mounted graph: j/k move the selection from the graph, from body and from a toolbar button (just-clicked Undo); not from a list or tree', async (tc) => {
  const t = await mountComponent(tc, 'graph-view.js', 'graph-view', graphData());
  const sel = () => t.store.state.selection && t.store.state.selection.sha;
  const scroller = t.root.querySelector('.gv-scroll');
  t.store.actions.select({ kind: 'commit', sha: SHA('a') });
  scroller.focus();
  assert.equal(t.dom.key('j').defaultPrevented, true);
  assert.equal(sel(), SHA('b'));

  // a toolbar button: j moves and focus goes to the graph
  const bar = t.dom.doc.createElement('div');
  bar.setAttribute('role', 'toolbar');
  const group = t.dom.doc.createElement('div');
  const undo = t.dom.doc.createElement('button');
  group.append(undo);
  bar.append(group);
  t.dom.doc.body.append(bar);
  undo.focus();
  assert.equal(t.dom.key('j').defaultPrevented, true);
  assert.equal(sel(), SHA('c'));
  assert.equal(t.dom.doc.activeElement, scroller, 'focus moved to the graph');

  t.dom.doc.activeElement = t.dom.doc.body;
  t.dom.key('k');
  assert.equal(sel(), SHA('b'), 'nothing focused: the graph owns the keys');

  // a button outside the toolbar, a button inside a listbox (a file row's action) and a tree row keep their own keys
  const plain = t.dom.doc.createElement('button');
  const list = t.dom.doc.createElement('div');
  list.setAttribute('role', 'listbox');
  const rowBtn = t.dom.doc.createElement('button');
  list.append(rowBtn);
  const tree = t.dom.doc.createElement('div');
  tree.setAttribute('role', 'tree');
  const item = t.dom.doc.createElement('div');
  tree.append(item);
  t.dom.doc.body.append(plain, list, tree);
  for (const f of [plain, rowBtn, item]) {
    f.focus();
    assert.equal(t.dom.key('j').defaultPrevented, false);
    assert.equal(sel(), SHA('b'));
  }
  // modifiers belong to the app shortcuts
  scroller.focus();
  assert.equal(t.dom.key('ArrowDown', { metaKey: true }).defaultPrevented, false);
  assert.equal(sel(), SHA('b'));
  // a dialog or menu open: its keys (focus may still be on body, e.g. while it opens)
  t.dom.doc.activeElement = t.dom.doc.body;
  t.win.Components.menu.isOpen = () => true;
  assert.equal(t.dom.key('j').defaultPrevented, false, 'menu open');
  t.win.Components.menu.isOpen = () => false;
  t.win.Components.dialog = { isOpen: () => true };
  assert.equal(t.dom.key('j').defaultPrevented, false, 'dialog open');
  assert.equal(sel(), SHA('b'));
  t.dispose();
});

test('ownsNavKeys: graph, body and toolbar buttons only', () => {
  const { mod: { ownsNavKeys } } = loadComponent('graph-view.js');
  const dom = makeDom();
  Object.defineProperty(globalThis, 'document', { value: dom.doc, configurable: true, writable: true });
  const scroller = dom.doc.createElement('div');
  const inGraph = dom.doc.createElement('div');
  scroller.append(inGraph);
  assert.equal(ownsNavKeys(null, scroller), true);
  assert.equal(ownsNavKeys(dom.doc.body, scroller), true);
  assert.equal(ownsNavKeys(dom.doc.documentElement, scroller), true);
  assert.equal(ownsNavKeys(inGraph, scroller), true);
  const toolbar = dom.doc.createElement('div');
  toolbar.setAttribute('role', 'toolbar');
  const tbBtn = dom.doc.createElement('button');
  const tbGroup = dom.doc.createElement('div');
  const nested = dom.doc.createElement('button');
  tbGroup.append(nested);
  toolbar.append(tbBtn, tbGroup);
  assert.equal(ownsNavKeys(tbBtn, scroller), true, 'a toolbar button');
  assert.equal(ownsNavKeys(nested, scroller), true, 'a button in a toolbar group');
  const tbDiv = dom.doc.createElement('div');
  toolbar.append(tbDiv);
  assert.equal(ownsNavKeys(tbDiv, scroller), false, 'only buttons of the toolbar');
  assert.equal(ownsNavKeys(dom.doc.createElement('button'), scroller), false, 'a button outside the toolbar (e.g. the WIP panel)');
  assert.equal(ownsNavKeys(dom.doc.createElement('input'), scroller), false);
  assert.equal(ownsNavKeys(dom.doc.createElement('div'), scroller), false, 'a focusable div (a row) keeps its keys');
  for (const role of ['listbox', 'tree', 'grid', 'menu', 'dialog', 'alertdialog', 'group']) {
    const box = dom.doc.createElement('div');
    box.setAttribute('role', role);
    const b = dom.doc.createElement('button');
    box.append(b);
    assert.equal(ownsNavKeys(b, scroller), false, role);
  }
});

// The WIP panel: details.js with its parts, the global ⌘⇧S / ⌘⇧U / ⌘⇧M / ⌘↵ / ⌘⇧↵ (PLWip.shortcut).
const DETAILS = ['wip-model.js', 'file-list.js', 'composer.js', 'details.js'];

function wipData({ staged = [], unstaged = [{ path: 'a.txt', status: 'M' }] } = {}) {
  return H.repoData({ commits: H.chain([SHA('a')]), status: H.status({ oid: SHA('a'), staged, unstaged }) });
}

/** The real working-tree flows (flows-kit.js + flows-worktree.js) next to the fake PLFlows of `t`. */
function addWorktreeFlows(t) {
  const fake = t.win.PLFlows;
  for (const f of ['flows-kit.js', 'flows-worktree.js']) {
    const p = require.resolve(`../renderer/${f}`);
    delete require.cache[p];
    require(p);
  }
  for (const [n, fn] of Object.entries(t.win.PLFlows)) if (!Object.hasOwn(fake, n)) fake[n] = fn;
  t.win.PLFlows = fake;
}

async function mountDetails(tc, data) {
  const t = await mountComponent(tc, DETAILS, 'details', data);
  addWorktreeFlows(t);
  const notices = [];
  t.store.setToast((m) => notices.push(m));
  const dialog = { open: false };
  t.win.Components.dialog = { isOpen: () => dialog.open };
  let menuOpen = false;
  t.win.Components.menu.isOpen = () => menuOpen;
  t.store.actions.select({ kind: 'wip' });
  const mod = (k, extra = {}) => ({ [t.win.Components.util.IS_MAC ? 'metaKey' : 'ctrlKey']: true, ...extra });
  const summary = () => t.root.querySelector('input.dt-summary');
  const WRITES = ['stage', 'unstage', 'stageAll', 'unstageAll', 'discard', 'commit', 'commitAll'];
  const writes = () => t.api.calls.filter((c) => WRITES.includes(c.op)).map((c) => c.op);
  return { ...t, notices, dialog, setMenu: (v) => { menuOpen = v; }, mod, summary, writes };
}

test('mounted WIP panel: ⌘⇧S / ⌘⇧U from anywhere (text fields too); nothing with a dialog or menu open; a repeat is swallowed', async (tc) => {
  const t = await mountDetails(tc, wipData({ staged: [{ path: 'b.txt', status: 'M' }] }));
  const e = t.dom.key('S', t.mod('s', { shiftKey: true }), t.dom.doc.body);
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(t.writes(), ['stageAll']);
  t.api.take('stageAll').resolve(true);
  await H.flush();

  t.summary().focus();
  t.dom.key('U', t.mod('u', { shiftKey: true }));
  assert.deepEqual(t.writes(), ['stageAll', 'unstageAll'], 'from the commit summary');
  t.api.take('unstageAll').resolve(true);
  await H.flush();

  t.dialog.open = true;
  assert.equal(t.dom.key('S', t.mod('s', { shiftKey: true }), t.dom.doc.body).defaultPrevented, false);
  t.dialog.open = false;
  t.setMenu(true);
  t.dom.key('S', t.mod('s', { shiftKey: true }), t.dom.doc.body);
  t.setMenu(false);
  assert.equal(t.dom.key('S', t.mod('s', { shiftKey: true, repeat: true }), t.dom.doc.body).defaultPrevented, true, 'repeat: swallowed');
  const other = t.win.Components.util.IS_MAC ? { ctrlKey: true } : { metaKey: true };
  t.dom.key('S', t.mod('s', { shiftKey: true, ...other }), t.dom.doc.body);
  t.dom.key('S', t.mod('s', { shiftKey: true, altKey: true }), t.dom.doc.body);
  assert.deepEqual(t.writes(), ['stageAll', 'unstageAll'], 'nothing else ran');
  t.dispose();
});

test('mounted WIP panel: ⌘⇧S / ⌘⇧U with nothing to do and ⌘⇧M on a clean tree explain themselves', async (tc) => {
  const t = await mountDetails(tc, wipData({ unstaged: [], staged: [] }));
  t.store.actions.select({ kind: 'commit', sha: SHA('a') }); // a clean tree has no WIP row
  t.dom.key('S', t.mod('s', { shiftKey: true }), t.dom.doc.body);
  t.dom.key('U', t.mod('u', { shiftKey: true }), t.dom.doc.body);
  t.dom.key('M', t.mod('m', { shiftKey: true }), t.dom.doc.body);
  assert.deepEqual(t.notices.map((n) => n.message), [
    'Stage all — no unstaged changes', 'Unstage all — no staged changes', 'Nothing to commit — the working tree is clean',
  ]);
  assert.ok(t.notices.every((n) => n.level === 'info'));
  assert.deepEqual(t.writes(), []);
  t.store.set({ busy: true });
  t.dom.key('S', t.mod('s', { shiftKey: true }), t.dom.doc.body);
  assert.equal(t.notices.length, 3, 'silent while busy');
  t.dispose();
});

test('mounted WIP panel: ⌘⇧M focuses the summary; ⌘↵ commits from outside the commit box, ⌘⇧↵ commits all; blocked commits say why', async (tc) => {
  const t = await mountDetails(tc, wipData({ staged: [{ path: 'b.txt', status: 'M' }] }));
  t.dom.key('M', t.mod('m', { shiftKey: true }), t.dom.doc.body);
  assert.equal(t.dom.doc.activeElement, t.summary(), '⌘⇧M');

  // no summary yet: the notice names the blocker, nothing is written
  t.dom.doc.activeElement = t.dom.doc.body;
  assert.equal(t.dom.key('Enter', t.mod('enter'), t.dom.doc.body).defaultPrevented, true);
  assert.deepEqual(t.notices.map((n) => n.message), ['Enter a commit summary']);

  t.summary().value = 'fix: thing';
  // from a file row / the graph (not a text field): commits
  const btn = t.root.querySelector('button.dt-stage-all');
  btn.focus();
  t.dom.key('Enter', t.mod('enter'), btn);
  assert.deepEqual(t.writes(), ['commit']);
  const c = t.api.take('commit');
  assert.equal(c.args[0], 'fix: thing');
  t.dom.key('Enter', t.mod('enter'), btn);
  assert.deepEqual(t.writes(), ['commit'], 'one commit at a time');
  assert.equal(t.notices.length, 1, 'silent while committing');
  c.resolve({ sha: SHA('e'), summary: 'fix: thing' });
  await H.flush();
  assert.equal(t.summary().value, '', 'cleared after the commit');

  // inside the summary: the composer's own handler runs it (and stops it there); ⌘⇧↵ = commit all
  t.summary().value = 'feat: all';
  t.summary().focus();
  const e = t.dom.key('Enter', t.mod('enter', { shiftKey: true }), t.summary());
  assert.equal(e.stopped, true);
  assert.deepEqual(t.writes(), ['commit', 'commitAll']);
  assert.equal(t.api.take('commitAll').args[0], 'feat: all');
  t.dispose();
});

test('mounted WIP panel: ⌘↵ is left alone in another text field, without the commit box, and while a menu is open', async (tc) => {
  const t = await mountDetails(tc, wipData({ staged: [{ path: 'b.txt', status: 'M' }] }));
  t.summary().value = 'msg';
  const field = t.dom.doc.createElement('input');
  field.type = 'text';
  t.dom.doc.body.append(field);
  field.focus();
  assert.equal(t.dom.key('Enter', t.mod('enter'), field).defaultPrevented, false, 'sidebar filter or similar');
  t.setMenu(true);
  assert.equal(t.dom.key('Enter', t.mod('enter'), t.dom.doc.body).defaultPrevented, false);
  t.setMenu(false);
  t.store.actions.select({ kind: 'commit', sha: SHA('a') });
  assert.equal(t.dom.key('Enter', t.mod('enter'), t.dom.doc.body).defaultPrevented, false, 'a commit is shown, not the commit box');
  assert.deepEqual(t.writes(), []);
  t.dispose();
});

test('mounted diff view: Esc closes the diff; not in a text field, with a menu or dialog open, or once handled', async (tc) => {
  const t = await mountComponent(tc, ['diff-model.js', 'diff-staging.js', 'image-preview.js', 'diff-view.js'], 'diff-view', graphData());
  let menuOpen = false;
  let dialogOpen = false;
  t.win.Components.menu.isOpen = () => menuOpen;
  t.win.Components.dialog = { isOpen: () => dialogOpen };
  const open = () => t.store.set({ diff: { spec: { kind: 'commit', sha: SHA('a'), file: 'a.txt' }, loading: false, error: 'boom' } });
  open();
  assert.equal(t.root.hidden, false);
  const field = t.dom.doc.createElement('input');
  field.type = 'text';
  t.dom.doc.body.append(field);
  field.focus();
  t.dom.key('Escape', {}, field);
  assert.ok(t.store.state.diff, 'typing: Esc is the field\'s');
  t.dom.doc.activeElement = t.dom.doc.body;
  menuOpen = true;
  t.dom.key('Escape');
  assert.ok(t.store.state.diff, 'menu open: Esc closes the menu only');
  menuOpen = false;
  dialogOpen = true;
  t.dom.key('Escape');
  assert.ok(t.store.state.diff, 'dialog open');
  dialogOpen = false;
  const claim = (e) => e.preventDefault(); // e.g. the sidebar filter clearing itself
  t.dom.doc.body.addEventListener('keydown', claim);
  t.dom.key('Escape');
  t.dom.doc.body.removeEventListener('keydown', claim);
  assert.ok(t.store.state.diff, 'already handled closer to the target');
  t.dom.key('Escape', { metaKey: true });
  assert.ok(t.store.state.diff, 'with a modifier');
  const e = t.dom.key('Escape');
  assert.equal(e.defaultPrevented, true);
  assert.equal(t.store.state.diff, null, 'closed');
  t.dispose();
});

test('mounted diff view: with lines picked, the first Esc clears them and the next closes the diff (VIEW_KEYS closeDiff)', async (tc) => {
  const t = await mountComponent(tc, ['diff-model.js', 'diff-staging.js', 'image-preview.js', 'diff-view.js'], 'diff-view', graphData());
  t.store.set({ status: H.status({ oid: SHA('a'), unstaged: [{ path: 'a.txt', status: 'M' }] }) });
  const f = {
    oldPath: 'a.txt', newPath: 'a.txt', isBinary: false, oldMode: '100644', newMode: '100644',
    hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ type: 'del', text: 'a', oldNo: 1 }, { type: 'add', text: 'b', newNo: 1 }] }],
  };
  const data = { file: f, sections: [f], fingerprint: 'fp', truncated: false, conflict: null };
  t.store.set({ diff: { spec: { kind: 'workdir', file: 'a.txt', staged: false, untracked: false }, loading: false, data, error: null } });
  const row = (i) => t.root.querySelectorAll('.dv-row').find((r) => r.dataset.row === String(i));
  t.dom.dispatch(row(2).querySelector('.dv-gutter'), 'mousedown', { button: 0 });
  t.dom.dispatch(t.dom.doc.body, 'mouseup');
  assert.ok(row(2).classList.contains('is-picked'), 'the added line is picked');
  assert.equal(t.dom.key('Escape', { metaKey: true }).defaultPrevented, false, 'not with a modifier');
  assert.ok(row(2).classList.contains('is-picked'));
  const e = t.dom.key('Escape');
  assert.equal(e.defaultPrevented, true);
  assert.equal(row(2).classList.contains('is-picked'), false, 'the first Esc clears the line selection');
  assert.ok(t.store.state.diff, 'and leaves the diff open');
  t.dom.key('Escape');
  assert.equal(t.store.state.diff, null, 'the next one closes it');
  t.dispose();
});

test('mounted graph + WIP panel: arrows with a WIP-panel button focused (Stage All Changes) stay there; the selection stays on WIP', async (tc) => {
  const t = await mountComponent(tc, ['graph-view.js', ...DETAILS], 'graph-view', wipData());
  const details = t.dom.doc.createElement('div');
  details.dataset.component = 'details';
  t.dom.doc.body.append(details);
  const unmount = t.win.Components.mountAll({ querySelectorAll: () => [details], contains: (n) => n === details }, t.store);
  tc.after(unmount);
  t.store.actions.select({ kind: 'wip' });
  const stageAll = details.querySelector('button.dt-stage-all');
  assert.ok(stageAll, 'the WIP panel is shown');
  stageAll.focus();
  for (const k of ['ArrowDown', 'j', 'ArrowUp', 'End', 'PageDown']) {
    const e = t.dom.key(k, {}, stageAll);
    assert.equal(e.defaultPrevented, false, k);
    assert.deepEqual(t.store.state.selection, { kind: 'wip' }, `${k}: still WIP`);
    assert.equal(t.dom.doc.activeElement, stageAll, `${k}: focus stays on the button`);
  }
  // the graph itself still moves off WIP
  t.root.querySelector('.gv-scroll').focus();
  t.dom.key('ArrowDown');
  assert.deepEqual(t.store.state.selection, { kind: 'commit', sha: SHA('a') });
  unmount();
  t.dispose();
});

test('mounted WIP panel: ⌘⇧M repeats (it only moves focus); a held ⌘↵ commits once', async (tc) => {
  const t = await mountDetails(tc, wipData({ staged: [{ path: 'b.txt', status: 'M' }] }));
  t.dom.key('M', t.mod('m', { shiftKey: true }), t.dom.doc.body);
  assert.equal(t.dom.doc.activeElement, t.summary());
  t.dom.doc.activeElement = t.dom.doc.body;
  const e = t.dom.key('M', t.mod('m', { shiftKey: true, repeat: true }), t.dom.doc.body);
  assert.equal(e.defaultPrevented, true);
  assert.equal(t.dom.doc.activeElement, t.summary(), 'a repeat focuses the summary again');

  t.summary().value = 'fix: once';
  t.dom.doc.activeElement = t.dom.doc.body;
  const held = t.dom.key('Enter', t.mod('enter', { repeat: true }), t.dom.doc.body);
  assert.equal(held.defaultPrevented, true, 'swallowed');
  assert.deepEqual(t.writes(), [], 'a repeat never commits');
  t.summary().focus();
  const inField = t.dom.key('Enter', t.mod('enter', { repeat: true }), t.summary());
  assert.equal(inField.defaultPrevented, true);
  assert.deepEqual(t.writes(), [], 'nor inside the commit fields');
  t.dom.key('Enter', t.mod('enter'), t.summary());
  assert.deepEqual(t.writes(), ['commit']);
  t.dispose();
});

// ------------------------------------------------------------------ WIP panel during a rebase / merge (docs/plans/rebase.md §5.4)

const RB_STOP = SHA('d');
const rebaseStatus = (o = {}, extra = {}) => H.status({
  oid: SHA('a'), branch: null, state: 'rebasing', conflicted: [], unstaged: [], staged: [],
  rebase: H.rebaseState({ conflicted: 0, ...o }), ...extra,
});

/** mountDetails + recording rebaseContinue / mergeCommit flows (each resolves `result`). */
async function mountOpDetails(tc, st, { result = true } = {}) {
  const t = await mountDetails(tc, H.repoData({ commits: H.chain([SHA('a')]), status: st }));
  const opCalls = [];
  for (const n of ['rebaseContinue', 'mergeCommit']) t.flows[n] = async (store, ...args) => { opCalls.push([n, ...args]); return result; };
  const desc = () => t.root.querySelector('textarea.dt-description');
  const btn = () => t.root.querySelector('button.dt-commit-btn');
  const contBtn = () => t.root.querySelector('button.dt-continue-btn');
  const amend = () => t.root.querySelector('label.dt-amend');
  const typeSummary = (v) => { t.summary().value = v; t.dom.dispatch(t.summary(), 'input'); };
  return { ...t, opCalls, desc, btn, contBtn, amend, typeSummary };
}

test('mounted WIP panel mid-rebase: conflict heading, Conflicted Files, and Continue Rebase with the stopped message', async (tc) => {
  const t = await mountOpDetails(tc, rebaseStatus({ conflicted: 1 }, { conflicted: [H.conflict('w.txt')] }));
  const head = t.root.querySelector('div.dt-op-head');
  assert.equal(head.hidden, false);
  assert.equal(head.querySelector('div.dt-op-title').textContent, 'Rebase conflicts detected');
  assert.match(head.textContent, /1 conflicted file: resolve it/);
  const conflictedTitle = t.root.querySelector('section.dt-section').querySelector('h3.dt-section-title');
  assert.match(conflictedTitle.textContent, /^Conflicted Files1$/);
  assert.equal(t.summary().value, 'add the widget');
  assert.equal(t.desc().value, 'With a body.');
  assert.equal(t.btn().textContent, 'Continue Rebase');
  assert.equal(t.btn().disabled, true);
  assert.equal(t.btn().title, 'Resolve and mark all conflicted files first');
  assert.equal(t.amend().hidden, true, 'no Amend at a conflict stop');
  assert.equal(t.contBtn().hidden, true);
  assert.equal(t.root.querySelector('span.dt-composer-title').textContent, 'Rebase commit');
  assert.match(t.root.querySelector('div.dt-wip-title').textContent, /feat \(rebasing\)/);

  // ⌘↵ while conflicts remain: the notice says why, nothing runs
  t.dom.key('Enter', t.mod('enter'), t.dom.doc.body);
  assert.deepEqual(t.opCalls, []);
  assert.equal(t.notices.at(-1).message, 'Resolve and mark all conflicted files first');

  // resolved: Continue runs without a message (unchanged)
  t.store.set({ status: rebaseStatus() });
  assert.equal(head.hidden, true);
  assert.equal(t.btn().disabled, false);
  assert.match(t.btn().title, /Continue Rebase with the original message/);
  t.dom.key('Enter', t.mod('enter'), t.dom.doc.body);
  await H.flush();
  assert.deepEqual(t.opCalls, [['rebaseContinue', { message: null }]]);
  assert.equal(t.store.state.continueDraft, null);

  // edited: the message goes along, and it is published for the banner's Continue
  t.typeSummary('add the better widget');
  assert.deepEqual(t.store.state.continueDraft, { key: `rebase:${RB_STOP}`, message: 'add the better widget\n\nWith a body.' });
  assert.match(t.btn().title, /with this message/);
  t.dom.dispatch(t.btn(), 'click');
  await H.flush();
  assert.deepEqual(t.opCalls[1], ['rebaseContinue', { message: 'add the better widget\n\nWith a body.' }]);

  // ⌘⇧↵ (stage all and commit) is refused in this mode
  t.dom.key('Enter', t.mod('enter', { shiftKey: true }), t.dom.doc.body);
  assert.equal(t.notices.at(-1).message, 'Stage resolved files one by one: all conflicts must be resolved first');
  assert.equal(t.opCalls.length, 2);
  assert.deepEqual(t.writes(), [], 'never a plain commit');

  // a cleared summary blocks
  t.typeSummary('   ');
  assert.equal(t.btn().disabled, true);
  assert.equal(t.btn().title, 'Enter a commit summary');
  t.dispose();
});

test('mounted WIP panel mid-rebase: drafts are kept per stop, and the commit draft comes back after the rebase', async (tc) => {
  const t = await mountOpDetails(tc, H.status({ oid: SHA('a'), unstaged: [{ path: 'a.txt', status: 'M' }] }), { result: false });
  t.typeSummary('my own wip message');
  assert.equal(t.btn().textContent, 'Commit changes to 0 files');

  // the rebase stops at d: the stopped message replaces the fields
  t.store.set({ status: rebaseStatus() });
  assert.equal(t.summary().value, 'add the widget');
  t.typeSummary('edited at d');

  // the next stop (f): its own prefill
  const f = { current: { cmd: 'pick', sha: SHA('f'), subject: 'second' }, stopMessage: 'second\n' };
  t.store.set({ status: rebaseStatus(f) });
  assert.equal(t.summary().value, 'second');
  assert.equal(t.desc().value, '');
  assert.equal(t.store.state.continueDraft, null, 'nothing edited at f');

  // back to d (say an abort and the same rebase again): its draft is restored
  t.store.set({ status: rebaseStatus() });
  assert.equal(t.summary().value, 'edited at d');
  assert.deepEqual(t.store.state.continueDraft, { key: `rebase:${RB_STOP}`, message: 'edited at d\n\nWith a body.' });

  // the rebase ends: the normal draft is back, Amend and the normal label too
  t.store.set({ status: H.status({ oid: SHA('a'), unstaged: [{ path: 'a.txt', status: 'M' }] }) });
  assert.equal(t.summary().value, 'my own wip message');
  assert.equal(t.amend().hidden, false);
  assert.equal(t.btn().textContent, 'Commit changes to 0 files');
  assert.equal(t.store.state.continueDraft, null);
  t.dispose();
});

test('mounted WIP panel at an edit stop: the normal commit box plus Continue Rebase (no message); merge mode: Commit and Merge', async (tc) => {
  const t = await mountOpDetails(tc, rebaseStatus({ stop: 'edit' }, { staged: [{ path: 'b.txt', status: 'M' }] }));
  assert.equal(t.btn().textContent, 'Commit changes to 1 file');
  assert.equal(t.amend().hidden, false, 'amend is the point of an edit stop');
  assert.equal(t.contBtn().hidden, false);
  assert.equal(t.contBtn().disabled, false);
  assert.match(t.contBtn().title, /amended into the stopped commit/);
  t.dom.dispatch(t.contBtn(), 'click');
  await H.flush();
  assert.deepEqual(t.opCalls, [['rebaseContinue', {}]]);
  t.store.set({ busy: true });
  assert.equal(t.contBtn().disabled, true);
  t.store.set({ busy: false });

  t.store.set({ status: H.status({ oid: SHA('a'), state: 'merging', merge: { head: SHA('f'), name: 'topic', message: "Merge branch 'topic'\n" } }) });
  assert.equal(t.contBtn().hidden, true);
  assert.equal(t.btn().textContent, 'Commit and Merge');
  assert.equal(t.summary().value, "Merge branch 'topic'");
  assert.equal(t.amend().hidden, true);
  assert.equal(t.root.querySelector('span.dt-composer-title').textContent, 'Merge commit');
  t.dom.dispatch(t.btn(), 'click');
  await H.flush();
  assert.deepEqual(t.opCalls[1], ['mergeCommit', { message: null }]);
  t.dispose();
});

test('mounted WIP panel where ops refuseAtPickStop refuses commits (empty stop, a stop on a replayed commit): Commit, Amend and ⌘⇧↵ are off with the backend\'s reason', async (tc) => {
  const refused = 'Use Continue Rebase to commit the resolved changes';
  for (const [stop, extra] of [['empty', {}], ['other', { stoppedSha: SHA('d') }], ['hook', { backend: 'apply', stoppedSha: SHA('d') }]]) {
    const t = await mountOpDetails(tc, rebaseStatus({ stop, ...extra }, { staged: [{ path: 'b.txt', status: 'M' }] }));
    t.typeSummary('fix: something');
    assert.equal(t.btn().disabled, true, stop);
    assert.equal(t.btn().title, refused, stop);
    const box = t.root.querySelector('input.dt-amend-input');
    assert.equal(box.disabled, true, `${stop}: amend off`);
    assert.equal(t.amend().title, refused);
    assert.equal(t.contBtn().hidden, false, 'Continue Rebase is the way on');
    t.summary().focus();
    t.dom.key('Enter', t.mod('enter'), t.summary());
    t.dom.key('Enter', t.mod('enter', { shiftKey: true }), t.summary());
    await H.flush();
    assert.deepEqual(t.writes(), [], `${stop}: nothing committed`);
    assert.deepEqual(t.notices.slice(-2).map((n) => n.message), [refused, refused], 'the keys say why');
    t.dispose();
  }
  // an edit stop allows them (even with REBASE_HEAD), and so does a stop between commits (break / exec: no stoppedSha)
  for (const o of [{ stop: 'edit', stoppedSha: SHA('d') }, { stop: 'other', stoppedSha: null }]) {
    const e = await mountOpDetails(tc, rebaseStatus(o, { staged: [{ path: 'b.txt', status: 'M' }] }));
    e.typeSummary('fix: amend it');
    assert.equal(e.btn().disabled, false, o.stop);
    assert.equal(e.root.querySelector('input.dt-amend-input').disabled, false, o.stop);
    e.dispose();
  }
});

test('mounted WIP panel: Continue Rebase and Commit and Merge are off while unstaged changes would be refused (merge: only while its autostash waits)', async (tc) => {
  const unstaged = [{ path: 'a.txt', status: 'M' }];
  const why = 'Stage or discard your unstaged changes first: Continue Rebase commits only what is staged';
  // the 'continue' mode (a resolved conflict stop)
  const t = await mountOpDetails(tc, rebaseStatus({}, { unstaged }));
  assert.equal(t.btn().textContent, 'Continue Rebase');
  assert.deepEqual([t.btn().disabled, t.btn().title], [true, why]);
  t.dom.key('Enter', t.mod('enter'), t.dom.doc.body);
  await H.flush();
  assert.deepEqual(t.opCalls, []);
  assert.equal(t.notices.at(-1).message, why);
  // untracked files don't count
  t.store.set({ status: rebaseStatus({}, { unstaged: [{ path: 'new.txt', status: '?' }] }) });
  assert.equal(t.btn().disabled, false);
  // the 'rebase' mode's Continue Rebase (an edit stop)
  t.store.set({ status: rebaseStatus({ stop: 'edit' }, { unstaged }) });
  assert.deepEqual([t.contBtn().disabled, t.contBtn().title], [true, why]);
  // a merge: git commits what is staged, unless our autostash waits for the merge to end
  const merging = (m, o) => H.status({ oid: SHA('a'), branch: 'main', state: 'merging', merge: { head: SHA('f'), name: 'topic', message: 'Merge topic\n', ...m }, ...o });
  t.store.set({ status: merging({}, { unstaged }) });
  assert.equal(t.btn().disabled, false);
  t.store.set({ status: merging({ autostash: SHA('7') }, { unstaged }) });
  assert.equal(t.btn().disabled, true);
  assert.match(t.btn().title, /your stashed changes come back when the merge is committed/);
  t.dispose();
});

test('mounted WIP panel at a hook stop: the refused message is editable and Continue Rebase sends it (merge backend); the apply backend sends none', async (tc) => {
  const hook = { stop: 'hook', stopMessage: 'wip\n', stoppedSha: SHA('d'), hookOutput: 'commit-msg: subject too short' };
  const t = await mountOpDetails(tc, rebaseStatus(hook));
  assert.equal(t.btn().textContent, 'Continue Rebase');
  assert.equal(t.summary().value, 'wip');
  assert.equal(t.amend().hidden, true);
  assert.equal(t.contBtn().hidden, true, 'the main button is Continue Rebase');
  t.typeSummary('feat: a proper subject');
  t.dom.dispatch(t.btn(), 'click');
  await H.flush();
  assert.deepEqual(t.opCalls, [['rebaseContinue', { message: 'feat: a proper subject' }]]);
  // an apply-backend rebase takes no message: the plain Continue Rebase, and Commit is refused (REBASE_HEAD)
  t.store.set({ status: rebaseStatus({ ...hook, backend: 'apply' }, { staged: [{ path: 'b.txt', status: 'M' }] }) });
  assert.equal(t.contBtn().hidden, false);
  assert.equal(t.btn().title, 'Use Continue Rebase to commit the resolved changes');
  t.dom.dispatch(t.contBtn(), 'click');
  await H.flush();
  assert.deepEqual(t.opCalls[1], ['rebaseContinue', {}]);
  t.dispose();
});

test('mounted WIP panel: its global shortcuts skip a keydown another handler already took (defaultPrevented)', async (tc) => {
  const t = await mountDetails(tc, wipData({ unstaged: [{ path: 'a.txt', status: 'M' }], staged: [{ path: 'b.txt', status: 'M' }] }));
  const taken = (e) => e.preventDefault();
  t.dom.doc.addEventListener('keydown', taken);
  t.dom.doc.activeElement = t.dom.doc.body;
  t.summary().value = 'fix: nope';
  for (const [k, sh] of [['s', true], ['u', true], ['Enter', false], ['Enter', true]]) t.dom.key(k, t.mod(k.toLowerCase(), { shiftKey: sh }), t.dom.doc.body);
  await H.flush();
  assert.deepEqual(t.writes(), [], 'stage all / unstage all / commit did not run');
  t.dom.doc.removeEventListener('keydown', taken);
  t.dom.key('S', t.mod('s', { shiftKey: true }), t.dom.doc.body);
  await H.flush();
  assert.equal(t.writes().length, 1, 'runs once nobody took it');
  t.dispose();
});

test('mounted graph: the WIP row reads "// Rebasing 2/3" mid-rebase with a clean tree', async (tc) => {
  const t = await mountComponent(tc, 'graph-view.js', 'graph-view', H.repoData({ commits: H.chain([SHA('a')]), status: rebaseStatus({ stop: 'edit' }) }));
  const { rowView } = require('../renderer/components/graph-view.js'); // the copy mountComponent loaded
  assert.equal(t.store.state.rows[0].kind, 'wip');
  assert.equal(rowView(t.store.state.rows[0], t.store.state.graph.rows[0], { refsBySha: new Map(), remoteBranch: new Map(), status: t.store.state.status }).subject, '// Rebasing 2/3');
  assert.equal(rowView({ kind: 'wip' }, null, { refsBySha: new Map(), remoteBranch: new Map(), status: H.status({ state: 'merging' }) }).subject, '// Merging');
  t.dispose();
});

// ------------------------------------------------------------------ R2: merge / rebase menus, ref pills, keep a side (docs/plans/rebase.md §5.1, §5.4)

/** main at a (current); feat/y at e, off b: e -> b, a -> b -> c. */
function sideGraphData() {
  const refs = H.refs({
    head: { branch: 'main', oid: SHA('a'), detached: false },
    local: [
      { name: 'main', oid: SHA('a'), upstream: null, ahead: 0, behind: 0, gone: false, current: true },
      { name: 'feat/y', oid: SHA('e'), upstream: null, ahead: 0, behind: 0, gone: false, current: false },
    ],
    remote: [{ name: 'origin/y', remote: 'origin', branch: 'y', oid: SHA('e') }],
    tags: [{ name: 'v0', oid: SHA('c') }],
  });
  const commits = [H.commit(SHA('e'), [SHA('b')]), H.commit(SHA('a'), [SHA('b')]), H.commit(SHA('b'), [SHA('c')]), H.commit(SHA('c'))];
  return H.repoData({ commits, status: H.status({ oid: SHA('a') }), refs });
}

test('mounted graph: right-click on a ref pill opens that ref’s menu (the sidebar’s), on the row the commit menu with Rebase / Merge', async (tc) => {
  const t = await mountComponent(tc, 'graph-view.js', 'graph-view', sideGraphData());
  t.flows.merge = async (store, ...a) => { t.flows.calls.push(['merge', store, ...a]); return true; };
  t.flows.rebase = async (store, ...a) => { t.flows.calls.push(['rebase', store, ...a]); return true; };
  const rowEl = (i) => t.root.querySelectorAll('.gv-row').find((r) => String(r.dataset.index) === String(i));
  // row 0 is e (feat/y + origin/y in one pill), row 1 is a (main)
  t.dom.dispatch(rowEl(0).querySelector('.gv-pill-name'), 'contextmenu', { clientX: 5, clientY: 6 });
  const pill = t.menu.opened[0].items;
  assert.deepEqual(labels(pill), [
    'Checkout', 'Push', 'Create branch here…', 'Set upstream…', '---', 'Merge feat/y into main', 'Rebase main onto feat/y', 'Interactive Rebase main onto feat/y', '---', 'Delete',
  ]);
  assert.deepEqual(t.store.state.selection, { kind: 'commit', sha: SHA('e') }, 'the row is selected too');
  byLabel(pill, 'Rebase main onto feat/y').action();
  assert.ok(!byLabel(pill, 'Rebase feat/y onto main…'), 'no reverse rebase (feat/y onto the current branch)');
  await H.flush();
  assert.deepEqual(calls(t.flows), [
    ['rebase', { onto: 'refs/heads/feat/y', expectHead: SHA('a') }],
  ]);

  t.dom.dispatch(rowEl(0).querySelector('.gv-subject'), 'contextmenu', { clientX: 5, clientY: 6 });
  const row = t.menu.opened[1].items;
  assert.deepEqual(labels(row), ['Checkout this commit', 'Create branch here…', '---', 'Rebase main onto this commit', 'Interactive Rebase main onto this commit', 'Merge this commit into main', '---', 'Checkout feat/y']);
  byLabel(row, 'Merge this commit into main').action();
  await H.flush();
  assert.deepEqual(calls(t.flows)[1], ['merge', { target: SHA('e'), expectHead: SHA('a') }]);

  // b is in main's history: no rebase / merge there, only "Interactive Rebase <n> children of <sha7>" (R3)
  t.dom.dispatch(rowEl(2).querySelector('.gv-subject'), 'contextmenu', { clientX: 5, clientY: 6 });
  assert.deepEqual(labels(t.menu.opened[2].items), ['Checkout this commit', 'Create branch here…', '---', 'Interactive Rebase 1 child of bbbbbbb']);
  // the current branch's pill: Rebase onto its upstream only when it has one (main has none here)
  t.dom.dispatch(rowEl(1).querySelector('.gv-pill-name'), 'contextmenu', { clientX: 5, clientY: 6 });
  assert.deepEqual(labels(t.menu.opened[3].items), ['Checkout', 'Push', 'Create branch here…', 'Set upstream…', '---', 'Delete']);

  // the ContextMenu key on a selected row with pills still opens the row menu (keyboard: rows; refs: the sidebar)
  t.root.querySelector('.gv-scroll').focus();
  t.store.actions.select({ kind: 'commit', sha: SHA('e') });
  at(40_000_000, () => t.dom.key('ContextMenu'));
  assert.equal(t.menu.opened[4].items[3].label, 'Rebase main onto this commit');
  t.dispose();
});

test('mounted sidebar: a rebase in progress disables Merge / Rebase with the reason; busy disables them too', async (tc) => {
  const data = sidebarData();
  const t = await mountComponent(tc, 'sidebar.js', 'sidebar', data);
  t.flows.merge = async () => true;
  t.flows.rebase = async () => true;
  const row = (key) => t.root.querySelectorAll('.sb-row').find((r) => r.dataset.key === key);
  t.store.set({ status: { ...t.store.state.status, state: 'rebasing', branch: null, rebase: H.rebaseState() } });
  t.dom.dispatch(row('local:feat/x'), 'contextmenu', { clientX: 1, clientY: 1 });
  const items = t.menu.opened[0].items;
  assert.ok(!byLabel(items, 'Rebase feat/x onto HEAD…'));
  for (const label of ['Merge feat/x into HEAD', 'Rebase HEAD onto feat/x']) {
    const it = byLabel(items, label);
    assert.ok(it, label);
    assert.deepEqual([it.disabled, it.title], [true, `${label.startsWith('Merge') ? 'Merge' : 'Rebase'} — finish or abort the rebase first`], label);
  }
  t.store.set({ status: data.status, busy: true });
  t.dom.dispatch(row('local:feat/x'), 'contextmenu', { clientX: 1, clientY: 1 });
  assert.ok(t.menu.opened[1].items.filter((d) => !d.separator).every((d) => d.disabled && d.title === 'Working…'));
  t.dispose();
});

test('mounted WIP panel mid-rebase / merge: Keep <onto> / Keep <commit> row buttons (keys 1 / 2) run resolveWith; Mark All Resolved stages every conflicted file', async (tc) => {
  const conflicted = [H.conflict('w.txt'), H.conflict('x.txt')];
  const t = await mountOpDetails(tc, rebaseStatus({ conflicted: 2 }, { conflicted }));
  const kept = [];
  t.flows.resolveWith = async (store, o) => { kept.push(o); return true; };
  const confirms = [];
  Object.assign(t.win.Components.dialog, { confirm: async (o) => { confirms.push(o); return true; }, pathListText: (p) => p.join('\n') });
  const fileRow = (p) => t.root.querySelectorAll('div.dt-file').find((r) => r.dataset.path === p && r.parentNode && r.parentNode.dataset.list === 'conflicted');
  const btnLabels = (p) => fileRow(p).querySelectorAll('button.dt-row-btn').map((b) => [b.textContent, b.dataset.act]);
  assert.deepEqual(btnLabels('w.txt'), [["Keep main's version", 'keep-ours'], ["Keep ddddddd's version", 'keep-theirs'], ['Mark resolved', 'resolve']]);
  assert.equal(fileRow('w.txt').querySelectorAll('button.dt-row-btn')[0].title, "Keep main's version of the file and mark it resolved (1)");

  t.dom.key('1', {}, fileRow('w.txt'));
  await H.flush();
  t.dom.key('2', {}, fileRow('x.txt'));
  await H.flush();
  assert.deepEqual(kept, [{ paths: ['w.txt'], side: 'ours' }, { paths: ['x.txt'], side: 'theirs' }]);

  // the names follow the stop: the rows are rebuilt for the next commit
  t.store.set({ status: rebaseStatus({ conflicted: 2, current: { cmd: 'pick', sha: SHA('9'), subject: 'next' } }, { conflicted }) });
  assert.equal(btnLabels('w.txt')[1][0], "Keep 9999999's version");

  // Mark All Resolved: one confirm listing the files, then ops markAllResolved
  const all = t.root.querySelector('button.dt-resolve-all');
  assert.equal(all.disabled, false);
  t.dom.dispatch(all, 'click');
  await H.flush();
  assert.equal(confirms.at(-1).title, 'Mark 2 files as resolved?');
  const op = t.api.take('markAllResolved');
  assert.deepEqual(op.args, []);
  assert.equal(all.disabled, true, 'inert while it runs');
  op.resolve({ paths: ['w.txt', 'x.txt'], count: 2 });
  await H.flush();
  assert.equal(t.api.pending('stage').length, 0, 'no per-file stage');

  // a merge names the branches; without a rebase / merge only Mark resolved is offered
  t.store.set({ status: H.status({ oid: SHA('a'), branch: 'main', state: 'merging', merge: { head: SHA('f'), name: 'feat', message: 'm' }, conflicted }) });
  assert.deepEqual(btnLabels('w.txt').map((b) => b[0]), ["Keep main's version", "Keep feat's version", 'Mark resolved']);
  t.store.set({ status: H.status({ oid: SHA('a'), branch: 'main', conflicted }) });
  assert.deepEqual(btnLabels('w.txt').map((b) => b[0]), ['Mark resolved']);
  t.dispose();
});

// The commit header's Copy button: the text goes to main (window.api.clipboard, clipboard:writeText),
// never to navigator.clipboard (main denies the page every web permission).
test('mounted commit details: Copy puts the full sha on the clipboard through window.api; a failure is a toast', async (tc) => {
  const t = await mountComponent(tc, DETAILS, 'details', wipData());
  const notices = [];
  t.store.setToast((m) => notices.push(m));
  const written = [];
  let fail = null;
  t.win.api = { clipboard: { writeText: async (text) => { if (fail) throw fail; written.push(text); } } };
  tc.after(() => { delete t.win.api; });
  t.store.actions.select({ kind: 'commit', sha: SHA('a') });
  const copy = t.root.querySelector('button.dt-copy');
  assert.ok(copy, 'the sha row has a Copy button');
  assert.equal(copy.getAttribute('aria-label'), 'Copy full SHA');

  t.dom.dispatch(copy, 'click');
  await H.flush();
  assert.deepEqual(written, [SHA('a')]);
  assert.equal(copy.textContent, 'Copied');
  assert.ok(copy.classList.contains('is-done'));
  assert.deepEqual(notices, []);

  // main's refusal arrives as a plain serialized error: the toast names it, the button stays Copy
  fail = { message: 'text must be a string', kind: 'invalid-args', exitCode: null };
  const again = t.root.querySelector('button.dt-copy');
  again.textContent = 'Copy';
  again.classList.remove('is-done');
  t.dom.dispatch(again, 'click');
  await H.flush();
  assert.equal(notices.length, 1);
  assert.ok(notices[0] instanceof Error);
  assert.equal(notices[0].message, 'Could not copy: text must be a string');
  assert.equal(again.textContent, 'Copy');

  // no window.api.clipboard (an old preload): the same error path, not navigator.clipboard
  t.win.api = {};
  t.dom.dispatch(again, 'click');
  await H.flush();
  assert.equal(notices.at(-1).message, 'Could not copy: The clipboard is not available');
  assert.deepEqual(written, [SHA('a')]);
  t.dispose();
});

// ------------------------------------------------------------------ multi-selection and bulk delete

test('nextSelection: plain click resets to one, ⌘/Ctrl toggles, Shift selects a range from the anchor', () => {
  const { mod: { nextSelection } } = loadComponent('sidebar.js');
  const order = ['local:a', 'local:b', 'local:c', 'local:d'];
  const keys = (sel) => [...sel.keys];
  let sel = nextSelection(null, 'local:b', order);
  assert.deepEqual([keys(sel), sel.anchor], [['local:b'], 'local:b']);
  sel = nextSelection(sel, 'local:d', order, { toggle: true });
  assert.deepEqual([keys(sel), sel.anchor], [['local:b', 'local:d'], 'local:d']);
  sel = nextSelection(sel, 'local:b', order, { toggle: true });
  assert.deepEqual([keys(sel), sel.anchor], [['local:d'], 'local:b'], 'toggled off; the anchor moves');
  sel = nextSelection({ keys: new Set(['local:c']), anchor: 'local:c' }, 'local:a', order, { range: true });
  assert.deepEqual([keys(sel), sel.anchor], [['local:a', 'local:b', 'local:c'], 'local:c'], 'upwards, anchor kept');
  sel = nextSelection(sel, 'local:d', order, { range: true });
  assert.deepEqual(keys(sel), ['local:c', 'local:d'], 'a new range from the same anchor replaces the old one');
  sel = nextSelection(sel, 'local:d', order, { range: true, toggle: true });
  assert.deepEqual(keys(sel), ['local:c', 'local:d'], 'Shift wins over ⌘');
  assert.deepEqual(keys(nextSelection({ keys: new Set(), anchor: 'local:gone' }, 'local:b', order, { range: true })), ['local:b'], 'no visible anchor');
  sel = nextSelection(sel, 'local:a', order);
  assert.deepEqual([keys(sel), sel.anchor], [['local:a'], 'local:a'], 'plain click');
  assert.deepEqual(keys(nextSelection(sel, 'remote:origin/a', order, { toggle: true })), [], 'not selectable: cleared');
  sel = nextSelection(sel, 'local:a', order, { toggle: true });
  assert.deepEqual([keys(sel), sel.anchor], [['local:a'], 'local:a'], 'toggling the only key off does nothing');
});

function bulkState(extra = {}) {
  const local = ['chore/a', 'chore/b', 'chore/sub/c', 'feat/x'].map((name, i) => ({ name, oid: SHA('bcde'[i]), upstream: null, ahead: 0, behind: 0, gone: false, current: false }));
  const s = sampleState(extra);
  return { ...s, refs: { ...s.refs, local: [s.refs.local[0], ...local] } };
}

test('folderMenuItems: "Delete all N branches in <folder>/" with nested folders and the filter; none for other folders', () => {
  const { mod: { folderMenuItems, folderBranches } } = loadComponent('sidebar.js');
  const s = bulkState();
  const flows = { deleteBranches: async () => true };
  assert.deepEqual(folderBranches('dir:local:/chore', s), ['chore/a', 'chore/b', 'chore/sub/c']);
  assert.deepEqual(folderBranches('dir:local:/chore', s, 'sub'), ['chore/sub/c']);
  const [d] = folderMenuItems('dir:local:/chore', s, { flows });
  assert.deepEqual(d, { label: 'Delete all 3 branches in chore/', flow: 'deleteBranches', args: [['chore/a', 'chore/b', 'chore/sub/c']], danger: true });
  assert.equal(folderMenuItems('dir:local:/chore/sub', s, { flows })[0].label, 'Delete 1 branch in chore/sub/');
  for (const k of ['dir:remote:origin', 'dir:tags:/v', 'local:chore/a', null]) assert.deepEqual(folderMenuItems(k, s, { flows }), [], String(k));
  assert.equal(folderMenuItems('dir:local:/chore', { ...s, busy: true }, { flows })[0].disabled, true, 'busy');
  const worktrees = [{ path: '/w', branch: 'chore/b', bare: false }];
  const partly = folderMenuItems('dir:local:/chore', { ...s, worktrees }, { flows })[0];
  assert.deepEqual([partly.label, partly.args], ['Delete 2 branches in chore/', [['chore/a', 'chore/b', 'chore/sub/c']]], 'counts what the flow deletes, without "all"');
});

test('selectionMenuItems: only "Delete N branches"; disabled when only the checked-out branch is left', () => {
  const { mod: { selectionMenuItems } } = loadComponent('sidebar.js');
  const s = bulkState();
  const flows = { deleteBranches: async () => true };
  const items = selectionMenuItems(new Set(['local:main', 'local:chore/a', 'local:feat/x']), s, flows);
  assert.deepEqual(labels(items), ['Delete 2 branches'], 'counts what the flow deletes: main is left out');
  assert.equal(items[0].disabled, undefined);
  assert.deepEqual(items[0].args, [['main', 'chore/a', 'feat/x']]);
  const cur = selectionMenuItems(new Set(['local:main']), s, flows)[0];
  assert.equal(cur.disabled, true);
  assert.equal(cur.title, 'The checked-out branch can’t be deleted: check out another branch first', 'deleteItem\'s reason (deleteRefusal)');
  assert.equal(cur.label, 'Delete 1 branch', 'none deletable: the count of the selection');
  const worktrees = [{ path: '/w', branch: 'chore/a', bare: false }];
  const both = selectionMenuItems(new Set(['local:main', 'local:chore/a']), { ...s, worktrees }, flows)[0];
  assert.deepEqual([both.disabled, both.title], [true, 'None of these branches can be deleted']);
});

test('branchMenuItems: in a normal repository the store\'s worktrees disable Delete up front for a branch checked out in a linked worktree', async () => {
  const { mod: { branchMenuItems, rowTarget } } = loadComponent('sidebar.js');
  const s = sampleState();
  const { api, store } = await H.loadedStore(H.repoData({ commits: H.chain([SHA('a')]), refs: s.refs }));
  assert.equal(store.state.repo.bare, undefined, 'a normal repository');
  api.take('worktrees').resolve([
    { path: '/r', head: SHA('a'), branch: 'main', bare: false, detached: false, main: true, current: true },
    { path: '/w/x', head: SHA('b'), branch: 'feat/x', bare: false, detached: false, main: false, current: false },
  ]);
  await H.flush();
  const del = byLabel(branchMenuItems(rowTarget('local:feat/x', store.state), store.state, fakeFlows()), 'Delete');
  assert.deepEqual([del.disabled, del.title], [true, 'feat/x is checked out in the worktree /w/x: it can’t be deleted']);
});

function bulkData() {
  const s = bulkState();
  return H.repoData({ commits: H.chain([SHA('a'), SHA('b')]), status: { ...H.status({ oid: SHA('a') }), upstream: 'origin/main' }, refs: s.refs, stashes: s.stashes });
}

test('mounted sidebar: ⌘/Ctrl-click toggles, Shift-click selects a range, a plain click and Esc go back to one', async (tc) => {
  const t = await mountComponent(tc, 'sidebar.js', 'sidebar', bulkData());
  const mod = t.win.Components.util.IS_MAC ? { metaKey: true } : { ctrlKey: true };
  const row = (key) => t.root.querySelectorAll('.sb-row').find((r) => r.dataset.key === key);
  const selected = () => t.root.querySelectorAll('.sb-row').filter((r) => r.classList.contains('selected')).map((r) => r.dataset.key);
  const click = (key, init) => t.dom.dispatch(row(key).querySelector('.sb-name'), 'click', init);
  click('local:chore/a');
  await H.flush();
  assert.deepEqual(selected(), ['local:chore/a']);
  click('local:feat/x', mod);
  assert.deepEqual(selected(), ['local:chore/a', 'local:feat/x']);
  assert.equal(row('local:feat/x').getAttribute('aria-selected'), 'true');
  click('local:chore/sub/c', { shiftKey: true }); // visible order: chore/sub/c, chore/a, chore/b, feat/x, main
  assert.deepEqual(selected(), ['local:chore/sub/c', 'local:chore/a', 'local:chore/b', 'local:feat/x']);

  // right-click inside the selection: the reduced menu
  t.dom.dispatch(row('local:chore/b'), 'contextmenu', { clientX: 1, clientY: 1 });
  assert.deepEqual(labels(t.menu.opened[0].items), ['Delete 4 branches']);
  t.menu.opened[0].items[0].action();
  await H.flush();
  assert.deepEqual(calls(t.flows).at(-1), ['deleteBranches', ['chore/sub/c', 'chore/a', 'chore/b', 'feat/x']]);

  // Esc goes back to the one selected row
  const esc = t.dom.key('Escape', {}, row('local:chore/b'));
  assert.equal(esc.defaultPrevented, true);
  assert.deepEqual(selected(), ['local:chore/a']);
  assert.equal(t.dom.key('Escape', {}, row('local:chore/b')).defaultPrevented, false, 'nothing to clear: left alone');

  // a plain click resets the selection to one
  click('local:chore/b', mod);
  assert.equal(selected().length, 2);
  click('local:main');
  await H.flush();
  assert.deepEqual(selected(), ['local:main']);

  // right-click outside the selection selects just that row and shows its normal menu
  click('local:chore/a', mod);
  assert.deepEqual(selected(), ['local:chore/a', 'local:main']);
  t.dom.dispatch(row('local:feat/x'), 'contextmenu', { clientX: 1, clientY: 1 });
  await H.flush();
  assert.deepEqual(selected(), ['local:feat/x']);
  assert.equal(labels(t.menu.opened.at(-1).items).at(-1), 'Delete');
  t.dispose();
});

test('mounted sidebar: right-click on a local folder offers deleting its branches', async (tc) => {
  const t = await mountComponent(tc, 'sidebar.js', 'sidebar', bulkData());
  const folder = t.root.querySelectorAll('.sb-folder').find((r) => r.dataset.key === 'dir:local:/chore');
  t.dom.dispatch(folder, 'contextmenu', { clientX: 1, clientY: 1 });
  assert.deepEqual(labels(t.menu.opened[0].items), ['Delete all 3 branches in chore/']);
  t.menu.opened[0].items[0].action();
  await H.flush();
  assert.deepEqual(calls(t.flows), [['deleteBranches', ['chore/a', 'chore/b', 'chore/sub/c']]]);
  t.dispose();
});

/** A mounted sidebar over bulkData() with row / selection / click helpers. */
async function bulkSidebar(tc) {
  const t = await mountComponent(tc, 'sidebar.js', 'sidebar', bulkData());
  const mod = t.win.Components.util.IS_MAC ? { metaKey: true } : { ctrlKey: true };
  const row = (key) => t.root.querySelectorAll('.sb-item').find((r) => r.dataset.key === key);
  const selected = () => t.root.querySelectorAll('.sb-row').filter((r) => r.classList.contains('selected') && r.dataset.key.startsWith('local:')).map((r) => r.dataset.key);
  const click = (key, init) => t.dom.dispatch(row(key).querySelector('.sb-name') || row(key), 'click', init);
  const sha = () => t.store.state.selection && t.store.state.selection.sha;
  return { ...t, mod, row, selected, click, sha };
}

test('mounted sidebar: a commit selected in the graph ends even a one-row selection: ⌘-click / Shift-click then start afresh', async (tc) => {
  const t = await bulkSidebar(tc);
  t.click('local:chore/a');
  await H.flush();
  t.store.actions.select({ kind: 'commit', sha: SHA('a') }); // the graph
  t.click('local:feat/x', t.mod);
  assert.deepEqual(t.selected(), ['local:feat/x'], 'chore/a is not added back');
  assert.equal(t.sha(), SHA('e'));
  t.dom.dispatch(t.row('local:chore/b'), 'contextmenu', { clientX: 1, clientY: 1 });
  assert.equal(labels(t.menu.opened.at(-1).items).at(-1), 'Delete', 'the one-branch menu');

  t.click('local:chore/a');
  t.store.actions.select({ kind: 'commit', sha: SHA('a') });
  t.click('local:feat/x', { shiftKey: true });
  assert.deepEqual(t.selected(), ['local:feat/x'], 'no range from the stale anchor');
  t.click('local:chore/b', t.mod); // the sidebar's own one-row selection is kept
  assert.deepEqual(t.selected(), ['local:chore/b', 'local:feat/x']);
});

test('mounted sidebar: ⌘-clicking the only selected row keeps it; Esc after ⌘-clicking the selected-commit row off goes to a row still selected', async (tc) => {
  const t = await bulkSidebar(tc);
  t.click('local:chore/a');
  await H.flush();
  t.click('local:chore/a', t.mod);
  assert.deepEqual(t.selected(), ['local:chore/a']);
  t.click('local:chore/b', t.mod);
  assert.deepEqual(t.selected(), ['local:chore/a', 'local:chore/b'], 'still in the selection');
  t.click('local:feat/x', t.mod);
  t.click('local:chore/a', t.mod); // the row whose commit is selected, off
  assert.deepEqual(t.selected(), ['local:chore/b', 'local:feat/x']);
  assert.equal(t.dom.key('Escape', {}, t.row('local:chore/b')).defaultPrevented, true);
  assert.deepEqual(t.selected(), ['local:feat/x'], 'not the deselected chore/a');
  assert.equal(t.sha(), SHA('e'), 'its commit is selected');
});

test('mounted sidebar: rows that are no longer shown leave the selection (refresh, filter, folder and section collapse)', async (tc) => {
  const t = await bulkSidebar(tc);
  const pick = (...keys) => {
    t.click(keys[0]);
    for (const k of keys.slice(1)) t.click(k, t.mod);
  };
  pick('local:chore/a', 'local:chore/b', 'local:feat/x');
  await H.flush();
  // refresh: chore/b deleted
  t.store.set({ refs: { ...t.store.state.refs, local: t.store.state.refs.local.filter((b) => b.name !== 'chore/b') } });
  assert.deepEqual(t.selected(), ['local:chore/a', 'local:feat/x']);
  // filter: only feat/x left -> back to the row whose commit is selected (filtered out: none)
  const input = t.root.querySelector('.sb-filter-input');
  input.value = 'feat';
  t.dom.dispatch(input, 'input', {});
  assert.deepEqual(t.selected(), []);
  input.value = '';
  t.dom.dispatch(input, 'input', {});
  assert.deepEqual(t.selected(), ['local:chore/a'], 'one row, the selected commit\'s');
  t.dom.dispatch(t.row('local:chore/a'), 'contextmenu', { clientX: 1, clientY: 1 });
  assert.equal(labels(t.menu.opened.at(-1).items).at(-1), 'Delete');
  // folder collapse
  pick('local:chore/a', 'local:chore/sub/c', 'local:feat/x');
  t.click('dir:local:/chore/sub');
  assert.deepEqual(t.selected(), ['local:chore/a', 'local:feat/x']);
  t.click('dir:local:/chore/sub');
  assert.deepEqual(t.selected(), ['local:chore/a', 'local:feat/x'], 'rows shown again are not re-added');
  // section collapse
  t.click('section:local');
  assert.deepEqual(t.selected(), []);
  t.click('section:local');
  assert.deepEqual(t.selected(), ['local:chore/a']);
});

test('mounted sidebar: opening another repository clears the multi-selection', async (tc) => {
  const t = await bulkSidebar(tc);
  t.click('local:chore/a');
  t.click('local:chore/b', t.mod);
  await H.flush();
  const loading = t.store.actions.loadRepo({ root: '/other', name: 'other' });
  await H.flush(1);
  await H.answerRefresh(t.api, bulkData());
  await loading;
  await H.flush();
  assert.equal(t.store.state.repo.root, '/other');
  assert.ok(t.selected().length < 2);
  t.click('local:feat/x', t.mod);
  assert.deepEqual(t.selected(), ['local:feat/x']);
});

test('mounted sidebar: Shift+ArrowUp/Down extends the range over local branch rows; ⌘/Ctrl+Space toggles the focused one', async (tc) => {
  const t = await bulkSidebar(tc);
  t.click('local:chore/a'); // visible: chore/, chore/sub/, chore/sub/c, chore/a, chore/b, feat/, feat/x, main
  await H.flush();
  const shift = (key) => {
    const e = t.dom.key(key, { shiftKey: true }, t.dom.doc.activeElement);
    assert.equal(e.defaultPrevented, true, key);
    assert.equal(e.stopped, true, key);
  };
  shift('ArrowDown');
  assert.deepEqual(t.selected(), ['local:chore/a', 'local:chore/b']);
  shift('ArrowDown'); // over the feat/ folder row
  assert.deepEqual(t.selected(), ['local:chore/a', 'local:chore/b', 'local:feat/x']);
  assert.equal(t.dom.doc.activeElement, t.row('local:feat/x'));
  shift('ArrowUp');
  assert.deepEqual(t.selected(), ['local:chore/a', 'local:chore/b'], 'shrinks towards the anchor');
  shift('ArrowUp');
  shift('ArrowUp');
  assert.deepEqual(t.selected(), ['local:chore/sub/c', 'local:chore/a'], 'past the anchor: the other way');
  shift('ArrowUp'); // chore/sub/c is the first local branch row
  assert.deepEqual(t.selected(), ['local:chore/sub/c', 'local:chore/a']);

  const space = (target) => t.dom.key(' ', t.mod, target);
  assert.equal(space(t.row('local:main')).defaultPrevented, true);
  assert.deepEqual(t.selected(), ['local:chore/sub/c', 'local:chore/a', 'local:main']);
  space(t.row('local:chore/sub/c'));
  assert.deepEqual(t.selected(), ['local:chore/a', 'local:main']);
  t.dom.key('Escape', {}, t.row('local:main'));
  assert.deepEqual(t.selected(), ['local:chore/a']);
  space(t.row('local:chore/a'));
  assert.deepEqual(t.selected(), ['local:chore/a'], 'the last one stays');

  // on a folder row Shift+Arrow just moves the focus, and ⌘/Ctrl+Space is left to the app
  const folder = t.row('dir:local:/feat');
  folder.focus();
  const onFolder = space(folder);
  assert.equal(onFolder.defaultPrevented, false);
  assert.equal(onFolder.stopped, false);
  t.dom.key('ArrowDown', { shiftKey: true }, folder);
  assert.equal(t.dom.doc.activeElement, t.row('local:feat/x'));
  assert.deepEqual(t.selected(), ['local:chore/a']);
  assert.equal(t.root.querySelector('.sb-list').getAttribute('aria-multiselectable'), 'true');
  await H.flush();
  assert.deepEqual(calls(t.flows), []);
});
