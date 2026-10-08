'use strict';
// The OS thumbnailer adapter (src/os-thumbnail.js; docs/plans/image-preview.md §11.4, I4) with a fake
// `thumbnail` call in place of Electron's nativeImage.createThumbnailFromPath: the platforms, the
// private temp copy and its cleanup, the size asked for, the answers it refuses (QuickLook's file
// icon), failures, the timeout, cancellation and the concurrency limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const { createOsThumbnailer, requestSize, thumbnailOf, PREFIX } = require('../src/os-thumbnail');
const { png, isobmff, psd } = require('./image-fixtures');

const POSIX = process.platform !== 'win32';
const HEIC = isobmff(['heic', 'mif1'], 40, 30);

/** A promise with its resolve / reject outside. */
function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => Object.assign(d, { resolve, reject }));
  return d;
}

/**
 * A thumbnailer on darwin over a fake OS call: `answer(file, size, calls)` (default: a PNG of the
 * size asked for). calls: [{file, size, bytes, mode, dirMode}] as the call saw its file.
 */
function fake({ answer, ...o } = {}) {
  const tmpDir = h.tmpDir();
  const calls = [];
  const thumbnail = async (file, size) => {
    const st = fs.statSync(file);
    calls.push({ file, size, bytes: fs.readFileSync(file), mode: st.mode & 0o777, dirMode: fs.statSync(path.dirname(file)).mode & 0o777 });
    return answer ? answer(file, size, calls) : png(size.width, size.height);
  };
  const t = createOsThumbnailer({ thumbnail, platform: 'darwin', tmpDir, ...o });
  return { t, calls, tmpDir, left: () => fs.readdirSync(tmpDir) };
}

test('platforms: macOS has one; Windows (a synchronous Shell call in Electron), Linux, or no call given, has none', () => {
  const thumbnail = async () => null;
  assert.equal(createOsThumbnailer({ thumbnail, platform: 'darwin' }).by, 'macOS');
  assert.equal(createOsThumbnailer({ thumbnail, platform: 'win32' }), null);
  assert.equal(createOsThumbnailer({ thumbnail, platform: 'linux' }), null);
  assert.equal(createOsThumbnailer({ thumbnail, platform: 'freebsd' }), null);
  assert.equal(createOsThumbnailer({ platform: 'darwin' }), null);
  assert.ok(Object.isFrozen(createOsThumbnailer({ thumbnail, platform: 'darwin' })));
});

test('requestSize: the header\'s dimensions fitted into the box, never enlarged', () => {
  assert.deepEqual(requestSize({ width: 4032, height: 3024 }), { width: 1024, height: 768 });
  assert.deepEqual(requestSize({ width: 3024, height: 4032 }), { width: 768, height: 1024 });
  assert.deepEqual(requestSize({ width: 64, height: 48 }), { width: 64, height: 48 });
  assert.deepEqual(requestSize({ width: 100000, height: 1 }), { width: 1024, height: 1 });
  assert.deepEqual(requestSize({ width: 3000, height: 2000 }, 300), { width: 300, height: 200 });
});

test('thumbnailOf: a PNG no larger than the image, of its aspect ratio', () => {
  const d = { width: 3000, height: 2000 };
  assert.deepEqual(thumbnailOf(png(2048, 1365), d), { width: 2048, height: 1365 });
  assert.deepEqual(thumbnailOf(png(1024, 683), d), { width: 1024, height: 683 });
  assert.deepEqual(thumbnailOf(png(3000, 2000), d), { width: 3000, height: 2000 });
  assert.equal(thumbnailOf(png(1024, 1024), d), null, 'QuickLook\'s square file icon');
  assert.equal(thumbnailOf(png(4096, 2731), d), null, 'larger than the image');
  assert.equal(thumbnailOf(png(1024, 700), d), null, 'another aspect ratio');
  // Turned a quarter: the header's dimensions missed a turn the OS applied.
  assert.deepEqual(thumbnailOf(png(683, 1024), d), { width: 683, height: 1024 });
  assert.deepEqual(thumbnailOf(png(1024, 683), { width: 2000, height: 3000 }), { width: 1024, height: 683 });
  assert.equal(thumbnailOf(png(2000, 3000), { width: 1000, height: 1500 }), null, 'turned and larger than the image');
  assert.equal(thumbnailOf(png(700, 1024), d), null, 'turned, another aspect ratio');
  assert.equal(thumbnailOf(Buffer.from('not a png'), d), null);
  assert.equal(thumbnailOf(null, d), null);
  assert.equal(thumbnailOf(Buffer.alloc(0), d), null);
});

test('render: a private temp copy named by the format, the size asked for, the PNG back; the copy is removed', async () => {
  const { t, calls, tmpDir, left } = fake();
  const res = await t.render(HEIC, { format: 'heic', dims: { width: 40, height: 30 } });
  assert.deepEqual([res.width, res.height], [40, 30]);
  assert.ok(res.png.equals(png(40, 30)));
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.ok(c.bytes.equals(HEIC), 'the bytes read for the side');
  assert.deepEqual(c.size, { width: 40, height: 30 });
  assert.equal(path.basename(c.file), 'image.heic');
  assert.equal(path.dirname(path.dirname(c.file)), tmpDir);
  assert.ok(path.basename(path.dirname(c.file)).startsWith(PREFIX));
  if (POSIX) assert.deepEqual([c.mode, c.dirMode], [0o600, 0o700]);
  await t.idle();
  assert.deepEqual(left(), [], 'nothing left behind');

  const big = psd(4000, 3000);
  const r2 = await t.render(big, { format: 'psd', dims: { width: 4000, height: 3000 } });
  assert.deepEqual([r2.width, r2.height, path.basename(calls[1].file), calls[1].size], [1024, 768, 'image.psd', { width: 1024, height: 768 }]);
  await t.render(Buffer.from('II*\0'), { format: 'tiff', dims: { width: 9, height: 8 } });
  assert.equal(path.basename(calls[2].file), 'image.tif');
  await t.idle();
  assert.deepEqual(left(), []);
});

test('render: refused and failed answers are null, and the copy is removed every time', async () => {
  const answers = {
    'the file icon': () => png(1024, 1024),
    'larger than the image': () => png(80, 60),
    'not a PNG': () => Buffer.from('nope'),
    'an empty answer': () => null,
    'a rejection': () => Promise.reject(new Error('unable to retrieve thumbnail preview image for the given path')),
    'a throw': () => { throw new Error('boom'); },
  };
  for (const [what, answer] of Object.entries(answers)) {
    const { t, calls, left } = fake({ answer });
    assert.equal(await t.render(HEIC, { format: 'heic', dims: { width: 40, height: 30 } }), null, what);
    assert.equal(calls.length, 1, what);
    await t.idle();
    assert.deepEqual(left(), [], what);
  }
});

test('render: no header dimensions or not a format for the OS: nothing is asked', async () => {
  const { t, calls, left } = fake();
  assert.equal(await t.render(HEIC, { format: 'heic', dims: null }), null);
  assert.equal(await t.render(HEIC, { format: 'svgz', dims: { width: 1, height: 1 } }), null);
  assert.equal(await t.render(png(2, 2), { format: 'png', dims: { width: 2, height: 2 } }), null);
  assert.equal(await t.render(HEIC, { format: 'jxl', dims: { width: 1, height: 1 } }), null);
  assert.equal(calls.length, 0);
  assert.deepEqual(left(), []);
});

test('render: a temp folder that can\'t be made is null, not an error', async () => {
  const thumbnail = async () => assert.fail('never called');
  const t = createOsThumbnailer({ thumbnail, platform: 'darwin', tmpDir: path.join(h.tmpDir(), 'missing', 'dir') });
  assert.equal(await t.render(HEIC, { format: 'heic', dims: { width: 40, height: 30 } }), null);
});

test('render: cancelled before, or while the OS works: kind aborted at once; the copy goes when the OS call ends', async () => {
  const gate = deferred();
  const { t, calls, left } = fake({ answer: () => gate.promise });
  const before = new AbortController();
  before.abort();
  await assert.rejects(t.render(HEIC, { format: 'heic', dims: { width: 40, height: 30 }, signal: before.signal }), { kind: 'aborted' });
  assert.equal(calls.length, 0, 'never asked');

  const ctrl = new AbortController();
  const p = t.render(HEIC, { format: 'heic', dims: { width: 40, height: 30 }, signal: ctrl.signal });
  while (!calls.length) await new Promise((r) => setTimeout(r, 5));
  ctrl.abort();
  await assert.rejects(p, { kind: 'aborted' });
  assert.equal(left().length, 1, 'the OS still has the file');
  gate.resolve(png(40, 30));
  await t.idle();
  assert.deepEqual(left(), [], 'removed once the call ended');
});

test('render: no answer within the timeout is null; the copy goes when the call ends', async () => {
  const gate = deferred();
  const { t, left } = fake({ answer: () => gate.promise, timeoutMs: 30 });
  assert.equal(await t.render(HEIC, { format: 'heic', dims: { width: 40, height: 30 } }), null);
  assert.equal(left().length, 1);
  gate.reject(new Error('late'));
  await t.idle();
  assert.deepEqual(left(), []);
});

test('render: an answer turned a quarter is taken (portrait thumbnail of a landscape header)', async () => {
  const { t, calls } = fake({ answer: (file, size) => png(size.height, size.width) });
  const res = await t.render(HEIC, { format: 'heic', dims: { width: 40, height: 30 } });
  assert.deepEqual([res.width, res.height, calls.length], [30, 40, 1]);
  await t.idle();
});

test('render: the timeout covers waiting for a slot and the OS call together', async () => {
  const gate = deferred();
  const timeoutMs = 200;
  const { t, calls, left } = fake({ answer: () => gate.promise, concurrent: 1, timeoutMs });
  const dims = { width: 40, height: 30 };
  const a = t.render(HEIC, { format: 'heic', dims });
  while (!calls.length) await new Promise((r) => setTimeout(r, 5));
  const t0 = Date.now();
  // b waits for a's slot; a hangs, so at a's deadline its slot is b's, whose own deadline comes soon after.
  assert.equal(await t.render(HEIC, { format: 'heic', dims }), null);
  const took = Date.now() - t0;
  assert.ok(took < timeoutMs * 1.6, `one deadline over the wait and the call (${took} ms)`);
  assert.equal(await a, null);
  assert.equal(calls.length, 2);
  gate.resolve(png(40, 30));
  await t.idle();
  assert.deepEqual(left(), []);
});

test('render: a hung OS call stops holding its slot at its deadline; while maxAbandoned hang, nothing new is asked', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const { t, calls, left } = fake({
    answer: (file, size, all) => (all.length <= gates.length ? gates[all.length - 1].promise : png(size.width, size.height)),
    concurrent: 1, timeoutMs: 30, maxAbandoned: 2,
  });
  const dims = { width: 40, height: 30 };
  assert.equal(await t.render(HEIC, { format: 'heic', dims }), null, 'the first hangs: null at its deadline');
  assert.equal(t.busy(), true);
  // A cancelled call holds its slot until it ends or its deadline passes, then frees it as well.
  const ctrl = new AbortController();
  const b = t.render(HEIC, { format: 'heic', dims, signal: ctrl.signal });
  while (calls.length < 2) await new Promise((r) => setTimeout(r, 5));
  ctrl.abort();
  await assert.rejects(b, { kind: 'aborted' });
  const c = t.render(HEIC, { format: 'heic', dims });
  assert.equal(await c, null, 'it waited for the cancelled call\'s deadline, and got no slot then: two calls hang');
  assert.equal(calls.length, 2);
  assert.equal(await t.render(HEIC, { format: 'heic', dims }), null, 'two hang: null at once');
  assert.equal(calls.length, 2, 'not handed to the OS');
  gates[0].resolve(null); // one hung call ends
  while (left().length > 1) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 5));
  const d = t.render(HEIC, { format: 'heic', dims });
  while (calls.length < 3) await new Promise((r) => setTimeout(r, 5));
  gates[2].resolve(png(40, 30));
  assert.equal((await d).width, 40, 'asked again once fewer hang');
  gates[1].resolve(null);
  await t.idle();
  assert.equal(t.busy(), false);
  assert.deepEqual(left(), []);
});

test('sweep: removes the thumbnailer\'s own old temp folders only', async () => {
  const { t, tmpDir, left } = fake();
  const old = Date.now() / 1000 - 2 * 3600;
  const mk = (name, { file = false, age = old } = {}) => {
    const p = path.join(tmpDir, name);
    if (file) fs.writeFileSync(p, 'x');
    else fs.mkdirSync(path.join(p, 'sub'), { recursive: true });
    fs.utimesSync(p, age, age);
  };
  mk(`${PREFIX}old`);
  mk(`${PREFIX}new`, { age: Date.now() / 1000 });
  mk(`${PREFIX}file`, { file: true });
  mk('other-old');
  if (POSIX) {
    const target = path.join(h.tmpDir(), `${PREFIX}target`);
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(tmpDir, `${PREFIX}link`));
    fs.lutimesSync(path.join(tmpDir, `${PREFIX}link`), old, old);
  }
  assert.equal(await t.sweep(), 1);
  assert.deepEqual(left().sort(), [`${PREFIX}file`, ...(POSIX ? [`${PREFIX}link`] : []), `${PREFIX}new`, 'other-old'].sort());
  assert.equal(await t.sweep({ maxAgeMs: 0, now: Date.now() + 1000 }), 1, 'the recent one, when asked');
  const missing = createOsThumbnailer({ thumbnail: async () => null, platform: 'darwin', tmpDir: path.join(tmpDir, 'nope') });
  assert.equal(await missing.sweep(), 0, 'no temp folder: nothing, no error');
});

test('render: at most `concurrent` OS calls; a call cancelled while it waits never reaches the OS', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const { t, calls, left } = fake({ answer: (file, size, all) => gates[all.length - 1].promise, concurrent: 1 });
  const dims = { width: 40, height: 30 };
  const a = t.render(HEIC, { format: 'heic', dims });
  const waiting = new AbortController();
  const b = t.render(HEIC, { format: 'heic', dims, signal: waiting.signal });
  const c = t.render(HEIC, { format: 'heic', dims });
  while (!calls.length) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1, 'one at a time');
  waiting.abort();
  await assert.rejects(b, { kind: 'aborted' });
  gates[0].resolve(png(40, 30));
  assert.equal((await a).width, 40);
  while (calls.length < 2) await new Promise((r) => setTimeout(r, 5));
  gates[1].resolve(png(20, 15));
  assert.equal((await c).width, 20, 'the third ran second');
  assert.equal(calls.length, 2, 'the cancelled one never ran');
  await t.idle();
  assert.deepEqual(left(), []);
});
