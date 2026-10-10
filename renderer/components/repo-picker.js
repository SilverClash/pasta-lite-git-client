'use strict';
// Repository picker (plain script; exposes window.PLRepoPicker; loads after toolbar.js for PLIcons,
// before app.js). One list component, used twice:
//   - the toolbar's popover under the repository breadcrumb (open / close / isOpen), and
//   - the New Tab / no-repo start screen (mountStart), which replaces the old welcome card.
// Each tab is its own page with one repo (multi-repo tabs are main's WebContentsViews), so opening
// "here" replaces this page's repo and "in a new tab" asks main for another tab.
//
//   source                     the page's data: {recent, tabs, tabId, current}; app.js feeds it
//                              from app.getState(), 'recent-changed', 'repo-opened' and 'tabs-changed'.
//                              recent: [{root, name, display}], display the root as main shows it
//                              (the home folder as ~; src/recent-view.js), so no path rule lives here
//   rank(recent, query, ctx) -> items [{root, name, path, title, current, tab, hits: {name, path}}]
//                              pure: an empty query keeps the recent order; otherwise a name prefix,
//                              then a name substring, then a path substring (the shown path: main's
//                              display, or the full root), then the name's letters in order (fuzzy); ties keep
//                              the recent order. hits: [[start, end)] ranges of the shown text.
//   segments(text, ranges)  -> [{text, hit}] pure: the pieces of a highlighted label
//   shownPath(root)         -> root as the recent list shows it (its display), else root itself
//   otherTabs(state)        -> Map root -> tab, the repos open in the window's other tabs
//   createList(opts)        -> {root, input, render(), focus(), move(), activate(), dispose()}
//   open(anchor, opts) / close() / isOpen()                  the popover (one at a time)
//   setToggle(fn) -> unset / toggle() -> boolean             the toolbar registers how its repository
//                              stack opens / closes the popover (its anchor, aria-expanded); app.js'
//                              ⌘P calls toggle() (false: no toolbar mounted)
//   mountStart(container, opts) -> {focus(), dispose()}      the start screen
//   openRepo(root, {newTab}) / openFolder({newTab}) / tabsAvailable()
//   cloneRepo({onError})       Clone Repository… (window.PLClone, renderer/clone.js, which loads
//                              after this script); the start screen and the popover's footer offer it
//   _internal: {CAP, rank, segments, subsequence, otherTabs}, the pure parts, for unit tests only
//
// Keyboard (the search field keeps focus; the list is a listbox driven by aria-activedescendant):
// ↑ / ↓ (wrapping), Home / End move; Enter opens here, ⌘↵ / Ctrl+↵ in a new tab. Mouse: click opens
// here, ⌘-click / Ctrl-click or the row's new-tab button in a new tab. Popover only: Esc closes and
// gives focus back, Tab / ⇧Tab cycle inside it, ⌘O runs the folder dialog, ⌘P closes it again; it
// also closes on an outside press, window blur and resize. Start screen: Esc clears the search.
// Without window.api.tabs (main without tabs) nothing offers a new tab and ⌘↵ / ⌘-click open here.
// Every name and path goes through util.displayName and textContent.
(function () {
  const { el, util } = window.Components;
  const { displayName, modKey, toError } = util;
  const Keys = () => window.PLKeys; // keys.js loads first
  const keyHint = (id) => (Keys() ? Keys().keyHint(id) : '');
  /** The tooltip of Open…: '… (⌘-click: in a new tab)' with tabs ('Ctrl-click' elsewhere). */
  const openTitle = () => (tabsAvailable() ? `Open a folder in this tab (${Keys().modClick()}: in a new tab)` : 'Open a folder');

  /** Recent entries shown before "View all repositories" (main keeps 10, src/recent.js). */
  const CAP = 6;

  /**
   * File > Clone Repository…'s key, ⇧⌘N / Ctrl+Shift+N: main's menu accelerator, so not in KEYS
   * (keys.js), only shown here.
   */
  const CLONE_KEY = { key: 'n', shift: true };

  /** Clone Repository… (renderer/clone.js loads after this script: looked up when used). */
  function cloneRepo({ onError } = {}) {
    const report = onError || ((x) => util.log.error(x));
    if (window.PLClone) window.PLClone.open({ onError: report });
    else report(new Error('Cloning is not available'));
  }

  // ---------------------------------------------------------------- pure

  /** Ranges of `q`'s letters found in order in `text` (lower case both), merged; null if not all are. */
  function subsequence(text, q) {
    const out = [];
    let from = 0;
    for (const ch of q) {
      const i = text.indexOf(ch, from);
      if (i < 0) return null;
      const last = out[out.length - 1];
      if (last && last[1] === i) last[1] = i + 1;
      else out.push([i, i + 1]);
      from = i + 1;
    }
    return out;
  }

  /** A recent entry's path as shown: main's display (home as ~), else the root itself. */
  const displayOf = (r) => (typeof r.display === 'string' && r.display ? r.display : r.root);

  /** Recent entries filtered and ordered for `query`; ctx: {current, tabs (otherTabs)}. */
  function rank(recent, query, { current = null, tabs = new Map() } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const items = (Array.isArray(recent) ? recent : []).filter((r) => r && r.root).map((r, i) => {
      const shown = displayOf(r);
      return {
        i,
        root: r.root,
        name: displayName(r.name || r.root),
        path: displayName(shown),
        title: displayName(shown),
        current: !!current && r.root === current,
        tab: tabs.get(r.root) || null,
        hits: { name: [], path: [] },
        score: 0,
      };
    });
    if (!q) return items;
    const out = [];
    for (const it of items) {
      const n = it.name.toLowerCase();
      const p = it.path.toLowerCase();
      const k = n.indexOf(q);
      const kp = p.indexOf(q);
      if (k >= 0) Object.assign(it, { score: k === 0 ? 0 : 1, hits: { name: [[k, k + q.length]], path: [] } });
      else if (kp >= 0) Object.assign(it, { score: 2, hits: { name: [], path: [[kp, kp + q.length]] } });
      else if (String(it.root).toLowerCase().includes(q)) it.score = 3; // e.g. the full home path typed
      else {
        const fuzzy = q.replace(/\s+/g, '') ? subsequence(n, q.replace(/\s+/g, '')) : null;
        if (!fuzzy) continue;
        Object.assign(it, { score: 4, hits: { name: fuzzy, path: [] } });
      }
      out.push(it);
    }
    return out.sort((a, b) => a.score - b.score || a.i - b.i);
  }

  /** The pieces of `text` inside / outside `ranges` ([[start, end)], sorted, not overlapping). */
  function segments(text, ranges) {
    const s = String(text);
    const out = [];
    let at = 0;
    for (const [a, b] of ranges || []) {
      if (a > at) out.push({ text: s.slice(at, a), hit: false });
      if (b > a) out.push({ text: s.slice(a, b), hit: true });
      at = Math.max(at, b);
    }
    if (at < s.length || !out.length) out.push({ text: s.slice(at), hit: false });
    return out;
  }

  /** Repos open in the window's other tabs: Map root -> tab (this tab is tabId, else the active one). */
  function otherTabs(state) {
    const m = new Map();
    for (const t of (state && Array.isArray(state.tabs) ? state.tabs : [])) {
      if (!t || !t.root) continue;
      const mine = state.tabId != null ? t.id === state.tabId : !!t.active;
      if (!mine && !m.has(t.root)) m.set(t.root, t);
    }
    return m;
  }

  // ---------------------------------------------------------------- data + opening

  function createSource() {
    let state = { recent: [], tabs: [], tabId: null, current: null };
    const subs = new Set();
    return {
      get: () => state,
      set(patch) {
        state = { ...state, ...patch };
        for (const fn of [...subs]) {
          try { fn(state); } catch (e) { util.log.error(e); }
        }
      },
      subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    };
  }
  const source = createSource();

  /**
   * `root` as the recent list shows it (the toolbar's tooltip): its entry's display, else `root`
   * itself (a repo the list no longer holds: main keeps the last 10 opened).
   */
  function shownPath(root) {
    const entry = (source.get().recent || []).find((r) => r && r.root === root);
    return entry ? displayOf(entry) : root;
  }

  /** Main supports tabs (the other half of the tabs contract, preload's window.api.tabs). */
  const tabsAvailable = () => !!(window.api && window.api.tabs);

  const call = (p) => Promise.resolve(p).catch((e) => { throw toError(e); });
  /** Open a recent repo here (main replaces this tab's repo) or, with newTab and tabs, in a new tab. */
  function openRepo(root, { newTab = false } = {}) {
    const app = window.api.app;
    return call(newTab && tabsAvailable() ? app.openRecent(root, { newTab: true }) : app.openRecent(root));
  }
  /** The folder dialog, for this tab or (newTab, with tabs) a new one. */
  function openFolder({ newTab = false } = {}) {
    const app = window.api.app;
    return call(newTab && tabsAvailable() ? app.openDialog({ newTab: true }) : app.openDialog());
  }

  /**
   * What choosing `item` does: a new tab when asked (and supported); here, the repo already open in
   * another tab is switched to when main offers window.api.tabs.activate (optional, beyond the
   * contract), the current repo is a no-op, anything else replaces this tab's repo.
   */
  function choose(item, { newTab = false } = {}) {
    if (newTab && tabsAvailable()) return openRepo(item.root, { newTab: true });
    const tabs = window.api && window.api.tabs;
    if (item.tab && tabs && typeof tabs.activate === 'function') return call(tabs.activate(item.tab.id));
    if (item.current) return Promise.resolve(null);
    return openRepo(item.root);
  }

  // ---------------------------------------------------------------- list component

  let listSeq = 0;
  const icon = (name, size, cls) => (window.PLIcons ? window.PLIcons.icon(name, size, cls) : el('span', `icon ${cls || ''}`));

  function labelInto(node, text, ranges) {
    node.replaceChildren(...segments(text, ranges).map((s) => (s.hit ? el('mark', 'rp-hit', s.text) : document.createTextNode(s.text))));
  }

  /**
   * The search field + "Recently opened" listbox (+ an optional footer). opts:
   *   source, cap (null: no cap), id (the listbox id), footer (true: Open… and View all),
   *   onChoose(item, {newTab}) / onFolder({newTab}) (the chosen action ran), onError(err), onEscape(e)
   */
  function createList(opts = {}) {
    const src = opts.source || source;
    const onError = opts.onError || ((e) => util.log.error(e));
    const n = ++listSeq;
    const listId = opts.id || `rp-list-${n}`;
    const labelId = `${listId}-label`;
    let query = '';
    let showAll = opts.cap == null;
    let items = [];
    let shown = [];
    let active = -1;
    let activeRoot = null;

    const root = el('div', 'rp');
    const search = el('div', 'rp-search');
    const input = el('input', 'rp-input');
    input.type = 'text';
    input.placeholder = 'Search';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Search repositories');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', listId);
    search.append(icon('search', 14, 'rp-search-icon'), input);
    const label = el('div', 'rp-label', 'Recently opened');
    label.id = labelId;
    const list = el('ul', 'rp-list');
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-labelledby', labelId);
    const empty = el('p', 'rp-empty');
    empty.hidden = true;
    root.append(search, label, list, empty);

    const ac = new AbortController();
    const on = (node, type, fn) => node.addEventListener(type, fn, { signal: ac.signal });

    let openBtn = null;
    let cloneBtn = null;
    let allBtn = null;
    if (opts.footer) {
      const foot = el('div', 'rp-footer');
      openBtn = el('button', 'rp-foot-btn rp-open');
      openBtn.type = 'button';
      openBtn.append(icon('folder-open', 14), el('span', null, 'Open…'));
      const hint = keyHint('open');
      if (hint) openBtn.append(el('span', 'rp-key', hint));
      openBtn.title = openTitle();
      cloneBtn = el('button', 'rp-foot-btn rp-clone', 'Clone…');
      cloneBtn.type = 'button';
      cloneBtn.title = `Clone a repository from a URL (${keyHint(CLONE_KEY)})`;
      allBtn = el('button', 'rp-foot-btn rp-all', 'View all repositories');
      allBtn.type = 'button';
      foot.append(openBtn, cloneBtn, allBtn);
      root.append(foot);
      on(openBtn, 'click', (e) => folder({ newTab: modKey(e) }));
      // The popover closes first (onClone), then the dialog opens.
      on(cloneBtn, 'click', () => {
        if (opts.onClone) opts.onClone();
        cloneRepo({ onError });
      });
      on(allBtn, 'click', () => {
        showAll = true;
        render();
        input.focus();
      });
    }

    function folder(o) {
      if (opts.onFolder) opts.onFolder(o);
      openFolder(o).catch(onError);
    }

    function activate(i, { newTab = false } = {}) {
      const it = shown[i];
      if (!it) return;
      if (opts.onChoose) opts.onChoose(it, { newTab });
      choose(it, { newTab }).catch(onError);
    }

    function setActive(i) {
      const prev = list.children[active];
      if (prev) { prev.classList.remove('is-active'); prev.setAttribute('aria-selected', 'false'); }
      active = shown.length ? Math.max(0, Math.min(i, shown.length - 1)) : -1;
      const row = list.children[active];
      activeRoot = active >= 0 ? shown[active].root : null;
      if (row) {
        row.classList.add('is-active');
        row.setAttribute('aria-selected', 'true');
        input.setAttribute('aria-activedescendant', row.id);
        if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function move(dir) {
      if (!shown.length) return;
      let from = active;
      if (active < 0) from = dir > 0 ? -1 : 0; // nothing active yet: down starts at the first, up at the last
      setActive((from + dir + shown.length) % shown.length);
    }

    function row(it, i) {
      const li = el('li', 'rp-item');
      li.id = `${listId}-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.root = it.root;
      li.title = it.title;
      if (it.current) li.classList.add('is-current');
      const main = el('span', 'rp-item-main');
      const name = el('span', 'rp-name');
      labelInto(name, it.name, it.hits.name);
      const path = el('span', 'rp-path'); // right-to-left box: a long path loses its start, not its name
      const pathText = el('span', 'rp-path-text');
      labelInto(pathText, it.path, it.hits.path);
      path.append(pathText);
      main.append(name, path);
      li.append(icon('folder', 14, 'rp-item-icon'), main);
      const status = [];
      if (it.current) {
        const b = el('span', 'rp-badge rp-badge-current', 'current');
        b.title = 'The repository open in this tab';
        li.append(b);
        status.push('current');
      }
      if (it.tab) {
        const b = el('span', 'rp-badge rp-badge-tab', 'open in tab');
        b.title = `Already open in another tab${it.tab.title ? `: ${displayName(it.tab.title)}` : ''}`;
        li.append(b);
        status.push('open in another tab');
      }
      if (status.length) li.setAttribute('aria-description', status.join(', '));
      if (tabsAvailable()) {
        const nt = el('button', 'rp-newtab');
        nt.type = 'button';
        nt.tabIndex = -1;
        nt.title = 'Open in a new tab';
        nt.setAttribute('aria-label', `Open ${it.name} in a new tab`);
        nt.append(icon('tab-new', 14));
        on(nt, 'click', (e) => { e.stopPropagation(); activate(i, { newTab: true }); });
        on(nt, 'mousedown', (e) => { e.preventDefault(); }); // keep focus in the search field
        li.append(nt);
      }
      on(li, 'mousemove', () => { if (active !== i) setActive(i); });
      on(li, 'mousedown', (e) => { e.preventDefault(); }); // keep focus in the search field
      on(li, 'click', (e) => activate(i, { newTab: modKey(e) }));
      return li;
    }

    function render() {
      const s = src.get();
      items = rank(s.recent, query, { current: s.current, tabs: otherTabs(s) });
      const capped = !query.trim() && !showAll && opts.cap != null && items.length > opts.cap;
      shown = capped ? items.slice(0, opts.cap) : items;
      list.replaceChildren(...shown.map((it, i) => row(it, i)));
      list.hidden = !shown.length;
      label.textContent = query.trim() ? 'Matching repositories' : 'Recently opened';
      empty.hidden = !!shown.length;
      empty.textContent = query.trim() ? `No recent repository matches “${displayName(query.trim())}”` : 'No recent repositories yet.';
      if (allBtn) allBtn.hidden = !capped;
      const keep = activeRoot ? shown.findIndex((x) => x.root === activeRoot) : -1;
      active = -1;
      setActive(keep >= 0 ? keep : 0);
    }

    on(input, 'input', () => {
      query = input.value;
      activeRoot = null; // a new query starts at its best match
      render();
    });
    on(input, 'keydown', (e) => {
      if (e.isComposing) return;
      const k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') move(k === 'ArrowDown' ? 1 : -1);
      else if (k === 'Home' && !e.shiftKey) setActive(0);
      else if (k === 'End' && !e.shiftKey) setActive(shown.length - 1);
      else if (k === 'Enter' && !e.shiftKey && !e.altKey) {
        if (e.repeat) { e.preventDefault(); e.stopPropagation(); return; }
        activate(active, { newTab: modKey(e) });
      } else if (k === 'Escape' && opts.onEscape) {
        if (opts.onEscape(e) === false) return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    const off = src.subscribe(() => render());
    render();

    return {
      root,
      input,
      openBtn,
      cloneBtn,
      allBtn,
      render,
      move,
      activate,
      get items() { return shown; },
      get active() { return active; },
      focus() { input.focus(); if (typeof input.select === 'function') input.select(); },
      clear() { input.value = ''; query = ''; activeRoot = null; render(); },
      dispose() { off(); ac.abort(); root.remove(); },
    };
  }

  // ---------------------------------------------------------------- popover

  let current = null; // {root, close}

  function close() {
    if (current) current.close(true);
  }

  /**
   * The picker under `anchor` (an Element). opts: {source, onError, onClose(), cap}. Returns the
   * popover element; a second open closes the first.
   */
  function open(anchor, opts = {}) {
    close();
    const previous = document.activeElement;
    const pop = el('div', 'rp-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-label', 'Repositories');
    let done = false;
    const finish = (restoreFocus) => {
      if (done) return;
      done = true;
      if (current && current.root === pop) current = null;
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
      list.dispose();
      pop.remove();
      if (restoreFocus && previous && typeof previous.focus === 'function' && previous.isConnected !== false) previous.focus();
      if (opts.onClose) opts.onClose();
    };
    const list = createList({
      source: opts.source,
      cap: opts.cap === undefined ? CAP : opts.cap,
      footer: true,
      onError: opts.onError,
      onChoose: () => finish(false),
      onFolder: () => finish(false),
      onClone: () => finish(false),
    });
    pop.append(list.root);

    const focusables = () => [list.input, list.openBtn, list.cloneBtn, list.allBtn].filter((b) => b && !b.hidden);
    pop.addEventListener('keydown', (e) => {
      const k = e.key;
      const mod = modKey(e) && !e.altKey && !e.shiftKey;
      if (k === 'Escape') {
        finish(true);
      } else if (k === 'Tab') {
        const f = focusables();
        const i = f.indexOf(document.activeElement);
        const next = f[((i < 0 ? 0 : i) + (e.shiftKey ? -1 : 1) + f.length) % f.length];
        if (next) next.focus();
      } else if (mod && String(k).toLowerCase() === 'o') {
        if (!e.repeat) { finish(false); openFolder().catch(opts.onError || ((x) => util.log.error(x))); }
      } else if (mod && String(k).toLowerCase() === 'p') {
        finish(true);
      } else {
        e.stopPropagation(); // typing and other keys stay in the picker (no page shortcuts)
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    });

    const inside = (t) => !!t && pop.contains(t);
    const onDown = (e) => {
      if (inside(e.target)) return;
      // A press on the anchor closes the picker and swallows its click, so the anchor toggles.
      const menu = window.Components.menu;
      if (anchor && typeof anchor.contains === 'function' && anchor.contains(e.target) && menu && menu.swallowNextClick) menu.swallowNextClick(anchor);
      finish(false);
    };
    const onBlur = () => finish(false);

    document.body.append(pop);
    const r = anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : { left: 0, top: 0, bottom: 0 };
    const size = typeof pop.getBoundingClientRect === 'function' ? pop.getBoundingClientRect() : { width: 0, height: 0 };
    const vw = (typeof window.innerWidth === 'number' && window.innerWidth) || 1e6;
    const vh = (typeof window.innerHeight === 'number' && window.innerHeight) || 1e6;
    const place = window.Components.menu && window.Components.menu.place;
    const pos = place
      ? place({ x: r.left, y: r.bottom + 4, below: { top: r.top } }, size.width || 0, size.height || 0, vw, vh, 8)
      : { left: r.left, top: r.bottom + 4 };
    pop.style.left = `${pos.left}px`;
    pop.style.top = `${pos.top}px`;

    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    current = { root: pop, list, close: finish };
    list.focus();
    return pop;
  }

  let toggleHook = null;
  /** Register the toolbar's toggle (the popover under its repository stack); returns the unregister. */
  function setToggle(fn) {
    toggleHook = typeof fn === 'function' ? fn : null;
    return () => { if (toggleHook === fn) toggleHook = null; };
  }
  /** Open / close the popover as the toolbar's repository stack does (⌘P); false without a toolbar. */
  function toggle() {
    if (!toggleHook) return false;
    toggleHook();
    return true;
  }

  // ---------------------------------------------------------------- start screen (New Tab / no repo)

  /**
   * The start screen in `container`: "Open a repository", the same list (no cap), Open… (⌘O) and,
   * with tabs, the ⌘T hint. opts: {source, onError}. Opening from here replaces this tab's (empty)
   * content; ⌘↵ / ⌘-click still open a new tab.
   */
  function mountStart(container, opts = {}) {
    const ac = new AbortController();
    const title = el('h1', 'start-title');
    title.append(el('span', 'brand-mark'), el('span', null, 'Open a repository'));
    title.firstChild.setAttribute('aria-hidden', 'true');
    const sub = el('p', 'muted start-sub', 'Pick a recently opened repository, open a folder, or clone one.');
    const list = createList({
      source: opts.source,
      cap: null,
      id: 'recent-list',
      onError: opts.onError,
      onEscape: () => {
        if (!list.input.value) return false;
        list.clear();
        return true;
      },
    });
    const actions = el('div', 'start-actions');
    const openBtn = el('button', 'btn btn-primary start-open');
    openBtn.type = 'button';
    openBtn.id = 'open-btn';
    openBtn.append(el('span', null, 'Open…'));
    const hint = keyHint('open');
    if (hint) openBtn.append(el('span', 'start-key', hint));
    openBtn.title = openTitle();
    openBtn.addEventListener('click', (e) => { openFolder({ newTab: modKey(e) }).catch(opts.onError || ((x) => util.log.error(x))); }, { signal: ac.signal });
    const cloneBtn = el('button', 'btn start-clone');
    cloneBtn.type = 'button';
    cloneBtn.id = 'clone-btn';
    cloneBtn.append(el('span', null, 'Clone…'));
    const cloneHint = keyHint(CLONE_KEY);
    if (cloneHint) cloneBtn.append(el('span', 'start-key', cloneHint));
    cloneBtn.title = `Clone a repository from a URL (${keyHint(CLONE_KEY)})`;
    cloneBtn.addEventListener('click', () => cloneRepo({ onError: opts.onError }), { signal: ac.signal });
    actions.append(openBtn, cloneBtn);
    const tabHint = el('p', 'hint start-hint');
    tabHint.append(el('kbd', null, keyHint({ key: 't' })), document.createTextNode(' opens another tab'));
    tabHint.hidden = !tabsAvailable();
    container.replaceChildren(title, sub, list.root, actions, tabHint);
    return {
      list,
      focus: () => list.focus(),
      dispose() { ac.abort(); list.dispose(); container.replaceChildren(); },
    };
  }

  const api = {
    shownPath, source, tabsAvailable, openRepo, openFolder, choose, cloneRepo,
    createList, open, close, isOpen: () => !!current, setToggle, toggle, mountStart,
    _internal: { CAP, rank, segments, subsequence, otherTabs }, // exported for unit tests only
  };
  window.PLRepoPicker = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
