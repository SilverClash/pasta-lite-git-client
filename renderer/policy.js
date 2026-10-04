'use strict';
// What is allowed when (plain script; exposes window.PLPolicy, and module.exports under node for the
// tests; loads after op-model.js). Pure, no DOM: the one place that says whether an action can run
// now and why not, for the toolbar, the menus, the keyboard shortcuts and the flow wrapper.
// Components.actions re-exports all of it (renderer/actions.js).
//
//   BUSY_TITLE                      'Working…'
//   FREE_FLOWS                      flows that also run while busy (openTerminal, cancel, openWorktree, revealWorktree, copyWorktreePath, …); the flow
//                                   wrapper (flows-kit.js) takes no lock for them
//   START_FLOWS                     flow -> action name of the flows that start a conflicting op
//   WORKTREE_FLOWS                  flow -> action name of the flows that need a working tree: refused
//                                   in a bare repository (repo.bare), like non-fetch pulls
//   isBare(state), bareTitle(action) -> '<action> — needs a working tree (bare repository)'
//   bareBlocked(state, flow, args?) -> that title when `flow` can't run in this bare repository, else null
//   opBlocked(state, flow, args?) -> the title of a START_FLOWS flow while an op is in progress, else null
//                                   (a pull in Fetch All mode runs); used by gateItems and the flow wrapper
//   PULL_MODES, DEFAULT_PULL_MODE   'fetch' | 'ff-if-possible' | 'ff-only' | 'rebase'; 'ff-if-possible'
//   effectivePullMode(state, stored) -> the mode the Pull button runs: 'fetch' in a bare repository,
//                                   else `stored` (the per-repo choice) when it is a mode, else the default
//   hasRemotes(state), headView(state) -> {branch, rebasingBranch, oid, detached, label}: HEAD as the UI names it
//   availability(state, {dirty, pullMode, pullLabel?}) -> {undo, redo, pull, pullMenu, fetch, push,
//                                   branch, stash, pop, terminal, switcher}: each {disabled, title};
//                                   while an op is in progress only Fetch and Terminal stay enabled
//                                   (and Pull when it is set to Fetch All; docs/plans/rebase.md §5.5); in a
//                                   bare repository Pull only as Fetch All, no Stash / Pop (gateBare)
//   gateItems(descs, state) -> descs with the availability() rules for fetch / push / createBranch,
//                                   every START_FLOWS flow disabled while a rebase / merge / … is in
//                                   progress (opBlocked), and the WORKTREE_FLOWS in a bare repository
//                                   (bareBlocked)
//   shortcutFor(keydown, state, {dirty, pullMode, inField}) -> flow name | null   the global shortcut
//                                   to run (a Components.actions.KEYS entry with a flow), gated by
//                                   Components.actions.availability; inField: focus is in a text field,
//                                   where ⌘Z / ⌘⇧Z stay the field's own
//   shortcutBlocked(keydown, state, ctx) -> string | null   the disabled title of a gated-off shortcut
// op-model.js checks repo.bare inline (bannerModel): it loads before this script.
(function () {
  const C = window.Components;
  const { displayName, plural, short } = C.util;
  // The in-progress model (renderer/op-model.js) loads before this script; node tests that load this
  // script alone get it from its file.
  const Op = window.PLOp || (typeof module !== 'undefined' && typeof require === 'function' ? require('./op-model.js') : null);

  const BUSY_TITLE = 'Working…';
  const FREE_FLOWS = new Set(['openTerminal', 'cancel', 'cancelInteractiveRebase', 'openWorktree', 'revealWorktree', 'copyWorktreePath']);
  const PULL_MODES = Object.freeze(['fetch', 'ff-if-possible', 'ff-only', 'rebase']);
  const DEFAULT_PULL_MODE = 'ff-if-possible';

  /**
   * HEAD as the UI names it, from store state `s` (status, else refs.head, else repo.head):
   *   branch          the checked-out branch (raw), or null
   *   rebasingBranch  the branch a rebase in progress replays (raw; HEAD is detached meanwhile), or null
   *   oid             HEAD's commit, or null (unborn)
   *   detached        no branch but a commit
   *   label           display-safe: the branch, '<branch> (rebasing)', 'detached HEAD', or null (no HEAD yet)
   */
  function headView(s) {
    const r = s && s.repo;
    const head = s && s.refs ? s.refs.head : null;
    const st = s && s.status;
    let branch = null;
    if (st) branch = st.branch || null;
    else if (head) branch = head.branch || null;
    else if (r && r.head) branch = r.head.branch || null;
    const oid = (st && st.oid) || (head && head.oid) || (r && r.head && r.head.sha) || null;
    const rb = !branch && Op ? Op.rebaseStateOf(st) : null;
    const rebasingBranch = rb && rb.branch ? rb.branch : null;
    const detached = !branch && !!oid;
    let label = null;
    if (branch) label = displayName(branch);
    else if (rebasingBranch) label = `${displayName(rebasingBranch)} (rebasing)`;
    else if (detached) label = 'detached HEAD';
    return { branch, rebasingBranch, oid, detached, label };
  }

  /** Whether the repo has any remote: state.remotes (names) once loaded, else remote branches. */
  function hasRemotes(state) {
    if (Array.isArray(state.remotes)) return state.remotes.length > 0;
    return !!state.refs && Array.isArray(state.refs.remote) && state.refs.remote.length > 0;
  }

  const NO_REMOTES = 'no remotes configured';
  const on = (title) => ({ disabled: false, title });
  const off = (title) => ({ disabled: true, title });

  /**
   * Per-action availability, each {disabled, title}: undo, redo, pull, pullMenu, fetch, push, branch,
   * stash, pop, terminal, switcher. Pure. state: store state; opts: {dirty (store.isDirty()),
   * pullMode (the Pull button's mode), pullLabel (its label for the tooltips, default 'Pull')}.
   * Terminal stays available while busy (PLFlows.openTerminal runs while busy).
   */
  function availability(state, { dirty = false, pullMode, pullLabel } = {}) {
    const mode = pullMode || 'ff-if-possible';
    const names = {
      undo: 'Undo', redo: 'Redo', pull: pullLabel || 'Pull', pullMenu: 'Pull options', fetch: 'Fetch', push: 'Push',
      branch: 'Branch', stash: 'Stash', pop: 'Pop', terminal: 'Terminal', switcher: 'Switch branch',
    };
    const m = {};
    if (!state || !state.repo) {
      for (const [k, n] of Object.entries(names)) m[k] = off(`${n} — open a repository first`);
      return m;
    }
    m.terminal = on('Open a terminal in the repository');
    if (state.busy) {
      for (const [k, n] of Object.entries(names)) if (k !== 'terminal') m[k] = off(`${n} — ${BUSY_TITLE}`);
      return m;
    }
    const { branch: rawBranch, oid, detached } = headView(state);
    const bname = rawBranch ? displayName(rawBranch) : null;
    const remotes = hasRemotes(state);

    m.undo = undoRedoAvailability(state, 'undo');
    m.redo = undoRedoAvailability(state, 'redo');
    Object.assign(m, pullFetchAvailability(names, mode, { bname, detached, remotes }));
    m.push = pushAvailability(state, { bname, oid, detached, remotes });
    m.branch = oid ? on(`Create a branch at ${bname || short(oid)}`) : off('Branch — the repository has no commits yet');
    m.stash = dirty ? on('Stash all changes') : off('Stash — no changes to stash');
    m.pop = popAvailability(state.stashes || []);
    let current = bname;
    if (!current) current = detached ? `Detached HEAD at ${oid}` : 'No branch';
    m.switcher = on(`${current}\nClick to switch branches`);
    if (isBare(state)) return gateBare(m, state, names, mode, { bname, oid, remotes });
    return gateInProgress(m, state, names, mode);
  }

  /** availability() of Undo (dir 'undo') or Redo ('redo'): what state.undo offers, or why not. */
  function undoRedoAvailability(state, dir) {
    const u = state.undo;
    const verb = dir === 'undo' ? 'Undo' : 'Redo';
    if (!u) return off(state.undoError ? `${verb} unavailable: ${displayName(state.undoError)}` : `Nothing to ${dir}`);
    if (u.busy) return off(`${verb} is unavailable while an operation (merge, rebase, …) is in progress`);
    const t = u[dir];
    if (t) return on(displayName(t.description || verb));
    const blocked = u[`${dir}Blocked`];
    if (blocked) return off(`${verb} unavailable: ${displayName(blocked)}`);
    return off(`Nothing to ${dir}`);
  }

  /** availability() of Pull, Pull options and Fetch: {pull, pullMenu, fetch}. */
  function pullFetchAvailability(names, mode, { bname, detached, remotes }) {
    if (!remotes) {
      return {
        pull: off(`${names.pull} — ${NO_REMOTES}`),
        pullMenu: off(`Pull options — ${NO_REMOTES}`),
        fetch: off(`Fetch — ${NO_REMOTES}`),
      };
    }
    let pull;
    if (mode === 'fetch') pull = on('Fetch All: fetch every remote');
    else if (!bname) pull = off(`${names.pull} — ${detached ? 'HEAD is detached' : 'no branch checked out'}`);
    else pull = on(`${names.pull} into ${bname}`);
    return {
      pull,
      pullMenu: on('Pull options: Fetch All, fast-forward if possible, fast-forward only, rebase'),
      fetch: on('Fetch all remotes'),
    };
  }

  /** availability() of Push: the current branch to its upstream (or setting one), or why not. */
  function pushAvailability(state, { bname, oid, detached, remotes }) {
    if (detached) return off('Push — HEAD is detached; check out a branch first');
    if (!bname) return off('Push — no branch checked out');
    if (!oid) return off(`Push — ${bname} has no commits yet`);
    if (!remotes) return off(`Push — ${NO_REMOTES}`);
    const st = state.status;
    const up = st && st.upstream ? displayName(st.upstream) : null;
    const ahead = st && st.ahead ? ` (${plural(st.ahead, 'commit')} ahead)` : '';
    return on(up ? `Push ${bname} to ${up}${ahead}` : `Push ${bname} and set its upstream`);
  }

  /** availability() of Pop: the latest stash, named by its message when it has one. */
  function popAvailability(stashes) {
    if (!stashes.length) return off('Pop — no stashes');
    const msg = stashes[0].message ? `: ${displayName(stashes[0].message)}` : '';
    return on(`Pop the latest stash${msg}`);
  }

  /**
   * availability() in a bare repository: Pull runs only as Fetch All, Stash / Pop are off,
   * Branch creates without checking out, the switcher lists the branches (its checkouts are off).
   * Push, Fetch, Undo / Redo (undoState offers only what works without a working tree) stay as they are.
   */
  function gateBare(m, state, names, mode, { bname, oid, remotes }) {
    const gated = { ...m };
    if (remotes) {
      if (mode !== 'fetch') gated.pull = off(bareTitle(names.pull));
      gated.pullMenu = on('Pull options: only Fetch All works without a working tree (bare repository)');
    }
    if (oid) gated.branch = on(`Create a branch at ${bname || short(oid)} (not checked out)`);
    gated.stash = off(bareTitle(names.stash));
    gated.pop = off(bareTitle(names.pop));
    gated.switcher = on(`${bname || 'No branch'} (HEAD of the bare repository)\nClick to see the branches`);
    return gated;
  }

  /**
   * availability() while a rebase / merge / … is in progress (status.state): everything that would
   * start a conflicting operation is disabled with the reason; Fetch, Terminal and a Pull set to
   * Fetch All stay as they are (docs/plans/rebase.md §5.5).
   */
  function gateInProgress(m, state, names, mode) {
    const st = state.status;
    if (!Op || !Op.inProgress(st)) return m;
    const name = Op.opName(st);
    const gated = { ...m };
    for (const k of ['undo', 'redo']) {
      if (!m[k].disabled) gated[k] = off(`${names[k]} is unavailable while a ${name} is in progress`);
    }
    if (mode !== 'fetch') gated.pull = off(Op.inProgressTitle(names.pull, st));
    gated.pullMenu = off(Op.inProgressTitle(names.pullMenu, st));
    gated.push = off(Op.inProgressTitle(names.push, st));
    for (const k of ['branch', 'stash', 'pop', 'switcher']) gated[k] = off(Op.finishFirstTitle(names[k], st));
    return gated;
  }

  // Flows that start an operation which can't run while another is in progress, with the action
  // name for their disabled title (fetch, setUpstream, stashDrop and openTerminal are fine).
  const START_FLOWS = Object.freeze({
    checkout: 'Checkout', createBranch: 'Branch', deleteBranch: 'Delete branch', deleteBranches: 'Delete branches', push: 'Push', pull: 'Pull',
    stashSave: 'Stash', stashPop: 'Pop stash', stashApply: 'Apply stash', merge: 'Merge', rebase: 'Rebase',
    interactiveRebase: 'Interactive rebase', undo: 'Undo', redo: 'Redo',
  });

  // Flows that need a working tree (an index, files, a checkout), with the action name for their
  // disabled title: refused in a bare repository, in the menus (gateItems) and in the flow wrapper
  // (flows-kit.js, which covers double-clicks and shortcuts). Main refuses the ops too (kind 'bare-repo').
  const WORKTREE_FLOWS = Object.freeze({
    checkout: 'Checkout', stashSave: 'Stash', stashPop: 'Pop stash', stashApply: 'Apply stash', stashDrop: 'Drop stash',
    merge: 'Merge', rebase: 'Rebase', interactiveRebase: 'Interactive rebase', startInteractiveRebase: 'Interactive rebase',
    reloadInteractiveRebase: 'Interactive rebase', rebaseContinue: 'Continue rebase', rebaseSkip: 'Skip commit',
    rebaseAbort: 'Abort rebase', mergeCommit: 'Commit merge', mergeAbort: 'Abort merge', restoreAutostash: 'Restore stash',
    resolveWith: 'Resolve conflicts',
    // flows-worktree.js (the WIP panel and the diff view)
    stage: 'Stage', stageAll: 'Stage all', unstage: 'Unstage', unstageAll: 'Unstage all', discard: 'Discard',
    markResolved: 'Mark resolved', commit: 'Commit', stageSelection: 'Stage', unstageSelection: 'Unstage',
    discardSelection: 'Discard',
  });

  const isBare = (state) => !!(state && state.repo && state.repo.bare);
  const bareTitle = (action) => `${action} — needs a working tree (bare repository)`;

  /**
   * The disabled title of flow `flow` (called with `args`) in a bare repository, or null when it can
   * run: every WORKTREE_FLOWS flow, and pull in any mode but 'fetch' (no mode: the flow's default,
   * which is Fetch All in a bare repository).
   */
  function bareBlocked(state, flow, args) {
    if (!isBare(state)) return null;
    if (Object.hasOwn(WORKTREE_FLOWS, flow)) return bareTitle(WORKTREE_FLOWS[flow]);
    const mode = args && args[0];
    if (flow === 'pull' && typeof mode === 'string' && mode !== 'fetch') return bareTitle('Pull');
    return null;
  }

  /**
   * The disabled title of flow `flow` (called with `args`) while a rebase / merge / … is in progress
   * (status.state), or null when it can run: every START_FLOWS flow ("Checkout — finish or abort the
   * rebase first"; push and pull: "Push — a rebase is in progress"), except a pull in Fetch All mode
   * (no mode: state.pullMode). The menus (gateItems) and the flow wrapper (flows-kit.js: double-clicks,
   * shortcuts) share it; main refuses the ops too (kind 'in-progress').
   */
  function opBlocked(state, flow, args) {
    const st = state && state.status;
    if (!Op || !Op.inProgress(st) || !Object.hasOwn(START_FLOWS, flow)) return null;
    const what = START_FLOWS[flow];
    if (flow === 'pull') {
      const mode = args && typeof args[0] === 'string' ? args[0] : state.pullMode;
      return mode === 'fetch' ? null : Op.inProgressTitle(what, st);
    }
    return flow === 'push' ? Op.inProgressTitle(what, st) : Op.finishFirstTitle(what, st);
  }

  /** True when the repository has no commits at all (HEAD unborn and no local branch). */
  const unbornRepo = (state) => !headView(state).oid && !((state.refs && state.refs.local) || []).length;

  /**
   * Apply availability()'s rules to context-menu descriptors (same titles as the toolbar):
   *   fetch                 disabled without remotes
   *   push (current branch) availability().push: no remotes, unborn branch, detached HEAD
   *   push {branch: other}  disabled without remotes (HEAD doesn't matter for another branch)
   *   createBranch          without a start: availability().branch; with one: disabled on an unborn repo
   *   WORKTREE_FLOWS, pull  in a bare repository (bareBlocked): disabled with bareTitle(), even when
   *                         already disabled for another reason (it is the reason that always holds)
   * Other descriptors already disabled keep their own reason.
   */
  function gateItems(descs, state) {
    if (!state || !state.repo) return descs || [];
    const a = availability({ ...state, busy: false });
    const current = headView(state).branch;
    const remotes = hasRemotes(state);
    return (descs || []).map((d) => {
      if (d.separator) return d;
      const bare = bareBlocked(state, d.flow, d.args);
      if (bare) return { ...d, disabled: true, title: bare };
      if (d.disabled) return d;
      const block = (title) => ({ ...d, disabled: true, title });
      const op = opBlocked(state, d.flow, d.args);
      if (op) return block(op);
      if (d.flow === 'fetch' && a.fetch.disabled) return block(a.fetch.title);
      if (d.flow === 'push') {
        const o = (d.args && d.args[0]) || {};
        const other = typeof o.branch === 'string' && o.branch && o.branch !== current;
        if (other) return remotes ? d : block(`Push — ${NO_REMOTES}`);
        return a.push.disabled ? block(a.push.title) : d;
      }
      if (d.flow === 'createBranch') {
        const o = (d.args && d.args[0]) || {};
        if (!o.start) return a.branch.disabled ? block(a.branch.title) : d;
        return unbornRepo(state) ? block('Branch — the repository has no commits yet') : d;
      }
      return d;
    });
  }

  /**
   * The Pull button's mode: Fetch All in a bare repository (nothing to pull into; the stored choice
   * stays for later), else `stored` (the per-repo default: PLFlows.pullMode's storage, or
   * state.pullMode) when it is one of PULL_MODES, else DEFAULT_PULL_MODE.
   */
  function effectivePullMode(state, stored) {
    if (isBare(state)) return 'fetch';
    return PULL_MODES.includes(stored) ? stored : DEFAULT_PULL_MODE;
  }

  // ---------------------------------------------------------------- keyboard shortcuts

  // The global shortcuts are the Components.actions.KEYS entries with a `flow` (⌘Z undo, ⌘⇧Z redo,
  // ⌘L fetch, ⌘B new branch; Ctrl elsewhere), matched by Components.actions.matchKey and gated by
  // availability()[entry.gate] like the toolbar buttons. Both are looked up on Components.actions
  // when a key is pressed (a test may replace it): without it there are no shortcuts.

  /** {entry, gate}: the pressed global shortcut and its availability entry ({disabled, title} or null). */
  function shortcutState(e, state, ctx) {
    const A = window.Components && window.Components.actions;
    if (!A || typeof A.matchKey !== 'function' || !state || !state.repo) return null;
    const entry = A.matchKey(e);
    if (!entry || !entry.flow || (ctx && ctx.inField && !entry.inField)) return null;
    const all = typeof A.availability === 'function' ? A.availability(state, ctx || {}) : null;
    return { entry, gate: (all && all[entry.gate]) || null };
  }

  /**
   * The flow a keydown runs ('undo' | 'redo' | 'fetch' | 'createBranch'), or null: not a global
   * shortcut, no repo, ⌘Z / ⌘⇧Z with ctx.inField, or disabled by availability(state, ctx) (ctx:
   * {dirty, pullMode, inField}). A key repeat still matches: the caller swallows it (repeatBlocked).
   */
  function shortcutFor(e, state, ctx) {
    const s = shortcutState(e, state, ctx);
    return s && !(s.gate && s.gate.disabled) ? s.entry.flow : null;
  }

  /** The availability title of a pressed shortcut that is disabled (for a notice), else null. */
  function shortcutBlocked(e, state, ctx) {
    const s = shortcutState(e, state, ctx);
    return s && s.gate && s.gate.disabled ? String(s.gate.title || 'Not available right now') : null;
  }

  const api = {
    BUSY_TITLE, FREE_FLOWS, START_FLOWS, WORKTREE_FLOWS, PULL_MODES, DEFAULT_PULL_MODE,
    isBare, bareTitle, bareBlocked, opBlocked, effectivePullMode, hasRemotes, headView, availability, gateItems,
    shortcutFor, shortcutBlocked,
  };
  if (typeof window !== 'undefined') window.PLPolicy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
