'use strict';
// main/tabs-controller.js over fake views, window, runner and tabs.json: restoring the saved tabs,
// with tabs.json suppressed as a scoped counter and the restore stopping when its
// window goes away.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

/**
 * main/tabs-controller.js (and main/window.js, which it imports) take Electron's classes at load.
 * This test injects fakes for all of them (View, menu, the window host), so under plain Node they
 * are never used (with the package installed, require('electron') is just the binary's path), but
 * the require must still resolve: a checkout without node_modules has no `electron`. A stub with
 * nothing in it answers for it while the controller loads, and only then.
 */
function requireWithoutElectron(id) {
  const stub = new Module('electron-stub');
  stub.filename = 'electron-stub';
  stub.loaded = true;
  const resolve = Module._resolveFilename;
  require.cache[stub.filename] = stub;
  Module._resolveFilename = function resolveElectron(request, ...rest) {
    return request === 'electron' ? stub.filename : resolve.call(this, request, ...rest);
  };
  try {
    return require(id);
  } finally {
    Module._resolveFilename = resolve;
    delete require.cache[stub.filename];
  }
}
const { createTabsController } = requireWithoutElectron('../main/tabs-controller');

let nextId = 100;
function fakeContents() {
  const wc = {
    id: nextId++, destroyed: false, sent: [],
    send: (ch, p) => wc.sent.push([ch, p]),
    isDestroyed: () => wc.destroyed,
    // The page "loads" at once (session.loaded resolves).
    once: (ev, cb) => { if (ev === 'did-finish-load') queueMicrotask(cb); }, on: () => {},
    loadURL: () => Promise.resolve(),
    close: () => { wc.destroyed = true; },
    focus: () => {},
  };
  return wc;
}
class FakeView {
  constructor() { this.webContents = fakeContents(); this.visible = null; }
  setBackgroundColor() {}
  setVisible(v) { this.visible = v; }
  setBounds() {}
}

function setup({ saved = { roots: [], active: 0 } } = {}) {
  const calls = { created: 0, saves: [], titles: [], strip: [] };
  let win = null;
  const makeWin = () => ({
    destroyed: false,
    contentView: { addChildView() {}, removeChildView() {} },
    getContentSize: () => [1000, 700],
    setTitle: (title) => calls.titles.push(title),
    isFocused: () => false,
    isDestroyed() { return this.destroyed; },
    isFullScreen: () => false,
    webContents: fakeContents(),
  });
  const windowHost = {
    get: () => win,
    alive: () => !!win && !win.destroyed,
    create: () => { calls.created++; win = makeWin(); return win; },
    sendStrip: (channel, payload) => calls.strip.push([channel, payload]),
    isFullScreen: () => false,
    close: () => { win.destroyed = true; win = null; },
  };
  const store = { load: () => saved, save: (s) => { calls.saves.push(s); return true; } };
  const logs = [];
  const controller = createTabsController({
    windowHost,
    runner: { running: () => [], on() {} },
    rendererLog: { forget() {} },
    ui: { interactive: true, confirm: async () => true, focus() {} },
    isMac: false,
    indexUrl: 'file:///index.html',
    viewPrefs: {},
    createWatcher: () => ({ pause() {}, resume() {}, close() {} }),
    logWatch: () => {},
    store: () => store,
    report: () => () => {},
    log: { info: (m, f) => logs.push([m, f]), warn: (m, f) => logs.push([m, f]) },
    View: FakeView,
    menu: { buildFromTemplate: () => ({ popup() {} }) },
  });
  /** A fake openBackgroundTab: a new tab with `root` open (as src/repo-opening.js does it). */
  const open = (hook = () => {}) => async (root, { abort } = {}) => {
    await hook(root);
    if (abort && abort()) return null;
    const s = controller.addTab({ activate: false });
    controller.setRepo(s, { root, name: root.slice(1), bare: false });
    return { info: s.repo, session: s };
  };
  windowHost.create();
  calls.created = 0;
  return { controller, windowHost, calls, logs, open };
}

describe('restoreTabs', () => {
  test('reopens the saved tabs in order, shows the saved active one, saves tabs.json once at the end', async () => {
    const { controller, calls, open } = setup({ saved: { roots: ['/a', null, '/b', '/c'], active: 2 } });
    await controller.restoreTabs(open());
    assert.deepEqual(controller.tabs.list().map((t) => t.repo.root), ['/a', '/b', '/c'], 'New Tabs are not restored');
    assert.equal(controller.tabs.active().repo.root, '/b');
    assert.ok(calls.saves.length > 0);
    for (const saved of calls.saves) assert.deepEqual(saved, { roots: ['/a', '/b', '/c'], active: 1 }, 'nothing saved while placing the tabs');
  });

  test('nothing to restore: one New Tab', async () => {
    const { controller, open } = setup();
    await controller.restoreTabs(open());
    assert.equal(controller.tabs.size, 1);
    assert.equal(controller.tabs.active().repo, null);
  });

  test('bug fix: the window closing mid-restore stops it; no window comes back, tabs.json is not rewritten', async () => {
    const t = setup({ saved: { roots: ['/a', '/b', '/c'], active: 0 } });
    const opened = [];
    await t.controller.restoreTabs(t.open((root) => {
      opened.push(root);
      if (root === '/b') {
        t.controller.destroyAll(); // what the window's 'closed' does
        t.windowHost.close();
      }
    }));
    assert.deepEqual(opened, ['/a', '/b'], 'the rest is not even opened');
    assert.equal(t.calls.created, 0, 'no window was created again');
    assert.equal(t.windowHost.get(), null);
    assert.equal(t.controller.tabs.size, 0);
    assert.deepEqual(t.calls.saves, []);
    assert.equal(t.logs.at(-1)[0], 'tab restore stopped: the window closed');
  });

  test('bug fix: suppression is a counter: two overlapping restores keep tabs.json quiet until both end', async () => {
    const t = setup({ saved: { roots: ['/a'], active: 0 } });
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = t.controller.restoreTabs(t.open(() => gate));
    const fast = t.controller.restoreTabs(t.open());
    await fast;
    t.controller.activateTab(t.controller.tabs.list()[0].id); // a change while the slow one still places tabs
    assert.deepEqual(t.calls.saves, [], 'still suppressed by the slow restore');
    release();
    await slow;
    assert.ok(t.calls.saves.length > 0);
    assert.deepEqual(t.calls.saves.at(-1).roots, ['/a', '/a']);
  });

  test('suppressPersist: release is idempotent; a change after the last release saves', () => {
    const t = setup();
    t.controller.addTab();
    const n = t.calls.saves.length;
    const r1 = t.controller.suppressPersist();
    const r2 = t.controller.suppressPersist();
    t.controller.addTab();
    r1();
    r1();
    t.controller.addTab();
    assert.equal(t.calls.saves.length, n, 'one hold is left');
    r2();
    t.controller.addTab();
    assert.equal(t.calls.saves.length, n + 1);
  });
});

describe('titles', () => {
  test('a linked worktree\'s tab: the strip gets its "project · folder" title and the tree icon flag, the window title the same', () => {
    const { controller, calls } = setup();
    const a = controller.addTab();
    controller.setRepo(a, { root: '/src/monorepo', name: 'monorepo', bare: false, linkedWorktree: null });
    const b = controller.addTab();
    controller.setRepo(b, {
      root: '/src/monorepo-feat', name: 'monorepo-feat', bare: false,
      linkedWorktree: { mainPath: '/src/monorepo', mainName: 'monorepo', title: 'monorepo · monorepo-feat' },
    });
    assert.equal(calls.titles.at(-1), 'monorepo · monorepo-feat — Pasta Lite Git client');
    const [channel, payload] = calls.strip.at(-1);
    assert.equal(channel, 'tabs-changed');
    assert.deepEqual(payload.tabs.map((t) => [t.title, t.linked]), [['monorepo', false], ['monorepo · monorepo-feat', true]]);
    assert.match(payload.tabs[1].tooltip, /\nLinked worktree of /);
    controller.activateTab(a.id);
    assert.equal(calls.titles.at(-1), 'monorepo — Pasta Lite Git client', 'the main worktree\'s tab keeps its title');
    const pages = b.webContents.sent.filter(([ch]) => ch === 'tabs-changed');
    assert.deepEqual(pages.at(-1)[1].tabs.map((t) => t.linked), [false, true], 'the pages get the flag too');
  });
});

describe('commandToActive (File > Clone Repository…)', () => {
  test('sent to the active tab\'s page once it has loaded', async () => {
    const { controller } = setup();
    const a = controller.addTab();
    controller.addTab({ activate: false });
    const s = await controller.commandToActive('clone');
    assert.equal(s, a);
    assert.deepEqual(a.webContents.sent.filter(([ch]) => ch === 'menu-command'), [['menu-command', { id: 'clone' }]]);
  });

  test('no tab (macOS, no window): a New Tab, and its window, take it', async () => {
    const { controller, windowHost, calls } = setup();
    windowHost.close();
    assert.equal(controller.tabs.size, 0);
    const s = await controller.commandToActive('clone');
    assert.equal(calls.created, 1, 'the window the user just asked for');
    assert.equal(controller.tabs.size, 1);
    assert.deepEqual(s.webContents.sent.filter(([ch]) => ch === 'menu-command'), [['menu-command', { id: 'clone' }]]);
  });

  test('a tab closed before its page loaded gets nothing', async () => {
    const { controller } = setup();
    const a = controller.addTab();
    const p = controller.commandToActive('clone');
    a.close();
    await p;
    assert.deepEqual(a.webContents.sent.filter(([ch]) => ch === 'menu-command'), []);
  });
});
