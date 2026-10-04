'use strict';
// Pure helpers in renderer/components.js (window.Components.util).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const util = () => H.loadRenderer().Components.util;

// ------------------------------------------------------------------ relTime

test('relTime: floor semantics at unit boundaries', () => {
  const { relTime } = util();
  const now = 2_000_000_000;
  const S = 1;
  const M = 60;
  const Hr = 3600;
  const D = 86400;
  const cases = [
    [59 * S, 'just now'],
    [60 * S, '1 minute ago'],
    [119 * S, '1 minute ago'],
    [30 * M, '30 minutes ago'],
    [59 * M + 59, '59 minutes ago'],
    [60 * M, '1 hour ago'],
    [12 * Hr, '12 hours ago'],
    [23 * Hr + 59 * M, '23 hours ago'],
    [4 * D, '4 days ago'],
    [6 * D + 23 * Hr, '6 days ago'],
    [7 * D, '1 week ago'],
    [15 * D, '2 weeks ago'],
    [29 * D, '4 weeks ago'],
    [30 * D, '1 month ago'],
    [190 * D, '6 months ago'],
    [364 * D, '12 months ago'],
    [365 * D, '1 year ago'],
    [3 * 365 * D, '3 years ago'],
  ];
  for (const [ago, want] of cases) assert.equal(relTime(now - ago, { now }), want, `${ago}s ago`);
  assert.equal(relTime(now, { now }), 'just now');
});

test('relTime: short mode', () => {
  const { relTime } = util();
  const now = 2_000_000_000;
  assert.equal(relTime(now - 30, { now, short: true }), 'just now');
  assert.equal(relTime(now - 5 * 60, { now, short: true }), '5m ago');
  assert.equal(relTime(now - 2 * 3600, { now, short: true }), '2h ago');
  assert.equal(relTime(now - 3 * 86400, { now, short: true }), '3d ago');
  assert.equal(relTime(now - 14 * 86400, { now, short: true }), '2w ago');
  assert.equal(relTime(now - 60 * 86400, { now, short: true }), '2mo ago');
  assert.equal(relTime(now - 400 * 86400, { now, short: true }), '1y ago');
});

test('relTime: future times, missing timestamps and the default clock', () => {
  const { relTime } = util();
  const now = 2_000_000_000;
  assert.equal(relTime(now + 2 * 3600, { now }), 'in 2 hours');
  assert.equal(relTime(now + 60, { now }), 'in 1 minute');
  assert.equal(relTime(now + 3 * 86400, { now, short: true }), 'in 3d');
  assert.equal(relTime(now + 10, { now }), 'just now', 'small clock skew');
  assert.equal(relTime(0, { now }), '');
  assert.equal(relTime(null), '');
  assert.equal(relTime(undefined), '');
  assert.equal(relTime(Math.floor(Date.now() / 1000) - 7200), '2 hours ago');
});

// ------------------------------------------------------------------ absTime

test('absTime: non-empty for a timestamp, empty without', () => {
  const { absTime } = util();
  const s = absTime(1700000000);
  assert.equal(typeof s, 'string');
  assert.ok(s.length > 0);
  assert.match(s, /2023/);
  assert.equal(absTime(0), '');
  assert.equal(absTime(null), '');
});

// ------------------------------------------------------------------ initials

test('initials', () => {
  const { initials } = util();
  assert.equal(initials('Ada Lovelace'), 'AL');
  assert.equal(initials('Ada Augusta King Lovelace'), 'AL');
  assert.equal(initials('ada.lovelace'), 'AL');
  assert.equal(initials('ada_love-lace'), 'AL');
  assert.equal(initials('ada'), 'AD');
  assert.equal(initials('a'), 'A');
  assert.equal(initials('  ada  '), 'AD');
  assert.equal(initials(''), '?');
  assert.equal(initials(null), '?');
  assert.equal(initials(undefined), '?');
  assert.equal(initials('   '), '?');
  assert.equal(initials('Ünïcödé Name'), 'ÜN');
  assert.equal(initials('ñandú'), 'ÑA');
});

// ------------------------------------------------------------------ displayName

test('displayName: bidi and invisible controls become visible escapes', () => {
  const { displayName } = util();
  assert.equal(displayName('rtl\u202Egnp.js'), 'rtl\\u{202E}gnp.js');
  for (const c of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]) {
    const hex = c.toString(16).toUpperCase().padStart(4, '0');
    assert.equal(displayName(`a${String.fromCodePoint(c)}b`), `a\\u{${hex}}b`, hex);
  }
});

test('displayName: newline, tab and C0/C1 controls', () => {
  const { displayName } = util();
  assert.equal(displayName('a\nb'), 'a\u21b5b');
  assert.equal(displayName('a\tb'), 'a\u21e5b');
  assert.equal(displayName('a\u0000b'), 'a\\u{0000}b');
  assert.equal(displayName('a\u001bb'), 'a\\u{001B}b');
  assert.equal(displayName('a\rb'), 'a\\u{000D}b');
  assert.equal(displayName('a\u007fb'), 'a\\u{007F}b');
  assert.equal(displayName('a\u0085b'), 'a\\u{0085}b');
});

test('displayName: normal text, unicode and emoji untouched', () => {
  const { displayName } = util();
  for (const s of ['src/main.js', 'Ünïcödé Name', '日本語/ファイル.txt', 'שלום', 'caf\u00e9', 'e\u0301', '🎉 party', '👩\u200d💻 dev', '🇩🇪', 'with space']) {
    assert.equal(displayName(s), s, JSON.stringify(s));
  }
  assert.equal(displayName(null), '');
  assert.equal(displayName(undefined), '');
  assert.equal(displayName(42), '42');
});

// ------------------------------------------------------------------ pathTree

const P = (...paths) => paths.map((path) => ({ path }));
const dirNames = (node) => [...node.dirs.values()].map((d) => d.name);
const filePaths = (node) => node.files.map((f) => f.path);

test('pathTree: nesting, root files, duplicate names in different folders', () => {
  const { pathTree } = util();
  const t = pathTree(P('README.md', 'src/a/index.js', 'src/b/index.js', 'src/main.js', 'docs/x.md'));
  assert.equal(t.name, '');
  assert.equal(t.path, '');
  assert.deepEqual(filePaths(t), ['README.md']);
  assert.deepEqual(dirNames(t), ['src', 'docs']);
  const src = t.dirs.get('src');
  assert.equal(src.path, 'src/');
  assert.deepEqual(filePaths(src), ['src/main.js']);
  assert.deepEqual(dirNames(src), ['a', 'b']);
  assert.equal(src.dirs.get('a').path, 'src/a/');
  assert.deepEqual(filePaths(src.dirs.get('a')), ['src/a/index.js']);
  assert.deepEqual(filePaths(src.dirs.get('b')), ['src/b/index.js']);
  assert.deepEqual(filePaths(t.dirs.get('docs')), ['docs/x.md']);
});

test('pathTree: custom pathOf keeps the original items', () => {
  const { pathTree } = util();
  const items = [{ name: 'feature/login' }, { name: 'feature/logout' }, { name: 'main' }];
  const t = pathTree(items, (b) => b.name);
  assert.deepEqual(t.files, [items[2]]);
  assert.deepEqual(t.dirs.get('feature').files, [items[0], items[1]]);
  assert.deepEqual(pathTree([]).files, []);
});

test('pathTree compress: merges single-child folder chains, not folders with files', () => {
  const { pathTree } = util();
  const t = pathTree(P('src/components/ui/button.js', 'src/components/ui/input.js', 'lib/x.js', 'lib/deep/er/y.js', 'a/b/c/1', 'a/b/d/2'), undefined, { compress: true });
  const byName = Object.fromEntries([...t.dirs.values()].map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(byName).sort(), ['a/b', 'lib', 'src/components/ui']);

  const ui = byName['src/components/ui'];
  assert.equal(ui.path, 'src/components/ui/');
  assert.deepEqual(filePaths(ui), ['src/components/ui/button.js', 'src/components/ui/input.js']);

  const lib = byName.lib;
  assert.equal(lib.path, 'lib/', 'lib has a file: not merged with its child');
  assert.deepEqual(filePaths(lib), ['lib/x.js']);
  assert.deepEqual(dirNames(lib), ['deep/er'], 'nested chain below is merged');
  assert.equal([...lib.dirs.values()][0].path, 'lib/deep/er/');

  const ab = byName['a/b'];
  assert.equal(ab.path, 'a/b/');
  assert.deepEqual(dirNames(ab).sort(), ['c', 'd'], 'a folder with two subfolders ends the chain');
});

test('pathTree compress: a folder whose only child is a file is kept', () => {
  const { pathTree } = util();
  const t = pathTree(P('one/two/file.txt'), undefined, { compress: true });
  const d = [...t.dirs.values()];
  assert.equal(d.length, 1);
  assert.equal(d[0].name, 'one/two');
  assert.deepEqual(filePaths(d[0]), ['one/two/file.txt']);
  assert.equal(d[0].dirs.size, 0);
});

// ------------------------------------------------------------------ storage

test('storage: JSON round trip through localStorage', (t) => {
  const ls = H.memoryStorage();
  H.setLocalStorage(ls);
  t.after(() => H.setLocalStorage(undefined));
  const { storage } = util();
  const v = { collapsed: ['LOCAL', 'TAGS'], n: 3, ok: true, nested: { a: null } };
  storage.set('pl.test', v);
  assert.equal(ls.map.get('pl.test'), JSON.stringify(v));
  assert.deepEqual(storage.get('pl.test', null), v);
  storage.set('pl.num', 0);
  assert.equal(storage.get('pl.num', 5), 0, 'falsy stored values are returned');
  assert.equal(storage.get('pl.missing', 'fb'), 'fb');
});

test('storage: corrupt JSON falls back', (t) => {
  const ls = H.memoryStorage();
  H.setLocalStorage(ls);
  t.after(() => H.setLocalStorage(undefined));
  const { storage } = util();
  ls.setItem('bad', '{not json');
  assert.deepEqual(storage.get('bad', { d: 1 }), { d: 1 });
});

test('storage: throwing or missing localStorage never throws', (t) => {
  t.after(() => H.setLocalStorage(undefined));
  H.setLocalStorage(H.throwingStorage());
  let { storage } = util();
  assert.doesNotThrow(() => storage.set('k', { a: 1 }));
  assert.equal(storage.get('k', 'fb'), 'fb');

  H.setLocalStorage(undefined); // no storage at all
  ({ storage } = util());
  assert.doesNotThrow(() => storage.set('k', 1));
  assert.equal(storage.get('k', 'fb'), 'fb');

  const full = H.memoryStorage();
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  H.setLocalStorage(full);
  ({ storage } = util());
  assert.doesNotThrow(() => storage.set('k', 'x'.repeat(10)));
  assert.equal(storage.get('k', 'fb'), 'fb');
});

// ------------------------------------------------------------------ repoKey

test('repoKey: stable, short, distinct per root', () => {
  const { repoKey } = util();
  const a = repoKey('/Users/ada/projects/app');
  assert.equal(a, repoKey('/Users/ada/projects/app'));
  assert.equal(a, H.loadRenderer().Components.util.repoKey('/Users/ada/projects/app'), 'stable across loads');
  assert.match(a, /^[0-9a-z]{1,7}$/);
  const roots = ['/a', '/b', '/a/', '/Users/ada/projects/app2', 'C:\\repo', '/tmp/ü', '/tmp/u', ''];
  const keys = new Set([a, ...roots.map(repoKey)]);
  assert.equal(keys.size, roots.length + 1, 'no collisions among these');
  assert.equal(repoKey(null), repoKey(''));
});

// ------------------------------------------------------------------ isEditable

test('isEditable: text inputs, textarea, select, contenteditable', () => {
  const { isEditable } = util();
  const elem = (tagName, extra = {}) => ({ nodeType: 1, tagName, isContentEditable: false, ...extra });
  for (const type of ['', 'text', 'search', 'email', 'password', 'number', 'url', 'TEXT']) {
    assert.equal(isEditable(elem('INPUT', { type })), true, `input[type=${type}]`);
  }
  assert.equal(isEditable(elem('INPUT')), true, 'input without type');
  for (const type of ['checkbox', 'button', 'radio', 'submit', 'reset', 'range', 'color', 'Checkbox']) {
    assert.equal(isEditable(elem('INPUT', { type })), false, `input[type=${type}]`);
  }
  assert.equal(isEditable(elem('TEXTAREA')), true);
  assert.equal(isEditable(elem('SELECT')), true);
  assert.equal(isEditable(elem('DIV', { isContentEditable: true })), true);
  assert.equal(isEditable(elem('DIV')), false);
  assert.equal(isEditable(elem('BUTTON')), false);
});

test('isEditable: non-elements', () => {
  const { isEditable } = util();
  assert.equal(isEditable(null), false);
  assert.equal(isEditable(undefined), false);
  assert.equal(isEditable({ nodeType: 3, tagName: 'INPUT' }), false, 'text node');
  assert.equal(isEditable({ nodeType: 9 }), false, 'document');
  assert.equal(isEditable({}), false, 'window-like');
});

// ------------------------------------------------------------------ inTextField / modalOpen

/** Run fn with globalThis.document replaced by `doc` (restored afterwards). */
function withDocument(doc, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  try { return fn(); } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else delete globalThis.document;
  }
}

test('inTextField: the event target or the focused element is a text field', () => {
  const { inTextField } = util();
  const elem = (tagName, extra = {}) => ({ nodeType: 1, tagName, isContentEditable: false, ...extra });
  const input = elem('INPUT', { type: 'text' });
  const button = elem('BUTTON');
  withDocument({ activeElement: button }, () => {
    assert.equal(inTextField({ target: input }), true, 'target');
    assert.equal(inTextField({ target: button }), false);
    assert.equal(inTextField({ target: elem('INPUT', { type: 'checkbox' }) }), false);
    assert.equal(inTextField({}), false);
    assert.equal(inTextField(null), false);
  });
  withDocument({ activeElement: elem('TEXTAREA') }, () => {
    assert.equal(inTextField({ target: button }), true, 'dispatched elsewhere while a field has focus');
    assert.equal(inTextField(null), true);
  });
});

test('modalOpen: Components.dialog or Components.menu open, or an [aria-modal="true"] element', () => {
  const win = H.loadRenderer();
  const { modalOpen } = win.Components.util;
  let modal = null;
  withDocument({ querySelector: (sel) => (sel === '[aria-modal="true"]' ? modal : null) }, () => {
    assert.equal(modalOpen(), false, 'neither loaded');
    win.Components.dialog = { isOpen: () => false };
    win.Components.menu = { isOpen: () => false };
    assert.equal(modalOpen(), false);
    win.Components.dialog.isOpen = () => true;
    assert.equal(modalOpen(), true, 'dialog (looked up at call time)');
    win.Components.dialog.isOpen = () => false;
    win.Components.menu.isOpen = () => true;
    assert.equal(modalOpen(), true, 'menu');
    win.Components.menu = { isOpen: 'nope' };
    assert.equal(modalOpen(), false, 'isOpen must be a function');
    modal = { nodeType: 1 };
    assert.equal(modalOpen(), true, 'another modal element');
  });
  withDocument({}, () => assert.equal(modalOpen(), false, 'no querySelector'));
});

// ------------------------------------------------------------------ toError / el

test('toError: keeps Errors, wraps bridge objects and strings', () => {
  const { toError } = util();
  const e = new Error('x');
  assert.equal(toError(e), e);
  const w = toError({ message: 'bad', kind: 'git', code: 128 });
  assert.ok(w instanceof Error);
  assert.equal(w.message, 'bad');
  assert.equal(w.kind, 'git');
  assert.equal(w.code, 128);
  assert.equal(toError('plain').message, 'plain');
  // a string is not spread onto the Error ("0": "p", "1": "l", ...)
  assert.deepEqual(Object.keys(toError('plain')), [], 'no extra own keys from a string');
  assert.deepEqual(Object.keys(toError(42)), []);
  assert.equal(toError(undefined).message, 'undefined');
  assert.equal(toError(null).message, 'null');
  assert.deepEqual(Object.keys(w).sort(), ['code', 'kind'], 'only the bridge fields');
  assert.equal(toError({ kind: 'x' }).kind, 'x');
});

test('plural', () => {
  const { plural } = util();
  assert.equal(plural(0, 'file'), '0 files');
  assert.equal(plural(1, 'file'), '1 file');
  assert.equal(plural(3, 'file'), '3 files');
  assert.equal(plural(2, 'entry', 'entries'), '2 entries');
  assert.equal(plural(1, 'entry', 'entries'), '1 entry');
});

test('modKey: ⌘ on macOS, Ctrl elsewhere', () => {
  const { modKey, IS_MAC } = util();
  assert.equal(typeof IS_MAC, 'boolean');
  assert.equal(modKey({ metaKey: true, ctrlKey: false }), IS_MAC);
  assert.equal(modKey({ metaKey: false, ctrlKey: true }), !IS_MAC);
  assert.equal(modKey({}), false);
});

test('el: sets class and text via textContent only', () => {
  const { el } = H.loadRenderer().Components;
  const e = el('div', 'cls', '<b>x</b>');
  assert.equal(e.tagName, 'DIV');
  assert.equal(e.className, 'cls');
  assert.equal(e.textContent, '<b>x</b>');
  assert.equal(e.innerHTML, undefined);
  assert.equal('textContent' in el('span', null, null), false);
  assert.equal(el('span', '', 0).textContent, 0);
});

// ------------------------------------------------------------------ mount / unmount

function fakeNode(component) {
  return { dataset: { component }, contains: () => false };
}

test('mountAll keeps the disposers; unmountAll / the returned disposer call each once and allow remounting', (t) => {
  const { Components } = H.loadRenderer();
  t.mock.method(console, 'warn', () => {});
  const calls = [];
  Components.register('a', { mount: () => { calls.push('mount a'); return () => calls.push('dispose a'); } });
  Components.register('b', { mount: () => { calls.push('mount b'); } }); // no disposer
  const nodes = [fakeNode('a'), fakeNode('b'), fakeNode('missing')];
  const root = { querySelectorAll: () => nodes, contains: (n) => nodes.includes(n) };
  const dispose = Components.mountAll(root, {});
  Components.mountAll(root, {}); // idempotent
  assert.deepEqual(calls, ['mount a', 'mount b']);
  assert.equal(nodes[0].dataset.mounted, '1');
  dispose();
  dispose();
  assert.deepEqual(calls, ['mount a', 'mount b', 'dispose a']);
  assert.equal(nodes[0].dataset.mounted, undefined);
  Components.mountAll(root, {});
  Components.unmountAll();
  assert.deepEqual(calls.slice(3), ['mount a', 'mount b', 'dispose a']);
});

test('unmountAll: a throwing disposer does not stop the others', (t) => {
  const { Components } = H.loadRenderer();
  const errors = [];
  t.mock.method(console, 'error', (e) => errors.push(e));
  let disposed = false;
  Components.register('x', { mount: () => () => { throw new Error('boom'); } });
  Components.register('y', { mount: () => () => { disposed = true; } });
  const nodes = [fakeNode('x'), fakeNode('y')];
  Components.mountAll({ querySelectorAll: () => nodes }, {});
  Components.unmountAll();
  assert.equal(disposed, true);
  assert.equal(errors.length, 1);
});

// ------------------------------------------------------------------ graph-view / sidebar pure pieces

/** Load a component script into a fresh renderer and return its node exports. */
function loadComponent(file) {
  const win = H.loadRenderer();
  const p = require.resolve(`../renderer/components/${file}`);
  delete require.cache[p];
  return { win, mod: require(p) };
}

test('refPills: order, upstream pairing, display-safe names', () => {
  const { mod: { refPills } } = loadComponent('graph-view.js');
  assert.deepEqual(refPills(undefined, new Map()), []);
  const remoteBranch = new Map([['origin/main', 'main'], ['origin/feat', 'feat'], ['up/main', 'main']]);
  const refs = [
    { type: 'tag', name: 'v1' },
    { type: 'remote', name: 'origin/main', remote: 'origin', branch: 'main' },
    { type: 'remote', name: 'up/main', remote: 'up', branch: 'main' },
    { type: 'local', name: 'feat', current: false, upstream: null },
    { type: 'remote', name: 'origin/feat', remote: 'origin', branch: 'feat' },
    { type: 'local', name: 'main', current: true, upstream: 'up/main' },
    { type: 'head', name: 'HEAD' },
  ];
  const pills = refPills(refs, remoteBranch);
  assert.deepEqual(pills.map((p) => [p.kind, p.name, p.remote || null]), [
    ['head', 'HEAD', null],
    ['local', 'main', 'up/main'], // configured upstream, never guessed from origin/main
    ['local', 'feat', 'origin/feat'], // no upstream: same-named remote branch
    ['remote', 'origin/main', null],
    ['tag', 'v1', null],
  ]);
  assert.equal(pills[1].current, true);
  assert.match(pills[1].title, /^Current branch main \(in sync with up\/main\)$/);
  // tracking a remote branch that is elsewhere: no pairing
  const away = refPills([{ type: 'local', name: 'main', upstream: 'origin/main' }, { type: 'remote', name: 'up/main' }], remoteBranch);
  assert.deepEqual(away.map((p) => p.kind), ['local', 'remote']);
  // bidi control in a name is made visible
  const [evil] = refPills([{ type: 'tag', name: 'x\u202Egnp.js' }], new Map());
  assert.equal(evil.name, 'x\\u{202E}gnp.js');
});

test('rowView: WIP row clears every text and tooltip (no recycled commit tooltips)', () => {
  const { mod: { rowView } } = loadComponent('graph-view.js');
  const H2 = H;
  const ctx = { refsBySha: new Map([['c1', [{ type: 'tag', name: 't' }]]]), remoteBranch: new Map(), status: H2.status({ unstaged: [{ path: 'a' }, { path: 'b' }], staged: [{ path: 'a' }] }) };
  const c = { kind: 'commit', commit: { hash: 'c1'.padEnd(40, '0'), parents: [], subject: 's', author: 'Ada', email: 'a@x', date: 1700000000, body: 'b\n\nmore' } };
  ctx.refsBySha.set(c.commit.hash, [{ type: 'tag', name: 't' }]);
  const v = rowView(c, { colorIndex: 3, isMerge: false }, ctx);
  assert.equal(v.wip, false);
  assert.equal(v.lane, 3);
  assert.equal(v.authorTitle, 'Ada <a@x>');
  assert.equal(v.shaTitle, c.commit.hash);
  assert.equal(v.sha, c.commit.hash.slice(0, 7));
  assert.equal(v.body, 'b more');
  assert.equal(v.count, null);
  assert.deepEqual(v.pills.map((p) => p.name), ['t']);
  const w = rowView({ kind: 'wip' }, { colorIndex: 0 }, ctx);
  assert.equal(w.wip, true);
  assert.equal(w.count, '2 files', 'distinct paths across the lists');
  for (const k of ['author', 'authorTitle', 'date', 'dateTitle', 'sha', 'shaTitle', 'body']) assert.equal(w[k], '', k);
  assert.equal(rowView({ kind: 'wip' }, null, { ...ctx, status: H2.status({ unstaged: [{ path: 'a' }] }) }).count, '1 file');
});

test('sidebarModel: sections, folders, filter, collapse, unborn/detached rows, stash error', () => {
  const { mod: { sidebarModel } } = loadComponent('sidebar.js');
  const refs = H.refs({
    local: [
      { name: 'main', oid: 'm', current: true, upstream: 'origin/main', ahead: 1, behind: 2 },
      { name: 'feat/a', oid: 'a' }, { name: 'feat/b', oid: 'b', upstream: 'origin/feat/b', gone: true },
    ],
    remote: [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: 'm' }, { name: 'origin/feat/b', remote: 'origin', branch: 'feat/b', oid: 'b' }],
    tags: [{ name: 'v1', oid: 'm' }],
  });
  const stashes = [{ hash: 's1', ref: 'stash@{0}', message: 'wip on main', date: 0 }];
  const m = sidebarModel({ refs, status: H.status({ oid: 'm' }), stashes, stashError: null });
  assert.deepEqual(m.sections.map((x) => [x.id, x.count, x.open]), [['local', 3, true], ['remote', 2, true], ['tags', 1, true], ['stashes', 1, true], ['worktrees', 0, true]]);
  const local = m.sections[0].rows;
  assert.deepEqual(local.map((r) => r.key), ['dir:local:/feat', 'local:feat/a', 'local:feat/b', 'local:main']);
  assert.equal(local[0].count, 2);
  assert.equal(local[0].level, 0);
  assert.equal(local[1].level, 1);
  assert.deepEqual(local[2].badges, [{ cls: 'sb-gone', text: 'gone' }]);
  assert.deepEqual(local[3].badges.map((b) => b.text), ['1↑', '2↓']);
  assert.equal(local[3].icon, 'check');
  assert.deepEqual(m.sections[1].rows.map((r) => r.key), ['dir:remote:origin', 'dir:remote:origin/feat', 'remote:origin/feat/b', 'remote:origin/main']);
  assert.equal(m.summary, '');

  // equal inputs give equal models (the DOM is left alone)
  assert.equal(JSON.stringify(sidebarModel({ refs, status: H.status({ oid: 'm', dirty: true }), stashes })), JSON.stringify(sidebarModel({ refs, status: H.status({ oid: 'm' }), stashes })));

  // collapsed folder / section; filter opens folders and counts matches
  const c = sidebarModel({ refs, status: null, stashes }, { collapsedFolders: new Set(['dir:local:/feat']), collapsedSections: { tags: true } });
  assert.deepEqual(c.sections[0].rows.map((r) => r.key), ['dir:local:/feat', 'local:main']);
  assert.equal(c.sections[0].rows[0].expanded, false);
  assert.equal(c.sections[2].open, false);
  const f = sidebarModel({ refs, status: null, stashes }, { filter: 'feat', collapsedFolders: new Set(['dir:local:/feat']) });
  assert.deepEqual(f.sections[0].rows.map((r) => r.key), ['dir:local:/feat', 'local:feat/a', 'local:feat/b']);
  assert.equal(f.summary, 'Viewing 3 of 7');
  assert.equal(f.sections[2].emptyText, 'No matches');

  // unborn branch and detached HEAD pseudo rows; stash error text
  const u = sidebarModel({ refs: H.refs(), status: H.status({ oid: null, branch: 'main' }), stashes: [], stashError: 'bad reflog' });
  assert.deepEqual(u.sections[0].rows.map((r) => [r.key, r.cls]), [['unborn:main', 'current unborn']]);
  assert.equal(u.sections[0].count, 1);
  assert.match(u.sections[3].emptyText, /bad reflog/);
  const d = sidebarModel({ refs: H.refs({ head: { oid: 'd'.repeat(40), detached: true } }), status: null, stashes: [] });
  assert.equal(d.sections[0].rows[0].key, 'head:detached');
  assert.deepEqual(d.sections[0].rows[0].badges, [{ cls: 'sb-sha', text: 'ddddddd' }]);
});

test('EXPECTED_KINDS: the rebase / merge error kinds users see are expected (logged at info), not unexpected', () => {
  const u = util();
  // docs/plans/rebase.md §4.5 (conflicts, stale, nothing, hook-failed and stash-conflict were already there)
  for (const kind of ['in-progress', 'not-rebasing', 'not-merging', 'conflicts', 'dirty', 'stale', 'nothing', 'invalid-todo', 'merge-commits',
    'root-commit', 'too-many', 'checked-out-elsewhere', 'hook-failed', 'rebasing', 'stash-conflict']) {
    assert.ok(u.EXPECTED_KINDS.has(kind), kind);
    assert.equal(u.isUnexpectedError(Object.assign(new Error(kind), { kind })), false, kind);
  }
  assert.equal(u.isUnexpectedError(Object.assign(new Error('x'), { kind: 'invalid-args' })), true, 'still unexpected');
});

test('EXPECTED_KINDS / QUIET_KINDS come from the error-kind catalogue (src/error-kinds.js), minus the IPC refusals', () => {
  const u = util();
  const { MEANING, isKind } = require('../src/error-kinds.js');
  const catalogue = Object.keys(MEANING);
  assert.deepEqual([...u.UNEXPECTED_KINDS].sort(), ['forbidden', 'invalid-args', 'unknown-op']); // NOSONAR(S2871): ASCII names
  assert.deepEqual([...u.UNEXPECTED_KINDS].filter((k) => !isKind(k)), [], 'the exceptions are catalogued kinds');
  assert.deepEqual([...u.QUIET_KINDS].filter((k) => !isKind(k)), [], 'quiet kinds are catalogued kinds');
  assert.deepEqual([...u.EXPECTED_KINDS].sort(), catalogue.filter((k) => !u.UNEXPECTED_KINDS.has(k)).sort()); // NOSONAR(S2871)
  for (const k of u.UNEXPECTED_KINDS) assert.equal(u.isUnexpectedError(Object.assign(new Error(k), { kind: k })), true, k);
  assert.equal(u.isUnexpectedError(Object.assign(new Error('x'), { kind: 'no-such-kind' })), true);
});

test('index.html loads ../src/error-kinds.js (window.PLErrorKinds) before components.js', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const at = scripts.indexOf('../src/error-kinds.js');
  assert.ok(at >= 0, 'loaded');
  assert.ok(at < scripts.indexOf('components.js'), 'before components.js');
});
