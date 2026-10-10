'use strict';
// The IPC contract (src/ipc-contract.js) and main's registration of it (main/ipc.js).
// - The sandboxed preloads can only require 'electron', so their channel names and event list are
//   literals: they are read here as text and checked against the channel table and EVENTS.
// - registerChannels over a fake ipcMain: exactly the table's channels, a handler without an
//   entry (or an entry without a handler) fails, and every call goes through the sender check,
//   the coercers and needsRepo.
// - The sender routing (routeSender, isIndexUrl) and opId namespacing.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const c = require('../src/ipc-contract');
const { registerChannels, createHandlers } = require('../main/ipc');

const ROOT = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const matches = (text, re) => new Set([...text.matchAll(re)].map((m) => m[1]));
const sorted = (set) => [...set].sort();

/** Channels a preload calls: call('<channel>', ...) and ipcRenderer.send('<channel>', ...). */
const preloadChannels = (text) => new Set([
  ...matches(text, /\bcall\('([^']+)'/g),
  ...matches(text, /ipcRenderer\.send\('([^']+)'/g),
]);

describe('the preloads agree with the table', () => {
  test('preload.js calls exactly the view channels (the smoke ones included)', () => {
    assert.deepEqual(sorted(preloadChannels(src('preload.js'))), sorted(new Set([...c.VIEW_CHANNELS, ...c.SMOKE_VIEW_CHANNELS])));
  });

  test('preload-tabs.js calls exactly the strip channels', () => {
    assert.deepEqual(sorted(preloadChannels(src('preload-tabs.js'))), sorted(c.STRIP_CHANNELS));
  });

  test('the fire-and-forget channels are sent, the others invoked', () => {
    for (const [channel, spec] of Object.entries(c.CHANNELS)) {
      const sent = src('preload.js').includes(`ipcRenderer.send('${channel}'`) || src('preload-tabs.js').includes(`ipcRenderer.send('${channel}'`);
      assert.equal(sent, !!spec.send, channel);
    }
  });

  test('preload.js EVENTS is exactly EVENTS; the strip subscribes to TABS_CHANGED', () => {
    const m = /const EVENTS = new Set\(\[([^\]]*)\]\)/.exec(src('preload.js'));
    assert.ok(m, 'preload.js declares EVENTS');
    assert.deepEqual(sorted(matches(m[1], /'([^']+)'/g)), sorted(Object.values(c.EVENTS)));
    assert.ok(src('preload-tabs.js').includes(`ipcRenderer.on('${c.EVENTS.TABS_CHANGED}'`));
  });

  test('main sends no event by a literal name outside EVENTS', () => {
    const files = ['main.js', ...fs.readdirSync(path.join(ROOT, 'main')).map((f) => `main/${f}`), 'src/repo-opening.js', 'src/watch-session.js', 'src/tab-session.js'];
    const known = new Set(Object.values(c.EVENTS));
    for (const f of files) {
      for (const name of matches(src(f), /\b(?:send|broadcast|sendStrip)\('([^']+)'/g)) assert.ok(known.has(name), `${f}: ${name}`);
    }
  });

  test("the pages' platform is the preloads' process.platform, never sniffed from the user agent", () => {
    assert.match(src('preload.js'), /^ {2}platform: process\.platform,$/m, "window.api.platform (Components.util.PLATFORM)");
    assert.match(src('preload-tabs.js'), /^ {2}isMac: process\.platform === 'darwin',$/m, 'window.tabsApi.isMac (the strip)');
    assert.match(src('renderer/components.js'), /window\.api\.platform/);
    const dir = path.join(ROOT, 'renderer');
    const scripts = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js'));
    for (const f of scripts) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /userAgent|navigator\.platform/, f);
  });

  test('the helpers both preloads duplicate (sandboxed: no shared module) stay identical, and match main', () => {
    const block = (text, start, end) => {
      const a = text.indexOf(start);
      assert.ok(a >= 0, start);
      return text.slice(a, text.indexOf(end, a) + end.length);
    };
    const pieces = (text) => ({
      call: block(text, 'async function call(', '\n}\n'),
      tabId: block(text, 'const tabId = ', ';\n'),
      levels: block(text, 'const LOG_LEVELS = ', ';\n'),
      max: block(text, 'const LOG_MAX = ', ';\n'),
      sendLog: block(text, 'function sendLog(', '\n}\n'),
    });
    assert.deepEqual(pieces(src('preload-tabs.js')), pieces(src('preload.js')));
    // What the preload lets through is what main accepts (src/renderer-log.js, the logger's levels).
    const { LEVELS } = require('../src/log');
    const { MAX_BYTES } = require('../src/renderer-log');
    const levels = matches(pieces(src('preload.js')).levels, /'([^']+)'/g);
    assert.deepEqual(sorted(levels), sorted(new Set(Object.keys(LEVELS))));
    assert.match(pieces(src('preload.js')).max, new RegExp(`= ${MAX_BYTES / 1024} \\* 1024;`));
  });

  test('the table: every channel has a known sender kind; the smoke-only channels are exactly tabs:probe', () => {
    for (const [channel, spec] of Object.entries(c.CHANNELS)) {
      assert.ok(spec.from.length && spec.from.every((w) => ['view', 'strip', 'smoke'].includes(w)), channel);
      for (const coerce of spec.args || []) assert.equal(typeof coerce, 'function', channel);
    }
    assert.deepEqual(sorted(c.SMOKE_ONLY_CHANNELS), ['tabs:probe']);
    assert.deepEqual(sorted(c.SMOKE_VIEW_CHANNELS), ['tabs:close', 'tabs:list', 'tabs:move', 'tabs:probe']);
  });
});

// ---------------------------------------------------------------- registerChannels

/** A fake ipcMain recording handle / on registrations; call(channel, event, ...args) invokes one. */
function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle: (ch, fn) => { assert.ok(!handlers.has(ch), `twice: ${ch}`); handlers.set(ch, fn); },
    on: (ch, fn) => listeners.set(ch, fn),
    call: (ch, event, ...a) => handlers.get(ch)(event, ...a),
  };
}
const fakeLog = () => { const recs = []; return { recs, info: (m, f) => recs.push(['info', m, f]), warn: (m, f) => recs.push(['warn', m, f]) }; };
const allHandlers = (fn = () => 'ok') => Object.fromEntries(Object.keys(c.CHANNELS).filter((ch) => !c.SMOKE_ONLY_CHANNELS.has(ch)).map((ch) => [ch, fn]));

function register({ handlers = allHandlers(), ctx = { kind: 'view', session: { id: 5, repo: { root: '/r' } }, senderId: 5 }, smoke = false } = {}) {
  const ipc = fakeIpcMain();
  const log = fakeLog();
  registerChannels({ ipcMain: ipc, senderContext: () => ctx, handlers, hasTab: (id) => id === 5 || id === 6, log, smoke });
  return { ipc, log };
}

describe('registerChannels (main/ipc.js)', () => {
  test('registers exactly the table (the smoke-only channels only with a smoke harness)', () => {
    const { ipc } = register();
    const registered = new Set([...ipc.handlers.keys(), ...ipc.listeners.keys()]);
    assert.deepEqual(sorted(registered), sorted(new Set(Object.keys(c.CHANNELS).filter((ch) => !c.SMOKE_ONLY_CHANNELS.has(ch)))));
    assert.deepEqual([...ipc.listeners.keys()], ['app:log']);
    const smoke = register({ handlers: { ...allHandlers(), 'tabs:probe': () => 'p' }, smoke: true });
    assert.ok(smoke.ipc.handlers.has('tabs:probe'));
  });

  test('a handler without a table entry, or a channel without a handler, fails at startup', () => {
    assert.throws(() => register({ handlers: { ...allHandlers(), 'app:secret': () => 1 } }), /app:secret has no entry/);
    const missing = allHandlers();
    delete missing['app:cancel'];
    assert.throws(() => register({ handlers: missing }), /no handler for app:cancel/);
    assert.throws(() => register({ smoke: true }), /no handler for tabs:probe/, 'a smoke run needs the harness\'s handler');
  });

  test('main\'s handlers cover the table exactly (the smoke harness adds tabs:probe)', () => {
    const controller = { tabs: {} };
    const h = createHandlers({ controller });
    assert.deepEqual(sorted(new Set(Object.keys(h))), sorted(new Set(Object.keys(c.CHANNELS).filter((ch) => !c.SMOKE_ONLY_CHANNELS.has(ch)))));
    assert.match(src('main/smoke.js'), /handlers: \{ 'tabs:probe': probe \}/);
  });

  test('an untrusted sender gets the forbidden error, serialized like any other, and is logged', async () => {
    const { ipc, log } = register({ ctx: null });
    assert.deepEqual(await ipc.call('app:getState', {}), { ok: false, error: { message: 'Forbidden', kind: 'forbidden', exitCode: null } });
    assert.deepEqual(log.recs[0].slice(0, 2), ['warn', 'refused a call from an untrusted sender']);
  });

  test('arguments are coerced before the handler; extra ones are dropped', async () => {
    const seen = [];
    const rec = (name) => (ctx, ...a) => { seen.push([name, ...a]); return true; };
    const handlers = allHandlers();
    for (const ch of ['op', 'app:openRecent', 'app:openDialog', 'tabs:activate', 'tabs:move', 'app:cancel']) handlers[ch] = rec(ch);
    const { ipc } = register({ handlers });
    await ipc.call('op', {}, { op: 'status', args: ['x'], opId: 'op-1' }, 'extra');
    await ipc.call('op', {}, { op: 'status' });
    await ipc.call('app:openRecent', {}, '/r/a', { newTab: 'yes' });
    await ipc.call('app:openDialog', {}, { newTab: true });
    await ipc.call('tabs:activate', {}, 5);
    await ipc.call('tabs:move', {}, 6, 0);
    await ipc.call('app:cancel', {}, 'op-1');
    assert.deepEqual(seen, [
      ['op', { op: 'status', args: ['x'], opId: 'op-1' }],
      ['op', { op: 'status', args: [], opId: undefined }],
      ['app:openRecent', '/r/a', { newTab: false }],
      ['app:openDialog', { newTab: true }],
      ['tabs:activate', 5, { keepFocus: false }],
      ['tabs:move', 6, 0],
      ['app:cancel', 'op-1'],
    ]);
  });

  test('refusals: unknown op, bad args, bad opId (op and app:cancel alike), unknown tab, non-integer index', async () => {
    const { ipc, log } = register();
    const kind = async (...a) => (await ipc.call(...a)).error.kind;
    assert.equal(await kind('op', {}, { op: 'rm -rf' }), 'unknown-op');
    assert.equal(await kind('op', {}, { op: 'toString' }), 'unknown-op', 'own ops only');
    assert.equal(await kind('op', {}, null), 'unknown-op');
    assert.equal(await kind('op', {}, { op: 'status', args: 'x' }), 'invalid-args');
    for (const bad of [42, '', {}]) {
      assert.equal(await kind('op', {}, { op: 'status', opId: bad }), 'invalid-args', `op opId ${JSON.stringify(bad)}`);
      assert.equal(await kind('app:cancel', {}, bad), 'invalid-args', `cancel opId ${JSON.stringify(bad)}`);
    }
    assert.equal(await kind('app:cancel', {}), 'invalid-args');
    assert.equal(await kind('tabs:close', {}, 9), 'invalid-args');
    assert.equal(await kind('tabs:close', {}, '5'), 'invalid-args');
    assert.equal(await kind('tabs:move', {}, 5, 1.5), 'invalid-args');
    assert.ok(log.recs.every(([level, msg]) => level === 'warn' && msg === 'refused a call'));
  });

  test('needsRepo: refused with no-repo (logged at info) before the handler, for every such channel', async () => {
    let ran = 0;
    const { ipc, log } = register({ handlers: allHandlers(() => { ran++; }), ctx: { kind: 'view', session: { id: 5, repo: null }, senderId: 5 } });
    for (const [ch, a] of [['op', [{ op: 'status' }]], ['app:openWorktree', ['/w']], ['app:openTerminal', []]]) {
      const res = await ipc.call(ch, {}, ...a);
      assert.deepEqual(res.error, { message: 'No repository is open', kind: 'no-repo', exitCode: null }, ch);
    }
    assert.equal(ran, 0);
    assert.ok(log.recs.every(([level]) => level === 'info'));
    assert.equal((await ipc.call('app:getState', {})).ok, true, 'no repo needed');
  });

  test('handler failures are serialized; logged except for op (its runner logs every op)', async () => {
    const boom = () => { throw Object.assign(new Error('nope'), { kind: 'busy' }); };
    const { ipc, log } = register({ handlers: { ...allHandlers(), op: boom, 'app:openDialog': boom } });
    assert.deepEqual((await ipc.call('op', {}, { op: 'status' })).error, { message: 'nope', kind: 'busy', exitCode: null });
    assert.equal(log.recs.length, 0);
    await ipc.call('app:openDialog', {});
    assert.deepEqual(log.recs.map((r) => r[1]), ['call failed']);
  });

  test('clipboard:writeText: a string of at most CLIPBOARD_MAX characters reaches Electron\'s clipboard; anything else is refused', async () => {
    const written = [];
    const main = createHandlers({ controller: { tabs: {} }, clipboard: { writeText: (t) => written.push(t) } });
    const { ipc, log } = register({ handlers: { ...allHandlers(), 'clipboard:writeText': main['clipboard:writeText'] } });
    const sha = 'a'.repeat(40);
    assert.deepEqual(await ipc.call('clipboard:writeText', {}, sha, 'extra'), { ok: true, value: undefined });
    assert.deepEqual(await ipc.call('clipboard:writeText', {}, 'x'.repeat(c.CLIPBOARD_MAX)), { ok: true, value: undefined });
    for (const bad of [undefined, null, 42, {}, ['a'], { toString: () => 'a' }, 'x'.repeat(c.CLIPBOARD_MAX + 1)]) {
      const res = await ipc.call('clipboard:writeText', {}, bad);
      assert.equal(res.ok, false);
      assert.equal(res.error.kind, 'invalid-args', typeof bad === 'string' ? 'too long' : JSON.stringify(bad));
    }
    assert.deepEqual(written, [sha, 'x'.repeat(c.CLIPBOARD_MAX)]);
    assert.ok(log.recs.every(([level, msg]) => level === 'warn' && msg === 'refused a call'));
    // A write that fails in main is a serialized error the page's toast can show.
    const broken = createHandlers({ controller: { tabs: {} }, clipboard: { writeText: () => { throw new Error('no pasteboard'); } } });
    const b = register({ handlers: { ...allHandlers(), 'clipboard:writeText': broken['clipboard:writeText'] } });
    assert.deepEqual(await b.ipc.call('clipboard:writeText', {}, sha), { ok: false, error: { message: 'no pasteboard', kind: null, exitCode: null } });
  });

  test('app:revealWorktree: shows only a worktree `git worktree list` gives now; a switched repo resolves false', async () => {
    const list = [
      { path: '/w/.bare', bare: true, prunable: false, missing: false }, { path: '/w/main', prunable: false, missing: false },
      { path: '/w/gone', prunable: true, missing: true }, { path: '/w/usb', locked: true, prunable: false, missing: true },
    ];
    const shown = [];
    let listing = async () => list;
    const session = { id: 5, repo: { root: '/r' } };
    const main = createHandlers({ controller: { tabs: {} }, listWorktrees: (root) => { assert.equal(root, '/r'); return listing(); }, shell: { showItemInFolder: (p) => shown.push(p) } });
    const { ipc } = register({ handlers: { ...allHandlers(), 'app:revealWorktree': main['app:revealWorktree'] }, ctx: { kind: 'view', session, senderId: 5 } });
    assert.deepEqual(await ipc.call('app:revealWorktree', {}, '/w/main'), { ok: true, value: true });
    assert.deepEqual(shown, ['/w/main']);
    for (const bad of ['/etc', '/w/gone', '/w/usb', '/w/main/']) {
      const res = await ipc.call('app:revealWorktree', {}, bad);
      assert.equal(res.ok, false);
      assert.equal(res.error.kind, 'not-found', bad);
    }
    assert.deepEqual(shown, ['/w/main'], 'no call for an unlisted path or a folder that is gone (prunable, or locked and missing)');
    assert.deepEqual(await ipc.call('app:revealWorktree', {}, '/w/.bare'), { ok: true, value: true }, 'the bare entry is a real folder');
    shown.pop();
    listing = async () => { session.repo = { root: '/other' }; return list; };
    assert.deepEqual(await ipc.call('app:revealWorktree', {}, '/w/main'), { ok: true, value: false });
    assert.deepEqual(shown, ['/w/main'], 'the repo switched: nothing shown');
    session.repo = null;
    const none = await ipc.call('app:revealWorktree', {}, '/w/main');
    assert.equal(none.error.kind, 'no-repo');
    assert.deepEqual(shown, ['/w/main']);
  });

  test('clipboard:writeText: a tab\'s page only (not the strip), and no repo needed', () => {
    const spec = c.CHANNELS['clipboard:writeText'];
    assert.deepEqual(spec.from, ['view']);
    assert.ok(!spec.needsRepo && !spec.send);
    assert.ok(c.VIEW_CHANNELS.has('clipboard:writeText'));
    assert.ok(!c.STRIP_CHANNELS.has('clipboard:writeText'));
  });

  test('app:log: fire and forget, only from a trusted sender', () => {
    const got = [];
    const handlers = { ...allHandlers(), 'app:log': (ctx, ...a) => got.push([ctx.senderId, ...a]) };
    const { ipc } = register({ handlers });
    ipc.listeners.get('app:log')({}, 'info', 'hi', { a: 1 });
    assert.deepEqual(got, [[5, 'info', 'hi', { a: 1 }]]);
    const refused = register({ handlers, ctx: null });
    refused.ipc.listeners.get('app:log')({}, 'info', 'x');
    assert.equal(got.length, 1);
  });
});

// ---------------------------------------------------------------- clone

describe('the clone channels', () => {
  const CLONE = ['app:cloneDefaults', 'app:pickCloneParent', 'app:clone', 'app:openCloned'];

  test('a tab\'s page only (never the strip), and no repo needed: a start-screen tab can clone', () => {
    for (const ch of CLONE) {
      assert.deepEqual(c.CHANNELS[ch].from, ['view'], ch);
      assert.ok(!c.CHANNELS[ch].needsRepo && !c.CHANNELS[ch].send, ch);
      assert.equal(c.routeSender({ senderId: 1, mainFrame: true, url: 'file:///x/tabs.html' }, ch, {
        stripId: 1, isView: () => false, isPage: () => true,
      }), null, `${ch}: a strip sender is refused`);
    }
    assert.deepEqual(Object.keys(c.CHANNELS).filter((ch) => /clone/i.test(ch)).sort(), [...CLONE].sort(), 'four clone channels');
    assert.equal(c.EVENTS.CLONE_PROGRESS, 'clone-progress');
    assert.equal(c.MENU_COMMANDS.CLONE, 'clone');
  });

  test('cloneRequest: three fields picked, extra ones dropped; the URL, the name and the parent display bounded; refusals quote no value', () => {
    const ok = c.cloneRequest({ kind: 'local', url: 'https://h/r.git', name: 'r', parent: '~/code', path: '/etc', extra: 1 });
    assert.deepEqual(ok, { url: 'https://h/r.git', name: 'r', parent: '~/code' });
    const secret = 'https://u:hunter2@h/r';
    const bad = [
      null, 'x', ['url'], {}, { url: `${secret}${'x'.repeat(2048)}`, name: 'r', parent: '~' },
      { url: 42, name: 'r', parent: '~' },
      { url: secret, name: 'r' },
      { url: `${secret}${'x'.repeat(2048)}`, name: 'r', parent: '~' },
      { url: secret, name: 'x'.repeat(256), parent: '~' },
      { url: secret, name: 'a\0b', parent: '~' },
      { url: secret, name: 'r', parent: 'p'.repeat(4097) },
      { url: `${secret}\0`, name: 'r', parent: '~' },
      { url: secret, name: { toString: () => 'r' }, parent: '~' },
    ];
    for (const v of bad) {
      const err = (() => { try { c.cloneRequest(v); return null; } catch (e) { return e; } })();
      assert.ok(err, JSON.stringify(v));
      assert.equal(err.kind, 'invalid-args');
      assert.ok(!err.message.includes('hunter2') && !err.message.includes('xxxx'), err.message);
    }
    assert.equal(c.cloneRequest({ url: 'u'.repeat(2048), name: 'r', parent: 'p'.repeat(4096) }).parent.length, 4096, 'a parent display may be a long path');
  });

  test('registered: the request and the opId are coerced, a refusal is logged without the URL, and a clone failure is QUIET', async () => {
    const seen = [];
    const handlers = allHandlers();
    handlers['app:clone'] = (ctx, req, opId) => { seen.push([req, opId]); throw Object.assign(new Error("fatal: repository 'https://u:hunter2@h/r/' not found"), { kind: 'not-found' }); };
    const { ipc, log } = register({ handlers, ctx: { kind: 'view', session: { id: 5, repo: null }, senderId: 5 } });
    const res = await ipc.call('app:clone', {}, { url: 'https://h/r', name: 'r', parent: '~', more: 1 }, 'op-1', 'extra');
    assert.equal(res.error.kind, 'not-found');
    assert.deepEqual(seen, [[{ url: 'https://h/r', name: 'r', parent: '~' }, 'op-1']]);
    assert.deepEqual(log.recs, [], 'app:clone failures are logged by the runner / the clone service only');
    assert.equal((await ipc.call('app:clone', {}, { url: 'https://u:hunter2@h/r', name: 'r', parent: '~' })).error.kind, 'invalid-args', 'the opId is required');
    assert.equal((await ipc.call('app:clone', {}, { url: 'https://u:hunter2@h/r', name: 7, parent: '~' }, 'op-2')).error.kind, 'invalid-args');
    assert.ok(log.recs.length > 0);
    assert.ok(!JSON.stringify(log.recs).includes('hunter2'), 'refusal records never carry the URL');
    assert.ok(require('../main/ipc').QUIET.has('app:clone'));
  });

  test('main\'s handlers pass the tab\'s session to the clone service, never a path', async () => {
    const calls = [];
    const clone = new Proxy({}, { get: (_, name) => (...a) => { calls.push([name, ...a]); return name; } });
    const h = createHandlers({ controller: { tabs: {} }, clone });
    const session = { id: 5 };
    const ctx = { session };
    assert.equal(await h['app:cloneDefaults'](ctx), 'defaults');
    await h['app:pickCloneParent'](ctx);
    await h['app:clone'](ctx, { url: 'https://h/r' }, 'op-1');
    await h['app:openCloned'](ctx, 'op-1');
    assert.deepEqual(calls, [['defaults', session], ['pickParent', session], ['clone', session, { url: 'https://h/r' }, 'op-1'], ['openCloned', session, 'op-1']]);
  });

  test('app:cancel: a clone still in its checks is cancelled by the service; anything else by the runner, by owned opId', async () => {
    const cancelled = [];
    let pending = true;
    const clone = { cancelPending: (s, opId) => { cancelled.push(['service', s.id, opId]); return pending; } };
    const runner = { cancel: (id) => { cancelled.push(['runner', id]); return true; } };
    const h = createHandlers({ controller: { tabs: {} }, clone, runner });
    const ctx = { session: { id: 5 } };
    assert.equal(h['app:cancel'](ctx, 'op-1'), true);
    pending = false;
    assert.equal(h['app:cancel'](ctx, 'op-2'), true);
    assert.deepEqual(cancelled, [['service', 5, 'op-1'], ['service', 5, 'op-2'], ['runner', 't5:op-2']]);
  });
});

// ---------------------------------------------------------------- routing

// The page URLs below spell POSIX paths; on Windows they are on the current drive (a file URL
// without one is no absolute path there), as path.resolve puts '/app/...'.
const DRIVE = process.platform === 'win32' ? `${path.resolve('/').slice(0, 2)}/` : '';
const FILE = `file:///${DRIVE}`;

describe('IPC routing (routeSender)', () => {
  const INDEX = path.resolve('/app/renderer/index.html');
  const TABS = path.resolve('/app/renderer/tabs.html');
  const o = (extra = {}) => ({
    stripId: 1,
    isView: (id) => id === 5 || id === 6,
    isPage: (url, which) => c.isIndexUrl(url, which === 'tabs' ? TABS : INDEX),
    ...extra,
  });
  const view = (id, url = `${FILE}app/renderer/index.html`, mainFrame = true) => ({ senderId: id, mainFrame, url });

  test('a tab view reaches its own session for the page channels', () => {
    for (const ch of c.VIEW_CHANNELS) assert.deepEqual(c.routeSender(view(5), ch, o()), { kind: 'view', id: 5 });
    assert.deepEqual(c.routeSender(view(6), 'op', o()), { kind: 'view', id: 6 });
  });

  test('app:openWorktree is a page channel, never the strip\'s', () => {
    assert.ok(c.VIEW_CHANNELS.has('app:openWorktree'));
    assert.deepEqual(c.routeSender(view(5), 'app:openWorktree', o()), { kind: 'view', id: 5 });
    assert.equal(c.routeSender(view(1, `${FILE}app/renderer/tabs.html`), 'app:openWorktree', o()), null);
  });

  test('the strip reaches only the tab channels, and a view not the strip-only ones', () => {
    const strip = view(1, `${FILE}app/renderer/tabs.html`);
    for (const ch of c.STRIP_CHANNELS) assert.deepEqual(c.routeSender(strip, ch, o()), { kind: 'strip' });
    for (const ch of ['op', 'app:getState', 'app:openRecent', 'app:cancel']) assert.equal(c.routeSender(strip, ch, o()), null);
    assert.equal(c.routeSender(view(5), 'tabs:menu', o()), null);
    assert.equal(c.routeSender(view(5), 'tabs:close', o()), null);
  });

  test('smoke runs let a view drive the tabs (list / close / move / probe)', () => {
    for (const ch of c.SMOKE_VIEW_CHANNELS) {
      assert.equal(c.routeSender(view(5), ch, o()), null);
      assert.deepEqual(c.routeSender(view(5), ch, o({ smoke: true })), { kind: 'view', id: 5 });
    }
  });

  test('refused: unknown senders, subframes, the wrong page, unknown channels', () => {
    assert.equal(c.routeSender(view(9), 'op', o()), null); // not ours
    assert.equal(c.routeSender(view(5, undefined, false), 'op', o()), null); // an iframe
    assert.equal(c.routeSender(view(5, `${FILE}app/renderer/tabs.html`), 'op', o()), null); // a view showing the strip page
    assert.equal(c.routeSender(view(1, `${FILE}app/renderer/index.html`), 'tabs:list', o()), null); // strip showing index
    assert.equal(c.routeSender(view(5, 'https://evil.example/index.html'), 'op', o()), null);
    assert.equal(c.routeSender(view(5), 'app:secret', o()), null);
    assert.equal(c.routeSender(view(1, `${FILE}app/renderer/tabs.html`), 'tabs:list', o({ stripId: null })), null);
    assert.equal(c.routeSender(undefined, 'op', o()), null);
  });

  test('opIds are namespaced per tab', () => {
    assert.equal(c.ownedOpId(5, 'op-1'), 't5:op-1');
    assert.notEqual(c.ownedOpId(5, 'op-1'), c.ownedOpId(6, 'op-1'));
  });
});


const ODD_DIRS = ['/Users/me/My Apps', '/Users/me/café', '/Users/me/hash#dir', '/Users/me/brk[x]', '/Users/me/pct%41',
  "/Users/me/it's", '/Users/me/par(en)', '/Users/me/q?uery', '/Users/me/a&b=c;d', '/Users/me/emoji😀', '/Users/me/plus+~!$'];

test('isIndexUrl: accepts our index.html under odd directory names, however the URL is escaped', () => {
  for (const dir of ODD_DIRS) {
    const index = path.resolve(dir, 'pl', 'renderer', 'index.html');
    const nodeUrl = pathToFileURL(index).href;
    assert.ok(c.isIndexUrl(nodeUrl, index), `node-escaped ${nodeUrl}`);
    // Chromium leaves '[', ']', "'", '(', ')' and friends unescaped.
    const chromeUrl = nodeUrl.replace(/%5B/g, '[').replace(/%5D/g, ']').replace(/%27/g, "'").replace(/%28/g, '(').replace(/%29/g, ')');
    assert.ok(c.isIndexUrl(chromeUrl, index), `chromium-escaped ${chromeUrl}`);
    assert.ok(c.isIndexUrl(`${nodeUrl}#section`, index), 'fragment ignored');
    assert.ok(c.isIndexUrl(`${nodeUrl}?q=1`, index), 'query ignored');
  }
});

test('isIndexUrl: %41 in a directory name is not confused with "A"', () => {
  const index = path.resolve('/Users/me/pct%41/renderer/index.html');
  assert.ok(c.isIndexUrl(`${FILE}Users/me/pct%2541/renderer/index.html`, index));
  // The URL loadFile used to produce (unescaped '%') names a different folder.
  assert.equal(c.isIndexUrl(`${FILE}Users/me/pct%41/renderer/index.html`, index), false);
  assert.ok(c.isIndexUrl(`${FILE}Users/me/pctA/renderer/index.html`, path.resolve('/Users/me/pctA/renderer/index.html')));
});

test('isIndexUrl: rejects other files, other schemes, hosts and garbage', () => {
  const index = path.resolve('/app/renderer/index.html');
  const reject = [
    `${FILE}app/renderer/other.html`,
    `${FILE}app/renderer/index.html/`,
    `${FILE}app/renderer/INDEX.html`,
    `${FILE}app/renderer/../renderer2/index.html`,
    `${FILE}app/renderer%2Findex.html`,
    `${FILE}evil/app/renderer/index.html`,
    'file://server/app/renderer/index.html',
    'http://localhost/app/renderer/index.html',
    'https://example.com/app/renderer/index.html',
    'data:text/html,<p>x</p>',
    'about:blank',
    'about:srcdoc',
    'devtools://devtools/bundled/inspector.html',
    'chrome-error://chromewebdata/',
    'javascript:alert(1)',
    '',
    'not a url',
    null,
    undefined,
    42,
  ];
  for (const u of reject) assert.equal(c.isIndexUrl(u, index), false, String(u));
  // Dot segments normalise to the same file: accepted (it IS our file).
  assert.ok(c.isIndexUrl(`${FILE}app/x/../renderer/./index.html`, index));
  assert.ok(c.isIndexUrl(`file://localhost/${DRIVE}app/renderer/index.html`, index));
});

describe('main/app-id.js', () => {
  // Windows matches the running app to its Start menu shortcut by this id; the packed package.json
  // has no `build` to read it from at run time, so main keeps a copy (main/window.js re-exports it
  // for main.js; that module needs Electron, this one doesn't).
  test("APP_ID is electron-builder's appId (package.json build.appId)", () => {
    const { APP_ID } = require('../main/app-id');
    assert.equal(APP_ID, require('../package.json').build.appId);
  });
});
