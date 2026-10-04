'use strict';
// Opening a repository: where an open goes, what it asks first, and what changes
// once it lands. Free of Electron: the tabs, git, the trust policy, the recent list and the UI
// are ports passed in, so the flow is unit-tested with fakes.
//
// Security boundary: the pages never give a path to open. Every use case below takes either a
// path from outside the pages (CLI, dock, the folder dialog, main's own menu, tabs.json) or a
// path matched against a list main holds: the recent list it last showed (findShownRecent) or
// `git worktree list` of the tab's repo, read just now (listedEntry, freshWorktreeEntry).
const { pickOpenTarget } = require('./tabs');
const { kindError } = require('./exec');
const { EVENTS } = require('./ipc-contract');

/** openRepo failures that mean the folder is gone / no longer a repo: drop it from recent. */
const FORGET_KINDS = new Set(['not-a-repo', 'not-found']);
const shouldForgetRecent = (err) => !!err && FORGET_KINDS.has(err.kind);

/**
 * The entry of `shown` (the recent list main last sent to the renderer) whose root is exactly
 * `root`, or null. openRecent only opens paths the user was shown, never an arbitrary one.
 */
function findShownRecent(shown, root) {
  if (typeof root !== 'string' || !root || !Array.isArray(shown)) return null;
  return shown.find((e) => e && e.root === root) || null;
}

/**
 * The entry of `list` (git.worktrees of the tab's repo, read just now) whose path is exactly the
 * renderer-supplied `wtPath`, or null: never a prunable or missing one (its folder is gone), and
 * the bare repo's own entry only with `allowBare` (app:revealWorktree: its folder is real and
 * revealing it opens nothing; app:openWorktree can't open it). Compared as git prints it: never
 * an arbitrary path.
 */
function listedEntry(list, wtPath, { allowBare = false } = {}) {
  if (typeof wtPath !== 'string' || !wtPath || !Array.isArray(list)) return null;
  return list.find((w) => w && w.path === wtPath && (allowBare || !w.bare) && !w.prunable && !w.missing) || null;
}

/**
 * listedEntry of a `listWorktrees` of `session`'s repo read just now (app:openWorktree,
 * app:revealWorktree), or null when the tab's repo changed while git listed them. Kinds: 'no-repo'
 * (no repository open), 'not-found' (not listed, or its folder is gone).
 */
async function freshWorktreeEntry(listWorktrees, session, wtPath, { allowBare = false } = {}) {
  const repo = session.repo;
  if (!repo) throw kindError('no-repo', 'No repository is open');
  const list = await listWorktrees(repo.root);
  if (session.repo !== repo) return null;
  const entry = listedEntry(list, wtPath, { allowBare });
  if (entry) return entry;
  const listed = Array.isArray(list) && list.some((w) => w && w.path === wtPath && (allowBare || !w.bare));
  throw kindError('not-found', listed ? 'Its folder is gone' : 'This worktree is no longer listed');
}

/**
 * @param {{
 *   tabs: ReturnType<typeof import('./tabs').createTabRegistry>,
 *   openRepo: (dir: string) => Promise<{root: string, name: string, bare: boolean}>,
 *   listWorktrees: (root: string) => Promise<{path: string, bare: boolean, prunable: boolean, missing: boolean}[]>,
 *   trust: {confirm(root: string): Promise<boolean>},
 *   recent: () => ({add(root: string, o: {name: string}): void, remove(root: string): void} | null),
 *   recentView: {refresh(): Promise<object[]>, readonly shown: object[]},
 *   place: {addTab(o: {index?: number, activate: boolean}): object, activate(id: number): void,
 *     front(): void, setRepo(session: object, info: object): void},
 *   pickFolder: (o: {newTab: boolean}) => Promise<string|null>,
 *   onRecentChanged: () => Promise<void>,
 *   onOpened: () => void,
 *   ui: {interactive: boolean, showError(title: string, err: unknown): void},
 *   log: {info: Function, warn: Function, error: Function}, tabLog: {info: Function},
 * }} o  place: the tabs controller (addTab creates the window if needed; setRepo updates the
 *   strip). pickFolder: the folder dialog, null when cancelled. onRecentChanged: the recent list
 *   changed outside an open (menu and pages). onOpened: after an open landed (the menu).
 *   ui.showError: an open the user started outside the pages failed (logs; a dialog when
 *   interactive).
 */
function createRepoOpening({
  tabs, openRepo, listWorktrees, trust, recent, recentView, place, pickFolder, onRecentChanged, onOpened, ui, log, tabLog,
}) {
  /** After a failed open of `dir`: drop it from recent if it is gone / no longer a repo. */
  function forgetRecentIfGone(dir, err) {
    const store = recent();
    if (!store || !shouldForgetRecent(err)) return;
    try {
      store.remove(dir);
    } catch (e) {
      log.warn('could not update the recent list', { err: e });
    }
    onRecentChanged().catch((e) => log.error('error', { err: e }));
  }

  /**
   * Open `dir` (any path inside a worktree). Where it goes is pickOpenTarget: `from` is the tab
   * that asked (null for the CLI, the dock, the menu without a window, restoring), `newTab` the
   * user asked for a new tab. A repo already open in another tab is shown there instead (unless
   * newTab). preferExisting (a worktree): the tab that has it, else a new tab, never the asking
   * one. background: the tab is added without being shown or the window brought forward
   * (restoring). abort(): stop before anything changes (the restore's window went away).
   * Rejects with ops.openRepo's error (kind 'not-a-repo' / 'not-found' also drop `dir` from
   * recent; others such as 'unsafe-repo' keep it). Resolves {info, session}, or null when a newer
   * open in the same tab started or landed meanwhile (that one wins), the asking tab was closed,
   * abort() said so, or the user declined to trust the repo's config.
   */
  async function open(dir, { from = null, newTab = false, preferExisting = false, background = false, abort = () => false } = {}) {
    const token = from ? from.beginOpen() : null;
    const stale = () => (!!token && token.stale()) || abort();
    let info;
    try {
      info = await openRepo(dir);
    } catch (err) {
      forgetRecentIfGone(dir, err);
      throw err;
    }
    if (stale()) return null;
    const pick = () => pickOpenTarget(tabs, { root: info.root, fromId: from ? from.id : null, newTab, preferExisting });
    const focusOpen = (id) => {
      tabLog.info('repo already open in a tab: showing it', { repo: info.root, tab: id });
      place.activate(id);
      if (!background) place.front();
      return { info, session: tabs.get(id) };
    };
    const first = pick();
    if (first.action === 'focus') return focusOpen(first.id);
    if (!(await trust.confirm(info.root)) || stale()) return null;
    try {
      recent().add(info.root, { name: info.name }); // best effort: an unwritable userData must not block opening
    } catch (err) {
      log.warn('could not update the recent list', { err });
    }
    const shown = await recentView.refresh();
    if (stale()) return null;
    // Nothing fallible from here on: the tab, the menu and the pages change together. Picked again:
    // tabs may have opened, closed or changed while the user was asked.
    const target = pick();
    if (target.action === 'focus') return focusOpen(target.id);
    const s = target.action === 'new'
      ? place.addTab({ index: from && tabs.get(from.id) ? tabs.indexOf(from.id) + 1 : undefined, activate: false })
      : tabs.get(target.id);
    place.setRepo(s, info);
    log.info('repo opened', { repo: info.root, tab: s.id });
    onOpened();
    // A tab created just now gets the repo from its app:getState instead (its page isn't loaded yet).
    s.send(EVENTS.REPO_OPENED, { repo: info, recent: shown });
    for (const t of tabs.list()) if (t !== s) t.send(EVENTS.RECENT_CHANGED, { recent: shown });
    if (!background) {
      place.activate(s.id);
      place.front();
    }
    return { info, session: s };
  }

  const infoOf = (res) => (res ? res.info : null);

  /** An open the user started outside the pages: a failure is shown (rethrown without a UI). */
  async function reported(dir, o) {
    try {
      return infoOf(await open(dir, o));
    } catch (err) {
      if (!ui.interactive) throw err;
      ui.showError('Could not open repository', err);
      return null;
    }
  }

  return {
    /** A path from outside the app (CLI, dock, "open with", a second launch). Resolves the info or null. */
    openExternal: (dir) => reported(dir, {}),
    /** File > Open Recent (main's own menu, built from the list main holds), for the active tab. */
    openFromMenu: (session, root) => reported(root, { from: session }),
    /** The folder dialog, for tab `session` or (newTab) a new tab. Resolves the info or null. */
    async openFromDialog(session, { newTab = false } = {}) {
      const dir = await pickFolder({ newTab });
      return dir ? infoOf(await open(dir, { from: session, newTab })) : null;
    },
    /** app:openRecent: only a root from the list main last showed, never an arbitrary path. */
    async openShownRecent(session, root, { newTab = false } = {}) {
      const entry = findShownRecent(recentView.shown, root);
      if (!entry) throw kindError('invalid-args', 'No such recent repository');
      return infoOf(await open(entry.root, { from: session, newTab }));
    },
    /**
     * app:openWorktree (the bare repo banner's "Open worktree", the sidebar): a path `git worktree
     * list` gives right now for the tab's repo, not bare and its folder there (freshWorktreeEntry:
     * no-repo, not-found). The tab that has it open already is shown, else it opens in a new tab
     * (the bare repo stays in this one). Resolves null when the tab's repo changed while git
     * listed the worktrees.
     */
    async openWorktreeOf(session, wtPath) {
      const entry = await freshWorktreeEntry(listWorktrees, session, wtPath);
      return entry ? infoOf(await open(entry.path, { from: session, preferExisting: true })) : null;
    },
    /** A new tab in the background (restoring tabs.json, smoke extra tabs). Resolves {info, session} or null. */
    openBackgroundTab: (root, { abort } = {}) => open(root, { newTab: true, background: true, abort }),
  };
}

module.exports = { createRepoOpening, shouldForgetRecent, findShownRecent, listedEntry, freshWorktreeEntry };
