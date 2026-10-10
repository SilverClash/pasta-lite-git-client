'use strict';
// src/repo-opening.js (where an open goes, what it asks, what changes once it lands) and
// src/recent-view.js, over fake ports: real tab registry and tab sessions, fake git, trust,
// recent store, dialogs and UI.
const test = require('node:test');
const { describe } = test;
const assert = require('node:assert/strict');
const { createRepoOpening, shouldForgetRecent, findShownRecent, listedEntry, freshWorktreeEntry } = require('../src/repo-opening');
const { createRecentView } = require('../src/recent-view');
const { createTabRegistry } = require('../src/tabs');
const { createTabSession } = require('../src/tab-session');
const { kindError } = require('../src/exec');


test('shouldForgetRecent: only not-a-repo / not-found drop the entry', () => {
  assert.ok(shouldForgetRecent({ kind: 'not-a-repo' }));
  assert.ok(shouldForgetRecent({ kind: 'not-found' }));
  for (const kind of ['unsafe-repo', 'timeout', 'aborted', 'forbidden', null, undefined]) {
    assert.equal(shouldForgetRecent({ kind, message: 'x' }), false, String(kind));
  }
  assert.equal(shouldForgetRecent(null), false);
  assert.equal(shouldForgetRecent(new Error('plain')), false);
});

test('findShownRecent: exact membership in the list main last sent', () => {
  const shown = [{ root: '/r/a', name: 'a' }, { root: '/r/b [x]', name: 'b [x]' }];
  assert.equal(findShownRecent(shown, '/r/a'), shown[0]);
  assert.equal(findShownRecent(shown, '/r/b [x]'), shown[1]);
  for (const bad of ['/r/c', '/r/a/', '/r/a/..', '/r', '', 'a', 0, null, undefined, {}, ['/r/a']]) {
    assert.equal(findShownRecent(shown, bad), null, JSON.stringify(bad));
  }
  assert.equal(findShownRecent([], '/r/a'), null);
  assert.equal(findShownRecent(null, '/r/a'), null);
});

describe('app:openWorktree / app:revealWorktree helpers', () => {
  const list = [
    { path: '/w/.bare', head: null, branch: null, bare: true, prunable: false, missing: false },
    { path: '/w/main', head: 'a'.repeat(40), branch: 'main', bare: false, prunable: false, missing: false },
    { path: '/w/gone', head: 'a'.repeat(40), branch: 'gone', bare: false, prunable: true, missing: true },
    { path: '/w/usb', head: 'a'.repeat(40), branch: 'usb', bare: false, prunable: false, missing: true, locked: true },
  ];
  test('listedEntry: only a listed path whose folder is there; the bare entry only with allowBare', () => {
    for (const o of [undefined, { allowBare: false }, { allowBare: true }]) {
      assert.equal(listedEntry(list, '/w/main', o), list[1]);
      assert.equal(listedEntry(list, '/w/gone', o), null, 'prunable: its folder is gone');
      assert.equal(listedEntry(list, '/w/usb', o), null, 'locked and missing: git doesn\'t call it prunable, but its folder is gone');
      assert.equal(listedEntry(list, '/etc', o), null, 'unlisted');
      assert.equal(listedEntry(list, '/w/main/', o), null, 'compared as git prints it');
      for (const bad of ['', null, undefined, 42, ['/w/main'], { path: '/w/main' }]) assert.equal(listedEntry(list, bad, o), null, String(bad));
      assert.equal(listedEntry(null, '/w/main', o), null);
    }
    assert.equal(listedEntry(list, '/w/.bare'), null, 'the bare entry can\'t be opened');
    assert.equal(listedEntry(list, '/w/.bare', { allowBare: true }), list[0], 'but it is a real folder to reveal');
  });
  test('freshWorktreeEntry: a fresh list of the tab\'s repo; not-found, no-repo, or null when the repo changed', async () => {
    const session = { repo: { root: '/w/.bare' } };
    const asked = [];
    const listWorktrees = async (root) => { asked.push(root); return list; };
    assert.equal(await freshWorktreeEntry(listWorktrees, session, '/w/main'), list[1]);
    assert.deepEqual(asked, ['/w/.bare']);
    assert.equal(await freshWorktreeEntry(listWorktrees, session, '/w/.bare', { allowBare: true }), list[0]);
    for (const [p, message] of [['/w/gone', 'Its folder is gone'], ['/w/usb', 'Its folder is gone'], ['/etc', 'This worktree is no longer listed'], ['/w/.bare', 'This worktree is no longer listed'], ['', 'This worktree is no longer listed'], [42, 'This worktree is no longer listed']]) {
      await assert.rejects(freshWorktreeEntry(listWorktrees, session, p), { kind: 'not-found', message }, String(p));
    }
    await assert.rejects(freshWorktreeEntry(listWorktrees, { repo: null }, '/w/main'), { kind: 'no-repo' });
    const moved = { repo: { root: '/w/.bare' } };
    const switching = async () => { moved.repo = { root: '/r/other' }; return list; };
    assert.equal(await freshWorktreeEntry(switching, moved, '/w/main'), null);
  });
});

// ---------------------------------------------------------------- recent view

test('recent view: the list last read, names, roots and the shown path only; an older, slower read never wins', async () => {
  let store = null;
  const view = createRecentView({ store: () => store, home: () => '/r' });
  assert.deepEqual(await view.refresh(), [], 'no store yet: empty');
  const reads = [];
  store = { list: () => new Promise((resolve) => reads.push(resolve)) };
  const older = view.refresh();
  const newer = view.refresh();
  reads[1]([{ root: '/r/new', name: 'new', openedAt: 2 }, { root: '/rx/y', name: 'y', openedAt: 1 }]);
  const list = [{ root: '/r/new', name: 'new', display: '~/new' }, { root: '/rx/y', name: 'y', display: '/rx/y' }];
  assert.deepEqual(await newer, list, 'display: the home folder as ~, at a folder boundary only');
  reads[0]([{ root: '/r/old', name: 'old', openedAt: 1 }]);
  assert.deepEqual(await older, list, 'the older read returns the newer list');
  assert.deepEqual(view.shown, list);
});

test('recent view: no home folder, every path in full', async () => {
  const view = createRecentView({ store: () => ({ list: async () => [{ root: '/r/a', name: 'a' }] }), home: () => '' });
  assert.deepEqual(await view.refresh(), [{ root: '/r/a', name: 'a', display: '/r/a' }]);
});

// ---------------------------------------------------------------- the open flow

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/**
 * A repo-opening over fakes. `repos` maps a dir to its info (or an Error to reject with);
 * `trustAnswers` are the Trust and Open answers (true / false / a deferred's promise); `risky`
 * lists the roots that ask. `tabs` are the roots of the tabs to start with (null: New Tab).
 */
function setup({ repos = {}, tabs: roots = [null], risky = [], trustAnswers = [], worktrees = {}, interactive = true, folder = null } = {}) {
  const tabs = createTabRegistry();
  const sent = []; // [tabId, channel, payload]
  const calls = []; // port calls, in order
  let nextId = 1;
  const newSession = () => {
    const id = nextId++;
    return createTabSession({ id, send: (ch, p) => sent.push([id, ch, p]), createWatcher: () => ({ pause() {}, resume() {}, close() {} }), log: () => {}, watch: { info: () => {} } });
  };
  for (const root of roots) {
    const s = tabs.add(newSession());
    if (root) s.setRepo({ root, name: root.split('/').pop(), bare: false });
  }
  const recentList = [];
  const store = {
    add: (root, o) => { calls.push(['recent.add', root, o.name]); recentList.unshift({ root, name: o.name }); },
    addAsync: async (root, o) => { calls.push(['recent.addAsync', root, o.name]); recentList.unshift({ root, name: o.name }); },
    remove: (root) => { calls.push(['recent.remove', root]); },
    list: async () => recentList.slice(),
  };
  const recentView = createRecentView({ store: () => store, home: () => '/home/nobody' });
  const errors = [];
  const opening = createRepoOpening({
    tabs,
    openRepo: async (dir) => {
      const r = repos[dir];
      if (!r) throw kindError('not-found', `No such folder: ${dir}`);
      if (r instanceof Error) throw r;
      return typeof r.then === 'function' ? r : { ...r };
    },
    listWorktrees: async (root) => { const w = worktrees[root]; return typeof w === 'function' ? w() : w || []; },
    trust: { confirm: async (root) => { calls.push(['trust', root]); return risky.includes(root) ? trustAnswers.shift() : true; } },
    recent: () => store,
    recentView,
    place: {
      addTab: ({ index, activate }) => { calls.push(['addTab', index, activate]); return tabs.add(newSession(), { index }); },
      activate: (id) => { calls.push(['activate', id]); tabs.activate(id); },
      front: () => calls.push(['front']),
      setRepo: (s, info) => { calls.push(['setRepo', s.id, info.root]); s.setRepo(info); },
    },
    pickFolder: async ({ newTab }) => { calls.push(['pickFolder', newTab]); return folder; },
    onRecentChanged: async () => { calls.push(['recentChanged']); },
    onOpened: () => calls.push(['menu']),
    ui: { interactive, showError: (title, err) => errors.push([title, err.kind]) },
    log: { info() {}, warn() {}, error() {} },
    tabLog: { info() {} },
  });
  return { opening, tabs, sent, calls, errors, recentView, store };
}
const info = (root, o = {}) => ({ root, name: root.split('/').pop(), head: { sha: 'a'.repeat(40), branch: 'main' }, bare: false, ...o });

describe('openExternal (CLI, dock, second launch)', () => {
  test('uses the empty active tab: the repo lands there, recent and the menu follow, the pages hear it, shown and brought forward', async () => {
    const { opening, tabs, sent, calls } = setup({ repos: { '/r/a/sub': info('/r/a') }, tabs: [null] });
    const res = await opening.openExternal('/r/a/sub');
    assert.equal(res.root, '/r/a');
    const s = tabs.get(1);
    assert.equal(s.repo.root, '/r/a');
    assert.deepEqual(calls, [['trust', '/r/a'], ['recent.add', '/r/a', 'a'], ['setRepo', 1, '/r/a'], ['menu'], ['activate', 1], ['front']]);
    assert.deepEqual(sent, [[1, 'repo-opened', { repo: res, recent: [{ root: '/r/a', name: 'a', display: '/r/a' }] }]]);
  });

  test('already open in a tab: that tab is shown, nothing asked, nothing added', async () => {
    const { opening, tabs, calls } = setup({ repos: { '/r/b': info('/r/b') }, tabs: ['/r/a', '/r/b'] });
    tabs.activate(1);
    await opening.openExternal('/r/b');
    assert.deepEqual(calls, [['activate', 2], ['front']]);
  });

  test('a failure: gone folders leave recent; shown in a dialog (interactive) or rethrown (smoke)', async () => {
    const t = setup({});
    assert.equal(await t.opening.openExternal('/r/gone'), null);
    assert.deepEqual(t.errors, [['Could not open repository', 'not-found']]);
    assert.deepEqual(t.calls, [['recent.remove', '/r/gone'], ['recentChanged']]);
    const kept = setup({ repos: { '/r/x': kindError('unsafe-repo', 'dubious') } });
    await kept.opening.openExternal('/r/x');
    assert.deepEqual(kept.calls, [], 'unsafe-repo keeps its recent entry');
    const headless = setup({ interactive: false });
    await assert.rejects(headless.opening.openExternal('/r/gone'), (e) => e.kind === 'not-found');
    assert.deepEqual(headless.errors, []);
  });

  test('the user declines to trust the config: nothing changes', async () => {
    const { opening, tabs, calls, sent } = setup({ repos: { '/r/a': info('/r/a') }, risky: ['/r/a'], trustAnswers: [false] });
    assert.equal(await opening.openExternal('/r/a'), null);
    assert.equal(tabs.get(1).repo, null);
    assert.deepEqual(calls, [['trust', '/r/a']]);
    assert.deepEqual(sent, []);
  });
});

describe('opens from a tab', () => {
  test('openShownRecent: only a root from the list main last showed; it replaces the asking tab\'s repo', async () => {
    const { opening, tabs, recentView, store } = setup({ repos: { '/r/a': info('/r/a'), '/r/b': info('/r/b') }, tabs: ['/r/b'] });
    await assert.rejects(opening.openShownRecent(tabs.get(1), '/r/a'), (e) => e.kind === 'invalid-args');
    store.add('/r/a', { name: 'a' });
    await recentView.refresh();
    await assert.rejects(opening.openShownRecent(tabs.get(1), '/r/a/'), (e) => e.kind === 'invalid-args', 'exact match only');
    const res = await opening.openShownRecent(tabs.get(1), '/r/a');
    assert.equal(res.root, '/r/a');
    assert.equal(tabs.get(1).repo.root, '/r/a');
  });

  test('newTab: a new tab right of the asking one, shown', async () => {
    const { opening, tabs, calls } = setup({ repos: { '/r/c': info('/r/c') }, tabs: ['/r/a', '/r/b'], folder: '/r/c' });
    await opening.openFromDialog(tabs.get(1), { newTab: true });
    assert.deepEqual(tabs.list().map((t) => t.repo && t.repo.root), ['/r/a', '/r/c', '/r/b']);
    assert.deepEqual(calls.filter((c) => c[0] === 'addTab' || c[0] === 'pickFolder'), [['pickFolder', true], ['addTab', 1, false]]);
  });

  test('openFromDialog cancelled: null, nothing opened', async () => {
    const { opening, tabs, calls } = setup({});
    assert.equal(await opening.openFromDialog(tabs.get(1)), null);
    assert.deepEqual(calls, [['pickFolder', false]]);
  });

  test('a newer open from the same tab wins over an older one still asking', async () => {
    const ask = deferred();
    const { opening, tabs } = setup({ repos: { '/r/slow': info('/r/slow'), '/r/fast': info('/r/fast') }, risky: ['/r/slow'], trustAnswers: [ask.promise], folder: '/r/slow' });
    const s = tabs.get(1);
    const slow = opening.openFromDialog(s);
    await new Promise((r) => setImmediate(r));
    await opening.openFromMenu(s, '/r/fast');
    ask.resolve(true);
    assert.equal(await slow, null, 'superseded');
    assert.equal(s.repo.root, '/r/fast');
  });

  test('bug fix: an external open landing in the tab supersedes an open still asking there', async () => {
    const ask = deferred();
    const { opening, tabs } = setup({ repos: { '/r/mine': info('/r/mine'), '/r/ext': info('/r/ext') }, risky: ['/r/mine'], trustAnswers: [ask.promise], folder: '/r/mine' });
    const s = tabs.get(1); // an empty active tab: an external open lands in it
    const mine = opening.openFromDialog(s);
    await new Promise((r) => setImmediate(r));
    await opening.openExternal('/r/ext');
    assert.equal(s.repo.root, '/r/ext');
    ask.resolve(true);
    assert.equal(await mine, null, 'the pending open does not replace the repo that landed meanwhile');
    assert.equal(s.repo.root, '/r/ext');
  });

  test('the asking tab closed meanwhile: null', async () => {
    const ask = deferred();
    const { opening, tabs } = setup({ repos: { '/r/a': info('/r/a') }, risky: ['/r/a'], trustAnswers: [ask.promise], folder: '/r/a' });
    const s = tabs.get(1);
    const p = opening.openFromDialog(s);
    await new Promise((r) => setImmediate(r));
    s.close();
    ask.resolve(true);
    assert.equal(await p, null);
  });
});

describe('openWorktreeOf', () => {
  const list = [
    { path: '/w/.bare', bare: true, prunable: false, missing: false },
    { path: '/w/main', bare: false, prunable: false, missing: false },
    { path: '/w/gone', bare: false, prunable: true, missing: true },
    { path: '/w/usb', bare: false, prunable: false, missing: true, locked: true },
  ];
  test('only a listed, openable worktree; it opens in a new tab next to the bare repo, which stays', async () => {
    const { opening, tabs } = setup({ repos: { '/w/main': info('/w/main') }, tabs: ['/w/.bare', null], worktrees: { '/w/.bare': list } });
    const s = tabs.get(1);
    for (const bad of ['/w/.bare', '/w/gone', '/w/usb', '/etc', '']) {
      await assert.rejects(opening.openWorktreeOf(s, bad), (e) => e.kind === 'not-found', bad);
    }
    await opening.openWorktreeOf(s, '/w/main');
    assert.deepEqual(tabs.list().map((t) => t.repo && t.repo.root), ['/w/.bare', '/w/main', null], 'not the empty tab, not the asking one');
    assert.equal(tabs.active().repo.root, '/w/main');
  });

  test('no repo: no-repo; the tab\'s repo changed while git listed: null', async () => {
    const t = setup({ tabs: [null] });
    await assert.rejects(t.opening.openWorktreeOf(t.tabs.get(1), '/w/main'), (e) => e.kind === 'no-repo');
    const later = deferred();
    const u = setup({ repos: { '/w/main': info('/w/main') }, tabs: ['/w/.bare'], worktrees: { '/w/.bare': () => later.promise } });
    const s = u.tabs.get(1);
    const p = u.opening.openWorktreeOf(s, '/w/main');
    s.setRepo(info('/r/other'));
    later.resolve(list);
    assert.equal(await p, null);
  });
});

describe('openBackgroundTab (restore, smoke extra tabs)', () => {
  test('always a new tab, never shown or brought forward', async () => {
    const { opening, tabs, calls } = setup({ repos: { '/r/a': info('/r/a') }, tabs: ['/r/a'] });
    const res = await opening.openBackgroundTab('/r/a');
    assert.equal(tabs.size, 2, 'a duplicate of an open repo included');
    assert.equal(res.session, tabs.get(2));
    assert.ok(!calls.some((c) => c[0] === 'activate' || c[0] === 'front'));
  });

  test('abort(): stops before anything changes', async () => {
    const { opening, tabs, calls } = setup({ repos: { '/r/a': info('/r/a') } });
    assert.equal(await opening.openBackgroundTab('/r/a', { abort: () => true }), null);
    assert.equal(tabs.size, 1);
    assert.deepEqual(calls, []);
  });
});

describe('openCloned (a folder main just cloned into) and rememberRecent', () => {
  test('from a start-screen tab: the clone opens in that tab', async () => {
    const { opening, tabs, calls } = setup({ repos: { '/c/new': info('/c/new') }, tabs: [null] });
    const s = tabs.get(1);
    const res = await opening.openCloned(s, '/c/new');
    assert.equal(res.info.root, '/c/new');
    assert.equal(res.session, s);
    assert.equal(s.repo.root, '/c/new');
    assert.deepEqual(calls, [['trust', '/c/new'], ['recent.add', '/c/new', 'new'], ['setRepo', 1, '/c/new'], ['menu'], ['activate', 1], ['front']]);
  });

  test('from a tab with a repo open: a new tab next to it', async () => {
    const { opening, tabs, calls } = setup({ repos: { '/c/new': info('/c/new') }, tabs: ['/r/a', '/r/b'] });
    const res = await opening.openCloned(tabs.get(1), '/c/new');
    assert.equal(tabs.get(1).repo.root, '/r/a', 'the asking tab keeps its repo');
    assert.equal(res.session.repo.root, '/c/new');
    assert.deepEqual(tabs.list().map((t) => t.repo.root), ['/r/a', '/c/new', '/r/b'], 'next to it');
    assert.ok(calls.some((c) => c[0] === 'addTab' && c[1] === 1));
  });

  test('a newer open landed in the tab meanwhile: stale (the tab is alive), and newTab: true opens it next to it', async () => {
    const gate = deferred();
    const { opening, tabs } = setup({ repos: { '/c/new': gate.promise.then(() => info('/c/new')), '/r/x': info('/r/x') }, tabs: [null] });
    const s = tabs.get(1);
    const p = opening.openCloned(s, '/c/new');
    await opening.openShownRecent(s, '/r/x').catch(() => null); // not shown: refused, nothing lands
    await opening.openExternal('/r/x'); // lands in the empty active tab
    gate.resolve();
    assert.deepEqual(await p, { info: null, reason: 'stale' });
    const again = await opening.openCloned(s, '/c/new', { newTab: true });
    assert.equal(again.info.root, '/c/new');
    assert.notEqual(again.session, s);
    assert.equal(s.repo.root, '/r/x');
  });

  test('the tab closed meanwhile: closed, no tab and no window; rememberRecent puts it in the recent list for the menu and the pages', async () => {
    const gate = deferred();
    const { opening, tabs, calls } = setup({ repos: { '/c/new': gate.promise.then(() => info('/c/new')) }, tabs: [null, '/r/a'] });
    const s = tabs.get(1);
    const p = opening.openCloned(s, '/c/new');
    s.close();
    gate.resolve();
    assert.deepEqual(await p, { info: null, reason: 'closed' });
    assert.deepEqual(calls, [], 'nothing asked, no tab added');
    await opening.rememberRecent('/c/new');
    assert.deepEqual(calls, [['recent.addAsync', '/c/new', undefined], ['recentChanged']], 'without blocking: the async add');
    const failing = setup({});
    failing.store.addAsync = async () => { throw new Error('disk full'); };
    await failing.opening.rememberRecent('/c/x'); // never rejects
    assert.deepEqual(failing.calls, [['recentChanged']]);
  });

  test('declined: Trust and Open is asked once, nothing opens', async () => {
    const { opening, tabs, calls } = setup({ repos: { '/c/new': info('/c/new') }, risky: ['/c/new'], trustAnswers: [false] });
    assert.deepEqual(await opening.openCloned(tabs.get(1), '/c/new'), { info: null, reason: 'declined' });
    assert.deepEqual(calls, [['trust', '/c/new']]);
    assert.equal(tabs.get(1).repo, null);
  });

  test('openRepo throws (dubious ownership): the error goes to the caller (the clone service reports openError)', async () => {
    const { opening, tabs } = setup({ repos: { '/c/new': kindError('unsafe-repo', 'dubious ownership') } });
    await assert.rejects(opening.openCloned(tabs.get(1), '/c/new'), { kind: 'unsafe-repo' });
  });

  test('the other use cases still resolve null for a missed open (open() wraps attempt())', async () => {
    const { opening } = setup({ repos: { '/r/a': info('/r/a') }, risky: ['/r/a'], trustAnswers: [false] });
    assert.equal(await opening.openExternal('/r/a'), null);
    assert.equal(await opening.openBackgroundTab('/r/a', { abort: () => true }), null);
  });
});
