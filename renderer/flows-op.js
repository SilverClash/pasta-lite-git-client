'use strict';
// PLFlows for a rebase / merge in progress, and what the merge / rebase starts share (plain script;
// loads after flows-stash.js, adds its flows to window.PLFlows and its helpers to window.PLFlowKit).
// docs/plans/rebase.md §4 (ops, results, error kinds), §4.4 (continue / skip are cancellable, abort is
// not), §5.3 (wording), §5.4 (keep a side). Names are computed before the op: once it finishes, the
// rebase state they come from is gone.
//
// Flows (contract: flows-kit.js): rebaseContinue, rebaseSkip, rebaseAbort, mergeCommit, mergeAbort,
// restoreAutostash, resolveWith.
// Kit additions (flows-merge.js, flows-rebase.js): rebaseResult, opError, startError, finishedOf,
// startGuard, needClean, targetInfo, ancestors, publishedFacts, publishedWarning, offerForcePush,
// mergeStoppedNotice, START_QUIET (reportOutcome and the kept-stash wording are flows-kit.js').
// All git-derived text reaches the DOM through the dialogs / toasts (textContent only).
(function () {
  const K = window.PLFlowKit;
  const { C, settle, report, dialog, dn, short, Op, status, upstreamOf, stashNote, reportOutcome, forcePush } = K;

  const REBASE_QUIET = ['aborted', 'conflicts', 'dirty', 'not-rebasing', 'hook-failed', 'rebase-exec'];
  const MERGE_QUIET = ['conflicts', 'dirty', 'not-merging', 'hook-failed', 'nothing-to-commit'];

  const opState = (store) => Op().opStateOf(status(store));
  const rebaseNow = (store) => Op().rebaseStateOf(status(store));
  const namesNow = (store) => Op().rebaseNames(status(store), store.state.refsBySha);
  const conflictsNow = (store) => Op().conflictCount(status(store));

  /** The message to continue / conclude with: an explicit {message} (null: none), else the composer's draft for this stop. */
  function draftMessage(store, o) {
    if (o && Object.hasOwn(o, 'message')) return typeof o.message === 'string' ? o.message : null;
    const d = store.state.continueDraft;
    const key = Op().composerMode(status(store)).key;
    return d && d.key === key && typeof d.message === 'string' ? d.message : null;
  }

  const clearDraft = (store) => { if (store.state.continueDraft) store.actions.setContinueDraft(null); };

  /** The paths a keep-a-side request names: `paths`, or the one `path`. */
  function askedPaths(o) {
    if (Array.isArray(o.paths)) return o.paths;
    return typeof o.path === 'string' ? [o.path] : [];
  }

  /** "2 files are deleted, as main has no version of them. " ('' without deletions). */
  function deletedNote(n, name) {
    if (!n) return '';
    const one = n === 1;
    return `${C.util.plural(n, 'file')} ${one ? 'is' : 'are'} deleted, as ${name} has no version of ${one ? 'it' : 'them'}. `;
  }

  /** The message of a merge git refused, by error kind (others show git's own message). */
  const MERGE_REFUSALS = Object.freeze({
    'unrelated-histories': 'These branches have no commit in common (unrelated histories), so they are not merged.',
    'not-fast-forward': "The branches have diverged, so a fast-forward-only merge isn't possible.",
  });

  // ---------------------------------------------------------------- results

  /** The notes of a done RebaseResult: commits that became empty, cherry-picks already upstream. */
  function rebaseNotes(res, names) {
    const parts = [];
    const dropped = Array.isArray(res && res.dropped) ? res.dropped.length : 0;
    if (dropped) parts.push(`${C.util.plural(dropped, 'commit')} became empty and ${dropped === 1 ? 'was' : 'were'} dropped`);
    const skipped = res && Number.isInteger(res.skippedCherryPicks) ? res.skippedCherryPicks : 0;
    if (skipped) parts.push(`${C.util.plural(skipped, 'commit')} ${skipped === 1 ? 'was' : 'were'} already in ${names.onto} and ${skipped === 1 ? 'was' : 'were'} skipped`);
    return parts;
  }

  /**
   * Report a RebaseResult (done / stopped / up-to-date). Always true: the op ran. `headline`: the done
   * notice's first sentence (default "Rebased feat onto main").
   */
  async function rebaseResult(store, res, names, headline) {
    if (res && res.status === 'stopped') {
      store.actions.notify(Op().stoppedNotice(res.state || rebaseNow(store), status(store)));
      store.actions.select({ kind: 'wip' });
      return true;
    }
    if (res && res.status === 'up-to-date') {
      store.actions.notify(`${names.branch} is already up to date with ${names.onto}`);
      return true;
    }
    const first = headline || `Rebased ${names.branch} onto ${names.onto}`;
    await reportOutcome(store, res, { done: 'Rebased', notice: [first, ...rebaseNotes(res, names)].join('. ') });
    return true;
  }

  /** Why ops refused a continue / commit for unstaged changes (kind 'dirty'), per operation. */
  const DIRTY_WHY = {
    rebase: 'Stage or discard your unstaged changes before continuing: Continue Rebase commits only what is staged.',
    merge: 'Stage or discard your unstaged changes before committing the merge: your local changes from before the merge are in a stash and come back then, which needs a clean working tree.',
  };

  /** Explain a failed rebase / merge op (kinds of docs/plans/rebase.md §4.5). Resolves false. */
  async function opError(store, e, { what }) {
    const a = dialog(store).alert;
    switch (e.kind) {
      case 'aborted':
        store.actions.notify(`${what === 'merge' ? 'Merge' : 'Rebase'} stopped: continue or abort it`);
        break;
      case 'conflicts': {
        const n = Number.isInteger(e.count) ? e.count : conflictsNow(store);
        store.actions.notify(`Resolve and mark ${n > 0 ? `all ${C.util.plural(n, 'conflicted file')}` : 'every conflicted file'} resolved first`);
        break;
      }
      case 'dirty':
        await a({
          title: 'Unstaged changes',
          message: DIRTY_WHY[what] || String(e.message || ''),
          detail: pathsDetail(store, e),
        });
        break;
      case 'not-rebasing':
      case 'not-merging':
        store.actions.notify(`No ${what} is in progress`);
        break;
      case 'hook-failed':
        await a({
          title: 'A hook refused the commit',
          message: `A commit hook failed, so the ${what} stopped. Fix the problem, then continue${what === 'merge' ? '' : ', skip the commit'} or abort.`,
          detail: String(e.message || '').trim() || '(the hook printed nothing)',
        });
        break;
      case 'rebase-exec':
        await a({
          title: "Pasta Lite doesn't continue this rebase",
          message: `${Op().EXEC_TODO} If you trust where this repository came from, continue the rebase in a terminal (git rebase --continue); otherwise abort it.`,
        });
        break;
      default:
        report(store, e);
    }
    return false;
  }

  /** The paths of a 'dirty' refusal ({paths, count}) for an alert's detail ('' without any). */
  function pathsDetail(store, e) {
    const paths = Array.isArray(e.paths) ? e.paths : [];
    if (!paths.length) return '';
    const more = Number.isInteger(e.count) && e.count > paths.length ? `\nand ${e.count - paths.length} more` : '';
    return `${dialog(store).pathListText(paths)}${more}`;
  }

  // ---------------------------------------------------------------- in progress (R1)

  const OPS = {
    rebase: { state: 'rebasing', Title: 'Rebase' },
    merge: { state: 'merging', Title: 'Merge' },
  };

  /** Refuse a continue / skip / abort / commit when no `what` ('rebase' | 'merge') is in progress; true when one is. */
  function needOp(store, what) {
    if (opState(store) === OPS[what].state) return true;
    store.actions.notify(`No ${what} is in progress`);
    return false;
  }

  /** Refuse to conclude while files are still conflicted (a notice); true when none are. */
  function resolvedFirst(store) {
    const n = conflictsNow(store);
    if (n <= 0) return true;
    store.actions.notify(`Resolve and mark all ${C.util.plural(n, 'conflicted file')} resolved first`);
    return false;
  }

  /** "Merging origin/main into main" names: {name, into}. */
  function mergeNames(store) {
    const st = status(store);
    const m = Op().mergeStateOf(st);
    return { name: m && m.name ? dn(m.name) : null, into: st && st.branch ? dn(st.branch) : 'HEAD' };
  }

  async function rebaseContinueFlow(store, o) {
    if (!needOp(store, 'rebase') || !resolvedFirst(store)) return false;
    const names = namesNow(store);
    // A message only in the composer's 'continue' mode (a conflict or hook stop of the merge backend;
    // ops refuse it elsewhere, §4.3).
    const message = Op().composerMode(status(store)).mode === 'continue' ? draftMessage(store, o) : null;
    const { value: res, error } = await settle(store.actions.write('rebaseContinue', [message !== null ? { message } : {}], { quiet: REBASE_QUIET, cancellable: true }));
    if (error) return opError(store, error, { what: 'rebase' });
    clearDraft(store);
    return rebaseResult(store, res, names);
  }

  async function mergeCommitFlow(store, o) {
    if (!needOp(store, 'merge') || !resolvedFirst(store)) return false;
    const names = mergeNames(store);
    const message = draftMessage(store, o);
    const { value: res, error } = await settle(store.actions.write('mergeCommit', [message !== null ? { message } : {}], { quiet: MERGE_QUIET }));
    if (error) return opError(store, error, { what: 'merge' });
    clearDraft(store);
    await reportOutcome(store, res, { done: 'Merged', notice: names.name ? `Merged ${names.name} into ${names.into}` : 'Merge committed' });
    return true;
  }

  const EDIT_NO_SKIP = 'At an edit stop the commit is already made: continue the rebase to keep it, or abort the rebase';

  /** The Skip confirm for the stop the rebase is at (what is lost depends on it). */
  function skipConfirm(stop, what) {
    if (stop === 'empty') {
      return { message: `Skip ${what}? It has become empty (its changes are already in the branch), so nothing is lost.`, danger: false };
    }
    const lost = stop === 'conflict'
      ? 'Your edits to its conflicted files are discarded.'
      : 'The changes staged for it are discarded.';
    return { message: `Skip ${what}? Its changes will be left out of the rebased branch. ${lost}`, danger: true };
  }

  async function rebaseSkipFlow(store) {
    if (!needOp(store, 'rebase')) return false;
    const rb = rebaseNow(store);
    const stop = Op().stopOf(rb, status(store));
    if (stop === 'edit') { // git would drop the commit being edited; the banner offers no Skip there
      store.actions.notify(EDIT_NO_SKIP);
      return false;
    }
    const cur = rb && rb.current;
    let what = 'the current commit';
    if (cur && cur.subject) what = `'${dn(cur.subject)}'`;
    else if (cur && cur.sha) what = short(cur.sha);
    const text = skipConfirm(stop, what);
    const ok = await dialog(store).confirm({ title: 'Skip commit?', message: text.message, confirmLabel: 'Skip Commit', danger: text.danger });
    if (!ok) return false;
    const names = namesNow(store);
    const { value: res, error } = await settle(store.actions.write('rebaseSkip', [], { quiet: [...REBASE_QUIET, 'invalid-args'], cancellable: true }));
    if (error) return skipError(store, error);
    return rebaseResult(store, res, names);
  }

  /** A refused skip: other changes that skipping would throw away ('dirty'), an edit stop ('invalid-args'), else opError. */
  async function skipError(store, e) {
    if (e.kind === 'dirty') {
      await dialog(store).alert({
        title: "Can't skip the commit",
        message: 'Skipping resets the working tree to the commits rebased so far, which would throw away the changes below: they are not part of the stopped commit. Discard them, or copy them somewhere safe, then skip again.',
        detail: pathsDetail(store, e),
      });
      return false;
    }
    if (e.kind === 'invalid-args') {
      store.actions.notify(Op().stopOf(rebaseNow(store), status(store)) === 'edit' ? EDIT_NO_SKIP : String(e.message || 'The commit could not be skipped'));
      return false;
    }
    return opError(store, e, { what: 'rebase' });
  }

  /** The abort confirm and the notice after it, per operation (names read before the op). */
  const ABORTS = {
    rebase(store) {
      const rb = rebaseNow(store);
      const who = rb && rb.branch ? namesNow(store).branch : 'HEAD';
      const at = rb && rb.origHead ? short(rb.origHead) : null;
      return {
        message: `Abort the rebase? ${who} goes back to where it was before the rebase${at ? ` (${at})` : ''}. Changes made while resolving conflicts are discarded.`
          + `${rb && rb.autostash ? '\n\nYour local changes from before the rebase are re-applied.' : ''}`,
        notice: `Rebase aborted${at ? `: ${who} is back at ${at}` : ''}`,
      };
    },
    merge(store) {
      const names = mergeNames(store);
      const m = Op().mergeStateOf(status(store));
      return {
        message: `Abort the merge${names.name ? ` of ${names.name}` : ''}? ${names.into} goes back to where it was before the merge. Changes made while resolving conflicts are discarded.`
          + `${m && m.autostash ? '\n\nYour local changes from before the merge are re-applied.' : ''}`,
        notice: 'Merge aborted',
      };
    },
  };

  /** rebaseAbort / mergeAbort: danger confirm, then the op (not cancellable: §4.4), then its outcome. */
  function abortFlow(what) {
    const { Title } = OPS[what];
    return async (store) => {
      if (!needOp(store, what)) return false;
      const text = ABORTS[what](store);
      const ok = await dialog(store).confirm({ title: `Abort ${what}?`, message: text.message, confirmLabel: `Abort ${Title}`, danger: true });
      if (!ok) return false;
      // Not cancellable: stopping half-way would leave the changes neither in the tree nor re-applied (§4.4).
      const { value: res, error } = await settle(store.actions.write(`${what}Abort`, [], { quiet: what === 'merge' ? MERGE_QUIET : REBASE_QUIET }));
      if (error) return opError(store, error, { what });
      clearDraft(store);
      await reportOutcome(store, res, { done: `${Title} aborted`, notice: text.notice });
      return true;
    };
  }

  async function restoreAutostashFlow(store, o) {
    const keep = !!(o && o.keep);
    const sha = Op().pendingAutostashOf(status(store));
    if (!sha) {
      store.actions.notify('There is no stash left over from a rebase');
      return false;
    }
    // A failed re-apply is a result (res.stash), not an error: only the 'dirty' refusal throws.
    const { value: res, error } = await settle(store.actions.write('restoreAutostash', [{ keep }], { quiet: ['dirty'] }));
    if (error) {
      if (error.kind !== 'dirty') { report(store, error); return false; }
      await dialog(store).alert({
        title: "Couldn't restore your changes",
        message: `The working tree has changes now, so the stash (${short(sha)}) was not re-applied. Commit or stash them first, then restore it.`,
        detail: pathsDetail(store, error),
      });
      return false;
    }
    if (keep) {
      store.actions.notify(`Your changes stay in the stash (${short(sha)}): pop it from the Stashes list when you're ready`);
      return true;
    }
    await reportOutcome(store, res, {
      title: "Couldn't restore your changes",
      notice: res && res.restored === false ? `The stash ${short(sha)} was already gone` : 'Restored your changes from before the rebase',
    });
    return true;
  }

  // ---------------------------------------------------------------- keep a side (R2)

  /**
   * resolveWith(store, {paths, side}): keep one side's version of conflicted files during a rebase
   * or merge (ops resolveWith(path, side), one path at a time): side 'ours' | 'theirs', each entry
   * labelled by PLOp.resolveChoices ("Keep main's version", "Delete a.txt (main deleted it)", "Keep
   * a.txt"). Danger confirm that names deletions. A failure part-way names the files already resolved.
   */
  async function resolveWithFlow(store, o) {
    const side = o && o.side;
    const asked = o && askedPaths(o);
    if ((side !== 'ours' && side !== 'theirs') || !asked || !asked.length) return false;
    const st = status(store);
    const entries = ((st && st.conflicted) || []).filter((e) => asked.includes(e.path));
    if (!entries.length) {
      store.actions.notify(asked.length === 1 ? `${dn(asked[0])} is no longer conflicted` : 'These files are no longer conflicted');
      return false;
    }
    if (!Op().conflictSides(st, store.state.refsBySha)) {
      store.actions.notify('Keeping one version is only available while a rebase or merge is in progress');
      return false;
    }
    // Per entry: its choice for `side` ('DD' has one choice, a deletion, whichever key was used).
    const plan = entries.map((e) => {
      const list = Op().resolveChoices(st, store.state.refsBySha, e);
      return { entry: e, choice: list.find((c) => c.side === side) || list[0] };
    });
    if (!(await confirmResolve(store, plan, side, Op().conflictSides(st, store.state.refsBySha)))) return false;
    const done = [];
    for (const p of plan) {
      const { value, error } = await settle(store.actions.write('resolveWith', [p.entry.path, p.choice.side], { quiet: ['not-conflicted'] }));
      if (error && error.kind === 'not-conflicted') continue; // resolved meanwhile (a terminal, a late refresh)
      if (error) return resolvePartial(store, done, plan.length, error);
      done.push({ ...p, deleted: !!(value && value.deleted) || p.choice.deletes });
    }
    if (!done.length) {
      store.actions.notify(plan.length === 1 ? `${dn(plan[0].entry.path)} is no longer conflicted` : 'These files are no longer conflicted');
      return false;
    }
    store.actions.notify(done.length === 1 ? resolvedText(done[0]) : resolvedMany(done));
    return true;
  }

  /** "Deleted a.txt" / "Kept main's version of a.txt" / "Kept a.txt". */
  function resolvedText(d) {
    const path = dn(d.entry.path);
    if (d.deleted) return `Deleted ${path}`;
    return d.choice.why === `${d.choice.name}'s version` ? `Kept ${d.choice.name}'s version of ${path}` : `Kept ${path}`;
  }

  /** The notice for several resolved files: "Kept main's version of 3 files" / "Resolved 3 files: 1 deleted, 2 kept". */
  function resolvedMany(done) {
    const del = done.filter((d) => d.deleted).length;
    const { name } = done[0].choice;
    if (!del && done.every((d) => d.choice.why === `${name}'s version`)) return `Kept ${name}'s version of ${C.util.plural(done.length, 'file')}`;
    return `Resolved ${C.util.plural(done.length, 'file')}: ${[del ? `${del} deleted` : '', done.length > del ? `${done.length - del} kept` : ''].filter(Boolean).join(', ')}`;
  }

  /** The danger confirm of resolveWith: says exactly what happens to each file, deletions by name. */
  function confirmResolve(store, plan, side, sides) {
    const other = sides[side === 'ours' ? 'theirs' : 'ours'];
    const one = plan.length === 1;
    const dels = plan.filter((p) => p.choice.deletes);
    if (one) {
      const { entry, choice } = plan[0];
      const path = dn(entry.path);
      return dialog(store).confirm(choice.deletes
        ? {
          title: `Delete ${path}?`,
          message: `${path} is deleted from the working tree and the deletion is marked resolved (${choice.why}). ${other}'s version of it and your edits are discarded.`,
          confirmLabel: 'Delete File', danger: true,
        }
        : {
          title: `${choice.label}?`,
          message: `${choice.title}: ${path}.\n\nThe other side's changes and your edits to the file are replaced, and it is marked resolved.`,
          confirmLabel: choice.label, danger: true,
        });
    }
    const name = plan[0].choice.name;
    const line = (p) => (p.choice.deletes ? `Delete ${dn(p.entry.path)} (${p.choice.why})` : `Keep ${dn(p.entry.path)} (${p.choice.why})`);
    return dialog(store).confirm({
      title: dels.length ? `Resolve ${plan.length} files with ${name}'s side?` : `Keep ${name}'s version of ${plan.length} files?`,
      message: `${deletedNote(dels.length, name)}The other side's changes and your edits to these files are replaced, and they are marked resolved.`,
      detail: [...plan.slice(0, 10).map(line), ...(plan.length > 10 ? [`and ${plan.length - 10} more`] : [])].join('\n'),
      confirmLabel: dels.length ? 'Resolve Files' : `Keep ${name}'s Version`,
      danger: true,
    });
  }

  /** A resolveWith failure after some files were resolved: say which ones, then the error. Resolves false. */
  async function resolvePartial(store, done, total, e) {
    if (!done.length) { report(store, e); return false; }
    await dialog(store).alert({
      title: `Resolved ${done.length} of ${total} files`,
      message: `The files below were resolved before an error stopped the rest:\n\n${String(e.message || e)}`,
      detail: dialog(store).pathListText(done.map((d) => `${d.deleted ? 'Deleted' : 'Kept'} ${d.entry.path}`)),
    });
    return false;
  }

  // ---------------------------------------------------------------- starts (merge / rebase / interactive)
  // Targets are full refnames (Components.actions.fullRef) or full shas; the backend resolves them.

  const STALE_NOTICE = 'The branch moved since you opened this; review and try again';
  const MAIN_NAMES = new Set(['main', 'master', 'develop']);
  const START_QUIET = ['stale', 'in-progress', 'conflicts', 'dirty', 'hook-failed', 'aborted', 'checked-out-elsewhere',
    'ambiguous', 'unrelated-histories', 'not-fast-forward'];

  /** {oid, name} of a merge / rebase target: its commit (from the refs, when known) and display name. */
  function targetInfo(store, target) {
    if (C.util.OID_RE.test(target)) return { oid: target, name: short(target) };
    const refs = store.state.refs || {};
    const m = /^refs\/(heads|remotes|tags)\/(.+)$/.exec(target);
    const name = m ? m[2] : target;
    const lists = m ? [{ heads: refs.local, remotes: refs.remote, tags: refs.tags }[m[1]]] : [refs.local, refs.remote, refs.tags];
    const hit = lists.map((l) => (l || []).find((r) => r.name === name)).find(Boolean);
    return { oid: hit ? hit.oid : null, name: dn(name) };
  }

  /** Loaded ancestors of `sha` (window.Store.ancestorsOf over state.commits), or null: unknown. */
  const ancestors = (store, sha) => (sha && typeof store.ancestorsOf === 'function' ? store.ancestorsOf(sha) : null);

  /** A start needs a clean repository: no rebase / merge / … in progress, no autostash left waiting. */
  function needClean(store, action) {
    const st = status(store);
    let why = null;
    if (Op().inProgress(st)) why = Op().finishFirstTitle(action, st);
    else if (Op().pendingAutostashOf(st)) why = Op().pendingStashTitle(action);
    if (why) store.actions.notify(why);
    return !why;
  }

  /**
   * The checks every start makes before its first dialog: a clean repository (needClean), a HEAD with
   * commits (an alert naming `what`: 'merge' | 'rebase'), and the menu's expectHead still HEAD (else the
   * stale notice; `expectOf` overrides what it is compared with). Resolves HEAD's sha, or null (refused).
   */
  async function startGuard(store, o, what, { action = what === 'merge' ? 'Merge' : 'Rebase', expectOf } = {}) {
    if (!needClean(store, action)) return null;
    const st = status(store);
    const head = st && st.oid;
    if (!head) {
      await dialog(store).alert({ title: `Cannot ${what}`, message: 'The current branch has no commits yet. Make a commit first.' });
      return null;
    }
    const want = expectOf === undefined ? head : expectOf;
    if (o && typeof o.expectHead === 'string' && o.expectHead && o.expectHead !== want) {
      store.actions.notify(STALE_NOTICE);
      return null;
    }
    return head;
  }

  /**
   * The result an error of a start carries when the op finished before a later step failed (ops keep
   * `result`, docs/plans/rebase.md §4.5): {...result, stash?} (the error's kept stash as the result's
   * stash field, when the result has none), or null (nothing finished).
   */
  function finishedOf(e) {
    const r = e && e.result;
    if (!r || typeof r !== 'object' || (r.status !== 'done' && r.status !== 'up-to-date')) return null;
    const stash = r.stash || (e.stashKept ? { kept: true, sha: e.stash || null, reason: e.reason || null } : undefined);
    return { ...r, ...(stash ? { stash } : {}), ...(e.resetFailed ? { resetFailed: true } : {}) };
  }

  /**
   * Explain a refused or failed merge / rebase start. Resolves false. `stale`: the notice for kind
   * 'stale' (default STALE_NOTICE; the interactive editor's names its plan).
   */
  async function startError(store, e, what, { stale = STALE_NOTICE } = {}) {
    const a = dialog(store).alert;
    const Title = what === 'merge' ? 'Merge' : 'Rebase';
    switch (e.kind) {
      case 'stale':
        store.actions.notify(stale);
        return false;
      case 'in-progress':
        store.actions.notify(String(e.message || `${Title} — another operation is in progress`));
        return false;
      case 'ambiguous':
      case 'unrelated-histories':
      case 'not-fast-forward':
        await a({
          title: `Cannot ${what}`,
          message: Object.hasOwn(MERGE_REFUSALS, e.kind) ? MERGE_REFUSALS[e.kind] : String(e.message || ''),
          detail: e.kind === 'ambiguous' ? '' : e.message,
        });
        return false;
      case 'checked-out-elsewhere':
        await a({ title: `Cannot ${what}`, message: 'The branch is checked out in another worktree. Rebase it there, or free it first.', detail: e.message });
        return false;
      case 'hook-failed':
        await a({
          title: `A hook refused the ${what}`,
          message: `A git hook refused the ${what}${what === 'rebase' ? ' before it started, so nothing changed' : ''}. Its output:`,
          detail: String(e.message || '').trim() || '(the hook printed nothing)',
        });
        return false;
      case 'conflicts':
        // A merge that stopped with conflicts, reported as an error: the banner and WIP panel take over.
        if (what === 'merge') {
          store.actions.notify(mergeStoppedNotice(e, store));
          store.actions.select({ kind: 'wip' });
          return false;
        }
        break;
      case 'aborted':
        if (what === 'rebase' && !e.rebase) {
          store.actions.notify('Rebase cancelled');
          return false;
        }
        break;
      default:
        if (e.stashKept) {
          await a({ title: `${Title} failed`, message: `${e.message}${stashNote(e, { banner: true })}` });
          return false;
        }
    }
    return opError(store, e, { what });
  }

  /** "Merge stopped: 2 conflicted files" from a stopped result / conflicts error, else the live status. */
  function mergeStoppedNotice(r, store) {
    const n = [r && r.count, r && r.conflicted, r && r.state && r.state.conflicted].find(Number.isInteger)
      ?? (r && Array.isArray(r.conflicted) ? r.conflicted.length : conflictsNow(store));
    return n > 0 ? `Merge stopped: ${C.util.plural(n, 'conflicted file')}` : 'Merge stopped: commit or abort it';
  }

  // ---------------------------------------------------------------- published commits (§5.7)

  /**
   * The published facts of rewriting `pub` ([{sha, remoteRefs}], the plan's published commits that are
   * rewritten) on `branch`: {count, where, remote, onlyUpstream, unknown: false}. where: the upstream
   * when it has them, else the first such ref; remote: the remote whose default branch `branch` is
   * (plan.defaultBranchOf); onlyUpstream: no remote branch but `branch`'s own upstream has them.
   */
  function publishedFacts(store, pub, branch, plan) {
    const up = branch ? upstreamOf(store, branch) : null;
    const refsOf = [...new Set(pub.flatMap((p) => (Array.isArray(p.remoteRefs) ? p.remoteRefs : [])))];
    const where = up && refsOf.includes(up) ? up : (refsOf[0] || up);
    const onlyUpstream = !!up && refsOf.length > 0 && refsOf.every((r) => r === up);
    return { count: pub.length, where, remote: (plan && plan.defaultBranchOf) || null, onlyUpstream, unknown: false };
  }

  /** Facts when the plan couldn't be read: the warning then hedges (only when the branch has an upstream). */
  function unknownFacts(store, branch) {
    const up = branch ? upstreamOf(store, branch) : null;
    return { count: 0, where: up, remote: null, unknown: !!up };
  }

  /**
   * Whether a rebase with these published facts asks first. A feature branch whose commits are only on
   * its own upstream doesn't: rewriting your own pushed branch is routine, and offerForcePush follows
   * the rebase. Commits on any other remote branch, or on the main branch, or not checked, do ask.
   */
  const needsPublishedConfirm = (facts, branch) =>
    !!facts && (facts.unknown || (facts.count > 0 && !(facts.onlyUpstream && !isMainBranch(facts, branch))));

  /** "Rewrite pushed commits?" (docs/plans/rebase.md §5.7): true when the user goes ahead. */
  async function publishedWarning(store, facts, branch, total) {
    return dialog(store).confirm({
      title: 'Rewrite pushed commits?',
      message: publishedText(store, facts, branch, total),
      confirmLabel: 'Rebase',
      danger: isMainBranch(facts, branch),
      defaultCancel: true,
    });
  }

  const isMainBranch = (facts, branch) => !!branch && !!(facts.remote || MAIN_NAMES.has(branch));

  /** The warning's text (also part of the checkout-first confirm of "Rebase b onto cur…"). */
  function publishedText(store, facts, branch, total) {
    const b = branch ? dn(branch) : 'HEAD';
    const where = dn(facts.where || 'a remote');
    const up = branch ? upstreamOf(store, branch) : null;
    const isUp = !!up && facts.where === up;
    const mainRemote = facts.remote || (up && up.includes('/') ? up.split('/')[0] : 'its remote');
    const first = facts.unknown
      ? `Some of the commits you're rebasing may already be pushed to ${where} (they couldn't be checked).`
      : `${pushedCount(facts.count, total)} already pushed to ${where}.`;
    const copies = facts.count === 1 ? 'it with a new copy' : 'them with new copies';
    const them = facts.count === 1 ? 'it' : 'them';
    const then = isUp || facts.unknown
      ? ` Rebasing replaces ${copies}, so you'll need to force push ${b} afterwards to update ${where}.`
      : ` Rebasing replaces ${copies}, so anyone who already has ${them} will see different commits.`;
    const main = isMainBranch(facts, branch) ? `\n\n${b} is the main branch of ${dn(mainRemote)}: others probably build on it.` : '';
    return `${first}${then}${main}`;
  }

  /** "Your commit is" / "All 3 of your commits are" / "2 of your 5 commits are" / "2 commits are" (total unknown). */
  function pushedCount(count, total) {
    if (!Number.isInteger(total) || total < count) return `${C.util.plural(count, 'commit')} ${count === 1 ? 'is' : 'are'}`;
    if (total === 1) return 'Your commit is';
    if (count === total) return `All ${total} of your commits are`;
    return `${count} of your ${total} commits ${count === 1 ? 'is' : 'are'}`;
  }

  /**
   * After a done rebase: offer the lease force push (Force Push…, its own confirm; Later is the default)
   * only when the result says rewritten commits were on a remote (`published` > 0) and the branch has
   * a remote upstream. The branch is the one the rebase ran on: the result's `branch` (null: a detached
   * HEAD, nothing to push), else `fallback` (what the flow asked for).
   */
  async function offerForcePush(store, res, fallback) {
    if (!res || res.status !== 'done' || !Number.isInteger(res.published) || res.published <= 0) return;
    let branch = fallback;
    if (Object.hasOwn(res, 'branch')) branch = typeof res.branch === 'string' && res.branch ? res.branch : null;
    if (!branch) return;
    const upstream = upstreamOf(store, branch);
    if (!upstream || !upstream.includes('/')) return;
    const choice = await dialog(store).choose({
      title: `Force push ${dn(branch)}?`,
      message: `${dn(upstream)} still has the commits from before the rebase. A force push replaces them with the rebased ones; it stops if someone else pushed to ${dn(upstream)} in the meantime. You can also do it later from Push.`,
      choices: [{ value: 'force', label: 'Force Push…', danger: true }],
      cancelLabel: 'Later',
    });
    if (choice === 'force') await forcePush(store, { branch }, upstream);
  }

  Object.assign(K, {
    START_QUIET, rebaseResult, opError, startError, finishedOf, startGuard,
    needClean, targetInfo, ancestors, publishedFacts, unknownFacts, needsPublishedConfirm, publishedWarning, publishedText, offerForcePush, mergeStoppedNotice,
  });

  K.register({
    rebaseContinue: rebaseContinueFlow,
    rebaseSkip: rebaseSkipFlow,
    rebaseAbort: abortFlow('rebase'),
    mergeCommit: mergeCommitFlow,
    mergeAbort: abortFlow('merge'),
    restoreAutostash: restoreAutostashFlow,
    resolveWith: resolveWithFlow,
  });
})();
