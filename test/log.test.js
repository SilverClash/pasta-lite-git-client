'use strict';
// src/log.js: levels, JSON shape, redaction on write, buffering / flush, rotation, an unwritable
// folder, child scopes. Uses an in-memory fs, a fixed clock and a manual scheduler; one test
// uses a real read-only temp folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger, parseLevel, slotName } = require('../src/log');

const DIR = '/logs';

/** In-memory fs with the calls the logger uses; `failAppend` makes writes fail with that code. */
function memFs() {
  const files = new Map();
  const dirs = new Set();
  const err = (code) => Object.assign(new Error(code), { code });
  const m = {
    files,
    failAppend: null,
    appends: 0,
    mkdirSync: (d) => { dirs.add(d); },
    accessSync: () => {},
    statSync: (p) => {
      if (!files.has(p)) throw err('ENOENT');
      return { size: Buffer.byteLength(files.get(p)) };
    },
    appendFile: (p, data, cb) => {
      m.appends++;
      setImmediate(() => {
        if (m.failAppend) return cb(err(m.failAppend));
        files.set(p, (files.get(p) || '') + data);
        cb(null);
      });
    },
    appendFileSync: (p, data) => {
      if (m.failAppend) throw err(m.failAppend);
      files.set(p, (files.get(p) || '') + data);
    },
    rename: (a, b, cb) => {
      setImmediate(() => {
        if (!files.has(a)) return cb(err('ENOENT'));
        files.set(b, files.get(a));
        files.delete(a);
        cb(null);
      });
    },
    unlink: (p, cb) => { files.delete(p); setImmediate(() => cb(null)); },
    readFile: (p, enc, cb) => setImmediate(() => (files.has(p) ? cb(null, files.get(p)) : cb(err('ENOENT')))),
  };
  return m;
}

/** Scheduler that only runs when told: tick() runs every pending timer. */
function manualClock() {
  const timers = [];
  return {
    timers,
    schedule: (fn) => { const t = { fn }; timers.push(t); return t; },
    cancel: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    tick() { for (const t of timers.splice(0)) t.fn(); },
  };
}

const sink = () => { const lines = []; return { lines, write: (s) => { lines.push(s); } }; };

function setup(o = {}) {
  const mfs = o.fs || memFs();
  const clock = manualClock();
  const stderr = sink();
  const logger = createLogger({
    fs: mfs, now: () => Date.UTC(2026, 8, 25, 12, 0, 0), schedule: clock.schedule, cancel: clock.cancel, stderr, env: {}, ...o.opts,
  });
  if (o.configure !== false) logger.configure({ dir: DIR, ...o.cfg });
  const read = (name = 'main.log') => (mfs.files.get(path.join(DIR, name)) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { mfs, clock, stderr, logger, read };
}

test('parseLevel and slot names', () => {
  assert.equal(parseLevel('DEBUG'), 'debug');
  assert.equal(parseLevel(' warn '), 'warn');
  assert.equal(parseLevel('verbose'), 'info');
  assert.equal(parseLevel(undefined, 'error'), 'error');
  assert.equal(slotName('main.log', 0), 'main.log');
  assert.equal(slotName('main.log', 2), 'main.2.log');
  assert.equal(slotName('main', 1), 'main.1');
});

test('JSON lines {t, level, scope, msg, ...fields}; reserved names do not clobber', async () => {
  const { logger, read } = setup();
  logger.child('ops').info('op done', { op: 'push', ms: 12, level: 'x', msg: 'y' });
  await logger.flush();
  const [r] = read();
  assert.deepEqual(Object.keys(r).slice(0, 4), ['t', 'level', 'scope', 'msg']);
  assert.deepEqual(r, { t: '2026-09-25T12:00:00.000Z', level: 'info', scope: 'ops', msg: 'op done', op: 'push', ms: 12, _level: 'x', _msg: 'y' });
});

test('levels: default info; PL_LOG_LEVEL and level option override; enabled()', async () => {
  const a = setup();
  a.logger.debug('hidden');
  a.logger.info('shown');
  a.logger.warn('w');
  a.logger.error('e');
  await a.logger.flush();
  assert.deepEqual(a.read().map((r) => r.level), ['info', 'warn', 'error']);
  assert.equal(a.logger.enabled('debug'), false);

  const b = setup({ opts: { env: { PL_LOG_LEVEL: 'debug' } } });
  b.logger.debug('now shown');
  await b.logger.flush();
  assert.deepEqual(b.read().map((r) => r.msg), ['now shown']);

  const c = setup({ opts: { level: 'error', env: { PL_LOG_LEVEL: 'debug' } } });
  c.logger.warn('no');
  c.logger.error('yes');
  c.logger.write('bogus', 'x', 'never');
  await c.logger.flush();
  assert.deepEqual(c.read().map((r) => r.msg), ['yes']);
  c.logger.level = 'debug';
  assert.equal(c.logger.level, 'debug');
});

test('every record is redacted (message and fields); an Error as fields becomes {err}', async () => {
  const { logger, read } = setup();
  const e = Object.assign(new Error(`fatal: unable to access 'https://ada:${'ghp' + '_1234567890abcdefghijABCDEFGHIJ'}@github.com/'`), { kind: 'auth' });
  logger.error('push to https://u:p@host/x failed', e);
  logger.info('env', { env: { GITHUB_TOKEN: 'abc' }, input: 'commit body' });
  await logger.flush();
  const [a, b] = read();
  assert.equal(a.msg, 'push to https://***@host/x failed');
  assert.equal(a.err.kind, 'auth');
  assert.ok(!JSON.stringify(a).includes('ghp_'));
  assert.equal(b.env.GITHUB_TOKEN, '***');
  assert.equal(b.input, '[omitted]');
});

test('buffered: nothing is written until the timer fires; then one append for the batch', async () => {
  const { logger, mfs, clock, read } = setup();
  for (let i = 0; i < 5; i++) logger.info(`r${i}`);
  assert.equal(mfs.appends, 0, 'writing is deferred');
  assert.equal(clock.timers.length, 1, 'one timer for the batch');
  clock.tick();
  await new Promise((r) => setImmediate(r));
  await logger.flush();
  assert.equal(mfs.appends, 1);
  assert.deepEqual(read().map((r) => r.msg), ['r0', 'r1', 'r2', 'r3', 'r4']);
});

test('records logged while a write is in flight follow it in order', async () => {
  const { logger, clock, read } = setup();
  logger.info('a');
  clock.tick(); // write of 'a' starts (async)
  logger.info('b');
  logger.info('c');
  await logger.flush();
  assert.deepEqual(read().map((r) => r.msg), ['a', 'b', 'c']);
});

test('flushSync writes the queue synchronously (quit / fatal error)', () => {
  const { logger, read, clock } = setup();
  logger.warn('before quit');
  logger.flushSync();
  assert.deepEqual(read().map((r) => r.msg), ['before quit']);
  assert.equal(clock.timers.length, 0, 'the pending timer was cancelled');
  logger.flushSync(); // nothing queued: no-op
  assert.equal(read().length, 1);
});

test('rotation: main.log -> main.1.log -> main.2.log, the oldest dropped', async () => {
  const { logger, mfs, read } = setup({ opts: { maxBytes: 300, maxFiles: 3 } });
  const big = 'x'.repeat(150);
  for (let i = 0; i < 8; i++) {
    logger.info(`r${i}`, { pad: big });
    await logger.flush(); // one record per write
  }
  const names = [...mfs.files.keys()].map((p) => path.basename(p)).sort();
  assert.deepEqual(names, ['main.1.log', 'main.2.log', 'main.log']);
  for (const n of names) assert.ok(Buffer.byteLength(mfs.files.get(path.join(DIR, n))) <= 300, `${n} within the cap`);
  const all = [...read('main.2.log'), ...read('main.1.log'), ...read()].map((r) => r.msg);
  assert.deepEqual(all, all.slice().sort(), 'oldest to newest across the files');
  assert.equal(all[all.length - 1], 'r7');
  assert.ok(!all.includes('r0'), 'the oldest records were dropped');
  // tail() reads across the rotated files, newest last.
  const tail = await logger.tail(3);
  assert.deepEqual(tail.map((l) => JSON.parse(l).msg), all.slice(-3));
  assert.deepEqual(logger.files().map((p) => path.basename(p)), ['main.log', 'main.1.log', 'main.2.log']);
});

test('rotation continues from the size already on disk', async () => {
  const mfs = memFs();
  mfs.files.set(path.join(DIR, 'main.log'), 'y'.repeat(290) + '\n');
  const { logger } = setup({ fs: mfs, opts: { maxBytes: 300 } });
  logger.info('first after restart');
  await logger.flush();
  assert.equal(mfs.files.get(path.join(DIR, 'main.1.log')).length, 291, 'the old file rotated out');
  assert.match(mfs.files.get(path.join(DIR, 'main.log')), /first after restart/);
});

test('a failing write switches to stderr once, never throws and never loops', async () => {
  const { logger, mfs, stderr } = setup();
  mfs.failAppend = 'ENOSPC';
  logger.info('lost?');
  await logger.flush();
  assert.equal(logger.failed, 'ENOSPC');
  assert.equal(stderr.lines.filter((l) => /cannot write logs/.test(l)).length, 1);
  assert.ok(stderr.lines.some((l) => l.includes('"msg":"lost?"')), 'the failed chunk went to stderr');
  const before = mfs.appends;
  logger.error('after');
  logger.flushSync();
  await logger.flush();
  assert.equal(mfs.appends, before, 'no more file writes');
  assert.ok(stderr.lines.some((l) => l.includes('"msg":"after"')));
  assert.equal(stderr.lines.filter((l) => /cannot write logs/.test(l)).length, 1, 'reported once');
});

test('a folder that cannot be created or written: stderr only, configure() says false', async () => {
  const mfs = memFs();
  mfs.mkdirSync = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  const { logger, stderr } = setup({ fs: mfs, configure: false });
  logger.info('early'); // before configure: kept in memory
  assert.equal(logger.configure({ dir: DIR }), false);
  assert.equal(logger.failed, 'EACCES');
  logger.info('later');
  await logger.flush();
  const out = stderr.lines.join('');
  assert.ok(out.includes(`cannot write logs to ${path.join(DIR, 'main.log')}: EACCES`), out);
  assert.match(out, /"msg":"early"/);
  assert.match(out, /"msg":"later"/);
  assert.equal(mfs.files.size, 0);
});

test('a real read-only folder falls back to stderr', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-log-ro-'));
  fs.chmodSync(dir, 0o500);
  t.after(() => { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); });
  const stderr = sink();
  const logger = createLogger({ stderr, env: {} });
  assert.equal(logger.configure({ dir }), false);
  logger.info('to stderr');
  await logger.flush();
  assert.ok(stderr.lines.some((l) => l.includes('"msg":"to stderr"')));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a real writable folder: the file is created and appended to', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logger = createLogger({ env: {}, stderr: sink() });
  assert.equal(logger.configure({ dir: path.join(dir, 'nested') }), true);
  logger.info('one');
  logger.info('two');
  await logger.flush();
  const lines = fs.readFileSync(path.join(dir, 'nested', 'main.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((r) => r.msg), ['one', 'two']);
});

test('before configure records wait in memory (bounded) and are written once a folder is set', async () => {
  const { logger, read } = setup({ configure: false });
  logger.info('early 1');
  logger.info('early 2');
  await logger.flush(); // nowhere to write yet: resolves anyway
  logger.configure({ dir: DIR });
  await logger.flush();
  assert.deepEqual(read().map((r) => r.msg), ['early 1', 'early 2']);

  const u = setup({ configure: false });
  for (let i = 0; i < 700; i++) u.logger.info(`m${i}`);
  u.logger.configure({ dir: DIR });
  await u.logger.flush();
  const got = u.read();
  assert.equal(got[0].msg, 'dropped 200 log records (queue full)');
  assert.equal(got.length, 501);
  assert.equal(got[got.length - 1].msg, 'm699');
});

test('a full queue drops the oldest records and says how many', async () => {
  const { logger, read } = setup({ opts: { maxQueue: 10 } });
  for (let i = 0; i < 25; i++) logger.info(`q${i}`);
  await logger.flush();
  const got = read();
  assert.equal(got[0].msg, 'dropped 15 log records (queue full)');
  assert.equal(got[0].level, 'warn');
  assert.deepEqual(got.slice(1).map((r) => r.msg), Array.from({ length: 10 }, (_, i) => `q${i + 15}`));
});

test('mirror: a readable line on stderr per record (dev / smoke), the file still gets JSON', async () => {
  const { logger, stderr, read } = setup({ cfg: { mirror: true } });
  logger.child('quit').info('quitting: cancelled push', { n: 1 });
  await logger.flush();
  assert.deepEqual(stderr.lines, ['[Pasta Lite] info quit: quitting: cancelled push {"n":1}\n']);
  assert.equal(read()[0].msg, 'quitting: cancelled push');
});

test('child scopes nest and share the file; log(level) picks the level at run time', async () => {
  const { logger, read } = setup();
  const ops = logger.child('ops');
  ops.warn('a');
  ops.child('queue').info('b');
  ops.log('error', 'c');
  logger.info('d');
  await logger.flush();
  assert.deepEqual(read().map((r) => [r.scope, r.level, r.msg]), [
    ['ops', 'warn', 'a'], ['ops.queue', 'info', 'b'], ['ops', 'error', 'c'], ['app', 'info', 'd'],
  ]);
});

test('odd input never throws: huge records are cut, non-object fields kept as value', async () => {
  const { logger, read } = setup();
  const huge = { a: Array.from({ length: 50 }, () => 'z'.repeat(3000)) };
  logger.info('huge', huge);
  logger.info('scalar', 42);
  logger.info(null);
  const cyc = {};
  cyc.me = cyc;
  logger.info('cyclic', cyc);
  await logger.flush();
  const got = read();
  assert.ok(got[0].truncated > 16 * 1024, 'record replaced by a stub with its size');
  assert.equal(got[1].value, 42);
  assert.equal(got[2].msg, '');
  assert.equal(got[3].me, '[circular]');
});
