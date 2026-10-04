'use strict';
// One tab's session: the repo open in it, its openSeq, its closing / closed state and
// its file watcher, kept consistent in one place. Pure Node, no Electron: main's
// tabs controller adds the tab's view and web contents and passes send(); tests use fakes.
//
// Invariants:
// - The watcher follows the repo: watching repo.root (bare mode when repo.bare) or nothing.
// - openSeq supersedes opens: beginOpen() takes a token; the token is stale once another open
//   started from this tab, once any open landed in it (setRepo with a repo, whoever asked), or
//   once the tab closed. So an open waiting on a dialog never replaces the repo that landed
//   meanwhile.
// - A closed session sends nothing and watches nothing.
const { createWatchSession } = require('./watch-session');

/**
 * The `bare` option for a watcher of `root`: the tab's repo is that root and is bare.
 * setRepo assigns the repo before it opens the watcher, so this sees the repo being opened.
 */
const watchesBare = (repo, root) => !!(repo && repo.root === root && repo.bare);

/** A repo's linkedWorktree as compared by sameShown (null: not a linked worktree, or no repo). */
const linkedKey = (r) => JSON.stringify((r && r.linkedWorktree) || null);

/**
 * What the strip, the window title and the watcher mode show of a repo: root, name, bare and
 * linkedWorktree (a linked worktree's title, tree icon and tooltip).
 */
const sameShown = (a, b) => (a ? a.root : null) === (b ? b.root : null)
  && (a ? a.name : null) === (b ? b.name : null) && !!(a && a.bare) === !!(b && b.bare)
  && linkedKey(a) === linkedKey(b);

/**
 * @param {{
 *   id: number,
 *   send: (channel: string, payload: object) => void,
 *   createWatcher: (root: string, o: {onEvent: Function, bare: boolean}) => {pause(), resume(), close()},
 *   runnerRunning?: () => {repo: string, write: boolean, started: boolean}[],
 *   onGone?: (session: object) => void,
 *   log?: (message: string, err: unknown) => void,
 *   watch?: object,
 * }} o  send: to the tab's page (the session drops it once closed). runnerRunning: the runner's
 *   running ops: writes already running (another tab's, on a repo this tab may open) keep the
 *   new watcher paused too. onGone: the watched folder was deleted or moved, and the session has
 *   closed its repo (the page still got the 'watch' 'gone' event). watch: extra
 *   createWatchSession options (tests: now, retryMs, info).
 */
function createTabSession({ id, send, createWatcher, runnerRunning = () => [], onGone = () => {}, log, watch: watchOpts = {} }) {
  let repo = null; // {root, name, head, bare, linkedWorktree} | null (the page shows the start screen)
  let openSeq = 0;
  let closed = false;
  let closing = false;

  const guardedSend = (channel, payload) => { if (!closed) send(channel, payload); };

  const watch = createWatchSession({
    ...watchOpts,
    createWatcher: (root, o) => createWatcher(root, { ...o, bare: watchesBare(repo, root) }),
    send: guardedSend,
    // The folder was deleted or moved: close the repo as app:getState does, so ops and the focus
    // refresh don't run against a missing folder.
    onGone: (root) => {
      if (!repo || repo.root !== root) return;
      setRepo(null);
      onGone(session);
    },
    ...(log ? { log } : {}),
  });
  watch.pause(); // in the background until the tab is shown
  for (const r of runnerRunning()) if (r.write && r.started) watch.busy({ repo: r.repo, running: true });

  /**
   * Set the repo open in this tab (null: none). A repo landing here supersedes every open still
   * pending from this tab (openSeq). The watcher is replaced (a new one, a reset retry backoff,
   * the repo's bare mode) or closed. Returns true when what the tab shows changed (root, name or
   * bare): the caller updates the strip and the window title.
   */
  function setRepo(info) {
    if (closed) return false;
    const prev = repo;
    if (info) openSeq++;
    repo = info || null;
    if (repo) watch.open(repo.root);
    else watch.close();
    return !sameShown(prev, repo);
  }

  /**
   * A fresh summary of the open repo (app:getState). Only for the repo still open here (same
   * root). A new head is just stored; a changed name, bare flag or linkedWorktree goes through
   * setRepo, so the watcher's mode, the title and the strip's icon follow. Returns true when what the tab shows changed.
   */
  function refresh(fresh) {
    if (closed || !repo || !fresh || fresh.root !== repo.root) return false;
    if (sameShown(repo, fresh)) {
      repo = fresh;
      return false;
    }
    return setRepo(fresh);
  }

  const session = {
    id,
    send: guardedSend,
    /** Start an open from this tab: {stale()} is true once it was superseded or the tab closed. */
    beginOpen() {
      const seq = ++openSeq;
      return { stale: () => closed || seq !== openSeq };
    },
    setRepo,
    refresh,
    /** The close guard is deciding (one decision at a time): false when one already is, or closed. */
    beginClose() {
      if (closing || closed) return false;
      closing = true;
      return true;
    },
    endClose() { closing = false; },
    /** The tab is gone: its opens are cancelled, its watcher closed, nothing is sent any more. */
    close() {
      if (closed) return;
      closed = true;
      openSeq++;
      watch.close();
    },
    /** The watch session (pause / resume / retry / busy; open and close follow the repo). */
    get watch() { return watch; },
    get repo() { return repo; },
    get closed() { return closed; },
    get closing() { return closing; },
  };
  return session;
}

module.exports = { createTabSession, watchesBare };
