'use strict';
// Repository picker (renderer/components/repo-picker.js, window.PLRepoPicker): the pure ranking and
// highlighting, the shared list on the New Tab start screen (filtering, keyboard, open here vs in a
// new tab, the open-in-another-tab badge, Esc), the toolbar popover (cap and View all, Esc / outside
// press / anchor toggle, Tab cycling, ⌘O), the toolbar's repository stack, and a main without tabs
// (window.api.tabs undefined). Mounted on H.componentDom with a fake window.api.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const R = (f) => require.resolve(`../renderer/${f}`);
const PICKER = R('components/repo-picker.js');

// display: the shown path main sends with each entry (src/recent-view.js: the home folder as ~).
const RECENT = [
  { root: '/Users/ada/src/git-clients', name: 'git-clients', display: '~/src/git-clients' },
  { root: '/Users/ada/src/noodle', name: 'noodle', display: '~/src/noodle' },
  { root: '/Users/ada/work/api-server', name: 'api-server', display: '~/work/api-server' },
  { root: '/home/bob/clients/web', name: 'web', display: '~/clients/web' },
  { root: '/opt/repos/gitlab-mirror', name: 'gitlab-mirror', display: '/opt/repos/gitlab-mirror' },
  { root: '/Users/ada/src/notes', name: 'notes', display: '~/src/notes' },
  { root: '/Users/ada/src/dotfiles', name: 'dotfiles', display: '~/src/dotfiles' },
  { root: '/Users/ada/src/game', name: 'game', display: '~/src/game' },
];

/** A fresh PLRepoPicker alone (pure helpers only need Components.util). */
function freshPicker() {
  H.loadRenderer();
  delete require.cache[PICKER];
  return require(PICKER);
}

/**
 * Renderer window on H.componentDom with actions.js, menu.js, toolbar.js (PLIcons) and the picker
 * loaded; window.api records openRecent / openDialog (and tabs.newTab / activate when `tabs`).
 */
function setup(tc, { tabs = false, activate = false, recent = RECENT, fail = null, store = null } = {}) {
  const win = store ? store.win : H.loadRenderer();
  const dom = H.componentDom();
  Object.defineProperty(globalThis, 'document', { value: dom.doc, configurable: true, writable: true });
  win.addEventListener = dom.win.addEventListener;
  win.removeEventListener = dom.win.removeEventListener;
  win.innerWidth = 1280;
  win.innerHeight = 800;
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return fail ? Promise.reject({ message: fail, kind: 'not-a-repo' }) : Promise.resolve(true); };
  win.api = { app: { openRecent: rec('openRecent'), openDialog: rec('openDialog') } };
  if (tabs) {
    win.api.tabs = { newTab: rec('newTab') };
    if (activate) win.api.tabs.activate = rec('activate');
  }
  for (const f of ['actions.js', 'menu.js', 'components/toolbar.js']) {
    delete require.cache[R(f)];
    require(R(f));
  }
  delete require.cache[PICKER];
  const P = require(PICKER);
  P.source.set({ recent, current: null, tabs: [], tabId: null });
  const IS_MAC = win.Components.util.IS_MAC;
  const mod = IS_MAC ? { metaKey: true } : { ctrlKey: true };
  tc.after(() => { if (P.isOpen()) P.close(); });
  return { win, dom, P, calls, mod, IS_MAC };
}

const names = (list) => list.root.querySelectorAll('.rp-item').map((li) => li.querySelector('.rp-name').textContent);
const marks = (li) => li.querySelectorAll('mark').map((m) => m.textContent);
const type = (t, list, text) => {
  list.input.value = text;
  t.dom.dispatch(list.input, 'input');
};
const activeRow = (list) => list.root.querySelector('.rp-item.is-active');

/** The start screen mounted in a <section> on the body. */
function start(t, opts = {}) {
  const box = t.dom.doc.createElement('section');
  t.dom.doc.body.append(box);
  const errors = [];
  const s = t.P.mountStart(box, { onError: (e) => errors.push(e), ...opts });
  s.focus();
  return { ...s, box, errors };
}

// ------------------------------------------------------------------ pure

test("the shown path is main's display (home as ~); without one, the root; the picker has no path rule of its own", () => {
  const P = freshPicker();
  assert.equal(P.homeShort, undefined, 'no renderer copy of fs-paths homeShort');
  const [a, b] = P._internal.rank([{ root: '/Users/ada/x', name: 'x', display: '~/x' }, { root: 'C:\\Users\\ada\\y', name: 'y' }], '');
  assert.deepEqual([a.path, a.title], ['~/x', '~/x']);
  assert.deepEqual([b.path, b.title], ['C:\\Users\\ada\\y', 'C:\\Users\\ada\\y'], 'no display: the root as it is, never guessed');
  P.source.set({ recent: RECENT });
  assert.equal(P.shownPath('/Users/ada/src/noodle'), '~/src/noodle', "shownPath: the recent entry's display");
  assert.equal(P.shownPath('/Users/ada/elsewhere'), '/Users/ada/elsewhere', 'not in the recent list: the root');
});

test('segments / subsequence: highlighted pieces of a label', () => {
  const P = freshPicker();
  assert.deepEqual(P._internal.segments('noodle', [[0, 2]]), [{ text: 'no', hit: true }, { text: 'odle', hit: false }]);
  assert.deepEqual(P._internal.segments('noodle', [[1, 2], [4, 6]]).map((s) => `${s.hit ? '[' : ''}${s.text}${s.hit ? ']' : ''}`).join(''), 'n[o]od[le]');
  assert.deepEqual(P._internal.segments('abc', []), [{ text: 'abc', hit: false }]);
  assert.deepEqual(P._internal.segments('', []), [{ text: '', hit: false }]);
  assert.deepEqual(P._internal.subsequence('git-clients', 'gcl'), [[0, 1], [4, 6]]);
  assert.equal(P._internal.subsequence('git', 'gx'), null);
});

test('rank: recent order for no query; name prefix, name substring, shown path, full root, then fuzzy; case-insensitive', () => {
  const P = freshPicker();
  const all = P._internal.rank(RECENT, '   ');
  assert.deepEqual(all.map((x) => x.name), RECENT.map((r) => r.name));
  assert.equal(all[0].path, '~/src/git-clients');
  assert.equal(all[0].title, '~/src/git-clients', 'the tooltip is the full path, home as ~');
  const git = P._internal.rank(RECENT, 'GIT');
  assert.deepEqual(git.map((x) => x.name), ['git-clients', 'gitlab-mirror'], 'name prefixes, recent order');
  assert.deepEqual(git[0].hits, { name: [[0, 3]], path: [] });
  // "cli": a name substring (git-clients) before a path-only match (web, under ~/clients)
  const cli = P._internal.rank(RECENT, 'cli');
  assert.deepEqual(cli.map((x) => x.name), ['git-clients', 'web']);
  assert.deepEqual(cli[1].hits, { name: [], path: [[2, 5]] }, 'highlighted in the shown path ~/clients/web');
  assert.deepEqual(P._internal.rank(RECENT, '/users/ada/work').map((x) => [x.name, x.hits.path.length]), [['api-server', 0]], 'the full root matches too (nothing to highlight)');
  const fz = P._internal.rank(RECENT, 'gtc');
  assert.deepEqual(fz.map((x) => x.name), ['git-clients'], 'letters in order');
  assert.deepEqual(fz[0].hits.name, [[0, 1], [2, 3], [4, 5]]);
  assert.deepEqual(P._internal.rank(RECENT, 'zzz'), []);
  assert.deepEqual(P._internal.rank(null, 'x'), []);
});

test('rank: current and open-in-another-tab flags; otherTabs by this tab id, else the active tab', () => {
  const P = freshPicker();
  const tabs = [
    { id: 1, title: 'git-clients', root: RECENT[0].root, active: true },
    { id: 2, title: 'noodle', root: RECENT[1].root, active: false },
    { id: 3, title: 'New Tab', root: null, active: false },
  ];
  const other = P._internal.otherTabs({ tabs, tabId: null });
  assert.deepEqual([...other.keys()], [RECENT[1].root], 'no id: every tab but the active one');
  assert.deepEqual([...P._internal.otherTabs({ tabs, tabId: 2 }).keys()], [RECENT[0].root], 'this tab (2) is in the background');
  assert.equal(P._internal.otherTabs({}).size, 0);
  const items = P._internal.rank(RECENT, '', { current: RECENT[0].root, tabs: other });
  assert.deepEqual(items.slice(0, 3).map((x) => [x.current, x.tab && x.tab.id]), [[true, null], [false, 2], [false, null]]);
});

test('rank: names and paths are display-safe (bidi controls escaped)', () => {
  const P = freshPicker();
  const [it] = P._internal.rank([{ root: '/x/evil\u202Egnp.js', name: 'evil\u202Egnp.js' }], '');
  assert.equal(it.name, 'evil\\u{202E}gnp.js');
  assert.equal(it.path, '/x/evil\\u{202E}gnp.js');
});

// ------------------------------------------------------------------ start screen (New Tab)

test('start screen: title, the whole recent list in #recent-list, search focused, Open… (⌘O); no ⌘T hint without tabs', (tc) => {
  const t = setup(tc);
  const s = start(t);
  assert.equal(s.box.querySelector('.start-title').textContent, 'Open a repository');
  assert.deepEqual(names(s.list), RECENT.map((r) => r.name), 'no cap on the start screen');
  const lb = s.box.querySelector('.rp-list');
  assert.equal(lb.id, 'recent-list');
  assert.equal(lb.getAttribute('role'), 'listbox');
  assert.equal(t.dom.doc.activeElement, s.list.input);
  assert.equal(s.list.input.placeholder, 'Search');
  assert.equal(s.list.input.getAttribute('aria-controls'), 'recent-list');
  assert.equal(s.box.querySelector('.rp-label').textContent, 'Recently opened');
  const first = lb.querySelectorAll('.rp-item')[0];
  assert.equal(first.getAttribute('role'), 'option');
  assert.equal(first.title, '~/src/git-clients');
  assert.equal(s.list.input.getAttribute('aria-activedescendant'), first.id);
  assert.equal(first.getAttribute('aria-selected'), 'true');
  const open = s.box.querySelector('.start-open');
  assert.match(open.textContent, t.IS_MAC ? /^Open…⌘O$/ : /^Open…Ctrl\+O$/);
  assert.equal(s.box.querySelector('.start-hint').hidden, true, 'no tabs: no ⌘T hint');
  assert.equal(s.box.querySelectorAll('.rp-newtab').length, 0, 'no tabs: no new-tab buttons');
  assert.equal(s.box.querySelector('.rp-footer'), null);
  s.dispose();
  assert.equal(s.box.children.length, 0);
});

test('start screen: typing filters (highlighted), empty result says so, Esc clears the search', (tc) => {
  const t = setup(tc);
  const s = start(t);
  type(t, s.list, 'cli');
  assert.deepEqual(names(s.list), ['git-clients', 'web']);
  const rows = s.list.root.querySelectorAll('.rp-item');
  assert.deepEqual(marks(rows[0]), ['cli']);
  assert.deepEqual(marks(rows[1]), ['cli'], 'the path match of ~/clients/web');
  assert.equal(s.list.root.querySelector('.rp-label').textContent, 'Matching repositories');
  assert.equal(activeRow(s.list), rows[0], 'the best match is active');
  type(t, s.list, 'nope');
  assert.deepEqual(names(s.list), []);
  const empty = s.list.root.querySelector('.rp-empty');
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, 'No recent repository matches “nope”');
  assert.equal(s.list.input.getAttribute('aria-activedescendant'), null);
  const e = t.dom.key('Escape', {}, s.list.input);
  assert.equal(e.defaultPrevented, true);
  assert.equal(s.list.input.value, '');
  assert.equal(names(s.list).length, RECENT.length);
  const again = t.dom.key('Escape', {}, s.list.input);
  assert.equal(again.defaultPrevented, false, 'nothing to clear: Esc is left alone');
  // Enter with no match does nothing
  type(t, s.list, 'nope');
  t.dom.key('Enter', {}, s.list.input);
  assert.deepEqual(t.calls, []);
});

test('start screen: ↑ / ↓ wrap, Home / End, mouse hover moves the active option; Enter opens it in this tab', async (tc) => {
  const t = setup(tc);
  const s = start(t);
  const id = () => s.list.input.getAttribute('aria-activedescendant');
  const rows = () => s.list.root.querySelectorAll('.rp-item');
  t.dom.key('ArrowDown', {}, s.list.input);
  assert.equal(id(), rows()[1].id);
  t.dom.key('ArrowUp', {}, s.list.input);
  t.dom.key('ArrowUp', {}, s.list.input);
  assert.equal(id(), rows()[RECENT.length - 1].id, 'wraps to the end');
  t.dom.key('ArrowDown', {}, s.list.input);
  assert.equal(id(), rows()[0].id, 'and back');
  t.dom.key('End', {}, s.list.input);
  assert.equal(activeRow(s.list), rows()[RECENT.length - 1]);
  const shiftHome = t.dom.key('Home', { shiftKey: true }, s.list.input);
  assert.equal(shiftHome.defaultPrevented, false, '⇧Home selects text in the field');
  t.dom.key('Home', {}, s.list.input);
  assert.equal(activeRow(s.list), rows()[0]);
  assert.equal(rows().filter((r) => r.getAttribute('aria-selected') === 'true').length, 1);
  t.dom.dispatch(rows()[2], 'mousemove');
  assert.equal(activeRow(s.list), rows()[2]);
  const e = t.dom.key('Enter', {}, s.list.input);
  assert.equal(e.defaultPrevented, true);
  assert.equal(e.stopped, true, 'the page shortcuts (⌘↵ commit) never see it');
  t.dom.key('Enter', { repeat: true }, s.list.input);
  await H.flush();
  assert.deepEqual(t.calls, [['openRecent', RECENT[2].root]], 'one arg: replace this tab; a held Enter opens once');
});

test('start screen with tabs: ⌘↵, ⌘-click and the row button open a new tab; click opens here; ⌘T hint; ⌘-click Open…', async (tc) => {
  const t = setup(tc, { tabs: true });
  const s = start(t);
  assert.equal(s.box.querySelector('.start-hint').hidden, false);
  assert.match(s.box.querySelector('.start-hint').textContent, /T opens another tab$/);
  t.dom.key('Enter', t.mod, s.list.input);
  const rows = s.list.root.querySelectorAll('.rp-item');
  t.dom.dispatch(rows[1], 'click', t.mod);
  t.dom.dispatch(rows[2], 'click');
  const nt = rows[3].querySelector('.rp-newtab');
  assert.equal(nt.getAttribute('aria-label'), 'Open web in a new tab');
  assert.equal(nt.tabIndex, -1, 'not a Tab stop (the list is one)');
  t.dom.dispatch(nt, 'click');
  s.box.querySelector('.start-open').click();
  t.dom.dispatch(s.box.querySelector('.start-open'), 'click', t.mod);
  await H.flush();
  assert.deepEqual(t.calls, [
    ['openRecent', RECENT[0].root, { newTab: true }],
    ['openRecent', RECENT[1].root, { newTab: true }],
    ['openRecent', RECENT[2].root],
    ['openRecent', RECENT[3].root, { newTab: true }],
    ['openDialog'],
    ['openDialog', { newTab: true }],
  ]);
});

test('without window.api.tabs: ⌘↵ and ⌘-click open in this tab, and the bridge gets no options', async (tc) => {
  const t = setup(tc, { tabs: false });
  assert.equal(t.P.tabsAvailable(), false);
  const s = start(t);
  t.dom.key('Enter', t.mod, s.list.input);
  t.dom.dispatch(s.list.root.querySelectorAll('.rp-item')[1], 'click', t.mod);
  t.dom.dispatch(s.box.querySelector('.start-open'), 'click', t.mod);
  await H.flush();
  assert.deepEqual(t.calls, [['openRecent', RECENT[0].root], ['openRecent', RECENT[1].root], ['openDialog']]);
});

test('open in another tab: the badge follows tabs-changed; with tabs.activate choosing it switches there', async (tc) => {
  const t = setup(tc, { tabs: true, activate: true });
  const s = start(t);
  const badges = () => s.list.root.querySelectorAll('.rp-item').map((li) => (li.querySelector('.rp-badge-tab') ? li.querySelector('.rp-name').textContent : null)).filter(Boolean);
  assert.deepEqual(badges(), []);
  t.P.source.set({ tabs: [{ id: 7, title: 'noodle', root: RECENT[1].root, active: false }, { id: 8, title: 'New Tab', root: null, active: true }] });
  assert.deepEqual(badges(), ['noodle']);
  const row = s.list.root.querySelectorAll('.rp-item')[1];
  assert.equal(row.querySelector('.rp-badge-tab').textContent, 'open in tab');
  assert.equal(row.getAttribute('aria-description'), 'open in another tab');
  t.dom.dispatch(row, 'click');
  t.dom.dispatch(row, 'click', t.mod);
  await H.flush();
  assert.deepEqual(t.calls, [['activate', 7], ['openRecent', RECENT[1].root, { newTab: true }]]);
});

test('open in another tab without tabs.activate (the contract only): a click opens it here', async (tc) => {
  const t = setup(tc, { tabs: true });
  t.P.source.set({ tabs: [{ id: 7, root: RECENT[1].root, active: false }], tabId: 8 });
  const s = start(t);
  t.dom.dispatch(s.list.root.querySelectorAll('.rp-item')[1], 'click');
  await H.flush();
  assert.deepEqual(t.calls, [['openRecent', RECENT[1].root]]);
});

test('an open that fails goes to onError as an Error; an empty recent list says so', async (tc) => {
  const t = setup(tc, { fail: 'Not a git repository', recent: [] });
  const s = start(t);
  assert.equal(s.list.root.querySelector('.rp-empty').textContent, 'No recent repositories yet.');
  assert.equal(s.list.root.querySelector('.rp-list').hidden, true);
  s.box.querySelector('.start-open').click();
  t.P.source.set({ recent: RECENT });
  assert.equal(s.list.root.querySelector('.rp-empty').hidden, true, 'recent-changed re-renders');
  t.dom.key('Enter', {}, s.list.input);
  await H.flush();
  assert.equal(s.errors.length, 2);
  assert.ok(s.errors.every((e) => e instanceof Error && e.message === 'Not a git repository' && e.kind === 'not-a-repo'));
});

// ------------------------------------------------------------------ popover

/** An anchor button on the body, and the popover opened under it. */
function popover(t, opts = {}) {
  const anchor = t.dom.doc.createElement('button');
  t.dom.doc.body.append(anchor);
  anchor.focus();
  const closed = [];
  const pop = t.P.open(anchor, { onClose: () => closed.push(1), ...opts });
  const list = { root: pop, input: pop.querySelector('.rp-input') };
  return { anchor, pop, list, closed };
}

test('popover: a modal dialog with the search focused, the current repo marked, capped at CAP with View all', (tc) => {
  const t = setup(tc);
  t.P.source.set({ current: RECENT[0].root });
  const p = popover(t);
  assert.equal(p.pop.getAttribute('role'), 'dialog');
  assert.equal(p.pop.getAttribute('aria-modal'), 'true');
  assert.equal(t.win.Components.util.modalOpen(), true, 'page shortcuts stand down while it is open');
  assert.equal(t.P.isOpen(), true);
  assert.equal(t.dom.doc.activeElement, p.list.input);
  assert.equal(names(p.list).length, t.P._internal.CAP);
  const cur = p.pop.querySelector('.rp-item.is-current');
  assert.equal(cur.querySelector('.rp-name').textContent, 'git-clients');
  assert.equal(cur.querySelector('.rp-badge-current').textContent, 'current');
  const all = p.pop.querySelector('.rp-all');
  assert.equal(all.hidden, false);
  assert.equal(all.textContent, 'View all repositories');
  all.click();
  assert.equal(names(p.list).length, RECENT.length);
  assert.equal(all.hidden, true, 'nothing more to show');
  assert.equal(t.dom.doc.activeElement, p.list.input);
  // a search always looks through every recent repo
  t.P.close();
  const q = popover(t);
  type(t, q.list, 'game');
  assert.deepEqual(names(q.list), ['game'], 'the 8th entry, past the cap');
  assert.equal(q.pop.querySelector('.rp-all').hidden, true);
});

test('popover: Esc closes and gives focus back; Enter on the current repo just closes; choosing closes', async (tc) => {
  const t = setup(tc, { tabs: true });
  t.P.source.set({ current: RECENT[0].root });
  const p = popover(t);
  const e = t.dom.key('Escape', {}, p.list.input);
  assert.equal(e.defaultPrevented, true);
  assert.equal(t.P.isOpen(), false);
  assert.equal(p.pop.isConnected, false);
  assert.equal(t.dom.doc.activeElement, p.anchor);
  assert.equal(p.closed.length, 1);
  const q = popover(t);
  t.dom.key('Enter', {}, q.list.input); // the current repo
  assert.equal(t.P.isOpen(), false);
  const r = popover(t);
  t.dom.key('ArrowDown', {}, r.list.input);
  t.dom.key('Enter', t.mod, r.list.input);
  assert.equal(t.P.isOpen(), false);
  await H.flush();
  assert.deepEqual(t.calls, [['openRecent', RECENT[1].root, { newTab: true }]]);
});

test('popover: an outside press closes it; a press on the anchor closes it and swallows the click (toggle); window blur closes it', (tc) => {
  const t = setup(tc);
  const p = popover(t);
  const inside = p.pop.querySelector('.rp-label');
  t.dom.dispatch(inside, 'mousedown');
  assert.equal(t.P.isOpen(), true, 'a press inside keeps it');
  const other = t.dom.doc.createElement('div');
  t.dom.doc.body.append(other);
  t.dom.dispatch(other, 'mousedown');
  assert.equal(t.P.isOpen(), false);
  assert.equal(p.closed.length, 1);

  const q = popover(t);
  let clicks = 0;
  q.anchor.addEventListener('click', () => { clicks++; });
  t.dom.dispatch(q.anchor, 'mousedown');
  assert.equal(t.P.isOpen(), false);
  const c = t.dom.dispatch(q.anchor, 'click');
  assert.equal(c.defaultPrevented, true);
  assert.equal(clicks, 0, 'the click after the press does not reopen it');

  popover(t);
  for (const l of [...t.dom.win.__l]) if (l.type === 'blur') l.fn({ type: 'blur' });
  assert.equal(t.P.isOpen(), false);
  assert.equal(t.dom.win.__l.filter((l) => l.type === 'blur' || l.type === 'resize').length, 0, 'listeners released');
  assert.equal(t.dom.doc.__l.filter((l) => l.type === 'mousedown').length, 0);
});

test('popover: Tab / ⇧Tab cycle between the search, Open… and View all; other keys stay inside', (tc) => {
  const t = setup(tc);
  const p = popover(t);
  const open = p.pop.querySelector('.rp-open');
  const all = p.pop.querySelector('.rp-all');
  t.dom.key('Tab', {}, p.list.input);
  assert.equal(t.dom.doc.activeElement, open);
  t.dom.key('Tab', {}, open);
  assert.equal(t.dom.doc.activeElement, all);
  t.dom.key('Tab', {}, all);
  assert.equal(t.dom.doc.activeElement, p.list.input, 'wraps');
  t.dom.key('Tab', { shiftKey: true }, p.list.input);
  assert.equal(t.dom.doc.activeElement, all);
  all.click(); // View all: its button goes away, the cycle is search <-> Open…
  t.dom.key('Tab', { shiftKey: true }, p.list.input);
  assert.equal(t.dom.doc.activeElement, open);
  let reached = 0;
  t.dom.doc.addEventListener('keydown', () => { reached++; });
  t.dom.key('j', {}, p.list.input);
  t.dom.key('l', t.mod, p.list.input);
  assert.equal(reached, 0, 'j / ⌘L never reach the page');
  assert.equal(t.P.isOpen(), true);
});

test('popover: Open… and ⌘O run the folder dialog (⌘-click: a new tab) and close; ⌘P closes', async (tc) => {
  const t = setup(tc, { tabs: true });
  let p = popover(t);
  const open = p.pop.querySelector('.rp-open');
  assert.match(open.textContent, t.IS_MAC ? /Open…⌘O/ : /Open…Ctrl\+O/);
  open.click();
  assert.equal(t.P.isOpen(), false);
  p = popover(t);
  t.dom.dispatch(p.pop.querySelector('.rp-open'), 'click', t.mod);
  p = popover(t);
  t.dom.key('o', t.mod, p.list.input);
  assert.equal(t.P.isOpen(), false);
  p = popover(t);
  t.dom.key('p', t.mod, p.list.input);
  assert.equal(t.P.isOpen(), false);
  assert.equal(t.dom.doc.activeElement, p.anchor);
  await H.flush();
  assert.deepEqual(t.calls, [['openDialog'], ['openDialog', { newTab: true }], ['openDialog']]);
});

test('popover: a recent-changed while open re-renders and keeps the active repo', (tc) => {
  const t = setup(tc);
  const p = popover(t);
  t.dom.key('ArrowDown', {}, p.list.input);
  assert.equal(activeRow(p.list).dataset.root, RECENT[1].root);
  t.P.source.set({ recent: [RECENT[5], RECENT[1], RECENT[0]] });
  assert.deepEqual(names(p.list), ['notes', 'noodle', 'git-clients']);
  assert.equal(activeRow(p.list).dataset.root, RECENT[1].root);
});

test('popover: a second open closes the first', (tc) => {
  const t = setup(tc);
  const a = popover(t);
  const b = popover(t);
  assert.equal(a.pop.isConnected, false);
  assert.equal(a.closed.length, 1);
  assert.equal(b.pop.isConnected, true);
  assert.equal(t.dom.doc.body.querySelectorAll('.rp-pop').length, 1);
});

// ------------------------------------------------------------------ toolbar breadcrumb

async function mountToolbar(tc, { picker = true } = {}) {
  const loaded = await H.loadedStore(H.repoData({ commits: H.chain(['aaaaaaa1']) }), { repo: { root: '/Users/ada/src/git-clients', name: 'git-clients' } });
  const t = setup(tc, { store: loaded });
  if (!picker) delete t.win.PLRepoPicker;
  t.win.PLFlows = {};
  const root = t.dom.doc.createElement('header');
  root.dataset.component = 'toolbar';
  t.dom.doc.body.append(root);
  const unmount = t.win.Components.mountAll({ querySelectorAll: () => [root], contains: (n) => n === root }, loaded.store);
  tc.after(() => unmount());
  const toasts = [];
  loaded.store.actions.toast = (e) => toasts.push(e);
  return { ...t, root, store: loaded.store, toasts, stack: root.querySelector('.tb-repo'), unmount };
}

test('toolbar: repository › branch breadcrumb; the repository stack toggles the picker (aria-expanded, ▴)', async (tc) => {
  const t = await mountToolbar(tc);
  const b = t.stack;
  assert.equal(b.dataset.action, 'repoPicker');
  assert.equal(b.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(b.getAttribute('aria-expanded'), 'false');
  assert.equal(b.querySelector('.tb-stack-label').textContent, 'repository');
  assert.equal(b.querySelector('.tb-stack-text').textContent, 'git-clients');
  assert.equal(b.title, `~/src/git-clients\nSwitch or open a repository (${t.IS_MAC ? '⌘P' : 'Ctrl+P'})`);
  const left = t.root.querySelector('.tb-left');
  const cls = (c) => c.className || c.getAttribute('class') || '';
  assert.deepEqual(left.children.map(cls), ['tb-stack tb-repo', 'tb-pill muted tb-wt-chip', 'icon icon-chevron-right tb-crumb-sep', 'tb-stack tb-branch', 'tb-pills'],
    'repository (+ the linked-worktree chip, hidden here) › branch, then the ahead / behind pills');
  assert.equal(left.children[1].hidden, true, 'not a linked worktree: no chip');
  assert.equal(t.root.querySelector('.tb-open'), null, 'Open… moved into the picker');
  b.click();
  assert.equal(t.P.isOpen(), true);
  assert.equal(b.getAttribute('aria-expanded'), 'true');
  assert.ok(b.classList.contains('is-open'));
  b.click();
  assert.equal(t.P.isOpen(), false);
  assert.equal(b.getAttribute('aria-expanded'), 'false');
  b.focus(); // a clicked button has focus
  b.click();
  t.dom.key('Escape', {}, t.dom.doc.activeElement);
  assert.equal(b.classList.contains('is-open'), false, 'Esc resets the chevron');
  assert.equal(t.dom.doc.activeElement, b);
  b.click();
  t.unmount();
  assert.equal(t.P.isOpen(), false, 'unmount closes it');
});

test('toolbar: PLRepoPicker.toggle (app.js\' ⌘P) runs the repository stack\'s toggle while the toolbar is mounted', async (tc) => {
  const t = await mountToolbar(tc);
  assert.equal(t.P.toggle(), true);
  assert.equal(t.P.isOpen(), true);
  assert.equal(t.stack.getAttribute('aria-expanded'), 'true', 'as a click on the stack');
  assert.equal(t.P.toggle(), true);
  assert.equal(t.P.isOpen(), false);
  assert.equal(t.stack.getAttribute('aria-expanded'), 'false');
  t.unmount();
  assert.equal(t.P.toggle(), false, 'no toolbar: nothing to toggle');
  assert.equal(t.P.isOpen(), false);
});

test('toolbar: a failed open from the picker is toasted; without PLRepoPicker the stack runs the folder dialog', async (tc) => {
  const t = await mountToolbar(tc);
  t.win.api.app.openRecent = () => Promise.reject({ message: 'gone', kind: 'not-found' });
  t.stack.click();
  const input = t.dom.doc.activeElement;
  t.dom.key('ArrowDown', {}, input);
  t.dom.key('Enter', {}, input);
  await H.flush();
  assert.deepEqual(t.toasts.map((e) => [e.message, e instanceof Error]), [['gone', true]]);

  const u = await mountToolbar(tc, { picker: false });
  u.stack.click();
  await H.flush();
  assert.deepEqual(u.calls, [['openDialog']]);
  assert.match(u.stack.title, /Switch or open a repository \((⌘O|Ctrl\+O)\)$/);
});
