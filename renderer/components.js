'use strict';
// Component registry (plain script; exposes window.Components). See the contract in store.js.
(function () {
  const registry = new Map();

  /** Shared DOM helper: el('div', 'cls', 'text') — text goes through textContent (null/undefined = none). */
  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  /**
   * A plain <button type="button"> with a tooltip and a click handler: button('cls', 'text', 'title', fn).
   * In a segmented control (style.css `.seg`) it has the class `seg-btn` and aria-pressed for the chosen one.
   */
  function button(className, text, title, onClick) {
    const b = el('button', className, text);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * The bridge rejects with a plain {message, kind, ...} object; make it a real Error. Only objects
   * have their fields copied (Object.assign on a string would copy its characters as "0", "1", ...).
   */
  const toError = (e) => {
    if (e instanceof Error) return e;
    if (e && typeof e === 'object') return Object.assign(new Error(e.message || String(e)), e);
    return new Error(String(e));
  };

  /** "1 file" / "3 files"; pluralWord defaults to word + 's'. */
  const plural = (n, word, pluralWord = `${word}s`) => `${n} ${n === 1 ? word : pluralWord}`;

  /** The 7-character abbreviation of a commit sha ('' for none). */
  const short = (sha) => String(sha || '').slice(0, 7);

  /** A full object id: 40 (SHA-1) or 64 (SHA-256) lower-case hex digits. */
  const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

  /** Show an error through store.actions.toast unless store.actions.write already toasted it. */
  const report = (store, e) => { if (!e || !e.toasted) store.actions.toast(e); };

  /**
   * The platform the app runs on, as Node names it ('darwin', 'win32', 'linux', ...): the preload's
   * process.platform (window.api.platform), not a guess from the user agent. Without a preload (the
   * unit tests load these scripts bare) 'linux': Ctrl shortcuts, no Finder or Explorer.
   */
  const PLATFORM = (typeof window !== 'undefined' && window.api && typeof window.api.platform === 'string' && window.api.platform) || 'linux';
  const IS_MAC = PLATFORM === 'darwin';
  /** The platform's command modifier is held: ⌘ on macOS, Ctrl elsewhere. */
  const modKey = (e) => (IS_MAC ? !!e.metaKey : !!e.ctrlKey);

  const UNITS = [[31536000, 'year', 'y'], [2592000, 'month', 'mo'], [604800, 'week', 'w'], [86400, 'day', 'd'],
    [3600, 'hour', 'h'], [60, 'minute', 'm']];

  /**
   * Relative time for a unix timestamp (seconds): "3 days ago" (long) or "3d ago" (short).
   * Units are chosen by floor, so 30 min is "30 minutes ago", never "1 hour ago".
   */
  function relTime(sec, { now = Date.now() / 1000, short = false } = {}) {
    if (!sec) return '';
    const d = now - sec;
    const abs = Math.abs(d);
    if (abs < 60) return 'just now';
    for (const [len, name, abbr] of UNITS) {
      if (abs >= len) {
        const n = Math.floor(abs / len);
        const s = short ? `${n}${abbr}` : plural(n, name);
        return d >= 0 ? `${s} ago` : `in ${s}`;
      }
    }
    return 'just now';
  }

  /** Locale date + time for a unix timestamp (seconds). */
  function absTime(sec) {
    if (!sec) return '';
    try {
      return new Date(sec * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return new Date(sec * 1000).toISOString();
    }
  }

  /** Two-letter initials: "Ada Lovelace" -> "AL", "ada.lovelace" -> "AL", "ada" -> "AD". */
  function initials(name) {
    const parts = String(name || '?').trim().split(/[\s._-]+/).filter(Boolean);
    const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2);
    return s.toUpperCase();
  }

  // Bidi controls (can reorder text: "rtl\u202Egnp.js" would show as "rtlsj.png"), zero-width
  // joiners aside, and C0/C1 control characters (newlines, tabs, escape) are made visible.
  const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
  /** Text safe to show as a name/path: dangerous or invisible characters become visible escapes. */
  const displayName = (s) => String(s == null ? '' : s).replace(INVISIBLE, (c) => {
    if (c === '\n') return '\u21b5'; // ↵
    if (c === '\t') return '\u21e5'; // ⇥
    return `\\u{${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}}`;
  });

  /**
   * Folder tree from items by '/'-separated path:
   * {name, path, dirs: Map name -> node, files: [item]}; dirs' `path` ends with '/'.
   * compress: chains of single-child folders without files merge ("src/components").
   */
  function pathTree(items, pathOf = (x) => x.path, { compress = false } = {}) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const it of items) {
      const parts = String(pathOf(it)).split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const name = parts[i];
        if (!node.dirs.has(name)) node.dirs.set(name, { name, path: `${node.path}${name}/`, dirs: new Map(), files: [] });
        node = node.dirs.get(name);
      }
      node.files.push(it);
    }
    if (!compress) return root;
    const squash = (node) => {
      for (const [k, d] of [...node.dirs]) {
        let cur = d;
        while (cur.files.length === 0 && cur.dirs.size === 1) {
          const only = [...cur.dirs.values()][0];
          cur = { ...only, name: `${cur.name}/${only.name}` };
        }
        node.dirs.set(k, squash(cur));
      }
      return node;
    };
    return squash(root);
  }

  /** JSON localStorage wrapper that never throws (storage can be unavailable). */
  const storage = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* unavailable or full: keep in memory only */
      }
    },
  };

  /** Stable short key for per-repo settings (FNV-1a of the repo root). */
  function repoKey(root) {
    let h = 0x811c9dc5;
    for (const c of String(root || '')) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0;
    return h.toString(36);
  }

  /** True when a key event's target is a text-editing control (inputs keep their own keys). */
  function isEditable(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color'].includes((t.type || '').toLowerCase());
  }

  /**
   * A key event happens in a text field: its target or the focused element is editable (a
   * key can be dispatched to the window or body while a field has focus).
   */
  const inTextField = (e) => isEditable(e && e.target) || (typeof document !== 'undefined' && isEditable(document.activeElement));

  /**
   * A modal dialog or a menu is open: it owns the keyboard, so global and panel shortcuts stand
   * down. Components.dialog / .menu are looked up now (they load after this script); any other
   * [aria-modal="true"] element counts too.
   */
  function modalOpen() {
    const C = window.Components;
    const open = (x) => !!x && typeof x.isOpen === 'function' && x.isOpen();
    if (open(C && C.dialog) || open(C && C.menu)) return true;
    return typeof document !== 'undefined' && typeof document.querySelector === 'function' && !!document.querySelector('[aria-modal="true"]');
  }

  // ---------------------------------------------------------------- logging

  // Error kinds (err.kind) come from the catalogue src/error-kinds.js (window.PLErrorKinds; index.html
  // loads it before this script; under node a fresh copy is required). Every catalogued kind is one
  // the app classifies and explains to the user, so a toast for one is expected: logged at info.
  // Except UNEXPECTED_KINDS: a refused IPC call or argument check (invalid-args, forbidden,
  // unknown-op) means a renderer bug, like any error with no kind or one not catalogued (a JS
  // TypeError): logged at error, and its toast points at the logs. QUIET_KINDS are routine (a diff
  // that moved on, a cancel, nothing to undo, busy) and not logged from the renderer at all (main's
  // op record already has them).
  const ErrorKinds = load('PLErrorKinds', '../src/error-kinds.js');
  const CATALOGUE = ErrorKinds && ErrorKinds.MEANING ? Object.keys(ErrorKinds.MEANING) : [];
  const UNEXPECTED_KINDS = new Set(['invalid-args', 'forbidden', 'unknown-op']);
  const QUIET_KINDS = new Set(['stale', 'aborted', 'nothing', 'busy']);
  const EXPECTED_KINDS = new Set([...QUIET_KINDS, ...CATALOGUE.filter((k) => !UNEXPECTED_KINDS.has(k))]);

  /** A notice ({message, level: 'info'}, from store.actions.notify), not an error. */
  const isNotice = (e) => !!e && typeof e === 'object' && e.level === 'info' && !(e instanceof Error);

  /** An error the app has no explanation for (toast it with a pointer to the logs). */
  const isUnexpectedError = (e) => !!e && !isNotice(e) && !(typeof e.kind === 'string' && EXPECTED_KINDS.has(e.kind));

  /** Plain, small description of an error for a log record (main redacts it again). */
  function errorInfo(e) {
    if (!e || typeof e !== 'object') return { message: String(e) };
    const o = { name: typeof e.name === 'string' ? e.name : 'Error', message: String(e.message || '') };
    if (typeof e.kind === 'string') o.kind = e.kind;
    if (Number.isInteger(e.exitCode)) o.exitCode = e.exitCode;
    if (typeof e.stack === 'string') o.stack = e.stack.split('\n').slice(0, 12).join('\n');
    return o;
  }

  /** Send one record to main.log (window.api.log, fire and forget). Never throws. */
  function forward(level, msg, fields) {
    try {
      const api = typeof window !== 'undefined' ? window.api : null;
      if (api && typeof api.log === 'function') api.log(level, String(msg).slice(0, 2000), fields);
    } catch {
      /* logging must never break the page */
    }
  }

  const markLogged = (e) => {
    try {
      if (e && typeof e === 'object') e.logged = true;
    } catch { /* frozen */ }
  };

  /**
   * log.error(msg | err, ...extra) (and debug / info / warn): writes to the console exactly as
   * console[level](...args) would, and forwards one record to main.log: {msg, err?, extra?}. An
   * Error it logged is marked `logged`, so logToast doesn't record it a second time.
   */
  function write(level, args) {
    try {
      const c = typeof console !== 'undefined' ? console[level] : null;
      if (typeof c === 'function') c.apply(console, args);
    } catch { /* no console */ }
    const [first, ...rest] = args;
    const fields = {};
    let msg;
    if (first && typeof first === 'object') {
      msg = first.message || String(first);
      fields.err = errorInfo(first);
      markLogged(first);
    } else {
      msg = String(first);
    }
    const extra = [];
    for (const x of rest) {
      if (x && typeof x === 'object' && (x instanceof Error || typeof x.message === 'string') && !fields.err) {
        fields.err = errorInfo(x);
        markLogged(x);
      } else if (x !== undefined) {
        extra.push(x instanceof Error ? errorInfo(x) : x);
      }
    }
    if (extra.length) fields.extra = extra;
    forward(level, msg, fields);
  }

  const log = {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
  };

  /**
   * Record an error that is being toasted (app.js toast): unexpected ones at error level, expected
   * kinds at info, QUIET_KINDS and notices not at all; one already logged (util.log) is skipped.
   * Returns the level used, or null.
   */
  function logToast(e) {
    if (!e || isNotice(e) || (typeof e === 'object' && e.logged)) return null;
    if (typeof e === 'object' && typeof e.kind === 'string' && QUIET_KINDS.has(e.kind)) return null;
    const level = isUnexpectedError(e) ? 'error' : 'info';
    forward(level, `toast: ${(e && e.message) || String(e)}`, { err: errorInfo(e) });
    markLogged(e);
    return level;
  }

  // Uncaught errors and unhandled rejections go to main.log (the console already shows them).
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('error', (e) => {
      const where = e && e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined;
      forward('error', `uncaught error: ${(e && e.message) || 'unknown'}`, { err: e && e.error ? errorInfo(e.error) : undefined, where });
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e ? e.reason : undefined;
      forward('error', `unhandled rejection: ${(r && r.message) || String(r)}`, { err: errorInfo(r) });
    });
  }

  /**
   * A script this one needs that loads before it in index.html: `name` on window ('PLColumns', or a
   * dotted path such as 'Components.actions'), else, under node (the tests), a fresh copy of `file`
   * (a path relative to renderer/) required now, so it binds to the window the test just built.
   * null in a browser without it.
   */
  function load(name, file) {
    const have = String(name).split('.').reduce((o, k) => (o ? o[k] : undefined), typeof window !== 'undefined' ? window : undefined);
    if (have) return have;
    if (typeof module === 'undefined' || typeof require !== 'function') return null;
    const p = require.resolve(file);
    delete require.cache[p];
    return require(p);
  }

  /** Mounted components: {node, dispose} (dispose is what def.mount returned, if a function). */
  const mounted = [];

  /** Unmount everything mounted under `root` (default: all), calling each component's dispose. */
  function unmountAll(root) {
    for (let i = mounted.length - 1; i >= 0; i--) {
      const m = mounted[i];
      if (root && !(root === m.node || (root.contains && root.contains(m.node)))) continue;
      mounted.splice(i, 1);
      delete m.node.dataset.mounted;
      if (m.dispose) {
        try {
          m.dispose();
        } catch (e) {
          log.error(e);
        }
      }
    }
  }

  window.Components = {
    el,
    util: {
      toError, plural, short, OID_RE, report, modKey, PLATFORM, IS_MAC, relTime, absTime, initials, displayName, pathTree, storage, repoKey, isEditable, inTextField, modalOpen,
      button, log, logToast, isUnexpectedError, EXPECTED_KINDS, QUIET_KINDS, UNEXPECTED_KINDS, load,
    },
    register(name, def) {
      if (registry.has(name)) throw new Error(`component ${name} registered twice`);
      registry.set(name, def);
    },
    /**
     * Mount every [data-component] element under `root` (idempotent per element). Returns a
     * disposer that unmounts them again (same as unmountAll(root)).
     */
    mountAll(root, store) {
      for (const node of root.querySelectorAll('[data-component]')) {
        if (node.dataset.mounted) continue;
        const def = registry.get(node.dataset.component);
        if (!def) {
          log.warn(`no component registered for ${node.dataset.component}`);
          continue;
        }
        node.dataset.mounted = '1';
        const dispose = def.mount(node, store);
        mounted.push({ node, dispose: typeof dispose === 'function' ? dispose : null });
      }
      return () => unmountAll(root);
    },
    unmountAll,
  };
})();
