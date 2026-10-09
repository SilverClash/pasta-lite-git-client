'use strict';
// Repository tabs: the pure parts in src/tabs.js (registry and ordering, where an open
// goes, titles, owner-scoped ops), tabs.json (src/tabs-store.js) and the close guard
// (src/quit-guard.js). The sender routing is test/ipc-contract.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const t = require('../src/tabs');
const ts = require('../src/tabs-store');
const { ownedOpId } = require('../src/ipc-contract');
const ops = require('../src/ops');
const { createCloseGuard, createQuitGuard, dialogOptions } = require('../src/quit-guard');

const repo = (root) => ({ root, name: path.basename(root), head: 'main' });
/** A registry with tabs {id, repo} from `roots` (null: New Tab); ids 1, 2, 3... */
function registry(roots) {
  const r = t.createTabRegistry();
  roots.forEach((root, i) => r.add({ id: i + 1, repo: root ? repo(root) : null }));
  return r;
}
const ids = (r) => r.list().map((x) => x.id);

describe('registry', () => {
  test('add: at the end or at an index (clamped); the first tab is active; ids are unique', () => {
    const r = t.createTabRegistry();
    assert.equal(r.active(), null);
    r.add({ id: 1, repo: null });
    assert.equal(r.activeId, 1);
    r.add({ id: 2, repo: null });
    r.add({ id: 3, repo: null }, { index: 1 });
    r.add({ id: 4, repo: null }, { index: 99 });
    assert.deepEqual(ids(r), [1, 3, 2, 4]);
    assert.equal(r.activeId, 1);
    assert.throws(() => r.add({ id: 2 }), /new id/);
  });

  test('remove: the active tab hands over to its right neighbour, else its left; the last leaves none', () => {
    const r = registry([null, null, null]);
    r.activate(2);
    assert.equal(r.remove(2), 3); // right neighbour
    r.activate(3);
    assert.equal(r.remove(3), 1); // no right: left
    assert.equal(r.remove(99), undefined);
    r.add({ id: 5, repo: null });
    assert.equal(r.remove(5), 1); // a background tab: active unchanged
    assert.equal(r.remove(1), null);
    assert.equal(r.size, 0);
  });

  test('move (drag reorder), neighbour (wrapping) and Select Tab 1–9 (9 = last)', () => {
    const r = registry([null, null, null, null]);
    assert.equal(r.move(1, 2), true);
    assert.deepEqual(ids(r), [2, 3, 1, 4]);
    assert.equal(r.move(1, 2), false); // already there
    assert.equal(r.move(4, -5), true); // clamped
    assert.deepEqual(ids(r), [4, 2, 3, 1]);
    assert.equal(r.move(4, 1.5), false);
    assert.equal(r.move(99, 0), false);
    r.activate(4);
    assert.equal(r.neighbour(1), 2);
    assert.equal(r.neighbour(-1), 1); // wraps to the last
    r.activate(1);
    assert.equal(r.neighbour(1), 4); // wraps to the first
    assert.equal(r.atShortcut(1), 4);
    assert.equal(r.atShortcut(4), 1);
    assert.equal(r.atShortcut(5), null);
    assert.equal(r.atShortcut(9), 1);
    assert.equal(r.atShortcut(0), null);
    assert.equal(t.createTabRegistry().neighbour(1), null);
  });

  test('Close Others / Close to the Right and findByRoot', () => {
    const r = registry(['/a', '/b', null, '/b']);
    assert.deepEqual(r.othersOf(2), [1, 3, 4]);
    assert.deepEqual(r.rightOf(2), [3, 4]);
    assert.deepEqual(r.rightOf(4), []);
    assert.deepEqual(r.othersOf(99), []);
    assert.equal(r.findByRoot('/b').id, 2);
    assert.equal(r.findByRoot('/b', 2).id, 4);
    assert.equal(r.findByRoot('/c'), null);
  });
});

describe('pickOpenTarget (already open → show that tab)', () => {
  test('from a tab: its own repo reopens there; open in another tab → focus it; else replace', () => {
    const r = registry(['/a', '/b', null]);
    assert.deepEqual(t.pickOpenTarget(r, { root: '/a', fromId: 1 }), { action: 'replace', id: 1 });
    assert.deepEqual(t.pickOpenTarget(r, { root: '/b', fromId: 1 }), { action: 'focus', id: 2 });
    assert.deepEqual(t.pickOpenTarget(r, { root: '/b', fromId: 3 }), { action: 'focus', id: 2 });
    assert.deepEqual(t.pickOpenTarget(r, { root: '/c', fromId: 1 }), { action: 'replace', id: 1 });
  });

  test('newTab: always a new tab, a duplicate of an open repo included', () => {
    const r = registry(['/a']);
    assert.deepEqual(t.pickOpenTarget(r, { root: '/a', fromId: 1, newTab: true }), { action: 'new' });
    assert.deepEqual(t.pickOpenTarget(r, { root: '/a', newTab: true }), { action: 'new' });
  });

  test('external (CLI, dock): focus an open one; use an empty active tab; else a new tab', () => {
    const r = registry(['/a', null]);
    assert.deepEqual(t.pickOpenTarget(r, { root: '/a' }), { action: 'focus', id: 1 });
    assert.deepEqual(t.pickOpenTarget(r, { root: '/c' }), { action: 'new' }); // active is /a
    r.activate(2);
    assert.deepEqual(t.pickOpenTarget(r, { root: '/c' }), { action: 'replace', id: 2 });
    assert.deepEqual(t.pickOpenTarget(t.createTabRegistry(), { root: '/c' }), { action: 'new' });
    // An asking tab that is gone counts as external.
    assert.deepEqual(t.pickOpenTarget(r, { root: '/c', fromId: 99 }), { action: 'replace', id: 2 });
  });

  test('preferExisting (Open worktree): the tab that has it, else a new tab; never replaces the asking tab', () => {
    const r = registry(['/bare', '/w/main', null]);
    assert.deepEqual(t.pickOpenTarget(r, { root: '/w/main', fromId: 1, preferExisting: true }), { action: 'focus', id: 2 });
    assert.deepEqual(t.pickOpenTarget(r, { root: '/w/other', fromId: 1, preferExisting: true }), { action: 'new' });
    // Not even an empty active tab: the bare repo's own tab asked, and a new tab sits next to it.
    r.activate(3);
    assert.deepEqual(t.pickOpenTarget(r, { root: '/w/other', fromId: 1, preferExisting: true }), { action: 'new' });
    // The asking tab itself counts (it would be shown, not reopened), and it wins over newTab.
    assert.deepEqual(t.pickOpenTarget(r, { root: '/bare', fromId: 1, preferExisting: true }), { action: 'focus', id: 1 });
    assert.deepEqual(t.pickOpenTarget(r, { root: '/w/main', fromId: 1, newTab: true, preferExisting: true }), { action: 'focus', id: 2 });
  });
});

describe('titles and the tabs-changed payload', () => {
  test('title = the repo name or New Tab; tooltip = the path with ~ for home (path boundary only)', () => {
    assert.equal(t.tabTitle(repo('/x/proj')), 'proj');
    assert.equal(t.tabTitle({ root: '/x/proj' }), 'proj');
    assert.equal(t.tabTitle(null), 'New Tab');
    assert.equal(t._internal.tabTooltip(repo('/Users/me/src/proj'), { home: '/Users/me', platform: 'darwin' }), '~/src/proj');
    assert.equal(t._internal.tabTooltip(repo('/Users/me/src/proj'), { home: '/Users/me/', platform: 'darwin' }), '~/src/proj');
    assert.equal(t._internal.tabTooltip(repo('/Users/meow/proj'), { home: '/Users/me', platform: 'darwin' }), '/Users/meow/proj');
    assert.equal(t._internal.tabTooltip(null, { home: '/Users/me' }), 'New Tab');
  });

  test('tooltip on Windows: the home folder matches in any case, at a path boundary only', () => {
    assert.equal(t._internal.tabTooltip(repo('c:\\users\\me\\src\\proj'), { home: 'C:\\Users\\Me', platform: 'win32' }), '~\\src\\proj');
    assert.equal(t._internal.tabTooltip(repo('C:\\Users\\Me'), { home: 'c:\\users\\me', platform: 'win32' }), '~');
    assert.equal(t._internal.tabTooltip(repo('C:\\Users\\Meow\\proj'), { home: 'C:\\Users\\Me', platform: 'win32' }), 'C:\\Users\\Meow\\proj');
    assert.equal(t._internal.tabTooltip(repo('/Users/Me/proj'), { home: '/Users/me', platform: 'darwin' }), '/Users/Me/proj', 'case matters off Windows');
  });

  test('pageTabs: {id, title, root, active, linked}; stripTabs: plus tooltip and busy', () => {
    const r = registry(['/h/a', null]);
    r.activate(2);
    assert.deepEqual(t.pageTabs(r), [
      { id: 1, title: 'a', root: '/h/a', active: false, linked: false },
      { id: 2, title: 'New Tab', root: null, active: true, linked: false },
    ]);
    assert.deepEqual(t.stripTabs(r, { home: '/h', busy: (x) => x.id === 1 }), [
      { id: 1, title: 'a', root: '/h/a', active: false, linked: false, tooltip: '~/a', busy: true },
      { id: 2, title: 'New Tab', root: null, active: true, linked: false, tooltip: 'New Tab', busy: false },
    ]);
  });

  test('a linked worktree (repo.linkedWorktree, from main): title "project · folder", linked, tooltip names the main worktree', () => {
    const lw = { mainPath: '/h/src/monorepo', mainName: 'monorepo', title: 'monorepo · monorepo-feat' };
    const linked = { ...repo('/h/src/monorepo-feat'), linkedWorktree: lw };
    assert.equal(t.tabTitle(linked), 'monorepo · monorepo-feat');
    assert.equal(t._internal.isLinked(linked), true);
    assert.equal(t._internal.tabTooltip(linked, { home: '/h', platform: 'darwin' }), '~/src/monorepo-feat\nLinked worktree of ~/src/monorepo');
    // The main worktree, a plain repo or bare repo (linkedWorktree null or absent) keep their title.
    const mainWt = { ...repo('/h/src/monorepo'), linkedWorktree: null };
    assert.deepEqual([t.tabTitle(mainWt), t._internal.isLinked(mainWt), t._internal.tabTooltip(mainWt, { home: '/h', platform: 'darwin' })], ['monorepo', false, '~/src/monorepo']);
    assert.equal(t._internal.isLinked(null), false);
    const r = t.createTabRegistry();
    r.add({ id: 1, repo: mainWt });
    r.add({ id: 2, repo: linked });
    r.add({ id: 3, repo: null });
    assert.deepEqual(t.stripTabs(r, { home: '/h' }).map((x) => [x.title, x.linked, x.tooltip]), [
      ['monorepo', false, '~/src/monorepo'],
      ['monorepo · monorepo-feat', true, '~/src/monorepo-feat\nLinked worktree of ~/src/monorepo'],
      ['New Tab', false, 'New Tab'],
    ], 'other tabs\' titles are unchanged');
  });
});

describe('the strip page (renderer/tabs.js)', () => {
  /** renderer/tabs.js on the fake DOM with a fake window.tabsApi; returns {apply(state), tabEl(id)}. */
  function loadStrip() {
    const H = require('./renderer-harness');
    const dom = H.componentDom();
    const tablist = dom.doc.createElement('div');
    const newTab = dom.doc.createElement('button');
    dom.doc.body.append(tablist, newTab);
    dom.doc.getElementById = (id) => ({ tablist, 'new-tab': newTab }[id] || null);
    let listener = null;
    const prev = { window: globalThis.window, document: globalThis.document };
    globalThis.window = {
      PLIcons: require('../renderer/icons.js'), // tabs.html loads icons.js first
      tabsApi: {
        isMac: true, list: () => new Promise(() => {}), subscribe: (cb) => { listener = cb; return () => {}; },
        activate: async () => {}, close: async () => {}, newTab: async () => {}, move: async () => {}, menu: async () => {}, log() {},
      },
    };
    Object.defineProperty(globalThis, 'document', { value: dom.doc, configurable: true, writable: true });
    const file = require.resolve('../renderer/tabs.js');
    delete require.cache[file];
    require(file);
    const restore = () => {
      globalThis.window = prev.window;
      Object.defineProperty(globalThis, 'document', { value: prev.document, configurable: true, writable: true });
    };
    return { apply: (state) => listener(state), tabEl: (id) => tablist.children.find((c) => c.dataset.id === String(id)), restore };
  }
  const tab = (o) => ({ root: '/r', active: false, linked: false, tooltip: '', busy: false, ...o });

  test('a linked-worktree tab shows the tree icon and main\'s "project · folder" title; the others keep the branch icon', (tc) => {
    const strip = loadStrip();
    tc.after(strip.restore);
    strip.apply({ tabs: [
      tab({ id: 1, title: 'monorepo', active: true }),
      tab({ id: 2, title: 'monorepo · monorepo-feat', linked: true, tooltip: '~/monorepo-feat\nLinked worktree of ~/monorepo' }),
    ] });
    const [a, b] = [strip.tabEl(1), strip.tabEl(2)];
    assert.deepEqual([a.firstChild.dataset.icon, a.querySelector('.tab-title').textContent], ['branch', 'monorepo']);
    assert.deepEqual([b.firstChild.dataset.icon, b.querySelector('.tab-title').textContent], ['worktree', 'monorepo · monorepo-feat']);
    assert.equal(b.title, '~/monorepo-feat\nLinked worktree of ~/monorepo');
    assert.match(b.firstChild.getAttribute('class'), /\bicon-worktree\b.*\btab-icon\b/, 'icons.js\'s tree, styled as a tab icon');
    // The tab switches to the main worktree: the icon goes back, in place (still the first child).
    strip.apply({ tabs: [tab({ id: 1, title: 'monorepo', active: true }), tab({ id: 2, title: 'monorepo' })] });
    assert.equal(strip.tabEl(2), b, 'the element is kept');
    assert.equal(b.firstChild.dataset.icon, 'branch');
    assert.equal(b.children.filter((c) => c.dataset.icon).length, 1, 'one icon');
  });
});

describe('tabs.json', () => {
  test('round trip: roots in order (New Tab as null) and the active index; unchanged content is not rewritten', () => {
    const file = path.join(h.tmpDir(), 'sub', 'tabs.json');
    const store = ts.createTabsStore(file);
    assert.deepEqual(store.load(), { roots: [], active: 0 }); // missing
    const r = registry(['/a', null, '/b']);
    r.activate(3);
    assert.deepEqual(ts.snapshot(r), { roots: ['/a', null, '/b'], active: 2 });
    assert.equal(store.save(ts.snapshot(r)), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, tabs: [{ root: '/a' }, { root: null }, { root: '/b' }], active: 2 });
    assert.equal(store.save(ts.snapshot(r)), false); // same content
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['tabs.json']); // tmp + rename, nothing left
    const again = ts.createTabsStore(file);
    assert.deepEqual(again.load(), { roots: ['/a', null, '/b'], active: 2 });
    assert.equal(again.save({ roots: ['/a', null, '/b'], active: 2 }), false);
  });

  test('corrupt or odd content: no tabs, or bad entries become null and the active index is clamped', () => {
    const dir = h.tmpDir();
    const file = path.join(dir, 'tabs.json');
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(ts.createTabsStore(file).load(), { roots: [], active: 0 });
    fs.writeFileSync(file, JSON.stringify({ tabs: [{ root: 'relative' }, 7, { root: '/ok' }], active: 12 }));
    assert.deepEqual(ts.createTabsStore(file).load(), { roots: [null, null, '/ok'], active: 2 });
    fs.writeFileSync(file, JSON.stringify({ tabs: 'x', active: 'y' }));
    assert.deepEqual(ts.createTabsStore(file).load(), { roots: [], active: 0 });
  });

  test('restoreActive: the saved active tab if it came back, else the nearest before it, else the first', () => {
    assert.equal(ts.restoreActive(2, [0, 2, 3]), 1);
    assert.equal(ts.restoreActive(2, [0, 1, 3]), 1); // gone: the one before
    assert.equal(ts.restoreActive(0, [1, 2]), 0); // nothing before: the first
    assert.equal(ts.restoreActive(5, [0, 1]), 1);
    assert.equal(ts.restoreActive(0, []), -1);
  });
});

// A deferred promise for gating fake ops.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe('ops across tabs: close guard and quit guard', () => {
  const setup = () => {
    const gates = { push: deferred(), fetch: deferred(), status: deferred() };
    const fakeOps = {
      push: (_r, signal) => new Promise((resolve, reject) => {
        gates.push.promise.then(resolve);
        if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { kind: 'aborted' })));
      }),
      fetch: () => gates.fetch.promise,
      status: () => gates.status.promise,
    };
    // Plain ops get no signal argument; cancelling is checked through running() rows.
    const runner = ops.createRunner({ ops: fakeOps, writeOps: new Set(['push', 'fetch']) });
    return { runner, gates };
  };

  test('closing a tab asks only about its own writes; Keep Running keeps them; Cancel and Close cancels only them', async () => {
    const { runner, gates } = setup();
    const p1 = runner.run('/a', 'push', [], { owner: 1, opId: ownedOpId(1, 'x') }).catch((e) => e);
    const p2 = runner.run('/b', 'fetch', [], { owner: 2 });
    const p3 = runner.run('/a', 'status', [], { owner: 3 });
    await new Promise((r) => setImmediate(r));
    const asked = [];
    const answers = [false, true];
    const guard1 = createCloseGuard({ runner: t.ownerView(runner, 1), confirm: async (k, n) => { asked.push([k, n]); return answers.shift(); } });
    assert.equal(guard1.needsConfirm(), true);
    assert.equal(await guard1.run(), 'stay');
    assert.equal(runner.running({ owner: 1 })[0].cancelled, false);
    assert.equal(await guard1.run(), 'close');
    assert.deepEqual(asked, [['close', 'push'], ['close', 'push']]);
    assert.equal(runner.running({ owner: 1 }).every((r) => r.cancelled), true);
    assert.equal(runner.running({ owner: 2 }).some((r) => r.cancelled), false); // tab 2's fetch untouched
    // Tab 3 has only a read: no question, the read is cancelled.
    const guard3 = createCloseGuard({ runner: t.ownerView(runner, 3), confirm: async () => assert.fail('asked') });
    assert.equal(guard3.needsConfirm(), false);
    assert.equal(await guard3.run(), 'close');
    assert.equal(runner.running({ owner: 3 })[0].cancelled, true);
    // Quitting sees the writes of every tab.
    const quit = createQuitGuard({ runner, killChildren: () => 0, confirm: async () => false });
    assert.equal(quit.needsConfirm(), true);
    assert.equal(await quit.run(), 'stay');
    gates.push.resolve('pushed');
    gates.fetch.resolve('fetched');
    gates.status.resolve('ok');
    await Promise.all([p1, p2, p3]);
    assert.equal(quit.needsConfirm(), false);
  });

  test('smoke: closing a busy tab never asks; the close dialog wording', async () => {
    const { runner, gates } = setup();
    const p = runner.run('/a', 'fetch', [], { owner: 1 });
    await new Promise((r) => setImmediate(r));
    const logged = [];
    const g = createCloseGuard({ runner: t.ownerView(runner, 1), confirm: async () => assert.fail('asked'), smoke: true, log: (m) => logged.push(m) });
    assert.equal(await g.run(), 'close');
    assert.match(logged[0], /cancelling running git operations \(fetch\)/);
    gates.fetch.resolve();
    await p.catch(() => {});
    await t.ownerView(runner, 1).settled();
    const d = dialogOptions('close', 'push');
    assert.match(d.message, /still running in this tab \(push\)/);
    assert.deepEqual(d.buttons, ['Cancel and Close', 'Keep Running']);
    assert.equal(d.defaultId, 1);
    assert.equal(d.cancelId, 1);
  });
});
