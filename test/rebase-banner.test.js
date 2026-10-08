'use strict';
// The operation in progress (docs/plans/rebase.md R1, renderer half): the pure window.PLOp model
// (renderer/op-model.js: banner text per state and stop kind, composer modes, WIP label, notices)
// and the op-banner component mounted on the harness' fake DOM (buttons -> PLFlows, busy gating,
// aria-disabled with the reason, focus kept across refreshes).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const SHA = (c) => c.repeat(40);

function loadOp() {
  const win = H.loadRenderer();
  return { win, Op: win.PLOp };
}

const rebasing = (rb = {}, o = {}) => H.status({
  oid: SHA('e'), branch: null, state: 'rebasing', rebase: H.rebaseState(rb),
  conflicted: [H.conflict('w.txt')], ...o,
});
const refsBy = (entries) => new Map(entries);

// ------------------------------------------------------------------ accessors

test('accessors: state, rebase, merge and pendingAutostash (null / clean when missing or malformed)', () => {
  const { Op } = loadOp();
  assert.equal(Op.opStateOf(null), 'clean');
  assert.equal(Op.opStateOf(H.status()), 'clean', 'status without state (older backend)');
  assert.equal(Op.opStateOf(H.status({ state: 'merging' })), 'merging');
  assert.equal(Op.inProgress(H.status({ state: 'clean' })), false);
  assert.equal(Op.inProgress(H.status({ state: 'bisecting' })), true);
  assert.equal(Op.rebaseStateOf(H.status({ rebase: 'x' })), null);
  assert.equal(Op.rebaseStateOf(rebasing()).branch, 'feat');
  assert.deepEqual(Op.mergeStateOf(H.status({ merge: { head: SHA('f'), name: 'x', message: 'm' } })), { head: SHA('f'), name: 'x', message: 'm' });
  assert.equal(Op.pendingAutostashOf(H.status({ pendingAutostash: SHA('9') })), SHA('9'));
  assert.equal(Op.pendingAutostashOf(H.status({ pendingAutostash: '' })), null);
  assert.equal(Op.opName(H.status({ state: 'cherry-picking' })), 'cherry-pick');
  assert.equal(Op.inProgressTitle('Pull', rebasing()), 'Pull — a rebase is in progress');
  assert.equal(Op.finishFirstTitle('Branch', H.status({ state: 'merging' })), 'Branch — finish or abort the merge first');
});

test('stopOf / conflictCount: live conflicts win over the reported stop; unknown stops are other', () => {
  const { Op } = loadOp();
  assert.equal(Op.stopOf(H.rebaseState({ stop: 'edit' }), rebasing({ stop: 'edit' })), 'conflict', 'a conflicted file listed');
  const clean = rebasing({ stop: 'edit', conflicted: 0 }, { conflicted: [] });
  assert.equal(Op.stopOf(Op.rebaseStateOf(clean), clean), 'edit');
  assert.equal(Op.stopOf(H.rebaseState({ stop: 'weird' }), H.status({ state: 'rebasing' })), 'other');
  assert.equal(Op.stopOf(null, H.status({ state: 'rebasing' })), 'other');
  assert.equal(Op.conflictCount(rebasing()), 1);
  assert.equal(Op.conflictCount({ rebase: H.rebaseState({ conflicted: 4 }) }), 4, 'fallback to the rebase copy');
});

test('ontoName: meta name first, then a local / remote / tag ref at onto, else the short sha', () => {
  const { Op } = loadOp();
  const onto = SHA('b');
  assert.equal(Op.ontoName(H.rebaseState(), null), 'main');
  const refs = refsBy([[onto, [{ type: 'tag', name: 'v1' }, { type: 'remote', name: 'origin/main' }, { type: 'local', name: 'dev' }]]]);
  assert.equal(Op.ontoName(H.rebaseState({ ontoName: null }), refs), 'dev');
  assert.equal(Op.ontoName(H.rebaseState({ ontoName: null }), refsBy([[onto, [{ type: 'tag', name: 'v1' }, { type: 'remote', name: 'origin/main' }]]])), 'origin/main');
  assert.equal(Op.ontoName(H.rebaseState({ ontoName: null }), new Map()), 'bbbbbbb');
  assert.equal(Op.ontoName(null, refs), null);
});

// ------------------------------------------------------------------ banner

const labels = (m) => m.buttons.map((b) => b.label);

test('bannerModel: nothing for a clean repo, no status, or before the first status', () => {
  const { Op } = loadOp();
  assert.equal(Op.bannerModel({ status: null }), null);
  assert.equal(Op.bannerModel({ status: H.status({ oid: SHA('a') }) }), null);
  assert.equal(Op.bannerModel({ status: H.status({ oid: SHA('a'), state: 'clean' }) }), null);
  assert.equal(Op.bannerModel(null), null);
});

test('bannerModel: rebase conflict stop — title, step with subject, conflicted files, Continue disabled until resolved', () => {
  const { Op } = loadOp();
  const m = Op.bannerModel({ status: rebasing({}, { conflicted: [H.conflict('a'), H.conflict('b', 'AA')] }), refsBySha: new Map() });
  assert.equal(m.kind, 'rebase');
  assert.equal(m.stop, 'conflict');
  assert.equal(m.title, 'Rebasing feat onto main');
  assert.deepEqual(m.lines, ['Commit 2 of 3: "add the widget"', '2 conflicted files']);
  assert.deepEqual(labels(m), ['Continue Rebase', 'Skip Commit', 'Abort Rebase']);
  assert.deepEqual(m.buttons.map((b) => b.flow), ['rebaseContinue', 'rebaseSkip', 'rebaseAbort']);
  assert.equal(m.buttons[0].disabled, true);
  assert.equal(m.buttons[0].title, 'Resolve and mark all conflicted files first');
  assert.equal(m.buttons[1].danger, true);
  assert.equal(m.buttons[2].danger, true);

  const resolved = Op.bannerModel({ status: rebasing({ conflicted: 0 }, { conflicted: [] }), refsBySha: new Map() });
  assert.equal(resolved.stop, 'conflict', 'the backend still says conflict: resolved but not continued');
  assert.equal(resolved.lines[1], 'All conflicts are marked resolved: continue the rebase');
  assert.equal(resolved.buttons[0].disabled, undefined);
  assert.match(resolved.buttons[0].title, /continue with the next commit/);
});

test('bannerModel: edit stop has no Skip, says "Stopped to edit <sha7>: amend or continue" and that staged changes are amended', () => {
  const { Op } = loadOp();
  const st = rebasing({ stop: 'edit', conflicted: 0, current: { cmd: 'edit', sha: SHA('a'), subject: 'fix it' } }, { conflicted: [] });
  const m = Op.bannerModel({ status: st });
  assert.deepEqual(labels(m), ['Continue Rebase', 'Abort Rebase']);
  assert.deepEqual(m.lines, ['Commit 2 of 3', 'Stopped to edit aaaaaaa: amend or continue', 'Staged changes are amended into "fix it"']);
  assert.match(m.buttons[0].title, /amended into the stopped commit/);
});

test('bannerModel: hook, empty, signing and other stops; the hook output goes to the detail', () => {
  const { Op } = loadOp();
  const stop = (o) => Op.bannerModel({ status: rebasing({ conflicted: 0, ...o }, { conflicted: [] }) });
  const hook = stop({ stop: 'hook', hookOutput: 'commit-msg: missing ticket id\n' });
  assert.match(hook.lines[1], /commit hook refused/);
  assert.equal(hook.detailLabel, 'Hook output');
  assert.equal(hook.detail, 'commit-msg: missing ticket id\n');
  assert.deepEqual(labels(hook), ['Continue Rebase', 'Skip Commit', 'Abort Rebase']);
  assert.equal(stop({ stop: 'hook' }).detail, null, 'no output: no detail');
  assert.match(stop({ stop: 'empty' }).lines[1], /^ddddddd "add the widget" has become empty/);
  assert.match(stop({ stop: 'other', signingFailed: true }).lines[1], /^Signing ddddddd "add the widget" failed/);
  assert.match(stop({ stop: 'other' }).lines[1], /^The rebase stopped at ddddddd "add the widget"/);
  assert.match(stop({ stop: 'other', current: null }).lines[1], /at the current commit/);
});

test('bannerModel: external rebase, detached HEAD, onto named by refs, our autostash, no step', () => {
  const { Op } = loadOp();
  const ext = Op.bannerModel({ status: rebasing({ ours: false, ontoName: null }), refsBySha: refsBy([[SHA('b'), [{ type: 'remote', name: 'origin/main' }]]]) });
  assert.equal(ext.title, 'Rebase in progress');
  assert.equal(ext.lines[0], 'feat onto origin/main (started outside Pasta Lite)');
  const det = Op.bannerModel({ status: rebasing({ branch: null, step: null, autostash: SHA('7') }) });
  assert.equal(det.title, 'Rebasing detached HEAD onto main');
  assert.deepEqual(det.lines, ['1 conflicted file', 'Your local changes are stashed (7777777) and come back when the rebase ends']);
});

test('bannerModel: a rebase whose todo runs commands offers only Abort, and says why', () => {
  const { Op } = loadOp();
  const st = rebasing({ ours: false, runsCommands: true, conflicted: 0 }, { conflicted: [] });
  const m = Op.bannerModel({ status: st });
  assert.ok(m.lines.includes('The rest of this rebase runs commands (exec lines in its todo), which Pasta Lite never runs. Continue it in a terminal if you trust it, or abort it.'));
  const byId = Object.fromEntries(m.buttons.map((b) => [b.id, b]));
  assert.equal(byId.continue.disabled, true);
  assert.equal(byId.skip.disabled, true);
  assert.match(byId.continue.title, /runs commands: continue it in a terminal, or abort it/);
  assert.equal(byId.abort.disabled, undefined);
  const plain = Op.bannerModel({ status: rebasing({ ours: false, conflicted: 0 }, { conflicted: [] }) });
  assert.equal(plain.buttons.find((b) => b.id === 'skip').disabled, undefined);
});

test('bannerModel: display-safe names (bidi / control characters escaped)', () => {
  const { Op } = loadOp();
  const m = Op.bannerModel({ status: rebasing({ branch: 'fe\u202eat', ontoName: 'ma\nin', current: { cmd: 'pick', sha: SHA('d'), subject: 'x\u202ey' } }) });
  assert.equal(m.title, 'Rebasing fe\\u{202E}at onto ma↵in');
  assert.equal(m.lines[0], 'Commit 2 of 3: "x\\u{202E}y"');
});

test('bannerModel: rebasing before the backend reports status.rebase still offers Continue / Skip / Abort', () => {
  const { Op } = loadOp();
  const m = Op.bannerModel({ status: H.status({ state: 'rebasing', branch: null }) });
  assert.equal(m.title, 'A rebase is in progress');
  assert.deepEqual(labels(m), ['Continue Rebase', 'Skip Commit', 'Abort Rebase']);
  const c = Op.bannerModel({ status: H.status({ state: 'rebasing', conflicted: [H.conflict('a')] }) });
  assert.deepEqual(c.lines, ['1 conflicted file']);
  assert.equal(c.buttons[0].disabled, true);
});

test('bannerModel: merge (name from MERGE_HEAD, or a ref at its head), other operations, pending autostash', () => {
  const { Op } = loadOp();
  const merge = Op.bannerModel({ status: H.status({ state: 'merging', conflicted: [H.conflict('a')], merge: { head: SHA('f'), name: 'origin/main', message: 'Merge' } }) });
  assert.equal(merge.kind, 'merge');
  assert.equal(merge.title, 'Merging origin/main into main');
  assert.deepEqual(merge.lines, ['1 conflicted file']);
  assert.deepEqual(labels(merge), ['Commit and Merge', 'Abort Merge']);
  assert.deepEqual(merge.buttons.map((b) => b.flow), ['mergeCommit', 'mergeAbort']);
  assert.equal(merge.buttons[0].disabled, true);
  const byRef = Op.bannerModel({ status: H.status({ state: 'merging', merge: { head: SHA('f'), name: null, message: '' } }), refsBySha: refsBy([[SHA('f'), [{ type: 'local', name: 'topic' }]]]) });
  assert.equal(byRef.title, 'Merging topic into main');
  assert.equal(byRef.lines[0], 'All conflicts are marked resolved: commit the merge');
  assert.equal(byRef.buttons[0].disabled, undefined);
  assert.equal(Op.bannerModel({ status: H.status({ state: 'merging', branch: null }) }).title, 'A merge into detached HEAD is in progress');

  const cp = Op.bannerModel({ status: H.status({ state: 'cherry-picking' }) });
  assert.deepEqual([cp.kind, cp.title, cp.lines, cp.buttons], ['other', 'A cherry-pick is in progress', ['Finish or abort it from a terminal.'], []]);

  const stash = Op.bannerModel({ status: H.status({ state: 'clean', pendingAutostash: SHA('9') }) });
  assert.equal(stash.kind, 'autostash');
  assert.equal(stash.title, 'Your changes from before the rebase are in a stash');
  assert.deepEqual(labels(stash), ['Restore', 'Keep in Stash']);
  assert.deepEqual(stash.buttons.map((b) => [b.flow, b.args]), [['restoreAutostash', [{ keep: false }]], ['restoreAutostash', [{ keep: true }]]]);
  assert.equal(Op.bannerModel({ status: H.status({ state: 'rebasing', rebase: H.rebaseState(), pendingAutostash: SHA('9') }) }).kind, 'rebase', 'the rebase first');
});

// ------------------------------------------------------------------ composer mode / WIP / notices

test('composerMode: continue at a conflict stop (keyed by the stopped commit), rebase for other stops, merge, commit', () => {
  const { Op } = loadOp();
  const c = Op.composerMode(rebasing());
  assert.deepEqual(c, {
    mode: 'continue', key: `rebase:${SHA('d')}`, stop: 'conflict', message: 'add the widget\n\nWith a body.\n', label: 'Continue Rebase', flow: 'rebaseContinue',
  });
  assert.equal(Op.composerMode(rebasing({ current: { cmd: 'pick', sha: SHA('1'), subject: 's' } })).key, `rebase:${SHA('1')}`, 'the next stop: another draft slot');
  assert.equal(Op.composerMode(rebasing({ current: null })).key, `rebase:${SHA('c')}`, 'no current commit: the orig-head');
  const edit = Op.composerMode(rebasing({ stop: 'edit', conflicted: 0 }, { conflicted: [] }));
  assert.deepEqual([edit.mode, edit.key, edit.stop], ['rebase', 'commit', 'edit']);
  const unknown = Op.composerMode(H.status({ state: 'rebasing', conflicted: [H.conflict('a')] }));
  assert.deepEqual([unknown.mode, unknown.message], ['rebase', undefined], 'no rebase state (backend unknown): no message to edit');
  const m = Op.composerMode(H.status({ state: 'merging', merge: { head: SHA('f'), name: 'x', message: "Merge branch 'x'" } }));
  assert.deepEqual(m, { mode: 'merge', key: `merge:${SHA('f')}`, stop: null, message: "Merge branch 'x'", label: 'Commit and Merge', flow: 'mergeCommit' });
  assert.deepEqual(Op.composerMode(H.status()), { mode: 'commit', key: 'commit', stop: null });
  assert.equal(Op.composerMode(H.status({ state: 'cherry-picking' })).mode, 'commit');
});

test('conflictHeading / wipLabel / stoppedNotice', () => {
  const { Op } = loadOp();
  assert.deepEqual(Op.conflictHeading(rebasing()), { title: 'Rebase conflicts detected', text: '1 conflicted file: resolve it, mark it resolved, then continue the rebase' });
  assert.deepEqual(Op.conflictHeading(H.status({ state: 'merging', conflicted: [H.conflict('a'), H.conflict('b')] })),
    { title: 'Merge conflicts detected', text: '2 conflicted files: resolve each one, mark them resolved, then commit the merge' });
  assert.equal(Op.conflictHeading(rebasing({}, { conflicted: [] })), null);
  assert.equal(Op.conflictHeading(H.status({ conflicted: [H.conflict('a')] })), null, 'a stash pop conflict is not a rebase');

  assert.equal(Op.wipLabel(H.status()), '// WIP');
  assert.equal(Op.wipLabel(rebasing()), '// Rebasing 2/3');
  assert.equal(Op.wipLabel(rebasing({ step: null })), '// Rebasing');
  assert.equal(Op.wipLabel(H.status({ state: 'merging' })), '// Merging');
  assert.equal(Op.wipLabel(H.status({ state: 'bisecting' })), '// WIP');

  assert.equal(Op.stoppedNotice(H.rebaseState({ conflicted: 2 })), 'Rebase stopped: 2 conflicted files');
  assert.equal(Op.stoppedNotice(H.rebaseState({ stop: 'edit', conflicted: 0 })), 'Rebase stopped to edit ddddddd "add the widget": amend or continue');
  assert.equal(Op.editStopText(H.rebaseState({ stop: 'edit' })), 'Stopped to edit ddddddd: amend or continue');
  assert.equal(Op.editStopText(null), 'Stopped to edit the commit: amend or continue');
  assert.equal(Op.stoppedNotice(H.rebaseState({ stop: 'hook', conflicted: 0 })), 'Rebase stopped: a commit hook refused the commit');
  assert.equal(Op.stoppedNotice(null, H.status()), 'Rebase stopped: continue or abort it');
  assert.equal(Op.stoppedNotice(H.rebaseState({ stop: 'empty', conflicted: 0 })), 'Rebase stopped: ddddddd "add the widget" has become empty: skip it to leave it out, or abort the rebase');
});

test('composerMode: a hook stop edits the refused message (merge backend only); commits are refused exactly where ops refuseAtPickStop refuses them', () => {
  const { Op } = loadOp();
  const hook = Op.composerMode(rebasing({ stop: 'hook', stopMessage: 'bad message\n', stoppedSha: SHA('d') }, { conflicted: [] }));
  assert.deepEqual([hook.mode, hook.key, hook.stop, hook.message, hook.flow], ['continue', `rebase:${SHA('d')}`, 'hook', 'bad message\n', 'rebaseContinue']);
  // the apply backend takes no message (ops: invalid-args): Continue without one, from the 'rebase' mode
  for (const stop of ['hook', 'conflict']) {
    const apply = Op.composerMode(rebasing({ stop, backend: 'apply', stoppedSha: SHA('d') }, { conflicted: [] }));
    assert.deepEqual([apply.mode, apply.message, apply.commitRefused], ['rebase', undefined, Op.COMMIT_REFUSED], `apply ${stop}`);
  }
  const refused = (rb) => Op.composerMode(rebasing(rb, { conflicted: [] })).commitRefused;
  assert.equal(refused({ stop: 'empty' }), Op.COMMIT_REFUSED);
  assert.equal(refused({ stop: 'other', stoppedSha: SHA('d') }), Op.COMMIT_REFUSED, 'REBASE_HEAD: a commit being replayed');
  assert.equal(refused({ stop: 'other', stoppedSha: null }), null, 'break / exec: between commits');
  assert.equal(refused({ stop: 'edit', stoppedSha: SHA('d') }), null, 'an edit stop always allows them');
});

test('unstagedBlocker: Continue Rebase always, Commit and Merge only while the merge autostash waits; the banners disable them with the reason', () => {
  const { Op } = loadOp();
  const unstaged = [{ path: 'a.txt', status: 'M' }];
  const untracked = [{ path: 'new.txt', status: '?' }];
  const rb = rebasing({ stop: 'edit' }, { conflicted: [], unstaged });
  assert.match(Op.unstagedBlocker(rb), /^Stage or discard your unstaged changes first: Continue Rebase commits only what is staged/);
  assert.equal(Op.unstagedBlocker(rebasing({ stop: 'edit' }, { conflicted: [], unstaged: untracked })), null, 'untracked files are fine');
  const cont = Op.bannerModel({ status: rb }).buttons.find((b) => b.id === 'continue');
  assert.deepEqual([cont.disabled, cont.title], [true, Op.unstagedBlocker(rb)]);

  const merge = (m, o = {}) => H.status({ oid: SHA('a'), branch: 'main', state: 'merging', merge: { head: SHA('f'), name: 'side', message: 'm', ...m }, ...o });
  assert.equal(Op.unstagedBlocker(merge({}, { unstaged })), null, 'no autostash: git commits what is staged');
  const waiting = merge({ autostash: SHA('7') }, { unstaged });
  assert.match(Op.unstagedBlocker(waiting), /your stashed changes come back when the merge is committed/);
  const mb = Op.bannerModel({ status: waiting });
  const commit = mb.buttons.find((b) => b.id === 'mergeCommit');
  assert.deepEqual([commit.disabled, commit.title], [true, Op.unstagedBlocker(waiting)]);
  assert.deepEqual(mb.lines, ['All conflicts are marked resolved: commit the merge', 'Your local changes are stashed (7777777) and come back when the merge ends']);
  assert.equal(Op.bannerModel({ status: merge({ autostash: SHA('7') }) }).buttons[0].disabled, undefined, 'a clean tree commits');
});

// ------------------------------------------------------------------ mounted banner

async function mountBanner(tc, data, { repo } = {}) {
  const { win, api, store } = await H.loadedStore(data, repo ? { repo } : {});
  const dom = H.fakeDom().install();
  dom.attach(win);
  for (const f of ['actions.js', 'components/op-banner.js']) {
    const p = require.resolve(`../renderer/${f}`);
    delete require.cache[p];
    require(p);
  }
  const calls = [];
  const flows = {};
  for (const n of ['rebaseContinue', 'rebaseSkip', 'rebaseAbort', 'mergeCommit', 'mergeAbort', 'restoreAutostash', 'openWorktree']) {
    flows[n] = async (s, ...args) => { calls.push([n, ...args]); return true; };
  }
  win.PLFlows = flows;
  const root = dom.document.createElement('div');
  root.dataset.component = 'op-banner';
  dom.document.body.append(root);
  const unmount = win.Components.mountAll({ querySelectorAll: () => [root], contains: (n) => n === root }, store);
  tc.after(unmount);
  const buttons = () => root.findAll((n) => n.tagName === 'BUTTON');
  const byAction = (id) => buttons().find((b) => b.dataset.action === id);
  const text = (cls) => (root.findAll((n) => n.className === cls)[0] || { textContent: null }).textContent;
  return { win, api, store, dom, root, calls, buttons, byAction, text, unmount };
}

const bannerData = (st) => H.repoData({ commits: H.chain([SHA('e')]), status: st });

test('mounted banner: hidden while clean; shows the rebase and runs its flows; busy and conflicts gate the buttons', async (tc) => {
  const t = await mountBanner(tc, bannerData(H.status({ oid: SHA('e') })));
  assert.equal(t.root.hidden, true);
  assert.equal(t.buttons().length, 0);

  t.store.set({ status: rebasing({}, { oid: SHA('e') }) });
  assert.equal(t.root.hidden, false);
  assert.equal(t.root.dataset.kind, 'rebase');
  assert.equal(t.text('ob-title'), 'Rebasing feat onto main');
  assert.equal(t.text('ob-lines'), 'Commit 2 of 3: "add the widget" · 1 conflicted file');
  const status = t.root.findAll((n) => n.getAttribute('role') === 'status');
  assert.equal(status.length, 1, 'a polite live region for the text');
  assert.equal(status[0].getAttribute('aria-live'), 'polite');
  assert.deepEqual(t.buttons().map((b) => b.textContent), ['Continue Rebase', 'Skip Commit', 'Abort Rebase']);
  const cont = t.byAction('continue');
  assert.equal(cont.getAttribute('aria-disabled'), 'true');
  assert.equal(cont.title, 'Resolve and mark all conflicted files first');
  cont.click();
  t.byAction('skip').click();
  await H.flush();
  assert.deepEqual(t.calls, [['rebaseSkip']], 'a disabled Continue runs nothing');

  // resolved: Continue enabled, the same button elements (focus stays)
  cont.focus();
  t.store.set({ status: rebasing({ conflicted: 0 }, { oid: SHA('e'), conflicted: [] }) });
  assert.equal(t.byAction('continue'), cont);
  assert.equal(t.dom.document.activeElement, cont);
  assert.equal(cont.getAttribute('aria-disabled'), null);
  cont.click();
  await H.flush();
  assert.deepEqual(t.calls.at(-1), ['rebaseContinue']);

  // busy: every button off with "Working…"
  t.store.set({ busy: true });
  assert.ok(t.buttons().every((b) => b.getAttribute('aria-disabled') === 'true' && b.title === 'Working…'));
  t.byAction('abort').click();
  await H.flush();
  assert.equal(t.calls.length, 2, 'nothing ran while busy');
  t.store.set({ busy: false });
  t.byAction('abort').click();
  await H.flush();
  assert.deepEqual(t.calls.at(-1), ['rebaseAbort']);
});

test('mounted banner: edit stop, merge, hook detail, pending autostash, and back to hidden', async (tc) => {
  const t = await mountBanner(tc, bannerData(rebasing({ stop: 'edit', conflicted: 0 }, { oid: SHA('e'), conflicted: [] })));
  assert.deepEqual(t.buttons().map((b) => b.dataset.action), ['continue', 'abort']);
  const detailWrap = t.root.findAll((n) => n.className === 'ob-detail-wrap')[0];
  assert.equal(detailWrap.hidden, true);

  t.store.set({ status: rebasing({ stop: 'hook', conflicted: 0, hookOutput: 'nope' }, { oid: SHA('e'), conflicted: [] }) });
  assert.equal(detailWrap.hidden, false);
  assert.equal(t.text('ob-detail'), 'nope');
  assert.equal(t.text('ob-detail-label'), 'Hook output');

  t.store.set({ status: H.status({ oid: SHA('e'), state: 'merging', merge: { head: SHA('f'), name: 'topic', message: 'm' } }) });
  assert.equal(t.text('ob-title'), 'Merging topic into main');
  assert.equal(detailWrap.hidden, true);
  t.byAction('mergeCommit').click();
  t.byAction('mergeAbort').click();
  await H.flush();
  assert.deepEqual(t.calls, [['mergeCommit'], ['mergeAbort']]);

  t.store.set({ status: H.status({ oid: SHA('e'), state: 'clean', pendingAutostash: SHA('9') }) });
  assert.equal(t.root.dataset.kind, 'autostash');
  t.byAction('restore').click();
  t.byAction('keep').click();
  await H.flush();
  assert.deepEqual(t.calls.slice(2), [['restoreAutostash', { keep: false }], ['restoreAutostash', { keep: true }]]);

  t.store.set({ status: H.status({ oid: SHA('e'), state: 'clean' }) });
  assert.equal(t.root.hidden, true);
  t.unmount();
  assert.equal(t.root.children.length, 0, 'unmount clears the region');
});

test('mounted banner: without PLFlows every button is disabled ("Not available")', async (tc) => {
  const t = await mountBanner(tc, bannerData(rebasing({ conflicted: 0 }, { oid: SHA('e'), conflicted: [] })));
  t.win.PLFlows = undefined;
  t.store.set({ busy: true });
  t.store.set({ busy: false });
  assert.ok(t.buttons().every((b) => b.getAttribute('aria-disabled') === 'true' && b.title === 'Not available'));
});

test('composer at an edit stop: "Stopped to edit <sha7>: amend or continue" above the normal commit box; hidden at other stops', async () => {
  const data = bannerData(rebasing({ stop: 'edit', conflicted: 0, current: { cmd: 'edit', sha: SHA('a'), subject: 'fix it' } }, { oid: SHA('e'), conflicted: [] }));
  const { win, store } = await H.loadedStore(data);
  const dom = H.fakeDom().install();
  dom.attach(win);
  H.setLocalStorage(H.memoryStorage());
  for (const f of ['actions.js', 'components/wip-model.js', 'components/composer.js']) {
    const p = require.resolve(`../renderer/${f}`);
    delete require.cache[p];
    require(p);
  }
  const c = win.PLComposer.create(store);
  dom.document.body.append(c.el);
  c.setRepo(store.state.repo);
  c.render();
  const note = c.el.findAll((n) => n.className === 'dt-stop-note')[0];
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'Stopped to edit aaaaaaa: amend or continue');
  assert.equal(note.getAttribute('role'), 'status');
  const cont = c.el.findAll((n) => n.className && n.className.includes('dt-continue-btn'))[0];
  assert.equal(cont.hidden, false, 'Continue Rebase under the commit button');
  store.set({ status: rebasing({ stop: 'hook', conflicted: 0 }, { oid: SHA('e'), conflicted: [] }) });
  c.render();
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
  store.set({ status: H.status({ oid: SHA('e') }) });
  c.render();
  assert.equal(note.hidden, true);
  if (typeof c.dispose === 'function') c.dispose();
});

// ------------------------------------------------------------------ bare repository

test('mounted banner in a bare repository: the bare banner, an "Open worktree" button per worktree once they are read; they work while busy', async (tc) => {
  const bare = { root: '/w/t/.bare', name: 't/.bare', bare: true };
  const t = await mountBanner(tc, bannerData({ ...H.status({ oid: SHA('e') }), state: 'clean', rebase: null, merge: null, pendingAutostash: null, bare: true }), { repo: bare });
  assert.equal(t.root.hidden, false);
  assert.equal(t.root.dataset.kind, 'bare');
  assert.equal(t.text('ob-title'), 'Bare repository — no working tree');
  assert.equal(t.text('ob-lines'), 'Commit, checkout, stash, merge and rebase need a worktree.');
  assert.equal(t.buttons().length, 0, 'worktrees not read yet');

  t.api.take('worktrees').resolve([
    { path: '/w/t/.bare', head: SHA('e'), branch: 'main', bare: true, detached: false, locked: false, prunable: false },
    { path: '/w/t/main', head: SHA('e'), branch: 'main', bare: false, detached: false, locked: false, prunable: false },
    { path: '/w/t/fix', head: SHA('e'), branch: 'fix/x', bare: false, detached: false, locked: false, prunable: false },
  ]);
  await H.flush();
  assert.deepEqual(t.buttons().map((b) => [b.textContent, b.title]), [
    ['Open worktree main', 'Open /w/t/main in a new tab'], ['Open worktree fix/x', 'Open /w/t/fix in a new tab'],
  ]);
  t.store.set({ busy: true });
  assert.equal(t.buttons()[1].getAttribute('aria-disabled'), null, 'openWorktree runs while busy');
  t.buttons()[1].click();
  await H.flush();
  assert.deepEqual(t.calls, [['openWorktree', '/w/t/fix']]);

  t.store.set({ busy: false, worktrees: [] });
  assert.equal(t.buttons().length, 0);
  assert.match(t.text('ob-lines'), / · It has no worktrees yet: add one from a terminal with git worktree add/);
});
