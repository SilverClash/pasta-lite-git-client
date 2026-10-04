'use strict';
// User-facing git flows, the shared part (plain script; exposes window.PLFlows and window.PLFlowKit):
// the dialogs, follow-up questions and messages around one git operation, shared by the toolbar,
// sidebar, graph and keybindings. This file holds the flow wrapper, the kit the other flow files
// build on, and the few flows that are no git write of their own.
//
// Contract: every flow takes the store first and returns Promise<boolean> — true when the git
// operation ran and succeeded, false when it was cancelled, refused or failed. A flow never throws:
// errors are shown (toast or dialog) unless store.actions.write already toasted them. While the
// repo is busy (state.busy) or another flow of this store is still running (including its
// dialogs), a flow does nothing and returns false. Exceptions: PLPolicy.FREE_FLOWS (openTerminal,
// cancel, cancelInteractiveRebase, openWorktree, revealWorktree and copyWorktreePath) work while busy.
// In a bare repository (repo.bare) the flows that need a working tree
// (PLPolicy.WORKTREE_FLOWS, and pull in any mode but Fetch All) refuse with a notice
// ("Checkout — needs a working tree (bare repository)") before doing anything; so do the flows that
// start a conflicting op while a rebase / merge / … is in progress (PLPolicy.opBlocked:
// "Checkout — finish or abort the rebase first"). The menus disable them already, this also covers
// double-clicks and shortcuts.
// A flow belongs to the repository that was open when it started. The native menu can open another
// one mid-flow (the lock is per store, not per repo), so the body gets a scoped store (scoped()):
// once another repository is open, its writes and reads refuse (kind 'repo-changed', shown as
// nothing), its notices and store changes do nothing and its dialogs (kit dialog(store)) answer
// "cancel" without showing: every follow-up of the old repo's op stands down.
//
// Files (index.html order; each adds its flows to window.PLFlows through window.PLFlowKit.register):
//   flows-kit.js      the wrapper (flow, scoped, NO_DIALOG, settle), the kept-stash wording and
//                     reportOutcome, authAlert, tagConflictsAlert, and the flows below
//   flows-sync.js     fetch, pull, pullMode / setPullMode / PULL_MODES, push, setUpstream
//   flows-branch.js   checkout, createBranch, deleteBranch, deleteBranches, branchNameError
//   flows-stash.js    stashSave, stashPop, stashApply, stashDrop
//   flows-worktree.js stage, unstage, stageAll, unstageAll, discard, markResolved, commit and the hunk /
//                     line selections (the WIP panel and the diff view)
//   flows-linked-worktrees.js  removeWorktree, pruneWorktrees, lockWorktree, unlockWorktree, revealWorktree,
//                     copyWorktreePath (the LINKED worktrees of the sidebar section; not the working tree)
//   flows-op.js       a rebase / merge in progress (R1, keep-a-side) and what merge / rebase starts share
//   flows-merge.js    merge (R2)          flows-rebase.js   rebase from the menus (R2), interactive rebase (R3)
// Each file's header lists its flows (flows-op.js / flows-merge.js / flows-rebase.js: their own).
//
//   undo(store), redo(store)
//   openTerminal(store)
//   openWorktree(store, path)   show a linked worktree of this repository: the tab that has it open, else
//                               a new tab (the bare banner's buttons; main accepts only a path its own
//                               worktree list has)
//   cancel(store) -> Promise<boolean>   aborts the running cancellable op (state.remoteOp): fetch, pull,
//                               push, rebaseContinue, rebaseSkip, rebase, rebaseInteractive
//   isRunning(store) -> boolean  a flow of this store is in progress
//   shortcutFor(keydown, state, ctx), shortcutBlocked(keydown, state, ctx)   PLPolicy's (the global shortcuts)
// Kit (window.PLFlowKit): C, flow, settle, report, dialog, dn, short, Op, status, currentBranch,
// localBranches, upstreamOf, keptStashTitle, keptStashText, stashNote, reportOutcome, authAlert,
// tagConflictsAlert, register; flows-sync.js adds forcePush, flows-branch.js checkoutInner and
// syntaxError, flows-op.js its start helpers.
// All git-derived text reaches the DOM through the dialogs / toasts (textContent only).
(function () {
  const C = window.Components;
  const P = window.PLPolicy; // policy.js loads before this script
  const running = new WeakMap(); // store -> name of the flow in progress

  const dn = (s) => C.util.displayName(s);
  const { short, report } = C.util;
  const Op = () => window.PLOp;

  /** False once `store` (a flow's scoped store) belongs to a repository that is no longer open. */
  const stillHere = (store) => !store || typeof store.stillHere !== 'function' || store.stillHere();

  // What a flow's dialogs do once its repository is no longer open: nothing is shown, every
  // question is answered "cancel".
  const NO_DIALOG = Object.freeze({
    alert: async () => undefined, confirm: async () => false, choose: async () => null, prompt: async () => null,
    editMessage: async () => null, confirmDiscard: async () => false, pathListText: (paths, max) => C.dialog.pathListText(paths, max),
  });

  /** Components.dialog for a flow of `store` (NO_DIALOG once its repository was switched away from). */
  const dialog = (store) => (stillHere(store) ? C.dialog : NO_DIALOG);

  /**
   * The store a flow body works with: `store` (state, helpers) whose actions, set and invoke stand
   * down once another repository is open (stillHere() false): write / invoke reject with kind
   * 'repo-changed' (marked toasted, so nothing is shown), the other actions and set do nothing.
   */
  function scoped(store) {
    const root = store.state.repo.root;
    const here = () => !!store.state.repo && store.state.repo.root === root;
    const gone = () => Promise.reject(Object.assign(new Error('Another repository was opened meanwhile'), { kind: 'repo-changed', toasted: true }));
    const REFUSE = new Set(['write']);
    const actions = new Proxy(store.actions, {
      get(target, k) {
        const v = target[k];
        if (typeof v !== 'function') return v;
        return (...a) => {
          if (here()) return target[k](...a);
          return REFUSE.has(k) ? gone() : undefined;
        };
      },
    });
    return Object.create(store, {
      actions: { value: actions },
      set: { value: (patch) => { if (here()) store.set(patch); } },
      invoke: { value: (...a) => (here() ? store.invoke(...a) : gone()) },
      stillHere: { value: here },
    });
  }

  /** {value} when `p` resolves, {error} when it rejects (keeps results const, no try/let). */
  const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));

  /**
   * Wrap a flow body: the busy / one-flow-at-a-time guard, the bare / in-progress refusals, and never
   * throwing. PLPolicy.FREE_FLOWS skip the guard (and don't take the lock).
   */
  function flow(name, body) {
    const free = P.FREE_FLOWS.has(name);
    return async (store, ...args) => {
      if (!store || !store.state || !store.state.repo) return false;
      if (!free && (store.state.busy || running.has(store))) return false;
      const refused = P.bareBlocked(store.state, name, args) || P.opBlocked(store.state, name, args);
      if (refused) {
        store.actions.notify(refused);
        return false;
      }
      if (!free) running.set(store, name);
      const view = scoped(store);
      try {
        return (await body(view, ...args)) === true;
      } catch (e) {
        report(view, e);
        return false;
      } finally {
        if (!free && running.get(store) === name) running.delete(store);
      }
    };
  }


  const status = (store) => store.state.status || null;
  /** The checked-out branch (raw; null when detached, also mid-rebase): PLPolicy.headView. */
  const currentBranch = (store) => P.headView(store.state).branch;
  const localBranches = (store) => (store.state.refs && store.state.refs.local) || [];

  /** The upstream ('origin/main') of `branch`, from status for the current branch, else from refs. */
  function upstreamOf(store, branch) {
    const st = status(store);
    if (st && st.branch === branch) return st.upstream || null;
    const b = localBranches(store).find((x) => x.name === branch);
    return (b && b.upstream) || null;
  }

  // ---------------------------------------------------------------- kept stashes (the one wording)
  // A stash of the user's changes that didn't come back: a result's stash {kept, sha, reason} or an
  // error's stashKept / stash / reason. reason: 'conflict' (or none) the re-apply conflicted and the
  // tree was reset; 'index' git gave up on it; 'dirty' the tree had other changes to tracked files;
  // 'untracked' untracked files are where the stash's untracked files go (nothing was applied).
  // `banner`: the stash is our recorded autostash (a rebase / merge / Pull (rebase)), which the
  // banner's Restore re-applies once the tree allows it ('dirty', 'untracked': its ref is kept).

  const REAPPLY_BLOCKED = new Set(['dirty', 'untracked', 'index']);

  /** Why the stashed changes didn't come back, after "Your local changes …". `left`: the tree after a reset ('clean', 'as pulled'). */
  function stashWhy(reason, resetFailed, { left = 'clean' } = {}) {
    if (reason === 'dirty') return 'were not re-applied, because the working tree has other changes now (it was left as it is)';
    if (reason === 'untracked') return 'were not re-applied, because untracked files in the working tree are in the way of files in the stash (nothing was changed)';
    const what = reason === 'index' ? 'could not be re-applied' : 'could not be re-applied without conflicts';
    return resetFailed
      ? `${what}, and the working tree couldn't be reset afterwards: check your files for conflict markers before you go on`
      : `${what}, so the working tree was left ${left}`;
  }

  /** "They are safe in a stash (a1b2c3d): <what to do next>." (`lead`: the sentence's subject). */
  function keptStashNote(sha, { reason, banner = false, lead = 'They' } = {}) {
    const where = `${lead} are safe in a stash${sha ? ` (${short(sha)})` : ''}`;
    const restore = banner && (reason === 'dirty' || reason === 'untracked');
    if (reason === 'untracked') return `${where}: move or delete the untracked files that are in the way, then ${restore ? 'click Restore in the banner' : 'pop the stash from the Stashes list'}.`;
    if (restore) return `${where}: commit, stash or discard your other changes, then click Restore in the banner.`;
    return `${where}: pop it from the Stashes list when you're ready.`;
  }

  /** The full explanation of a kept stash for a dialog: "Your local changes <why>.\n\nThey are safe …". */
  const keptStashText = ({ sha, reason, resetFailed, banner, left }) => `Your local changes ${stashWhy(reason, resetFailed, { left })}.\n\n${keptStashNote(sha, { reason, banner })}`;

  /** "<done>, but your changes weren't re-applied" / "…conflicted": the title of a kept-stash alert. */
  const keptStashTitle = (done, reason) => `${done}, but ${REAPPLY_BLOCKED.has(reason) ? "your changes weren't re-applied" : 'your changes conflicted'}`;

  /** A note about the stash an error kept (e.stashKept), appended to a dialog's message; '' without one. */
  const stashNote = (e, { banner = false } = {}) => (e && e.stashKept
    ? `\n\n${keptStashNote(e.stash, { reason: e.reason, banner, lead: 'Your local changes' })}`
    : '');

  /**
   * The ONE place a finished op's result fields are explained (docs/plans/rebase.md §3.8; pull,
   * rebase, continue, skip, interactive, merge, mergeCommit, the aborts, restoreAutostash): a kept
   * stash ({stash: {kept, sha, reason}}) or a failed reset (resetFailed) gets an alert ("<done>, but
   * your changes conflicted" / "… weren't re-applied", or `title`); otherwise `notice` is shown, with
   * a note when the changes came back without their staged / unstaged split (indexRestored: false).
   * `banner`: the stash is our recorded autostash (default true: every op but pull's merge modes).
   * Resolves true when the alert was shown.
   */
  async function reportOutcome(store, res, { done, notice, title, banner = true, left }) {
    const stash = res && res.stash && res.stash.kept ? res.stash : null;
    const resetFailed = !!(res && res.resetFailed);
    if (stash || resetFailed) {
      const reason = stash ? stash.reason : null;
      const why = `Your local changes from before ${stashWhy(reason, resetFailed, { left })}.`;
      await dialog(store).alert({
        title: title || keptStashTitle(done, reason),
        message: stash ? `${why}\n\n${keptStashNote(stash.sha, { reason, banner })}` : why,
      });
      return true;
    }
    const split = res && res.indexRestored === false ? '. Your local changes came back, but their staged part could not be restored, so all of them are unstaged' : '';
    if (notice) store.actions.notify(`${notice}${split}`);
    return false;
  }

  const AUTH_MESSAGE = 'Git could not authenticate with the remote. Pasta Lite uses your existing git setup and never asks for passwords itself:\n\n'
    + '• HTTPS remotes: store your credentials with a credential helper (e.g. git config --global credential.helper osxkeychain) or sign in once from a terminal.\n'
    + '• SSH remotes: add your key to ssh-agent (ssh-add) and check that the remote accepts it.\n\nThen try again.';

  const authAlert = (store, e) => dialog(store).alert({ title: 'Authentication failed', message: AUTH_MESSAGE, detail: e && e.message });

  async function tagConflictsAlert(store, res) {
    const tags = (res && res.tagConflicts) || [];
    if (!tags.length) return;
    await dialog(store).alert({
      title: 'Some tags were not updated',
      message: `${C.util.plural(tags.length, 'local tag')} ${tags.length === 1 ? 'differs' : 'differ'} from the remote's copy and ${tags.length === 1 ? 'was' : 'were'} kept as is. Branches were updated.`,
      detail: dialog(store).pathListText(tags),
    });
  }

  // ---------------------------------------------------------------- undo / redo

  const pastTense = (description) => String(description || '').replace(/^Undo /, 'Undid ').replace(/^Redo /, 'Redid ');

  function undoFlow(dir) {
    return async (store) => {
      const u = store.state.undo;
      const target = u && u[dir];
      if (!target) {
        const blocked = u && u[`${dir}Blocked`];
        if (u && u.busy) store.actions.notify(`${dir === 'undo' ? 'Undo' : 'Redo'} is unavailable while a merge, rebase or similar operation is in progress`);
        else if (blocked) store.actions.notify(`Can't ${dir}: ${blocked}`);
        else store.actions.notify(`Nothing to ${dir}`);
        return false;
      }
      const res = await store.actions.write(dir, []);
      const note = res && res.upstreamRestored === false ? ' (its upstream could not be restored)' : '';
      store.actions.notify(`${pastTense((res && res.description) || target.description)}${note}`);
      return true;
    };
  }

  // ---------------------------------------------------------------- misc

  async function openTerminalFlow() {
    const api = window.api;
    if (!api || !api.app || typeof api.app.openTerminal !== 'function') throw new Error('Opening a terminal is not available');
    try {
      await api.app.openTerminal();
    } catch (e) {
      throw C.util.toError(e);
    }
    return true;
  }

  async function openWorktreeFlow(store, path) {
    if (typeof path !== 'string' || !path) return false;
    const api = window.api;
    if (!api || !api.app || typeof api.app.openWorktree !== 'function') throw new Error('Opening a worktree is not available');
    try {
      await api.app.openWorktree(path);
    } catch (e) {
      throw C.util.toError(e);
    }
    return true;
  }

  window.PLFlows = {
    undo: flow('undo', undoFlow('undo')),
    redo: flow('redo', undoFlow('redo')),
    openTerminal: flow('openTerminal', openTerminalFlow),
    openWorktree: flow('openWorktree', openWorktreeFlow),
    cancel: async (store) => {
      try {
        return !!(store && store.actions && (await store.actions.cancelRemote()));
      } catch {
        return false;
      }
    },
    isRunning: (store) => running.has(store),
    shortcutFor: P.shortcutFor,
    shortcutBlocked: P.shortcutBlocked,
  };

  // What the other flow files build on (they add their flows to PLFlows, and their shared helpers here).
  window.PLFlowKit = {
    C, flow, settle, report, dialog, dn, short, Op, status, currentBranch, localBranches, upstreamOf,
    keptStashTitle, keptStashText, stashNote, reportOutcome, authAlert, tagConflictsAlert,
    /** Add flows to window.PLFlows: {name: body} (bodies as for flow(); PLPolicy.FREE_FLOWS skip the guard). */
    register(bodies) {
      for (const [name, body] of Object.entries(bodies)) window.PLFlows[name] = flow(name, body);
    },
  };
})();
