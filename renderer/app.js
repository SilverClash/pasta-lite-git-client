'use strict';
// App bootstrap: the start screen (New Tab / no repo) and the repo view built from components
// (store.js, components/*). This page shows one repo; multi-repo tabs are separate pages (main).
// The recent list, the tabs and the current repo go to PLRepoPicker.source, which the start screen
// and the toolbar's repository picker render. All git-derived text is rendered with textContent.
(() => {
  const api = window.api;
  const $ = (id) => document.getElementById(id);

  const { toError } = window.Components.util;
  // The bridge rejects with a plain {message, kind, ...} object; toError makes it a real Error.
  const appCall = (name, ...args) => api.app[name](...args).catch((e) => { throw toError(e); });

  // busy: repo root -> number of writes running (events arrive for every repo, even after a switch).
  const state = { repo: null, recent: [], gitVersion: null, gitPath: null, busy: new Map() };

  const { el } = window.Components;
  const picker = window.PLRepoPicker;
  /** Feed the start screen and the repository picker (PLRepoPicker.source). */
  const share = () => picker.source.set({ recent: state.recent, current: state.repo ? state.repo.root : null });

  let toastTimer = null;
  const { logToast, isUnexpectedError } = window.Components.util;
  /**
   * Show an error, or a notice ({message, level: 'info'}, from store.actions.notify). Errors are
   * recorded in main.log (util.logToast: unexpected ones at error level); an unexpected one also
   * says where to find the details.
   */
  function toast(err) {
    const t = $('toast');
    const info = !!(err && err.level === 'info' && !(err instanceof Error));
    const text = err && err.message ? err.message : String(err);
    if (!info) logToast(err);
    if (!info && isUnexpectedError(err)) {
      t.replaceChildren(el('span', null, text), el('span', 'toast-hint', 'See Help → Show Logs for details.'));
    } else {
      t.textContent = text;
    }
    t.dataset.level = info ? 'info' : 'error';
    t.setAttribute('role', info ? 'status' : 'alert');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, info ? 4000 : 8000);
  }
  $('toast').addEventListener('click', () => { $('toast').hidden = true; });

  function setView(view) {
    document.body.dataset.view = view;
    $('welcome-view').hidden = view !== 'welcome';
    $('repo-view').hidden = view !== 'repo';
  }

  // ------------------------------------------------------------ start screen (New Tab / no repo)

  // Search + recent list + Open… (PLRepoPicker.mountStart); opening from it replaces this tab's
  // content (success arrives as 'repo-opened'), ⌘↵ / ⌘-click open another tab.
  const start = picker.mountStart($('start-screen'), { onError: toast });

  function showWelcome() {
    state.repo = null;
    share();
    document.title = picker.tabsAvailable() ? 'New Tab — Pasta Lite Git client' : 'Pasta Lite Git client';
    const gitText = state.gitVersion ? `git ${state.gitVersion}` : '';
    $('git-version').textContent = gitText && state.gitPath ? `${gitText} · ${state.gitPath}` : gitText;
    setView('welcome');
    start.focus();
    document.body.dataset.ready = '1';
  }

  const openDialog = () => picker.openFolder().catch(toast);

  // ------------------------------------------------------------ repo

  const store = window.Store.create(api);
  store.setToast(toast);
  const flows = window.PLFlows;
  // The Pull button's default mode is remembered per repo (flows-sync.js).
  store.subscribe(['repo'], (s) => store.actions.setPullMode(s.repo ? flows.pullMode(store) : null));
  const unmount = window.Components.mountAll($('repo-view'), store);
  // Release component listeners, observers and timers when the page goes away (reload, close).
  window.addEventListener('beforeunload', unmount);
  // Smoke/debug probe (main.js --smoke reads window.PL.probe()); only exposed in smoke runs.
  if (api.smoke) window.PL = {
    store,
    probe: () => ({
      repo: store.state.repo && store.state.repo.name,
      rows: store.state.rows.length,
      commits: store.state.commits.length,
      hasMore: store.state.hasMore,
      selection: store.state.selection,
      diff: store.state.diff && { spec: store.state.diff.spec, loading: store.state.diff.loading, error: store.state.diff.error },
      staged: store.state.status && store.state.status.staged.length,
      unstaged: store.state.status && store.state.status.unstaged.length,
      rebaseEditor: store.state.rebaseEditor && {
        rows: store.state.rebaseEditor.model.rows.map((r) => ({ sha: r.sha, action: r.action, subject: r.subject })),
        stale: store.state.rebaseEditor.stale, running: store.state.rebaseEditor.running,
      },
    }),
  };

  function renderBusy() {
    store.actions.setBusy(state.repo && state.busy.get(state.repo.root) > 0);
  }

  async function showRepo(repo) {
    state.repo = repo;
    share();
    picker.close(); // a picker left open belongs to the previous repo
    renderBusy(); // the previous repo's busy state must not stick
    document.body.dataset.ready = '0';
    document.title = `${repo.name} — Pasta Lite Git client`; // main titles the window (src/tabs.js tabTitle)
    setView('repo');
    try {
      await store.actions.loadRepo(repo);
    } catch (e) {
      toast(e);
    }
    document.body.dataset.ready = '1';
  }

  const refreshRepo = () => store.actions.refresh();

  /**
   * Main's fresh summary of the repo already shown (app:getState, same root): main re-decides
   * linkedWorktree there and updates the strip and the window title itself; the page takes it too,
   * so the toolbar's worktree chip and tooltip follow without a reopen.
   */
  function adoptRepo(repo) {
    state.repo = repo;
    store.actions.updateRepoInfo(repo);
  }

  // Global shortcuts: the Components.actions.KEYS entries with a flow (⌘Z undo, ⌘⇧Z
  // redo, ⌘L fetch, ⌘B new branch; Ctrl elsewhere), from any focus, run as PLFlows[entry.flow](store,
  // ...entry.args). In a text field only the `inField` ones (⌘Z / ⌘⇧Z stay the field's own undo /
  // redo); nothing while a dialog or menu is open; a key repeat is swallowed (they all write).
  // Whether it is available now is PLFlows.shortcutFor (the toolbar's gating). The WIP keys are
  // details.js'.
  const { inTextField, modalOpen } = window.Components.util;
  const { repeatBlocked, matchKey, effectivePullMode } = window.Components.actions;
  // ⌘O (folder dialog, this tab) and ⌘P (the repository picker; on the start screen: its search)
  // work with or without a repo and in text fields. Held keys act once.
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || modalOpen()) return;
    const k = matchKey(e);
    if (!k || (k.id !== 'open' && k.id !== 'repoPicker')) return;
    e.preventDefault();
    if (repeatBlocked(e, k)) return;
    if (k.id === 'open') openDialog();
    else if (!state.repo) start.focus();
    else picker.toggle(); // the toolbar's repository stack (PLRepoPicker.setToggle)
  });
  document.addEventListener('keydown', (e) => {
    if (!state.repo || e.defaultPrevented || modalOpen()) return;
    const ctx = {
      dirty: store.isDirty(),
      pullMode: effectivePullMode(store.state, store.state.pullMode || flows.pullMode(store)),
      inField: inTextField(e),
    };
    const name = flows.shortcutFor(e, store.state, ctx);
    const blocked = name ? null : flows.shortcutBlocked(e, store.state, ctx);
    if (!name && !blocked) return;
    e.preventDefault();
    if (repeatBlocked(e)) return;
    if (name) flows[name](store, ...matchKey(e).args);
    else if (!store.state.busy) store.actions.notify(blocked); // busy: the toolbar already says so
  });
  window.addEventListener('focus', () => { if (state.repo) refreshRepo(); });

  // ------------------------------------------------------------ wiring

  api.on('repo-opened', ({ repo, recent }) => {
    state.recent = recent || state.recent;
    showRepo(repo);
  });
  api.on('recent-changed', ({ recent }) => {
    state.recent = recent;
    share();
  });
  // The window's tabs (main, multi-repo tabs): the picker marks repos open in another tab. The
  // preload throws for an event it doesn't know (a main without tabs): then there are none.
  try {
    api.on('tabs-changed', ({ tabs } = {}) => picker.source.set({ tabs: Array.isArray(tabs) ? tabs : [] }));
  } catch {
    /* no tabs */
  }
  // 'changed' also fires after a failed write (it may have changed part of the repo).
  api.on('changed', ({ repo }) => { if (state.repo && repo === state.repo.root) refreshRepo(); });
  // File watcher: the store filters by repo root and refreshes only what changed.
  api.on('watch', (e) => {
    store.actions.watchEvent(e);
    // Main closes a repo that was moved or deleted; follow it to the welcome screen (the notice
    // says why) instead of refreshing a repo that is no longer open on every focus.
    if (state.repo && e && e.repo === state.repo.root && Array.isArray(e.kinds) && e.kinds.includes('gone')) {
      appCall('getState').then((s) => {
        state.recent = s.recent;
        if (s.repo && state.repo && s.repo.root === state.repo.root) adoptRepo(s.repo);
        share();
        if (!s.repo) showWelcome();
      }, toast);
    }
  });
  // App menu commands handled here: View > Reset Column Widths (the graph's PLColumns preference).
  api.on('menu-command', ({ id } = {}) => {
    if (id === 'resetColumnWidths' && window.PLColumns) window.PLColumns.prefs.reset();
  });
  api.on('busy', ({ repo, running }) => {
    const n = (state.busy.get(repo) || 0) + (running ? 1 : -1);
    if (n > 0) state.busy.set(repo, n);
    else state.busy.delete(repo);
    renderBusy();
  });

  appCall('getState').then((s) => {
    state.recent = s.recent;
    state.gitVersion = s.gitVersion;
    state.gitPath = s.gitPath;
    // Optional from main: this tab's id ({tabs: {count, id}}) and the home folder (for ~ in paths).
    picker.source.set({
      ...(s.tabs && s.tabs.id != null ? { tabId: s.tabs.id } : {}),
      ...(typeof s.home === 'string' && s.home ? { home: s.home } : {}),
    });
    if (s.repo) showRepo(s.repo);
    else showWelcome();
  }, (e) => {
    showWelcome();
    toast(e);
  });
})();
