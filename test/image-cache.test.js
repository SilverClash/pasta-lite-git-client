'use strict';
// The image preview's object-URL cache (renderer/image-cache.js, window.PLImageCache): an LRU of
// blob: URLs keyed by RevisionKey, with a byte budget and pinning, over a fake URL api.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require(path.join(__dirname, '..', 'renderer', 'image-cache.js'));

/** A fake URL api: counts what was created and revoked, and keeps each Blob. */
function fakeUrls() {
  let n = 0;
  const live = new Map();
  return {
    created: 0,
    revoked: [],
    live,
    createObjectURL(blob) {
      this.created++;
      const url = `blob:file:///u${++n}`;
      live.set(url, blob);
      return url;
    },
    revokeObjectURL(url) {
      this.revoked.push(url);
      live.delete(url);
    },
  };
}

const bytes = (n) => new Uint8Array(n);

test('put: a typed Blob per key; a key already held keeps its URL', async () => {
  const urls = fakeUrls();
  const c = C.create(urls);
  const u = c.put('oid1', new Uint8Array([1, 2, 3]), 'image/webp');
  assert.match(u, /^blob:/);
  const blob = urls.live.get(u);
  assert.equal(blob.type, 'image/webp');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
  assert.equal(c.put('oid1', bytes(3), 'image/webp'), u, 're-put: same URL');
  assert.equal(urls.created, 1, 'no second Blob');
  assert.equal(c.get('oid1'), u);
  assert.equal(c.get('nope'), null);
  assert.equal(c.has('oid1'), true);
  assert.equal(c.size, 1);
  assert.equal(c.bytes, 3);
});

test('entry limit: the least recently used goes first, its URL revoked', () => {
  const urls = fakeUrls();
  const c = C.create(urls, { maxEntries: 3 });
  const a = c.put('a', bytes(1), 'image/png');
  c.put('b', bytes(1), 'image/png');
  c.put('c', bytes(1), 'image/png');
  c.get('a'); // a is now the most recent
  c.put('d', bytes(1), 'image/png');
  assert.equal(c.has('b'), false, 'b was the least recently used');
  assert.deepEqual(urls.revoked, ['blob:file:///u2']);
  assert.equal(c.get('a'), a);
  assert.equal(c.size, 3);
  c.put('c', bytes(1), 'image/png'); // a re-put touches too
  c.put('e', bytes(1), 'image/png');
  assert.equal(c.has('d'), false);
  assert.equal(c.has('c'), true);
});

test('byte budget: evicts until the total fits', () => {
  const urls = fakeUrls();
  const c = C.create(urls, { maxBytes: 100 });
  c.put('a', bytes(40), 'image/png');
  c.put('b', bytes(40), 'image/png');
  c.put('c', bytes(40), 'image/png');
  assert.deepEqual([c.has('a'), c.has('b'), c.has('c')], [false, true, true]);
  assert.equal(c.bytes, 80);
  c.put('big', bytes(100), 'image/png');
  assert.deepEqual([c.has('b'), c.has('c'), c.has('big')], [false, false, true], 'a side as large as the budget still fits alone');
  assert.equal(c.bytes, 100);
  assert.equal(urls.revoked.length, 3);
});

test('pin: the keys on screen are never evicted; a new pin set replaces the old one', () => {
  const urls = fakeUrls();
  const c = C.create(urls, { maxEntries: 2 });
  c.put('old', bytes(1), 'image/png');
  c.put('new', bytes(1), 'image/png');
  c.pin(['old', 'new', null]);
  c.put('x', bytes(1), 'image/png');
  c.put('y', bytes(1), 'image/png');
  assert.deepEqual([c.has('old'), c.has('new'), c.has('x'), c.has('y')], [true, true, false, true], 'over the limit while pinned, the rest is evicted');
  c.pin([]); // unpinned: the limit applies again
  assert.equal(c.size, 2);
  assert.deepEqual([c.has('old'), c.has('new'), c.has('y')], [false, true, true]);
});

test('clear: revokes every URL and forgets the pins', () => {
  const urls = fakeUrls();
  const c = C.create(urls);
  c.put('a', bytes(5), 'image/png');
  c.put('b', bytes(5), 'image/gif');
  c.pin(['a']);
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.bytes, 0);
  assert.equal(urls.revoked.length, 2);
  assert.equal(urls.live.size, 0, 'nothing left alive');
  c.put('a', bytes(5), 'image/png');
  assert.equal(urls.created, 3, 'a cleared key is made again');
});

test('defaults: 24 entries, 256 MB', () => {
  assert.equal(C.MAX_ENTRIES, 24);
  assert.equal(C.MAX_BYTES, 256 * 1024 * 1024);
  const urls = fakeUrls();
  const c = C.create(urls);
  for (let i = 0; i < 30; i++) c.put(`k${i}`, bytes(1), 'image/png');
  assert.equal(c.size, 24);
  assert.equal(urls.revoked.length, 6);
});
