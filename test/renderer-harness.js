'use strict';
// Loads the browser-only renderer scripts (components.js, store.js) into node with a fake
// `window`, plus a controllable fake IPC api for deterministic race tests.
const path = require('node:path');

const R = (f) => path.join(__dirname, '..', 'renderer', f);

/** Replace (or remove, with `undefined`) the global localStorage (node 25 ships its own). */
function setLocalStorage(ls) {
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
  if (globalThis.window) globalThis.window.localStorage = ls;
}

/** Map-backed Storage stub. */
function memoryStorage() {
  const m = new Map();
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

/** Storage whose every access throws (disabled / sandboxed storage). */
function throwingStorage() {
  const boom = () => { throw new Error('SecurityError: storage disabled'); };
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom };
}

/**
 * Fresh window.Graph / window.PLErrorKinds / window.PLImageFormat / window.PLDisplayText / window.PLPathNames /
 * window.PLCloneUrl / window.Components / window.PLKeys / window.PLIcons /
 * window.PLOp / window.PLPolicy / window.PLHistory / window.PLRebase / window.PLImageCache / window.PLImage /
 * window.Store (module caches cleared; index.html order).
 */
function loadRenderer() {
  const files = ['components.js', 'keys.js', 'icons.js', 'op-model.js', 'policy.js', 'history-model.js', 'components/rebase-model.js',
    'image-cache.js', 'components/image-model.js', 'store.js'];
  const S = (f) => path.join(__dirname, '..', 'src', f);
  const shared = ['error-kinds.js', 'image-format.js', 'display-text.js', 'path-names.js', 'clone-url.js'].map(S);
  for (const f of [...shared, R('graph.js'), ...files.map(R)]) delete require.cache[require.resolve(f)];
  // index.html order: graph.js, ../src/error-kinds.js (window.PLErrorKinds), ../src/image-format.js
  // (window.PLImageFormat), ../src/display-text.js, ../src/path-names.js, ../src/clone-url.js
  // (window.PLDisplayText, PLPathNames, PLCloneUrl), then components.js ...
  const [PLErrorKinds, PLImageFormat, PLDisplayText, PLPathNames, PLCloneUrl] = shared.map((f) => require(f));
  globalThis.window = { Graph: require(R('graph.js')), PLErrorKinds, PLImageFormat, PLDisplayText, PLPathNames, PLCloneUrl };
  globalThis.document = globalThis.document || { createElement: (tag) => ({ tagName: String(tag).toUpperCase() }) };
  for (const f of files) require(R(f));
  return globalThis.window;
}

/**
 * loadRenderer() plus dialog.js, actions.js (which loads its parts, menus.js included) and the DOM-free
 * component helpers (index.html order): window.Components.dialog, window.Components.actions (the KEYS
 * table PLWip.shortcut reads),
 * window.PLWip (components/wip-model.js), window.PLDiff (components/diff-model.js).
 */
function loadComponentHelpers() {
  const win = loadRenderer();
  for (const f of ['dialog.js', 'actions.js', 'components/wip-model.js', 'components/diff-model.js']) {
    delete require.cache[require.resolve(R(f))];
    require(R(f));
  }
  return win;
}

/**
 * loadComponentHelpers() plus menu.js and the flows (flows-kit.js, flows-sync.js, flows-branch.js, flows-stash.js,
 * flows-worktree.js, flows-linked-worktrees.js, flows-op.js, flows-merge.js, flows-rebase.js:
 * window.Components.menu, window.PLFlows; the global
 * shortcuts read Components.actions, which a test may replace).
 * Pass `dom` (from fakeDom()) first to get working dialogs and menus.
 */
function loadFlows() {
  const win = loadComponentHelpers();
  for (const f of ['menu.js', 'flows-kit.js', 'flows-sync.js', 'flows-branch.js', 'flows-stash.js', 'flows-worktree.js', 'flows-linked-worktrees.js', 'flows-op.js', 'flows-merge.js', 'flows-rebase.js']) {
    delete require.cache[require.resolve(R(f))];
    require(R(f));
  }
  return win;
}

/**
 * loadFlows() plus renderer/clone.js (window.PLClone, Clone Repository…; it reads PLCloneUrl, the
 * dialogs and PLFlowKit.authMessage). Pass `dom` (from fakeDom()) first for working dialogs, and
 * give window.api a clone member (test/clone-ui.test.js fakes one).
 */
function loadClone() {
  const win = loadFlows();
  const f = R('clone.js');
  delete require.cache[require.resolve(f)];
  require(f);
  return win;
}

// ------------------------------------------------------------------ minimal DOM

/**
 * A tiny DOM, enough for dialog.js and menu.js: elements with children, attributes, classList,
 * textContent, focus, listeners, and dispatch with capture / target / bubble phases through
 * window -> document -> ancestors. Install with dom.install() (sets globalThis.document and the
 * window listener methods); dom.key(key, mods, target?) and dom.dispatch(target, type, init) fire events.
 */
function fakeDom() {
  const listenersOf = (o) => o.__listeners || (o.__listeners = []);
  const listen = (o) => {
    o.addEventListener = (type, fn, opts) => listenersOf(o).push({ type, fn, capture: opts === true || !!(opts && opts.capture) });
    o.removeEventListener = (type, fn, opts) => {
      const capture = opts === true || !!(opts && opts.capture);
      const l = listenersOf(o);
      const i = l.findIndex((x) => x.type === type && x.fn === fn && x.capture === capture);
      if (i >= 0) l.splice(i, 1);
    };
    return o;
  };
  const doc = listen({ activeElement: null });
  const win = listen({ innerWidth: 1200, innerHeight: 800 });

  class El {
    constructor(tag) {
      listen(this);
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this.children = [];
      this.parentNode = null;
      this.attrs = new Map();
      this.className = '';
      this.dataset = {};
      this.style = {};
      this.ownText = '';
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.id = '';
      const self = this;
      this.classList = {
        add: (...c) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
        remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
        contains: (c) => self.className.split(/\s+/).includes(c),
        toggle: (c, on) => { const has = self.classList.contains(c); const want = on === undefined ? !has : !!on; if (want) self.classList.add(c); else self.classList.remove(c); return want; },
      };
    }
    get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) {
      for (const c of this.children) c.parentNode = null;
      this.children = [];
      this.ownText = v == null ? '' : String(v);
    }
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    append(...nodes) {
      for (let n of nodes) {
        if (typeof n === 'string') { const t = new El('#text'); t.ownText = n; n = t; }
        if (n.parentNode) n.remove();
        n.parentNode = this;
        this.children.push(n);
      }
    }
    replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
    /** Moves `n` before `ref` (null: to the end); moving a node out blurs focus inside it, as browsers do. */
    insertBefore(n, ref) {
      if (!ref) { this.append(n); return n; }
      if (n.parentNode) n.remove();
      n.parentNode = this;
      this.children.splice(this.children.indexOf(ref), 0, n);
      return n;
    }
    remove() {
      if (!this.parentNode) return;
      const sib = this.parentNode.children;
      sib.splice(sib.indexOf(this), 1);
      this.parentNode = null;
      if (doc.activeElement && this.contains(doc.activeElement)) doc.activeElement = doc.body;
    }
    contains(n) {
      for (let x = n; x; x = x.parentNode) if (x === this) return true;
      return false;
    }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    removeAttribute(k) { this.attrs.delete(k); }
    hasAttribute(k) { return this.attrs.has(k); }
    focus() { if (!this.disabled && doc.body.contains(this)) doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    select() {}
    getBoundingClientRect() { return this.rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    /** Every descendant (depth first) matching pred. */
    findAll(pred) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (pred(c)) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    click() { dispatch(this, 'click'); }
    /** Simple selectors only: '.cls', 'tag', 'tag.cls', '[attr]' / '[attr="v"]'. */
    matches(sel) {
      const m = /^([a-z0-9-]*)((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/i.exec(String(sel).trim());
      if (!m) return false;
      const [, tag, cls, attr, val] = m;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      if (cls && !cls.split('.').filter(Boolean).every((c) => this.classList.contains(c))) return false;
      if (attr && (!this.attrs.has(attr) || (val !== undefined && this.attrs.get(attr) !== val))) return false;
      return true;
    }
    closest(sel) {
      for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches && n.matches(sel)) return n;
      return null;
    }
    querySelector(sel) { return this.findAll((n) => n.matches && n.matches(sel))[0] || null; }
    querySelectorAll(sel) { return this.findAll((n) => n.matches && n.matches(sel)); }
    get isConnected() { return doc.body.contains(this); }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  }

  doc.createElement = (tag) => new El(tag);
  doc.createElementNS = (ns, tag) => new El(tag);
  doc.createTextNode = (text) => { const t = new El('#text'); t.nodeType = 3; t.ownText = String(text); return t; };
  doc.body = new El('body');
  doc.activeElement = doc.body;
  doc.contains = (n) => doc.body.contains(n);

  function dispatch(target, type, init = {}) {
    const e = {
      ...init, type, target, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    const chain = [];
    for (let n = target; n; n = n.parentNode) chain.unshift(n);
    const path = [win, doc, ...chain.filter((n) => n !== target)];
    const fire = (node, capture) => {
      for (const l of [...listenersOf(node)]) {
        if (l.type !== type || (capture !== null && l.capture !== capture)) continue;
        l.fn.call(node, e);
      }
    };
    for (const n of path) { fire(n, true); if (e.stopped) return e; }
    fire(target, null);
    if (e.stopped) return e;
    for (const n of [...path].reverse()) { fire(n, false); if (e.stopped) return e; }
    return e;
  }

  return {
    document: doc,
    window: win,
    El,
    dispatch,
    key: (key, mods = {}, target = doc.activeElement) => dispatch(target, 'keydown', { key, ...mods }),
    install() {
      Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
      return this;
    },
    /** Copy window-level members onto the renderer's fake window (after loadRenderer). */
    attach(w) {
      for (const k of ['addEventListener', 'removeEventListener', 'innerWidth', 'innerHeight']) w[k] = win[k];
      w.__listeners = listenersOf(win);
      win.__listeners = w.__listeners;
      return this;
    },
  };
}

/**
 * The DOM of the mounted component tests (sidebar-actions, graph-columns, image-preview-ui): just enough for
 * sidebar.js, graph-view.js and diff-view.js. Elements with children, attributes, classList, dataset, style (setProperty),
 * document fragments (appending one moves its children),
 * closest / querySelector(All) for '.a.b', 'tag', '[attr="v"]', '[data-x]' and descendant ('a b')
 * selectors and lists of them ('a, b'), focus, click(), and event dispatch (capture on window / document, then target -> ancestors ->
 * document -> window). Returns {doc, win, El, dispatch, key}.
 */
function componentDom() {
  const listenable = (o) => {
    o.__l = [];
    o.addEventListener = (type, fn, opts) => o.__l.push({ type, fn, capture: opts === true || !!(opts && opts.capture) });
    o.removeEventListener = (type, fn, opts) => {
      const capture = opts === true || !!(opts && opts.capture);
      const i = o.__l.findIndex((x) => x.type === type && x.fn === fn && x.capture === capture);
      if (i >= 0) o.__l.splice(i, 1);
    };
    return o;
  };
  const doc = listenable({ activeElement: null });
  const win = listenable({});

  const matches = (n, sel) => {
    if (!n || n.nodeType !== 1) return false;
    if (sel.includes(',')) return sel.split(',').some((s) => matches(n, s)); // a selector list: 'a, b'
    const parts = sel.trim().split(/\s+/);
    if (parts.length > 1) { // descendant selector: 'a b'
      if (!matches(n, parts.pop())) return false;
      const rest = parts.join(' ');
      for (let p = n.parentNode; p; p = p.parentNode) if (matches(p, rest)) return true;
      return false;
    }
    const data = /^\[data-([\w-]+)\]$/.exec(sel); // [data-x]: presence in dataset
    if (data) return Object.hasOwn(n.dataset, data[1].replace(/-(\w)/g, (_, c) => c.toUpperCase()));
    const attr = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
    if (attr) return n.getAttribute(attr[1]) === attr[2];
    const [tag, ...classes] = sel.split('.');
    if (tag && n.tagName !== tag.toUpperCase()) return false;
    return classes.every((c) => n.classList.contains(c));
  };

  class El {
    constructor(tag) {
      listenable(this);
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this.children = [];
      this.parentNode = null;
      this.attrs = new Map();
      this.className = '';
      this.dataset = {};
      const props = new Map();
      this.style = { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k), getPropertyValue: (k) => props.get(k) || '' };
      this.own = '';
      this.hidden = false;
      this.tabIndex = -1;
      this.scrollTop = 0;
      this.clientHeight = 0;
      this.scrollHeight = 0;
      this.offsetTop = 0;
      this.id = '';
      this.title = '';
      this.value = ''; // inputs / textareas (the commit box)
      const self = this;
      this.classList = {
        add: (...c) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
        remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
        contains: (c) => self.className.split(/\s+/).includes(c),
        toggle: (c, on) => { const want = on === undefined ? !self.classList.contains(c) : !!on; if (want) self.classList.add(c); else self.classList.remove(c); return want; },
      };
    }
    get textContent() { return this.own + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this.own = v == null ? '' : String(v); }
    get isConnected() { return doc.body.contains(this); }
    get offsetParent() { return this.isConnected && !this.hidden ? doc.body : null; }
    append(...nodes) {
      for (let n of nodes) {
        if (typeof n === 'string') { const t = new El('#text'); t.nodeType = 3; t.own = n; n = t; }
        if (n.nodeType === 11) { this.append(...n.children); continue; } // a fragment: its children move
        if (n.parentNode) n.remove();
        n.parentNode = this;
        this.children.push(n);
      }
    }
    appendChild(n) { this.append(n); return n; }
    get firstChild() { return this.children[0] || null; }
    get childNodes() { return this.children; }
    get nextSibling() { const sib = this.parentNode ? this.parentNode.children : []; return sib[sib.indexOf(this) + 1] || null; }
    insertBefore(n, ref) {
      if (!ref) return this.appendChild(n);
      if (n.parentNode) n.remove();
      n.parentNode = this;
      this.children.splice(this.children.indexOf(ref), 0, n);
      return n;
    }
    prepend(...nodes) { const kids = [...this.children]; this.replaceChildren(...nodes, ...kids); }
    replaceWith(...nodes) {
      const parent = this.parentNode;
      if (!parent) return;
      const kids = parent.children.flatMap((c) => (c === this ? nodes : [c]));
      this.parentNode = null;
      for (const n of nodes) if (n.parentNode && n.parentNode !== parent) n.remove();
      parent.children = [];
      for (const k of kids) { k.parentNode = parent; parent.children.push(k); }
    }
    replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
    remove() {
      if (!this.parentNode) return;
      const sib = this.parentNode.children;
      sib.splice(sib.indexOf(this), 1);
      this.parentNode = null;
      if (doc.activeElement && this.contains(doc.activeElement)) doc.activeElement = doc.body;
    }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    removeAttribute(k) { this.attrs.delete(k); }
    hasAttribute(k) { return this.attrs.has(k); }
    closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    focus() { if (doc.body.contains(this)) doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    select() {}
    scrollIntoView() {}
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    click() { dispatch(this, 'click'); }
  }

  doc.createElement = (tag) => new El(tag);
  doc.createElementNS = (_ns, tag) => new El(tag);
  doc.createTextNode = (text) => { const n = new El('#text'); n.nodeType = 3; n.own = String(text); return n; };
  doc.createDocumentFragment = () => { const f = new El('#fragment'); f.nodeType = 11; return f; };
  doc.body = new El('body');
  doc.documentElement = new El('html');
  doc.activeElement = doc.body;
  doc.querySelector = (sel) => doc.body.querySelector(sel);

  function dispatch(target, type, init = {}) {
    const e = {
      clientX: 0, clientY: 0, button: 0, detail: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false,
      ...init, type, target, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    const fire = (node, capture) => {
      for (const l of [...node.__l]) if (l.type === type && (capture === null || l.capture === capture)) l.fn.call(node, e);
    };
    for (const n of [win, doc]) { fire(n, true); if (e.stopped) return e; }
    for (let n = target; n; n = n.parentNode) { fire(n, n === target ? null : false); if (e.stopped) return e; }
    for (const n of [doc, win]) { fire(n, false); if (e.stopped) return e; }
    return e;
  }
  return { doc, win, El, dispatch, key: (key, mods = {}, target = doc.activeElement) => dispatch(target, 'keydown', { key, ...mods }) };
}

/**
 * Fake api: every invoke(op, ...args) is recorded as a call whose promise is settled manually.
 *   api.calls                 all calls in order: {op, args, settled, resolve(v), reject(e)}
 *   api.pending(op?, pred?)   unsettled calls (optionally filtered)
 *   api.take(op, pred?)       first unsettled call of `op` (throws when none)
 *   api.count(op)             number of calls of `op` so far
 */
function makeApi() {
  const calls = [];
  const pending = (op, pred) => calls.filter((c) => !c.settled && (!op || c.op === op) && (!pred || pred(c)));
  return {
    calls,
    invoke(op, ...args) {
      let res;
      let rej;
      const promise = new Promise((a, b) => { res = a; rej = b; });
      const call = {
        op, args, settled: false,
        resolve(v) { call.settled = true; res(v); },
        reject(e) { call.settled = true; rej(e); },
      };
      calls.push(call);
      return promise;
    },
    pending,
    take(op, pred) {
      const c = pending(op, pred)[0];
      if (!c) throw new Error(`no pending ${op} call (calls: ${calls.map((x) => `${x.op}${x.settled ? '' : '*'}`).join(', ')})`);
      return c;
    },
    count: (op) => calls.filter((c) => c.op === op).length,
    // Cancellable calls are recorded like invoke's, with the call's `opId`.
    newOpId: (() => { let n = 0; return () => `op-test-${++n}`; })(),
    invokeCancellable(opId, op, ...args) {
      const p = this.invoke(op, ...args);
      calls[calls.length - 1].opId = opId;
      return p;
    },
    app: {
      cancelled: [],
      cancel(opId) { this.cancelled.push(opId); return Promise.resolve(true); },
    },
  };
}

/** Let promise chains run (several macrotask turns). */
async function flush(turns = 5) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

// ------------------------------------------------------------------ fake git data

const commit = (hash, parents = [], extra = {}) => ({ hash, parents, subject: `commit ${hash}`, author: 'Ada Lovelace', date: 1700000000, ...extra });

/** Linear chain: chain(['c', 'b', 'a']) -> c->b->a (newest first). */
const chain = (hashes) => hashes.map((h, i) => commit(h, hashes[i + 1] ? [hashes[i + 1]] : []));

/**
 * A git.status() result. The in-progress fields (docs/plans/rebase.md §3.4) are added only when
 * given: state ('rebasing', 'merging', …), rebase (RebaseState), merge, pendingAutostash.
 */
function status({ oid = null, branch = 'main', dirty = false, staged, unstaged, conflicted, state, rebase, merge, pendingAutostash } = {}) {
  const extra = {};
  if (state !== undefined) extra.state = state;
  if (rebase !== undefined) extra.rebase = rebase;
  if (merge !== undefined) extra.merge = merge;
  if (pendingAutostash !== undefined) extra.pendingAutostash = pendingAutostash;
  return {
    oid, branch, detached: false, upstream: null, ahead: 0, behind: 0,
    staged: staged || [],
    unstaged: unstaged || (dirty ? [{ path: 'a.txt', status: 'M' }] : []),
    conflicted: conflicted || [],
    ...extra,
  };
}

/**
 * A conflicted status entry as git.status() returns it: {path, status: 'U', xy} (xy: the porcelain
 * code, 'UU' both modified, 'AA' both added, 'UD' / 'DU' modify/delete, 'DD' both deleted; see
 * test/fixtures/status-conflicts.json, captured from a real merge).
 */
const conflict = (path, xy = 'UU') => ({ path, status: 'U', xy });

/** git.status() of a real merge with UU / UD / DU / AA conflicts (test/fixtures/status-conflicts.json). */
const realConflicts = () => JSON.parse(require('node:fs').readFileSync(path.join(__dirname, 'fixtures', 'status-conflicts.json'), 'utf8'));

/** A RebaseState (docs/plans/rebase.md §3.4) with overrides: a conflict stop at commit 2 of 3 of feat onto main. */
function rebaseState(o = {}) {
  return {
    backend: 'merge', interactive: true, ours: true, branch: 'feat',
    onto: 'b'.repeat(40), origHead: 'c'.repeat(40), ontoName: 'main',
    step: { done: 2, total: 3 },
    current: { cmd: 'pick', sha: 'd'.repeat(40), subject: 'add the widget' },
    stop: 'conflict', stopMessage: 'add the widget\n\nWith a body.\n', conflicted: 1,
    todoEditable: true, autostash: null,
    ...o,
  };
}

function refs({ head = null, local = [], remote = [], tags = [] } = {}) {
  return { head: head || { oid: null, detached: false, branch: 'main' }, local, remote, tags };
}

/** Everything one refresh needs; overrides per field. */
function repoData(o = {}) {
  const commits = o.commits || [];
  return {
    status: o.status || status({ oid: commits[0] ? commits[0].hash : null }),
    refs: o.refs || refs(),
    stashes: o.stashes || [],
    log: { commits, hasMore: !!o.hasMore, next: o.next === undefined ? null : o.next },
    undoState: o.undoState === undefined ? { entries: [] } : o.undoState,
  };
}

const isRefreshLog = (c) => c.op === 'log' && !(c.args[0] && c.args[0].tips);

/**
 * Settle the oldest pending refresh with `data`. A refresh after the first load reads status, refs,
 * stashes and undoState first and only then asks for the log (when a tip moved), so the log is
 * answered once it is requested; returns whether it was. (Works for the first load's parallel batch too.)
 * `rejectUndo` / `rejectStashes`: reject that call with the error instead.
 */
async function answerRefresh(api, data, { rejectUndo, rejectStashes } = {}) {
  const logNow = api.pending('log', isRefreshLog)[0];
  api.take('status').resolve(data.status);
  api.take('refs').resolve(data.refs);
  const st = api.take('stashes');
  if (rejectStashes) st.reject(rejectStashes);
  else st.resolve(data.stashes);
  const u = api.take('undoState');
  if (rejectUndo) u.reject(rejectUndo);
  else u.resolve(data.undoState);
  await flush();
  const log = logNow || api.pending('log', isRefreshLog)[0];
  if (log) {
    log.resolve(data.log);
    await flush();
  }
  return !!log;
}

/** Store over a fresh api; loads `repo` with `data` (answering the first refresh). urlApi: the image cache's URL api. */
async function loadedStore(data, { repo = { root: '/r', name: 'r' }, urlApi } = {}) {
  const win = loadRenderer();
  const api = makeApi();
  const store = win.Store.create(api, { urlApi });
  const p = store.actions.loadRepo(repo);
  await flush(1);
  await answerRefresh(api, data);
  await p;
  return { win, api, store };
}

// ------------------------------------------------------------------ scripted flows (test/flows.test.js, rebase-editor-flows)

const errOf = (kind, message = kind, extra = {}) => ({ message, kind, exitCode: 1, ...extra });

/**
 * Scripted api: handlers[op](...args) returns the value (or throws / rejects with an error object).
 * Refresh ops default to `data` (a repoData()-like object with `remotes`). Records {op, args, opId};
 * writes() is every call but the refresh reads. app: cancel (records cancelled op ids), openTerminal.
 */
function scriptedApi(data, handlers = {}) {
  const calls = [];
  const defaults = {
    status: () => data.status, refs: () => data.refs, stashes: () => data.stashes,
    undoState: () => data.undoState, log: () => data.log, remotes: () => data.remotes || ['origin'],
    commitFiles: () => [], worktrees: () => data.worktrees || [], worktreeDirty: () => data.worktreeDirty || [],
    worktreeUnreachable: () => data.worktreeUnreachable || { count: 0 },
  };
  const run = (op, args, opId) => {
    calls.push({ op, args, opId });
    const h = Object.hasOwn(handlers, op) ? handlers[op] : defaults[op];
    if (!h) return Promise.reject(errOf('unknown-op', `no handler for ${op}`));
    return Promise.resolve().then(() => h(...args));
  };
  let n = 0;
  return {
    calls,
    writes: () => calls.filter((c) => !Object.hasOwn(defaults, c.op)),
    handlers,
    invoke: (op, ...args) => run(op, args, null),
    newOpId: () => `op-${++n}`,
    invokeCancellable: (opId, op, ...args) => run(op, args, opId),
    app: {
      cancelled: [],
      cancel(opId) { this.cancelled.push(opId); return Promise.resolve(true); },
      terminals: 0,
      openTerminal() { this.terminals++; return Promise.resolve(true); },
    },
  };
}

/**
 * Scripted Components.dialog: each call is recorded as {type, opts}; answers are taken in order (a
 * function gets the opts). Defaults: confirm false, prompt / choose / editMessage null.
 */
function scriptDialogs(win, answers = []) {
  const seen = [];
  const next = (type, opts) => {
    seen.push({ type, opts });
    if (!answers.length) return type === 'confirm' ? false : type === 'alert' ? undefined : null;
    const a = answers.shift();
    return typeof a === 'function' ? a(opts) : a;
  };
  const d = win.Components.dialog;
  d.confirm = async (o) => next('confirm', o);
  d.prompt = async (o) => next('prompt', o);
  d.choose = async (o) => next('choose', o);
  d.editMessage = async (o) => next('editMessage', o);
  d.alert = async (o) => { next('alert', o); };
  return seen;
}

module.exports = {
  errOf, scriptedApi, scriptDialogs,
  loadRenderer, loadComponentHelpers, loadFlows, loadClone, fakeDom, componentDom, makeApi, flush, setLocalStorage, memoryStorage, throwingStorage,
  commit, chain, status, conflict, realConflicts, rebaseState, refs, repoData, answerRefresh, isRefreshLog, loadedStore,
};
