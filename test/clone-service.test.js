'use strict';
// The clone use cases (src/clone-service.js) over fakes: runner, opening, clone.json, cleanup and
// the folder dialog. No git runs (test/clone.test.js clones for real).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');
const { createCloneService } = require('../src/clone-service');
const { kindError } = require('../src/exec');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((r) => setImmediate(r));

function session(id) {
  return { id, closed: false, repo: null, sent: [], send(channel, payload) { if (!this.closed) this.sent.push([channel, payload]); } };
}

/** A service over fakes. `homeDir` is what displays shorten to '~'. */
function setup({ last = null, homeDir = '/nowhere', picks = [], removing = [], openAnswers = [] } = {}) {
  const calls = [];
  const runs = [];
  const prefs = {
    last,
    lastParent: async () => prefs.last,
    setLastParent: async (abs) => { calls.push(['setLastParent', abs]); prefs.last = abs; },
  };
  const runner = {
    run(repo, name, args, o) {
      const d = deferred();
      runs.push({ repo, name, args, o, ...d });
      return d.promise;
    },
  };
  const opening = {
    async openCloned(s, dir, o = {}) {
      calls.push(['openCloned', s.id, dir, !!o.newTab]);
      const a = openAnswers.length ? openAnswers.shift() : { info: { root: dir, name: path.basename(dir) } };
      if (a instanceof Error) throw a;
      return a;
    },
    rememberRecent: async (dir) => { calls.push(['rememberRecent', dir]); },
  };
  const removals = [];
  const journal = []; // ['journal' | 'forget', made]
  const cleanup = {
    outcome: 'removed',
    journal: async (made) => { journal.push(['journal', made]); },
    forget: async (made) => { journal.push(['forget', made]); },
    remove(made) { removals.push(made); return Promise.resolve(cleanup.outcome); },
    running: () => removing.map((abs) => ({ abs })),
  };
  const logged = [];
  const service = createCloneService({
    runner, opening, prefs, cleanup,
    pickFolder: async (o) => { calls.push(['pickFolder', o.defaultPath]); return picks.length ? picks.shift() : null; },
    log: { info: (m, f) => logged.push([m, f]), warn: (m, f) => logged.push([m, f]) },
    platform: process.platform,
    homeDir: () => homeDir,
  });
  return { service, calls, runs, prefs, removals, journal, cleanup, logged };
}

const doneRes = (root, o = {}) => ({ status: 'done', root, name: path.basename(root), submodules: false, empty: false, ...o });

test('the parent: the one last picked; none until the user picks one (never the home folder by default)', async () => {
  const a = h.tmpDir();
  assert.deepEqual((await setup({ last: a }).service.defaults(session(1))).parent, { display: a, chars: a.length });
  assert.equal((await setup({}).service.defaults(session(1))).parent, null, 'nothing picked yet: no parent, the form asks for one');
  await assert.rejects(setup({}).service.clone(session(1), { url: 'https://h/r', name: 'r', parent: '~' }, 'x'), { kind: 'not-found', state: 'parent' }, 'and main refuses to guess');
  const shown = await setup({ last: a, homeDir: path.dirname(a) }).service.defaults(session(1));
  assert.equal(shown.parent.display, `~${path.sep}${path.basename(a)}`);
});

test('pickParent: main\'s dialog from the current parent; the choice is saved at once; cancel changes nothing', async () => {
  const [a, b] = [h.tmpDir(), h.tmpDir()];
  const t = setup({ last: a, picks: [b, null] });
  assert.deepEqual(await t.service.pickParent(session(1)), { display: b, chars: b.length });
  assert.deepEqual(t.calls, [['pickFolder', a], ['setLastParent', b]]);
  assert.equal(await t.service.pickParent(session(1)), null);
  assert.equal(t.prefs.last, b);
});

test('clone: a typed URL runs the app op in the runner for <parent>/<name>, owned by the tab, then opens it', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent });
  const s = session(7);
  const p = t.service.clone(s, { url: ' https://h/o/r.git ', name: 'r', parent }, 'op-1');
  await flush();
  assert.equal(t.runs.length, 1);
  const run = t.runs[0];
  const target = path.join(parent, 'r');
  assert.equal(run.repo, target);
  assert.equal(run.name, 'clone');
  assert.deepEqual(run.args[0], { source: 'https://h/o/r.git', parent, name: 'r' }, 'the URL as parseCloneUrl accepted it');
  assert.deepEqual(run.o, { opId: 't7:op-1', owner: 7 });
  run.resolve(doneRes(target));
  const out = await p;
  assert.deepEqual(out, { status: 'done', target, name: 'r', submodules: false, empty: false, opened: { root: target, name: 'r' } });
  assert.deepEqual(t.calls, [['openCloned', 7, target, false]]);
});

test('progress goes to the tab that asked only, with its own opId', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent });
  const [s1, s2] = [session(1), session(2)];
  const p = t.service.clone(s1, { url: 'git@host:o/r.git', name: 'r', parent }, 'a');
  await flush();
  const { onProgress } = t.runs[0].args[1];
  onProgress({ phase: 'Receiving objects', percent: 5, current: 1, total: 20, bytes: null, rate: null, done: false, remote: false });
  assert.deepEqual(s1.sent, [['clone-progress', { opId: 'a', phase: 'Receiving objects', percent: 5, current: 1, total: 20, bytes: null, rate: null, done: false, remote: false }]]);
  assert.deepEqual(s2.sent, []);
  t.runs[0].resolve(doneRes(path.join(parent, 'r')));
  await p;
});

test('refused before the runner: a changed parent (stale), no parent, a typed local path, a bad name; logged by kind only', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent });
  const s = session(1);
  const ask = (o) => t.service.clone(s, { url: 'https://h/r', name: 'r', parent, ...o }, 'x');
  await assert.rejects(ask({ parent: '~/elsewhere' }), { kind: 'stale' });
  await assert.rejects(ask({ url: '/srv/secret.git' }), { kind: 'invalid-args', message: /Enter a remote URL/ });
  await assert.rejects(ask({ url: 'ext::sh -c x' }), { kind: 'invalid-args' });
  await assert.rejects(ask({ name: '../x' }), { kind: 'invalid-args' });
  await assert.rejects(ask({ name: '.git' }), { kind: 'invalid-args' });
  await assert.rejects(setup({}).service.clone(s, { url: 'https://h/r', name: 'r', parent: '' }, 'x'), { kind: 'not-found' });
  assert.equal(t.runs.length, 0);
  assert.ok(t.logged.every(([m, f]) => m === 'clone refused' && !JSON.stringify(f).includes('secret') && !JSON.stringify(f).includes(parent)));
});

test('in-progress: a second clone from the same tab, and a target whose previous folder is still being removed', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent, removing: [path.join(parent, 'old')] });
  const [s1, s2] = [session(1), session(2)];
  const p = t.service.clone(s1, { url: 'https://h/r', name: 'r', parent }, 'a');
  await flush();
  await assert.rejects(t.service.clone(s1, { url: 'https://h/q', name: 'q', parent }, 'b'), { kind: 'in-progress', state: 'clone' });
  const other = t.service.clone(s2, { url: 'https://h/q', name: 'q', parent }, 'b');
  await flush();
  assert.equal(t.runs.length, 2, 'another tab may clone meanwhile');
  const err = await t.service.clone(session(3), { url: 'https://h/old', name: 'old', parent }, 'c').then(() => null, (e) => e);
  assert.equal(err.kind, 'in-progress');
  assert.equal(err.state, 'cleanup');
  assert.equal(err.leftover, path.join(parent, 'old'));
  t.runs[0].resolve(doneRes(path.join(parent, 'r')));
  t.runs[1].resolve(doneRes(path.join(parent, 'q')));
  await Promise.all([p, other]);
});

test('defaults().running: a reloaded page finds its tab\'s clone (opId, target) until it settles', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent, homeDir: parent });
  const s = session(3);
  const p = t.service.clone(s, { url: 'https://h/r', name: 'r', parent: '~' }, 'op-9');
  await flush();
  assert.deepEqual((await t.service.defaults(s)).running, { opId: 'op-9', target: `~${path.sep}r` });
  assert.equal((await t.service.defaults(session(4))).running, null, 'another tab\'s clone is not this tab\'s');
  t.runs[0].reject(kindError('aborted', 'git was cancelled'));
  await assert.rejects(p, { kind: 'aborted' });
  assert.equal((await t.service.defaults(s)).running, null);
});

test('a failed clone: what it made is removed (not awaited); a failed removal tells the page where the leftover is', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent, homeDir: parent });
  const s = session(1);
  const made = { abs: path.join(parent, 'r'), dev: '1', ino: '2' };
  t.cleanup.outcome = 'failed';
  const p = t.service.clone(s, { url: 'https://h/r', name: 'r', parent: '~' }, 'a');
  await flush();
  t.runs[0].reject(Object.assign(kindError('aborted', 'git was cancelled'), { made }));
  await assert.rejects(p, { kind: 'aborted' });
  await flush();
  assert.deepEqual(t.removals, [made]);
  assert.deepEqual(s.sent, [['clone-progress', { opId: 'a', cleanup: 'failed', leftover: `~${path.sep}r` }]]);
  const plain = t.service.clone(s, { url: 'https://h/q', name: 'q', parent: '~' }, 'b');
  await flush();
  t.runs[1].reject(kindError('exists', 'exists'));
  await assert.rejects(plain, { kind: 'exists' });
  assert.equal(t.removals.length, 1, 'nothing made: nothing removed');
});

test('checkout-failed: kept for Open Anyway, by this tab\'s opId only, once', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent });
  const [s, other] = [session(1), session(2)];
  const p = t.service.clone(s, { url: 'https://h/r', name: 'r', parent }, 'a');
  await flush();
  const root = path.join(parent, 'r');
  t.runs[0].resolve({ status: 'checkout-failed', root, name: 'r', submodules: false, empty: false, message: 'error: cannot stat x: File name too long' });
  const out = await p;
  assert.deepEqual(out, { status: 'checkout-failed', target: root, name: 'r', submodules: false, empty: false, opened: null, message: 'error: cannot stat x: File name too long' });
  assert.deepEqual(t.calls, [], 'not opened without the user\'s choice');
  await assert.rejects(t.service.openCloned(other, 'a'), { kind: 'not-found' }, 'another tab can\'t open it');
  await assert.rejects(t.service.openCloned(s, 'b'), { kind: 'not-found' });
  assert.deepEqual(await t.service.openCloned(s, 'a'), { opened: { root, name: 'r' } });
  assert.deepEqual(t.calls, [['openCloned', 1, root, false]]);
  await assert.rejects(t.service.openCloned(s, 'a'), { kind: 'not-found' }, 'once');
});

test('opening: declined, stale (one more try in a new tab), an open that throws (openError), the tab closed meanwhile', async () => {
  const parent = h.tmpDir();
  const root = path.join(parent, 'r');
  const run = async (t, s) => {
    const p = t.service.clone(s, { url: 'https://h/r', name: 'r', parent }, 'a');
    await flush();
    return { p, run: t.runs[t.runs.length - 1] };
  };
  // Declined: asked once, not opened.
  let t = setup({ last: parent, openAnswers: [{ info: null, reason: 'declined' }] });
  let r = await run(t, session(1));
  r.run.resolve(doneRes(root));
  assert.equal((await r.p).reason, 'declined');
  assert.deepEqual(t.calls, [['openCloned', 1, root, false]]);
  // Stale with the tab alive: a new tab next to it.
  t = setup({ last: parent, openAnswers: [{ info: null, reason: 'stale' }] });
  r = await run(t, session(1));
  r.run.resolve(doneRes(root));
  assert.deepEqual((await r.p).opened, { root, name: 'r' });
  assert.deepEqual(t.calls, [['openCloned', 1, root, false], ['openCloned', 1, root, true]]);
  // openRepo throws (dubious ownership on a network drive): the clone still succeeded.
  t = setup({ last: parent, openAnswers: [kindError('unsafe-repo', 'detected dubious ownership')] });
  r = await run(t, session(1));
  r.run.resolve(doneRes(root));
  const out = await r.p;
  assert.equal(out.status, 'done');
  assert.equal(out.opened, null);
  assert.equal(out.openError.kind, 'unsafe-repo');
  // The tab (or on macOS the window) closed while the clone ran: it finishes, is added to recent, not opened.
  t = setup({ last: parent });
  const s = session(1);
  r = await run(t, s);
  s.closed = true;
  r.run.resolve(doneRes(root));
  assert.equal((await r.p).reason, 'closed');
  assert.deepEqual(t.calls, [['rememberRecent', root]], 'no openCloned: no tab, no window');
  // Closed during the open itself.
  t = setup({ last: parent, openAnswers: [{ info: null, reason: 'closed' }] });
  r = await run(t, session(1));
  r.run.resolve(doneRes(root));
  assert.equal((await r.p).reason, 'closed');
  assert.deepEqual(t.calls, [['openCloned', 1, root, false], ['rememberRecent', root]]);
});

test('the home folder itself is a parent only once the user picked it in main\'s dialog', async () => {
  const t = setup({ homeDir: os.homedir(), picks: [os.homedir()] });
  assert.equal((await t.service.defaults(session(1))).parent, null);
  assert.equal((await t.service.pickParent(session(1))).display, '~');
  assert.equal((await t.service.defaults(session(1))).parent.display, '~');
});

test('a second submit from the same tab is refused at once, even while the first one is still in its checks', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent });
  const s = session(1);
  const req = { url: 'https://h/r', name: 'r', parent };
  const [a, b] = [t.service.clone(s, req, 'a'), t.service.clone(s, { ...req, name: 'q' }, 'b')];
  await assert.rejects(b, { kind: 'in-progress', state: 'clone' });
  await flush();
  assert.equal(t.runs.length, 1, 'one clone runs');
  t.runs[0].resolve(doneRes(path.join(parent, 'r')));
  await a;
  const c = t.service.clone(s, { ...req, name: 'c' }, 'c'); // free again once the first settled
  await flush();
  assert.equal(t.runs.length, 2);
  t.runs[1].resolve(doneRes(path.join(parent, 'c')));
  await c;
});

test('a cancel that comes before the runner has the clone: it never starts (aborted); after that the runner cancels it', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent });
  const s = session(1);
  const p = t.service.clone(s, { url: 'https://h/r', name: 'r', parent }, 'a');
  assert.equal(t.service.cancelPending(s, 'b'), false, 'another opId');
  assert.equal(t.service.cancelPending(session(2), 'a'), false, 'another tab');
  assert.equal(t.service.cancelPending(s, 'a'), true, 'still in its checks');
  await assert.rejects(p, { kind: 'aborted' });
  assert.equal(t.runs.length, 0, 'the runner never got it');
  assert.equal((await t.service.defaults(s)).last.error.kind, 'aborted');
  const q = t.service.clone(s, { url: 'https://h/r', name: 'r', parent }, 'c');
  await flush();
  assert.equal(t.service.cancelPending(s, 'c'), false, 'the runner has it: app:cancel goes there');
  t.runs[0].reject(kindError('aborted', 'git was cancelled'));
  await assert.rejects(q, { kind: 'aborted' });
});

test('the folder is journalled when made and forgotten when the clone succeeds; a failure hands it to the removal', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent });
  const s = session(1);
  const made = { abs: path.join(parent, 'r'), dev: '1', ino: '2' };
  let p = t.service.clone(s, { url: 'https://h/r', name: 'r', parent }, 'a');
  await flush();
  t.runs[0].args[1].onMade(made);
  assert.deepEqual(t.journal, [['journal', made]], 'pending from the moment it exists');
  t.runs[0].resolve(doneRes(made.abs));
  await p;
  assert.deepEqual(t.journal, [['journal', made], ['forget', made]]);
  assert.deepEqual(t.removals, []);
  t.journal.length = 0;
  p = t.service.clone(s, { url: 'https://h/q', name: 'q', parent }, 'b');
  await flush();
  const q = { abs: path.join(parent, 'q'), dev: '1', ino: '3' };
  t.runs[1].args[1].onMade(q);
  t.runs[1].resolve({ status: 'checkout-failed', root: q.abs, name: 'q', message: 'x' });
  await p;
  assert.deepEqual(t.journal, [['journal', q], ['forget', q]], 'a checkout failure keeps the folder: the user\'s too');
  t.journal.length = 0;
  p = t.service.clone(s, { url: 'https://h/z', name: 'z', parent }, 'c');
  await flush();
  const z = { abs: path.join(parent, 'z'), dev: '1', ino: '4' };
  t.runs[2].args[1].onMade(z);
  t.runs[2].reject(kindError('auth', 'no')); // even without err.made: the journalled folder is removed
  await assert.rejects(p, { kind: 'auth' });
  await flush();
  assert.deepEqual(t.journal, [['journal', z]]);
  assert.deepEqual(t.removals, [z]);
});

test('defaults().last: how this tab\'s last clone ended, for a reloaded page (never another tab\'s)', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent, homeDir: parent });
  const [s, other] = [session(1), session(2)];
  let p = t.service.clone(s, { url: 'git@host:o/r.git', name: 'r', parent: '~' }, 'a');
  await flush();
  assert.deepEqual((await t.service.defaults(s)).running, { opId: 'a', target: `~${path.sep}r` });
  t.runs[0].reject(Object.assign(kindError('host-key', 'Host key verification failed.'), { made: { abs: path.join(parent, 'r'), dev: '1', ino: '2' } }));
  await assert.rejects(p);
  const d = await t.service.defaults(s);
  assert.equal(d.running, null);
  assert.deepEqual({ ...d.last, error: { kind: d.last.error.kind, message: d.last.error.message } }, {
    opId: 'a', req: { url: 'git@host:o/r.git' }, status: 'failed', target: `~${path.sep}r`, name: 'r', opened: false,
    error: { kind: 'host-key', message: 'Host key verification failed.' },
  });
  assert.equal((await t.service.defaults(other)).last, null);
  p = t.service.clone(s, { url: 'https://h/q', name: 'q', parent: '~' }, 'b');
  await flush();
  t.runs[1].resolve(doneRes(path.join(parent, 'q')));
  await p;
  assert.deepEqual((await t.service.defaults(s)).last, { opId: 'b', req: { url: 'https://h/q' }, status: 'done', target: `~${path.sep}q`, name: 'q', opened: true });
});

test('refusals about the parent say so (state): none, or changed', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent });
  const s = session(1);
  await assert.rejects(setup({}).service.clone(s, { url: 'https://h/r', name: 'r', parent: '' }, 'x'), { kind: 'not-found', state: 'parent' });
  await assert.rejects(t.service.clone(s, { url: 'https://h/r', name: 'r', parent: '~/x' }, 'x'), { kind: 'stale', state: 'parent' });
});

test('a tab that closes while the clone is still in its checks gets no clone (no headless run, nothing a guard didn\'t see)', async () => {
  const parent = h.tmpDir();
  let release;
  const t = setup({});
  t.prefs.lastParent = () => new Promise((r) => { release = () => r(parent); }); // the checks wait here, once
  const s = session(1);
  const p = t.service.clone(s, { url: 'https://h/r', name: 'r', parent }, 'a');
  s.closed = true;
  release();
  t.prefs.lastParent = async () => parent;
  await assert.rejects(p, { kind: 'aborted' });
  assert.equal(t.runs.length, 0, 'the runner never got it');
  assert.equal((await t.service.defaults(s)).last, null, 'nothing remembered for a closed tab');
});

test('an unexpected error before the runner is logged (name, code, stack frames; never the URL), a refusal only as a refusal', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent });
  t.prefs.lastParent = async () => { throw Object.assign(new TypeError('cannot read https://secret-host.example/r'), { code: 'EBROKEN' }); };
  const s = session(1);
  await assert.rejects(t.service.clone(s, { url: 'https://secret-host.example/r', name: 'r', parent }, 'a'), TypeError);
  const rec = t.logged.find(([m]) => m === 'clone failed before it started');
  assert.ok(rec, JSON.stringify(t.logged));
  assert.equal(rec[1].name, 'TypeError');
  assert.equal(rec[1].code, 'EBROKEN');
  assert.match(rec[1].stack, /clone-service\.test\.js/);
  assert.ok(!JSON.stringify(t.logged).includes('secret-host'), 'no URL in the log');
  const u = setup({ last: parent });
  await assert.rejects(u.service.clone(s, { url: '/local', name: 'r', parent }, 'b'), { kind: 'invalid-args' });
  assert.deepEqual(u.logged.map(([m]) => m), ['clone refused'], 'a kinded refusal: logged once, as such');
});

test('sessionClosed forgets the tab\'s last outcome (it holds the typed URL); a clone finishing after the tab closed leaves none', async () => {
  const parent = h.tmpDir();
  const t = setup({ last: parent });
  const s = session(1);
  let p = t.service.clone(s, { url: 'https://h/r', name: 'r', parent }, 'a');
  await flush();
  t.runs[0].resolve({ status: 'checkout-failed', root: path.join(parent, 'r'), name: 'r', message: 'error: File name too long' });
  await p;
  const last = (await t.service.defaults(s)).last;
  assert.equal(last.status, 'checkout-failed');
  assert.equal(last.message, 'error: File name too long', 'a reloaded page can show it and offer Open Anyway');
  t.service.sessionClosed(s);
  assert.equal((await t.service.defaults(s)).last, null);
  p = t.service.clone(s, { url: 'https://h/q', name: 'q', parent }, 'b');
  await flush();
  s.closed = true;
  t.runs[1].resolve(doneRes(path.join(parent, 'q')));
  await p;
  assert.equal((await t.service.defaults(s)).last, null);
});
