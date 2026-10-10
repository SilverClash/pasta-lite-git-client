'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuitGuard, createQuitFlow, confirmWith, dialogOptions } = require('../src/quit-guard');

/**
 * A fake runner. Each op: {op, write = true, started = true, onCancel: 'settle' | 'needs-kill' |
 * 'ignore'}. 'settle': its git dies on cancel; 'needs-kill': its git ignores SIGTERM and dies on
 * killChildren's SIGKILL; 'ignore': an uncancellable phase, it ends on finish(op) or kill {all}.
 */
function fakeRunner(list) {
  let ops = list.map((o) => ({ write: true, started: true, onCancel: 'settle', ...o, cancelled: false }));
  const waiters = [];
  const calls = { cancelAll: 0, kills: [] };
  const remove = (pred) => {
    ops = ops.filter((o) => !pred(o));
    if (!ops.length) waiters.splice(0).forEach((r) => r());
  };
  const runner = {
    running: () => ops.map(({ op, write, started, cancelled }) => ({ repo: '/r', op, write, started, cancelled })),
    cancelAll() {
      calls.cancelAll++;
      let n = 0;
      for (const o of ops) if (!o.cancelled) { o.cancelled = true; n++; }
      setImmediate(() => remove((o) => o.cancelled && o.onCancel === 'settle'));
      return n;
    },
    settled: () => (ops.length ? new Promise((r) => waiters.push(r)) : Promise.resolve()),
  };
  const killChildren = (o = {}) => {
    calls.kills.push(o);
    const hit = ops.filter((x) => (o.all ? true : x.cancelled && x.onCancel === 'needs-kill'));
    setImmediate(() => remove((x) => hit.includes(x)));
    return hit.length;
  };
  const finish = (name) => remove((o) => o.op === name);
  return { runner, killChildren, finish, calls };
}

/** A fake dialog answering from `answers` ({running: [bool...], unsafe: [bool...]}), recording each ask. */
function fakeConfirm(answers) {
  const asked = [];
  const confirm = async (kind, names) => {
    asked.push([kind, names]);
    return answers[kind].shift();
  };
  return { confirm, asked };
}

const guard = (f, c, o = {}) => createQuitGuard({
  runner: f.runner, killChildren: f.killChildren, confirm: c.confirm, boundMs: 60, graceMs: 20, ...o,
});

test('nothing running: quit at once, no dialog; a running read alone does not ask and is cancelled', async () => {
  let f = fakeRunner([]);
  let c = fakeConfirm({});
  let g = guard(f, c);
  assert.equal(g.needsConfirm(), false);
  assert.equal(await g.run(), 'quit');
  assert.deepEqual(c.asked, []);

  f = fakeRunner([{ op: 'status', write: false }]);
  c = fakeConfirm({});
  g = guard(f, c);
  assert.equal(g.needsConfirm(), false);
  g.quitNow();
  assert.equal(f.calls.cancelAll, 1);
  assert.equal(f.runner.running()[0].cancelled, true);
  assert.deepEqual(c.asked, []);
});

test('Keep Running: nothing is cancelled and the app stays', async () => {
  const f = fakeRunner([{ op: 'push' }]);
  const c = fakeConfirm({ running: [false] });
  const g = guard(f, c);
  assert.equal(g.needsConfirm(), true);
  assert.equal(await g.run(), 'stay');
  assert.deepEqual(c.asked, [['running', 'push']]);
  assert.equal(f.calls.cancelAll, 0);
  assert.deepEqual(f.calls.kills, []);
  assert.equal(f.runner.running().length, 1);
});

test('Cancel and Quit: every running and queued op is cancelled; quit once they settled, no kill needed', async () => {
  const f = fakeRunner([{ op: 'push' }, { op: 'fetch', started: false }, { op: 'push', started: false }, { op: 'log', write: false }]);
  const c = fakeConfirm({ running: [true] });
  const logs = [];
  assert.equal(await guard(f, c, { log: (m) => logs.push(m) }).run(), 'quit');
  assert.deepEqual(c.asked, [['running', 'push, fetch']]);
  assert.equal(f.calls.cancelAll, 1);
  assert.deepEqual(f.calls.kills, []);
  assert.deepEqual(f.runner.running(), []);
  assert.deepEqual(logs, ['quitting: cancelled push, fetch']);
});

test('a cancelled git that ignores SIGTERM is SIGKILLed after the bound (cancelled ones only)', async () => {
  const f = fakeRunner([{ op: 'push', onCancel: 'needs-kill' }]);
  const c = fakeConfirm({ running: [true] });
  const t0 = Date.now();
  assert.equal(await guard(f, c).run(), 'quit');
  assert.ok(Date.now() - t0 >= 50, 'waited for the bound first');
  assert.deepEqual(f.calls.kills, [{ signal: 'SIGKILL' }]);
  assert.deepEqual(c.asked, [['running', 'push']]);
});

test('an uncancellable op that finishes within the bound is waited for, never killed', async () => {
  const f = fakeRunner([{ op: 'undo', onCancel: 'ignore' }]);
  const c = fakeConfirm({ running: [true] });
  setTimeout(() => f.finish('undo'), 20);
  assert.equal(await guard(f, c).run(), 'quit');
  assert.deepEqual(c.asked, [['running', 'undo']]);
  assert.deepEqual(f.calls.kills, []);
});

test('an uncancellable op outliving the bound: ask Quit / Wait; Wait waits another bound and asks again; Quit kills', async () => {
  const f = fakeRunner([{ op: 'undo', onCancel: 'ignore' }, { op: 'stage', started: false }]);
  const c = fakeConfirm({ running: [true], unsafe: [false, true] });
  assert.equal(await guard(f, c).run(), 'quit');
  // the queued stage (skipped once undo ends) isn't named; the undo is
  assert.deepEqual(c.asked, [['running', 'undo, stage'], ['unsafe', 'undo'], ['unsafe', 'undo']]);
  // the SIGKILL pass spares uncancellable git (it matched nothing), then Quit kills everything
  assert.deepEqual(f.calls.kills, [{ signal: 'SIGKILL' }, { all: true, signal: 'SIGTERM' }]);
  assert.deepEqual(f.runner.running(), []);
});

test('Wait: quits without asking again once the op finishes during the wait', async () => {
  const f = fakeRunner([{ op: 'discard', onCancel: 'ignore' }]);
  const c = fakeConfirm({ running: [true], unsafe: [false] });
  const answered = c.confirm;
  c.confirm = async (kind, names) => {
    const r = await answered(kind, names);
    if (kind === 'unsafe') setTimeout(() => f.finish('discard'), 20);
    return r;
  };
  assert.equal(await guard(f, c).run(), 'quit');
  assert.deepEqual(c.asked, [['running', 'discard'], ['unsafe', 'discard']]);
  assert.deepEqual(f.calls.kills, [{ signal: 'SIGKILL' }]);
});

test('smoke mode never asks: it cancels, logs, and quits anyway after the bound', async () => {
  let f = fakeRunner([{ op: 'push' }]);
  const c = fakeConfirm({});
  let logs = [];
  assert.equal(await guard(f, c, { smoke: true, log: (m) => logs.push(m) }).run(), 'quit');
  assert.deepEqual(logs, ['quitting: cancelling running git operations (push)', 'quitting: cancelled push']);
  assert.equal(f.calls.cancelAll, 1);

  f = fakeRunner([{ op: 'undo', onCancel: 'ignore' }]);
  logs = [];
  assert.equal(await guard(f, c, { smoke: true, log: (m) => logs.push(m) }).run(), 'quit');
  assert.deepEqual(c.asked, []);
  assert.equal(logs.length, 2);
  assert.match(logs[1], /undo did not finish within 60 ms; quitting anyway/);
  assert.deepEqual(f.calls.kills, [{ signal: 'SIGKILL' }, { all: true, signal: 'SIGTERM' }]);
});

test('if the SIGTERM on Quit is not enough, SIGKILL follows', async () => {
  const f = fakeRunner([{ op: 'undo', onCancel: 'ignore' }]);
  const kills = [];
  f.killChildren = (o) => { kills.push(o); if (o.all && o.signal === 'SIGKILL') setImmediate(() => f.finish('undo')); return 1; };
  const c = fakeConfirm({ running: [true], unsafe: [true] });
  assert.equal(await guard(f, c).run(), 'quit');
  assert.deepEqual(kills, [{ signal: 'SIGKILL' }, { all: true, signal: 'SIGTERM' }, { all: true, signal: 'SIGKILL' }]);
});

test('dialog wording: the safe choice (Keep Running / Wait) is the default and the cancel', () => {
  const a = dialogOptions('running', 'push');
  assert.equal(a.message, 'A git operation is still running (push)');
  assert.deepEqual(a.buttons, ['Cancel and Quit', 'Keep Running']);
  assert.equal(a.defaultId, 1);
  assert.equal(a.cancelId, 1);
  const b = dialogOptions('unsafe', 'undo');
  assert.match(b.message, /\(undo\)/);
  assert.match(b.detail, /half-restored/);
  assert.deepEqual(b.buttons, ['Quit', 'Wait']);
  assert.equal(b.defaultId, 1);
  assert.equal(b.cancelId, 1);
});

// ---------------------------------------------------------------- createQuitFlow / confirmWith

/** A fake guard: run() resolves the next of `decisions` when release() is called (or throws `fail`). */
function fakeGuard({ needs = true, fail = null } = {}) {
  const pending = [];
  const g = {
    runs: 0,
    needs,
    needsConfirm: () => g.needs,
    run() {
      g.runs++;
      if (fail) return Promise.reject(fail);
      return new Promise((resolve) => pending.push(resolve));
    },
    release: (decision) => pending.shift()(decision),
  };
  return g;
}
const fakeLog = () => {
  const records = [];
  return { records, info: (msg, f) => records.push(['info', msg, f]), error: (msg, f) => records.push(['error', msg, f]) };
};
const tick = () => new Promise((r) => setImmediate(r));

test('quit flow: one decision at a time; quit once it says quit, and from then on nothing asks', async () => {
  const g = fakeGuard();
  const log = fakeLog();
  let quits = 0;
  const flow = createQuitFlow({ guard: g, quit: () => { quits++; }, log, running: () => ['push'] });
  assert.equal(flow.needsConfirm(), true);
  const a = flow.request();
  const b = flow.request();
  assert.equal(a, b, 'a second request joins the decision in progress');
  assert.equal(g.runs, 1);
  g.release('quit');
  await a;
  assert.equal(quits, 1);
  assert.equal(flow.approved, true);
  assert.equal(flow.needsConfirm(), false, 'approved: before-quit and the window close let the quit through');
  assert.deepEqual(log.records, [['info', 'quit decision', { decision: 'quit', running: ['push'] }]]);
});

test('quit flow: stay keeps the app and asks again next time; nothing running needs no confirm', async () => {
  const g = fakeGuard();
  let quits = 0;
  const flow = createQuitFlow({ guard: g, quit: () => { quits++; } });
  const a = flow.request();
  g.release('stay');
  await a;
  assert.equal(quits, 0);
  assert.equal(flow.approved, false);
  assert.equal(flow.needsConfirm(), true);
  const b = flow.request();
  assert.notEqual(a, b, 'a new decision');
  g.release('stay');
  await b;
  g.needs = false;
  assert.equal(flow.needsConfirm(), false);
});

test('quit flow: a guard that fails is logged and quits anyway', async () => {
  const err = new Error('boom');
  const log = fakeLog();
  let quits = 0;
  const flow = createQuitFlow({ guard: fakeGuard({ fail: err }), quit: () => { quits++; }, log });
  await flow.request();
  await tick();
  assert.equal(quits, 1);
  assert.deepEqual(log.records[0], ['error', 'quit guard failed; quitting', { err }]);
  assert.equal(log.records[1][2].decision, 'quit');
});

test('confirmWith: asks with the dialog wording of the kind; true = the first button', async () => {
  const asked = [];
  const confirm = confirmWith(async (opts) => { asked.push(opts); return opts.buttons[0] === 'Cancel and Close'; });
  assert.equal(await confirm('close', 'push'), true);
  assert.equal(await confirm('running', 'push'), false);
  assert.deepEqual(asked, [dialogOptions('close', 'push'), dialogOptions('running', 'push')]);
});

test('clone wording: quitting or closing a tab says what happens to the folder; an unkilled clone gets its own UNSAFE detail', () => {
  for (const names of ['clone', 'push, clone']) {
    assert.match(dialogOptions('running', names).detail, /^Quitting cancels it\. .* A clone that is cancelled leaves no folder behind: its partial folder is removed, at the next start if needed\.$/, names);
    assert.match(dialogOptions('close', names).detail, /Closing the tab cancels it\. .* partial folder is removed/, names);
  }
  for (const names of ['push', 'cloneX', 'fetch, pull']) {
    assert.doesNotMatch(dialogOptions('running', names).detail, /clone/, names);
    assert.doesNotMatch(dialogOptions('close', names).detail, /clone/, names);
  }
  const unsafe = dialogOptions('unsafe', 'clone');
  assert.match(unsafe.message, /\(clone\)/);
  assert.equal(unsafe.detail, 'Git is still stopping. Quitting now may leave a partial folder: the next start removes it if its download hadn\'t finished, and otherwise leaves it for you to check.');
  assert.deepEqual(unsafe.buttons, ['Quit', 'Wait']);
  assert.match(dialogOptions('unsafe', 'undo').detail, /half-restored/, 'undo / discard keep their text');
  assert.match(dialogOptions('unsafe', 'undo, clone').detail, /half-restored/, 'restoring files is the graver risk');
});

test('the quit guard names a running clone with the clone wording (confirm gets its op name)', async () => {
  const asked = [];
  const runner = { running: () => [{ op: 'clone', write: true, started: true }], cancelAll: () => 1, settled: async () => {} };
  const guard = createQuitGuard({ runner, killChildren: () => 0, confirm: async (kind, names) => { asked.push(dialogOptions(kind, names)); return false; } });
  assert.equal(await guard.run(), 'stay');
  assert.match(asked[0].detail, /partial folder is removed/);
});
