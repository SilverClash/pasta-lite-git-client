'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const { createRecentStore, createTrustStore, createClonePrefs } = require('../src/recent');

const dirs = (n) => Array.from({ length: n }, () => h.tmpDir('pl-recent-'));
const roots = (list) => list.map((e) => e.root);

test('add moves an entry to the front; list is newest first with names', async () => {
  const [a, b, c] = dirs(3);
  const file = path.join(h.tmpDir(), 'sub', 'recent.json');
  const store = createRecentStore(file);
  assert.deepEqual((await store.list()), []); // missing file
  store.add(a);
  store.add(b);
  store.add(c);
  assert.deepEqual(roots((await store.list())), [c, b, a]);
  store.add(a);
  assert.deepEqual(roots((await store.list())), [a, c, b]);
  assert.equal((await store.list())[0].name, path.basename(a));
  assert.ok((await store.list())[0].openedAt > 0);
  // Persisted: a new store over the same file sees the same list.
  assert.deepEqual(roots((await createRecentStore(file).list())), [a, c, b]);
});

test('keeps at most 10 entries', async () => {
  const all = dirs(12);
  const store = createRecentStore(path.join(h.tmpDir(), 'recent.json'));
  for (const d of all) store.add(d);
  const list = await store.list();
  assert.equal(list.length, 10);
  assert.deepEqual(roots(list), all.slice(2).reverse());
});

test('dedupes by real path (symlinks, trailing slash, relative segments)', async () => {
  const [a] = dirs(1);
  const link = path.join(h.tmpDir(), 'link');
  fs.symlinkSync(a, link);
  const store = createRecentStore(path.join(h.tmpDir(), 'recent.json'));
  store.add(a);
  store.add(link);
  store.add(`${a}/`);
  store.add(path.join(a, 'x', '..'));
  assert.deepEqual(roots((await store.list())), [a]);
});

test('list drops entries whose directory no longer exists; remove and clear', async () => {
  const [a, b, c] = dirs(3);
  const store = createRecentStore(path.join(h.tmpDir(), 'recent.json'));
  store.add(a);
  store.add(b);
  store.add(c);
  fs.rmSync(b, { recursive: true });
  assert.deepEqual(roots((await store.list())), [c, a]);
  store.remove(c);
  assert.deepEqual(roots((await store.list())), [a]);
  store.remove(b); // gone from disk: removed by its stored path
  store.clear();
  assert.deepEqual((await store.list()), []);
});

test('tolerates a corrupt or wrongly shaped file and overwrites it on the next add', async () => {
  const [a] = dirs(1);
  const file = path.join(h.tmpDir(), 'recent.json');
  for (const junk of ['{not json', '{"root": 1}', '[1, null, {"root": "relative/path"}, {"root": 5}]', '']) {
    fs.writeFileSync(file, junk);
    const store = createRecentStore(file);
    assert.deepEqual((await store.list()), []);
    store.add(a);
    assert.deepEqual(roots((await store.list())), [a]);
  }
});

test('writes atomically: temp file + rename, no leftovers', async () => {
  const [a] = dirs(1);
  const dir = h.tmpDir();
  const file = path.join(dir, 'recent.json');
  const store = createRecentStore(file);
  const renames = [];
  const orig = fs.renameSync;
  fs.renameSync = (from, to) => { renames.push([from, to]); return orig(from, to); };
  try {
    store.add(a);
  } finally {
    fs.renameSync = orig;
  }
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], file);
  assert.equal(path.dirname(renames[0][0]), dir);
  assert.match(path.basename(renames[0][0]), /^recent\.json\..*\.tmp$/);
  assert.deepEqual(fs.readdirSync(dir), ['recent.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => e.root), [a]);
});

test('a failed write leaves the previous file intact and no temp file', async () => {
  const [a, b] = dirs(2);
  const dir = h.tmpDir();
  const file = path.join(dir, 'recent.json');
  const store = createRecentStore(file);
  store.add(a);
  const before = fs.readFileSync(file, 'utf8');
  const orig = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk full'); };
  try {
    assert.throws(() => store.add(b), /disk full/);
  } finally {
    fs.renameSync = orig;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['recent.json']);
});

test('list is async and only keeps existing directories', async () => {
  const [a] = dirs(1);
  const store = createRecentStore(path.join(h.tmpDir(), 'recent.json'));
  store.add(a);
  const statSync = fs.statSync;
  fs.statSync = () => { throw new Error('sync stat on the main thread'); };
  try {
    const p = store.list();
    assert.ok(p instanceof Promise);
    assert.deepEqual(roots(await p), [a]);
  } finally {
    fs.statSync = statSync;
  }
});

// ---------------------------------------------------------------- trust store

test('trust store: a root is trusted only for the keys accepted, persisted by real path', () => {
  const [a, b] = dirs(2);
  const file = path.join(h.tmpDir(), 'sub', 'trusted.json');
  const store = createTrustStore(file);
  assert.equal(store.isTrusted(a, ['filter.x.clean']), false); // missing file
  store.trust(a, ['filter.x.clean']);
  assert.equal(store.isTrusted(a, ['filter.x.clean']), true);
  assert.equal(store.isTrusted(a, []), true);
  assert.equal(store.isTrusted(a, ['filter.x.clean', 'core.sshcommand']), false); // a new key asks again
  assert.equal(store.isTrusted(b, ['filter.x.clean']), false);
  store.trust(a, ['core.sshcommand']);
  const link = path.join(h.tmpDir(), 'link');
  fs.symlinkSync(a, link);
  const again = createTrustStore(file);
  assert.equal(again.isTrusted(link, ['filter.x.clean', 'core.sshcommand']), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ root: a, keys: ['core.sshcommand', 'filter.x.clean'] }]);
});

const caseInsensitiveFs = (() => {
  const [d] = dirs(1);
  return fs.existsSync(path.join(path.dirname(d), path.basename(d).toUpperCase()));
})();

test('trust store: an entry saved under another spelling (a symlink, another letter case) is the same repo; trust rewrites it once', () => {
  const [a] = dirs(1);
  const link = path.join(h.tmpDir(), 'link');
  fs.symlinkSync(a, link);
  // Saved by an older version that kept a non-canonical spelling.
  const upper = path.join(path.dirname(a), path.basename(a).toUpperCase());
  const saved = caseInsensitiveFs ? upper : link;
  const file = path.join(h.tmpDir(), 'trusted.json');
  fs.writeFileSync(file, JSON.stringify([{ root: saved, keys: ['filter.x.clean'] }]));
  const store = createTrustStore(file);
  assert.equal(store.isTrusted(a, ['filter.x.clean']), true, 'no second prompt');
  store.trust(a, ['core.sshcommand']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ root: a, keys: ['core.sshcommand', 'filter.x.clean'] }], 'one entry, by its real path');
});

test('recent store: an entry saved under another letter case is not listed twice', { skip: !caseInsensitiveFs && 'case-sensitive file system' }, async () => {
  const [a] = dirs(1);
  const upper = path.join(path.dirname(a), path.basename(a).toUpperCase());
  const file = path.join(h.tmpDir(), 'recent.json');
  fs.writeFileSync(file, JSON.stringify([{ root: upper, name: 'x', openedAt: 1 }]));
  const store = createRecentStore(file);
  store.add(a);
  assert.deepEqual(roots(await store.list()), [a]);
});

test('trust store tolerates a corrupt or wrongly shaped file', () => {
  const [a] = dirs(1);
  const file = path.join(h.tmpDir(), 'trusted.json');
  for (const junk of ['{not json', '{"root": 1}', `[null, {"root": "rel"}, {"root": ${JSON.stringify(a)}, "keys": "x"}, {"root": ${JSON.stringify(a)}, "keys": [1]}]`, '']) {
    fs.writeFileSync(file, junk);
    const store = createTrustStore(file);
    assert.equal(store.isTrusted(a, ['k']), false);
    store.trust(a, ['k']);
    assert.equal(store.isTrusted(a, ['k']), true);
  }
});

// ---------------------------------------------------------------- json-file: atomic writes

test('writeJson on Windows: a rename over a file held open (EPERM / EBUSY / EACCES) is tried again, briefly', () => {
  const { writeJson, readJson, _internal: { RENAME_DELAYS_MS } } = require('../src/json-file');
  const dir = h.tmpDir('pl-json-');
  const file = path.join(dir, 'tabs.json');
  writeJson(file, { v: 1 });
  const err = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
  // Held for two tries, then free: written, after two sleeps (no busy-wait).
  let fails = ['EPERM', 'EBUSY'];
  const slept = [];
  const rename = (from, to) => {
    if (fails.length) throw err(fails.shift());
    fs.renameSync(from, to);
  };
  const win = { platform: 'win32', rename, sleep: (ms) => slept.push(ms) };
  writeJson(file, { v: 2 }, win);
  assert.deepEqual(readJson(file), { v: 2 });
  assert.deepEqual(slept, RENAME_DELAYS_MS.slice(0, 2));
  // Held for good: bounded tries, the last error thrown, the tmp file removed, the old file kept.
  fails = Array(100).fill('EACCES');
  slept.length = 0;
  assert.throws(() => writeJson(file, { v: 3 }, win), { code: 'EACCES' });
  assert.equal(slept.length, RENAME_DELAYS_MS.length);
  assert.equal(fails.length, 100 - RENAME_DELAYS_MS.length - 1);
  assert.deepEqual(fs.readdirSync(dir), ['tabs.json']);
  assert.deepEqual(readJson(file), { v: 2 });
  // Other errors, and every error off Windows, are not retried.
  for (const [platform, code] of [['win32', 'ENOSPC'], ['linux', 'EPERM'], ['darwin', 'EBUSY']]) {
    fails = [code];
    slept.length = 0;
    assert.throws(() => writeJson(file, { v: 4 }, { ...win, platform }), { code }, `${platform} ${code}`);
    assert.deepEqual(slept, [], `${platform} ${code}`);
    assert.deepEqual(fs.readdirSync(dir), ['tabs.json']);
  }
});

test('sleepSync blocks for about the time asked', () => {
  const { sleepSync } = require('../src/json-file')._internal;
  const t0 = process.hrtime.bigint();
  sleepSync(20);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms >= 15 && ms < 1000, `${ms} ms`);
});

// ---------------------------------------------------------------- clone.json (createClonePrefs)

const made = (abs, ino = '42') => ({ abs, dev: '7', ino });

test('createClonePrefs: the last parent is kept while it is an absolute path to a directory', async () => {
  const [a] = dirs(1);
  const file = path.join(h.tmpDir(), 'sub', 'clone.json');
  const prefs = createClonePrefs(file);
  assert.equal(await prefs.lastParent(), null, 'missing file');
  await prefs.setLastParent(a);
  assert.equal(await prefs.lastParent(), a);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { lastParent: a });
  fs.rmSync(a, { recursive: true });
  assert.equal(await prefs.lastParent(), null, 'gone: no parent');
  await prefs.setLastParent('relative/x');
  assert.equal(await prefs.lastParent(), null);
  const f2 = path.join(h.tmpDir(), 'f');
  fs.writeFileSync(f2, '');
  await prefs.setLastParent(f2);
  assert.equal(await prefs.lastParent(), null, 'a file is no parent');
  fs.writeFileSync(file, '{corrupt');
  assert.equal(await prefs.lastParent(), null);
  assert.deepEqual(await prefs.pendingCleanup(), []);
});

test('createClonePrefs: pending removals are added once, dropped by identity, and malformed entries ignored', async () => {
  const dir = h.tmpDir();
  const file = path.join(dir, 'clone.json');
  const prefs = createClonePrefs(file);
  const a = made(path.join(dir, 'a'));
  const b = made(path.join(dir, 'b'), '43');
  await Promise.all([prefs.setLastParent(dir), prefs.addPendingCleanup(a), prefs.addPendingCleanup(b), prefs.addPendingCleanup({ ...a, extra: 'x' })]);
  assert.deepEqual(await prefs.pendingCleanup(), [b, a], 'edits run one after another on fresh reads; a re-add moves to the end');
  assert.equal(await prefs.lastParent(), dir, 'other fields kept');
  await prefs.dropPendingCleanup({ ...a, ino: '99' });
  assert.equal((await prefs.pendingCleanup()).length, 2, 'another folder at the same path is not this entry');
  await prefs.dropPendingCleanup(a);
  assert.deepEqual(await prefs.pendingCleanup(), [b]);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.pendingCleanup.push({ abs: 'rel', dev: '1', ino: '2' }, { abs: path.join(dir, 'c'), dev: 1, ino: '2' }, null, 'x');
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.deepEqual(await prefs.pendingCleanup(), [b], 'malformed entries are skipped');
});

test('addAsync: the same list add() makes, without blocking; calls run one after another', async () => {
  const [a, b, c] = dirs(3);
  const file = path.join(h.tmpDir(), 'recent.json');
  const store = createRecentStore(file, { max: 2 });
  store.add(a);
  await Promise.all([store.addAsync(b, { name: 'bee' }), store.addAsync(a)]);
  assert.deepEqual((await store.list()).map((e) => [e.root, e.name]), [[a, path.basename(a)], [b, 'bee']], 'deduplicated by real path, newest first');
  await store.addAsync(c);
  assert.deepEqual(roots(await store.list()), [c, a], 'capped at max');
  fs.mkdirSync(path.join(path.dirname(file), 'blocker.json'));
  await assert.rejects(createRecentStore(path.join(path.dirname(file), 'blocker.json')).addAsync(a), 'a failed write rejects (the caller logs it)');
});

test('createClonePrefs: a folder\'s entry replaces every older one for the same path; the birth time is kept', async () => {
  const dir = h.tmpDir();
  const prefs = createClonePrefs(path.join(dir, 'clone.json'));
  const abs = path.join(dir, 'r');
  await prefs.addPendingCleanup(made(abs, '1'));
  await prefs.addPendingCleanup({ ...made(abs, '1'), born: '123' });
  assert.deepEqual(await prefs.pendingCleanup(), [{ abs, dev: '7', ino: '1', born: '123' }]);
  await prefs.dropPendingCleanup(made(abs, '1'));
  assert.equal((await prefs.pendingCleanup()).length, 1, 'another birth time: another folder');
  await prefs.addPendingCleanup({ ...made(abs, '1'), born: 'x' });
  assert.deepEqual(await prefs.pendingCleanup(), [], 'a malformed birth time is no entry');
});

test('createClonePrefs: a write that fails is logged without the path, never thrown', async () => {
  const dir = h.tmpDir();
  const file = path.join(dir, 'clone.json');
  fs.mkdirSync(file); // a folder where the file goes: every rename fails
  const warned = [];
  const prefs = createClonePrefs(file, { log: { warn: (msg, fields) => warned.push([msg, fields]) } });
  await prefs.setLastParent(dir);
  await prefs.addPendingCleanup(made(path.join(dir, 'a')));
  assert.equal(warned.length, 2);
  assert.ok(warned.every(([, fields]) => !JSON.stringify(fields).includes(dir)));
  assert.equal(await prefs.lastParent(), null);
  assert.deepEqual(fs.readdirSync(dir), ['clone.json'], 'no tmp file left');
});

test('writeJsonAsync / readJsonAsync: atomic, and on Windows a held rename is tried again with timers', async () => {
  const { writeJsonAsync, readJsonAsync, _internal: { RENAME_DELAYS_MS } } = require('../src/json-file');
  const dir = h.tmpDir('pl-json-');
  const file = path.join(dir, 'sub', 'clone.json');
  assert.equal(await readJsonAsync(file), null);
  await writeJsonAsync(file, { v: 1 });
  assert.deepEqual(await readJsonAsync(file), { v: 1 });
  const err = (code) => Object.assign(new Error(code), { code });
  let fails = ['EPERM', 'EBUSY'];
  const waited = [];
  const rename = async (from, to) => {
    if (fails.length) throw err(fails.shift());
    await fs.promises.rename(from, to);
  };
  const win = { platform: 'win32', rename, wait: async (ms) => { waited.push(ms); } };
  await writeJsonAsync(file, { v: 2 }, win);
  assert.deepEqual(await readJsonAsync(file), { v: 2 });
  assert.deepEqual(waited, RENAME_DELAYS_MS.slice(0, 2));
  fails = Array(100).fill('EACCES');
  await assert.rejects(writeJsonAsync(file, { v: 3 }, win), { code: 'EACCES' });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['clone.json'], 'the tmp file is removed');
  fails = ['EPERM'];
  waited.length = 0;
  await assert.rejects(writeJsonAsync(file, { v: 4 }, { ...win, platform: 'darwin' }), { code: 'EPERM' });
  assert.deepEqual(waited, [], 'not retried off Windows');
  assert.deepEqual(await readJsonAsync(file), { v: 2 });
});
