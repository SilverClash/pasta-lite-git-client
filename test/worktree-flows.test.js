'use strict';
// The linked-worktree menu (PLMenus.worktreeMenuItems / worktreeRefusal), the policy entries and the
// flows of renderer/flows-linked-worktrees.js over a scripted api and scripted dialogs.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const { scriptedApi, scriptDialogs, errOf: err } = H;
const REPO = { root: '/r', name: 'r' };
const SHA = 'a'.repeat(40);

const wt = (o) => ({
  path: '/w/x', head: SHA, branch: 'x', bare: false, detached: false, locked: false, lockReason: '',
  prunable: false, prunableReason: '', main: false, current: false, ...o,
});
const MAIN = wt({ path: '/w/main', branch: 'main', main: true, current: true });
const NORMAL = wt({});

async function setup(handlers = {}, answers = [], { worktrees = [MAIN, NORMAL], repo = REPO } = {}) {
  H.setLocalStorage(H.memoryStorage());
  const win = H.loadFlows();
  const st = H.status({ oid: SHA, branch: 'main' });
  const data = {
    status: st, refs: H.refs({ local: [{ name: 'main', oid: SHA, upstream: null, current: true }] }), stashes: [],
    log: { commits: [H.commit(SHA)], hasMore: false, next: null },
    undoState: { undo: null, redo: null, busy: false, undoBlocked: null, redoBlocked: null }, worktrees,
  };
  const api = scriptedApi(data, handlers);
  win.api = api;
  const store = win.Store.create(api);
  const toasts = [];
  store.setToast((e) => toasts.push(e));
  await store.actions.loadRepo(repo);
  await H.flush();
  const dialogs = scriptDialogs(win, answers);
  return {
    win, api, store, F: win.PLFlows, dialogs, toasts, data,
    notices: () => toasts.filter((t) => t.level === 'info').map((t) => t.message),
    errors: () => toasts.filter((t) => t.level !== 'info'),
    A: win.Components.actions,
  };
}
const calls = (api, op) => api.calls.filter((c) => c.op === op).map((c) => c.args);

// ------------------------------------------------------------------ menu

const ALL = ['openWorktree', 'revealWorktree', 'copyWorktreePath', 'lockWorktree', 'unlockWorktree', 'pruneWorktrees', 'removeWorktree']
  .reduce((o, n) => ({ ...o, [n]: async () => true }), {});
const labels = (items) => items.map((d) => (d.separator ? '---' : d.label));
const find = (items, label) => items.find((d) => d.label === label);

test('menu: a normal worktree, in order, all enabled', async () => {
  const { A } = await setup();
  const items = A.worktreeMenuItems(NORMAL, { busy: false, repo: REPO }, ALL, { platform: 'darwin' });
  assert.deepEqual(labels(items), ['Open', 'Reveal in Finder', 'Copy Path', '---', 'Lock…', '---', 'Delete…']);
  assert.ok(items.every((d) => !d.disabled));
  assert.equal(find(items, 'Open').title, 'Show the tab that has it open, else open it in a new tab');
  assert.deepEqual(find(items, 'Open').args, ['/w/x']);
  assert.equal(find(items, 'Delete…').flow, 'removeWorktree');
  assert.equal(find(items, 'Delete…').danger, true);
});

test('menu: the reveal label per platform', async () => {
  const { A } = await setup();
  for (const [platform, label] of [['darwin', 'Reveal in Finder'], ['win32', 'Show in Explorer'], ['linux', 'Show in File Manager']]) {
    assert.equal(A.worktreeMenuItems(NORMAL, {}, ALL, { platform })[1].label, label);
  }
});

test('menu: main, current, bare, locked, prunable, missing, locked+missing, detached', async () => {
  const { A } = await setup();
  const m = (w) => A.worktreeMenuItems(w, { busy: false }, ALL, { platform: 'darwin' });

  let items = m(MAIN);
  assert.equal(find(items, 'Open').disabled, true);
  assert.equal(find(items, 'Open').title, 'This tab has this worktree open');
  assert.equal(find(items, 'Lock…').disabled, true);
  assert.equal(find(items, 'Lock…').title, "The main worktree can't be locked");
  assert.equal(find(items, 'Delete…').title, "The main worktree can't be deleted");

  items = m(wt({ path: '/w/cur', current: true }));
  assert.equal(find(items, 'Lock…').disabled, undefined, 'lock is allowed on the current worktree');
  assert.match(find(items, 'Delete…').title, /^This tab has this worktree open: open another/);

  items = m(wt({ path: '/w/bare', bare: true, main: true, branch: null, head: null }));
  assert.equal(find(items, 'Open').title, 'The bare repository has no working tree to open');
  assert.equal(find(items, 'Delete…').title, "The bare repository can't be deleted here");
  assert.equal(find(items, 'Lock…').disabled, true);
  assert.equal(find(items, 'Lock…').title, 'The bare repository has no worktree folder to lock');

  items = m(wt({ locked: true, lockReason: 'usb <b>' }));
  assert.ok(find(items, 'Unlock') && !find(items, 'Lock…'));
  assert.equal(find(items, 'Unlock').flow, 'unlockWorktree');
  assert.equal(find(items, 'Delete…').disabled, true);
  assert.match(find(items, 'Delete…').title, /^Locked \(usb .*\): unlock it first$/);
  assert.equal(find(m(wt({ locked: true })), 'Delete…').title, 'Locked: unlock it first');

  items = m(wt({ prunable: true }));
  assert.deepEqual(labels(items), ['Open', 'Reveal in Finder', 'Copy Path', '---', 'Lock…', 'Prune…', '---', 'Delete…']);
  assert.equal(find(items, 'Open').title, 'Its folder is gone: prune it');
  assert.equal(find(items, 'Reveal in Finder').disabled, true);
  assert.equal(find(items, 'Reveal in Finder').title, 'Its folder is gone');
  assert.equal(find(items, 'Prune…').flow, 'pruneWorktrees');
  assert.equal(find(items, 'Prune…').disabled, undefined);
  assert.equal(find(items, 'Delete…').title, 'Its folder is already gone: use Prune');

  // git never marks a locked worktree prunable: a locked one whose folder is gone is only `missing`
  items = m(wt({ locked: true, lockReason: 'usb', missing: true }));
  assert.deepEqual(labels(items), ['Open', 'Reveal in Finder', 'Copy Path', '---', 'Unlock', '---', 'Delete…'], 'no Prune: git keeps it');
  assert.equal(find(items, 'Open').disabled, true);
  assert.equal(find(items, 'Open').title, 'Its folder is gone');
  assert.equal(find(items, 'Reveal in Finder').disabled, true);
  assert.equal(find(items, 'Reveal in Finder').title, 'Its folder is gone');
  assert.equal(find(items, 'Unlock').disabled, undefined);
  assert.equal(find(items, 'Delete…').title, 'Locked (usb): unlock it first');

  items = m(wt({ missing: true }));
  assert.equal(find(items, 'Open').title, 'Its folder is gone');
  assert.equal(find(items, 'Reveal in Finder').disabled, true);
  assert.equal(find(items, 'Delete…').title, 'Its folder is gone: Prune is offered once git marks it prunable');
  assert.equal(find(m(wt({ missing: true, prunable: true })), 'Delete…').title, 'Its folder is already gone: use Prune');

  items = m(wt({ branch: null, detached: true }));
  assert.ok(items.every((d) => !d.disabled), 'detached is a normal worktree');
});

test('menu: busy disables everything but Open, Reveal and Copy Path; a missing flow disables its item', async () => {
  const { A } = await setup();
  const items = A.worktreeMenuItems(NORMAL, { busy: true }, ALL, { platform: 'darwin' });
  for (const d of items.filter((x) => !x.separator)) {
    const free = ['openWorktree', 'revealWorktree', 'copyWorktreePath'].includes(d.flow);
    assert.equal(!!d.disabled, !free, d.label);
  }
  const pr = A.worktreeMenuItems(wt({ prunable: true }), { busy: true }, ALL, {});
  assert.equal(!!find(pr, 'Prune…').disabled, true);
  const noFlow = A.worktreeMenuItems(NORMAL, { busy: false }, { openWorktree: ALL.openWorktree }, {});
  assert.equal(!!find(noFlow, 'Open').disabled, false);
  assert.equal(!!find(noFlow, 'Copy Path').disabled, true);
});

test('worktreeRefusal: null for a missing entry and unknown actions; actions per entry', async () => {
  const { A } = await setup();
  assert.equal(A.worktreeRefusal(null, 'delete'), null);
  assert.equal(A.worktreeRefusal(NORMAL, 'bogus'), null);
  for (const a of ['open', 'reveal', 'lock', 'unlock', 'delete', 'prune']) assert.equal(A.worktreeRefusal(NORMAL, a), null, a);
  assert.equal(A.worktreeRefusal(wt({ locked: true, prunable: true }), 'prune'), null, 'no prune refusal: git never reports that state');
  assert.equal(A.worktreeRefusal(MAIN, 'unlock').title, "The main worktree can't be locked");
});

// ------------------------------------------------------------------ policy

test('policy: revealWorktree and copyWorktreePath are free flows; the others are not, nor bare-blocked', async () => {
  const { win } = await setup();
  const P = win.PLPolicy;
  assert.ok(P.FREE_FLOWS.has('revealWorktree') && P.FREE_FLOWS.has('copyWorktreePath'));
  for (const n of ['removeWorktree', 'pruneWorktrees', 'lockWorktree', 'unlockWorktree']) {
    assert.ok(!P.FREE_FLOWS.has(n), n);
    assert.ok(!(n in P.WORKTREE_FLOWS) && !P.WORKTREE_FLOWS.includes?.(n), n);
    assert.ok(!P.START_FLOWS[n], n);
    assert.equal(P.bareBlocked({ repo: { bare: true } }, n, []), null, n);
  }
});

// ------------------------------------------------------------------ removeWorktree

test('removeWorktree: confirm (danger) with the branch, then a plain write and a notice', async () => {
  const s = await setup({ removeWorktree: () => true }, [true]);
  assert.equal(await s.F.removeWorktree(s.store, '/w/x'), true);
  const c = s.dialogs[0];
  assert.equal(c.type, 'confirm');
  assert.equal(c.opts.title, 'Delete worktree?');
  assert.equal(c.opts.confirmLabel, 'Delete');
  assert.equal(c.opts.danger, true);
  assert.match(c.opts.message, /Its folder is removed from disk, including ignored files \(e\.g\. \.env\)\. The branch x is kept\./);
  assert.deepEqual(calls(s.api, 'worktreeUnreachable'), [], 'not counted for a branch');
  assert.match(c.opts.message, /that tab shows it as deleted\.$/);
  assert.deepEqual(calls(s.api, 'removeWorktree'), [['/w/x', {}]]);
  assert.deepEqual(s.notices(), ['Deleted worktree x']);
});

test('removeWorktree: a detached worktree warns with the count of commits only it reaches; none: no warning; a failed count: the generic one', async () => {
  const d = wt({ path: '/w/d', branch: null, detached: true, head: 'b'.repeat(40) });
  const s = await setup({ removeWorktree: () => true, worktreeUnreachable: () => ({ count: 3 }) }, [true], { worktrees: [MAIN, d] });
  assert.equal(await s.F.removeWorktree(s.store, '/w/d'), true);
  assert.deepEqual(calls(s.api, 'worktreeUnreachable'), [['/w/d']]);
  assert.match(s.dialogs[0].opts.message, /Its HEAD is detached at bbbbbbb with 3 commits that no branch or tag points at: they will be lost\.\n/);

  const one = await setup({ worktreeUnreachable: () => ({ count: 1 }) }, [false], { worktrees: [MAIN, d] });
  await one.F.removeWorktree(one.store, '/w/d');
  assert.match(one.dialogs[0].opts.message, /with 1 commit that no branch or tag points at: it will be lost\./);

  const none = await setup({}, [false], { worktrees: [MAIN, d] }); // the harness default: {count: 0}
  await none.F.removeWorktree(none.store, '/w/d');
  assert.equal(calls(none.api, 'worktreeUnreachable').length, 1);
  assert.doesNotMatch(none.dialogs[0].opts.message, /detached|lost/);

  for (const h of [() => { throw err('git', 'no'); }, () => ({}), () => ({ count: -1 })]) {
    const f = await setup({ worktreeUnreachable: h }, [false], { worktrees: [MAIN, d] });
    await f.F.removeWorktree(f.store, '/w/d');
    assert.match(f.dialogs[0].opts.message, /detached at bbbbbbb: commits that no branch or tag points at can be lost/);
    assert.deepEqual(f.errors(), [], 'a failed count is not toasted');
  }
});

test('removeWorktree: worktree-busy (a rebase in progress there) is reported once and never offers a force delete', async () => {
  const msg = 'A rebase is in progress in /w/x: finish or abort it first';
  const s = await setup({ removeWorktree: () => { throw err('worktree-busy', msg); } }, [true, true]);
  assert.equal(await s.F.removeWorktree(s.store, '/w/x'), false);
  assert.equal(s.dialogs.length, 1, 'only the first confirm');
  assert.deepEqual(calls(s.api, 'removeWorktree'), [['/w/x', {}]]);
  assert.deepEqual(s.errors().map((e) => e.message), [msg]);
  assert.deepEqual(s.notices(), []);
});

test('removeWorktree: declined confirm writes nothing', async () => {
  const s = await setup({ removeWorktree: () => true }, [false]);
  assert.equal(await s.F.removeWorktree(s.store, '/w/x'), false);
  assert.deepEqual(calls(s.api, 'removeWorktree'), []);
});

test('removeWorktree: dirty asks again, then force-deletes (submodules in the wording)', async () => {
  let n = 0;
  const s = await setup({ removeWorktree: () => { if (++n === 1) throw err('worktree-dirty', 'dirty', { submodules: true }); return true; } }, [true, true]);
  assert.equal(await s.F.removeWorktree(s.store, '/w/x'), true);
  assert.deepEqual(calls(s.api, 'removeWorktree'), [['/w/x', {}], ['/w/x', { force: true }]]);
  const f = s.dialogs[1];
  assert.equal(f.opts.title, 'Worktree has changes');
  assert.equal(f.opts.confirmLabel, 'Force Delete');
  assert.equal(f.opts.danger, true);
  assert.match(f.opts.message, /has modified or untracked files or submodules\. Delete it anyway\?/);
  assert.deepEqual(s.errors(), [], 'the dirty error was not toasted');
  assert.deepEqual(s.notices(), ['Deleted worktree x']);

  n = 0;
  const t = await setup({ removeWorktree: () => { if (++n === 1) throw err('worktree-dirty', 'dirty'); return true; } }, [true, true]);
  await t.F.removeWorktree(t.store, '/w/x');
  assert.doesNotMatch(t.dialogs[1].opts.message, /submodules/);
});

test('removeWorktree: the force confirm warns about unpushed submodule commits only when there are submodules', async () => {
  let n = 0;
  const s = await setup({ removeWorktree: () => { if (++n === 1) throw err('worktree-dirty', 'dirty', { submodules: true }); return true; } }, [true, false]);
  await s.F.removeWorktree(s.store, '/w/x');
  assert.match(s.dialogs[1].opts.message, /Commits in its submodules that were not pushed are lost too\.$/);
  n = 0;
  const t = await setup({ removeWorktree: () => { if (++n === 1) throw err('worktree-dirty', 'dirty'); return true; } }, [true, false]);
  await t.F.removeWorktree(t.store, '/w/x');
  assert.doesNotMatch(t.dialogs[1].opts.message, /not pushed/);
});

test('a failed worktree list is reported with its own error, not as "not found"', async () => {
  const s = await setup({}, []);
  s.api.handlers.worktrees = () => { throw err('unsafe-repo', 'unsafe repository'); };
  s.dialogs.length = 0;
  for (const run of [() => s.F.removeWorktree(s.store, '/w/x'), () => s.F.lockWorktree(s.store, '/w/x'), () => s.F.unlockWorktree(s.store, '/w/x')]) {
    s.toasts.length = 0;
    assert.equal(await run(), false);
    assert.deepEqual(s.errors().map((e) => e.message), ['unsafe repository']);
    assert.equal(s.dialogs.length, 0, 'no "Worktree not found" alert');
  }
});

test('removeWorktree: a declined force stops; other errors are reported once', async () => {
  const s = await setup({ removeWorktree: () => { throw err('worktree-dirty', 'dirty'); } }, [true, false]);
  assert.equal(await s.F.removeWorktree(s.store, '/w/x'), false);
  assert.equal(calls(s.api, 'removeWorktree').length, 1);
  assert.deepEqual(s.notices(), []);

  const t = await setup({ removeWorktree: () => { throw err('boom', 'git said no'); } }, [true]);
  assert.equal(await t.F.removeWorktree(t.store, '/w/x'), false);
  assert.deepEqual(t.errors().map((e) => e.message), ['git said no']);
});

test('removeWorktree: refusals and a missing entry alert without a write', async () => {
  const locked = wt({ path: '/w/l', locked: true, lockReason: 'usb' });
  const s = await setup({ removeWorktree: () => true }, [], { worktrees: [MAIN, locked] });
  for (const [path, title, msg] of [
    ['/w/main', "Can't delete this worktree", "The main worktree can't be deleted"],
    ['/w/l', "Can't delete this worktree", 'Locked (usb): unlock it first'],
    ['/w/gone', 'Worktree not found', 'It was removed or moved meanwhile.'],
  ]) {
    s.dialogs.length = 0;
    assert.equal(await s.F.removeWorktree(s.store, path), false, path);
    assert.deepEqual([s.dialogs[0].type, s.dialogs[0].opts.title, s.dialogs[0].opts.message], ['alert', title, msg]);
  }
  assert.deepEqual(calls(s.api, 'removeWorktree'), []);
  assert.equal(await s.F.removeWorktree(s.store, ''), false);
});

// ------------------------------------------------------------------ pruneWorktrees

test('pruneWorktrees: nothing to prune is a notice', async () => {
  const s = await setup({ worktreePrunePreview: () => ({ entries: [] }) });
  assert.equal(await s.F.pruneWorktrees(s.store), false);
  assert.deepEqual(s.notices(), ['Nothing to prune']);
  assert.equal(s.dialogs.length, 0);
});

test('pruneWorktrees: confirm lists the entries, then prunes', async () => {
  const entries = [{ id: 'a', reason: 'gitdir file points to non-existent location' }, { id: 'b', reason: 'gone' }];
  const s = await setup({ worktreePrunePreview: () => ({ entries }), pruneWorktrees: () => true }, [true]);
  assert.equal(await s.F.pruneWorktrees(s.store), true);
  const o = s.dialogs[0].opts;
  assert.equal(o.title, 'Prune worktrees?');
  assert.equal(o.confirmLabel, 'Prune');
  assert.equal(o.detail, 'a: gitdir file points to non-existent location\nb: gone');
  assert.match(o.message, /^Remove git's records of 2 worktrees whose folder is gone\?/);
  assert.deepEqual(calls(s.api, 'pruneWorktrees'), [[]]);
  assert.deepEqual(s.notices(), ['Pruned 2 worktrees'], 'no entries returned: the preview count');

  const t = await setup({ worktreePrunePreview: () => ({ entries }), pruneWorktrees: () => true }, [false]);
  assert.equal(await t.F.pruneWorktrees(t.store), false);
  assert.deepEqual(calls(t.api, 'pruneWorktrees'), []);
});

test('pruneWorktrees: the notice counts the entries the prune returned, not the preview', async () => {
  const preview = [{ id: 'a', reason: 'gone' }];
  const s = await setup({ worktreePrunePreview: () => ({ entries: preview }), pruneWorktrees: () => ({ entries: [...preview, { id: 'b', reason: 'gone' }, { id: 'c', reason: 'gone' }] }) }, [true]);
  assert.equal(await s.F.pruneWorktrees(s.store), true);
  assert.match(s.dialogs[0].opts.message, /records of 1 worktree whose/);
  assert.deepEqual(s.notices(), ['Pruned 3 worktrees']);

  const t = await setup({ worktreePrunePreview: () => ({ entries: preview }), pruneWorktrees: () => ({ entries: [] }) }, [true]);
  await t.F.pruneWorktrees(t.store);
  assert.deepEqual(t.notices(), ['Nothing was pruned']);
});

test('pruneWorktrees: entries that appear after the confirm are asked about before anything is written', async () => {
  const a = { id: 'a', reason: 'gone' };
  const b = { id: 'b', reason: 'drive unplugged' };
  let n = 0;
  const s = await setup({ worktreePrunePreview: () => ({ entries: ++n === 1 ? [a] : [a, b] }), pruneWorktrees: () => ({ entries: [a, b] }) }, [true, true]);
  assert.equal(await s.F.pruneWorktrees(s.store), true);
  assert.equal(s.dialogs.length, 2);
  assert.equal(s.dialogs[1].opts.detail, 'b: drive unplugged', 'only the new entries are listed');
  assert.deepEqual(calls(s.api, 'pruneWorktrees'), [[]]);
  assert.deepEqual(s.notices(), ['Pruned 2 worktrees']);

  n = 0;
  const t = await setup({ worktreePrunePreview: () => ({ entries: ++n === 1 ? [a] : [a, b] }), pruneWorktrees: () => true }, [true, false]);
  assert.equal(await t.F.pruneWorktrees(t.store), false);
  assert.deepEqual(calls(t.api, 'pruneWorktrees'), [], 'declining the second ask writes nothing');

  const u = await setup({ worktreePrunePreview: () => ({ entries: [a] }), pruneWorktrees: () => true }, [true]);
  await u.F.pruneWorktrees(u.store);
  assert.equal(u.dialogs.length, 1, 'an unchanged preview asks once');
  assert.equal(calls(u.api, 'worktreePrunePreview').length, 2);

  let m = 0;
  const v = await setup({ worktreePrunePreview: () => { if (++m === 2) throw err('boom', 'recheck failed'); return { entries: [a] }; }, pruneWorktrees: () => true }, [true]);
  assert.equal(await v.F.pruneWorktrees(v.store), false);
  assert.deepEqual(calls(v.api, 'pruneWorktrees'), []);
  assert.deepEqual(v.errors().map((e) => e.message), ['recheck failed']);
});

test('pruneWorktrees: a failing preview is reported', async () => {
  const s = await setup({ worktreePrunePreview: () => { throw err('boom', 'no preview'); } });
  assert.equal(await s.F.pruneWorktrees(s.store), false);
  assert.deepEqual(s.errors().map((e) => e.message), ['no preview']);
});

// ------------------------------------------------------------------ lock / unlock

test('lockWorktree: the prompt, reason trimming, validation and cancel', async () => {
  const s = await setup({ lockWorktree: () => true }, ['  on usb  ']);
  assert.equal(await s.F.lockWorktree(s.store, '/w/x'), true);
  const o = s.dialogs[0].opts;
  assert.equal(s.dialogs[0].type, 'prompt');
  assert.deepEqual([o.title, o.label, o.okLabel], ['Lock worktree', 'Reason (optional)', 'Lock']);
  assert.match(o.message, /^Lock \/w\/x\? Git won't prune, move or delete/);
  assert.equal(o.validate(''), null);
  assert.equal(o.validate('a'.repeat(200)), null);
  assert.ok(o.validate('a'.repeat(201)));
  assert.ok(o.validate('a\nb'));
  assert.equal(o.validate('a\tb'), "The reason can't contain control characters (such as tabs)", 'main rejects every \\p{Cc}');
  assert.ok(o.validate('a\u0007b'));
  assert.ok(o.validate('a\u007fb'));
  assert.equal(o.validate('  on usb\t'), null, 'trimmed first, as main does');
  assert.equal(o.validate(` ${'a'.repeat(200)} `), null);
  assert.deepEqual(calls(s.api, 'lockWorktree'), [['/w/x', { reason: 'on usb' }]]);
  assert.deepEqual(s.notices(), ['Locked worktree x']);

  const t = await setup({ lockWorktree: () => true }, ['   ']);
  assert.equal(await t.F.lockWorktree(t.store, '/w/x'), true);
  assert.deepEqual(calls(t.api, 'lockWorktree'), [['/w/x', {}]]);

  const u = await setup({ lockWorktree: () => true }, [null]);
  assert.equal(await u.F.lockWorktree(u.store, '/w/x'), false);
  assert.deepEqual(calls(u.api, 'lockWorktree'), []);
});

test('lockWorktree / unlockWorktree: refused for main, missing entries alert', async () => {
  const s = await setup({ lockWorktree: () => true, unlockWorktree: () => true });
  assert.equal(await s.F.lockWorktree(s.store, '/w/main'), false);
  assert.equal(s.dialogs[0].opts.title, "Can't lock this worktree");
  assert.equal(await s.F.unlockWorktree(s.store, '/w/main'), false);
  assert.equal(s.dialogs[1].opts.title, "Can't unlock this worktree");
  assert.equal(await s.F.unlockWorktree(s.store, '/w/gone'), false);
  assert.equal(s.dialogs[2].opts.title, 'Worktree not found');
  assert.deepEqual(s.api.writes().map((c) => c.op), []);
});

test('unlockWorktree: no confirmation, a write and a notice; an error is reported', async () => {
  const l = wt({ locked: true });
  const s = await setup({ unlockWorktree: () => true }, [], { worktrees: [MAIN, l] });
  assert.equal(await s.F.unlockWorktree(s.store, '/w/x'), true);
  assert.equal(s.dialogs.length, 0);
  assert.deepEqual(calls(s.api, 'unlockWorktree'), [['/w/x']]);
  assert.deepEqual(s.notices(), ['Unlocked worktree x']);

  const t = await setup({ unlockWorktree: () => { throw err('nothing', 'It is not locked'); } }, [], { worktrees: [MAIN, l] });
  assert.equal(await t.F.unlockWorktree(t.store, '/w/x'), false);
  assert.deepEqual(t.errors().map((e) => e.message), ['It is not locked']);
});

test('write flows do nothing while busy', async () => {
  const s = await setup({ removeWorktree: () => true });
  s.store.set({ busy: true });
  assert.equal(await s.F.removeWorktree(s.store, '/w/x'), false);
  assert.equal(await s.F.pruneWorktrees(s.store), false);
  assert.equal(await s.F.lockWorktree(s.store, '/w/x'), false);
  assert.equal(await s.F.unlockWorktree(s.store, '/w/x'), false);
  assert.equal(s.dialogs.length, 0);
});

// ------------------------------------------------------------------ reveal / copy

test('revealWorktree: calls api.app.revealWorktree, also while busy; errors are shown', async () => {
  const s = await setup();
  const seen = [];
  s.win.api.app.revealWorktree = async (p) => { seen.push(p); };
  s.store.set({ busy: true });
  assert.equal(await s.F.revealWorktree(s.store, '/w/x'), true);
  assert.deepEqual(seen, ['/w/x']);
  assert.equal(await s.F.revealWorktree(s.store, ''), false);
  s.win.api.app.revealWorktree = async () => { throw { message: 'Not a worktree of this repository', kind: 'not-a-worktree' }; };
  assert.equal(await s.F.revealWorktree(s.store, '/etc'), false);
  assert.deepEqual(s.errors().map((e) => e.message), ['Not a worktree of this repository']);
  delete s.win.api.app.revealWorktree;
  assert.equal(await s.F.revealWorktree(s.store, '/w/x'), false);
});

test('copyWorktreePath: writes the path to the clipboard and notifies; a failure is shown', async () => {
  const s = await setup();
  const seen = [];
  s.win.api.clipboard = { writeText: async (t) => { seen.push(t); } };
  s.store.set({ busy: true });
  assert.equal(await s.F.copyWorktreePath(s.store, '/w/x'), true);
  assert.deepEqual(seen, ['/w/x']);
  assert.deepEqual(s.notices(), ['Copied /w/x']);
  s.win.api.clipboard = { writeText: async () => { throw new Error('denied'); } };
  assert.equal(await s.F.copyWorktreePath(s.store, '/w/x'), false);
  assert.deepEqual(s.errors().map((e) => e.message), ['denied']);
  s.win.api.clipboard = undefined;
  assert.equal(await s.F.copyWorktreePath(s.store, '/w/x'), false);
  assert.equal(await s.F.copyWorktreePath(s.store, ''), false);
});
