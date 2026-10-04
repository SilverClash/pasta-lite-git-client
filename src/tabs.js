'use strict';
// Repository tabs: the pure parts of main's tab handling, free of Electron so they can
// be unit-tested with plain node:test. main's tabs controller keeps one session per tab
// (src/tab-session.js plus its view) in a registry from createTabRegistry and decides where an
// open goes (pickOpenTarget). Titles: a linked worktree's tab reads 'project · folder' and is
// flagged `linked` for the strip's tree icon (repo.linkedWorktree, src/repo-open.js). The sender routing is src/ipc-contract.js, tabs.json
// src/tabs-store.js.
const path = require('node:path');

const NEW_TAB_TITLE = 'New Tab';

// ---------------------------------------------------------------- registry

/**
 * The open tabs in strip order, plus which one is active. Tabs are the caller's objects; the
 * registry only reads `id` (unique) and `repo` ({root, name, ...} | null).
 */
function createTabRegistry() {
  const tabs = [];
  let activeId = null;
  const indexOf = (id) => tabs.findIndex((t) => t.id === id);
  const get = (id) => tabs.find((t) => t.id === id) || null;

  return {
    list: () => tabs.slice(),
    get,
    indexOf,
    get size() { return tabs.length; },
    get activeId() { return activeId; },
    active: () => get(activeId),
    /** Insert `tab` at `index` (default: the end). The first tab added becomes active. */
    add(tab, { index = tabs.length } = {}) {
      if (!tab || get(tab.id)) throw new Error('tabs: a tab needs a new id');
      const i = Number.isInteger(index) ? Math.max(0, Math.min(index, tabs.length)) : tabs.length;
      tabs.splice(i, 0, tab);
      if (activeId === null) activeId = tab.id;
      return tab;
    },
    /**
     * Remove tab `id`. Closing the active tab activates its right neighbour, else its left one
     * (as browsers do); null when it was the last. Returns the new active id (unchanged when a
     * background tab was closed), or undefined when there was no such tab.
     */
    remove(id) {
      const i = indexOf(id);
      if (i < 0) return undefined;
      tabs.splice(i, 1);
      if (activeId === id) activeId = tabs.length ? tabs[Math.min(i, tabs.length - 1)].id : null;
      return activeId;
    },
    /** Make `id` the active tab; false when there is no such tab. */
    activate(id) {
      if (!get(id)) return false;
      activeId = id;
      return true;
    },
    /** Move tab `id` to `toIndex` (clamped); true when the order changed. */
    move(id, toIndex) {
      const from = indexOf(id);
      if (from < 0 || !Number.isInteger(toIndex)) return false;
      const to = Math.max(0, Math.min(toIndex, tabs.length - 1));
      if (to === from) return false;
      const [t] = tabs.splice(from, 1);
      tabs.splice(to, 0, t);
      return true;
    },
    /** The id `delta` tabs from the active one, wrapping around (Next / Previous Tab). */
    neighbour(delta) {
      if (!tabs.length) return null;
      const i = Math.max(0, indexOf(activeId));
      return tabs[(((i + delta) % tabs.length) + tabs.length) % tabs.length].id;
    },
    /** Select Tab n: 1–8 are positions (null past the end), 9 is always the last tab. */
    atShortcut(n) {
      if (!tabs.length || !Number.isInteger(n) || n < 1 || n > 9) return null;
      if (n === 9) return tabs[tabs.length - 1].id;
      return n <= tabs.length ? tabs[n - 1].id : null;
    },
    /** Ids of every tab but `id` (Close Other Tabs). */
    othersOf: (id) => (get(id) ? tabs.filter((t) => t.id !== id).map((t) => t.id) : []),
    /** Ids of the tabs right of `id` (Close Tabs to the Right). */
    rightOf: (id) => { const i = indexOf(id); return i < 0 ? [] : tabs.slice(i + 1).map((t) => t.id); },
    /** The first tab (in strip order) showing `root`, other than `exceptId`; null when none. */
    findByRoot(root, exceptId = null) {
      return tabs.find((t) => t.id !== exceptId && t.repo && t.repo.root === root) || null;
    },
  };
}

// ---------------------------------------------------------------- where an open goes

/**
 * Where opening `root` goes: {action: 'focus', id} (show the tab that already has it),
 * {action: 'replace', id} (open it in that tab) or {action: 'new'} (a new tab).
 * - newTab (the user asked for a new tab): always a new tab, a duplicate of an open repo included.
 * - from a tab (its Open… / recent list): its own repo again → reopen it there; open in another
 *   tab → focus that one; otherwise replace the asking tab's repo.
 * - external (CLI, dock, "open with", no asking tab): open in another tab → focus it; an empty
 *   active tab (New Tab) is used; otherwise a new tab.
 * - preferExisting (a bare repo's "Open worktree"): the tab that has it open, the asking
 *   one included, is focused; otherwise a new tab (the asking tab keeps its repo). Wins over newTab.
 * @param {ReturnType<typeof createTabRegistry>} tabs
 * @param {{root: string, fromId?: number|null, newTab?: boolean, preferExisting?: boolean}} o
 */
function pickOpenTarget(tabs, { root, fromId = null, newTab = false, preferExisting = false }) {
  if (preferExisting) {
    const open = tabs.findByRoot(root);
    return open ? { action: 'focus', id: open.id } : { action: 'new' };
  }
  if (newTab) return { action: 'new' };
  const from = fromId === null ? null : tabs.get(fromId);
  if (from && from.repo && from.repo.root === root) return { action: 'replace', id: from.id };
  const open = tabs.findByRoot(root, from ? from.id : null);
  if (open) return { action: 'focus', id: open.id };
  if (from) return { action: 'replace', id: from.id };
  const active = tabs.active();
  if (active && !active.repo) return { action: 'replace', id: active.id };
  return { action: 'new' };
}

// ---------------------------------------------------------------- titles, the tabs-changed event

/**
 * A tab's title (also the window title's): a linked worktree's 'project · folder'
 * (repo.linkedWorktree.title, src/repo-open.js), else its repo's name (ops.repoName; the root's
 * basename only when it has none), or 'New Tab'. Folder names are used raw, as repo.name always
 * was: main has no display sanitiser, and the strip sets the title with textContent.
 */
function tabTitle(repo) {
  if (!repo || !repo.root) return NEW_TAB_TITLE;
  if (isLinked(repo) && repo.linkedWorktree.title) return repo.linkedWorktree.title;
  return repo.name || path.basename(repo.root);
}

/** The tab's repo is a linked worktree (main decided it: summary's linkedWorktree). */
const isLinked = (repo) => !!(repo && repo.root && repo.linkedWorktree);

/** `p` with the home folder as '~'. */
function homeShort(p, home) {
  if (home && (p === home || p.startsWith(home.endsWith(path.sep) ? home : home + path.sep))) {
    return `~${p.slice(home.replace(/[\\/]+$/, '').length)}`;
  }
  return p;
}

/**
 * A tab's tooltip: the repo's full path with the home folder as '~' (a linked worktree's adds
 * 'Linked worktree of <main worktree>'), or 'New Tab'.
 */
function tabTooltip(repo, home = '') {
  if (!repo || !repo.root) return NEW_TAB_TITLE;
  const where = homeShort(repo.root, home);
  const main = isLinked(repo) && repo.linkedWorktree.mainPath;
  return main ? `${where}\nLinked worktree of ${homeShort(main, home)}` : where;
}

/**
 * One tab as the pages see it: {id, title, root|null, active, linked}. linked: its repo is a linked
 * worktree (the strip shows a tree icon).
 */
const pageTab = (tabs, t) => ({
  id: t.id, title: tabTitle(t.repo), root: t.repo ? t.repo.root : null, active: t.id === tabs.activeId, linked: isLinked(t.repo),
});

/** The pages' 'tabs-changed' list: [{id, title, root|null, active, linked}], in strip order. */
const pageTabs = (tabs) => tabs.list().map((t) => pageTab(tabs, t));

/**
 * The strip's list: each page tab plus {tooltip, busy} (busy(tab): a write of that tab is queued
 * or running).
 */
const stripTabs = (tabs, { home = '', busy = () => false } = {}) => tabs.list()
  .map((t) => ({ ...pageTab(tabs, t), tooltip: tabTooltip(t.repo, home), busy: !!busy(t) }));

// ---------------------------------------------------------------- ops of one tab

/** The runner seen by one tab (createCloseGuard): only the ops run with `owner`. */
const ownerView = (runner, owner) => ({
  running: () => runner.running({ owner }),
  cancelAll: () => runner.cancelAll({ owner }),
  settled: () => runner.settled({ owner }),
});

module.exports = { createTabRegistry, pickOpenTarget, tabTitle, isLinked, tabTooltip, pageTabs, stripTabs, ownerView };
