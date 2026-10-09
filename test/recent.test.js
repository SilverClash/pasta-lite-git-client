'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const { createRecentStore, createTrustStore } = require('../src/recent');

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
