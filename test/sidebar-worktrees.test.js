'use strict';
// The sidebar's Worktrees section: the pure row model (labels, folder names, icons, badges, titles,
// the filter and counts), rowTarget / double-click / context menu of a worktree row, and the mounted
// section (dirty dots read only while it is open, Enter / double-click open, keyboard and
// multi-selection of local branches still working). Setup patterns follow sidebar-actions.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const ACTIONS = require.resolve('../renderer/actions.js');
const SHA = (c) => c.repeat(40);

/** Load actions.js + a component script into `win` (index.html order) and return the component's exports. */
function loadInto(win, file) {
  delete require.cache[ACTIONS];
  const A = require(ACTIONS);
  const p = require.resolve(`../renderer/components/${file}`);
  delete require.cache[p];
  return { A, mod: require(p) };
}

function loadSidebar() {
  const win = H.loadRenderer();
  return { win, ...loadInto(win, 'sidebar.js') };
}

const FLOW_NAMES = ['checkout', 'deleteBranches', 'stashApply', 'openWorktree', 'revealWorktree', 'copyWorktreePath',
  'lockWorktree', 'unlockWorktree', 'removeWorktree', 'pruneWorktrees'];

/** Fake PLFlows: records every call as [name, store, ...args] and resolves true. */
function fakeFlows() {
  const calls = [];
  const flows = { calls };
  for (const n of FLOW_NAMES) flows[n] = async (store, ...args) => { calls.push([n, store, ...args]); return true; };
  return flows;
}
const calls = (flows) => flows.calls.map(([n, , ...a]) => [n, ...a]);
const labels = (items) => items.map((d) => (d.separator ? '---' : d.label));
const byLabel = (items, label) => items.find((d) => d.label === label);

const wt = (o) => ({
  head: SHA('a'), branch: null, bare: false, detached: false, locked: false, lockReason: null,
  prunable: false, prunableReason: null, main: false, current: false, ...o,
});

const WT = {
  main: wt({ path: '/r', branch: 'main', main: true, current: true }),
  feat: wt({ path: '/w/feat-x', head: SHA('b'), branch: 'feat/x' }),
  det: wt({ path: '/w/detached', head: SHA('c'), detached: true }),
  locked: wt({ path: '/w/usb', head: SHA('b'), branch: 'usb', locked: true, lockReason: 'on a USB drive' }),
  gone: wt({ path: '/w/gone', head: SHA('b'), branch: 'old', prunable: true, prunableReason: 'gitdir file points to non-existent location' }),
};
const WTS = [WT.main, WT.feat, WT.det, WT.locked, WT.gone];

const REFS = () => H.refs({
  head: { branch: 'main', oid: SHA('a'), detached: false },
  local: [
    { name: 'main', oid: SHA('a'), upstream: null, ahead: 0, behind: 0, gone: false, current: true },
    { name: 'feat/x', oid: SHA('b'), upstream: null, ahead: 0, behind: 0, gone: false, current: false },
    { name: 'usb', oid: SHA('b'), upstream: null, ahead: 0, behind: 0, gone: false, current: false },
  ],
  remote: [],
  tags: [],
});

const wtSection = (model) => model.sections.find((s) => s.id === 'worktrees');
const rowOf = (model, path) => wtSection(model).rows.find((r) => r.key === `worktree:${path}`);

// ------------------------------------------------------------------ model (pure)

test('sidebarModel: a Worktrees section last, one row per worktree in git\'s order, labelled by branch with the folder name', () => {
  const { mod: { sidebarModel } } = loadSidebar();
  const m = sidebarModel({ refs: REFS(), stashes: [], worktrees: WTS, worktreeDirty: {}, currentDirty: false });
  const sec = m.sections.at(-1);
  assert.deepEqual([sec.id, sec.title, sec.icon, sec.open, sec.count], ['worktrees', 'Worktrees', 'worktree', true, 5]);
  assert.deepEqual(sec.rows.map((r) => r.key), WTS.map((w) => `worktree:${w.path}`), 'git\'s order, main first');
  assert.deepEqual(sec.rows.map((r) => [r.label, r.sub]), [
    ['main', 'r'], ['feat/x', 'feat-x'], ['ccccccc', 'detached'], ['usb', ''], ['old', 'gone'],
  ], 'the folder name is left out when it equals the label');
  assert.ok(sec.rows.every((r) => r.kind === 'worktree' && r.level === 0 && r.sha === null));
});

test('sidebarModel: worktree rows: current (home icon, highlighted), main, detached, locked, missing, bare and unborn', () => {
  const { mod: { sidebarModel } } = loadSidebar();
  const bare = wt({ path: '/srv/r.git', head: null, bare: true, main: true });
  const unborn = wt({ path: '/w/new', head: null, branch: null });
  const m = sidebarModel({ refs: REFS(), stashes: [], worktrees: [...WTS, bare, unborn], worktreeDirty: {}, currentDirty: false });

  const main = rowOf(m, '/r');
  assert.deepEqual([main.icon, main.cls], ['home', 'current']);
  assert.deepEqual(main.badges, [{ cls: 'sb-note sb-wt-main', text: 'main' }]);
  assert.equal(main.title, '/r\nBranch main\nMain worktree\nOpen in this tab');

  const feat = rowOf(m, '/w/feat-x');
  assert.deepEqual([feat.icon, feat.cls, feat.badges], ['worktree', '', []]);
  assert.equal(feat.title, '/w/feat-x\nBranch feat/x');

  const det = rowOf(m, '/w/detached');
  assert.deepEqual([det.icon, det.cls], ['detached', 'detached']);
  assert.equal(det.title, `/w/detached\nDetached HEAD at ${SHA('c').slice(0, 7)}`);

  const locked = rowOf(m, '/w/usb');
  assert.deepEqual(locked.badges, [{ cls: 'sb-wt-locked', icon: 'lock', text: '' }]);
  assert.equal(locked.title, '/w/usb\nBranch usb\nLocked: on a USB drive');

  const gone = rowOf(m, '/w/gone');
  assert.equal(gone.cls, 'sb-wt-prunable');
  assert.deepEqual(gone.badges, [{ cls: 'sb-gone', text: 'missing' }]);
  assert.match(gone.title, /\nFolder missing: gitdir file points to non-existent location$/);

  const b = rowOf(m, '/srv/r.git');
  assert.deepEqual([b.label, b.sub, b.icon, b.cls], ['bare repository', 'r.git', 'worktree', '']);
  assert.equal(b.title, '/srv/r.git\nBare repository\nThe repository itself');

  const u = rowOf(m, '/w/new');
  assert.deepEqual([u.label, u.title], ['no commits', '/w/new\nNo commits yet']);

  // missing (git never marks a locked worktree prunable): the missing badge after its lock
  const away = rowOf(sidebarModel({ worktrees: [wt({ path: '/w/away', branch: 'away', locked: true, lockReason: 'usb', missing: true })] }), '/w/away');
  assert.equal(away.cls, 'sb-wt-prunable');
  assert.deepEqual(away.badges, [{ cls: 'sb-wt-locked', icon: 'lock', text: '' }, { cls: 'sb-gone', text: 'missing' }]);
  assert.equal(away.title, '/w/away\nBranch away\nLocked: usb\nFolder missing');

  // a current detached worktree keeps the home icon; locked without a reason
  const m2 = sidebarModel({ worktrees: [wt({ path: '/d', current: true, locked: true })] });
  assert.deepEqual([rowOf(m2, '/d').icon, rowOf(m2, '/d').cls], ['home', 'current detached']);
  assert.match(rowOf(m2, '/d').title, /\nLocked$/);
});

test('sidebarModel: the dirty dot: the current worktree from currentDirty, the others from worktreeDirty (true only)', () => {
  const { mod: { sidebarModel } } = loadSidebar();
  const dot = { cls: 'sb-dirty', text: '●' };
  const dirtyOf = (m, p) => rowOf(m, p).badges.some((x) => x.cls === 'sb-dirty');
  const m = sidebarModel({ worktrees: WTS, worktreeDirty: { '/w/feat-x': true, '/w/detached': null, '/w/usb': false }, currentDirty: true });
  assert.deepEqual(rowOf(m, '/r').badges.at(-1), dot);
  assert.match(rowOf(m, '/r').title, /\nHas uncommitted changes$/);
  assert.deepEqual(rowOf(m, '/w/feat-x').badges, [dot]);
  assert.equal(dirtyOf(m, '/w/detached'), false, 'null (unknown) shows no dot');
  assert.equal(dirtyOf(m, '/w/usb'), false);
  const clean = sidebarModel({ worktrees: WTS, worktreeDirty: null, currentDirty: false });
  assert.ok(WTS.every((w) => !dirtyOf(clean, w.path)), 'not read yet: no dots');
  const m3 = sidebarModel({ worktrees: WTS, worktreeDirty: { '/r': true }, currentDirty: false });
  assert.equal(dirtyOf(m3, '/r'), false, 'the current one never reads worktreeDirty');
});

test('sidebarModel: the filter matches branch, folder name or short head; counts and the "Viewing" totals include worktrees', () => {
  const { mod: { sidebarModel } } = loadSidebar();
  const data = { refs: REFS(), stashes: [], worktrees: WTS };
  const keys = (filter) => wtSection(sidebarModel(data, { filter })).rows.map((r) => r.key.slice('worktree:'.length));
  assert.deepEqual(keys('feat'), ['/w/feat-x'], 'branch and folder name');
  assert.deepEqual(keys('feat-x'), ['/w/feat-x'], 'folder name');
  assert.deepEqual(keys('gone'), ['/w/gone'], 'folder name (its branch is old)');
  assert.deepEqual(keys('/w/'), [], 'not the parent folders of the path');
  assert.deepEqual(keys('w'), [], 'a parent folder name alone matches nothing');
  assert.deepEqual(keys('ccccccc'), ['/w/detached'], 'short head');
  assert.deepEqual(keys(SHA('c')), [], 'not the full head');
  assert.deepEqual(keys('usb'), ['/w/usb']);

  const m = sidebarModel(data, { filter: 'usb' });
  assert.equal(wtSection(m).count, 1);
  assert.equal(m.summary, 'Viewing 2 of 8', 'local usb + its worktree, of 3 branches + 5 worktrees');
  const none = sidebarModel(data, { filter: 'zzz' });
  assert.deepEqual([wtSection(none).count, wtSection(none).emptyText], [0, 'No matches']);
  assert.equal(sidebarModel(data).summary, '');
});

test('sidebarModel: "Reading worktrees…" before the first read, "No worktrees" for an empty list; collapsed sections keep their rows out', () => {
  const { mod: { sidebarModel } } = loadSidebar();
  assert.deepEqual([wtSection(sidebarModel({ worktrees: null })).emptyText, wtSection(sidebarModel({ worktrees: null })).count], ['Reading worktrees…', 0]);
  assert.equal(wtSection(sidebarModel({})).emptyText, 'Reading worktrees…');
  assert.equal(wtSection(sidebarModel({ worktrees: [] })).emptyText, 'No worktrees');
  assert.equal(wtSection(sidebarModel({ worktrees: WTS }, { collapsedSections: { worktrees: true } })).open, false);
});

// ------------------------------------------------------------------ actions (pure)

test('rowTarget: a worktree row resolves to the state.worktrees entry with exactly that path', () => {
  const { mod: { rowTarget } } = loadSidebar();
  const s = { worktrees: [...WTS, wt({ path: 'C:\\w\\a:b', branch: 'colon' })] };
  assert.deepEqual(rowTarget('worktree:/w/feat-x', s), { kind: 'worktree', entry: WT.feat });
  assert.equal(rowTarget('worktree:C:\\w\\a:b', s).entry.branch, 'colon', 'paths with ":" survive');
  for (const k of ['worktree:/w/feat-x/', 'worktree:/W/feat-x', 'worktree:', 'worktree:feat-x']) assert.equal(rowTarget(k, s), null, k);
  assert.equal(rowTarget('worktree:/r', { worktrees: null }), null);
});

test('doubleClickAction: a worktree opens with openWorktree (also while busy) unless worktreeRefusal refuses opening it', () => {
  const { mod: { rowTarget, doubleClickAction } } = loadSidebar();
  const bare = wt({ path: '/srv/r.git', head: null, bare: true, main: true });
  const s = { busy: false, worktrees: [...WTS, bare] };
  const dbl = (p, st = s) => doubleClickAction(rowTarget(`worktree:${p}`, st), st);
  assert.deepEqual(dbl('/w/feat-x'), { flow: 'openWorktree', args: ['/w/feat-x'] });
  assert.deepEqual(dbl('/w/usb'), { flow: 'openWorktree', args: ['/w/usb'] }, 'locked ones open');
  assert.deepEqual(dbl('/w/detached', { ...s, busy: true }), { flow: 'openWorktree', args: ['/w/detached'] }, 'a free flow');
  for (const p of ['/r', '/w/gone', '/srv/r.git']) assert.equal(dbl(p), null, p);
  // a bare repository's linked worktrees open too (the bare banner's way)
  const bareState = { ...s, repo: { root: '/srv/r.git', bare: true }, worktrees: [{ ...bare, current: true }, WT.feat] };
  assert.deepEqual(dbl('/w/feat-x', bareState), { flow: 'openWorktree', args: ['/w/feat-x'] });
  // branches: still nothing while busy
  const refState = { busy: true, refs: REFS() };
  assert.equal(doubleClickAction(rowTarget('local:feat/x', refState), refState), null);
});

test('targetMenuItems: a worktree row gets Components.actions.worktreeMenuItems', () => {
  const { A, mod: { rowTarget, targetMenuItems } } = loadSidebar();
  const s = { busy: false, worktrees: WTS };
  const flows = fakeFlows();
  for (const w of WTS) {
    const items = targetMenuItems(rowTarget(`worktree:${w.path}`, s), s, flows);
    assert.deepEqual(items, A.worktreeMenuItems(w, s, flows), w.path);
  }
  const items = targetMenuItems(rowTarget('worktree:/w/feat-x', s), s, flows);
  assert.equal(labels(items)[0], 'Open');
  assert.equal(labels(items).at(-1), 'Delete…');
});

// ------------------------------------------------------------------ mounted

function recordingMenu() {
  const opened = [];
  return { opened, api: { open: (anchor, items) => opened.push({ anchor, items }), close() {}, isOpen: () => false } };
}

/**
 * A loaded store with the sidebar mounted on the fake DOM (as sidebar-actions.test.js mounts it), its
 * setWorktreeDirtyWanted calls recorded in `wanted`. The first refresh's `worktrees` read is left
 * pending (answer it with answerWorktrees). `collapsed`: sections stored as collapsed.
 */
async function mountSidebar(tc, { collapsed = {}, data } = {}) {
  const { win, api, store } = await H.loadedStore(data || H.repoData({ commits: H.chain([SHA('a'), SHA('b'), SHA('c')]), status: H.status({ oid: SHA('a') }), refs: REFS(), stashes: [] }));
  const dom = H.componentDom();
  Object.defineProperty(globalThis, 'document', { value: dom.doc, configurable: true, writable: true });
  const ls = H.memoryStorage();
  H.setLocalStorage(ls);
  if (Object.keys(collapsed).length) ls.setItem('pl.sidebar.sections', JSON.stringify(collapsed));
  win.addEventListener = dom.win.addEventListener;
  win.removeEventListener = dom.win.removeEventListener;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  dom.doc.body.dataset.view = 'repo';
  loadInto(win, 'sidebar.js');
  const flows = fakeFlows();
  win.PLFlows = flows;
  const menu = recordingMenu();
  win.Components.menu = menu.api;
  const wanted = [];
  const orig = store.actions.setWorktreeDirtyWanted;
  store.actions.setWorktreeDirtyWanted = (on) => { wanted.push(on); return orig(on); };
  const root = dom.doc.createElement('div');
  root.dataset.component = 'sidebar';
  dom.doc.body.append(root);
  const unmount = win.Components.mountAll({ querySelectorAll: () => [root], contains: (n) => n === root }, store);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; unmount(); } };
  tc.after(dispose);
  const row = (key) => root.querySelectorAll('.sb-item').find((r) => r.dataset.key === key);
  const wrow = (p) => row(`worktree:${p}`);
  const section = () => root.querySelectorAll('.sb-section').find((s) => s.dataset.section === 'worktrees');
  async function answerWorktrees(list = WTS) {
    api.take('worktrees').resolve(list);
    await H.flush();
  }
  return { win, api, store, dom, root, flows, menu, wanted, dispose, row, wrow, section, answerWorktrees };
}

test('mounted sidebar: the Worktrees section reads "Reading worktrees…", then one row per worktree via textContent', async (tc) => {
  const t = await mountSidebar(tc);
  const h = t.section().querySelector('.sb-section-header');
  assert.equal(h.querySelector('.sb-section-title').textContent, 'Worktrees');
  assert.equal(h.querySelector('.sb-count').textContent, '0');
  assert.equal(t.section().querySelector('.sb-empty').textContent, 'Reading worktrees…');

  const odd = wt({ path: '/w/<b>x', branch: 'a\u202eb<i>' });
  await t.answerWorktrees([...WTS, odd]);
  assert.equal(h.isConnected, false, 'the section was rebuilt');
  assert.equal(t.section().querySelector('.sb-count').textContent, '6');
  const r = t.wrow('/w/feat-x');
  assert.equal(r.getAttribute('role'), 'treeitem');
  assert.equal(r.querySelector('.sb-name').textContent, 'feat/x');
  assert.equal(r.querySelector('.sb-sub').textContent, 'feat-x');
  assert.equal(r.title, '/w/feat-x\nBranch feat/x');
  assert.ok(r.classList.contains('sb-worktree'));
  assert.equal(r.querySelector('.sb-icon').children[0].getAttribute('class'), 'icon icon-worktree');
  assert.equal(t.wrow('/r').querySelector('.sb-icon').children[0].getAttribute('class'), 'icon icon-home');
  assert.ok(t.wrow('/r').classList.contains('current'));
  assert.equal(t.wrow('/w/usb').querySelector('.sb-sub'), null, 'no folder name equal to the label');
  const lock = t.wrow('/w/usb').querySelector('.sb-wt-locked');
  assert.equal(lock.children[0].getAttribute('class'), 'icon icon-lock');
  assert.equal(t.wrow('/w/gone').querySelector('.sb-gone').textContent, 'missing');
  assert.ok(t.wrow('/w/gone').classList.contains('sb-wt-prunable'));

  const o = t.wrow('/w/<b>x');
  assert.equal(o.querySelector('.sb-name').textContent, 'a\\u{202E}b<i>', 'display-safe text');
  assert.equal(o.querySelector('.sb-name').children.length, 0, 'text, not markup');
  assert.equal(o.querySelector('.sb-sub').textContent, '<b>x');
  assert.equal(o.querySelector('.sb-sub').children.length, 0);
  assert.equal(t.root.querySelector('.sb-filter-input').getAttribute('aria-label'), 'Filter branches, tags, stashes and worktrees');
});

test('mounted sidebar: the dirty dots are wanted on mount, off when the section is collapsed and on unmount, back on expand', async (tc) => {
  const t = await mountSidebar(tc);
  assert.deepEqual(t.wanted, [true], 'the section starts open');
  await t.answerWorktrees();
  const read = t.api.take('worktreeDirty');
  read.resolve([{ path: '/w/feat-x', dirty: true }, { path: '/w/detached', dirty: false }]);
  await H.flush();
  assert.ok(t.wrow('/w/feat-x').querySelector('.sb-dirty'), 'a worktreeDirty change re-renders');
  assert.equal(t.wrow('/w/feat-x').querySelector('.sb-dirty').textContent, '●');
  assert.match(t.wrow('/w/feat-x').title, /Has uncommitted changes/);
  assert.equal(t.wrow('/w/detached').querySelector('.sb-dirty'), null);

  const header = () => t.section().querySelector('.sb-section-header');
  t.dom.dispatch(header(), 'click');
  assert.deepEqual(t.wanted, [true, false]);
  assert.equal(t.wrow('/w/feat-x'), undefined, 'collapsed');
  header().focus();
  t.dom.key('Enter');
  assert.deepEqual(t.wanted, [true, false, true], 'expanded with the keyboard');
  // another section's toggle leaves it alone
  t.dom.dispatch(t.root.querySelectorAll('.sb-section-header')[0], 'click');
  assert.deepEqual(t.wanted, [true, false, true]);
  t.dispose();
  assert.deepEqual(t.wanted, [true, false, true, false]);
});

test('mounted sidebar: a collapsed Worktrees section never asks for the dirty state', async (tc) => {
  const t = await mountSidebar(tc, { collapsed: { worktrees: true } });
  assert.deepEqual(t.wanted, [false]);
  await t.answerWorktrees();
  assert.equal(t.api.count('worktreeDirty'), 0);
  assert.equal(t.section().querySelector('.sb-section-header').querySelector('.sb-count').textContent, '5');
});

test('mounted sidebar: the current worktree\'s dot follows the working tree (statusKey includes the dirty flag)', async (tc) => {
  const t = await mountSidebar(tc);
  await t.answerWorktrees();
  assert.equal(t.wrow('/r').querySelector('.sb-dirty'), null);
  t.store.set({ status: H.status({ oid: SHA('a'), dirty: true }) });
  assert.ok(t.wrow('/r').querySelector('.sb-dirty'), 'dirty: the dot');
  const before = t.wrow('/r');
  t.store.set({ status: H.status({ oid: SHA('a'), unstaged: [{ path: 'b.txt', status: 'M' }, { path: 'c.txt', status: 'M' }] }) });
  assert.equal(t.wrow('/r'), before, 'still dirty: the DOM is left alone');
  t.store.set({ status: H.status({ oid: SHA('a') }) });
  assert.equal(t.wrow('/r').querySelector('.sb-dirty'), null, 'clean again');
});

test('mounted sidebar: double-click and Enter open a worktree, Space does not; refused ones do nothing; a click selects no commit', async (tc) => {
  const t = await mountSidebar(tc);
  await t.answerWorktrees();
  const sel = t.store.state.selection;
  t.dom.dispatch(t.wrow('/w/feat-x').querySelector('.sb-name'), 'click');
  assert.equal(t.store.state.selection, sel, 'no commit selected');
  assert.equal(t.dom.doc.activeElement, t.wrow('/w/feat-x'));
  t.dom.dispatch(t.wrow('/w/feat-x').querySelector('.sb-name'), 'dblclick');
  t.dom.dispatch(t.wrow('/r'), 'dblclick'); // current: refused
  t.dom.dispatch(t.wrow('/w/gone'), 'dblclick'); // missing: refused
  await H.flush();
  assert.deepEqual(calls(t.flows), [['openWorktree', '/w/feat-x']]);

  t.wrow('/w/detached').focus();
  const e = t.dom.key('Enter');
  assert.equal(e.defaultPrevented, true);
  t.wrow('/w/usb').focus();
  const sp = t.dom.key(' ');
  assert.equal(sp.defaultPrevented, true, 'Space is handled (no page scroll), as on other rows');
  assert.equal(t.dom.doc.activeElement, t.wrow('/w/usb'));
  t.wrow('/r').focus();
  t.dom.key('Enter');
  await H.flush();
  assert.deepEqual(calls(t.flows), [['openWorktree', '/w/feat-x'], ['openWorktree', '/w/detached']], 'Space opens nothing');
  assert.equal(t.dom.doc.activeElement, t.wrow('/r'), 'the focus stays');

  t.store.set({ busy: true });
  t.dom.dispatch(t.wrow('/w/feat-x'), 'dblclick');
  await H.flush();
  assert.equal(t.flows.calls.length, 3, 'openWorktree runs while busy');
});

test('mounted sidebar: right-click / ContextMenu key on a worktree row opens worktreeMenuItems; its items run the flows', async (tc) => {
  const t = await mountSidebar(tc);
  await t.answerWorktrees();
  const e = t.dom.dispatch(t.wrow('/w/feat-x').querySelector('.sb-name'), 'contextmenu', { clientX: 5, clientY: 6 });
  assert.equal(e.defaultPrevented, true);
  const { anchor, items } = t.menu.opened[0];
  assert.deepEqual(anchor, { x: 5, y: 6 });
  const want = t.win.Components.actions.worktreeMenuItems(WT.feat, t.store.state, t.flows);
  assert.deepEqual(labels(items), labels(want));
  assert.equal(t.dom.doc.activeElement, t.wrow('/w/feat-x'));
  byLabel(items, 'Open').action();
  byLabel(items, 'Copy Path').action();
  byLabel(items, 'Delete…').action();
  await H.flush();
  assert.deepEqual(calls(t.flows), [['openWorktree', '/w/feat-x'], ['copyWorktreePath', '/w/feat-x'], ['removeWorktree', '/w/feat-x']]);

  // the current worktree: Open and Delete… are off
  t.wrow('/r').focus();
  t.dom.key('F10', { shiftKey: true });
  const cur = t.menu.opened[1].items;
  assert.equal(t.menu.opened[1].anchor, t.wrow('/r'));
  assert.equal(byLabel(cur, 'Open').disabled, true);
  assert.equal(byLabel(cur, 'Delete…').disabled, true);
});

test('mounted sidebar: arrows walk from local branches into the worktree rows; multi-selection of branches ignores them', async (tc) => {
  const t = await mountSidebar(tc);
  await t.answerWorktrees();
  const mod = t.win.Components.util.IS_MAC ? { metaKey: true } : { ctrlKey: true };
  const selected = () => t.root.querySelectorAll('.sb-row').filter((r) => r.classList.contains('selected')).map((r) => r.dataset.key);
  t.dom.dispatch(t.row('local:feat/x').querySelector('.sb-name'), 'click');
  await H.flush();
  t.dom.dispatch(t.row('local:usb').querySelector('.sb-name'), 'click', mod);
  assert.deepEqual(selected(), ['local:feat/x', 'local:usb']);
  t.dom.dispatch(t.row('local:usb'), 'contextmenu', { clientX: 1, clientY: 1 });
  assert.deepEqual(labels(t.menu.opened.at(-1).items), ['Delete 2 branches']);

  // keyboard: from the last section header down through the worktree rows, and End
  const items = () => t.root.querySelectorAll('.sb-item');
  const wtHeader = t.section().querySelector('.sb-section-header');
  wtHeader.focus();
  t.dom.key('ArrowDown');
  assert.equal(t.dom.doc.activeElement, t.wrow('/r'));
  t.dom.key('ArrowDown');
  assert.equal(t.dom.doc.activeElement, t.wrow('/w/feat-x'));
  assert.equal(t.wrow('/w/feat-x').tabIndex, 0, 'roving tabindex');
  t.dom.key('End');
  assert.equal(t.dom.doc.activeElement, items().at(-1));
  assert.equal(t.dom.doc.activeElement, t.wrow('/w/gone'));
  // Shift+Arrow on a worktree row is plain navigation: the branch selection stays
  t.dom.key('ArrowUp', { shiftKey: true });
  assert.equal(t.dom.doc.activeElement, t.wrow('/w/usb'));
  assert.deepEqual(selected(), ['local:feat/x', 'local:usb']);
  // Space on a worktree row acts like a plain click on it (as Space does on other rows): it opens
  // nothing and ends the multi-selection, back to the row of the selected commit
  t.dom.key(' ');
  assert.deepEqual(selected(), ['local:feat/x']);
  assert.equal(t.flows.calls.length, 0);
  assert.equal(t.dom.doc.activeElement, t.wrow('/w/usb'));

  // a (⌘/Ctrl-)click on a worktree row never joins the selection: like a plain click elsewhere it
  // ends it; no worktree row is ever highlighted
  t.dom.dispatch(t.row('local:feat/x').querySelector('.sb-name'), 'click');
  t.dom.dispatch(t.row('local:usb').querySelector('.sb-name'), 'click', mod);
  assert.deepEqual(selected(), ['local:feat/x', 'local:usb']);
  t.dom.dispatch(t.wrow('/w/feat-x').querySelector('.sb-name'), 'click', mod);
  assert.deepEqual(selected(), ['local:feat/x'], 'the multi-selection ended');
  assert.equal(t.dom.doc.activeElement, t.wrow('/w/feat-x'));
  t.dom.dispatch(t.row('local:usb'), 'contextmenu', { clientX: 1, clientY: 1 });
  assert.notDeepEqual(labels(t.menu.opened.at(-1).items), ['Delete 2 branches']);
});

test('mounted sidebar: the filter narrows the worktree rows and counts them in "Viewing"', async (tc) => {
  const t = await mountSidebar(tc);
  await t.answerWorktrees();
  const input = t.root.querySelector('.sb-filter-input');
  input.value = 'detached';
  t.dom.dispatch(input, 'input');
  assert.deepEqual(t.section().querySelectorAll('.sb-row').map((r) => r.dataset.key), ['worktree:/w/detached']);
  assert.equal(t.root.querySelector('.sb-summary').textContent, 'Viewing 1 of 8');
});

// ------------------------------------------------------------------ a branch checked out in another worktree

test('checkout refusals: a branch another worktree has checked out gets no double-click and a disabled Checkout ("Checked out in worktree <path>")', () => {
  const { mod: { rowTarget, doubleClickAction, targetMenuItems } } = loadSidebar();
  const refs = H.refs({ ...REFS(), remote: [{ name: 'origin/feat/x', remote: 'origin', branch: 'feat/x', oid: SHA('b') }, { name: 'origin/dev', remote: 'origin', branch: 'dev', oid: SHA('c') }] });
  const s = { busy: false, repo: { root: '/r' }, refs, worktrees: WTS };
  const dbl = (key, st = s) => doubleClickAction(rowTarget(key, st), st);
  assert.equal(dbl('local:feat/x'), null, 'feat/x is checked out in /w/feat-x');
  assert.equal(dbl('local:usb'), null, 'a locked worktree holds its branch too');
  assert.equal(dbl('remote:origin/feat/x'), null, 'its remote branch would switch to the same local branch');
  assert.deepEqual(dbl('remote:origin/dev'), { flow: 'checkout', args: [{ target: 'origin/dev', kind: 'remote' }] });
  assert.deepEqual(dbl('local:feat/x', { ...s, worktrees: [WT.main] }), { flow: 'checkout', args: [{ target: 'feat/x', kind: 'local' }] }, 'free once no worktree has it');
  assert.deepEqual(dbl('local:feat/x', { ...s, worktrees: null }), { flow: 'checkout', args: [{ target: 'feat/x', kind: 'local' }] }, 'worktrees not read yet: git is the backstop');

  const flows = fakeFlows();
  const checkout = (key) => targetMenuItems(rowTarget(key, s), s, flows).find((d) => d.flow === 'checkout');
  assert.deepEqual([checkout('local:feat/x').disabled, checkout('local:feat/x').title], [true, 'Checked out in worktree /w/feat-x']);
  assert.deepEqual([checkout('local:usb').disabled, checkout('local:usb').title], [true, 'Checked out in worktree /w/usb']);
  assert.deepEqual([checkout('remote:origin/feat/x').disabled, checkout('remote:origin/feat/x').title], [true, 'Checked out in worktree /w/feat-x']);
  assert.equal(checkout('remote:origin/dev').disabled, undefined);
  const main = checkout('local:main');
  assert.deepEqual([main.disabled, main.title], [true, 'Already checked out'], 'this worktree\'s own branch is the current one, not "elsewhere"');
});

test('checkoutRefusal: never the current or bare entry, never a commit; the path is display-safe (deleteRefusal shares the lookup)', () => {
  const { A } = loadSidebar();
  const s = { worktrees: [WT.main, wt({ path: '/w/x‮', branch: 'x' }), wt({ path: '/srv/r.git', bare: true, branch: 'b' })] };
  assert.deepEqual(A.checkoutRefusal('x', s), { title: 'Checked out in worktree /w/x\\u{202E}' });
  assert.equal(A.checkoutRefusal('main', s), null, 'the current worktree\'s branch');
  assert.equal(A.checkoutRefusal('b', s), null, 'a bare entry has no checkout');
  assert.equal(A.checkoutRefusal('x', s, { kind: 'commit' }), null);
  assert.equal(A.checkoutRefusal('x', {}), null);
  assert.equal(A.deleteRefusal('x', s).title, 'x is checked out in the worktree /w/x\\u{202E}: it can’t be deleted');
  assert.deepEqual(A.checkoutItem({ target: 'x', kind: 'local', state: s }), { label: 'Checkout', flow: 'checkout', args: [{ target: 'x', kind: 'local' }], disabled: true, title: 'Checked out in worktree /w/x\\u{202E}' });
  assert.deepEqual(A.checkoutItem({ target: 'x', kind: 'local' }), { label: 'Checkout', flow: 'checkout', args: [{ target: 'x', kind: 'local' }] }, 'without state: unchecked');
});

test('checkoutRefusal of a remote branch: its local branch from state.refs; never guessed from the name (a remote name may contain "/")', () => {
  const { A } = loadSidebar();
  const remote = [{ name: 'team/fork/x', remote: 'team/fork', branch: 'x' }];
  const s = { refs: { remote }, worktrees: [WT.main, wt({ path: '/w/x', branch: 'x' }), wt({ path: '/w/fx', branch: 'fork/x' })] };
  assert.deepEqual(A.checkoutRefusal('team/fork/x', s, { kind: 'remote' }), { title: 'Checked out in worktree /w/x' });
  assert.equal(A.checkoutRefusal('team/fork/x', { ...s, refs: { remote: [] } }, { kind: 'remote' }), null, 'unlisted: git decides (not "fork/x")');
  assert.equal(A.checkoutRefusal('team/fork/x', { ...s, refs: null }, { kind: 'remote' }), null);
});

test('deleteRefusal: worktreeHolding skips the current worktree (its branch is refused as the checked-out one), not another one', () => {
  const { A } = loadSidebar();
  // No refs: only the worktree lookup can refuse.
  const s = { worktrees: [WT.main, WT.feat] };
  assert.equal(A.deleteRefusal('main', s), null, 'the current worktree\'s entry is skipped');
  assert.equal(A.deleteRefusal('main', { ...s, refs: REFS() }).why, 'checked out', 'the current branch is refused as such');
  assert.equal(A.deleteRefusal('feat/x', s).why, 'checked out in the worktree /w/feat-x');
  const asOther = { ...s, worktrees: [{ ...WT.main, current: false }, WT.feat] };
  assert.equal(A.deleteRefusal('main', asOther).why, 'checked out in the worktree /r', 'the same entry, not current: refused');
});

test('a prunable worktree (its folder deleted) still holds its branch: checkout is refused, and git refuses it too', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const h = require('./helpers');
  const git = require('../src/git');
  const { A } = loadSidebar();
  const dir = h.initRepo();
  const gone = path.join(h.tmpDir(), 'held');
  h.git(dir, 'worktree', 'add', '-q', '-b', 'held', gone);
  fs.rmSync(gone, { recursive: true, force: true });
  const worktrees = await git.worktrees(dir);
  assert.equal(worktrees.find((w) => w.branch === 'held').prunable, true);
  const s = { worktrees };
  assert.deepEqual(A.checkoutRefusal('held', s), { title: `Checked out in worktree ${gone}` });
  assert.equal(A.checkoutItem({ target: 'held', kind: 'local', state: s }).disabled, true);
  assert.throws(() => h.git(dir, 'checkout', 'held'), /already used by worktree|already checked out/);
});

test('mounted sidebar: double-clicking a branch checked out in another worktree runs nothing; its menu\'s Checkout is disabled', async (tc) => {
  const t = await mountSidebar(tc);
  await t.answerWorktrees();
  t.dom.dispatch(t.row('local:feat/x').querySelector('.sb-name'), 'dblclick');
  await H.flush();
  assert.deepEqual(calls(t.flows), []);
  t.dom.dispatch(t.row('local:feat/x'), 'contextmenu', { clientX: 1, clientY: 1 });
  const item = t.menu.opened.at(-1).items.find((i) => i.label === 'Checkout');
  assert.deepEqual([item.disabled, item.title], [true, 'Checked out in worktree /w/feat-x']);
});

// ------------------------------------------------------------------ revealing the current worktree (the toolbar's chip)

test('mounted sidebar: revealWorktree opens a collapsed section, clears a filter hiding the row, focuses the current worktree\'s row and flashes it', async (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  const t = await mountSidebar(tc, { collapsed: { worktrees: true } });
  await t.answerWorktrees([{ ...WT.main, current: false }, WT.feat, { ...WT.det, current: true }]);
  const input = t.root.querySelector('.sb-filter-input');
  input.value = 'feat';
  t.dom.dispatch(input, 'input');
  assert.equal(t.wrow('/w/detached'), undefined, 'collapsed (and filtered out)');
  t.store.actions.revealWorktree();
  assert.equal(t.section().classList.contains('collapsed'), false, 'the section is open');
  assert.equal(JSON.parse(globalThis.localStorage.getItem('pl.sidebar.sections')).worktrees, true, 'the saved preference stays collapsed');
  assert.equal(input.value, '', 'the filter that hid the row is cleared');
  const row = t.wrow('/w/detached');
  assert.equal(t.dom.doc.activeElement, row, 'the current worktree\'s row has the focus');
  assert.equal(row.tabIndex, 0, 'and the roving tabindex');
  assert.equal(row.classList.contains('sb-flash'), true);
  assert.equal(t.wanted.at(-1), true, 'its dirty dots are wanted again');
  t.store.set({ worktreeDirty: { '/w/feat-x': true } }); // the dots arrive: the rows are rebuilt
  const again = t.wrow('/w/detached');
  assert.notEqual(again, row);
  assert.equal(again.classList.contains('sb-flash'), true, 'the flash survives a re-render');
  assert.equal(t.dom.doc.activeElement, again, 'and so does the focus');
  tc.mock.timers.tick(1200);
  assert.equal(t.wrow('/w/detached').classList.contains('sb-flash'), false, 'briefly');
  t.store.set({ worktreeDirty: {} });
  assert.equal(t.wrow('/w/detached').classList.contains('sb-flash'), false, 'and not again on the next render');
  // The user closing and opening the section again saves their choice.
  const header = () => t.section().querySelector('.sb-section-header');
  t.dom.dispatch(header(), 'click');
  t.dom.dispatch(header(), 'click');
  assert.equal(t.section().classList.contains('collapsed'), false);
  assert.equal(JSON.parse(globalThis.localStorage.getItem('pl.sidebar.sections')).worktrees, undefined, 'opened by the user: saved open');
});

test('mounted sidebar: revealWorktree keeps a filter that shows the row; before the first worktrees read it focuses the section header', async (tc) => {
  const t = await mountSidebar(tc);
  t.store.actions.revealWorktree();
  assert.equal(t.dom.doc.activeElement, t.section().querySelector('.sb-section-header'), 'no rows yet');
  await t.answerWorktrees();
  const input = t.root.querySelector('.sb-filter-input');
  input.value = 'main';
  t.dom.dispatch(input, 'input');
  t.store.actions.revealWorktree();
  assert.equal(input.value, 'main', 'the row is shown: the filter stays');
  assert.equal(t.dom.doc.activeElement, t.wrow('/r'));
});
