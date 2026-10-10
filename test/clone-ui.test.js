'use strict';
// The Clone Repository… dialog (renderer/clone.js, window.PLClone) on the harness's fake DOM with a
// fake window.api: the form, the progress and its Cancel, the outcomes, reattaching after a reload,
// the menu command, and the pure helpers. Main's side is test/clone-service.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

const PARENT = { display: '~/code', chars: 20 };

/** A window.api with app.cancel, events (emit) and api.clone recorded; clone.start settles by hand. */
function fakeApi({ defaults } = {}) {
  const calls = [];
  const listeners = {};
  const starts = [];
  let n = 0;
  const api = {
    calls,
    starts,
    next: { parent: null, openCloned: null },
    defaults: defaults || { parent: PARENT, running: null },
    newOpId: () => `op-${++n}`,
    on(ch, cb) {
      (listeners[ch] = listeners[ch] || []).push(cb);
      return () => { listeners[ch] = listeners[ch].filter((x) => x !== cb); };
    },
    emit(ch, payload) { for (const cb of [...(listeners[ch] || [])]) cb(payload); },
    app: { cancelled: [], cancel(opId) { this.cancelled.push(opId); return Promise.resolve(true); } },
    clone: {
      defaults: async () => { calls.push(['defaults']); return api.defaults; },
      pickParent: async () => { calls.push(['pickParent']); return api.next.parent; },
      start(opId, req) {
        calls.push(['start', opId, req]);
        const d = deferred();
        starts.push({ opId, req, ...d });
        return d.promise;
      },
      openCloned: async (opId) => { calls.push(['openCloned', opId]); return api.next.openCloned || { opened: { root: '/x/r', name: 'r' } }; },
    },
  };
  return api;
}

function setup(o) {
  const dom = H.fakeDom().install();
  const win = H.loadClone();
  dom.attach(win);
  const api = fakeApi(o);
  win.api = api;
  const toasts = [];
  const body = dom.document.body;
  const q = (sel) => body.querySelector(sel);
  const btn = (text) => body.findAll((x) => x.tagName === 'BUTTON' && x.textContent === text)[0] || null;
  const type = (input, value) => { input.value = value; dom.dispatch(input, 'input'); };
  return { dom, win, api, C: win.PLClone, D: win.Components.dialog, toasts, onError: (e) => toasts.push(e), q, btn, type };
}

/** open() and wait for the form; {done}: the flow's promise (wrapped: an async function would adopt it). */
async function openForm(t) {
  const done = t.C.open({ onError: t.onError });
  await H.flush();
  return { done };
}

/** Fill the form with a URL and press Clone; resolves the start call. */
async function startWith(t, url = 'https://github.com/o/repo.git') {
  t.type(t.q('.clone-url'), url);
  t.btn('Clone').click();
  await H.flush();
  return t.api.starts.at(-1);
}

const notices = (t) => t.toasts.filter((e) => e.level === 'info').map((e) => e.message);

// ---------------------------------------------------------------- the form

test('the form: the name follows the URL until edited; the preview and Clone follow the fields', async () => {
  const t = setup();
  const done = (await openForm(t)).done;
  const url = t.q('.clone-url');
  const name = t.q('.clone-name');
  const clone = t.btn('Clone');
  assert.equal(t.D.isOpen(), true);
  assert.equal(t.q('.clone-parent').value, '~/code');
  assert.equal(clone.disabled, true, 'nothing typed yet');
  assert.equal(t.q('.dlg-error').hidden, true, 'no message before the user types');
  t.type(url, 'https://github.com/o/repo.git');
  assert.equal(name.value, 'repo');
  assert.equal(clone.disabled, false);
  assert.equal(t.q('.clone-preview').textContent, 'Will create ~/code/repo');
  t.type(name, 'mine');
  t.type(url, 'https://github.com/o/other.git');
  assert.equal(name.value, 'mine', 'edited: stays as typed');
  t.type(name, '');
  assert.equal(clone.disabled, true, 'an empty name');
  t.type(url, 'git@host:o/again.git');
  assert.equal(name.value, 'again', 'emptied: follows again');
  t.btn('Cancel').click();
  await done;
  assert.equal(t.api.starts.length, 0);
});

test('the form: an invalid URL disables Clone with its message; a typed local path asks for a remote URL; there is no local-repository picker', async () => {
  const t = setup();
  const done = (await openForm(t)).done;
  const url = t.q('.clone-url');
  const err = t.q('.dlg-error');
  t.type(url, 'ext::sh -c x');
  assert.equal(t.btn('Clone').disabled, true);
  assert.match(err.textContent, /helper program/);
  assert.equal(err.hidden, false);
  assert.equal(url.getAttribute('aria-invalid'), 'true');
  t.type(url, '/srv/private.git');
  assert.match(err.textContent, /^Enter a remote URL/);
  t.type(url, 'http://h/r');
  assert.equal(t.btn('Clone').disabled, false);
  assert.match(t.q('.clone-note').textContent, /aren't encrypted/);
  t.dom.key('Escape');
  await done;
});

test('Choose\u2026 shows the new parent; without one Clone stays disabled', async () => {
  const t = setup({ defaults: { parent: null, running: null } });
  const done = (await openForm(t)).done;
  t.type(t.q('.clone-url'), 'https://h/r.git');
  assert.equal(t.btn('Clone').disabled, true, 'no parent yet');
  t.api.next.parent = { display: '~/elsewhere', chars: 12 };
  t.btn('Choose\u2026').click();
  await H.flush();
  assert.equal(t.q('.clone-parent').value, '~/elsewhere');
  assert.equal(t.q('.clone-preview').textContent, 'Will create ~/elsewhere/r');
  assert.equal(t.btn('Clone').disabled, false);
  t.btn('Cancel').click();
  await done;
});

test('Windows: a long target path gets the core.longpaths warning before starting', async () => {
  const t = setup({ defaults: { parent: { display: 'C:\\deep', chars: 195 }, running: null } });
  t.win.Components.util.PLATFORM = 'win32';
  const done = (await openForm(t)).done;
  t.type(t.q('.clone-url'), 'https://h/r.git');
  assert.equal(t.q('.clone-warn').hidden, true, '195 + 1 + 1 characters');
  t.type(t.q('.clone-name'), 'longer-name');
  assert.equal(t.q('.clone-warn').hidden, false);
  assert.match(t.q('.clone-warn').textContent, /core\.longpaths/);
  assert.equal(t.q('.clone-preview').textContent, 'Will create C:\\deep\\longer-name');
  t.btn('Cancel').click();
  await done;
});

test('Enter in a field submits; the request carries the URL, the name and the parent shown', async () => {
  const t = setup();
  const done = (await openForm(t)).done;
  t.type(t.q('.clone-url'), '  https://github.com/o/repo.git ');
  t.q('.clone-url').focus();
  t.dom.key('Enter');
  await H.flush();
  assert.equal(t.api.starts.length, 1);
  assert.deepEqual(t.api.starts[0].req, { url: 'https://github.com/o/repo.git', name: 'repo', parent: '~/code' });
  t.api.starts[0].resolve({ status: 'done', target: '~/code/repo', name: 'repo', submodules: false, empty: false, opened: { root: '/u/code/repo', name: 'repo' } });
  await done;
  assert.deepEqual(notices(t), ['Cloned repo.']);
});

// ---------------------------------------------------------------- progress

test('progress: frames of this clone update the phase and the bar; another opId\'s are ignored', async () => {
  const t = setup();
  const done = (await openForm(t)).done;
  const s = await startWith(t);
  assert.equal(t.D.isOpen(), true);
  assert.match(t.q('.clone-lead').textContent, /^Cloning https:\/\/github\.com\/o\/repo\.git into ~\/code\/repo$/);
  const bar = t.q('.clone-bar');
  assert.ok(bar.classList.contains('is-indeterminate'), 'no percent yet');
  t.api.emit('clone-progress', { opId: 'op-999', phase: 'Receiving objects', percent: 90, current: 9, total: 10, done: false, remote: false });
  assert.equal(t.q('.clone-phase').textContent, 'Starting\u2026');
  t.api.emit('clone-progress', { opId: s.opId, phase: 'Counting objects', percent: 20, current: 7, total: 35, bytes: null, rate: null, done: false, remote: true });
  assert.equal(t.q('.clone-phase').textContent, 'Server: counting objects 20% (7 / 35)');
  t.api.emit('clone-progress', { opId: s.opId, phase: 'Receiving objects', percent: 45, current: 1234, total: 2741, bytes: 12.3 * 1024 ** 2, rate: 4.1 * 1024 ** 2, done: false, remote: false });
  assert.equal(t.q('.clone-phase').textContent, 'Receiving objects 45% (1,234 / 2,741) \u00b7 12.3 MiB \u00b7 4.1 MiB/s');
  assert.equal(bar.value, 45);
  assert.equal(bar.classList.contains('is-indeterminate'), false);
  assert.equal(t.q('.clone-live').getAttribute('aria-live'), 'polite');
  assert.equal(t.q('.clone-live').textContent, 'Server: counting objects 20% (7 / 35)', 'the screen reader line: at most once a second');
  s.resolve({ status: 'done', target: '~/code/repo', name: 'repo', submodules: true, empty: false, opened: { root: '/r', name: 'repo' } });
  await done;
  assert.equal(t.D.isOpen(), false);
  assert.deepEqual(notices(t), ['Cloned repo. It has submodules, which were not cloned: run git submodule update --init in a terminal.']);
});

test('"Waiting\u2026" after 30 s without a frame: with the password hint until a first frame came', async (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  const t = setup();
  const done = (await openForm(t)).done;
  const s = await startWith(t);
  const wait = () => t.q('.clone-wait');
  tc.mock.timers.tick(29000);
  assert.equal(wait().hidden, true);
  tc.mock.timers.tick(1000);
  assert.equal(wait().hidden, false);
  assert.match(wait().textContent, /^Waiting\u2026\n\nIf the server needs a password or an SSH key passphrase, Pasta Lite can't ask for it yet\. Git could not authenticate/);
  t.api.emit('clone-progress', { opId: s.opId, phase: 'Receiving objects', percent: 1, current: 1, total: 100, done: false, remote: false });
  assert.equal(wait().hidden, true, 'a frame hides it');
  tc.mock.timers.tick(30000);
  assert.equal(wait().textContent, 'Waiting\u2026', 'after a frame: no password hint');
  s.reject({ message: 'git was cancelled', kind: 'aborted' });
  await done;
});

// ---------------------------------------------------------------- cancel

test('Cancel: api.app.cancel(opId), then "Cancelling\u2026" disabled; Esc and the backdrop do nothing; aborted closes with a notice', async () => {
  const t = setup();
  const done = (await openForm(t)).done;
  const s = await startWith(t);
  t.dom.key('Escape');
  const cancel = t.btn('Cancel');
  t.dom.dispatch(cancel.closest('.dlg-backdrop'), 'mousedown');
  assert.equal(t.D.isOpen(), true, 'Esc and the backdrop are ignored while it runs');
  assert.deepEqual(t.api.app.cancelled, []);
  cancel.click();
  assert.deepEqual(t.api.app.cancelled, [s.opId]);
  assert.equal(cancel.disabled, true);
  assert.equal(cancel.textContent, 'Cancelling\u2026');
  cancel.click();
  assert.deepEqual(t.api.app.cancelled, [s.opId], 'once');
  s.reject({ message: 'git was cancelled', kind: 'aborted' });
  await done;
  assert.equal(t.D.isOpen(), false);
  assert.deepEqual(notices(t), ['Clone cancelled']);
});

test('a forced close (another dialog) doesn\'t cancel: the clone goes on and its outcome is a toast', async () => {
  const t = setup();
  const done = (await openForm(t)).done;
  const s = await startWith(t);
  const other = t.D.confirm({ title: 'Something else' });
  await H.flush();
  assert.equal(t.q('.clone-bar'), null, 'the progress modal is gone');
  assert.deepEqual(t.api.app.cancelled, []);
  t.D.close();
  await other;
  s.resolve({ status: 'done', target: '~/code/repo', name: 'repo', submodules: false, empty: false, opened: { root: '/r', name: 'repo' } });
  await done;
  assert.deepEqual(notices(t), ['Cloned repo.']);
  const t2 = setup();
  const d2 = (await openForm(t2)).done;
  const s2 = await startWith(t2);
  t2.D.confirm({ title: 'x' });
  t2.D.close();
  s2.reject({ message: "fatal: repository 'https://h/r/' not found", kind: 'not-found' });
  await d2;
  assert.equal(t2.toasts.length, 1);
  assert.equal(t2.toasts[0].kind, 'not-found');
  assert.match(t2.toasts[0].message, /^Repository not found: fatal: repository/);
});

// ---------------------------------------------------------------- outcomes

test('an error: its explanation with Back (the form again, with its values) and Close', async () => {
  const t = setup();
  const done = (await openForm(t)).done;
  const s = await startWith(t, 'https://github.com/o/nope.git');
  s.reject({ message: "remote: Repository not found.\nfatal: repository 'https://github.com/o/nope.git/' not found", kind: 'not-found' });
  await H.flush();
  assert.equal(t.q('.dlg-title').textContent, 'Repository not found');
  assert.match(t.q('.dlg-message').textContent, /aren't signed in/);
  assert.match(t.q('.dlg-detail').textContent, /not found/);
  t.btn('Back').click();
  await H.flush();
  assert.equal(t.q('.clone-url').value, 'https://github.com/o/nope.git');
  assert.equal(t.q('.clone-name').value, 'nope');
  t.btn('Cancel').click();
  await done;
  const t2 = setup();
  const d2 = (await openForm(t2)).done;
  const s2 = await startWith(t2);
  s2.reject({ message: 'fatal: whatever', kind: null });
  await H.flush();
  assert.equal(t2.q('.dlg-title').textContent, 'Clone failed');
  assert.match(t2.q('.dlg-message').textContent, /Show Logs/);
  t2.btn('Close').click();
  await d2;
  assert.equal(t2.D.isOpen(), false);
});

test('stale: Back shows main\'s current parent', async () => {
  const t = setup();
  const done = (await openForm(t)).done;
  const s = await startWith(t);
  t.api.defaults = { parent: { display: '~/other', chars: 10 }, running: null };
  s.reject({ message: 'The folder changed; check it and try again', kind: 'stale' });
  await H.flush();
  assert.equal(t.q('.dlg-title').textContent, 'The folder changed');
  t.btn('Back').click();
  await H.flush();
  assert.equal(t.q('.clone-parent').value, '~/other');
  assert.equal(t.q('.clone-url').value, 'https://github.com/o/repo.git');
  t.btn('Cancel').click();
  await done;
});

test('a removal that failed later: the leftover toast', async () => {
  const t = setup();
  const done = (await openForm(t)).done;
  const s = await startWith(t);
  s.reject({ message: 'git was cancelled', kind: 'aborted' });
  await done;
  t.api.emit('clone-progress', { opId: s.opId, cleanup: 'failed', leftover: '~/code/repo' });
  assert.equal(t.toasts.at(-1).message, 'A partial folder was left at ~/code/repo: delete it by hand.');
});

test('checkout-failed: git\'s text and Open Anyway, which calls api.clone.openCloned(opId)', async () => {
  const t = setup();
  const done = (await openForm(t)).done;
  const s = await startWith(t);
  s.resolve({ status: 'checkout-failed', target: '~/code/repo', name: 'repo', submodules: false, empty: false, opened: null, message: 'error: cannot stat x: File name too long' });
  await H.flush();
  assert.equal(t.q('.dlg-title').textContent, 'The repository was cloned, but some files could not be checked out');
  assert.match(t.q('.dlg-detail').textContent, /File name too long/);
  t.btn('Open Anyway').click();
  await done;
  assert.deepEqual(t.api.calls.filter((c) => c[0] === 'openCloned'), [['openCloned', s.opId]]);
  assert.deepEqual(notices(t), ['Cloned repo.']);
});

test('declined, closed and openError outcomes', async () => {
  const run = async (outcome) => {
    const t = setup();
    const done = (await openForm(t)).done;
    const s = await startWith(t);
    s.resolve({ status: 'done', target: '~/code/repo', name: 'repo', submodules: false, empty: false, opened: null, ...outcome });
    await H.flush();
    return { t, done };
  };
  let r = await run({ reason: 'declined' });
  await r.done;
  assert.deepEqual(notices(r.t), ['Cloned to ~/code/repo. It was not opened.']);
  r = await run({ reason: 'closed' });
  await r.done;
  assert.deepEqual(r.t.toasts, []);
  r = await run({ openError: { message: 'detected dubious ownership', kind: 'unsafe-repo' } });
  assert.equal(r.t.q('.dlg-title').textContent, 'Cloned to ~/code/repo, but it couldn\'t be opened');
  assert.equal(r.t.q('.dlg-message').textContent, 'detected dubious ownership');
  r.t.btn('OK').click();
  await r.done;
});

test('all text is text: a URL with markup shows as typed, no element made from it', async () => {
  const t = setup();
  const done = (await openForm(t)).done;
  const s = await startWith(t, 'https://h/<img src=x onerror=alert(1)>');
  const lead = t.q('.clone-lead');
  assert.match(lead.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(lead.children.length, 0);
  assert.equal(t.dom.document.body.findAll((x) => x.tagName === 'IMG').length, 0);
  s.reject({ message: 'git was cancelled', kind: 'aborted' });
  await done;
});

// ---------------------------------------------------------------- reattach, the menu

test('resume: a clone still running for this tab reopens its progress; frames and Cancel work; it closes once main says it ended', async (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  const t = setup({ defaults: { parent: PARENT, running: { opId: 'op-77', target: '~/code/big' } } });
  await t.C.resume({ onError: t.onError });
  await H.flush();
  assert.equal(t.D.isOpen(), true);
  assert.equal(t.q('.clone-lead').textContent, 'Cloning into ~/code/big');
  t.api.emit('clone-progress', { opId: 'op-77', phase: 'Resolving deltas', percent: 60, current: 6, total: 10, done: false, remote: false });
  assert.equal(t.q('.clone-phase').textContent, 'Resolving deltas 60% (6 / 10)');
  t.btn('Cancel').click();
  assert.deepEqual(t.api.app.cancelled, ['op-77']);
  tc.mock.timers.tick(1000);
  await H.flush();
  assert.equal(t.D.isOpen(), true, 'still running');
  t.api.defaults = { parent: PARENT, running: null, last: { opId: 'op-77', req: { url: 'https://h/big' }, status: 'failed', target: '~/code/big', name: 'big', opened: false, error: { kind: 'aborted', message: 'git was cancelled' } } };
  tc.mock.timers.tick(1000);
  await H.flush();
  assert.equal(t.D.isOpen(), false);
  assert.deepEqual(notices(t), ['Clone cancelled'], 'what main recorded for this tab');
  // Nothing running: resume shows nothing.
  const quiet = setup();
  await quiet.C.resume({ onError: quiet.onError });
  assert.equal(quiet.D.isOpen(), false);
});

test('open() while this tab\'s clone runs shows its progress instead of a new form', async () => {
  const t = setup({ defaults: { parent: PARENT, running: { opId: 'op-5', target: '~/code/x' } } });
  await t.C.open({ onError: t.onError });
  await H.flush();
  assert.equal(t.q('.clone-url'), null);
  assert.equal(t.q('.clone-lead').textContent, 'Cloning into ~/code/x');
  t.D.close();
});

test('the menu command opens the dialog, and is ignored while a dialog is open', async () => {
  const t = setup();
  const busy = t.D.confirm({ title: 'Busy' });
  assert.equal(t.C.fromMenu({ onError: t.onError }), false);
  await H.flush();
  assert.deepEqual(t.api.calls, [], 'not even asked');
  t.D.close();
  await busy;
  assert.equal(t.C.fromMenu({ onError: t.onError }), true);
  await H.flush();
  assert.ok(t.q('.clone-url'));
  t.btn('Cancel').click();
});

// ---------------------------------------------------------------- pure

test('the pure helpers: amounts, rates, progress text, the name rule, the shown target', () => {
  const t = setup();
  const { formatBytes, formatRate, progressText, nameState, joinShown, notesText } = t.C._internal;
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(12.3 * 1024 ** 2), '12.3 MiB');
  assert.equal(formatBytes(3 * 1024 ** 4), '3.0 TiB');
  assert.equal(formatBytes(null), '');
  assert.equal(formatRate(4.1 * 1024 ** 2), '4.1 MiB/s');
  assert.equal(formatRate(null), '');
  assert.equal(progressText({ phase: 'Enumerating objects', percent: null, current: 35, total: null, remote: true }), 'Server: enumerating objects (35)');
  assert.equal(progressText({ phase: 'Updating files', percent: 3, current: 600, total: 20000 }), 'Updating files 3% (600 / 20,000)');
  assert.equal(progressText(null), '');
  assert.equal(nameState(false, 'derived', 'typed'), 'derived');
  assert.equal(nameState(true, 'derived', 'typed'), 'typed');
  assert.equal(joinShown('~/code', 'r', 'darwin'), '~/code/r');
  assert.equal(joinShown('~', 'r', 'darwin'), '~/r');
  assert.equal(joinShown('C:\\', 'r', 'win32'), 'C:\\r');
  assert.equal(joinShown('D:\\src', 'r', 'win32'), 'D:\\src\\r');
  assert.match(notesText(['insecure', 'user-in-url']), /aren't encrypted.*user name/);
});

test('errorView: each kind\'s title and text', () => {
  const t = setup();
  const { errorView } = t.C._internal;
  const v = (kind, o = {}, req = { url: 'git@github.com:o/r.git' }) => errorView({ message: 'git said this', kind, ...o }, req);
  assert.equal(v('auth').title, 'Authentication failed');
  assert.match(v('auth').message, /credential helper/);
  assert.equal(v('host-key').title, 'Unknown host key');
  assert.match(v('host-key').message, /ssh doesn't know github\.com yet .* \(ssh -T git@github\.com\)/);
  assert.match(v('not-found').message, /aren't signed in/);
  assert.equal(v('unreachable').title, 'Can\'t reach the server');
  assert.equal(v('unreachable').detail, 'git said this');
  assert.equal(v('exists', { message: 'A folder named r already exists in ~/code' }).message, 'A folder named r already exists in ~/code. Choose another name or folder.');
  for (const [kind, title] of [['no-access', 'Can\'t create the folder'], ['no-space', 'The disk is full'], ['path-too-long', 'The path is too long']]) {
    assert.equal(v(kind).title, title, kind);
    assert.equal(v(kind).message, 'git said this', kind);
  }
  assert.equal(v('unsafe-repo').detail, 'git said this');
  assert.equal(v('unsupported').title, 'This kind of URL isn\'t supported');
  assert.equal(v('stale').message, 'Another tab chose a different folder to clone into. Check it and try again.', 'not the title again');
  assert.equal(v('in-progress', { state: 'cleanup' }).title, 'The previous clone\'s folder is still being removed');
  assert.equal(v('in-progress', { state: 'clone' }).title, 'A clone is already running in this tab');
  assert.equal(v(null).title, 'Clone failed');
  assert.match(v(undefined).message, /See Help \u2192 Show Logs/);
});

test('reattached: the outcome is main\'s record of this tab\'s clone, never another tab\'s changed event', async (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  const running = { opId: 'op-8', target: '~/code/r' };
  const t = setup({ defaults: { parent: PARENT, running, last: null } });
  await t.C.resume({ onError: t.onError });
  await H.flush();
  t.api.emit('changed', { repo: '/elsewhere/x', op: 'clone', ok: false }); // another tab's clone failed
  t.btn('Cancel').click(); // asked, but the clone completed anyway
  t.api.defaults = { parent: PARENT, running: null, last: { opId: 'op-8', req: { url: 'https://h/r' }, status: 'done', target: '~/code/r', name: 'r', opened: true } };
  tc.mock.timers.tick(1000);
  await H.flush();
  assert.equal(t.D.isOpen(), false);
  assert.deepEqual(t.toasts.map((e) => e.message), ['Cloned r.'], 'it completed: not "cancelled", not the other tab\'s failure');
});

test('reattached: a failure says why (errorView), and no record for that opId says only that it ended', async (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  const t = setup({ defaults: { parent: PARENT, running: { opId: 'op-9', target: '~/code/r' }, last: null } });
  await t.C.resume({ onError: t.onError });
  await H.flush();
  t.api.defaults = { parent: PARENT, running: null, last: { opId: 'op-9', req: { url: 'git@github.com:o/r.git' }, status: 'failed', target: '~/code/r', name: 'r', opened: false, error: { kind: 'host-key', message: 'Host key verification failed.' } } };
  tc.mock.timers.tick(1000);
  await H.flush();
  assert.equal(t.toasts.length, 1);
  assert.equal(t.toasts[0].kind, 'host-key');
  assert.match(t.toasts[0].message, /^Unknown host key: Host key verification failed\./);
  const u = setup({ defaults: { parent: PARENT, running: { opId: 'op-1', target: '' }, last: null } });
  await u.C.resume({ onError: u.onError });
  await H.flush();
  assert.equal(u.q('.clone-lead').textContent, 'Cloning\u2026', 'the target isn\'t known yet');
  u.api.defaults = { parent: PARENT, running: null, last: { opId: 'op-0', status: 'done', target: '~/x', name: 'x', opened: true } };
  tc.mock.timers.tick(1000);
  await H.flush();
  assert.deepEqual(notices(u), ['The clone has ended.'], 'another clone\'s record is not this one\'s');
});

test('attach is idempotent: attaching again leaves one poll loop, and the earlier one never closes the new view', async (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  const running = { opId: 'op-3', target: '~/code/r' };
  const t = setup({ defaults: { parent: PARENT, running, last: null } });
  await t.C.resume({ onError: t.onError });
  await H.flush();
  t.D.confirm({ title: 'Something else' }); // forces the progress shut
  t.D.close();
  await H.flush();
  await t.C.open({ onError: t.onError }); // reattaches: a new view and a new loop
  await H.flush();
  assert.ok(t.q('.clone-bar'));
  const polls = () => t.api.calls.filter((c) => c[0] === 'defaults').length;
  const before = polls();
  tc.mock.timers.tick(1000);
  await H.flush();
  assert.equal(polls() - before, 1, 'one loop asks main');
  assert.ok(t.q('.clone-bar'), 'still showing');
  t.api.defaults = { parent: PARENT, running: null, last: { opId: 'op-3', status: 'done', target: '~/code/r', name: 'r', opened: true } };
  tc.mock.timers.tick(1000);
  await H.flush();
  assert.equal(t.D.isOpen(), false);
  assert.deepEqual(notices(t), ['Cloned r.'], 'told once');
});

test('errorView: a parent that is gone or missing asks for another folder; an "exists" text ending in a period gets one', () => {
  const t = setup();
  const { errorView } = t.C._internal;
  const gone = errorView({ kind: 'not-found', state: 'parent', message: 'The folder ~/code no longer exists' }, { url: 'https://h/r' });
  assert.deepEqual(gone, { title: 'Choose another folder', message: 'The folder ~/code no longer exists' });
  assert.equal(errorView({ kind: 'not-found', state: 'parent', message: 'Choose a folder to clone into' }).title, 'Choose another folder');
  assert.equal(errorView({ kind: 'not-found', message: 'x' }, { url: 'https://h/r' }).title, 'Repository not found');
  assert.equal(errorView({ kind: 'exists', message: 'A folder named r already exists in ~/code.' }).message, 'A folder named r already exists in ~/code. Choose another name or folder.');
  assert.equal(errorView({ kind: 'stale', state: 'parent' }).title, 'The folder changed');
});

test('reattached, then forced shut by another dialog: the outcome still comes (as a toast)', async (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  const t = setup({ defaults: { parent: PARENT, running: { opId: 'op-4', target: '~/code/r' }, last: null } });
  await t.C.resume({ onError: t.onError });
  await H.flush();
  const other = t.D.confirm({ title: 'Something else' });
  await H.flush();
  assert.equal(t.q('.clone-bar'), null, 'forced shut');
  t.api.defaults = { parent: PARENT, running: null, last: { opId: 'op-4', req: { url: 'https://h/r' }, status: 'failed', target: '~/code/r', name: 'r', opened: false, error: { kind: 'unreachable', message: 'Could not resolve host' } } };
  tc.mock.timers.tick(1000);
  await H.flush();
  assert.equal(t.toasts.length, 1);
  assert.equal(t.toasts[0].kind, 'unreachable');
  t.D.close();
  await other;
});

test('reattached after a reload: a checkout failure offers Open Anyway while main still holds it', async (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  const t = setup({ defaults: { parent: PARENT, running: { opId: 'op-6', target: '~/code/r' }, last: null } });
  await t.C.resume({ onError: t.onError });
  await H.flush();
  t.api.defaults = { parent: PARENT, running: null, last: { opId: 'op-6', req: { url: 'https://h/r' }, status: 'checkout-failed', target: '~/code/r', name: 'r', opened: false, message: 'error: unable to create file x: Filename too long' } };
  tc.mock.timers.tick(1000);
  await H.flush();
  assert.equal(t.q('.dlg-title').textContent, 'The repository was cloned, but some files could not be checked out');
  assert.match(t.q('.dlg-detail').textContent, /Filename too long/);
  t.btn('Open Anyway').click();
  await H.flush();
  assert.deepEqual(t.api.calls.filter((c) => c[0] === 'openCloned'), [['openCloned', 'op-6']]);
  assert.deepEqual(notices(t), ['Cloned r.']);
  // With another dialog on screen, a toast says so instead (a dialog now would close it).
  const u = setup({ defaults: { parent: PARENT, running: { opId: 'op-7', target: '~/code/r' }, last: null } });
  await u.C.resume({ onError: u.onError });
  await H.flush();
  const busy = u.D.confirm({ title: 'Busy' });
  u.api.defaults = { parent: PARENT, running: null, last: { opId: 'op-7', req: { url: 'https://h/r' }, status: 'checkout-failed', target: '~/code/r', name: 'r', opened: false, message: 'x' } };
  tc.mock.timers.tick(1000);
  await H.flush();
  assert.deepEqual(notices(u), ['Cloned to ~/code/r, but some files could not be checked out.']);
  u.D.close();
  await busy;
});

test('attaching again closes the earlier, forced-shut view: its "Waiting…" and live-line timers stop', async (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  const running = { opId: 'op-2', target: '~/code/r' };
  const t = setup({ defaults: { parent: PARENT, running, last: null } });
  await t.C.resume({ onError: t.onError });
  await H.flush();
  const oldWait = t.q('.clone-wait');
  t.D.confirm({ title: 'x' });
  t.D.close();
  await H.flush();
  await t.C.open({ onError: t.onError });
  await H.flush();
  tc.mock.timers.tick(31000);
  await H.flush();
  assert.equal(oldWait.hidden, true, 'the old view\'s timer was stopped');
  assert.equal(t.q('.clone-wait').hidden, false, 'the new one waits as usual');
  t.D.close();
});

test('no parent picked yet: the form asks for one, and Clone stays disabled', async () => {
  const t = setup({ defaults: { parent: null, running: null } });
  const done = (await openForm(t)).done;
  t.type(t.q('.clone-url'), 'https://h/r.git');
  assert.equal(t.q('.clone-preview').textContent, 'Choose a folder to clone into (Choose…).');
  assert.equal(t.q('.clone-preview').hidden, false);
  assert.equal(t.btn('Clone').disabled, true);
  t.btn('Cancel').click();
  await done;
});
