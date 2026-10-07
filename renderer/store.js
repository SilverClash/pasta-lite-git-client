'use strict';
// Renderer state store shared by all components (plain script; exposes window.Store).
//
// Contract for components (renderer/components/*.js):
//   Components.register(name, { mount(rootEl, store) -> optional unmount fn })
//   - read state via store.state (treat as read-only; replace, never mutate, nested values)
//   - react via store.subscribe(['key', ...], (state, changedKeys) => ...) -> unsubscribe fn
//   - change things only through store.actions.*; store.set is for purely local UI keys a component
//     keeps in the store for itself (none today: every shared key has its action, e.g. setBusy,
//     setPullMode, setContinueDraft)
//   - render git-derived text with textContent / createTextNode only, never innerHTML
//
// State keys:
//   repo         {root, name, head:{sha, branch}, bare, linkedWorktree} | null   bare: a bare repository, whose
//                status is main's synthetic clean one, so there is no WIP row and the selection falls back to
//                HEAD; linkedWorktree: {mainPath, mainName, title} when the folder is a linked worktree, else
//                null (decided in main, src/repo-open.js: the renderer never compares paths)
//   worktrees    ops 'worktrees' result [{path, head, branch, bare, detached, locked, lockReason, prunable,
//                prunableReason, missing, main, current}] | null until first read; read for every repository
//                with every full refresh (the last list is kept when reading fails)
//   worktreeDirty {[path]: true | false | null} | null: whether each linked worktree (not bare, not prunable,
//                not missing, not current) has changes; null for one main couldn't check. Read lazily,
//                only while wanted (actions.setWorktreeDirtyWanted: the sidebar's Worktrees section is
//                open), with each worktrees read, at most once per DIRTY_TTL_MS (from the end of the
//                last read) for the same paths and never while a read of them is still running
//                the last value is kept when reading
//                fails. The current worktree is absent: use store.isDirty().
//   worktreeReveal a counter: actions.revealWorktree() bumps it (the toolbar's linked-worktree chip), and
//                the sidebar then opens its Worktrees section and focuses the current worktree's row. A
//                click event kept as state on purpose: the store has no event bus, only keyed subscriptions,
//                so a changing counter is how one component asks another to act
//   status       git.status() result | null
//   refs         git.refs() result | null
//   refsBySha    Map sha -> [{type:'head'|'local'|'remote'|'tag', name, current?, upstream?, remote?, branch?}]
//   stashes      git.stashes() result (the previous list is kept when reading stashes fails)
//   stashError   message when the stash list couldn't be read, else null
//   commits      loaded commits (git.log order), at most LOG_MAX
//   hasMore      more history can be loaded (loadMore); false once LOG_MAX commits are loaded
//   next         git.log paging cursor for loadMore ({tips, skip}) | null
//   graph        { width, rows } from Graph.layout over `rows` (see below)
//   rows         [{kind:'wip'} | {kind:'commit', commit}] — row i of the graph view
//   selection    {kind:'wip'} | {kind:'commit', sha} | null
//   commitFiles  {sha, files|null, loading, error}  (for the selected commit)
//   diff         null | {spec, loading, data|null, error}; data = ops diffView result:
//                {file (=sections[0]|null), sections, fingerprint, truncated, maxLines, maxLineChars, conflict|null}
//                spec: {kind:'workdir', file, staged, untracked} | {kind:'commit', sha, file, orig}
//   imagePreview null | the open diff's image preview (docs/plans/image-preview.md §6.3): {spec, conflict,
//                old: Slot, new: Slot, base?: Slot}, Slot = {loading, side: ImageSide without its bytes
//                (src/image-preview.js header) | null, url: a blob: URL of the bytes (window.PLImageCache) | null,
//                error: message | null}. conflict: an unmerged path (PLImage.previewKind 'conflict'), whose
//                old / new / base slots are its ours / theirs / base stages (`base` only then).
//                Loaded by the store itself after a diff lands when PLImage.wantsPreview(spec, data) (one op per
//                side, commitImageSide / workdirImageSide, each cancellable), reloaded with each side's
//                `knownKey` whenever the diff is re-fetched (an unchanged side keeps its URL; a Git LFS pointer
//                whose object isn't in the local cache is read again: it may have been downloaded), and null
//                whenever state.diff is closed or shows another file (set() drops it, cancelling the reads in flight).
//                The bytes live only in the URL cache, never in a state key (diffs are compared as JSON).
//                actions: loadImagePreview(spec, {force?, side?}) (force: the Load preview button, one side;
//                internally also `data`, the diff about to land),
//                closeImagePreview(), releaseImagePreview() (also empties the URL cache: the diff view unmounting)
//   undo         undo.getState() result | null: {undo: {action, description, entry}|null, redo: same|null,
//                busy, undoBlocked: string|null, redoBlocked: string|null}
//   remotes      configured remote names (ops 'remotes'), e.g. ['origin'], null until first read; read on the first load and
//                whenever `refs` changed (not on every refresh). The last list is kept when reading fails.
//   remotesError message when the last remotes read failed (logged too), else null
//   remoteOp     {op, opId} while a cancellable write (write(op, args, {cancellable: true}); the flows use it
//                for fetch, pull, push, rebase, rebaseInteractive, rebaseContinue and rebaseSkip) runs, else
//                null; actions.cancelRemote() cancels it
//   pullMode     the Pull button's default mode (flows-sync.js: PLFlows.pullMode / setPullMode), null until known;
//                actions.setPullMode(mode) (app.js on a repo switch, PLFlows.setPullMode, which also stores it)
//   undoError    message when undo state couldn't be read, else null
//   busy         true while a write op runs for this repo (app.js from 'busy' events: actions.setBusy(bool))
//   loading      true during the first load of a repo
//   loadError    message when the repo's first load failed (nothing could be shown), else null
//   continueDraft {key, message} | null: the commit composer's edited message for the rebase stop /
//                merge in progress (key: PLOp.composerMode(status).key), set by composer.js
//                (actions.setContinueDraft; the flows clear it after the op), read by
//                PLFlows.rebaseContinue / mergeCommit when the banner runs them; null when unedited
//   rebaseEditor null | the interactive rebase editor shown in place of the graph (docs/plans/rebase.md §5.6):
//                {plan (rebasePlan result), model (window.PLRebase model), args: {upstream, onto?} (as the flow
//                got them, for Reload), names: {branch, onto} (display-safe), past / future: [model] (the
//                editor's undo / redo stacks), stale: string | null (why Start is refused until Reload),
//                running: boolean}
//                actions: openRebaseEditor({plan, args, names}), closeRebaseEditor(), editRebase(fn) -> boolean
//                (fn(model) -> model; a changed model is recorded for undo and clears redo), undoRebaseEdit() /
//                redoRebaseEdit() -> boolean, resetRebaseEditor(), patchRebaseEditor(patch). While it is open
//                openDiff shows the notice "Close the rebase editor to view diffs" instead (the editor owns the
//                centre); opening it closes the diff.
//   centre       derived (never set): what the centre pane shows, 'rebaseEditor' while state.rebaseEditor is
//                set, else 'diff' while state.diff is, else 'graph'. It changes in the same set() as those
//                keys; graph-view, diff-view and rebase-editor each show themselves only for their value.
//
// A rebase or merge in progress (status.state !== 'clean', docs/plans/rebase.md §5.4) keeps the WIP
// row in the graph even with a clean tree (an edit stop), so its banner and composer stay reachable.
//
// Helpers: store.isDirty(status = state.status), store.hasWip(status = state.status) (the WIP row is
// shown: dirty or an operation in progress), store.rowIndexOf(sel = state.selection) -> row index | -1,
// store.headAncestors() / store.ancestorsOf(sha) -> Set of loaded hashes reachable from HEAD / sha
// (itself included) | null when it isn't loaded. window.Store.headAncestors / ancestorsOf /
// tipsContaining are history-model.js' (window.PLHistory: pure, cached per commits array).
// Notices: store.actions.notify(message) shows an informational toast (errors: actions.toast(err)).
// store.setToast(fn): fn(errorOrNotice); a notice is {message, level: 'info'}.
// File watcher: store.actions.watchEvent(e) takes main's 'watch' events ({repo, kinds, paths?, error?})
// and runs the refresh they call for; events for another repo root are ignored.
(function () {
  // The first page is read (and laid out) before the repo shows, so it stays well under LOG_MAX:
  // 1500 commits are ~50 screens of 28 px rows, more than most sessions scroll. Later pages are
  // small (one log call per ~5600 px of scrolling) so paging never stalls the graph.
  const PAGE_FIRST = 1500;
  const PAGE_MORE = 200;
  // Mirrors LOG_MAX in src/ops.js (the log op rejects a larger limit): refresh re-reads the whole
  // loaded history in one call, so no more than this many commits are ever loaded.
  const LOG_MAX = 10000;
  const WIP = 'WIP';

  const sameJSON = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

  const toError = (e) => window.Components.util.toError(e);
  // Console + main.log (Components.util.log); looked up per call, the harness may swap Components.
  const logError = (...a) => {
    const util = window.Components && window.Components.util;
    if (util && util.log) util.log.error(...a);
    else console.error(...a);
  };

  // The loaded history's ancestor sets and tip walks (history-model.js loads before this script).
  const { ancestorsOf, headAncestors, tipsContaining } = window.PLHistory;

  /** create(api, {urlApi}): urlApi (createObjectURL / revokeObjectURL, default URL) is for the tests. */
  function create(api, { urlApi } = {}) {
    const listeners = new Set();
    const state = {
      repo: null, status: null, refs: null, refsBySha: new Map(), stashes: [],
      stashError: null, commits: [], hasMore: false, next: null, graph: { width: 0, rows: [] }, rows: [],
      selection: null, commitFiles: null, diff: null, undo: null, undoError: null, busy: false, loading: false,
      loadError: null, remotes: null, remotesError: null, remoteOp: null, pullMode: null, continueDraft: null,
      rebaseEditor: null, worktrees: null, worktreeDirty: null, worktreeReveal: 0, centre: 'graph', imagePreview: null,
    };
    let loadSeq = 0; // guards against out-of-order loads (repo switch, rapid refreshes)
    // History bookkeeping for state.commits: hashes loaded (paging de-dup), the ref-tips signature
    // the log was read at (an unchanged signature skips re-reading it), the resumable layout of
    // state.rows and the WIP/HEAD key it was built for.
    let seen = new Set();
    let logSig = null;
    let layouter = null;
    let layoutKey = null;
    let remotesSeq = 0; // latest remotes read; an older one never lands after it
    let watchNoticed = null; // 'gone' | 'error' once that notice was shown for this repo load

    /** The derived state.centre for the current rebaseEditor / diff. */
    const centreOf = (s) => {
      if (s.rebaseEditor) return 'rebaseEditor';
      return s.diff ? 'diff' : 'graph';
    };

    function set(patch) {
      const changed = [];
      for (const k of Object.keys(patch)) {
        if (k !== 'centre' && state[k] !== patch[k]) {
          state[k] = patch[k];
          changed.push(k);
        }
      }
      if (!changed.length) return;
      // The image preview belongs to the open diff: it goes when the diff closes or shows another file.
      if (changed.includes('diff') && state.imagePreview && !(state.diff && Img().sameTarget(state.diff.spec, state.imagePreview.spec))) {
        dropPreview();
        state.imagePreview = null;
        if (!changed.includes('imagePreview')) changed.push('imagePreview');
      }
      const centre = centreOf(state);
      if (centre !== state.centre) {
        state.centre = centre;
        changed.push('centre');
      }
      for (const l of [...listeners]) {
        if (!l.keys || l.keys.some((k) => changed.includes(k))) {
          try {
            l.fn(state, changed);
          } catch (e) {
            logError(e);
          }
        }
      }
    }

    function subscribe(keys, fn) {
      const l = { keys: keys && keys.length ? keys : null, fn };
      listeners.add(l);
      return () => listeners.delete(l);
    }

    const invoke = (op, ...args) => api.invoke(op, ...args).catch((e) => { throw toError(e); });

    let toastFn = (e) => logError(e);
    const toast = (e) => toastFn(e);

    // ---------------------------------------------------------------- derived data

    function indexRefs(refs) {
      const m = new Map();
      const add = (sha, r) => {
        if (!sha) return;
        if (!m.has(sha)) m.set(sha, []);
        m.get(sha).push(r);
      };
      if (!refs) return m;
      if (refs.head && refs.head.detached && refs.head.oid) add(refs.head.oid, { type: 'head', name: 'HEAD' });
      for (const b of refs.local) add(b.oid, { type: 'local', name: b.name, current: b.current, upstream: b.upstream });
      for (const b of refs.remote) add(b.oid, { type: 'remote', name: b.name, remote: b.remote, branch: b.branch });
      for (const t of refs.tags) add(t.oid, { type: 'tag', name: t.name });
      return m;
    }

    const isDirty = (st) => !!st && (st.staged.length + st.unstaged.length + st.conflicted.length > 0);
    // A rebase / merge / … in progress (status.state; window.PLOp, op-model.js, loads before this script).
    const opInProgress = (st) => !!st && window.PLOp.inProgress(st);
    /** The WIP row is shown: local changes, or an operation in progress (even with a clean tree). */
    const hasWip = (st) => isDirty(st) || opInProgress(st);

    /** What the rows' layout depends on besides the commits: the WIP row and HEAD. */
    const wipKey = (status) => `${hasWip(status) ? 'wip' : 'clean'}:${(status && status.oid) || ''}`;

    /** Everything git.log walks from: HEAD and every branch, remote branch and tag tip. */
    const tipsSig = (status, refs) => JSON.stringify([
      status && status.oid, refs && refs.head && refs.head.oid,
      ...['local', 'remote', 'tags'].map((k) => ((refs && refs[k]) || []).map((r) => r.oid)),
    ]);

    const rowOf = (c) => ({ kind: 'commit', commit: c });
    const inputOf = (c) => ({ hash: c.hash, parents: c.parents });

    /** rows + graph layout; the WIP row sits on top, parented to HEAD, when hasWip(status). */
    function layoutRows(commits, status) {
      const rows = [];
      const input = [];
      const wip = hasWip(status);
      if (wip) {
        rows.push({ kind: 'wip' });
        input.push({ hash: WIP, parents: status.oid ? [status.oid] : [] });
      }
      for (const c of commits) {
        rows.push(rowOf(c));
        input.push(inputOf(c));
      }
      // HEAD's first-parent chain (through the WIP row when shown) stays in lane 0.
      const pinned = wip ? WIP : status && status.oid;
      layouter = window.Graph.createLayout(pinned ? { pinned } : {});
      layoutKey = wipKey(status);
      return { rows, graph: layouter.add(input) };
    }

    /** rows + graph after appending a history page: resumes the saved layout when possible. */
    function appendRows(fresh, commits) {
      if (!layouter || !layouter.canResume || layouter.count !== state.rows.length || layoutKey !== wipKey(state.status)) {
        return layoutRows(commits, state.status);
      }
      return { rows: state.rows.concat(fresh.map(rowOf)), graph: layouter.add(fresh.map(inputOf)) };
    }

    // row index by selection, cached per rows array
    let rowIndex = { rows: null, map: null };
    function rowIndexOf(sel = state.selection) {
      if (!sel) return -1;
      if (rowIndex.rows !== state.rows) {
        const map = new Map();
        state.rows.forEach((r, i) => map.set(r.kind === 'wip' ? WIP : r.commit.hash, i));
        rowIndex = { rows: state.rows, map };
      }
      const i = rowIndex.map.get(sel.kind === 'wip' ? WIP : sel.sha);
      return i === undefined ? -1 : i;
    }

    /**
     * Where a working-copy diff spec points after a status change: the same spec, a corrected one
     * (untracked -> tracked unstaged; staged rename orig updated), or null when the file left the list.
     */
    function followSpec(spec, status) {
      const find = (list) => list.find((f) => f.path === spec.file);
      if (spec.staged) {
        const e = find(status.staged);
        if (!e) return null;
        const orig = e.orig || undefined;
        return orig === spec.orig ? spec : { ...spec, orig };
      }
      const e = find(status.unstaged) || find(status.conflicted);
      if (!e) return null;
      const untracked = e.status === '?';
      return untracked === !!spec.untracked ? spec : { ...spec, untracked };
    }

    // ---------------------------------------------------------------- actions

    async function loadRepo(repo) {
      const seq = ++loadSeq;
      seen = new Set();
      logSig = null;
      layouter = null;
      layoutKey = null;
      watchNoticed = null;
      dirtyAt = 0;
      dirtyKey = '';
      dirtyInFlight = null;
      dropPreview();
      images.clear();
      set({
        repo, loading: true, status: null, refs: null, refsBySha: new Map(), stashes: [], stashError: null,
        commits: [], hasMore: false, next: null, rows: [], graph: { width: 0, rows: [] }, selection: null,
        commitFiles: null, diff: null, undo: null, undoError: null, loadError: null, remotes: null, remotesError: null,
        remoteOp: null, continueDraft: null, rebaseEditor: null, worktrees: null, worktreeDirty: null, imagePreview: null,
      });
      try {
        await refresh({ first: true });
      } finally {
        if (seq === loadSeq) set({ loading: false });
      }
    }

    // What a refresh reads. FULL: everything (the log too when a tip moved). A partial scope
    // {status, stashes, paths} comes from the file watcher: status re-reads status + undo state and
    // reloads an open working-copy diff only when `paths` (null: unknown) includes its file;
    // stashes re-reads the stash list.
    const FULL = Object.freeze({ full: true });

    /** Union of two scopes (either may be null). */
    function mergeScope(a, b) {
      if (!a) return b;
      if (!b) return a;
      if (a.full || b.full) return FULL;
      const pathsOf = (x) => (x.status ? x.paths : new Set()); // no status part: adds no paths
      const pa = pathsOf(a);
      const pb = pathsOf(b);
      return { status: !!(a.status || b.status), stashes: !!(a.stashes || b.stashes), paths: pa && pb ? new Set([...pa, ...pb]) : null };
    }

    // One refresh runs at a time per repo; calls made meanwhile coalesce into a single re-run (their
    // scopes merged), so an older result can never land after a newer one (focus, 'changed' and
    // watcher refreshes overlap constantly).
    let refreshing = null; // {seq, promise}
    let refreshAgain = null; // scope of the re-run requested meanwhile, or null

    /**
     * Reload status/refs/stashes/history/undo (or the parts `scope` names), keeping the loaded
     * history length and selection.
     */
    function refresh({ first = false, scope = FULL } = {}) {
      if (!state.repo) return Promise.resolve();
      const seq = loadSeq;
      if (refreshing && refreshing.seq === seq) {
        refreshAgain = mergeScope(refreshAgain, scope);
        return refreshing.promise;
      }
      const promise = (async () => {
        let isFirst = first;
        let next = scope;
        let lastError; // set by every pass of the loop
        do {
          refreshAgain = null;
          try {
            await refreshOnce(seq, isFirst, next);
            lastError = null;
          } catch (e) {
            lastError = e; // a re-run requested meanwhile still happens
            // Nothing could be loaded at all: say so instead of looking like an empty repo.
            if (seq === loadSeq && !state.status) set({ loadError: e.message || String(e) });
          }
          isFirst = false;
          next = refreshAgain;
        } while (next && seq === loadSeq); // NOSONAR(S2189): refreshAgain and loadSeq change while the loop body awaits
        if (lastError) throw lastError;
      })().finally(() => { if (refreshing && refreshing.promise === promise) refreshing = null; });
      refreshing = { seq, promise };
      return promise;
    }

    /**
     * What one refresh reads: `full` (everything; the first load, or before anything is known) or
     * only a partial scope's parts. `logFirst`: the log is read in parallel with the rest.
     */
    function readPlan(first, scope) {
      const full = first || !!scope.full || logSig === null || !state.status;
      return { first, full, status: full || !!scope.status, stashes: full || !!scope.stashes, logFirst: first || logSig === null };
    }

    /** The log read of a refresh: {log, started} (history length and cursor when the call went out). */
    async function readLog(first) {
      const started = { next: state.next, length: state.commits.length };
      const limit = first ? PAGE_FIRST : Math.min(LOG_MAX, Math.max(PAGE_FIRST, state.commits.length));
      return { log: await invoke('log', { limit }), started };
    }

    /**
     * The git reads of one refresh (plan: readPlan). Parts outside the plan are the current state.
     * Resolves null when the repo changed meanwhile, {again: true} when HEAD moved under a partial
     * refresh (its refs are the old ones: read everything next), else {status, refs, stashes, undo,
     * log, started}: stashes / undo are {value, error} (a failed read is value null plus its
     * message), log is null when no ref tip moved. A failed status, refs or log read rejects.
     */
    async function readParts(seq, plan) {
      const soft = (op) => invoke(op).then((value) => ({ value, error: null }), (e) => ({ value: null, error: e.message }));
      const reads = [
        plan.status ? invoke('status') : state.status,
        plan.full ? invoke('refs') : state.refs,
        plan.stashes ? soft('stashes') : { value: state.stashes, error: state.stashError },
        plan.status ? soft('undoState') : { value: state.undo, error: state.undoError },
      ];
      if (plan.logFirst) {
        const [status, refs, stashes, undo, history] = await Promise.all([...reads, readLog(plan.first)]);
        return { status, refs, stashes, undo, ...history };
      }
      const [status, refs, stashes, undo] = await Promise.all(reads);
      if (seq !== loadSeq) return null;
      const parts = { status, refs, stashes, undo, log: null, started: null };
      if (tipsSig(status, refs) === logSig) return parts;
      if (!plan.full) return { again: true };
      return { ...parts, ...(await readLog(plan.first)) };
    }

    /**
     * The open diff after a refresh: undefined (unchanged), null (closed) or a copy with its re-made
     * spec. A working-copy diff belongs to the WIP selection: it closes when WIP goes away, and
     * follows its file between lists (an untracked file becomes tracked once part of it is staged).
     */
    function diffAfter(d, selection, status) {
      if (!d || d.spec.kind !== 'workdir') return undefined;
      if (!(selection && selection.kind === 'wip')) return null;
      const spec = followSpec(d.spec, status);
      if (spec === null) return null;
      return spec === d.spec ? undefined : { ...d, spec };
    }

    /**
     * The state patch for one refresh's reads (readParts result): only keys whose content changed,
     * plus the error keys. A new log also replaces the history bookkeeping (seen, logSig) and the
     * layout (layoutRows) — the same when only the WIP row / HEAD moved.
     */
    function patchFor({ status: readStatus, refs, stashes: readStashes, undo, log }) {
      const status = sameJSON(state.status, readStatus) ? state.status : readStatus;
      // A failed stash read (value null) keeps the last list.
      const stashes = readStashes.value === null || sameJSON(state.stashes, readStashes.value) ? state.stashes : readStashes.value;
      const commits = log ? log.commits : state.commits;
      if (log) {
        seen = new Set(commits.map((c) => c.hash));
        logSig = tipsSig(status, refs);
      }
      const hasMore = !!log && log.hasMore && commits.length < LOG_MAX;
      const layout = log || layoutKey !== wipKey(status) ? layoutRows(commits, status) : null;

      // Keep the selection if it still exists (stashes are selectable but never in the log);
      // otherwise default to WIP (dirty, or mid-rebase / merge) or HEAD.
      const sel = state.selection;
      const exists = !!sel && (sel.kind === 'wip'
        ? hasWip(status)
        : seen.has(sel.sha) || stashes.some((st) => st.hash === sel.sha));
      let fallback = null;
      if (hasWip(status)) fallback = { kind: 'wip' };
      else if (commits[0]) fallback = { kind: 'commit', sha: status.oid || commits[0].hash };
      const diff = diffAfter(state.diff, exists ? sel : fallback, status);
      return {
        loadError: null, undoError: undo.error, stashError: readStashes.error,
        ...(status !== state.status && { status }),
        ...(!sameJSON(state.refs, refs) && { refs, refsBySha: indexRefs(refs) }),
        ...(stashes !== state.stashes && { stashes }),
        ...(!sameJSON(state.undo, undo.value) && { undo: undo.value }),
        ...(log && { commits, hasMore, next: hasMore ? log.next : null }),
        ...layout,
        ...(!exists && { selection: fallback }),
        ...(diff !== undefined && { diff }),
      };
    }

    /**
     * One refresh: status, refs, stashes and undo state, then the history only when a ref tip or HEAD
     * moved (or on the first load, when it is read in parallel). Only keys whose content changed are
     * set, so an idle refresh (focus, watcher) notifies nobody. A partial `scope` reads only its
     * parts; when HEAD turns out to have moved, a full refresh is queued behind it.
     */
    async function refreshOnce(seq, first, scope = FULL) {
      const plan = readPlan(first, scope);
      const parts = await readParts(seq, plan);
      if (!parts || seq !== loadSeq) return;
      // A loadMore page landed while the log was read: this log is shorter than (or out of step with)
      // the loaded history. Drop it (like a HEAD move under a partial refresh) and re-run in full.
      const logStale = !!parts.log && (state.next !== parts.started.next || state.commits.length !== parts.started.length);
      if (parts.again || logStale) {
        refreshAgain = mergeScope(refreshAgain, FULL);
        return;
      }
      const patch = patchFor(parts);
      set(patch);
      // Remotes rarely change: read them with the first load and when refs moved (a new remote shows
      // up as new remote branches after its first fetch; flows re-read them before choosing one).
      if (first || patch.refs) loadRemotes();
      // The sidebar's Worktrees section and the bare banner's "Open worktree" buttons: a worktree added,
      // removed or locked from a terminal shows up with the next full refresh (window focus, the watcher).
      if (plan.full) loadWorktrees();
      if (patch.selection && patch.selection.kind === 'commit') loadCommitFiles(patch.selection.sha);
      if (state.diff && diffNeedsReload(state.diff.spec, plan.full ? FULL : scope, !!patch.diff)) reloadDiff();
    }

    /**
     * Whether a refresh of `scope` must re-fetch the open diff: always after a full one; after a
     * watcher refresh, only a working-copy diff whose status part ran and whose file is among the
     * changed paths (or the paths are unknown), or whose spec was just re-made.
     */
    function diffNeedsReload(spec, scope, specChanged) {
      if (scope.full || specChanged) return true;
      if (spec.kind !== 'workdir' || !scope.status) return false;
      return !scope.paths || scope.paths.has(spec.file) || (!!spec.orig && scope.paths.has(spec.orig));
    }

    /**
     * Main's 'watch' event ({repo, kinds, paths?, error?}) for the open repo: 'full' / 'refs' run a
     * full refresh, 'status' / 'stashes' only their parts; 'gone' and 'error' show a notice once
     * per repo load (the last state stays; window focus still refreshes).
     */
    function watchEvent(e) {
      if (!e || !state.repo || e.repo !== state.repo.root || !Array.isArray(e.kinds)) return;
      const kinds = e.kinds;
      const once = (kind, message) => {
        if (watchNoticed === kind) return;
        watchNoticed = kind;
        toastFn({ message, level: 'info' });
      };
      if (kinds.includes('gone')) {
        once('gone', 'This repository was moved or deleted');
        return;
      }
      if (kinds.includes('error')) {
        once('error', `Auto-refresh is off${e.error ? ` (${e.error})` : ''}: changes made outside Pasta Lite show up when the window regains focus`);
        return;
      }
      watchNoticed = null; // watching again: a later failure is worth a new notice
      const scope = watchScope(kinds, e.paths);
      if (scope) refresh({ scope }).catch(toast);
    }

    /** The refresh scope for a watch event's kinds (FULL, a partial scope, or null: nothing to read). */
    function watchScope(kinds, paths) {
      if (kinds.includes('full') || kinds.includes('refs')) return FULL;
      if (!kinds.includes('status') && !kinds.includes('stashes')) return null;
      return { status: kinds.includes('status'), stashes: kinds.includes('stashes'), paths: Array.isArray(paths) ? new Set(paths) : null };
    }

    /**
     * Re-read the configured remotes into state.remotes; resolves with the list (the last one on
     * failure) and never rejects. A failure is logged and kept in state.remotesError (cleared by
     * the next successful read), so callers can tell "couldn't read them" from "there are none".
     */
    async function loadRemotes() {
      if (!state.repo) return state.remotes || [];
      const seq = loadSeq;
      const mine = ++remotesSeq;
      const latest = () => seq === loadSeq && mine === remotesSeq;
      const list = await invoke('remotes').then((l) => (Array.isArray(l) ? l : []), (e) => {
        logError('[store] could not read the remotes:', e);
        if (latest()) set({ remotesError: e.message || String(e) });
        return null;
      });
      if (list && latest()) set(sameJSON(state.remotes, list) ? { remotesError: null } : { remotesError: null, remotes: list });
      return seq === loadSeq ? state.remotes || [] : [];
    }

    let worktreesSeq = 0; // latest worktrees read; an older one never lands after it

    /**
     * Re-read state.worktrees, then their dirty state when it is wanted; never rejects, a failure is
     * logged and keeps the last list.
     */
    async function loadWorktrees() {
      const seq = loadSeq;
      const mine = ++worktreesSeq;
      const list = await invoke('worktrees').then((l) => (Array.isArray(l) ? l : []), (e) => {
        logError('[store] could not read the worktrees:', e);
        return null;
      });
      if (!list || seq !== loadSeq || mine !== worktreesSeq) return;
      if (!sameJSON(state.worktrees, list)) set({ worktrees: list });
      if (dirtyWanted) loadWorktreeDirty();
    }

    const DIRTY_TTL_MS = 5000;
    let dirtyWanted = false; // the sidebar's Worktrees section is open
    let dirtySeq = 0; // latest dirty read; an older one never lands after it
    let dirtyAt = 0; // when the last dirty read for dirtyKey finished (0: none, or it failed)
    let dirtyKey = ''; // JSON of the sorted paths that read checked
    let dirtyInFlight = null; // {key, promise} of the dirty read still running, else null

    /**
     * Re-read state.worktreeDirty (ops worktreeDirty) unless the same linked worktrees were checked
     * < DIRTY_TTL_MS ago or are being checked right now (that read's promise is returned, so a slow
     * read is never overlapped by another for the same paths). Never rejects.
     */
    function loadWorktreeDirty() {
      if (!state.repo || !Array.isArray(state.worktrees)) return Promise.resolve();
      const paths = state.worktrees.filter((w) => !w.bare && !w.prunable && !w.missing && !w.current).map((w) => w.path).sort();
      const key = JSON.stringify(paths);
      if (!paths.length) {
        dirtySeq++; // an older read must not land over this
        dirtyInFlight = null;
        dirtyKey = key;
        dirtyAt = Date.now();
        if (!sameJSON(state.worktreeDirty, {})) set({ worktreeDirty: {} });
        return Promise.resolve();
      }
      if (dirtyInFlight && dirtyInFlight.key === key) return dirtyInFlight.promise;
      if (key === dirtyKey && Date.now() - dirtyAt < DIRTY_TTL_MS) return Promise.resolve();
      const seq = loadSeq;
      const mine = ++dirtySeq;
      dirtyKey = key;
      dirtyAt = 0;
      const flight = { key, promise: null };
      flight.promise = (async () => {
        const list = await invoke('worktreeDirty').then((l) => (Array.isArray(l) ? l : []), (e) => {
          logError('[store] could not read the worktrees\' state:', e);
          return null;
        });
        if (dirtyInFlight === flight) dirtyInFlight = null;
        if (seq !== loadSeq || mine !== dirtySeq) return;
        if (!list) return; // a failure: dirtyAt stays 0, so the next read retries
        dirtyAt = Date.now();
        const dirty = {};
        for (const e of list) if (e && typeof e.path === 'string') dirty[e.path] = e.dirty === true || e.dirty === false ? e.dirty : null;
        if (!sameJSON(state.worktreeDirty, dirty)) set({ worktreeDirty: dirty });
      })();
      dirtyInFlight = flight;
      return flight.promise;
    }

    /** The sidebar's Worktrees section opened (true) or closed: the dirty dots are read only while it is open. */
    function setWorktreeDirtyWanted(on) {
      dirtyWanted = !!on;
      if (dirtyWanted) loadWorktreeDirty();
    }

    let loadingMore = null; // {seq, next, promise}
    let loadMoreFailed = null; // {seq, next, at}: back off after a failure (scroll calls this every render)
    const LOAD_MORE_BACKOFF_MS = 5000;

    /** Load the next history page. Concurrent calls share the in-flight load (per repo). */
    function loadMore() {
      if (loadingMore && loadingMore.seq === loadSeq && loadingMore.next === state.next) return loadingMore.promise;
      if (!state.hasMore || !state.next) return Promise.resolve();
      const room = LOG_MAX - state.commits.length;
      if (room <= 0) {
        set({ hasMore: false, next: null });
        return Promise.resolve();
      }
      if (loadMoreFailed && loadMoreFailed.seq === loadSeq && loadMoreFailed.next === state.next
        && Date.now() - loadMoreFailed.at < LOAD_MORE_BACKOFF_MS) return Promise.resolve();
      const seq = loadSeq;
      const startedNext = state.next;
      const promise = (async () => {
        const res = await invoke('log', { limit: Math.min(PAGE_MORE, room), ...startedNext }).catch((e) => {
          loadMoreFailed = { seq, next: startedNext, at: Date.now() };
          throw e;
        });
        // A refresh (or repo switch) replaced the history meanwhile: this page belongs to the old walk.
        if (seq !== loadSeq || state.next !== startedNext) return;
        const fresh = res.commits.filter((c) => !seen.has(c.hash));
        for (const c of fresh) seen.add(c.hash);
        const commits = state.commits.concat(fresh);
        const { rows, graph } = appendRows(fresh, commits);
        const hasMore = res.hasMore && commits.length < LOG_MAX;
        set({ commits, hasMore, next: hasMore ? res.next : null, rows, graph });
      })().finally(() => { if (loadingMore && loadingMore.promise === promise) loadingMore = null; });
      loadingMore = { seq, next: startedNext, promise };
      return promise;
    }

    async function loadCommitFiles(sha) {
      const seq = loadSeq;
      const current = () => seq === loadSeq && state.commitFiles && state.commitFiles.sha === sha;
      set({ commitFiles: { sha, files: null, loading: true, error: null } });
      try {
        const files = await invoke('commitFiles', sha);
        if (current()) set({ commitFiles: { sha, files, loading: false, error: null } });
      } catch (e) {
        if (current()) set({ commitFiles: { sha, files: null, loading: false, error: e.message } });
      }
    }

    /** sel: {kind:'wip'} | {kind:'commit', sha} (stash commits too). Closes an open diff. */
    function select(sel) {
      const same = state.selection && sel && state.selection.kind === sel.kind && state.selection.sha === sel.sha;
      if (same) return;
      set({ selection: sel, diff: null });
      if (sel && sel.kind === 'commit') loadCommitFiles(sel.sha);
    }

    /** Move the selection by `delta` rows in the graph (j/k, arrow keys). */
    function selectRelative(delta) {
      const rows = state.rows;
      if (!rows.length) return;
      const sel = state.selection;
      const idx = rowIndexOf(sel);
      if (sel && idx === -1) return; // e.g. a stash is selected: it has no row to move from
      const next = Math.max(0, Math.min(rows.length - 1, (idx === -1 ? 0 : idx + delta)));
      const r = rows[next];
      select(r.kind === 'wip' ? { kind: 'wip' } : { kind: 'commit', sha: r.commit.hash });
      if (next >= rows.length - 50) loadMore().catch(toast);
    }

    /** The {staged, untracked, orig?} options of a working-copy spec, as the workdir ops take them. */
    const workdirArgs = (spec) => ({ staged: !!spec.staged, untracked: !!spec.untracked, ...(spec.orig ? { orig: spec.orig } : {}) });

    async function fetchDiff(spec) {
      return spec.kind === 'commit'
        ? invoke('commitDiffView', spec.sha, spec.file, spec.orig)
        : invoke('workdirDiffView', spec.file, workdirArgs(spec));
    }

    // Every diff fetch gets a generation; only the latest one for the open spec may land.
    let diffGen = 0;

    async function loadDiff(spec, { keepData = false } = {}) {
      const seq = loadSeq;
      const gen = ++diffGen;
      const current = () => seq === loadSeq && gen === diffGen && state.diff && state.diff.spec === spec;
      if (!keepData) set({ diff: { spec, loading: true, data: null, error: null } });
      // A reload that brings exactly what is shown sets nothing, so the view keeps its DOM (and the
      // focused hunk button) instead of re-rendering.
      const land = (data, error) => {
        const d = state.diff;
        if (!d.loading && d.error === error && sameJSON(d.data, data)) return;
        set({ diff: { spec, loading: false, data, error } });
      };
      try {
        const data = await fetchDiff(spec);
        if (!current()) return;
        // The working-copy change is gone (file reverted/committed): close the diff.
        if (keepData && spec.kind === 'workdir' && !data.file && !data.conflict) set({ diff: null });
        else {
          // The preview's slots are in place before the body that shows them renders.
          previewFor(spec, data);
          land(data, null);
        }
      } catch (e) {
        if (!current()) return;
        previewFor(spec, null);
        land(null, e.message);
      }
    }

    /**
     * spec: {kind:'workdir', file, staged, untracked} | {kind:'commit', sha, file, orig}. Not while the
     * rebase editor is open (it owns the centre): a notice says so instead.
     */
    function openDiff(spec) {
      if (state.centre !== 'rebaseEditor') return loadDiff(spec);
      toastFn({ message: EDITOR_OWNS_DIFF, level: 'info' });
      return Promise.resolve();
    }

    /** Re-fetch the open diff after a refresh (keeps showing the old data meanwhile). */
    const reloadDiff = () => (state.diff ? loadDiff(state.diff.spec, { keepData: true }) : Promise.resolve());

    const closeDiff = () => set({ diff: null });

    // ---------------------------------------------------------------- image preview

    const Img = () => window.PLImage;
    const images = window.PLImageCache.create(urlApi || URL);
    const LOADING_SLOT = Object.freeze({ loading: true, side: null, url: null, error: null });
    let previewGen = 0; // bumped when the preview is dropped: reads started before never land
    const SIDES = ['old', 'new', 'base'];
    const sideGen = { old: 0, new: 0, base: 0 }; // the latest read per side; an older one never lands after it
    const inflight = { old: null, new: null, base: null }; // op id of each side's running read

    /** Cancel `which` side's running read (main kills its git process); it then rejects 'aborted'. */
    function cancelSide(which) {
      const opId = inflight[which];
      inflight[which] = null;
      if (!opId || !api.app || typeof api.app.cancel !== 'function') return;
      Promise.resolve().then(() => api.app.cancel(opId)).catch((e) => logError('[store] could not cancel an image read:', e));
    }

    /** Forget the preview's reads: cancel them all, let none land, unpin its URLs. (set() / close.) */
    function dropPreview() {
      previewGen++;
      for (const w of SIDES) cancelSide(w);
      images.pin([]);
    }

    /** One side's read: commitImageSide / workdirImageSide with an op id (cancellable). */
    function fetchImageSide(opId, spec, which, o) {
      const call = (op, ...args) => (opId && typeof api.invokeCancellable === 'function'
        ? api.invokeCancellable(opId, op, ...args) : api.invoke(op, ...args));
      return spec.kind === 'commit'
        ? call('commitImageSide', spec.sha, spec.file, spec.orig || null, which, o)
        : call('workdirImageSide', spec.file, workdirArgs(spec), which, o);
    }

    /**
     * The key a reload may send for a shown side: its bytes are still cached (or it has none to show).
     * None for a Git LFS pointer: its object may have reached the local LFS cache since.
     */
    function knownKeyOf(slot) {
      const side = slot && !slot.error ? slot.side : null;
      if (!side || !side.key || side.kind === 'lfs-pointer') return null;
      return side.kind !== 'image' || images.has(side.key) ? side.key : null;
    }

    /** Keep the URLs on screen from being evicted. */
    function pinShown() {
      const p = state.imagePreview;
      images.pin(p ? SIDES.map((w) => p[w]).filter((s) => s && s.url).map((s) => s.side.key) : []);
    }

    async function loadSide(spec, which, { force, knownKey }) {
      const seq = loadSeq;
      const gen = previewGen;
      const mine = ++sideGen[which];
      cancelSide(which);
      const opId = typeof api.newOpId === 'function' ? api.newOpId() : null;
      inflight[which] = opId;
      const current = () => seq === loadSeq && gen === previewGen && mine === sideGen[which]
        && !!state.imagePreview && Img().sameTarget(state.imagePreview.spec, spec);
      const o = { ...(knownKey && { knownKey }), ...(force && { force: true }) };
      let res = null;
      let error = null;
      try {
        res = await fetchImageSide(opId, spec, which, o);
      } catch (e) {
        error = toError(e);
      } finally {
        if (inflight[which] === opId) inflight[which] = null;
      }
      if (!current()) return;
      const p = state.imagePreview;
      const slot = p[which];
      if (error) {
        if (error.kind === 'aborted') return; // cancelled: a newer read (or none) owns the side
        // Saved while it was read: keep what is shown, the watcher's reload follows.
        if (error.kind === 'stale' && slot.side) return;
        set({ imagePreview: { ...p, [which]: { loading: false, side: null, url: null, error: error.message || String(error) } } });
        return;
      }
      if (res && res.unchanged) {
        if (slot.side && slot.side.key === res.key) return;
        await loadSide(spec, which, { force, knownKey: null }); // the slot moved on meanwhile: read it all
        return;
      }
      const { bytes, ...side } = res || {};
      const url = side.kind === 'image' && bytes ? images.put(side.key, bytes, side.mime) : null;
      set({ imagePreview: { ...p, [which]: { loading: false, side, url, error: null } } });
      pinShown();
    }

    /**
     * Load the open diff's image preview (every side, or `side` only): old and new, plus base for a
     * conflict (the open diff's data says, PLImage.previewKind). The same file as the preview shown
     * reloads each side with its key (unchanged sides keep their URL, nothing flickers); another
     * file, or a file that became or stopped being a conflict, starts over. force: lift the soft size
     * cap (Load preview). Not for a spec that isn't open.
     */
    function loadImagePreview(spec, { force = false, side = null, data } = {}) {
      const d = state.diff;
      if (!spec || !d || !Img().sameTarget(d.spec, spec)) return Promise.resolve();
      // previewFor passes the data about to land; the Load preview button the shown one.
      const conflict = Img().previewKind(spec, data === undefined ? d.data : data) === 'conflict';
      const all = conflict ? SIDES : ['old', 'new'];
      let p = state.imagePreview;
      const keep = !!p && Img().sameTarget(p.spec, spec) && !!p.conflict === conflict;
      if (keep) {
        if (p.spec !== spec) p = { ...p, spec };
      } else {
        dropPreview();
        p = { spec, conflict, old: LOADING_SLOT, new: LOADING_SLOT, ...(conflict ? { base: LOADING_SLOT } : {}) };
      }
      const sides = all.includes(side) ? [side] : all;
      if (force) for (const w of sides) p = { ...p, [w]: LOADING_SLOT };
      set({ imagePreview: p });
      return Promise.all(sides.map((w) => loadSide(spec, w, { force, knownKey: keep && !force ? knownKeyOf(p[w]) : null })));
    }

    /** The diff of `spec` landed with `data` (null: it failed): load its preview, or drop one it no longer wants. */
    function previewFor(spec, data) {
      if (Img().wantsPreview(spec, data)) loadImagePreview(spec, { data });
      else if (state.imagePreview) closeImagePreview();
    }

    function closeImagePreview() {
      dropPreview();
      set({ imagePreview: null });
    }

    /** closeImagePreview, and revoke every cached URL (the diff view unmounting). */
    function releaseImagePreview() {
      closeImagePreview();
      images.clear();
    }

    /**
     * Run a write op (stage, commit, discard, ...). Errors are toasted and re-thrown so callers can
     * react (e.g. keep the commit message on failure); a toasted error has `toasted = true`, so callers
     * don't show it twice. The 'changed' event from main triggers the refresh, so callers don't
     * refresh themselves. Returns the op's value.
     * opts.quiet: kinds (e.g. ['stale']) the caller handles itself — not toasted.
     * opts.cancellable: run it with an op id (api.invokeCancellable) published as state.remoteOp
     * while it runs, so actions.cancelRemote() can abort it (it then rejects with kind 'aborted').
     */
    async function write(op, args = [], { quiet = [], cancellable = false } = {}) {
      let mine = null;
      try {
        if (cancellable && typeof api.invokeCancellable === 'function' && typeof api.newOpId === 'function') {
          mine = { op, opId: api.newOpId() };
          set({ remoteOp: mine });
          return await api.invokeCancellable(mine.opId, op, ...args).catch((e) => { throw toError(e); });
        }
        return await invoke(op, ...args);
      } catch (e) {
        if (!quiet.includes(e.kind)) {
          e.toasted = true;
          toast(e);
        }
        throw e;
      } finally {
        if (mine && state.remoteOp === mine) set({ remoteOp: null });
      }
    }

    // ---------------------------------------------------------------- interactive rebase editor

    const REBASE_UNDO_MAX = 100;
    const EDITOR_OWNS_DIFF = 'Close the rebase editor to view diffs';
    const Rebase = () => window.PLRebase;

    /** Show the editor for a rebasePlan result (replaces an open one; closes the diff). */
    function openRebaseEditor({ plan, args, names } = {}) {
      if (!plan || !Rebase()) return false;
      set({
        diff: null,
        rebaseEditor: {
          plan, model: Rebase().fromPlan(plan), args: { ...(args || {}) }, names: { branch: 'HEAD', onto: '', ...(names || {}) },
          past: [], future: [], stale: null, running: false,
        },
      });
      return true;
    }

    const closeRebaseEditor = () => set({ rebaseEditor: null });

    const capped = (list, model) => [...list.slice(1 - REBASE_UNDO_MAX), model];

    /** Apply fn(model) -> model; a changed model goes on the undo stack (and clears redo). Returns whether it changed. */
    function editRebase(fn) {
      const ed = state.rebaseEditor;
      if (!ed || ed.running || typeof fn !== 'function') return false;
      const next = fn(ed.model);
      if (!next || next === ed.model) return false;
      set({ rebaseEditor: { ...ed, model: next, past: capped(ed.past, ed.model), future: [] } });
      return true;
    }

    /** The editor's ⌘Z: back one model (the current one goes on the redo stack). */
    function undoRebaseEdit() {
      const ed = state.rebaseEditor;
      if (!ed || ed.running || !ed.past.length) return false;
      set({ rebaseEditor: { ...ed, model: ed.past[ed.past.length - 1], past: ed.past.slice(0, -1), future: capped(ed.future || [], ed.model) } });
      return true;
    }

    /** The editor's ⌘⇧Z: forward one undone model. */
    function redoRebaseEdit() {
      const ed = state.rebaseEditor;
      const future = (ed && ed.future) || [];
      if (!ed || ed.running || !future.length) return false;
      set({ rebaseEditor: { ...ed, model: future[future.length - 1], past: capped(ed.past, ed.model), future: future.slice(0, -1) } });
      return true;
    }

    /** Back to the plan as loaded; clears the undo and redo stacks. */
    function resetRebaseEditor() {
      const ed = state.rebaseEditor;
      if (!ed || ed.running) return false;
      set({ rebaseEditor: { ...ed, model: Rebase().reset(ed.model), past: [], future: [] } });
      return true;
    }

    function patchRebaseEditor(patch) {
      const ed = state.rebaseEditor;
      if (!ed || !patch) return false;
      set({ rebaseEditor: { ...ed, ...patch } });
      return true;
    }

    /** Cancel the running cancellable write (state.remoteOp). Resolves true when main found it. */
    async function cancelRemote() {
      const r = state.remoteOp;
      if (!r || !api.app || typeof api.app.cancel !== 'function') return false;
      try {
        return (await api.app.cancel(r.opId)) === true;
      } catch (e) {
        toast(toError(e));
        return false;
      }
    }

    return {
      state,
      set,
      subscribe,
      invoke,
      isDirty: (st = state.status) => isDirty(st),
      hasWip: (st = state.status) => hasWip(st),
      rowIndexOf,
      headAncestors: () => headAncestors(state),
      ancestorsOf: (sha) => ancestorsOf(state.commits, sha),
      setToast: (fn) => { toastFn = fn; },
      actions: {
        loadRepo, refresh: () => refresh().catch(toast), loadMore: () => loadMore().catch(toast),
        reloadDiff, watchEvent, setWorktreeDirtyWanted, loadWorktreeDirty, loadImagePreview, closeImagePreview, releaseImagePreview,
        select, selectRelative, openDiff, closeDiff, toast, write, loadRemotes, cancelRemote,
        notify: (message) => toastFn({ message: String(message), level: 'info' }),
        openRebaseEditor, closeRebaseEditor, editRebase, undoRebaseEdit, redoRebaseEdit, resetRebaseEditor, patchRebaseEditor,
        setBusy: (busy) => set({ busy: !!busy }),
        setPullMode: (mode) => set({ pullMode: mode == null ? null : mode }),
        setContinueDraft: (draft) => set({ continueDraft: draft || null }),
        revealWorktree: () => set({ worktreeReveal: state.worktreeReveal + 1 }),
        /**
         * Main's fresh summary of the open repo (app.js, from app:getState): only what main may have
         * re-decided for the same root, linkedWorktree (the toolbar's chip and tooltip). Another root,
         * or nothing changed: no-op (no 'repo' notification, so nothing re-renders).
         */
        updateRepoInfo: (repo) => {
          const cur = state.repo;
          if (!repo || !cur || repo.root !== cur.root) return;
          const lw = repo.linkedWorktree || null;
          if (JSON.stringify(lw) === JSON.stringify(cur.linkedWorktree || null)) return;
          set({ repo: { ...cur, linkedWorktree: lw } });
        },
      },
    };
  }

  window.Store = { create, LOG_MAX, PAGE_FIRST, PAGE_MORE, ancestorsOf, headAncestors, tipsContaining };
})();
