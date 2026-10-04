'use strict';
// Left sidebar: filter box + collapsible LOCAL / REMOTE / TAGS / STASHES / WORKTREES sections.
// Branch names are grouped into folders by '/' prefix. Clicking a ref or stash selects its commit
// (store.actions.select); double-click checks out a branch / applies a stash, and a context menu
// (right-click, Shift+F10 or the ContextMenu key) offers the ref's actions, run through window.PLFlows.
// A branch checked out in another worktree is not checked out: no double-click, and its Checkout item
// is disabled with the reason (Components.actions.checkoutRefusal).
// Local branches can be multi-selected (⌘/Ctrl-click or ⌘/Ctrl+Space toggles, Shift-click or
// Shift+Arrow selects a range in visible order, a plain click or Esc goes back to one): the menu of a
// row in such a selection, and of a local folder, only deletes those branches (flow deleteBranches).
// WORKTREES lists git's worktrees of the repository (store worktrees, in git's order): the one this
// tab shows is highlighted, a dot marks uncommitted changes (store worktreeDirty, read only while the
// section is open: actions.setWorktreeDirtyWanted; the current one's from store.isDirty()).
// Double-click or Enter opens another worktree (flow openWorktree; Space and a click only focus it, and
// end a branch multi-selection), and its context menu is Components.actions.worktreeMenuItems (open,
// reveal, copy path, lock / unlock, prune, delete). The filter matches its branch, folder name or head.
// store.actions.revealWorktree() (the toolbar's linked-worktree chip; store worktreeReveal) opens the
// section (for now: a collapsed preference stays saved), clears a filter that hides the current worktree's row, then scrolls to that row, focuses it
// and flashes it (sb-flash, REVEAL_FLASH_MS); before the first worktrees read, the section header.
// Collapsed sections persist in localStorage (global), collapsed folders per repository. Git data goes
// through textContent only, via util.displayName (bidi/control characters shown as escapes).
(function () {
  const { el, util } = window.Components;
  const { displayName, relTime, absTime, storage, pathTree, repoKey, short, plural } = util;
  const icon = (name, size = 14, cls) => (window.PLIcons ? window.PLIcons.icon(name, size, cls) : el('span', 'icon')); // NOSONAR(S1788): the argument order of PLIcons.icon
  /** The refs list (store refs) that holds a row target of each ref kind. */
  const REF_LISTS = Object.freeze({ local: 'local', remote: 'remote', tag: 'tags' });

  const LS_SECTIONS = 'pl.sidebar.sections';
  const lsFolders = (repoRoot) => `pl.sidebar.folders.${repoKey(repoRoot)}`;
  const SECTIONS = [
    { id: 'local', title: 'Local', icon: 'laptop' },
    { id: 'remote', title: 'Remote', icon: 'cloud' },
    { id: 'tags', title: 'Tags', icon: 'tag' },
    { id: 'stashes', title: 'Stashes', icon: 'stash' },
    { id: 'worktrees', title: 'Worktrees', icon: 'worktree' },
  ];
  const WORKTREES = 'worktrees';
  const REVEAL_FLASH_MS = 1200; // how long a revealed worktree row stays highlighted

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const cmp = (a, b) => collator.compare(a, b);

  /** Folder tree of refs by '/' in `pathOf(item)`; files become {item, leafName}. */
  function buildTree(items, pathOf) {
    const withLeaf = items.map((item) => ({ item, leafName: String(pathOf(item)).split('/').pop() }));
    return pathTree(withLeaf, (x) => pathOf(x.item));
  }
  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const countLeaves = (node) => node.files.length + [...node.dirs.values()].reduce((n, c) => n + countLeaves(c), 0);

  // ------------------------------------------------------------------ model (pure)
  //
  // The sidebar is rendered from a plain model: sections of row descriptors
  //   {key, kind: 'ref'|'folder'|'stash'|'worktree', level, label, title, sha, cls, icon,
  //    badges: [{cls, text, icon?}], sub?, toggle?, expanded?, count?, date?}
  // `sub`: a muted second name after the label (a worktree's folder name).
  // Titles are display-safe; labels go through displayName when rendered. Equal models (compared
  // as JSON) mean the DOM is left alone.

  function folderDesc(key, level, label, open, count, iconName = 'folder') {
    return {
      key, kind: 'folder', level, label, title: displayName(label), sha: null, cls: iconName === 'remote' ? 'sb-remote-group' : '',
      icon: iconName === 'folder' && open ? 'folder-open' : iconName, badges: [], toggle: key, expanded: open, count: count || 0,
    };
  }

  /** Append a tree (folders first, then leaves) as descriptors into `out`. */
  function treeRows(out, node, level, keyPrefix, leafDesc, isFolderOpen) {
    for (const name of [...node.dirs.keys()].sort(cmp)) {
      const child = node.dirs.get(name);
      const key = `${keyPrefix}/${name}`;
      const open = isFolderOpen(key);
      out.push(folderDesc(key, level, name, open, countLeaves(child)));
      if (open) treeRows(out, child, level + 1, key, leafDesc, isFolderOpen);
    }
    for (const leaf of [...node.files].sort((a, b) => cmp(a.leafName, b.leafName))) out.push(leafDesc(leaf, level));
  }

  function localDesc({ item: b, leafName }, level) {
    const up = b.upstream ? displayName(b.upstream) : null;
    let track = 'no upstream';
    if (up) track = b.gone ? `upstream ${up} is gone` : `tracking ${up}: ${b.ahead} ahead, ${b.behind} behind`;
    const badges = [];
    if (b.gone) badges.push({ cls: 'sb-gone', text: 'gone' });
    else {
      if (b.ahead) badges.push({ cls: 'sb-ab ahead', text: `${b.ahead}↑` });
      if (b.behind) badges.push({ cls: 'sb-ab behind', text: `${b.behind}↓` });
    }
    return {
      key: `local:${b.name}`, kind: 'ref', level, label: leafName, sha: b.oid,
      title: `${displayName(b.name)}${b.current ? ' (checked out)' : ''}\n${track}`,
      cls: b.current ? 'current' : '', icon: b.current ? 'check' : null, badges,
    };
  }

  const refDesc = (prefix) => ({ item, leafName }, level) => ({
    key: `${prefix}:${item.name}`, kind: 'ref', level, label: leafName, sha: item.oid, title: displayName(item.name), cls: '', icon: null, badges: [],
  });
  const remoteDesc = refDesc('remote');
  const tagDesc = refDesc('tag');

  /** The last component of a path ('/' or '\\' separated), trailing separators ignored (PLOp.fsBaseName). */
  const fsBaseName = (p) => window.PLOp.fsBaseName(p);

  /**
   * The row of state.worktrees entry `w`. dirty: true (the dot) | false | null (unknown); `current`
   * is the tab's own worktree (decided in main, the renderer never compares paths). `missing`: its
   * folder is gone (git marks only an unlocked one prunable; a locked one keeps its lock badge).
   */
  function worktreeDesc(w, dirty) {
    const detached = !w.bare && !w.branch;
    let label;
    let what;
    if (w.bare) [label, what] = ['bare repository', 'Bare repository'];
    else if (w.branch) [label, what] = [w.branch, `Branch ${displayName(w.branch)}`];
    else if (w.head) [label, what] = [short(w.head), `Detached HEAD at ${short(w.head)}`];
    else [label, what] = ['no commits', 'No commits yet'];
    const sub = fsBaseName(w.path);
    const badges = [];
    if (w.main) badges.push({ cls: 'sb-note sb-wt-main', text: 'main' });
    if (w.locked) badges.push({ cls: 'sb-wt-locked', icon: 'lock', text: '' });
    const gone = !!(w.prunable || w.missing);
    if (gone) badges.push({ cls: 'sb-gone', text: 'missing' });
    if (dirty === true) badges.push({ cls: 'sb-dirty', text: '●' });
    const lines = [displayName(w.path), what];
    if (w.main) lines.push(w.bare ? 'The repository itself' : 'Main worktree');
    if (w.current) lines.push('Open in this tab');
    if (w.locked) lines.push(`Locked${w.lockReason ? `: ${displayName(w.lockReason)}` : ''}`);
    if (gone) lines.push(`Folder missing${w.prunable && w.prunableReason ? `: ${displayName(w.prunableReason)}` : ''}`);
    if (dirty === true) lines.push('Has uncommitted changes');
    const cls = [w.current && 'current', gone && 'sb-wt-prunable', detached && 'detached'].filter(Boolean).join(' ');
    return {
      key: `worktree:${w.path}`, kind: 'worktree', level: 0, label, sub: sub === label ? '' : sub, sha: null,
      title: lines.join('\n'), cls, icon: w.current ? 'home' : (detached ? 'detached' : 'worktree'), badges,
    };
  }

  /**
   * data: {refs, status, stashes, stashError, worktrees (null: not read yet), worktreeDirty
   * ({[path]: bool|null} | null), currentDirty (the tab's own worktree)}; view: {filter (lower-cased),
   * collapsedSections (object), collapsedFolders (Set)}. Returns {sections: [{id, title, icon, open,
   * count, rows, emptyText}], summary}.
   */
  function sidebarModel({ refs, status: st, stashes, stashError, worktrees, worktreeDirty, currentDirty }, { filter = '', collapsedSections = {}, collapsedFolders = new Set() } = {}) {
    const matches = (text) => !filter || String(text || '').toLowerCase().includes(filter);
    const isFolderOpen = (key) => !!filter || !collapsedFolders.has(key);

    // LOCAL (+ detached HEAD / unborn branch pseudo rows)
    const local = [];
    const head = refs && refs.head;
    if (head && head.detached && matches('HEAD detached')) {
      local.push({
        key: 'head:detached', kind: 'ref', level: 0, label: 'HEAD', sha: head.oid, cls: 'current detached',
        title: `Detached HEAD at ${head.oid}`, icon: 'detached', badges: [{ cls: 'sb-sha', text: short(head.oid) }],
      });
    }
    const unborn = st && st.branch && !st.oid && !(refs && refs.local.some((b) => b.name === st.branch)) ? st.branch : null;
    const unbornShown = !!unborn && matches(unborn);
    if (unbornShown) {
      local.push({
        key: `unborn:${unborn}`, kind: 'ref', level: 0, label: unborn, sha: null, cls: 'current unborn',
        title: `${displayName(unborn)}\nNo commits yet`, icon: 'check', badges: [{ cls: 'sb-note', text: 'no commits' }],
      });
    }
    const localRefs = refs ? refs.local.filter((b) => matches(b.name)) : [];
    treeRows(local, buildTree(localRefs, (b) => b.name), 0, 'dir:local:', localDesc, isFolderOpen);

    // REMOTE: remote name, then folders
    const remote = [];
    const remoteRefs = refs ? refs.remote.filter((b) => matches(b.name)) : [];
    const byRemote = new Map();
    for (const b of remoteRefs) {
      if (!byRemote.has(b.remote)) byRemote.set(b.remote, []);
      byRemote.get(b.remote).push(b);
    }
    for (const name of [...byRemote.keys()].sort(cmp)) {
      const key = `dir:remote:${name}`;
      const open = isFolderOpen(key);
      remote.push(folderDesc(key, 0, name, open, byRemote.get(name).length, 'remote'));
      if (open) treeRows(remote, buildTree(byRemote.get(name), (b) => b.branch), 1, key, remoteDesc, isFolderOpen);
    }

    // TAGS
    const tags = [];
    const tagRefs = refs ? refs.tags.filter((t) => matches(t.name)) : [];
    treeRows(tags, buildTree(tagRefs, (t) => t.name), 0, 'dir:tags:', tagDesc, isFolderOpen);

    // STASHES
    const stashList = (stashes || []).filter((x) => matches(x.message) || matches(x.ref));
    const stashRows = stashList.map((x) => ({
      key: `stash:${x.hash}`, kind: 'stash', level: 0, label: x.message || x.ref, sha: x.hash, cls: '',
      title: `${displayName(x.ref)}: ${displayName(x.message)}${x.date ? `\n${absTime(x.date)}` : ''}`,
      icon: 'stash', badges: [], date: relTime(x.date, { short: true }),
    }));

    // WORKTREES, in git's order (the main one first): matched by branch, folder name or short head
    // (not the whole path, whose parent folders would match every row)
    const wtList = (worktrees || []).filter((w) => matches(w.branch) || matches(fsBaseName(w.path)) || (w.head && matches(short(w.head))));
    const wtRows = wtList.map((w) => worktreeDesc(w, w.current ? !!currentDirty : (worktreeDirty && worktreeDirty[w.path] === true)));

    const sec = (def, count, rows, emptyText) => ({
      id: def.id, title: def.title, icon: def.icon, open: !collapsedSections[def.id], count, rows,
      emptyText: filter ? 'No matches' : emptyText,
    });
    const total = (refs ? refs.local.length + refs.remote.length + refs.tags.length + (stashes || []).length : 0) + (worktrees || []).length;
    const shown = localRefs.length + remoteRefs.length + tagRefs.length + stashList.length + wtList.length;
    return {
      sections: [
        sec(SECTIONS[0], localRefs.length + (unbornShown ? 1 : 0), local, 'No branches'),
        sec(SECTIONS[1], remoteRefs.length, remote, 'No remote branches'),
        sec(SECTIONS[2], tagRefs.length, tags, 'No tags'),
        sec(SECTIONS[3], stashList.length, stashRows, stashError ? `Couldn’t read stashes: ${displayName(stashError)}` : 'No stashes'),
        sec(SECTIONS[4], wtRows.length, wtRows, worktrees ? 'No worktrees' : 'Reading worktrees…'),
      ],
      summary: filter ? `Viewing ${shown} of ${total}` : '',
    };
  }

  // ------------------------------------------------------------------ actions (pure)
  //
  // Menus and double-clicks are built as Components.actions descriptors {label, flow, args, danger?,
  // disabled?, title?} (or {separator: true}); `flow` names a window.PLFlows function. Menu labels are
  // display-safe (they may contain ref names). Gating (busy, missing flow, and the toolbar's rules for
  // fetch / push / create branch) comes from actions.gateItems + finishItems.

  // Components.actions (renderer/actions.js) loads before the components; node tests that load this
  // script alone get a fresh copy bound to their window (util.load).
  const A = util.load('Components.actions', './actions.js');
  const { flowsOf, runFlow, toMenuItems, bindContextMenu, bareBlocked, FREE_FLOWS } = A;

  /**
   * The item/action target behind sidebar row `key`: {kind: 'local'|'tag', name, oid, current} |
   * {kind: 'remote', name, oid, current: false, remote} | {kind: 'stash' | 'worktree', entry} | null
   * (a worktree: the state.worktrees entry of exactly that path).
   */
  function rowTarget(key, state) {
    const refs = state && state.refs;
    const i = String(key || '').indexOf(':');
    if (i < 0) return null;
    const kind = key.slice(0, i);
    const name = key.slice(i + 1);
    const find = (list) => (list || []).find((r) => r.name === name);
    if (kind === 'local' || kind === 'remote' || kind === 'tag') {
      const r = refs && find(refs[REF_LISTS[kind]]);
      if (!r) return null;
      const t = { kind, name: r.name, oid: r.oid, current: kind === 'local' && !!r.current };
      if (kind === 'remote') t.remote = r.remote;
      return t;
    }
    if (kind === 'stash') {
      const entry = ((state && state.stashes) || []).find((s) => s.hash === name);
      return entry ? { kind, entry } : null;
    }
    if (kind === 'worktree') {
      const entry = ((state && state.worktrees) || []).find((w) => w.path === name);
      return entry ? { kind, entry } : null;
    }
    return null;
  }

  /**
   * Context menu descriptors for a local / remote branch or tag target (see rowTarget): the shared
   * Components.actions.refMenuItems (also the graph's ref pills), with Merge / Rebase (R2).
   */
  const branchMenuItems = (ref, state, flows = flowsOf()) => A.refMenuItems(ref, state, flows);

  /** Context menu descriptors for a stash entry (Components.actions.stashMenuItems, as the graph's). */
  const stashMenuItems = (entry, state, flows = flowsOf()) => A.stashMenuItems(entry, state, flows);

  /**
   * The descriptor a double-click on target would run (before the busy / bare checks), or null. A
   * branch checked out in another worktree is not checked out (Components.actions.checkoutRefusal).
   */
  function doubleClickDesc(target, state) {
    if ((target.kind === 'local' || target.kind === 'remote') && A.checkoutRefusal(target.name, state, { kind: target.kind })) return null;
    if (target.kind === 'local') return target.current ? null : { flow: 'checkout', args: [{ target: target.name, kind: 'local' }] };
    if (target.kind === 'remote') return { flow: 'checkout', args: [{ target: target.name, kind: 'remote' }] };
    if (target.kind === 'stash') return { flow: 'stashApply', args: [target.entry.hash] };
    if (target.kind === 'worktree') return A.worktreeRefusal(target.entry, 'open') ? null : { flow: 'openWorktree', args: [target.entry.path] };
    return null;
  }

  /**
   * The descriptor a double-click (or Enter on a worktree row) on target runs, or null (current branch,
   * a branch checked out in another worktree, tags, a worktree that can't be opened (worktreeRefusal), busy unless the flow runs while busy
   * (openWorktree), and checkout / apply in a bare repository: they need a working tree,
   * Components.actions.bareBlocked). While a rebase / merge / … is in progress the flow itself refuses
   * with the reason (PLPolicy.opBlocked).
   */
  function doubleClickAction(target, state) {
    if (!target) return null;
    const d = doubleClickDesc(target, state);
    if (!d || (state && state.busy && !FREE_FLOWS.has(d.flow))) return null;
    return bareBlocked(state, d.flow, d.args) ? null : d;
  }

  // ------------------------------------------------------------------ multi-selection (pure)
  //
  // Local branch rows ('local:<name>' keys) can be selected together: sel = {keys: Set, anchor}.

  const LOCAL_KEY = 'local:';
  const LOCAL_DIR = 'dir:local:/';
  const isMultiKey = (key) => typeof key === 'string' && key.startsWith(LOCAL_KEY);

  /**
   * The selection after a click on row `key`; `order`: the selectable keys in visible order.
   * range (Shift-click, Shift+Arrow): anchor..key, the anchor kept (without a visible anchor: just
   * key); toggle (⌘/Ctrl-click, ⌘/Ctrl+Space): key added or removed, and it becomes the anchor — the
   * last selected key stays (as in a file manager); neither: just key. A key that isn't selectable
   * clears the selection.
   */
  function nextSelection(sel, key, order, { toggle = false, range = false } = {}) {
    const cur = sel || { keys: new Set(), anchor: null };
    if (!order.includes(key)) return { keys: new Set(), anchor: null };
    if (range && cur.anchor && order.includes(cur.anchor)) {
      const [a, b] = [order.indexOf(cur.anchor), order.indexOf(key)].sort((x, y) => x - y);
      return { keys: new Set(order.slice(a, b + 1)), anchor: cur.anchor };
    }
    if (toggle && !range) {
      const keys = new Set(cur.keys);
      if (keys.has(key) && keys.size === 1) return { keys, anchor: key };
      if (keys.has(key)) keys.delete(key);
      else keys.add(key);
      return { keys, anchor: key };
    }
    return { keys: new Set([key]), anchor: key };
  }

  /** The local branch names of selection keys, in order. */
  const selectedBranches = (keys) => [...(keys || [])].filter(isMultiKey).map((k) => k.slice(LOCAL_KEY.length));

  /** Menu descriptors of a multi-selection (keys): "Delete N branches" only. */
  function selectionMenuItems(keys, state, flows = flowsOf()) {
    const names = selectedBranches(keys);
    return names.length ? [A.deleteBranchesItem(names, state, { flows })] : [];
  }

  /**
   * The local branches under folder row `folderKey` ('dir:local:/chore', nested folders included)
   * that match `filter` (lower-cased, as the model's) — the ones its count shows; null for another row.
   */
  function folderBranches(folderKey, state, filter = '') {
    if (typeof folderKey !== 'string' || !folderKey.startsWith(LOCAL_DIR)) return null;
    const prefix = `${folderKey.slice(LOCAL_DIR.length)}/`;
    const local = (state && state.refs && state.refs.local) || [];
    return local.map((b) => b.name)
      .filter((n) => n.startsWith(prefix) && (!filter || n.toLowerCase().includes(filter)))
      .sort(cmp);
  }

  /**
   * Menu descriptors of a folder row: "Delete all N branches in <folder>/" for a local folder (N: the
   * ones the flow deletes; without "all" when it leaves some out), else none.
   */
  function folderMenuItems(folderKey, state, { filter = '', flows = flowsOf() } = {}) {
    const names = folderBranches(folderKey, state, filter);
    if (!names || !names.length) return [];
    const where = `${displayName(folderKey.slice(LOCAL_DIR.length))}/`;
    const label = (n) => `Delete ${n > 1 && n === names.length ? 'all ' : ''}${plural(n, 'branch', 'branches')} in ${where}`;
    return [A.deleteBranchesItem(names, state, { label, flows })];
  }

  /** Menu descriptors for a target (rowTarget result). */
  const targetMenuItems = (target, state, flows = flowsOf()) => {
    if (!target) return [];
    if (target.kind === 'worktree') return A.worktreeMenuItems(target.entry, state, flows);
    return target.kind === 'stash' ? stashMenuItems(target.entry, state, flows) : branchMenuItems(target, state, flows);
  };

  window.Components.register('sidebar', {
    mount(root, store) {
      const stored = storage.get(LS_SECTIONS, {});
      const collapsedSections = isObject(stored) ? stored : {};
      // Sections opened only for a reveal (revealWorktree), not by the user: still saved collapsed.
      const revealedOpen = new Set();
      const collapsedFolders = new Set(); // for the current repo (see loadFolders)
      const rowsByKey = new Map(); // rebuilt by render()
      // view state
      let filter = '';
      let activeKey = null; // row the user last clicked (several refs can share a sha)
      let focusKey = null; // roving tabindex target
      let multi = { keys: new Set(), anchor: null }; // local branch rows selected together (nextSelection)
      let selecting = false; // selectRow is changing the store's selection (not the graph)
      let lastRepoRoot = null;
      let lastSig = null; // JSON of the model the DOM shows
      let flashKey = null; // the row revealWorktree is flashing (rowEl keeps it across re-renders)
      let flashTimer = null;
      const isDirty = (st) => (typeof store.isDirty === 'function' ? store.isDirty(st) : false);
      /** The worktrees' dirty dots are read only while their section is open. */
      const wantDirty = (on) => { if (typeof store.actions.setWorktreeDirtyWanted === 'function') store.actions.setWorktreeDirtyWanted(on); };

      function loadFolders(repoRoot) {
        collapsedFolders.clear();
        const v = repoRoot ? storage.get(lsFolders(repoRoot), []) : [];
        if (Array.isArray(v)) for (const k of v) if (typeof k === 'string') collapsedFolders.add(k);
      }

      // ---- header: filter box
      const header = el('div', 'sb-header');
      const box = el('label', 'sb-filter');
      const input = el('input', 'sb-filter-input');
      input.type = 'search';
      input.placeholder = `Filter (${A.keyHint({ key: 'f', alt: true })})`;
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Filter branches, tags, stashes and worktrees');
      const clear = el('button', 'sb-filter-clear');
      clear.type = 'button';
      clear.title = 'Clear filter (Esc)';
      clear.setAttribute('aria-label', 'Clear filter');
      clear.append(icon('x', 12));
      clear.hidden = true;
      box.append(icon('search', 14, 'sb-filter-icon'), input, clear);
      const summary = el('div', 'sb-summary');
      header.append(box, summary);

      const list = el('div', 'sb-list');
      list.setAttribute('role', 'tree');
      list.setAttribute('aria-label', 'References');
      // On the tree: ARIA allows aria-multiselectable on a tree, not on the local section's group.
      list.setAttribute('aria-multiselectable', 'true');
      root.replaceChildren(header, list);

      // ---- model -> DOM
      function rowEl(d) {
        const r = el('div', `sb-item sb-row sb-${d.kind}${d.cls ? ` ${d.cls}` : ''}`);
        r.dataset.key = d.key;
        r.dataset.kind = d.kind;
        if (d.sha) r.dataset.sha = d.sha;
        r.setAttribute('role', 'treeitem');
        r.setAttribute('aria-level', String(d.level + 1));
        r.tabIndex = -1;
        r.style.setProperty('--level', String(d.level));
        if (d.title) r.title = d.title;
        if (d.key === flashKey) r.classList.add('sb-flash');
        const twisty = el('span', 'sb-twisty');
        const ic = el('span', 'sb-icon');
        r.append(twisty, ic, el('span', 'sb-name', displayName(d.label)));
        if (d.sub) r.append(el('span', 'sb-sub', displayName(d.sub)));
        if (d.kind === 'folder') {
          r.dataset.toggle = d.toggle;
          r.setAttribute('aria-expanded', String(d.expanded));
          twisty.append(icon(d.expanded ? 'chevron' : 'chevron-right', 10));
          ic.append(icon(d.icon, 14));
          if (d.count) r.append(el('span', 'sb-count', String(d.count)));
        } else if (d.icon) ic.append(icon(d.icon, 13));
        if (d.badges.length) {
          const badges = el('span', 'sb-badges');
          for (const b of d.badges) {
            const span = el('span', b.cls, b.text);
            if (b.icon) span.append(icon(b.icon, 11));
            badges.append(span);
          }
          r.append(badges);
        }
        if (d.date !== undefined) r.append(el('span', 'sb-date', d.date));
        rowsByKey.set(d.key, r);
        return r;
      }

      function sectionEl(sec) {
        const wrap = el('div', `sb-section${sec.open ? '' : ' collapsed'}`);
        wrap.dataset.section = sec.id;
        const h = el('div', 'sb-item sb-section-header');
        h.dataset.key = `section:${sec.id}`;
        h.dataset.kind = 'section';
        h.dataset.section = sec.id;
        h.setAttribute('role', 'treeitem');
        h.setAttribute('aria-level', '1');
        h.setAttribute('aria-expanded', String(sec.open));
        h.tabIndex = -1;
        h.title = `${sec.open ? 'Collapse' : 'Expand'} ${sec.title.toLowerCase()}`;
        const tw = el('span', 'sb-twisty');
        tw.append(icon(sec.open ? 'chevron' : 'chevron-right', 10));
        const ic = el('span', 'sb-icon');
        ic.append(icon(sec.icon, 15));
        h.append(tw, ic, el('span', 'sb-section-title', sec.title), el('span', 'sb-count', String(sec.count)));
        rowsByKey.set(h.dataset.key, h);
        wrap.append(h);
        if (sec.open) {
          const g = el('div', 'sb-group');
          g.setAttribute('role', 'group');
          if (sec.rows.length) g.append(...sec.rows.map(rowEl));
          else g.append(el('div', 'sb-empty', sec.emptyText));
          wrap.append(g);
        }
        return wrap;
      }

      /** Rebuild the tree when its model changed; otherwise only the selection is updated. */
      function render() {
        const s = store.state;
        const model = sidebarModel(
          {
            refs: s.refs, status: s.status, stashes: s.stashes, stashError: s.stashError,
            worktrees: s.worktrees, worktreeDirty: s.worktreeDirty, currentDirty: isDirty(s.status),
          },
          { filter, collapsedSections, collapsedFolders },
        );
        const sig = JSON.stringify(model);
        if (sig === lastSig) {
          updateSelection();
          return;
        }
        lastSig = sig;
        rowsByKey.clear();
        const hadFocus = list.contains(document.activeElement);
        const scroll = list.scrollTop;
        list.replaceChildren(...model.sections.map(sectionEl));
        summary.textContent = model.summary;
        summary.hidden = !model.summary;
        // Rows no longer shown (deleted, filtered out, in a collapsed folder) leave the selection;
        // fewer than two left: back to the row whose commit is selected (what is highlighted then).
        const kept = [...multi.keys].filter((k) => rowsByKey.has(k));
        if (kept.length > 1 || kept.length === multi.keys.size) {
          multi = { keys: new Set(kept), anchor: rowsByKey.has(multi.anchor) ? multi.anchor : null };
        } else {
          multi = isMultiKey(activeKey) && rowsByKey.has(activeKey) ? { keys: new Set([activeKey]), anchor: activeKey } : { keys: new Set(), anchor: null };
        }

        updateSelection();
        updateRoving();
        list.scrollTop = scroll;
        if (hadFocus && !list.contains(document.activeElement)) {
          const f = rowsByKey.get(focusKey) || list.querySelector('.sb-item');
          if (f) f.focus({ preventScroll: true });
        }
      }

      function updateSelection() {
        const sel = store.state.selection;
        const sha = sel && sel.kind === 'commit' ? sel.sha : null;
        const activeMatches = activeKey && rowsByKey.get(activeKey) && rowsByKey.get(activeKey).dataset.sha === sha;
        const many = multi.keys.size > 1;
        for (const [key, r] of rowsByKey) {
          const on = many ? multi.keys.has(key) : !!sha && r.dataset.sha === sha && (activeMatches ? key === activeKey : true);
          r.classList.toggle('selected', on);
          if (r.getAttribute('role') === 'treeitem' && r.dataset.kind !== 'section') r.setAttribute('aria-selected', String(on));
        }
      }

      function updateRoving() {
        let target = rowsByKey.get(focusKey);
        if (!target) {
          target = list.querySelector('.sb-item');
          focusKey = target ? target.dataset.key : null;
        }
        for (const r of rowsByKey.values()) r.tabIndex = r === target ? 0 : -1;
      }

      // ---- interaction
      /**
       * Open or close section id (open undefined: toggle). The user's choice is saved; `reveal`
       * (revealWorktree) opens it for now only and keeps the saved collapsed preference.
       */
      function toggleSection(id, open, { reveal = false } = {}) {
        const now = open === undefined ? !!collapsedSections[id] : open;
        if (now) delete collapsedSections[id];
        else collapsedSections[id] = true;
        if (reveal) revealedOpen.add(id);
        else revealedOpen.delete(id);
        const saved = { ...collapsedSections };
        for (const r of revealedOpen) saved[r] = true;
        storage.set(LS_SECTIONS, saved);
        if (id === WORKTREES) wantDirty(now);
        render();
      }
      function toggleFolder(key, open) {
        if (filter) return; // folders are always open while filtering
        const now = open === undefined ? collapsedFolders.has(key) : open;
        if (now) collapsedFolders.delete(key);
        else collapsedFolders.add(key);
        if (lastRepoRoot) storage.set(lsFolders(lastRepoRoot), [...collapsedFolders]);
        render();
      }

      /** Select row r's commit (the row stays the highlighted one of the rows at that sha). */
      function selectRow(r) {
        activeKey = r.dataset.key;
        const cur = store.state.selection;
        if (cur && cur.kind === 'commit' && cur.sha === r.dataset.sha) updateSelection();
        else {
          selecting = true;
          try {
            store.actions.select({ kind: 'commit', sha: r.dataset.sha });
          } finally {
            selecting = false;
          }
        }
      }

      const selectableKeys = () => [...rowsByKey.keys()].filter(isMultiKey); // visible order

      function activate(r) {
        if (!r) return;
        focusKey = r.dataset.key;
        const kind = r.dataset.kind;
        if (kind === 'section') toggleSection(r.dataset.section);
        else if (kind === 'folder') toggleFolder(r.dataset.toggle);
        else if (r.dataset.sha) {
          multi = nextSelection(multi, r.dataset.key, selectableKeys());
          selectRow(r);
          updateRoving();
        } else if (kind === 'worktree') {
          // a worktree has no commit to select: like a plain click on any other row, it ends a
          // multi-selection (the row of the selected commit is highlighted again)
          multi = { keys: new Set(), anchor: null };
          updateSelection();
          updateRoving();
        } else updateRoving();
      }

      /** ⌘/Ctrl-click or ⌘/Ctrl+Space (toggle), Shift-click or Shift+Arrow (range) on local branch row r. */
      function extendSelection(r, opts) {
        multi = nextSelection(multi, r.dataset.key, selectableKeys(), opts);
        focusKey = r.dataset.key;
        const only = multi.keys.size === 1 ? rowsByKey.get([...multi.keys][0]) : null;
        if (only) selectRow(only);
        else updateSelection(); // activeKey stays the row whose commit is selected (Esc goes back to it while selected)
        updateRoving();
      }

      function onClick(e) {
        const r = e.target.closest('.sb-item');
        if (!r || !list.contains(r)) return;
        const toggle = util.modKey(e);
        const range = !!e.shiftKey;
        if ((toggle || range) && isMultiKey(r.dataset.key) && r.dataset.sha) extendSelection(r, { toggle, range });
        else activate(r);
        const again = rowsByKey.get(r.dataset.key);
        if (again) again.focus({ preventScroll: true });
      }
      list.addEventListener('click', onClick);
      const onMouseDown = (e) => { if (e.detail > 1) e.preventDefault(); }; // no text selection on dblclick
      list.addEventListener('mousedown', onMouseDown);

      const rowOf = (e) => {
        const r = e.target.closest && e.target.closest('.sb-row');
        return r && list.contains(r) ? r : null;
      };
      /** Run the double-click action of row r (the row's target), if it has one. */
      function runRow(r) {
        const d = doubleClickAction(rowTarget(r.dataset.key, store.state), store.state);
        if (d) runFlow(d, store);
      }
      function onDblClick(e) {
        const r = rowOf(e);
        if (r) runRow(r);
      }
      list.addEventListener('dblclick', onDblClick);

      /** Menu descriptors of one row: a local folder's, else its target's (rowTarget). */
      const rowMenuItems = (r) => (r.dataset.kind === 'folder'
        ? folderMenuItems(r.dataset.toggle, store.state, { filter })
        : targetMenuItems(rowTarget(r.dataset.key, store.state), store.state));

      // Context menu: right-click on a row, or the ContextMenu key / Shift+F10 on the focused row.
      const unbindMenu = bindContextMenu(list, {
        targetOf: rowOf,
        anchorOf: (r) => r,
        itemsFor(r) {
          const key = r.dataset.key;
          const inSelection = multi.keys.size > 1 && multi.keys.has(key);
          // a row outside the multi-selection becomes the selection (as in a file manager)
          if (!inSelection && multi.keys.size > 1 && r.dataset.sha) activate(r);
          const descs = inSelection ? selectionMenuItems(multi.keys, store.state) : rowMenuItems(r);
          if (!descs.length) return [];
          focusKey = r.dataset.key;
          updateRoving();
          r.focus({ preventScroll: true });
          return toMenuItems(descs, store);
        },
      });

      const isBranchRow = (r) => !!r && isMultiKey(r.dataset.key) && !!r.dataset.sha;

      /**
       * Keyboard multi-selection of local branch rows: Shift+ArrowUp/Down extends the range from the
       * anchor (the focused row when there is none) to the previous / next local branch row;
       * ⌘/Ctrl+Space toggles the focused one. True when `e` was one of them.
       */
      function selectionKey(e, cur) {
        if (e.altKey) return false;
        if (e.key === ' ' && util.modKey(e) && !e.shiftKey) {
          if (!isBranchRow(cur)) return false; // elsewhere it's left to the app shortcuts
          extendSelection(cur, { toggle: true });
          return true;
        }
        if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !e.shiftKey || e.metaKey || e.ctrlKey) return false;
        if (!isBranchRow(cur)) return false; // plain navigation elsewhere
        const order = selectableKeys();
        const next = rowsByKey.get(order[order.indexOf(cur.dataset.key) + (e.key === 'ArrowDown' ? 1 : -1)]);
        if (!next) return true;
        if (!multi.anchor || !rowsByKey.has(multi.anchor)) multi = { keys: new Set([cur.dataset.key]), anchor: cur.dataset.key };
        extendSelection(next, { range: true });
        next.scrollIntoView({ block: 'nearest' });
        return true;
      }

      /** Esc: back from a multi-selection to one row (the one whose commit is selected, if still in it). */
      function collapseSelection() {
        const keys = [...multi.keys].filter((k) => rowsByKey.has(k));
        const key = keys.includes(activeKey) ? activeKey : keys.at(-1);
        multi = key ? { keys: new Set([key]), anchor: key } : { keys: new Set(), anchor: null };
        if (key) selectRow(rowsByKey.get(key));
        else updateSelection();
      }

      function onListKey(e) {
        const cur = e.target.closest && e.target.closest('.sb-item');
        if (selectionKey(e, cur)) {
          const f = rowsByKey.get(focusKey);
          if (f) f.focus();
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // ⌘/Ctrl/Alt combinations are app shortcuts (⌘↵ commit, ⌘Z undo, …), not tree navigation.
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const items = [...list.querySelectorAll('.sb-item')];
        const i = items.indexOf(cur);
        const move = (j) => {
          const t = items[Math.max(0, Math.min(items.length - 1, j))];
          if (!t) return;
          focusKey = t.dataset.key;
          updateRoving();
          t.focus();
          t.scrollIntoView({ block: 'nearest' });
        };
        const expanded = cur && cur.getAttribute('aria-expanded');
        switch (e.key) {
          case 'ArrowDown': move(i + 1); break;
          case 'ArrowUp': move(i - 1); break;
          case 'Home': move(0); break;
          case 'End': move(items.length - 1); break;
          case 'Enter':
          case ' ':
            // Enter opens a worktree (as double-click does); Space only focuses it, as on other rows
            if (e.key === 'Enter' && cur && cur.dataset.kind === 'worktree') {
              focusKey = cur.dataset.key;
              updateRoving();
              runRow(cur); // open it (a worktree has no commit to select)
              break;
            }
            activate(cur);
            if (rowsByKey.get(focusKey)) rowsByKey.get(focusKey).focus();
            break;
          case 'ArrowRight':
            if (expanded === 'false') activate(cur);
            else move(i + 1);
            if (rowsByKey.get(focusKey)) rowsByKey.get(focusKey).focus();
            break;
          case 'ArrowLeft':
            if (expanded === 'true') activate(cur);
            if (rowsByKey.get(focusKey)) rowsByKey.get(focusKey).focus();
            break;
          case 'Escape':
            if (multi.keys.size < 2) return;
            collapseSelection();
            break;
          default: return;
        }
        e.preventDefault();
        e.stopPropagation(); // keep j/k/arrow graph navigation out of the sidebar
      }
      list.addEventListener('keydown', onListKey);

      function setFilter(v) {
        const next = v.trim().toLowerCase();
        clear.hidden = !v;
        if (next === filter) return;
        filter = next;
        render();
      }
      input.addEventListener('input', () => setFilter(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (input.value) {
            input.value = '';
            setFilter('');
          } else input.blur();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          const first = list.querySelector('.sb-row') || list.querySelector('.sb-item');
          if (first) {
            focusKey = first.dataset.key;
            updateRoving();
            first.focus();
          }
        }
      });
      clear.addEventListener('click', (e) => {
        e.preventDefault();
        input.value = '';
        setFilter('');
        input.focus();
      });

      function onDocKey(e) {
        // ⌘⌥F (Ctrl+Alt+F elsewhere). e.code: Option turns e.key into 'ƒ' on macOS. Not while a dialog
        // or menu is open: this capture listener would otherwise run before their own.
        if (e.code === 'KeyF' && e.altKey && util.modKey(e) && !e.shiftKey && document.body.dataset.view === 'repo' && !util.modalOpen()) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
      document.addEventListener('keydown', onDocKey, true);

      // The sidebar shows only the branch and HEAD oid from status (unborn branch row) and whether the
      // tree is dirty (the current worktree's dot): other status changes (most edits in the working
      // tree) don't even build the model.
      const statusKey = (st) => (st ? `${st.branch || ''}:${st.oid || ''}:${isDirty(st) ? 1 : 0}` : '');
      let lastStatusKey = statusKey(store.state.status);
      /**
       * Show the current worktree's row (store.actions.revealWorktree): open the section, drop a
       * filter that hides the row, scroll to it, focus it and flash it. Without the row yet (worktrees
       * not read), the section header.
       */
      function revealWorktree() {
        const cur = (store.state.worktrees || []).find((w) => w && w.current);
        const key = cur ? `worktree:${cur.path}` : `section:${WORKTREES}`;
        if (collapsedSections[WORKTREES]) toggleSection(WORKTREES, true, { reveal: true });
        if (!rowsByKey.has(key) && filter) {
          input.value = '';
          clear.hidden = true;
          setFilter('');
        }
        const r = rowsByKey.get(key) || rowsByKey.get(`section:${WORKTREES}`);
        if (!r) return;
        focusKey = r.dataset.key;
        updateRoving();
        r.scrollIntoView({ block: 'nearest' });
        r.focus({ preventScroll: true });
        // flashKey: a re-render meanwhile (the dirty dots arriving) keeps the flash on the new row
        for (const x of list.querySelectorAll('.sb-flash')) x.classList.remove('sb-flash');
        flashKey = r.dataset.key;
        r.classList.add('sb-flash');
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
          const now = rowsByKey.get(flashKey);
          if (now) now.classList.remove('sb-flash');
          flashKey = null;
        }, REVEAL_FLASH_MS);
      }
      const offReveal = store.subscribe(['worktreeReveal'], revealWorktree);

      const off = store.subscribe(['refs', 'stashes', 'stashError', 'status', 'selection', 'repo', 'worktrees', 'worktreeDirty'], (s, changed) => {
        const repoRoot = s.repo && s.repo.root;
        const sk = statusKey(s.status);
        const statusMoved = sk !== lastStatusKey;
        lastStatusKey = sk;
        if (repoRoot !== lastRepoRoot) {
          lastRepoRoot = repoRoot;
          lastSig = null;
          loadFolders(repoRoot);
          activeKey = null;
          focusKey = null;
          multi = { keys: new Set(), anchor: null };
          input.value = '';
          clear.hidden = true;
          filter = '';
          list.scrollTop = 0;
        }
        // A selection this sidebar didn't make (the graph, a refresh) ends a multi-selection, and a
        // one-row selection unless it's still that row's commit: a later ⌘/Shift-click starts afresh.
        if (changed.includes('selection') && !selecting) {
          const a = rowsByKey.get(multi.anchor);
          const sha = s.selection && s.selection.sha;
          if (multi.keys.size > 1 || !a || a.dataset.sha !== sha) multi = { keys: new Set(), anchor: null };
        }
        const relevant = changed.filter((k) => k !== 'selection' && (k !== 'status' || statusMoved));
        if (relevant.length || lastSig === null) render();
        else if (changed.includes('selection')) updateSelection();
      });
      lastRepoRoot = store.state.repo && store.state.repo.root;
      loadFolders(lastRepoRoot);
      render();
      wantDirty(!collapsedSections[WORKTREES]);

      return () => {
        off();
        offReveal();
        clearTimeout(flashTimer);
        wantDirty(false);
        document.removeEventListener('keydown', onDocKey, true);
        list.removeEventListener('click', onClick);
        list.removeEventListener('mousedown', onMouseDown);
        list.removeEventListener('dblclick', onDblClick);
        unbindMenu();
        list.removeEventListener('keydown', onListKey);
        rowsByKey.clear();
        root.replaceChildren();
      };
    },
  });

  if (typeof module !== 'undefined') module.exports = {
    sidebarModel, buildTree, rowTarget, branchMenuItems, stashMenuItems, doubleClickAction, targetMenuItems,
    nextSelection, selectedBranches, selectionMenuItems, folderBranches, folderMenuItems,
  };
})();
