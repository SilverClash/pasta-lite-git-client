'use strict';
// The context-menu descriptors of the toolbar, sidebar and graph (plain script; exposes
// window.PLMenus, and module.exports under node for the tests; loads after policy.js and menu.js,
// before actions.js, which re-exports all of it as Components.actions). Pure, no DOM.
//
// Descriptors: {label, flow, args, danger?, disabled?, title?, checked?} | {separator: true} (see
// actions.js). Labels and titles are display-safe (util.displayName).
//
//   refMenuItems(ref, state, flows?) -> finished descriptors for a branch / tag (sidebar rows and graph
//                                   ref pills): checkout, push, create branch, set upstream, delete, fetch,
//                                   and "Merge <x> into <cur>" / "Rebase <cur> onto <x>" (the current
//                                   branch moves, never x) / "Rebase <cur> onto <upstream>", each rebase
//                                   with its "Interactive Rebase <cur> onto <x>" (docs/plans/rebase.md
//                                   §5.1); a no-op onto a local branch behind its upstream says so
//   commitOpItems(hash, state) -> "Rebase / Interactive Rebase <cur> onto this commit" / "Merge this commit
//                                   into <cur>" outside HEAD's loaded history, "Interactive Rebase <n> children
//                                   of <sha7>" inside it (unfinished descriptors)
//   commitItems(hash, state, flows?) -> finished descriptors of a graph commit row: check out the commit,
//                                   create a branch there, commitOpItems, check out each local branch at it
//   stashMenuItems(entry, state, flows?) -> finished Apply / Pop / Drop of a stash (git.stashes() item)
//   checkoutItem({target, kind, label?, title?, current?, state?}) -> the one checkout descriptor (current:
//                                   disabled, "Already checked out"; with state, a branch checked out in
//                                   another worktree: disabled with checkoutRefusal's title)
//   checkoutRefusal(name, state, {kind?}) -> {title} | null   "Checked out in worktree <path>" when another
//                                   worktree (state.worktrees, not the current one) has the branch (a remote
//                                   branch: its local one); the checkout double-clicks check it too
//   createHere(ref) -> "Create branch here…"
//   upstreamTarget(state, name), behindOf(state, name), deleteItem(ref, state), fullRef(kind, name)
//   deleteRefusal(name, state, {current?}) -> {why, title} | null   why a local branch can't be deleted
//                                   (deleteItem, deletableBranches and the delete flows)
//   deletableBranches(names, state) -> {names, skipped: [{name, why, title}]}   what a bulk delete removes
//   deleteBranchesItem(names, state, {label?(n), flows?}) -> the finished "Delete N branches" descriptor
//                                   (sidebar multi-selection and folder menus; N: the deletable ones)
//   worktreeRefusal(w, action) -> {title} | null   why linked-worktree entry `w` (a state.worktrees
//                                   item) can't be opened / revealed / locked / unlocked / deleted / pruned
//   worktreeMenuItems(w, state, flows?, {platform?}?) -> finished descriptors of a sidebar worktree row: Open,
//                                   Reveal (Finder / Explorer / File Manager), Copy Path, Lock… / Unlock,
//                                   Prune… (a prunable one), Delete…
// "Finished": gated (PLPolicy.gateItems) and disabled while busy or without their flow
// (Components.actions.finishItems, looked up when a menu is built: actions.js loads after this script).
(function () {
  const C = window.Components;
  const { displayName, plural, short, OID_RE } = C.util;
  // Node tests that load this script alone get the models from their files.
  const need = (name, file) => window[name] || (typeof module !== 'undefined' && typeof require === 'function' ? require(file) : null);
  const Op = need('PLOp', './op-model.js');
  const P = need('PLPolicy', './policy.js');
  // The interactive rebase limit (500, rebasePlan's) lives in the rebase model (components/rebase-model.js).
  const Rebase = need('PLRebase', './components/rebase-model.js');
  const History = need('PLHistory', './history-model.js');
  const { headView, gateItems, isBare } = P;
  const flowsOf = () => (typeof window !== 'undefined' ? window.PLFlows : undefined);

  /** Gate, then finish (busy, missing flow: Components.actions.finishItems). */
  const finish = (descs, state, flows) => C.actions.finishItems(gateItems(descs, state), state, flows);

  /**
   * The checkout descriptor: of a local / remote branch (name) or a commit (full sha); `current`:
   * already there. With `state` (store state), a branch checked out in another worktree is disabled
   * with checkoutRefusal's reason.
   */
  function checkoutItem({ target, kind, label = 'Checkout', title, current = false, state = null }) {
    const d = { label, flow: 'checkout', args: [{ target, kind }], ...(title ? { title } : {}) };
    if (current) return { ...d, disabled: true, title: 'Already checked out' };
    const no = state ? checkoutRefusal(target, state, { kind }) : null;
    return no ? { ...d, disabled: true, title: no.title } : d;
  }

  /**
   * The state.worktrees entry (kept by the store for every repository) of another worktree that has
   * local branch `name` checked out, or null: never the bare entry, nor this tab's own worktree
   * (current: decided in main), whose branch is the checked-out one. deleteRefusal and
   * checkoutRefusal share it. A branch mid-rebase or mid-bisect in another worktree is listed as
   * detached there (no `branch`), so it isn't found: git's refusal is the backstop for it.
   */
  function worktreeHolding(name, state) {
    const list = state && Array.isArray(state.worktrees) ? state.worktrees : [];
    return list.find((w) => w && !w.bare && !w.current && w.branch === name) || null;
  }

  /**
   * Why branch `name` can't be checked out here, or null: {title} 'Checked out in worktree <path>'
   * (display-safe) when another worktree has it (git refuses: kind 'checked-out-elsewhere' stays
   * the backstop when state.worktrees is stale). kind 'remote' ('origin/x'): its local branch
   * ('x', which the checkout would switch to) is checked, when state.refs lists the remote branch
   * (a remote name may contain '/', so the name is never split; unlisted: null, git decides); a
   * commit never is. Used by checkoutItem
   * (the menus, the branch switcher) and the double-clicks (sidebar rows, graph ref pills).
   */
  function checkoutRefusal(name, state, { kind = 'local' } = {}) {
    if (typeof name !== 'string' || !name || kind === 'commit') return null;
    let branch = name;
    if (kind === 'remote') {
      const r = ((state && state.refs && state.refs.remote) || []).find((x) => x.name === name);
      if (!r || !r.branch) return null;
      branch = r.branch;
    }
    const wt = worktreeHolding(branch, state);
    return wt ? { title: `Checked out in worktree ${displayName(wt.path)}` } : null;
  }


  // What the merge / rebase flows get as their target: a full refname (never ambiguous between a
  // local branch 'origin/x' and the remote branch, or a branch and a tag of the same name; the same
  // rule as pull's merge) or a full sha. The backend resolves it to a commit (commitId).
  const REF_PREFIX = { local: 'refs/heads/', remote: 'refs/remotes/', tag: 'refs/tags/' };
  const fullRef = (kind, name) => `${REF_PREFIX[kind] || ''}${name}`;

  /** '<cur>' in menu labels: the checked-out branch's display name, 'HEAD' when detached or unknown. */
  const currentName = (state) => { const b = headView(state).branch; return b ? displayName(b) : 'HEAD'; };

  /** Loaded ancestors of HEAD / of `sha` (PLHistory), or null: unknown. */
  const headAncestors = (state) => History.headAncestors(state);
  const ancestorsOf = (state, sha) => History.ancestorsOf(state.commits, sha);

  /**
   * "Merge <x> into <cur>" / "Rebase <cur> onto <x>" descriptors for target t = {arg, oid, label, behind?}
   * (arg: the ref name or full sha the flow gets; label display-safe; behind: behindOf()). Disabled
   * with the reason when HEAD has no commits, or when the loaded history already shows the op is a
   * no-op (Components.menu shows a disabled item's reason under its label).
   * Flows: merge(store, {target, expectHead}), rebase(store, {onto, expectHead}).
   */
  // A no-op the loaded history shows (already contains / already based on) is disabled with that
  // reason, except while an operation is in progress: gateItems' "finish or abort … first" wins then.
  // A no-op onto a local branch behind its upstream (t.behind, behindOf) points at the upstream.
  const behindText = (t, verb) => (t.behind ? ` — ${t.behind.text}: ${verb} ${t.behind.up} instead` : '');
  const noOp = (d, state, title) => (Op && Op.inProgress(state.status) ? d : { ...d, disabled: true, title });

  function mergeItem(t, state, { label } = {}) {
    const { oid } = headView(state);
    const cur = currentName(state);
    const d = { label: label || `Merge ${t.label} into ${cur}`, flow: 'merge', args: [{ target: t.arg, expectHead: oid }] };
    if (!oid) return { ...d, disabled: true, title: `Merge — ${cur} has no commits yet` };
    const anc = headAncestors(state);
    if (t.oid && (t.oid === oid || (anc && anc.has(t.oid)))) return noOp(d, state, `${cur} already contains ${t.label}${behindText(t, 'merge')}`);
    return { ...d, title: `Merge ${t.label} into ${cur} (fast-forward when possible)` };
  }

  function rebaseItem(t, state, { label } = {}) {
    const { oid } = headView(state);
    const cur = currentName(state);
    const d = { label: label || `Rebase ${cur} onto ${t.label}`, flow: 'rebase', args: [{ onto: t.arg, expectHead: oid }] };
    if (!oid) return { ...d, disabled: true, title: `Rebase — ${cur} has no commits yet` };
    const anc = headAncestors(state);
    if (t.oid && (t.oid === oid || (anc && anc.has(t.oid)))) return noOp(d, state, `${cur} is already based on ${t.label}${behindText(t, 'rebase onto')}`);
    return { ...d, title: `Replay ${cur}'s own commits on top of ${t.label}` };
  }

  /**
   * "Interactive Rebase <cur> onto <x>" for target t = {arg, oid, label}: edits the commits x..HEAD and
   * replays them onto x (x may already be in HEAD's history: then only those commits are edited).
   * Disabled when HEAD has no commits, is x, or is in x's loaded history (nothing of its own to edit).
   * Flow: interactiveRebase(store, {upstream, expectHead}).
   */
  function interactiveItem(t, state, { label } = {}) {
    const { oid } = headView(state);
    const cur = currentName(state);
    const d = { label: label || `Interactive Rebase ${cur} onto ${t.label}`, flow: 'interactiveRebase', args: [{ upstream: t.arg, expectHead: oid }] };
    if (!oid) return { ...d, disabled: true, title: `Interactive rebase — ${cur} has no commits yet` };
    const theirs = t.oid ? ancestorsOf(state, t.oid) : null;
    if (t.oid && (t.oid === oid || (theirs && theirs.has(oid)))) return noOp(d, state, `${cur} has no commits of its own to rebase onto ${t.label}`);
    return { ...d, title: `Pick, reword, squash, reorder or drop ${cur}'s own commits, replayed on top of ${t.label}` };
  }

  /**
   * "Interactive Rebase <n> children of <sha7>" for a commit in HEAD's loaded history (not HEAD): edits
   * the n commits after it. null for HEAD itself or outside the history; disabled with the reason when
   * the range has merge commits or more than IR_LIMIT commits. The flow re-reads the range (rebasePlan).
   */
  const IR_LIMIT = Rebase.MAX_ROWS;
  function childrenItem(hash, state) {
    const { oid } = headView(state);
    const mine = headAncestors(state);
    const theirs = ancestorsOf(state, hash);
    if (!oid || hash === oid || !mine || !mine.has(hash) || !theirs) return null;
    const range = (state.commits || []).filter((c) => mine.has(c.hash) && !theirs.has(c.hash));
    const n = range.length;
    const d = {
      label: `Interactive Rebase ${plural(n, 'child', 'children')} of ${short(hash)}`,
      flow: 'interactiveRebase', args: [{ upstream: hash, expectHead: oid }],
      title: `Pick, reword, squash, reorder or drop the ${plural(n, 'commit')} after ${short(hash)}`,
    };
    const merges = range.filter((c) => (c.parents || []).length > 1).length;
    if (merges) return { ...d, disabled: true, title: `The ${plural(n, 'commit')} after ${short(hash)} include ${plural(merges, 'merge commit')}: interactive rebase can't keep merges yet` };
    if (n > IR_LIMIT) return { ...d, disabled: true, title: `Interactive rebase is limited to ${IR_LIMIT} commits (there are ${n} after ${short(hash)})` };
    return d;
  }

  /** The configured upstream of local branch `name` as a menu target {arg, oid, label, gone}, or null. */
  function upstreamTarget(state, name) {
    const refs = state && state.refs;
    const b = refs && (refs.local || []).find((x) => x.name === name);
    if (!b || !b.upstream) return null;
    const remote = (refs.remote || []).find((x) => x.name === b.upstream);
    const r = remote || (refs.local || []).find((x) => x.name === b.upstream);
    return { arg: fullRef(remote ? 'remote' : 'local', b.upstream), oid: r ? r.oid : null, label: displayName(b.upstream), gone: !!b.gone || !r };
  }

  /**
   * The "why" of a no-op Merge / Rebase onto local branch `name` when its upstream is ahead of it (the
   * user usually means the upstream then): {text: "main is 2 behind origin/main", up: 'origin/main'}
   * (display-safe), or null (no upstream, gone, not behind).
   */
  function behindOf(state, name) {
    const b = ((state.refs && state.refs.local) || []).find((x) => x.name === name);
    if (!b || !b.upstream || b.gone || !(b.behind > 0)) return null; // NOSONAR(S1940): also true when behind is missing (<= 0 would not be)
    const up = displayName(b.upstream);
    return { text: `${displayName(name)} is ${b.behind} behind ${up}`, up };
  }

  /**
   * Context menu descriptors for a branch or tag: ref = {kind: 'local'|'remote'|'tag', name, oid,
   * current, remote?} (the sidebar's rowTarget, or a graph ref pill). Shared by the sidebar rows and
   * the graph's ref pills (docs/plans/rebase.md §5.1). Finished: gated (gateItems) and disabled while
   * busy or without their flow (finishItems).
   */
  function refMenuItems(ref, state, flows = flowsOf()) {
    if (!ref || !state) return [];
    const build = REF_MENUS[ref.kind];
    return build ? finish(build(ref, state, flows), state, flows) : [];
  }

  /** The unfinished descriptors of refMenuItems, per ref kind. */
  const REF_MENUS = {
    local(ref, state, flows) {
      const t = { arg: fullRef('local', ref.name), oid: ref.oid, label: displayName(ref.name), behind: ref.current ? null : behindOf(state, ref.name) };
      const up = ref.current ? upstreamTarget(state, ref.name) : null;
      const gone = (d) => (up && up.gone && !d.disabled ? { ...d, disabled: true, title: `The upstream ${up.label} is gone` } : d);
      let ops = [];
      if (!ref.current) ops = [mergeItem(t, state), rebaseItem(t, state), interactiveItem(t, state), { separator: true }];
      else if (up) ops = [gone(rebaseItem(up, state)), gone(interactiveItem(up, state)), { separator: true }];
      return [
        checkoutItem({ target: ref.name, kind: 'local', current: ref.current, state }),
        { label: 'Push', flow: 'push', args: [ref.current ? {} : { branch: ref.name }] },
        createHere(ref),
        ...(flows && typeof flows.setUpstream === 'function' ? [{ label: 'Set upstream…', flow: 'setUpstream', args: [ref.name] }] : []),
        { separator: true },
        ...ops,
        deleteItem(ref, state),
      ];
    },
    remote(ref, state) {
      const t = { arg: fullRef('remote', ref.name), oid: ref.oid, label: displayName(ref.name) };
      return [
        checkoutItem({ target: ref.name, kind: 'remote', state }),
        createHere(ref),
        ...(ref.remote ? [{ label: `Fetch ${displayName(ref.remote)}`, flow: 'fetch', args: [{ remote: ref.remote }] }] : []),
        { separator: true },
        mergeItem(t, state),
        rebaseItem(t, state),
        interactiveItem(t, state),
      ];
    },
    tag(ref, state) {
      const t = { arg: fullRef('tag', ref.name), oid: ref.oid, label: displayName(ref.name) };
      return [
        checkoutItem({ target: ref.oid, kind: 'commit', title: 'Check out the tagged commit (detached HEAD)' }),
        createHere(ref),
        { separator: true },
        rebaseItem(t, state),
        interactiveItem(t, state),
        mergeItem(t, state),
      ];
    },
  };

  const createHere = (ref) => ({ label: 'Create branch here…', flow: 'createBranch', args: [{ start: ref.oid }] });

  /**
   * Why local branch `name` can't be deleted, or null: {why, title} (display-safe). `why` is short
   * ('checked out', 'HEAD of the bare repository', 'checked out in the worktree <path>'), `title` the
   * menu item's reason. Refused: the checked-out branch (in a bare repository: the branch HEAD points
   * at; `current` also counts the caller's ref as it) and a branch checked out in a linked worktree
   * (state.worktrees: kept by the store for every repository, re-read by the delete flows; git
   * refuses to delete it). The one source for deleteItem and deletableBranches.
   */
  function deleteRefusal(name, state, { current = false } = {}) {
    const s = state || {};
    const b = ((s.refs && s.refs.local) || []).find((x) => x.name === name);
    if (current || (b && b.current) || name === headView(s).branch) {
      return isBare(s)
        ? { why: 'HEAD of the bare repository', title: 'HEAD of the bare repository points at this branch: it can’t be deleted' }
        : { why: 'checked out', title: 'The checked-out branch can’t be deleted: check out another branch first' };
    }
    const wt = worktreeHolding(name, s);
    if (!wt) return null;
    const why = `checked out in the worktree ${displayName(wt.path)}`;
    return { why, title: `${displayName(name)} is ${why}: it can’t be deleted` };
  }

  /** "Delete" of local branch ref: disabled with deleteRefusal's reason. */
  function deleteItem(ref, state) {
    const d = { label: 'Delete', flow: 'deleteBranch', args: [ref.name], danger: true };
    const no = deleteRefusal(ref.name, state, { current: ref.current });
    return no ? { ...d, disabled: true, title: no.title } : d;
  }

  /**
   * The local branches of `names` a bulk delete removes, and the ones it leaves out (deleteRefusal):
   * {names, skipped: [{name, why, title}]}. Order kept, duplicates dropped.
   */
  function deletableBranches(names, state) {
    const out = { names: [], skipped: [] };
    for (const name of new Set((names || []).filter((n) => typeof n === 'string' && n))) {
      const no = deleteRefusal(name, state);
      if (no) out.skipped.push({ name, ...no });
      else out.names.push(name);
    }
    return out;
  }

  /**
   * The one "Delete N branches" descriptor (finished) of local branches `names` (a multi-selection,
   * a sidebar folder): flow deleteBranches with all of them (the flow says which it leaves out).
   * N counts the ones it deletes (deletableBranches); none: disabled with the reason. `label(n)`
   * replaces the default label.
   */
  function deleteBranchesItem(names, state, { label, flows = flowsOf() } = {}) {
    const list = [...new Set(names || [])];
    const { names: ok, skipped } = deletableBranches(list, state);
    const n = ok.length || list.length;
    const d = { label: label ? label(n) : `Delete ${plural(n, 'branch', 'branches')}`, flow: 'deleteBranches', args: [list], danger: true };
    const off = ok.length ? d : {
      ...d, disabled: true,
      title: skipped.length === 1 ? skipped[0].title : 'None of these branches can be deleted',
    };
    return finish([off], state || {}, flows)[0];
  }

  /**
   * The merge / rebase descriptors of a graph commit row (unfinished: the caller gates and finishes
   * them with its other items): outside HEAD's loaded history "Rebase <cur> onto this commit" /
   * "Interactive Rebase <cur> onto this commit" / "Merge this commit into <cur>"; inside it (HEAD
   * excluded) "Interactive Rebase <n> children of <sha7>"; nothing for HEAD or without a HEAD commit.
   */
  function commitOpItems(hash, state) {
    const { oid } = headView(state || {});
    if (!state || !oid || !OID_RE.test(String(hash || ''))) return [];
    const anc = headAncestors(state);
    if (hash === oid) return [];
    if (anc && anc.has(hash)) {
      const d = childrenItem(hash, state);
      return d ? [d] : [];
    }
    const t = { arg: hash, oid: hash, label: short(hash) };
    const cur = currentName(state);
    return [
      rebaseItem(t, state, { label: `Rebase ${cur} onto this commit` }),
      interactiveItem(t, state, { label: `Interactive Rebase ${cur} onto this commit` }),
      mergeItem(t, state, { label: `Merge this commit into ${cur}` }),
    ];
  }


  /**
   * The descriptors of graph commit row `hash`: check out the commit (detached), create a branch there,
   * "Rebase <cur> onto this commit" / "Merge this commit into <cur>" for a commit outside HEAD's history
   * (commitOpItems), and check out each local branch pointing at it. Finished. state: store state
   * ({refsBySha, refs, commits, busy, repo, status, remotes}).
   */
  function commitItems(hash, state, flows) {
    const head = state && state.refs && state.refs.head;
    const atHead = !!(head && head.detached && head.oid === hash);
    const items = [
      checkoutItem({ target: hash, kind: 'commit', label: 'Checkout this commit', title: 'Detached HEAD at this commit', current: atHead }),
      createHere({ oid: hash }),
    ];
    const ops = commitOpItems(hash, state);
    if (ops.length) items.push({ separator: true }, ...ops);
    const locals = ((state && state.refsBySha && state.refsBySha.get(hash)) || []).filter((r) => r.type === 'local');
    if (locals.length) items.push({ separator: true });
    for (const r of locals) items.push(checkoutItem({ target: r.name, kind: 'local', label: `Checkout ${displayName(r.name)}`, current: r.current, state }));
    return finish(items, state, flows);
  }

  /** Apply / Pop / Drop of a stash entry (git.stashes() item; the flows get its commit hash). Finished. */
  function stashMenuItems(entry, state, flows) {
    if (!entry) return [];
    return finish([
      { label: 'Apply', flow: 'stashApply', args: [entry.hash] },
      { label: 'Pop', flow: 'stashPop', args: [entry.hash] },
      { separator: true },
      { label: 'Drop', flow: 'stashDrop', args: [entry.hash], danger: true },
    ], state, flows);
  }

  const dn = displayName;

  /**
   * Why worktree `w` (a state.worktrees entry) can't take `action` ('open', 'reveal', 'lock', 'unlock'
   * or 'delete'), or null: {title} (display-safe). The renderer's mirror of main's safety checks (main
   * re-checks them; a rebase or merge in progress there is refused by main alone: worktree-busy).
   * `missing` (the folder is gone; git marks only unlocked ones prunable) counts like prunable for
   * Open and Reveal.
   */
  function worktreeRefusal(w, action) {
    if (!w) return null;
    const gone = !!(w.prunable || w.missing);
    switch (action) {
      case 'open':
        if (w.current) return { title: 'This tab has this worktree open' };
        if (w.bare) return { title: 'The bare repository has no working tree to open' };
        if (w.prunable) return { title: 'Its folder is gone: prune it' };
        if (w.missing) return { title: 'Its folder is gone' };
        return null;
      case 'reveal':
        return gone ? { title: 'Its folder is gone' } : null;
      case 'lock':
      case 'unlock':
        if (w.bare) return { title: 'The bare repository has no worktree folder to lock' };
        return w.main ? { title: "The main worktree can't be locked" } : null;
      case 'delete':
        if (w.bare) return { title: "The bare repository can't be deleted here" };
        if (w.main) return { title: "The main worktree can't be deleted" };
        if (w.current) return { title: 'This tab has this worktree open: open another worktree and delete it from there' };
        if (w.locked) return { title: `Locked${w.lockReason ? ` (${dn(w.lockReason)})` : ''}: unlock it first` };
        if (w.prunable) return { title: 'Its folder is already gone: use Prune' };
        if (w.missing) return { title: 'Its folder is gone: Prune is offered once git marks it prunable' };
        return null;
      default:
        return null;
    }
  }

  /** The reveal item's label for `platform` ('darwin' | 'win32' | other); default: the running one. */
  function revealLabel(platform) {
    const p = platform || (C.util.IS_MAC ? 'darwin' : (typeof navigator !== 'undefined' && /Win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.userAgent || '') ? 'win32' : 'linux'));
    if (p === 'darwin') return 'Reveal in Finder';
    return p === 'win32' ? 'Show in Explorer' : 'Show in File Manager';
  }

  /** The finished context menu of worktree entry `w` (see the header). */
  function worktreeMenuItems(w, state, flows = flowsOf(), { platform } = {}) {
    if (!w) return [];
    const off = (d, no) => (no ? { ...d, disabled: true, title: no.title } : d);
    const open = off({ label: 'Open', flow: 'openWorktree', args: [w.path], title: 'Show the tab that has it open, else open it in a new tab' }, worktreeRefusal(w, 'open'));
    const reveal = off({ label: revealLabel(platform), flow: 'revealWorktree', args: [w.path] }, worktreeRefusal(w, 'reveal'));
    const items = [
      open,
      reveal,
      { label: 'Copy Path', flow: 'copyWorktreePath', args: [w.path] },
      { separator: true },
      off(w.locked
        ? { label: 'Unlock', flow: 'unlockWorktree', args: [w.path] }
        : { label: 'Lock…', flow: 'lockWorktree', args: [w.path] }, worktreeRefusal(w, w.locked ? 'unlock' : 'lock')),
    ];
    if (w.prunable) items.push({ label: 'Prune…', flow: 'pruneWorktrees', args: [] });
    items.push({ separator: true }, off({ label: 'Delete…', flow: 'removeWorktree', args: [w.path], danger: true }, worktreeRefusal(w, 'delete')));
    return finish(items, state || {}, flows);
  }

  const api = {
    worktreeRefusal, worktreeMenuItems,
    refMenuItems, commitOpItems, commitItems, stashMenuItems, checkoutItem, checkoutRefusal, createHere, upstreamTarget, behindOf, deleteItem, fullRef,
    deleteRefusal, deletableBranches, deleteBranchesItem,
  };
  if (typeof window !== 'undefined') window.PLMenus = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
