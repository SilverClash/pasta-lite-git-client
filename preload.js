'use strict';
// The renderer's only door to the main process. Sandboxed preload: it may require 'electron' only,
// so this file is self-contained. ipcRenderer itself is never exposed.
//
// Errors: contextBridge copies thrown Errors without their custom properties (kind, stash, ...),
// so failures reject with the plain serialized error object {message, kind, exitCode, ...extras};
// the renderer turns it back into an Error (Components.util.toError, via renderer/store.js).
const { contextBridge, ipcRenderer } = require('electron');

// 'tabs-changed' {tabs: [{id, title, root|null, active, linked}]}: the window's tabs, on every
// change (opened, closed, moved, switched, a tab's repo changed).
const EVENTS = new Set(['changed', 'busy', 'watch', 'repo-opened', 'recent-changed', 'menu-command', 'tabs-changed']);

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && res.ok) return res.value;
  throw (res && res.error) || { message: 'Unknown error', kind: null, exitCode: null };
}

let seq = 0;

// app:log: fire and forget. Main checks the sender, the level, the size and the rate
// again; this side only keeps the payload cloneable and small.
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const LOG_MAX = 8 * 1024;
function sendLog(level, msg, fields) {
  try {
    const lvl = String(level);
    if (!LOG_LEVELS.has(lvl)) return;
    let f;
    if (fields && typeof fields === 'object') {
      const json = JSON.stringify(fields);
      f = json && json.length <= LOG_MAX ? JSON.parse(json) : { truncated: json ? json.length : 0 };
    }
    ipcRenderer.send('app:log', lvl, String(msg).slice(0, LOG_MAX), f);
  } catch {
    /* logging must never break the page */
  }
}

// Set by main only for `--smoke` runs (sandboxed preloads still see process.argv).
const isSmoke = typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv.includes('--pl-smoke');

/** app.openDialog / app.openRecent options: only {newTab: true} means anything. */
const tabOpts = (o) => ({ newTab: !!(o && o.newTab === true) });
const tabId = (id) => Number(id);

// Smoke runs only (main refuses these from a page otherwise): drive the tabs from a smoke script,
// which runs in the active tab's page (with activate, which every page has). list() is the tabs-changed list; probe(id) is main's smoke
// PROBE of that tab's page ({view, title, stats, ...} | null while it loads).
const smokeTabs = isSmoke ? {
  list: () => call('tabs:list'),
  close: (id) => call('tabs:close', tabId(id)),
  move: (id, toIndex) => call('tabs:move', tabId(id), Number(toIndex)),
  probe: (id) => call('tabs:probe', tabId(id)),
} : {};

contextBridge.exposeInMainWorld('api', {
  /**
   * The platform, as Node names it ('darwin', 'win32', 'linux'): the page's ⌘ / Ctrl shortcuts and
   * hints, its file manager's name, the credential helper it suggests (Components.util.PLATFORM).
   */
  platform: process.platform,
  /** True in smoke/test runs: the page may expose debug globals (window.PL). */
  smoke: isSmoke,
  /** Run a git operation on the current repo. The repo path is never passed: main injects it. */
  invoke: (op, ...args) => call('op', { op: String(op), args }),
  /** Unique id for invokeCancellable / app.cancel. */
  newOpId: () => `op-${Date.now()}-${++seq}`,
  /** Like invoke, but app.cancel(opId) aborts it while running or drops it while queued. */
  invokeCancellable: (opId, op, ...args) => call('op', { op: String(op), args, opId: String(opId) }),
  app: {
    /**
     * {repo, recent, gitVersion, gitPath, tabs: {count, id}}: tabs.id is this page's own tab;
     * recent [{root, name, display}], display the root as shown (the home folder as ~/…, as the
     * tab tooltips have it; main decides, src/recent-view.js).
     */
    getState: () => call('app:getState'),
    /** Pick a folder and open it here, or in a new tab with {newTab: true}. */
    openDialog: (o) => call('app:openDialog', tabOpts(o)),
    /**
     * Open a recent repo by root, here or in a new tab with {newTab: true}; main only accepts a
     * root from the recent list it last sent. A repo already open in another tab is shown there
     * instead (unless newTab).
     */
    openRecent: (root, o) => call('app:openRecent', String(root), tabOpts(o)),
    /**
     * Open a worktree of the current repo by path (a `worktrees` op entry's path). Main
     * accepts only a path `git worktree list` gives for this tab's repo right now (not the bare
     * entry, not a prunable one), then shows the tab that has it open, else opens it in a new tab.
     */
    openWorktree: (wtPath) => call('app:openWorktree', String(wtPath)),
    /**
     * Show a worktree of the current repo in the file manager (Finder on macOS), by path. Main
     * accepts only a path `git worktree list` gives for this tab's repo right now (the bare
     * entry included, a prunable one not). Resolves true; false if the tab changed repo meanwhile.
     */
    revealWorktree: (wtPath) => call('app:revealWorktree', String(wtPath)),
    cancel: (opId) => call('app:cancel', String(opId)),
    /** Open a terminal window in the current repo's root. */
    openTerminal: () => call('app:openTerminal'),
  },
  tabs: {
    /**
     * Open a new, empty tab (New Tab) and show it; resolves its id. No page calls it today (a repo
     * goes to a new tab through openRecent / openDialog {newTab: true}); the repo picker only
     * checks that window.api.tabs exists, and its tests fake this member.
     */
    newTab: () => call('tabs:newTab'),
    /** Show tab `id` (an id from 'tabs-changed'; main accepts only an existing tab's). */
    activate: (id) => call('tabs:activate', tabId(id)),
    ...smokeTabs,
  },
  clipboard: {
    /** Put plain text on the system clipboard (main writes it; at most 64 KiB of text). */
    writeText: (text) => call('clipboard:writeText', String(text)),
  },
  /** Add a record to main.log (level: debug | info | warn | error). Never throws, returns nothing. */
  log: (level, msg, fields) => { sendLog(level, msg, fields); },
  /** Subscribe to a main-process event; returns an unsubscribe function. */
  on: (channel, cb) => {
    if (!EVENTS.has(channel) || typeof cb !== 'function') throw new Error(`Unknown event: ${channel}`);
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
