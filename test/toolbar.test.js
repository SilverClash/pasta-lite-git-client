'use strict';
// Toolbar: the pure menu models and click -> PLFlows wiring, mounted on a minimal fake DOM (just
// what components.js' el() and toolbar.js use). The availability rules themselves live in
// renderer/actions.js and are tested in actions.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const H = require('./renderer-harness.js');

const TOOLBAR = path.join(__dirname, '..', 'renderer', 'components', 'toolbar.js');
const ACTIONS = path.join(__dirname, '..', 'renderer', 'actions.js');

// ------------------------------------------------------------------ fake DOM

class FakeClassList {
  constructor(node) { this.node = node; }
  get set() { return new Set(String(this.node.className || '').split(/\s+/).filter(Boolean)); }
  write(s) { this.node.className = [...s].join(' '); }
  contains(c) { return this.set.has(c); }
  add(...cs) { const s = this.set; cs.forEach((c) => s.add(c)); this.write(s); }
  remove(...cs) { const s = this.set; cs.forEach((c) => s.delete(c)); this.write(s); }
  toggle(c, force) {
    const s = this.set;
    const on = force === undefined ? !s.has(c) : !!force;
    if (on) s.add(c); else s.delete(c);
    this.write(s);
    return on;
  }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.attrs = new Map();
    this.dataset = {};
    this.className = '';
    this.title = '';
    this.listeners = [];
    this._text = '';
    this.classList = new FakeClassList(this);
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; this._text = ''; }
  addEventListener(type, fn, opts = {}) {
    const l = { type, fn };
    this.listeners.push(l);
    if (opts.signal) opts.signal.addEventListener('abort', () => { this.listeners = this.listeners.filter((x) => x !== l); });
  }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter((x) => x.type !== type || x.fn !== fn); }
  click() { for (const l of [...this.listeners]) if (l.type === 'click') l.fn({ type: 'click', target: this }); }
  contains(n) { return n === this || this.children.some((c) => c.contains && c.contains(n)); }
  /** Depth-first search. */
  find(pred) {
    if (pred(this)) return this;
    for (const c of this.children) {
      const hit = c.find && c.find(pred);
      if (hit) return hit;
    }
    return null;
  }
}

const fakeDocument = () => ({
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
});

/** window + fake DOM + actions.js + toolbar.js loaded (index.html order); returns {win, mod}. */
function loadToolbar() {
  const win = H.loadRenderer();
  globalThis.document = fakeDocument();
  delete require.cache[require.resolve(ACTIONS)];
  require(ACTIONS);
  delete require.cache[require.resolve(TOOLBAR)];
  const mod = require(TOOLBAR);
  return { win, mod };
}

/** A fake PLFlows recording every call as [name, ...args-after-store]. */
function fakeFlows(store, { mode = 'ff-if-possible' } = {}) {
  const calls = [];
  const flows = { calls, mode };
  for (const name of ['undo', 'redo', 'fetch', 'pull', 'push', 'checkout', 'createBranch', 'stashSave', 'stashPop', 'openTerminal', 'cancel']) {
    flows[name] = (s, ...args) => {
      assert.equal(s, store, `${name} gets the store first`);
      calls.push([name, ...args]);
      return Promise.resolve(true);
    };
  }
  flows.PULL_MODES = ['fetch', 'ff-if-possible', 'ff-only', 'rebase'];
  flows.pullMode = () => flows.mode;
  flows.setPullMode = (s, m) => { calls.push(['setPullMode', m]); flows.mode = m; return Promise.resolve(true); };
  return flows;
}

function fakeMenu() {
  const menu = { opened: [], closed: 0, open: false };
  return {
    menu,
    api: {
      open(anchor, items, opts) { menu.opened.push({ anchor, items, opts }); menu.open = true; },
      close() { menu.closed++; menu.open = false; },
      isOpen: () => menu.open,
    },
  };
}

// ------------------------------------------------------------------ state fixtures

const REPO = { root: '/r', name: 'r' };
const baseRefs = (o = {}) => H.refs({
  head: { branch: 'main', oid: 'aaaaaaa1', detached: false },
  local: [{ name: 'main', oid: 'aaaaaaa1', current: true, upstream: 'origin/main' }, { name: 'feat/x', oid: 'b' }],
  remote: [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: 'aaaaaaa1' }],
  ...o,
});
const state = (o = {}) => ({ repo: REPO, refs: baseRefs(), ...o });
const KEYS = ['undo', 'redo', 'pull', 'pullMenu', 'push', 'branch', 'stash', 'pop', 'terminal', 'switcher'];
/** The platform's text for ⌘<key> / ⇧⌘<key> (Ctrl+… elsewhere). */
const hint = (win, key, shift = false) => (win.Components.util.IS_MAC ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`);

// ------------------------------------------------------------------ pure models

test('pullMenuModel / branchMenuModel', () => {
  const { mod: { pullMenuModel, branchMenuModel, PULL_LABELS } } = loadToolbar();
  const modes = ['fetch', 'ff-if-possible', 'ff-only', 'rebase'];
  assert.deepEqual(pullMenuModel(modes, 'ff-only').map((x) => [x.mode, x.checked]),
    [['fetch', false], ['ff-if-possible', false], ['ff-only', true], ['rebase', false]]);
  assert.deepEqual(pullMenuModel(modes, 'ff-only').map((x) => x.label), ['Fetch All', 'Pull (fast-forward if possible)', 'Pull (fast-forward only)', 'Pull (rebase)']);
  assert.deepEqual(pullMenuModel(['rebase', 'new-mode'], 'new-mode').map((x) => [x.label, x.checked]), [['Pull (rebase)', false], ['Pull', true]], 'modes come from the caller (PLFlows.PULL_MODES)');
  assert.deepEqual(pullMenuModel(undefined, 'rebase'), []);
  assert.deepEqual(Object.keys(PULL_LABELS), modes);
  assert.deepEqual(branchMenuModel(state({ refs: baseRefs({ local: [{ name: 'main', current: true }, { name: 'x\u202e' }] }) })),
    [{ name: 'main', label: 'main', current: true }, { name: 'x\u202e', label: 'x\\u{202E}', current: false }]);
  assert.deepEqual(branchMenuModel(state({ refs: null })), []);
});

// ------------------------------------------------------------------ mounted: clicks -> PLFlows

async function mounted(data, { mode, repo = REPO } = {}) {
  const { win } = loadToolbar();
  const api = H.makeApi();
  const store = win.Store.create(api);
  const p = store.actions.loadRepo(repo);
  await H.flush(1);
  await H.answerRefresh(api, data);
  await p;
  const flows = fakeFlows(store, { mode });
  win.PLFlows = flows;
  store.set({ pullMode: null }); // app.js sets it on each repo switch; null exercises the fallback
  const menu = fakeMenu();
  win.Components.menu = menu.api;
  const root = new FakeNode('div');
  root.dataset.component = 'toolbar';
  root.querySelectorAll = () => [];
  const container = { querySelectorAll: () => [root], contains: (n) => n === root };
  const dispose = win.Components.mountAll(container, store);
  const btn = (key) => root.find((n) => n.dataset && n.dataset.action === key);
  const cls = (c) => root.find((n) => n.classList && n.classList.contains(c));
  return { win, api, store, flows, menu, root, btn, cls, dispose };
}

const repoData = (o = {}) => H.repoData({
  commits: H.chain(['aaaaaaa1']),
  status: { ...H.status({ oid: 'aaaaaaa1', dirty: true }), upstream: 'origin/main', ahead: 1 },
  refs: baseRefs(),
  stashes: [{ hash: 's1', ref: 'stash@{0}', message: 'wip', date: 0 }],
  undoState: { undo: { action: 'commit', description: "Undo commit 'x'" }, redo: null, busy: false, undoBlocked: null, redoBlocked: null },
  ...o,
});

test('mounted: each enabled button calls the matching PLFlows function with the store', async () => {
  const t = await mounted(repoData(), { mode: 'ff-only' });
  assert.equal(t.btn('undo').getAttribute('aria-disabled'), null);
  assert.equal(t.btn('undo').title, `Undo commit 'x' (${hint(t.win, 'Z')})`);
  assert.equal(t.btn('redo').getAttribute('aria-disabled'), 'true');
  t.btn('undo').click();
  t.btn('redo').click(); // disabled: nothing
  t.btn('pull').click();
  t.btn('push').click();
  t.btn('branch').click();
  t.btn('stash').click();
  t.btn('pop').click();
  t.btn('terminal').click();
  await H.flush();
  assert.deepEqual(t.flows.calls, [
    ['undo'], ['pull', 'ff-only'], ['push'], ['createBranch', {}], ['stashSave'], ['stashPop'], ['openTerminal'],
  ]);
  t.dispose();
});

test('mounted: pull menu lists the modes with the default checked; choosing one sets it and runs it', async () => {
  const t = await mounted(repoData());
  t.btn('pullMenu').click();
  assert.equal(t.menu.menu.opened.length, 1);
  const { anchor, items } = t.menu.menu.opened[0];
  assert.equal(anchor, t.btn('pullMenu'));
  assert.deepEqual(items.map((i) => [i.label, i.checked]), [
    ['Fetch All', false], ['Pull (fast-forward if possible)', true], ['Pull (fast-forward only)', false], ['Pull (rebase)', false],
  ]);
  items[3].action();
  await H.flush();
  assert.deepEqual(t.flows.calls, [['setPullMode', 'rebase'], ['pull', 'rebase']]);
  assert.equal(t.btn('pull').title, 'Pull (rebase) into main');
  t.btn('pull').click();
  await H.flush();
  assert.deepEqual(t.flows.calls.at(-1), ['pull', 'rebase']);
  t.dispose();
});

test('mounted: branch switcher lists local branches (current checked) plus New branch…', async () => {
  const t = await mounted(repoData());
  t.btn('switcher').click();
  const { anchor, items, opts } = t.menu.menu.opened[0];
  assert.equal(anchor, t.btn('switcher'));
  assert.deepEqual(items.map((i) => (i.separator ? '---' : [i.label, !!i.checked])), [['main', true], ['feat/x', false], '---', ['New branch…', false]]);
  // Search mode: the branches filter, New branch… is always shown
  assert.deepEqual(opts.search, { label: 'Filter branches', placeholder: 'Filter branches', empty: 'No branches match' });
  assert.deepEqual(items.map((i) => !!i.pinned), [false, false, false, true]);
  assert.equal(t.btn('switcher').getAttribute('aria-haspopup'), 'dialog', 'the switcher: a search field over a listbox');
  assert.equal(t.btn('switcher').getAttribute('aria-expanded'), 'true');
  opts.onClose();
  assert.equal(t.btn('switcher').getAttribute('aria-expanded'), 'false', 'kept in sync when the menu goes away');
  items[0].action(); // current branch: no checkout
  items[1].action();
  items[3].action();
  await H.flush();
  assert.deepEqual(t.flows.calls, [['checkout', { target: 'feat/x', kind: 'local' }], ['createBranch', {}]]);
  t.dispose();
});

test('mounted: busy disables every action but Terminal ("Working…"), clicks do nothing, and it re-enables after', async () => {
  const t = await mounted(repoData());
  t.store.set({ busy: true });
  for (const k of KEYS) {
    if (k === 'terminal') continue;
    assert.equal(t.btn(k).getAttribute('aria-disabled'), 'true', k);
    assert.match(t.btn(k).title, /Working…/, k);
    t.btn(k).click();
  }
  assert.equal(t.root.classList.contains('is-busy'), true);
  await H.flush();
  assert.deepEqual(t.flows.calls, []);
  // PLFlows.openTerminal runs while busy (flows contract), so Terminal stays enabled
  assert.equal(t.btn('terminal').getAttribute('aria-disabled'), null);
  t.btn('terminal').click();
  await H.flush();
  assert.deepEqual(t.flows.calls, [['openTerminal']]);
  t.flows.calls.length = 0;
  assert.equal(t.menu.menu.opened.length, 0);
  t.store.set({ busy: false });
  assert.equal(t.btn('push').getAttribute('aria-disabled'), null);
  t.dispose();
});

test('mounted: clean tree and no stashes disable Stash / Pop; unmount releases listeners and the subscription', async () => {
  const t = await mounted(repoData({ status: { ...H.status({ oid: 'aaaaaaa1' }), upstream: 'origin/main' }, stashes: [] }));
  assert.equal(t.btn('stash').getAttribute('aria-disabled'), 'true');
  assert.equal(t.btn('pop').getAttribute('aria-disabled'), 'true');
  t.btn('stash').click();
  t.btn('pop').click();
  const push = t.btn('push');
  const pull = t.btn('pull');
  t.btn('pullMenu').click(); // leave a menu open: unmount closes it
  t.dispose();
  assert.equal(t.menu.menu.closed, 1);
  assert.equal(t.root.children.length, 0);
  assert.equal(push.listeners.length, 0);
  assert.equal(pull.listeners.length, 0);
  const title = push.title;
  t.store.set({ busy: true }); // no longer subscribed
  assert.equal(push.title, title);
  push.click();
  await H.flush();
  assert.deepEqual(t.flows.calls, []);
});

test('mounted: Cancel shows while a remote op runs, stays enabled while busy and calls PLFlows.cancel', async () => {
  const t = await mounted(repoData());
  const cancel = t.btn('cancel');
  assert.ok(cancel, 'Cancel button in the busy area');
  assert.equal(t.cls('tb-busy').contains(cancel), true);
  assert.equal(cancel.hidden, true);
  cancel.click();
  await H.flush();
  assert.deepEqual(t.flows.calls, [], 'no remote op: nothing to cancel');

  t.store.set({ busy: true, remoteOp: { op: 'fetch', opId: 'op-1' } });
  assert.equal(cancel.hidden, false);
  assert.equal(cancel.getAttribute('aria-disabled'), null);
  assert.equal(cancel.title, 'Cancel the running fetch');
  assert.equal(t.cls('tb-busy').classList.contains('on'), true);
  cancel.click();
  await H.flush();
  assert.deepEqual(t.flows.calls, [['cancel']]);

  t.store.set({ busy: false, remoteOp: null });
  assert.equal(cancel.hidden, true);
  assert.equal(t.cls('tb-busy').classList.contains('on'), false);
  t.dispose();
});

test('mounted: the Pull button reads state.pullMode, falling back to PLFlows.pullMode(store)', async () => {
  const t = await mounted(repoData(), { mode: 'ff-only' });
  assert.equal(t.btn('pull').title, 'Pull (fast-forward only) into main', 'fallback: PLFlows.pullMode');
  t.store.set({ pullMode: 'rebase' });
  assert.equal(t.btn('pull').title, 'Pull (rebase) into main', 're-rendered on state.pullMode');
  t.btn('pull').click();
  await H.flush();
  assert.deepEqual(t.flows.calls, [['pull', 'rebase']]);
  t.btn('pullMenu').click();
  assert.deepEqual(t.menu.menu.opened[0].items.filter((i) => i.checked).map((i) => i.label), ['Pull (rebase)']);
  t.store.set({ pullMode: 'fetch' });
  assert.equal(t.btn('pull').title, `Fetch All: fetch every remote (${hint(t.win, 'L')})`, 'Fetch All is ⌘L');
  t.store.set({ pullMode: 'bogus' });
  assert.equal(t.btn('pull').title, 'Pull (fast-forward only) into main', 'unknown value: PLFlows.pullMode');
  t.dispose();
});

test('mounted: Undo / Redo / Branch tooltips end with their shortcut, enabled or not; Fetch All in the pull menu names ⌘L', async () => {
  const t = await mounted(repoData());
  assert.equal(t.btn('undo').title, `Undo commit 'x' (${hint(t.win, 'Z')})`);
  assert.equal(t.btn('redo').getAttribute('aria-disabled'), 'true');
  assert.equal(t.btn('redo').title, `Nothing to redo (${hint(t.win, 'Z', true)})`, 'a disabled button still shows its key');
  assert.equal(t.btn('branch').title, `Create a branch at main (${hint(t.win, 'B')})`);
  assert.doesNotMatch(t.btn('push').title, /⌘|Ctrl\+/, 'Push has no shortcut');
  assert.doesNotMatch(t.btn('pull').title, /⌘|Ctrl\+/, 'a real pull is not ⌘L');
  t.store.set({ busy: true });
  assert.equal(t.btn('undo').title, `Undo — Working… (${hint(t.win, 'Z')})`);
  t.store.set({ busy: false });
  t.btn('pullMenu').click();
  const fetchAll = t.menu.menu.opened[0].items.find((i) => i.label === 'Fetch All');
  assert.equal(fetchAll.title, `Fetch every remote (${hint(t.win, 'L')})`);
  assert.equal(t.menu.menu.opened[0].items.filter((i) => i.title).length, 1, 'only Fetch All has a shortcut');
  t.dispose();
});

test('Components.actions.keyHint / withKeyHint: macOS glyphs, Ctrl+ elsewhere', () => {
  const { win } = loadToolbar();
  const A = win.Components.actions;
  assert.equal(A.keyHint('undo', true), '⌘Z');
  assert.equal(A.keyHint('redo', true), '⇧⌘Z');
  assert.equal(A.keyHint('commit', true), '⌘↵');
  assert.equal(A.keyHint('commitAll', true), '⇧⌘↵');
  assert.equal(A.keyHint('stageAll', true), '⇧⌘S');
  assert.equal(A.keyHint('undo', false), 'Ctrl+Z');
  assert.equal(A.keyHint('redo', false), 'Ctrl+Shift+Z');
  assert.equal(A.keyHint('commit', false), 'Ctrl+Enter');
  assert.equal(A.keyHint('commitAll', false), 'Ctrl+Shift+Enter');
  assert.equal(A.keyHint({ key: 'X', shift: true }, false), 'Ctrl+Shift+X');
  assert.equal(A.keyHint('nope'), '');
  assert.equal(A.keyHint('undo'), A.keyHint('undo', win.Components.util.IS_MAC), 'defaults to util.IS_MAC');
  assert.equal(A.withKeyHint('Undo', 'undo', false), 'Undo (Ctrl+Z)');
  assert.equal(A.withKeyHint('Push', 'push', true), 'Push', 'no shortcut: unchanged');
});

test('mounted: a throwing flow is logged and toasted by the shared runFlow', async () => {
  const t = await mounted(repoData());
  t.flows.push = () => { throw new Error('push exploded'); };
  const toasts = [];
  t.store.actions.toast = (e) => toasts.push(e);
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a);
  try {
    t.btn('push').click();
    await H.flush();
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
  assert.deepEqual(toasts.map((e) => e.message), ['push exploded']);
  t.dispose();
});

test('mounted mid-rebase: the branch stack names the branch being rebased, conflicting actions are off, Cancel names the rebase', async () => {
  const st = { ...H.status({ oid: 'aaaaaaa1', branch: null, state: 'rebasing', rebase: H.rebaseState() }), upstream: null };
  const t = await mounted(repoData({ status: st }));
  const branchText = t.btn('switcher').find((n) => n.classList && n.classList.contains('tb-stack-text'));
  assert.equal(branchText.textContent, 'feat (rebasing)');
  for (const key of ['pull', 'push', 'branch', 'stash', 'pop', 'switcher', 'undo']) {
    assert.equal(t.btn(key).getAttribute('aria-disabled'), 'true', key);
  }
  assert.equal(t.btn('branch').title, `Branch — finish or abort the rebase first (${hint(t.win, 'B')})`);
  assert.equal(t.btn('push').title, 'Push — a rebase is in progress');
  assert.equal(t.btn('terminal').getAttribute('aria-disabled'), null);
  t.btn('branch').click();
  t.btn('pull').click();
  await H.flush();
  assert.deepEqual(t.flows.calls, [], 'gated clicks run nothing');

  t.store.set({ busy: true, remoteOp: { op: 'rebaseContinue', opId: 'op-9' } });
  assert.equal(t.btn('cancel').title, 'Cancel the running rebase');
  t.btn('cancel').click();
  await H.flush();
  assert.deepEqual(t.flows.calls, [['cancel']]);
  const { mod: { cancelTitle } } = loadToolbar();
  assert.equal(cancelTitle('rebaseSkip'), 'Cancel the running rebase');
  assert.equal(cancelTitle('push'), 'Cancel the running push');
  assert.equal(cancelTitle(undefined), 'Cancel the running operation');
  t.dispose();
});

// ------------------------------------------------------------------ bare repository

test('mounted bare repository: name as main gives it, a bare pill, Pull as Fetch All, no Stash / Pop, switcher checkouts off, Branch on', async () => {
  const bare = { root: '/w/myproject/.bare', name: 'myproject/.bare', bare: true };
  const status = { ...H.status({ oid: 'aaaaaaa1' }), upstream: 'origin/main', ahead: 0, behind: 0, state: 'clean', rebase: null, merge: null, pendingAutostash: null, bare: true };
  const t = await mounted(repoData({ status, stashes: [] }), { mode: 'ff-only', repo: bare });
  assert.equal(t.btn('repoPicker').find((n) => n.classList && n.classList.contains('tb-stack-text')).textContent, 'myproject/.bare');
  const pills = t.cls('tb-pills');
  assert.deepEqual(pills.children.map((c) => c.textContent), ['bare', '✓']);
  assert.equal(pills.children[0].title, 'Bare repository — no working tree');

  // Pull runs as Fetch All whatever the stored mode
  assert.equal(t.btn('pull').getAttribute('aria-disabled'), null);
  assert.equal(t.btn('pull').title, `Fetch All: fetch every remote (${hint(t.win, 'L')})`);
  t.btn('pull').click();
  await H.flush();
  assert.deepEqual(t.flows.calls, [['pull', 'fetch']]);
  t.btn('pullMenu').click();
  const pullItems = t.menu.menu.opened[0].items;
  assert.deepEqual(pullItems.map((i) => [i.label, !!i.checked, !!i.disabled]), [
    ['Fetch All', true, false], ['Pull (fast-forward if possible)', false, true], ['Pull (fast-forward only)', false, true], ['Pull (rebase)', false, true],
  ]);
  assert.equal(pullItems[2].title, 'Pull (fast-forward only) — needs a working tree (bare repository)');
  pullItems[3].action(); // disabled: nothing
  await H.flush();
  assert.equal(t.flows.calls.length, 1);

  for (const k of ['stash', 'pop']) {
    assert.equal(t.btn(k).getAttribute('aria-disabled'), 'true', k);
    assert.match(t.btn(k).title, /— needs a working tree \(bare repository\)$/, k);
  }
  assert.equal(t.btn('branch').title, `Create a branch at main (not checked out) (${hint(t.win, 'B')})`);
  for (const k of ['push', 'branch', 'switcher']) assert.equal(t.btn(k).getAttribute('aria-disabled'), null, k);

  t.btn('switcher').click();
  const items = t.menu.menu.opened[1].items;
  assert.deepEqual(items.map((i) => (i.separator ? '---' : [i.label, !!i.disabled])), [['main', false], ['feat/x', true], '---', ['New branch…', false]]);
  assert.equal(items[0].title, 'HEAD of the bare repository points at main');
  assert.equal(items[1].title, 'Checkout — needs a working tree (bare repository)');
  items[1].action();
  items[3].action();
  await H.flush();
  assert.deepEqual(t.flows.calls.slice(1), [['createBranch', {}]], 'no checkout; the flow creates without checking out');
  t.dispose();
});

test('mounted bare repository, real menu.js: every checkout off, the highlight falls to the pinned New branch…; typing filters; Enter creates', async () => {
  const bare = { root: '/w/b/.bare', name: 'b/.bare', bare: true };
  const status = { ...H.status({ oid: 'aaaaaaa1' }), upstream: null, ahead: 0, behind: 0, state: 'clean', rebase: null, merge: null, pendingAutostash: null, bare: true };
  // HEAD names a branch that is not among the local ones: nothing is current, every row is a checkout.
  const refs = baseRefs({ local: [{ name: 'feat/x', oid: 'b' }, { name: 'fix/y', oid: 'c' }] });
  const t = await mounted(repoData({ status, refs, stashes: [] }), { repo: bare });
  // The real menu on the fake DOM from renderer-harness (the toolbar keeps its own nodes).
  const dom = H.fakeDom().install();
  dom.attach(t.win);
  const MENU = path.join(__dirname, '..', 'renderer', 'menu.js');
  delete require.cache[require.resolve(MENU)];
  require(MENU);

  t.btn('switcher').click();
  assert.equal(t.win.Components.menu.isOpen(), true);
  assert.equal(t.btn('switcher').getAttribute('aria-expanded'), 'true');
  const root = dom.document.body.findAll((n) => n.classList.contains('pl-menu'))[0];
  const input = root.findAll((n) => n.tagName === 'INPUT')[0];
  const options = root.findAll((n) => n.getAttribute('role') === 'option');
  const empty = root.children.find((n) => n.classList.contains('pl-menu-empty'));
  const type = (text) => { input.value = text; dom.dispatch(input, 'input'); };
  const activeId = () => input.getAttribute('aria-activedescendant');
  assert.equal(dom.document.activeElement, input);
  assert.deepEqual(options.map((o) => [o.children.find((n) => n.classList.contains('pl-menu-label')).textContent, o.getAttribute('aria-disabled')]),
    [['feat/x', 'true'], ['fix/y', 'true'], ['New branch…', null]]);
  assert.equal(activeId(), options[2].id, 'no enabled branch: New branch… is highlighted');

  type('fix');
  assert.deepEqual(options.map((o) => o.hidden), [true, false, false], 'the pinned row stays');
  assert.equal(activeId(), null, 'only a disabled branch matches');
  assert.equal(empty.textContent, '');
  dom.key('Enter');
  assert.equal(t.win.Components.menu.isOpen(), true, 'Enter does nothing');

  type('zzz');
  assert.equal(empty.textContent, 'No branches match');
  type('new');
  assert.equal(empty.textContent, '', 'New branch… matches');
  assert.equal(activeId(), options[2].id);
  dom.key('Enter');
  assert.equal(t.win.Components.menu.isOpen(), false);
  assert.equal(t.btn('switcher').getAttribute('aria-expanded'), 'false');
  await H.flush();
  assert.deepEqual(t.flows.calls, [['createBranch', {}]], 'no checkout ran');
  t.dispose();
});

// ------------------------------------------------------------------ linked worktrees

const LINKED = { root: '/w/monorepo-feat', name: 'monorepo-feat', bare: false, linkedWorktree: { mainPath: '/w/monorepo', mainName: 'monorepo', title: 'monorepo · monorepo-feat' } };

test('worktreeChipModel: only a linked worktree (main\'s repo.linkedWorktree) gets the chip; tooltip = its folder and the main worktree', () => {
  const { mod: { worktreeChipModel } } = loadToolbar();
  assert.deepEqual(worktreeChipModel(LINKED), { text: 'worktree', title: '/w/monorepo-feat\nLinked worktree of /w/monorepo' });
  assert.equal(worktreeChipModel({ root: '/w/monorepo', name: 'monorepo', bare: false, linkedWorktree: null }), null, 'the main worktree');
  assert.equal(worktreeChipModel({ root: '/r', name: 'r' }), null, 'a normal repository');
  assert.equal(worktreeChipModel({ root: '/r.git', name: 'r.git', bare: true, linkedWorktree: null }), null, 'a bare repository');
  assert.equal(worktreeChipModel(null), null);
  assert.equal(worktreeChipModel({ ...LINKED, root: '/w/x‮' }).title, '/w/x\\u{202E}\nLinked worktree of /w/monorepo', 'display-safe');
});

test('mounted: the worktree chip sits right of the repository stack for a linked worktree; a click asks the sidebar to reveal it', async () => {
  const t = await mounted(repoData(), { repo: LINKED });
  const chip = t.btn('worktreeChip');
  const left = t.cls('tb-left');
  assert.equal(left.children.indexOf(chip), left.children.indexOf(t.btn('repoPicker')) + 1, 'next to the repository crumb');
  assert.equal(chip.hidden, false);
  assert.ok(chip.classList.contains('tb-pill') && chip.classList.contains('muted'), 'styled like the "no upstream" pill');
  assert.equal(chip.textContent, 'worktree');
  assert.ok(chip.find((n) => n.getAttribute && /icon-worktree/.test(n.getAttribute('class') || '')), 'the tree icon');
  assert.equal(chip.title, '/w/monorepo-feat\nLinked worktree of /w/monorepo');
  assert.equal(t.store.state.worktreeReveal, 0);
  chip.click();
  chip.click();
  assert.equal(t.store.state.worktreeReveal, 2, 'store.actions.revealWorktree, once per click');
  assert.deepEqual(t.flows.calls, [], 'no flow runs');
  t.dispose();
});

test('mounted: no worktree chip for a main worktree or a normal repository', async () => {
  for (const repo of [REPO, { root: '/w/monorepo', name: 'monorepo', bare: false, linkedWorktree: null }]) {
    const t = await mounted(repoData(), { repo });
    assert.equal(t.btn('worktreeChip').hidden, true, repo.root);
    t.dispose();
  }
});

test('mounted: the branch switcher disables a branch checked out in another worktree ("Checked out in worktree <path>")', async () => {
  const t = await mounted(repoData());
  const w = (o) => ({ head: 'b', bare: false, detached: false, locked: false, prunable: false, main: false, current: false, ...o });
  t.store.set({ worktrees: [w({ path: '/r', branch: 'main', main: true, current: true }), w({ path: '/w/feat‮', branch: 'feat/x' })] });
  t.btn('switcher').click();
  const { items } = t.menu.menu.opened[0];
  const feat = items.find((i) => i.label === 'feat/x');
  assert.deepEqual([feat.disabled, feat.title], [true, 'Checked out in worktree /w/feat\\u{202E}']);
  feat.action();
  const main = items.find((i) => i.label === 'main');
  assert.equal(main.checked, true, 'the current worktree\'s own branch is the current branch, not refused');
  await H.flush();
  assert.deepEqual(t.flows.calls, [], 'no checkout ran');
  t.dispose();
});

test('mounted: main\'s fresh summary of the same repo (store.actions.updateRepoInfo) updates the chip in place; another root is ignored', async () => {
  const t = await mounted(repoData(), { repo: LINKED });
  const chip = t.btn('worktreeChip');
  const before = t.store.state.repo;
  t.store.actions.updateRepoInfo({ ...LINKED, linkedWorktree: { ...LINKED.linkedWorktree } });
  assert.equal(t.store.state.repo, before, 'nothing changed: the same repo object, no re-render');
  const moved = { mainPath: '/w/moved/monorepo', mainName: 'monorepo', title: 'monorepo · monorepo-feat' };
  t.store.actions.updateRepoInfo({ ...LINKED, linkedWorktree: moved });
  assert.equal(chip.title, '/w/monorepo-feat\nLinked worktree of /w/moved/monorepo');
  assert.equal(t.store.state.repo.root, LINKED.root);
  t.store.actions.updateRepoInfo({ root: '/elsewhere', name: 'x', bare: false, linkedWorktree: null });
  assert.equal(chip.hidden, false, 'another root: ignored');
  t.store.actions.updateRepoInfo({ ...LINKED, linkedWorktree: null });
  assert.equal(chip.hidden, true, 'no longer a linked worktree');
  t.dispose();
});
