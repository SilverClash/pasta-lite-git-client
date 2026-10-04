'use strict';
// Toolbar: the repository › branch breadcrumb (the repository stack opens the repository picker,
// components/repo-picker.js, ⌘P; the branch stack is the branch switcher), upstream pills,
// action buttons (Undo, Redo, Pull + mode menu, Push, Branch, Stash, Pop, Terminal), busy
// indicator with Cancel (while a cancellable op runs: fetch, pull, push, a rebase and its
// continue / skip). Opening a folder (Open…, ⌘O) lives in the picker. Without
// window.PLRepoPicker the repository stack runs the folder dialog. Actions run through
// window.PLFlows via Components.actions.runFlow (flows looked up at click time); which button is
// available, and why not, comes from the pure Components.actions.availability(). Unavailable
// buttons are aria-disabled but stay focusable and keep a tooltip with the reason.
// Undo / Redo / Branch (and Pull in Fetch All mode) tooltips end with their keybinding ("Undo (⌘Z)").
// The branch switcher is a Components.menu in search mode: typing filters the branches ("No branches
// match" when none do), ↑ / ↓ and Enter pick one, Esc clears the query, then closes; New branch… is
// pinned (always shown).
// A bare repository (repo.bare): a "bare" pill, Pull runs as Fetch All (the other modes are
// disabled in its menu), the switcher's checkouts are disabled (Components.actions.gateItems).
// A linked worktree (repo.linkedWorktree, decided in main): a "worktree" chip with a tree icon
// right of the repository stack (worktreeChipModel; tooltip: its folder and the main worktree);
// clicking it opens the sidebar's Worktrees section on the current worktree's row
// (store.actions.revealWorktree). None for a main worktree, a normal or a bare repository.
// The switcher's branches checked out in another worktree are disabled (checkoutItem with state:
// Components.actions.checkoutRefusal).
// Icons: window.PLIcons (renderer/icons.js).
(function () {
  const { el, util } = window.Components;
  const { toError, displayName, plural, short } = util;
  // Components.actions (renderer/actions.js) loads before the components; node tests that load this
  // script alone get a fresh copy bound to their window (util.load).
  const A = util.load('Components.actions', './actions.js');
  const { BUSY_TITLE, availability, headView, flowsOf, runFlow, toMenuItems, withKeyHint, gateItems, bareTitle, isBare, effectivePullMode, checkoutItem } = A;
  // Buttons whose tooltip also names their keybinding: button key -> Components.actions.KEYS name.
  const BUTTON_KEYS = { undo: 'undo', redo: 'redo', branch: 'branch' };

  /** Menu labels for PLFlows.PULL_MODES (the modes themselves are PLPolicy's). */
  const PULL_LABELS = {
    fetch: 'Fetch All',
    'ff-if-possible': 'Pull (fast-forward if possible)',
    'ff-only': 'Pull (fast-forward only)',
    rebase: 'Pull (rebase)',
  };
  const pullLabel = (m) => PULL_LABELS[m] || 'Pull';
  /**
   * What the Cancel button's tooltip calls a cancellable op (state.remoteOp.op): the rebase ops
   * (rebase, rebaseInteractive, rebaseContinue, rebaseSkip) by the operation's name (PLOp.opName),
   * the others by their own.
   */
  const cancelName = (op) => (/^rebase/.test(String(op || '')) && window.PLOp ? window.PLOp.opName({ state: 'rebasing' }) : String(op || 'operation'));
  const cancelTitle = (op) => `Cancel the running ${cancelName(op)}`;

  /**
   * Pull-mode menu entries for `modes` (PLFlows.PULL_MODES): [{mode, label, checked, disabled?, title?}];
   * `bare`: every mode but Fetch All is disabled (nothing to pull into).
   */
  function pullMenuModel(modes, current, { bare = false } = {}) {
    return (modes || []).map((mode) => {
      const x = { mode, label: pullLabel(mode), checked: mode === current };
      return bare && mode !== 'fetch' ? { ...x, disabled: true, title: bareTitle(pullLabel(mode)) } : x;
    });
  }

  /** The branch switcher's search field (Components.menu search mode). */
  const BRANCH_SEARCH = Object.freeze({ label: 'Filter branches', placeholder: 'Filter branches', empty: 'No branches match' });

  /** Branch-switcher entries: [{name, label, current}] — local branches in refs order. */
  function branchMenuModel(state) {
    const local = (state.refs && state.refs.local) || [];
    return local.map((b) => ({ name: b.name, label: displayName(b.name), current: !!b.current }));
  }

  function pill(text, cls, title) {
    const p = el('span', `tb-pill ${cls}`, text);
    p.title = title;
    return p;
  }

  /**
   * The linked-worktree chip of repo `r` (store repo): {text: 'worktree', title} when main says it is
   * a linked worktree (r.linkedWorktree), else null (main worktree, normal or bare repository).
   * The title: the worktree's folder, then the main worktree it belongs to (display-safe).
   */
  function worktreeChipModel(r) {
    const lw = r && !r.bare && r.linkedWorktree;
    if (!lw) return null;
    return { text: 'worktree', title: `${displayName(r.root)}\nLinked worktree of ${displayName(lw.mainPath)}` };
  }

  /** The repository stack's tooltip: the repo's folder (home-relative with the picker), or "Open". */
  function repoTitle(r) {
    if (!r) return withKeyHint('Open a repository', 'open');
    const picker = window.PLRepoPicker;
    const where = picker ? picker.homeShort(r.root, picker.source.get().home) : r.root;
    return withKeyHint(`${displayName(where)}\nSwitch or open a repository`, picker ? 'repoPicker' : 'open');
  }

  /**
   * The branch stack's text for head = headView(s): the branch, the branch being rebased (mid-rebase
   * HEAD is detached, docs/plans/rebase.md §3.4), the detached commit, or a placeholder.
   */
  function branchText(s, head) {
    if (head.branch || head.rebasingBranch) return head.label;
    if (head.detached) return `detached @ ${short(head.oid)}`;
    return s.loading ? '…' : '—';
  }

  /** The pills after the branch: bare, then the branch's upstream tracking (✓ / ↑n / ↓n or why none). */
  function trackingPills(s, { branch: rawBranch, oid }) {
    const bname = rawBranch ? displayName(rawBranch) : null;
    const st = s.status;
    const kids = [];
    if (isBare(s)) kids.push(pill('bare', 'muted', 'Bare repository — no working tree'));
    if (!st || !bname) return kids;
    const upstream = st.upstream ? displayName(st.upstream) : null;
    const local = s.refs && s.refs.local.find((b) => b.name === rawBranch);
    if (!oid) kids.push(pill('no commits', 'muted', 'This branch has no commits yet'));
    else if (local && local.gone) kids.push(pill('upstream gone', 'gone', `Upstream ${displayName(local.upstream)} no longer exists`));
    else if (!upstream) kids.push(pill('no upstream', 'muted', 'This branch does not track a remote branch'));
    else kids.push(...syncPills(st, upstream));
    return kids;
  }

  /** ✓ when in sync with `upstream`, else ↑ahead and / or ↓behind. */
  function syncPills(st, upstream) {
    if (!st.ahead && !st.behind) return [pill('✓', 'synced', `Up to date with ${upstream}`)];
    const kids = [];
    if (st.ahead) kids.push(pill(`↑${st.ahead}`, 'ahead', `${plural(st.ahead, 'commit')} ahead of ${upstream}`));
    if (st.behind) kids.push(pill(`↓${st.behind}`, 'behind', `${plural(st.behind, 'commit')} behind ${upstream}`));
    return kids;
  }

  // window.PLIcons (renderer/icons.js) loads before the components (util.load: a fresh copy under node).
  const { icon } = util.load('PLIcons', './icons.js');

  /** Disabled (aria-disabled) buttons stay focusable and keep their tooltip. */
  function setDisabled(btn, disabled, title) {
    if (disabled) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
    btn.title = title;
  }

  function actionButton(name, label, key) {
    const b = el('button', 'tb-action');
    b.type = 'button';
    b.dataset.action = key;
    b.append(icon(name, 18), el('span', 'tb-action-label', label));
    setDisabled(b, true, label);
    return b;
  }

  function stack(label, cls) {
    const b = el('button', `tb-stack ${cls}`);
    b.type = 'button';
    const value = el('span', 'tb-stack-value');
    const text = el('span', 'tb-stack-text');
    value.append(text, icon('chevron', 12, 'tb-caret'));
    b.append(el('span', 'tb-stack-label', label), value);
    return { b, text };
  }

  window.Components.register('toolbar', {
    mount(root, store) {
      root.setAttribute('role', 'toolbar');
      root.setAttribute('aria-label', 'Repository actions');
      const ac = new AbortController(); // every DOM listener below goes away with ac.abort()
      const listen = (node, fn) => node.addEventListener('click', fn, { signal: ac.signal });
      const toast = (e) => store.actions.toast(toError(e));
      const openRepo = () => window.api.app.openDialog().catch(toast);

      // ---- left: repository › branch breadcrumb + upstream pills
      const left = el('div', 'tb-left');
      const repo = stack('repository', 'tb-repo');
      repo.b.dataset.action = 'repoPicker';
      repo.b.setAttribute('aria-haspopup', 'dialog');
      repo.b.setAttribute('aria-expanded', 'false');
      const setExpanded = (on) => {
        repo.b.setAttribute('aria-expanded', on ? 'true' : 'false');
        repo.b.classList.toggle('is-open', on);
      };
      /** Toggle the repository picker under the stack (the folder dialog without the picker script). */
      function togglePicker() {
        const picker = window.PLRepoPicker;
        if (!picker) return openRepo();
        if (picker.isOpen()) { picker.close(); return null; }
        picker.open(repo.b, { onError: toast, onClose: () => setExpanded(false) });
        setExpanded(true);
        return null;
      }
      listen(repo.b, togglePicker);
      // ⌘P (app.js) toggles the picker as a click on the stack does (PLRepoPicker.toggle).
      const unhookPicker = window.PLRepoPicker && typeof window.PLRepoPicker.setToggle === 'function' ? window.PLRepoPicker.setToggle(togglePicker) : null;
      const branch = stack('branch', 'tb-branch');
      branch.b.dataset.action = 'switcher';
      branch.b.setAttribute('aria-haspopup', 'dialog'); // the switcher: a search field over a listbox
      branch.b.setAttribute('aria-expanded', 'false');
      const setBranchExpanded = (on) => branch.b.setAttribute('aria-expanded', on ? 'true' : 'false');
      // The linked-worktree chip (worktreeChipModel), hidden unless the repo is one.
      const wtChip = el('button', 'tb-pill muted tb-wt-chip');
      wtChip.type = 'button';
      wtChip.dataset.action = 'worktreeChip';
      wtChip.append(icon('worktree', 12), el('span', 'tb-wt-chip-text', 'worktree'));
      wtChip.hidden = true;
      listen(wtChip, () => store.actions.revealWorktree());
      const sep = icon('chevron-right', 14, 'tb-crumb-sep');
      const pills = el('div', 'tb-pills');
      left.append(repo.b, wtChip, sep, branch.b, pills);

      // ---- centre: actions
      const center = el('div', 'tb-center');
      const undo = actionButton('undo', 'Undo', 'undo');
      const redo = actionButton('redo', 'Redo', 'redo');
      const pullGroup = el('div', 'tb-split');
      const pull = actionButton('pull', 'Pull', 'pull');
      const pullMenu = el('button', 'tb-split-caret');
      pullMenu.type = 'button';
      pullMenu.dataset.action = 'pullMenu';
      pullMenu.setAttribute('aria-haspopup', 'menu');
      pullMenu.setAttribute('aria-label', 'Pull mode');
      pullMenu.append(icon('chevron', 12));
      setDisabled(pullMenu, true, 'Pull options');
      pullGroup.append(pull, pullMenu);
      const push = actionButton('push', 'Push', 'push');
      const newBranch = actionButton('branch', 'Branch', 'branch');
      const stash = actionButton('stash', 'Stash', 'stash');
      const pop = actionButton('pop', 'Pop', 'pop');
      const term = actionButton('terminal', 'Terminal', 'terminal');
      const group = (...items) => { const g = el('div', 'tb-group'); g.append(...items); return g; };
      center.append(group(undo, redo), group(pullGroup, push), group(newBranch), group(stash, pop), group(term));

      // ---- right: busy (+ Cancel while a fetch / pull / push runs)
      const right = el('div', 'tb-right');
      const busy = el('div', 'tb-busy');
      const busyStatus = el('span', 'tb-busy-status');
      busyStatus.setAttribute('role', 'status');
      busyStatus.setAttribute('aria-live', 'polite');
      busyStatus.append(el('span', 'tb-spinner'), el('span', 'tb-busy-text', BUSY_TITLE));
      const cancel = el('button', 'tb-cancel', 'Cancel');
      cancel.type = 'button';
      cancel.dataset.action = 'cancel';
      cancel.hidden = true;
      busy.append(busyStatus, cancel);
      right.append(busy);

      root.replaceChildren(left, center, right);

      // ---- actions (PLFlows / Components.menu are looked up when used)
      const buttons = { undo, redo, pull, pullMenu, push, branch: newBranch, stash, pop, terminal: term, switcher: branch.b };
      const pullModes = () => {
        const f = flowsOf();
        return f && Array.isArray(f.PULL_MODES) ? f.PULL_MODES : [];
      };
      /**
       * The Pull button's mode (Components.actions.effectivePullMode): Fetch All in a bare repository,
       * else state.pullMode (set by flows / app.js), else PLFlows.pullMode(store).
       */
      const currentPullMode = (s = store.state) => {
        const f = flowsOf();
        const fallback = () => (f && typeof f.pullMode === 'function' ? f.pullMode(store) : undefined);
        return effectivePullMode(s, pullModes().includes(s.pullMode) ? s.pullMode : fallback());
      };
      const model = (s = store.state) => {
        const mode = currentPullMode(s);
        return availability(s, { dirty: store.isDirty(s.status), pullMode: mode, pullLabel: pullLabel(mode) });
      };
      const run = (flow, ...args) => runFlow({ flow, args }, store);

      function choosePullMode(mode) {
        const f = flowsOf();
        if (f && typeof f.setPullMode === 'function') f.setPullMode(store, mode);
        render(store.state); // the Pull tooltip names the new default
        return run('pull', mode);
      }

      function openPullMenu() {
        const menu = window.Components.menu;
        if (!menu) return;
        menu.open(pullMenu, pullMenuModel(pullModes(), currentPullMode(), { bare: isBare(store.state) }).map((x) => ({
          label: x.label, checked: x.checked, action: () => { if (!x.disabled) choosePullMode(x.mode); },
          ...(x.mode === 'fetch' ? { title: withKeyHint('Fetch every remote', 'fetch') } : {}),
          ...(x.disabled ? { disabled: true, title: x.title } : {}),
        })));
      }

      function openBranchMenu() {
        const menu = window.Components.menu;
        if (!menu) return;
        const m = model();
        const bare = isBare(store.state);
        // The checkouts go through gateItems: disabled in a bare repository.
        const items = branchMenuModel(store.state).map((b) => (b.current
          ? { label: b.label, checked: true, title: bare ? `HEAD of the bare repository points at ${b.label}` : `${b.label} is checked out`, action: () => {} }
          : toMenuItems(gateItems([{ ...checkoutItem({ target: b.name, kind: 'local', label: b.label, title: `Check out ${b.label}`, state: store.state }), checked: false }], store.state), store)[0]));
        if (items.length) items.push({ separator: true });
        // New branch… stays in the list whatever the query (pinned).
        items.push(...toMenuItems([{ label: 'New branch…', disabled: m.branch.disabled, title: m.branch.title, flow: 'createBranch', args: [{}] }], store).map((x) => ({ ...x, pinned: true })));
        menu.open(branch.b, items, { search: BRANCH_SEARCH, onClose: () => setBranchExpanded(false) });
        setBranchExpanded(true);
      }

      const ACTIONS = {
        undo: () => run('undo'),
        redo: () => run('redo'),
        pull: () => run('pull', currentPullMode()),
        pullMenu: openPullMenu,
        push: () => run('push'),
        branch: () => run('createBranch', {}),
        stash: () => run('stashSave'),
        pop: () => run('stashPop'),
        terminal: () => run('openTerminal'),
        switcher: openBranchMenu,
      };
      for (const [key, btn] of Object.entries(buttons)) {
        listen(btn, () => {
          if (model()[key].disabled) return; // re-checked now: the rendered state may be stale
          ACTIONS[key]();
        });
      }
      // Cancel stays enabled while busy: PLFlows.cancel is one of the flows that run while busy.
      listen(cancel, () => {
        if (!store.state.remoteOp) return;
        run('cancel');
      });

      function render(s) {
        const r = s.repo;
        repo.text.textContent = r ? displayName(r.name) : '—';
        repo.b.title = repoTitle(r);
        const chip = worktreeChipModel(r);
        wtChip.hidden = !chip;
        wtChip.title = chip ? chip.title : '';
        wtChip.setAttribute('aria-label', chip ? chip.title.replace(/\n/g, ', ') : 'worktree');

        const head = headView(s);
        branch.b.classList.toggle('detached', head.detached);
        branch.text.textContent = branchText(s, head);
        pills.replaceChildren(...trackingPills(s, head));

        const m = model(s);
        const mode = currentPullMode(s);
        for (const [key, btn] of Object.entries(buttons)) {
          // The Pull button set to Fetch All is the same action as ⌘L.
          const hint = BUTTON_KEYS[key] || (key === 'pull' && mode === 'fetch' ? 'fetch' : null);
          setDisabled(btn, m[key].disabled, hint ? withKeyHint(m[key].title, hint) : m[key].title);
        }

        const op = s.remoteOp;
        cancel.hidden = !op;
        cancel.title = op ? cancelTitle(op.op) : '';
        busy.classList.toggle('on', !!s.busy || !!op);
        root.classList.toggle('is-busy', !!s.busy);
      }

      render(store.state);
      const off = store.subscribe(['repo', 'refs', 'remotes', 'status', 'stashes', 'undo', 'undoError', 'busy', 'loading', 'pullMode', 'remoteOp'], render);
      return () => {
        off();
        ac.abort();
        if (unhookPicker) unhookPicker();
        if (window.PLRepoPicker && window.PLRepoPicker.isOpen()) window.PLRepoPicker.close();
        const menu = window.Components.menu;
        if (menu && typeof menu.isOpen === 'function' && menu.isOpen()) menu.close();
        root.replaceChildren();
        root.classList.remove('is-busy');
      };
    },
  });

  if (typeof module !== 'undefined') {
    module.exports = { pullMenuModel, branchMenuModel, worktreeChipModel, PULL_LABELS, BRANCH_SEARCH, cancelTitle };
  }
})();
