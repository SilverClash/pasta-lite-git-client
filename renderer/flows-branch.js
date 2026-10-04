'use strict';
// PLFlows for branches (plain script; loads after flows-sync.js and adds its flows to window.PLFlows).
// Contract: flows-kit.js.
//   checkout(store, {target, kind})   kind 'local' (name) | 'remote' ('origin/x') | 'commit' (full sha)
//   createBranch(store, {start?, checkout = true}?)   never checks out in a bare repository
//   deleteBranch(store, name)      refused (an alert) for the current branch and one checked out in a
//                                   linked worktree (the worktrees re-read first)
//   deleteBranches(store, names)   several local branches, one confirmation (the checked-out branch and
//                                   branches of linked worktrees are left out, and the dialog says so;
//                                   more than DELETE_BRANCHES_MAX: an alert, no confirmation)
// Shared by both: withWorktrees (the state with the worktrees re-read), confirmForce (the force-delete
// question), and PLMenus.deleteRefusal (why a branch can't be deleted).
//   branchNameError(name, refs) -> string | null   the create-branch validation (pure)
// Kit additions: checkoutInner (flows-rebase.js checks a branch out before rebasing it), syntaxError
// (flows-sync.js' setUpstream validates the remote branch name with it).
// All git-derived text reaches the DOM through the dialogs / toasts (textContent only).
(function () {
  const K = window.PLFlowKit;
  const { C, settle, report, dialog, dn, short, status, currentBranch, keptStashTitle, keptStashText, stashNote } = K;
  const P = window.PLPolicy;
  const undoKey = () => window.PLKeys.keyHint('undo');

  // ---------------------------------------------------------------- checkout

  /**
   * Explain a failure of a write that auto-stashed local changes (checkout, createBranch with
   * checkout; a plain stash, not the banner's): the changes didn't come back on the new HEAD
   * (kind 'stash-conflict', with its reason), or the op failed with the stash kept. `done`: what did
   * happen ('Checked out'). Resolves false when `e` is neither (the caller reports it).
   */
  async function autostashError(store, e, { where, done, failTitle }) {
    if (e.kind === 'stash-conflict') {
      await dialog(store).alert({
        title: keptStashTitle(done, e.reason),
        message: `Switched to ${where}. ${keptStashText({ sha: e.stash, reason: e.reason, resetFailed: e.resetFailed })}`,
        detail: e.resetFailed && e.resetError ? `The working tree could not be reset: ${e.resetError}` : '',
      });
      return true;
    }
    if (e.stashKept) {
      await dialog(store).alert({ title: failTitle, message: `${e.message}${stashNote(e)}` });
      return true;
    }
    return false;
  }

  async function checkoutInner(store, target, kind) {
    try {
      await store.actions.write('checkout', [target, { kind }], { quiet: ['local-exists', 'stash-conflict'] });
      return true;
    } catch (e) {
      if (e.kind === 'local-exists' && kind === 'remote' && e.branch) {
        const ok = await dialog(store).confirm({
          title: 'Branch already exists',
          message: `A local branch ${dn(e.branch)} already exists and doesn't track ${dn(target)}. Check out the local branch instead?`,
          confirmLabel: 'Check Out Local Branch',
        });
        return ok ? checkoutInner(store, e.branch, 'local') : false;
      }
      const explained = await autostashError(store, e, {
        where: dn(kind === 'commit' ? short(target) : target),
        done: 'Checked out',
        failTitle: 'Checkout failed',
      });
      if (!explained) report(store, e);
      return false;
    }
  }

  async function checkoutFlow(store, o) {
    const { target, kind = 'local' } = o || {};
    if (typeof target !== 'string' || !target) return false;
    if (kind === 'local' && target === currentBranch(store)) return false; // already there
    if (kind === 'commit') {
      const ok = await dialog(store).confirm({
        title: 'Check out commit?',
        message: `Check out ${short(target)} as a detached HEAD? New commits made there won't belong to any branch unless you create one.`,
        confirmLabel: 'Check Out',
      });
      if (!ok) return false;
    }
    return checkoutInner(store, target, kind);
  }

  // ---------------------------------------------------------------- branches

  /** git check-ref-format rules a name can break on its own (the backend re-checks with git). */
  function syntaxError(name) {
    if (/\s/.test(name)) return 'Branch names cannot contain spaces';
    if (name.startsWith('-')) return "Branch names cannot start with '-'";
    if (/[\u0000-\u001f\u007f~^:?*[\\]/.test(name)) return 'Branch names cannot contain ~ ^ : ? * [ \\ or control characters';
    if (name.includes('..') || name.includes('@{') || name === '@' || name === 'HEAD') return `'${name}' is not a valid branch name`;
    if (name.startsWith('/') || name.endsWith('/') || name.includes('//') || name.endsWith('.')) return 'Branch names cannot start or end with / or end with .';
    if (name.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'))) return "Path components cannot start with '.' or end with '.lock'";
    return null;
  }

  /** Error text for a new branch name (trimmed by the caller), or null when it's fine. */
  function branchNameError(name, refs) {
    if (typeof name !== 'string' || !name) return 'Enter a branch name';
    const bad = syntaxError(name);
    if (bad) return bad;
    const local = (refs && refs.local) || [];
    if (local.some((b) => b.name === name)) return `A branch named '${name}' already exists`;
    // git can't store both 'a' and 'a/b' (a ref is a file, a folder holds the refs under it).
    const clash = local.find((b) => b.name.startsWith(`${name}/`) || name.startsWith(`${b.name}/`));
    if (clash) return `'${name}' conflicts with the existing branch '${clash.name}'`;
    return null;
  }

  async function createBranchFlow(store, o) {
    const { start } = o || {};
    // A bare repository has no working tree to check the new branch out into.
    const checkout = !P.isBare(store.state) && (!o || o.checkout === undefined || !!o.checkout);
    const at = start ? short(start) : (currentBranch(store) || short(status(store) && status(store).oid) || 'HEAD');
    const name = await dialog(store).prompt({
      title: 'Create branch',
      message: `The new branch starts at ${dn(at)}${checkout ? ' and is checked out' : ''}.`,
      label: 'Branch name',
      placeholder: 'feature/my-change',
      okLabel: checkout ? 'Create & Check Out' : 'Create',
      validate: (v) => branchNameError(v.trim(), store.state.refs),
    });
    if (name === null) return false;
    const branch = name.trim();
    // With checkout, blocking local changes are auto-stashed by the backend (as for checkout).
    const { error } = await settle(store.actions.write('createBranch', [branch, { ...(start ? { start } : {}), checkout: !!checkout }], { quiet: ['stash-conflict'] }));
    if (!error) return true;
    const explained = await autostashError(store, error, {
      where: `the new branch ${dn(branch)}`,
      done: 'Branch created',
      failTitle: 'Create branch failed',
    });
    if (!explained) report(store, error);
    return false;
  }

  const branches = (n) => C.util.plural(n, 'branch', 'branches');
  /** The most branches one deleteBranches write accepts (src/ops.js DELETE_BRANCHES_MAX). */
  const DELETE_BRANCHES_MAX = 1000;
  /** Every name, one per line (display-safe): the dialog's detail box scrolls. */
  const nameList = (store, names) => dialog(store).pathListText(names, names.length);

  /**
   * store.state with state.worktrees re-read: the store keeps them for every repository (read with each
   * full refresh), but a worktree added from a terminal since then may hold the branch, so the delete
   * flows re-read them for freshness. A failed read keeps the store's list (git still refuses such a
   * branch, and the flow reports it).
   */
  async function withWorktrees(store) {
    const { value } = await settle(store.invoke('worktrees'));
    return Array.isArray(value) ? { ...store.state, worktrees: value } : store.state;
  }

  /**
   * The force-delete question for the local branches `names` that aren't fully merged (one or
   * several; several are listed). Resolves true to force-delete them.
   */
  function confirmForce(store, names) {
    const one = names.length === 1;
    return dialog(store).confirm({
      title: one ? 'Branch not fully merged' : `${names.length} branches not fully merged`,
      message: `${one ? `${dn(names[0])} has` : 'These branches have'} commits that aren't merged into ${one ? 'its' : 'their'} upstream or the current branch. Delete ${one ? 'it' : 'them'} anyway?`
        + `\n\nYou can still undo this with Undo (${undoKey()}).`,
      ...(one ? {} : { detail: nameList(store, names) }),
      confirmLabel: 'Force Delete',
      danger: true,
    });
  }

  async function deleteBranchFlow(store, name) {
    if (typeof name !== 'string' || !name) return false;
    if (name === currentBranch(store)) {
      await dialog(store).alert({ title: 'Cannot delete the current branch', message: `Check out another branch before deleting ${dn(name)}.` });
      return false;
    }
    const refused = C.actions.deleteRefusal(name, await withWorktrees(store));
    if (refused) {
      await dialog(store).alert({ title: 'Cannot delete this branch', message: refused.title });
      return false;
    }
    const ok = await dialog(store).confirm({
      title: 'Delete branch?',
      message: `Delete the local branch ${dn(name)}? The remote branch (if any) is not touched.\n\nYou can undo this with Undo (${undoKey()}).`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return false;
    const first = await settle(store.actions.write('deleteBranch', [name, {}], { quiet: ['not-merged'] }));
    if (first.error) {
      if (first.error.kind !== 'not-merged') { report(store, first.error); return false; }
      if (!(await confirmForce(store, [name]))) return false;
    }
    const res = first.error ? await store.actions.write('deleteBranch', [name, { force: true }]) : first.value;
    if (res && res.warning) await dialog(store).alert({ title: 'Branch deleted', message: res.warning });
    else store.actions.notify(`Deleted branch ${dn(name)}${res && res.sha ? ` (was ${short(res.sha)})` : ''}`);
    return true;
  }

  /**
   * Delete local branches `names` after one confirmation that lists them. Left out (and named in the
   * dialog): what deleteBranch refuses (C.actions.deletableBranches, with the worktrees re-read);
   * nothing left: an alert. One deleteBranches write deletes them in turn; branches that aren't fully
   * merged are offered for a force delete together (confirmForce, as deleteBranch does for one), and
   * what still failed (a failed force write too) is listed at the end without undoing the rest.
   */
  async function deleteBranchesFlow(store, names) {
    const { names: todo, skipped } = C.actions.deletableBranches(Array.isArray(names) ? names : [], await withWorktrees(store));
    const skippedNote = skipped.length ? `Not deleted: ${skipped.map((x) => `${dn(x.name)} (${x.why})`).join(', ')}.` : '';
    if (!todo.length) {
      if (skipped.length) await dialog(store).alert({ title: 'Nothing to delete', message: skippedNote });
      return false;
    }
    if (todo.length > DELETE_BRANCHES_MAX) {
      await dialog(store).alert({
        title: `Too many branches (${todo.length})`,
        message: `At most ${DELETE_BRANCHES_MAX} branches can be deleted at once. Narrow the selection, or filter the sidebar first.`,
      });
      return false;
    }
    const ok = await dialog(store).confirm({
      title: `Delete ${branches(todo.length)}?`,
      message: `Delete ${todo.length === 1 ? 'this local branch' : `these ${todo.length} local branches`}? Remote branches are not touched.`
        + `${skippedNote ? `\n\n${skippedNote}` : ''}\n\nYou can undo this with Undo (${undoKey()}), one branch at a time.`,
      detail: nameList(store, todo),
      confirmLabel: `Delete ${branches(todo.length)}`,
      danger: true,
    });
    if (!ok) return false;
    const first = await store.actions.write('deleteBranches', [todo, {}]);
    const unmerged = first.failed.filter((f) => f.kind === 'not-merged').map((f) => f.name);
    const force = unmerged.length > 0 && await confirmForce(store, unmerged);
    const none = { deleted: [], failed: [] };
    const { value: forced = none, error } = force ? await settle(store.actions.write('deleteBranches', [unmerged, { force: true }])) : { value: none };
    // a force write that rejected (toasted by write) still gets the summary of the first one
    const forceFailed = error && error.kind !== 'repo-changed'
      ? unmerged.map((n) => ({ name: n, message: error.message || String(error) }))
      : [];
    const deleted = [...first.deleted, ...forced.deleted];
    const failed = [...first.failed.filter((f) => f.kind !== 'not-merged'), ...forced.failed, ...forceFailed];
    const kept = force ? [] : unmerged;
    const warnings = deleted.filter((d) => d.warning).map((d) => `${dn(d.name)}: ${d.warning}`);
    const done = deleted.length ? `Deleted ${branches(deleted.length)}` : 'No branches deleted';
    if (failed.length || warnings.length) {
      await dialog(store).alert({
        title: failed.length ? `${branches(failed.length)} could not be deleted` : done,
        message: `${done}${kept.length ? `, kept ${kept.length} not fully merged` : ''}.`
          + `${failed.length ? ' Not deleted:' : ''}`,
        detail: [...failed.map((f) => `${dn(f.name)}: ${f.message}`), ...warnings].join('\n'),
      });
    } else {
      store.actions.notify(`${done}${kept.length ? ` (kept ${kept.length} not fully merged)` : ''}`);
    }
    return deleted.length > 0;
  }

  Object.assign(K, { checkoutInner, syntaxError });
  window.PLFlows.branchNameError = branchNameError;
  K.register({
    checkout: checkoutFlow,
    createBranch: createBranchFlow,
    deleteBranch: deleteBranchFlow,
    deleteBranches: deleteBranchesFlow,
  });
})();
