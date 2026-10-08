'use strict';
// The operation in progress (rebase, merge, …) as the renderer shows it (plain script; exposes
// window.PLOp, and module.exports under node for the tests). Pure, no DOM. Loads after
// components.js (util.displayName) and before policy.js / store.js / actions.js / the flows / the components.
//
// Backend fields (docs/plans/rebase.md §3.4, §3.8, §3.10), read ONLY through the accessors below so
// a change in their shape is a one-line fix here:
//   status.state             'clean' | 'rebasing' | 'merging' | 'cherry-picking' | 'reverting' | 'am' | 'sequencer' | 'bisecting'
//   status.rebase            RebaseState | null  {backend, interactive, ours, branch, onto, origHead, ontoName,
//                            step: {done, total}, current: {cmd, sha, subject} | null,
//                            stop: 'conflict'|'edit'|'empty'|'hook'|'other', stopMessage, conflicted,
//                            todoEditable, runsCommands, autostash, stoppedSha, hookOutput?, signingFailed?}
//                            runsCommands: the rest of the todo has exec lines (Continue / Skip refused, 'rebase-exec')
//                            autostash: our stash's sha, only while that stash still exists
//   status.merge             {head, name, message, autostash} | null   autostash: the sha of our stash that comes back when
//                            the merge ends (only while it exists; mergeCommit then refuses unstaged changes)
//   status.pendingAutostash  sha | null (a rebase finished or aborted outside the app left our stash)
//
//   opStateOf(status) -> state string ('clean' when unknown)     inProgress(status) -> boolean
//   rebaseStateOf(status), mergeStateOf(status), pendingAutostashOf(status)
//   opName(status) -> 'rebase' | 'merge' | 'cherry-pick' | …     stopOf(rebase, status) -> stop kind
//   conflictCount(status) -> number (the live status.conflicted, else rebase.conflicted)
//   ontoName(rebase, refsBySha) -> raw name of the rebase target (meta name, a ref at onto, else sha7)
//   rebaseNames(status, refsBySha) -> {branch, onto} display-safe
//   inProgressTitle(action, status) -> 'Pull — a rebase is in progress'
//   finishFirstTitle(action, status) -> 'Branch — finish or abort the rebase first'
//   pendingStashTitle(action) -> 'Rebase — restore or keep the stash left over from the last rebase first (see the banner)'
//   unstagedBlocker(status) -> null | reason   why Continue Rebase / Commit and Merge would be refused for unstaged
//                            changes to tracked files (ops rebaseContinue always; mergeCommit while status.merge.autostash)
//   bannerModel(state) -> null | {kind, title, lines: [text], detailLabel, detail, buttons: [descriptor]}
//                            kind 'bare' for a bare repository (state.repo.bare): "Open worktree <branch>"
//                            buttons for its linked worktrees (state.worktrees, which the store reads for every
//                            repository), before every other banner
//   bareWorktrees(worktrees) -> the worktrees the bare banner offers (not bare, not prunable, not missing)
//                            descriptors are Components.actions descriptors {id, label, flow, args, title, disabled?, danger?, primary?}
//   composerMode(status) -> {mode: 'commit'|'continue'|'rebase'|'merge', key, message?, label?, flow?, stop?,
//                            commitRefused?}  commitRefused: why Commit / Amend / Commit All are off ('rebase' mode
//                            where ops refuseAtPickStop refuses them: the backend's COMMIT_REFUSED), else null
//   conflictHeading(status) -> null | {title, text}   the WIP panel's "Rebase conflicts detected" block
//   wipLabel(status) -> '// WIP' | '// Rebasing 3/7' | '// Merging'
//   stoppedNotice(rebase, status?) -> 'Rebase stopped: 2 conflicted files' | …
//   editStopText(rebase) -> 'Stopped to edit a1b2c3d: amend or continue' (banner and composer at an edit stop)
//   conflictCode(entry) -> 'UU' | 'DU' | … | null   entry.xy (conflicted entries are {path, status: 'U', xy})
//   conflictSides(status, refsBySha) -> null | {ours, theirs}   display names of the two sides
//   resolveChoices(status, refsBySha, entry) -> null | [{side: 'ours'|'theirs', name, label, title, deletes, file}]
//                            the WIP panel's "Keep main's version" / "Delete a.txt (main deleted it)" /
//                            "Delete a.txt (main doesn't have it)" buttons
// Every returned text is display-safe (names through util.displayName); the DOM gets it via textContent.
(function () {
  const util = () => (typeof window !== 'undefined' && window.Components ? window.Components.util : null);
  const dn = (s) => {
    const u = util();
    if (u) return u.displayName(s);
    return s == null ? '' : String(s);
  };
  // Components.util (components.js loads first, in index.html and in the tests).
  const plural = (...a) => util().plural(...a);
  const short = (sha) => util().short(sha);
  /** A full refname as users know it ('refs/heads/main' -> 'main'); the flows pass full refnames. */
  const refShort = (name) => String(name).replace(/^refs\/(heads|remotes|tags)\//, '');

  // ---------------------------------------------------------------- accessors (the adaptation points)

  const opStateOf = (st) => (st && typeof st.state === 'string' && st.state) || 'clean';
  const rebaseStateOf = (st) => (st && st.rebase && typeof st.rebase === 'object' ? st.rebase : null);
  const mergeStateOf = (st) => (st && st.merge && typeof st.merge === 'object' ? st.merge : null);
  const pendingAutostashOf = (st) => (st && typeof st.pendingAutostash === 'string' && st.pendingAutostash ? st.pendingAutostash : null);
  const inProgress = (st) => opStateOf(st) !== 'clean';

  const OP_NAMES = {
    rebasing: 'rebase', merging: 'merge', 'cherry-picking': 'cherry-pick', reverting: 'revert',
    am: 'git am session', sequencer: 'cherry-pick or revert', bisecting: 'bisect',
  };
  const opName = (st) => OP_NAMES[opStateOf(st)] || 'operation';

  const STOPS = new Set(['conflict', 'edit', 'empty', 'hook', 'other']);

  /** Live conflicted-file count: status.conflicted (what the WIP panel lists), else the rebase's copy. */
  function conflictCount(st) {
    if (st && Array.isArray(st.conflicted)) return st.conflicted.length;
    const rb = rebaseStateOf(st);
    return rb && Number.isInteger(rb.conflicted) ? rb.conflicted : 0;
  }

  /** The stop kind of a rebase: the backend's, except that live conflicts always make it 'conflict'. */
  function stopOf(rb, st) {
    if (conflictCount(st) > 0) return 'conflict';
    if (rb && STOPS.has(rb.stop)) return rb.stop;
    return 'other';
  }

  /** Raw name of what the rebase replays onto: meta.json's name, a ref at `onto` (local, remote, tag), else sha7. */
  function ontoName(rb, refsBySha) {
    if (!rb) return null;
    if (typeof rb.ontoName === 'string' && rb.ontoName) return refShort(rb.ontoName);
    const refs = (rb.onto && refsBySha && typeof refsBySha.get === 'function' && refsBySha.get(rb.onto)) || [];
    const pick = ['local', 'remote', 'tag'].map((t) => refs.find((r) => r.type === t)).find(Boolean);
    if (pick) return pick.name;
    return rb.onto ? short(rb.onto) : null;
  }

  /** {branch, onto}: display names for "Rebasing <branch> onto <onto>". */
  function rebaseNames(st, refsBySha) {
    const rb = rebaseStateOf(st);
    let branch = 'detached HEAD';
    if (rb && rb.branch) branch = dn(rb.branch);
    else if (st && st.branch) branch = dn(st.branch);
    const onto = ontoName(rb, refsBySha);
    return { branch, onto: onto ? dn(onto) : 'its new base' };
  }

  const inProgressTitle = (action, st) => `${action} — a ${opName(st)} is in progress`;
  const finishFirstTitle = (action, st) => `${action} — finish or abort the ${opName(st)} first`;
  /** Why a start waits for the autostash an earlier rebase left (status.pendingAutostash). */
  const pendingStashTitle = (action) => `${action} — restore or keep the stash left over from the last rebase first (see the banner)`;

  /** Changes to tracked files that aren't staged (untracked files don't count, as in ops trackedPaths). */
  const unstagedTracked = (st) => ((st && Array.isArray(st.unstaged)) ? st.unstaged : []).filter((f) => f && f.status !== '?');

  const UNSTAGED_REBASE = 'Stage or discard your unstaged changes first: Continue Rebase commits only what is staged';
  const UNSTAGED_MERGE = 'Stage or discard your unstaged changes first: your stashed changes come back when the merge is committed, and they need a clean working tree';

  /**
   * Why ops would refuse Continue Rebase / Commit and Merge for unstaged changes to tracked files
   * (rebaseContinue: always; mergeCommit: only while status.merge.autostash waits), else null.
   */
  function unstagedBlocker(st) {
    if (!unstagedTracked(st).length) return null;
    const op = opStateOf(st);
    if (op === 'rebasing') return UNSTAGED_REBASE;
    if (op === 'merging') { const m = mergeStateOf(st); return m && typeof m.autostash === 'string' && m.autostash ? UNSTAGED_MERGE : null; }
    return null;
  }

  // ---------------------------------------------------------------- banner

  /** "Stopped to edit a1b2c3d: amend or continue" (an `edit` stop; the banner and the composer). */
  function editStopText(rb) {
    const cur = rb && rb.current;
    return `Stopped to edit ${cur && cur.sha ? short(cur.sha) : 'the commit'}: amend or continue`;
  }

  const btn = (id, label, flow, title, extra = {}) => ({ id, label, flow, args: [], title, ...extra });
  const RESOLVE_FIRST = 'Resolve and mark all conflicted files first';
  /** Why Continue / Skip are off while the rest of the todo runs commands (rebase.runsCommands; ops kind 'rebase-exec'). */
  const EXEC_TODO = 'The rest of this rebase runs commands (exec lines in its todo), which Pasta Lite never runs.';
  const EXEC_OFF = 'The rest of this rebase runs commands: continue it in a terminal, or abort it';
  /** ops refuseAtPickStop's reason (kind 'rebasing'): commits are only made at an edit stop. */
  const COMMIT_REFUSED = 'Use Continue Rebase to commit the resolved changes';

  /** "Commit 3 of 7" (+ `: "subject"`), or null without a usable step. */
  function stepText(rb, withSubject) {
    const s = rb && rb.step;
    if (!s || !Number.isInteger(s.done) || !Number.isInteger(s.total) || s.total <= 0) return null;
    const cur = rb.current;
    const subject = withSubject && cur && cur.subject ? `: "${dn(cur.subject)}"` : '';
    return `Commit ${s.done} of ${s.total}${subject}`;
  }

  const commitRef = (cur) => {
    if (!cur) return 'the current commit';
    const sha = cur.sha ? short(cur.sha) : '';
    const subject = cur.subject ? `"${dn(cur.subject)}"` : '';
    return [sha, subject].filter(Boolean).join(' ') || 'the current commit';
  };

  /** The banner's text for a rebase: {title, lines, detailLabel, detail}. */
  function rebaseText(st, refsBySha, rb, stop, n) {
    const lines = [];
    const names = rb ? rebaseNames(st, refsBySha) : null;
    const external = !!rb && rb.ours === false;
    let title;
    if (!rb) title = 'A rebase is in progress';
    else if (external) title = 'Rebase in progress';
    else title = `Rebasing ${names.branch} onto ${names.onto}`;
    if (external) lines.push(`${names.branch} onto ${names.onto} (started outside Pasta Lite)`);
    const step = rb ? stepText(rb, stop !== 'edit') : null;
    if (step) lines.push(step);
    const hook = !!rb && stop === 'hook';
    if (stop === 'conflict') {
      lines.push(n ? plural(n, 'conflicted file') : 'All conflicts are marked resolved: continue the rebase');
    } else if (!rb && n === 0) {
      lines.push('Continue, skip the current commit, or abort the rebase.');
    } else if (rb) {
      const what = commitRef(rb.current);
      if (stop === 'edit') {
        lines.push(editStopText(rb));
        const subject = rb.current && rb.current.subject ? `"${dn(rb.current.subject)}"` : 'it';
        lines.push(`Staged changes are amended into ${subject}`);
      } else if (stop === 'empty') lines.push(`${what} has become empty (its changes are already there): skip it to leave it out`);
      else if (hook) lines.push('A commit hook refused the commit: fix the problem, then continue');
      else if (rb.signingFailed) lines.push(`Signing ${what} failed: fix your signing setup, then continue`);
      else lines.push(`The rebase stopped at ${what}: continue, skip it or abort the rebase`);
    }
    if (rb && rb.autostash) lines.push(`Your local changes are stashed (${short(rb.autostash)}) and come back when the rebase ends`);
    const detail = hook && typeof rb.hookOutput === 'string' && rb.hookOutput.trim() ? rb.hookOutput : null;
    return { title, lines, detailLabel: hook ? 'Hook output' : null, detail };
  }

  function rebaseBanner(st, refsBySha) {
    const rb = rebaseStateOf(st);
    const n = conflictCount(st);
    const stop = stopOf(rb, st);
    const { title, lines, detailLabel, detail } = rebaseText(st, refsBySha, rb, stop, n);

    const exec = !!rb && rb.runsCommands === true;
    if (exec) lines.push(`${EXEC_TODO} Continue it in a terminal if you trust it, or abort it.`);
    let why = n > 0 ? RESOLVE_FIRST : unstagedBlocker(st);
    if (exec) why = EXEC_OFF;
    const cont = btn('continue', 'Continue Rebase', 'rebaseContinue',
      stop === 'edit' ? 'Continue the rebase: staged changes are amended into the stopped commit' : 'Commit the resolved changes and continue with the next commit',
      { primary: true, ...(why ? { disabled: true, title: why } : {}) });
    const skip = btn('skip', 'Skip Commit', 'rebaseSkip', 'Leave the current commit out and continue with the next one',
      { danger: true, ...(exec ? { disabled: true, title: EXEC_OFF } : {}) });
    const abort = btn('abort', 'Abort Rebase', 'rebaseAbort', 'Stop the rebase and put the branch back where it was', { danger: true });
    return {
      kind: 'rebase', stop, title, lines, detailLabel, detail,
      buttons: stop === 'edit' ? [cont, abort] : [cont, skip, abort],
    };
  }

  function mergeBanner(st, refsBySha) {
    const m = mergeStateOf(st);
    const n = conflictCount(st);
    const into = st.branch ? dn(st.branch) : 'detached HEAD';
    const name = mergeName(m, refsBySha);
    const stash = m && typeof m.autostash === 'string' && m.autostash ? m.autostash : null;
    const why = n > 0 ? RESOLVE_FIRST : unstagedBlocker(st);
    return {
      kind: 'merge', stop: n ? 'conflict' : 'other',
      title: name ? `Merging ${dn(name)} into ${into}` : `A merge into ${into} is in progress`,
      lines: [
        n ? plural(n, 'conflicted file') : 'All conflicts are marked resolved: commit the merge',
        ...(stash ? [`Your local changes are stashed (${short(stash)}) and come back when the merge ends`] : []),
      ],
      detailLabel: null, detail: null,
      buttons: [
        btn('mergeCommit', 'Commit and Merge', 'mergeCommit', 'Commit the merge with the resolved changes',
          { primary: true, ...(why ? { disabled: true, title: why } : {}) }),
        btn('mergeAbort', 'Abort Merge', 'mergeAbort', 'Stop the merge and put the branch back where it was', { danger: true }),
      ],
    };
  }

  /**
   * The worktrees of a bare repository that can be opened: not the bare repository itself, not prunable
   * nor missing (gone; git marks a locked one only missing). state.worktrees is read for every
   * repository; only a bare one's banner uses this.
   */
  const bareWorktrees = (list) => (Array.isArray(list) ? list : [])
    .filter((w) => w && typeof w.path === 'string' && w.path && !w.bare && !w.prunable && !w.missing);

  /**
   * The bare repository banner: one "Open worktree <branch>" button per openable linked worktree
   * (flow openWorktree, a new tab; a detached one is named by its folder). state.worktrees null (not
   * read yet, or the read failed): no buttons and no hint; an empty list: how to add one.
   */
  function bareBanner(s) {
    const wts = bareWorktrees(s.worktrees);
    const lines = ['Commit, checkout, stash, merge and rebase need a worktree.'];
    if (Array.isArray(s.worktrees) && !wts.length) lines.push('It has no worktrees yet: add one from a terminal with git worktree add <folder> <branch>, then open that folder');
    return {
      kind: 'bare', stop: null, title: 'Bare repository — no working tree', lines, detailLabel: null, detail: null,
      buttons: wts.map((w, i) => btn(`worktree-${i}`, `Open worktree ${dn(w.branch || fsBaseName(w.path))}`, 'openWorktree',
        `Open ${dn(w.path)} in a new tab${w.locked ? ' (locked)' : ''}`, { args: [w.path], ...(i === 0 ? { primary: true } : {}) })),
    };
  }

  /**
   * The banner for store state `s` (repo, status, refsBySha, worktrees), or null when there is nothing
   * to show: a bare repository, a rebase or merge (with its buttons), another git operation (text
   * only), or a pending autostash.
   */
  function bannerModel(s) {
    // Inline rather than Components.actions.isBare: this module loads before actions.js and is used without it.
    if (s && s.repo && s.repo.bare) return bareBanner(s);
    const st = s && s.status;
    if (!st) return null;
    const op = opStateOf(st);
    if (op === 'rebasing') return rebaseBanner(st, s.refsBySha);
    if (op === 'merging') return mergeBanner(st, s.refsBySha);
    if (op !== 'clean') {
      return {
        kind: 'other', stop: null, title: `A ${opName(st)} is in progress`,
        lines: ['Finish or abort it from a terminal.'], detailLabel: null, detail: null, buttons: [],
      };
    }
    const stash = pendingAutostashOf(st);
    if (!stash) return null;
    return {
      kind: 'autostash', stop: null, title: 'Your changes from before the rebase are in a stash',
      lines: [`Stash ${short(stash)}: restore them into the working tree now, or keep them in the stash list`],
      detailLabel: null, detail: null,
      buttons: [
        { id: 'restore', label: 'Restore', flow: 'restoreAutostash', args: [{ keep: false }], title: 'Re-apply the stashed changes (staged and unstaged as they were) and drop the stash', primary: true },
        { id: 'keep', label: 'Keep in Stash', flow: 'restoreAutostash', args: [{ keep: true }], title: 'Leave the changes in the stash list' },
      ],
    };
  }

  // ---------------------------------------------------------------- WIP panel

  /**
   * Whether ops refuseAtPickStop refuses commit / commitAll mid-rebase (mirrors it exactly): never at
   * an edit stop; else at a conflict or empty stop, or whenever git stopped on a commit it is
   * replaying (REBASE_HEAD: rebase.stoppedSha). A stop between commits (break, exec, some hook
   * stops) allows them.
   */
  const commitRefusedAt = (rb) => !!rb && rb.stop !== 'edit' && (rb.stop === 'conflict' || rb.stop === 'empty' || !!rb.stoppedSha);

  /**
   * What the commit composer is for right now:
   *   commit    the normal commit box
   *   continue  a rebase conflict stop, or a hook stop (a hook refused the message): the stopped
   *             commit's message, editable, button Continue Rebase (flow rebaseContinue, which sends an
   *             edited message). Only with git's merge backend: ops refuse a message otherwise.
   *   rebase    another rebase stop (edit, empty, …), or any stop of an apply-backend rebase: the normal
   *             commit box plus a Continue Rebase button (no message is sent)
   *   merge     a merge: MERGE_MSG, button Commit and Merge (flow mergeCommit)
   * `key` names the draft slot: the fields are saved per stop ('rebase:<sha>', 'merge:<sha>').
   */
  function composerMode(st) {
    const op = opStateOf(st);
    if (op === 'rebasing') {
      const rb = rebaseStateOf(st);
      const stop = stopOf(rb, st);
      const message = !!rb && rb.backend === 'merge' && (stop === 'conflict' || stop === 'hook');
      if (!message) return { mode: 'rebase', key: 'commit', stop, label: 'Continue Rebase', flow: 'rebaseContinue', commitRefused: commitRefusedAt(rb) ? COMMIT_REFUSED : null };
      const sha = (rb.current && rb.current.sha) || rb.stoppedSha || rb.origHead || '';
      const text = typeof rb.stopMessage === 'string' ? rb.stopMessage : '';
      return { mode: 'continue', key: `rebase:${sha}`, stop, message: text, label: 'Continue Rebase', flow: 'rebaseContinue' };
    }
    if (op === 'merging') {
      const m = mergeStateOf(st);
      const message = m && typeof m.message === 'string' ? m.message : '';
      return { mode: 'merge', key: `merge:${(m && m.head) || ''}`, stop: null, message, label: 'Commit and Merge', flow: 'mergeCommit' };
    }
    return { mode: 'commit', key: 'commit', stop: null };
  }

  /** The WIP panel's header block while a rebase / merge has conflicts, else null. */
  function conflictHeading(st) {
    const n = conflictCount(st);
    const op = opStateOf(st);
    if (!n || (op !== 'rebasing' && op !== 'merging')) return null;
    const next = op === 'rebasing' ? 'continue the rebase' : 'commit the merge';
    return {
      title: op === 'rebasing' ? 'Rebase conflicts detected' : 'Merge conflicts detected',
      text: `${plural(n, 'conflicted file')}: resolve ${n === 1 ? 'it' : 'each one'}, mark ${n === 1 ? 'it' : 'them'} resolved, then ${next}`,
    };
  }

  /** The WIP row's subject in the graph. */
  function wipLabel(st) {
    const op = opStateOf(st);
    if (op === 'rebasing') {
      const s = (rebaseStateOf(st) || {}).step;
      return s && Number.isInteger(s.done) && Number.isInteger(s.total) && s.total > 0 ? `// Rebasing ${s.done}/${s.total}` : '// Rebasing';
    }
    if (op === 'merging') return '// Merging';
    return '// WIP';
  }

  // ---------------------------------------------------------------- keep a side (R2)

  // A conflicted entry's two-letter porcelain code (git status XY): {path, status: 'U', xy}.
  //   DD both deleted     AU added by us      UD deleted by them   UA added by them
  //   DU deleted by us    AA both added       UU both modified
  // X is ours (index stage 2), Y theirs (stage 3).
  function conflictCode(entry) {
    const v = entry && entry.xy;
    return typeof v === 'string' && /^[ADU]{2}$/.test(v) ? v : null;
  }

  /**
   * The sides that have no version of the file (no index stage), which is what merge.resolveWith
   * checks: keeping such a side deletes the file (`git rm`). Ours is missing for DD / DU (deleted by
   * us) and UA (added by them only); theirs for DD / UD (deleted by them) and AU (added by us only).
   * {ours, theirs, deleted}: deleted, the side removed the file (D) rather than never having it (AU / UA).
   */
  function missingSides(code) {
    if (!code) return { ours: false, theirs: false, deleted: { ours: false, theirs: false } };
    return {
      ours: code[0] === 'D' || code === 'UA',
      theirs: code[1] === 'D' || code === 'AU',
      deleted: { ours: code[0] === 'D', theirs: code[1] === 'D' },
    };
  }

  /** Raw name of what a merge brings in: MERGE_MSG's name, a ref at MERGE_HEAD, else sha7. */
  function mergeName(m, refsBySha) {
    if (!m) return null;
    if (typeof m.name === 'string' && m.name) return refShort(m.name);
    const refs = (m.head && refsBySha && typeof refsBySha.get === 'function' && refsBySha.get(m.head)) || [];
    if (refs.length) return refs[0].name;
    return m.head ? short(m.head) : null;
  }

  /** {ours, theirs}: display names of the two sides of a conflict, or null (no rebase / merge in progress). */
  function conflictSides(st, refsBySha) {
    const op = opStateOf(st);
    if (op === 'rebasing') {
      const rb = rebaseStateOf(st);
      const cur = rb && rb.current;
      return { ours: dn(ontoName(rb, refsBySha) || 'the new base'), theirs: cur && cur.sha ? short(cur.sha) : 'the replayed commit' };
    }
    if (op === 'merging') {
      return { ours: st && st.branch ? dn(st.branch) : 'HEAD', theirs: dn(mergeName(mergeStateOf(st), refsBySha) || 'the merged branch') };
    }
    return null;
  }

  // The last component of a path. A filesystem path (a worktree folder) splits on '/' and, as on
  // Windows, '\'; a git path (a file in the repo) is always '/'-separated, and on POSIX a file name
  // may contain '\', so it splits on '/' only.
  const fsBaseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');
  const baseName = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || String(p || '');

  /**
   * The "Keep … version" choices for a conflicted file while a rebase or merge is in progress, or
   * null (nothing in progress: only Mark resolved applies). [{side: 'ours'|'theirs', name, label, title,
   * deletes, file, why}] (why: "main deleted it" / "main's version", for lists of files). During a
   * rebase ours is what is being built on (onto plus the commits already replayed) and theirs the
   * commit being replayed; during a merge ours is the checked-out branch and
   * theirs what is merged in. The labels name the branch or commit, never "ours" / "theirs"
   * (docs/plans/rebase.md §5.4). A side without a version of the file (missingSides: a modify/delete
   * conflict 'UD' / 'DU', or a file only one side added, 'AU' / 'UA') says exactly what keeping it
   * does: "Delete a.txt (main deleted it)" / "Delete a.txt (main doesn't have it)" (deletes: true),
   * and the other side "Keep a.txt". 'DD' (both deleted it) has the one choice "Delete a.txt (both
   * sides deleted it)". Everything display-safe.
   */
  function resolveChoices(st, refsBySha, entry) {
    const sides = conflictSides(st, refsBySha);
    if (!sides) return null;
    const file = dn(baseName(entry && entry.path));
    const gone = missingSides(conflictCode(entry));
    const choice = (side) => {
      const name = sides[side];
      const other = sides[side === 'ours' ? 'theirs' : 'ours'];
      if (gone.ours && gone.theirs) {
        return { side, name, file, deletes: true, why: 'both sides deleted it', label: `Delete ${file} (both sides deleted it)`, title: 'Delete the file (both sides deleted it) and mark it resolved' };
      }
      if (gone[side]) {
        const did = gone.deleted[side];
        const why = did ? `${name} deleted it` : `${name} doesn't have it`;
        const title = did
          ? `Delete the file, as ${name} did, and mark the deletion resolved: ${other}'s changes to it are discarded`
          : `Delete the file (only ${other} added it) and mark the deletion resolved: ${other}'s version is discarded`;
        return { side, name, file, deletes: true, why, label: `Delete ${file} (${why})`, title };
      }
      if (gone.ours || gone.theirs) {
        const otherDid = gone.deleted[side === 'ours' ? 'theirs' : 'ours'];
        const note = otherDid ? `${other} deleted it` : `${other} doesn't have it`;
        return { side, name, file, deletes: false, why: `with ${name}'s changes; ${note}`, label: `Keep ${file}`, title: `Keep the file with ${name}'s changes and mark it resolved (${note})` };
      }
      return { side, name, file, deletes: false, why: `${name}'s version`, label: `Keep ${name}'s version`, title: `Keep ${name}'s version of the file and mark it resolved` };
    };
    return gone.ours && gone.theirs ? [choice('ours')] : [choice('ours'), choice('theirs')];
  }

  /** The notice for a rebase op that stopped (RebaseResult {status: 'stopped', state}). */
  function stoppedNotice(rb, st) {
    const n = rb && Number.isInteger(rb.conflicted) ? rb.conflicted : conflictCount(st);
    let stop = 'other';
    if (n > 0) stop = 'conflict';
    else if (rb && STOPS.has(rb.stop)) stop = rb.stop;
    if (stop === 'conflict') return `Rebase stopped: ${plural(n, 'conflicted file')}`;
    if (stop === 'edit') return `Rebase stopped to edit ${commitRef(rb && rb.current)}: amend or continue`;
    if (stop === 'hook') return 'Rebase stopped: a commit hook refused the commit';
    if (stop === 'empty') return `Rebase stopped: ${commitRef(rb && rb.current)} has become empty: skip it to leave it out, or abort the rebase`;
    return 'Rebase stopped: continue or abort it';
  }

  const api = {
    opStateOf, rebaseStateOf, mergeStateOf, pendingAutostashOf, inProgress, opName, stopOf, conflictCount,
    ontoName, rebaseNames, inProgressTitle, finishFirstTitle, pendingStashTitle, unstagedBlocker, bannerModel, bareWorktrees, composerMode, conflictHeading,
    wipLabel, stoppedNotice, editStopText, RESOLVE_FIRST, COMMIT_REFUSED, EXEC_TODO, refShort, conflictCode, missingSides, conflictSides, resolveChoices,
    baseName, fsBaseName,
  };
  if (typeof window !== 'undefined') window.PLOp = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
