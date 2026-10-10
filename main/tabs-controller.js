'use strict';
// The window's repository tabs. Each tab is a WebContentsView showing
// renderer/index.html below the strip, with a session (src/tab-session.js: the repo open in it,
// its openSeq, its file watcher) and its ops (tagged with the tab's id). Only the active tab's
// view is visible; the others stay alive (switching is instant) with their watchers paused. The
// pure parts are src/tabs.js (registry, where an open goes, titles) and src/tabs-store.js
// (tabs.json).
const os = require('node:os');
const { WebContentsView, Menu } = require('electron');
const tabsLib = require('../src/tabs');
const { snapshot, restoreActive } = require('../src/tabs-store');
const { createTabSession } = require('../src/tab-session');
const { createCloseGuard, confirmWith } = require('../src/quit-guard');
const { EVENTS } = require('../src/ipc-contract');
const { APP_NAME, STRIP_H, BG } = require('./window');

/**
 * @param {{
 *   windowHost: ReturnType<typeof import('./window').createWindowHost>,
 *   runner: object, rendererLog: {forget(id: number): void},
 *   ui: {interactive: boolean, confirm(o: object): Promise<boolean>, focus(t: {focus(): void}): void},
 *   isMac: boolean, indexUrl: string, viewPrefs: object,
 *   createWatcher: (root: string, o: object) => object, logWatch: (message: string, err: unknown) => void,
 *   store: () => ({save(state: object): boolean, load(): {roots: (string|null)[], active: number}} | null),
 *   report: (title?: string) => (err: unknown) => void,
 *   log: {info: Function, warn: Function},
 *   privateOps?: Set<string>, onTabClosed?: (session: object) => void,
 *   View?: typeof WebContentsView, menu?: typeof Menu,
 * }} o  store: tabs.json (created at start). privateOps: ops whose runner events no page gets (the
 *   app ops: their `repo` is a folder main keeps from the pages). onTabClosed: a tab's session
 *   closed (the clone service forgets it). View / menu: Electron's (tests pass fakes).
 */
function createTabsController({
  windowHost, runner, rendererLog, ui, isMac, indexUrl, viewPrefs, createWatcher, logWatch, store, report, log,
  privateOps = new Set(), onTabClosed = () => {}, View = WebContentsView, menu = Menu,
}) {
  const tabs = tabsLib.createTabRegistry(); // one session per tab, in strip order
  const win = () => windowHost.get();
  const alive = () => windowHost.alive();

  // tabs.json is not written while this is above 0: while restoreTabs places the saved tabs (it
  // saves once at the end) and while the window closes (its tabs close, but tabs.json keeps them).
  let quiet = 0;
  /** Hold persistence off until the returned release() (idempotent) is called. */
  function suppressPersist() {
    quiet++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      quiet--;
    };
  }

  /** To every tab's page. */
  function broadcast(channel, payload) {
    for (const s of tabs.list()) s.send(channel, payload);
  }

  /** A write of tab `s` is queued or running (the strip shows it). */
  const tabBusy = (s) => runner.running({ owner: s.id }).some((r) => r.write);
  const pageTabs = () => tabsLib.pageTabs(tabs);
  /** The strip's 'tabs-changed' payload: the tabs, and fullscreen (macOS: no traffic lights to leave room for). */
  const stripState = () => ({ tabs: tabsLib.stripTabs(tabs, { home: os.homedir(), busy: tabBusy }), fullscreen: windowHost.isFullScreen() });
  const updateStrip = () => windowHost.sendStrip(EVENTS.TABS_CHANGED, stripState());

  /** Save the open tabs (tabs.json), unless suppressed. */
  function persistTabs() {
    const s = store();
    if (!s || quiet > 0) return;
    try {
      s.save(snapshot(tabs));
    } catch (err) {
      log.warn('could not save the open tabs', { err });
    }
  }

  /**
   * The tabs, their order, titles or the active one changed: tell every page ('tabs-changed'
   * {tabs: [{id, title, root, active, linked}]}) and the strip (with tooltips and busy), retitle the
   * window (src/tabs.js tabTitle: a linked worktree's 'project · folder', as its tab) and save tabs.json.
   */
  function tabsChanged() {
    if (!alive()) return;
    broadcast(EVENTS.TABS_CHANGED, { tabs: pageTabs() });
    updateStrip();
    const a = tabs.active();
    win().setTitle(a && a.repo ? `${tabsLib.tabTitle(a.repo)} — ${APP_NAME}` : APP_NAME);
    persistTabs();
  }

  /** Position every tab view below the strip, over the rest of the window. */
  function layout() {
    if (!alive()) return;
    const [width, height] = win().getContentSize();
    const bounds = { x: 0, y: STRIP_H, width, height: Math.max(0, height - STRIP_H) };
    for (const s of tabs.list()) s.view.setBounds(bounds);
  }

  /**
   * Ctrl+Tab / Ctrl+Shift+Tab on macOS, from any of our pages: the menu shows ⌘⇧] / ⌘⇧[ there (a
   * menu can't take Ctrl+Tab), so this is the only handler for them. Elsewhere the Window menu's
   * own Ctrl+Tab accelerators do it.
   */
  function addTabKeys(contents) {
    if (!isMac) return;
    contents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Tab' || !input.control || input.meta || input.alt) return;
      e.preventDefault();
      cycleTab(input.shift ? -1 : 1);
    });
  }

  /** A tab: its view (renderer/index.html) and its session. The tab id is the view's webContents id. */
  function createSession() {
    const view = new View({ webPreferences: viewPrefs });
    view.setBackgroundColor(BG);
    const wc = view.webContents;
    const s = createTabSession({
      id: wc.id,
      send: (channel, payload) => { if (!wc.isDestroyed()) wc.send(channel, payload); },
      createWatcher: (root, o) => createWatcher(root, { ...o, log: logWatch }),
      runnerRunning: () => runner.running(),
      // The page still gets the 'gone' event; the tab now shows the start screen.
      onGone: () => tabsChanged(),
      log: logWatch,
    });
    Object.assign(s, { view, webContents: wc, loaded: new Promise((resolve) => wc.once('did-finish-load', resolve)) });
    addTabKeys(wc);
    wc.loadURL(indexUrl).catch(report('Could not load the tab'));
    return s;
  }

  /** Set the repo open in tab `s` (null: none, the page shows the start screen). */
  function setRepo(s, info) {
    if (s.setRepo(info)) tabsChanged();
  }

  /**
   * Show tab `id`: the previous one is hidden and its watcher paused; this one's watcher resumes
   * (emitting what changed meanwhile) and is retried if it had gone away. `focus`: give its page the
   * keyboard focus (its window 'focus' event refreshes the repo), unless the strip keeps it.
   */
  function activateTab(id, { focus = true } = {}) {
    const next = tabs.get(id);
    if (!next) return false;
    const prev = tabs.active();
    tabs.activate(id);
    if (prev && prev !== next) {
      prev.view.setVisible(false);
      prev.watch.pause();
    }
    next.view.setVisible(true);
    next.watch.resume();
    next.watch.retry();
    if (focus && alive() && win().isFocused()) ui.focus(next.webContents);
    tabsChanged();
    return true;
  }

  /**
   * A new tab at `index` (default: the end), empty (New Tab) until a repo is opened in it. It is
   * shown unless activate is false (the first tab is always shown). Creates the window if needed.
   */
  function addTab({ index, activate = true } = {}) {
    if (!alive()) windowHost.create();
    const s = createSession();
    s.view.setVisible(false);
    win().contentView.addChildView(s.view);
    tabs.add(s, { index });
    layout();
    log.info('tab opened', { tab: s.id, tabs: tabs.size });
    if (activate || tabs.activeId === s.id) activateTab(s.id);
    else tabsChanged();
    return s;
  }

  /** Next / Previous Tab (wrapping). */
  function cycleTab(delta) {
    const id = tabs.neighbour(delta);
    if (id !== null && id !== tabs.activeId) activateTab(id);
  }

  /** Select Tab n (⌘1–⌘8; ⌘9 is the last tab). */
  function selectTab(n) {
    const id = tabs.atShortcut(n);
    if (id !== null) activateTab(id);
  }

  /** Drag reorder: move tab `id` to `toIndex`. */
  function moveTab(id, toIndex) {
    if (tabs.move(id, toIndex)) tabsChanged();
    else updateStrip(); // the strip may show a drop that changed nothing
  }

  /**
   * Drop tab `s`: its opens are cancelled, its watcher closed, its view removed and its page
   * closed. Unless quiet (the window is closing), the tab that takes its place is shown.
   */
  function destroySession(s, { quiet: silent = false } = {}) {
    const wasActive = tabs.activeId === s.id;
    const next = tabs.remove(s.id);
    s.close();
    try {
      onTabClosed(s);
    } catch (err) {
      log.warn('a tab-closed listener failed', { err });
    }
    if (alive()) win().contentView.removeChildView(s.view);
    rendererLog.forget(s.id); // reports what its rate limit dropped
    if (!s.webContents.isDestroyed()) s.webContents.close();
    if (silent) return;
    if (wasActive && next !== null && next !== undefined) activateTab(next);
    else tabsChanged();
  }

  /** No window, no tabs: every tab closes quietly (tabs.json still has them for the next window). */
  function destroyAll() {
    for (const s of tabs.list()) destroySession(s, { quiet: true });
  }

  /**
   * Close tab `id`. A write of that tab queued or running asks first, as quitting does
   * (createCloseGuard; the tab is shown while it asks). Closing the last tab leaves a New Tab.
   * Resolves true when the tab was closed.
   */
  async function closeTab(id) {
    const s = tabs.get(id);
    if (!s || s.closing) return false; // its close guard is asking already
    const guard = createCloseGuard({
      runner: tabsLib.ownerView(runner, s.id),
      confirm: confirmWith(ui.confirm),
      smoke: !ui.interactive,
      log: (message) => log.info(message),
    });
    if (guard.needsConfirm() && tabs.activeId !== s.id) activateTab(s.id);
    if (!s.beginClose()) return false;
    let decision;
    try {
      decision = await guard.run();
    } finally {
      s.endClose();
    }
    if (decision !== 'close' || s.closed) return false;
    destroySession(s);
    log.info('tab closed', { tab: id, tabs: tabs.size });
    if (!tabs.size) addTab(); // the last tab: a New Tab takes its place (the window stays)
    return true;
  }

  /** Close several tabs, one at a time (each may ask). */
  async function closeTabs(ids) {
    for (const id of ids) await closeTab(id);
  }

  /** The strip's context menu for tab `id`. */
  function showTabMenu(id) {
    if (!tabs.get(id) || !alive()) return false;
    const others = tabs.othersOf(id);
    const right = tabs.rightOf(id);
    menu.buildFromTemplate([
      { label: 'Close Tab', click: () => { closeTab(id).catch(report()); } },
      { label: 'Close Other Tabs', enabled: others.length > 0, click: () => { closeTabs(others).catch(report()); } },
      { label: 'Close Tabs to the Right', enabled: right.length > 0, click: () => { closeTabs(right).catch(report()); } },
    ]).popup({ window: win() });
    return true;
  }

  /**
   * A menu command for the active tab's page ('menu-command' {id}): a New Tab when there is none
   * (macOS with no window: addTab creates the window, which the user just asked for), sent once
   * its page has loaded. Resolves the tab it went to.
   */
  async function commandToActive(id) {
    const s = tabs.active() || addTab();
    await s.loaded;
    if (!s.closed) s.send(EVENTS.MENU_COMMAND, { id });
    return s;
  }

  /** Bring the window forward after an open (ui.focus: never in smoke runs, whose window stays hidden). */
  function bringToFront() {
    if (!alive()) return;
    if (win().isMinimized()) win().restore();
    ui.focus(win());
  }

  /**
   * Reopen the tabs saved in tabs.json, in order, in the background (`openBackgroundTab`, src/
   * repo-opening.js), then show the one that was active. A root that is gone or no longer a repo
   * is skipped (and dropped from recent, as a failed recent open is); New Tabs are not restored.
   * With nothing to restore, one New Tab. If the window closes meanwhile the restore stops there:
   * it never brings a window back, and tabs.json keeps what it had.
   */
  async function restoreTabs(openBackgroundTab) {
    const w = win();
    const gone = () => !w || w.isDestroyed() || win() !== w;
    const saved = store().load();
    const opened = []; // saved indexes that became tabs
    const placed = []; // their sessions
    const release = suppressPersist();
    try {
      for (const [i, root] of saved.roots.entries()) {
        if (gone()) break;
        if (!root) continue;
        try {
          const res = await openBackgroundTab(root, { abort: gone });
          if (res) {
            opened.push(i);
            placed.push(res.session);
          }
        } catch (err) {
          log.warn('could not restore a tab', { err });
        }
      }
    } finally {
      release();
    }
    if (gone()) {
      log.info('tab restore stopped: the window closed', { saved: saved.roots.length, restored: opened.length });
      return;
    }
    const k = restoreActive(saved.active, opened);
    if (k >= 0 && !placed[k].closed) activateTab(placed[k].id);
    if (!tabs.size) addTab();
    log.info('tabs restored', { saved: saved.roots.length, restored: opened.length });
    persistTabs();
  }

  /**
   * Runner events go to every tab: a write on a repo can still be finishing after its tab switched
   * repos or closed, the same repo may be open in two tabs, and each page tracks busy per repo (it
   * filters by e.repo itself). Our own writes pause the watchers ('busy' is emitted synchronously
   * before the write touches anything); the 'changed' refresh covers what they did. The strip
   * shows which tabs are busy, once the op has settled (a turn later: it is still listed while
   * 'busy' is emitted).
   */
  function forwardRunnerEvents() {
    // Not the private ops' (clone): their `repo` is the target's absolute path, and no page needs
    // it (the watchers below ignore a repo they don't hold; the strip asks runner.running()).
    for (const channel of [EVENTS.CHANGED, EVENTS.BUSY]) runner.on(channel, (e) => { if (!privateOps.has(e.op)) broadcast(channel, e); });
    runner.on(EVENTS.BUSY, (e) => {
      for (const s of tabs.list()) s.watch.busy(e);
      setTimeout(updateStrip, 0);
    });
  }

  return {
    tabs,
    broadcast,
    pageTabs,
    stripState,
    updateStrip,
    tabsChanged,
    layout,
    addTabKeys,
    setRepo,
    addTab,
    activateTab,
    cycleTab,
    selectTab,
    moveTab,
    closeTab,
    destroyAll,
    showTabMenu,
    bringToFront,
    commandToActive,
    restoreTabs,
    suppressPersist,
    forwardRunnerEvents,
    /** The window got the focus: retry the active tab's watcher if it had gone away. */
    retryActive() { const a = tabs.active(); if (a) a.watch.retry(); },
    /** Quitting: stop every watcher. */
    closeWatchers() { for (const s of tabs.list()) s.watch.close(); },
  };
}

module.exports = { createTabsController };
