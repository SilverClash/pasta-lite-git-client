'use strict';
// The image preview reads (docs/plans/image-preview.md §10.2): imageSide's policy (pure), and
// commitImageSide / workdirImageSide end to end against throwaway repos - which blob or file each
// side is, the caps (an over-cap blob is never read), knownKey, Git LFS pointers and the local LFS
// cache, conflict stages, special entries, the path guards, cancellation and bare repositories.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const ops = require('../src/ops');
const exec = require('../src/exec');
const { findOnPath } = require('../src/which');
const { CHANNELS } = require('../src/ipc-contract');
const { imageSide, readLimit, revisionKey, thumbnailKey, thumbnailSide, testHooks } = require('../src/image-preview');
const { createOsThumbnailer } = require('../src/os-thumbnail');
const { POLICY } = require('../src/image-format');
const { png, jpeg, webpVp8x, svg, isobmff, tiff, psd } = require('./image-fixtures');

const runner = ops.createRunner();
const rev = (dir, r) => h.git(dir, 'rev-parse', r).trim();
const commitSide = (dir, sha, file, orig, side, o) => runner.run(dir, 'commitImageSide', [sha, file, orig, side, o]);
const workdirSide = (dir, file, wo, side, o) => runner.run(dir, 'workdirImageSide', [file, wo, side, o]);

/** A repo with `files` ({path: bytes}) committed in one commit. */
function repoWith(files, message = 'images') {
  const dir = h.initRepo();
  for (const [f, b] of Object.entries(files)) h.write(dir, f, b);
  h.git(dir, 'add', '-A');
  h.git(dir, 'commit', '-q', '-m', message);
  return dir;
}

/** Small caps for one test (testHooks.policy), restored after it. */
function smallCaps(t, caps = {}) {
  testHooks.policy = Object.freeze({
    ...POLICY, sniffBytes: 64, softMaxBytes: 300, maxBytes: 600, svgMaxBytes: 200, maxPixels: 400, ...caps,
  });
  t.after(() => { testHooks.policy = null; });
}

/**
 * A git that runs the real one, but touches `marker` whenever `cat-file blob` runs, and with
 * `hang` then sleeps instead (killed by a cancel). Used for "never read" and cancellation.
 */
function spyGit(t, { hang = false } = {}) {
  const real = findOnPath(process.platform === 'win32' ? 'git.exe' : 'git');
  const dir = h.tmpDir();
  const marker = path.join(dir, 'cat-file-blob-ran');
  const bin = path.join(dir, 'git');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'prev=',
    'for a in "$@"; do',
    `  if [ "$prev" = cat-file ] && [ "$a" = blob ]; then touch '${marker}'; ${hang ? 'exec sleep 30;' : ''} fi`,
    '  prev=$a',
    'done',
    `exec '${real}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  exec.setGitBinary(bin);
  t.after(() => exec.setGitBinary(null));
  return { ran: () => fs.existsSync(marker), marker };
}

const POSIX = process.platform !== 'win32';

// ---------------------------------------------------------------- imageSide (pure)

test('imageSide: kinds and the policy, without git', () => {
  const p = { ...POLICY, sniffBytes: 64, softMaxBytes: 300, maxBytes: 600, svgMaxBytes: 200, maxPixels: 400 };
  const git = (bytes, extra = {}) => ({ side: 'new', source: 'commit', oid: 'abc', mode: '100644', size: bytes ? bytes.length : 0, ...extra });
  const small = png(4, 4);
  let s = imageSide(git(small), small, { policy: p, path: 'a.png' });
  assert.equal(s.kind, 'image');
  assert.equal(s.mime, 'image/png');
  assert.equal(s.key, 'abc');
  assert.deepEqual(s.dims, { width: 4, height: 4 });
  assert.equal(s.bytes, small);
  // Pixel cap by header (21 x 20 = 420 > 400); not for SVG.
  const wide = png(21, 20);
  s = imageSide(git(wide), wide, { policy: p, path: 'a.png' });
  assert.deepEqual([s.kind, s.limit, s.soft, s.max, s.bytes], ['too-large', 'pixels', false, 400, undefined]);
  const bigSvg = Buffer.from('<svg width="1000" height="1000"></svg>');
  assert.equal(imageSide(git(bigSvg), bigSvg, { policy: p, path: 'a.svg' }).kind, 'image');
  // SVG byte cap: hard, force doesn't lift it.
  const longSvg = svg('', `<svg width="1" height="1">${' '.repeat(200)}`);
  s = imageSide(git(longSvg), longSvg, { policy: p, path: 'a.svg', force: true });
  assert.deepEqual([s.kind, s.limit, s.soft, s.format], ['too-large', 'svg', false, 'svg']);
  // Unread git sides (over the cap): too-large by the extension, else not-image.
  s = imageSide(git(null, { size: 400 }), null, { policy: p, path: 'a.webp' });
  assert.deepEqual([s.kind, s.soft, s.limit, s.format, s.extensionHint, s.size], ['too-large', true, 'size', null, 'webp', 400]);
  s = imageSide(git(null, { size: 700 }), null, { policy: p, path: 'a.webp', force: true });
  assert.deepEqual([s.kind, s.soft, s.max], ['too-large', false, 600]);
  assert.equal(imageSide(git(null, { size: 400 }), null, { policy: p, path: 'a.zip' }).kind, 'not-image');
  assert.throws(() => imageSide(git(null, { size: 100 }), null, { policy: p }), TypeError, 'a side under the caps must come with its bytes');
  // An empty file: not an image, nothing to read.
  assert.equal(imageSide(git(null, { size: 0 }), null, { policy: p, path: 'a.png' }).kind, 'not-image');
  // Tier 2 and probe formats: unsupported, whatever the size.
  const heic = isobmff(['heic', 'mif1'], 4032, 3024);
  s = imageSide(git(heic), heic, { policy: p, path: 'IMG_1.HEIC' });
  assert.deepEqual([s.kind, s.format, s.mime, s.dims.width, s.bytes], ['unsupported', 'heic', null, 4032, undefined]);
  // Absent and special sides carry nothing.
  s = imageSide({ side: 'old', source: 'head', absent: true }, null, { policy: p, path: 'a.png' });
  assert.deepEqual([s.kind, s.key, s.size, s.extensionHint], ['absent', null, null, 'png']);
  assert.equal(imageSide({ side: 'old', source: 'index', oid: 'x', mode: '120000', size: null, special: true }, null, { policy: p }).kind, 'special');
  // Mismatch: content decides, MIME from the content.
  const j = jpeg(8, 8);
  s = imageSide(git(j), j, { policy: p, path: 'a.png' });
  assert.deepEqual([s.kind, s.format, s.mime, s.mismatch, s.extensionHint], ['image', 'jpeg', 'image/jpeg', true, 'png']);
});

test('readLimit and revisionKey', () => {
  const p = { ...POLICY, sniffBytes: 64, softMaxBytes: 300, maxBytes: 600 };
  const g = (size) => ({ side: 'new', source: 'index', oid: 'o', size });
  const w = (size) => ({ side: 'new', source: 'worktree', size, statKey: '1:2:3:4' });
  assert.equal(readLimit(g(300), { policy: p }), 300);
  assert.equal(readLimit(g(301), { policy: p }), 0, 'a git blob over the cap is not read');
  assert.equal(readLimit(g(301), { policy: p, force: true }), 301);
  assert.equal(readLimit(g(601), { policy: p, force: true }), 0);
  assert.equal(readLimit(w(301), { policy: p }), 64, 'a worktree file over the cap: its head');
  assert.equal(readLimit(w(601), { policy: p, force: true }), 64);
  assert.equal(readLimit({ absent: true }, { policy: p }), 0);
  assert.equal(readLimit({ special: true, size: null }, { policy: p }), 0);
  assert.equal(revisionKey(g(1)), 'o');
  assert.equal(revisionKey(w(1)), 'wt:1:2:3:4');
  assert.equal(revisionKey({ side: 'new', source: 'lfs-cache', oid: 'f'.repeat(64), size: 1 }), `lfs:${'f'.repeat(64)}`);
  assert.equal(readLimit({ side: 'new', source: 'lfs-cache', oid: 'f', size: 301 }, { policy: p }), 0, 'an LFS object over the cap is not read');
  assert.equal(revisionKey({ absent: true }), null);
});

test('imageSide with thumbnails: HEIC / TIFF / PSD capped like tier 1; thumbnailSide and thumbnailKey', () => {
  const p = { ...POLICY, sniffBytes: 64, softMaxBytes: 300, maxBytes: 600, maxPixels: 400 };
  const git = (bytes, extra = {}) => ({ side: 'old', source: 'index', oid: 'abc', mode: '100644', size: bytes.length, ...extra });
  const heic = isobmff(['heic', 'mif1'], 4032, 3024); // over the pixel cap: not checked, the OS scales it
  let s = imageSide(git(heic), heic, { policy: p, path: 'a.heic', thumbnails: true });
  assert.deepEqual([s.kind, s.format, s.bytes], ['unsupported', 'heic', undefined]);
  const big = Buffer.concat([tiff(9, 8), Buffer.alloc(400)]);
  s = imageSide({ ...git(big), source: 'worktree', statKey: '1:2:3:4' }, big.subarray(0, 64), { policy: p, path: 'a.tif', thumbnails: true });
  assert.deepEqual([s.kind, s.soft, s.format, s.dims], ['too-large', true, 'tiff', { width: 9, height: 8 }], 'a worktree head over the soft cap');
  s = imageSide({ ...git(big), source: 'worktree', statKey: '1:2:3:4' }, big.subarray(0, 64), { policy: p, path: 'a.tif' });
  assert.equal(s.kind, 'unsupported', 'without thumbnails: as before');
  const svgz = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]);
  assert.equal(imageSide(git(svgz), svgz, { policy: p, path: 'a.svgz', thumbnails: true }).kind, 'unsupported', 'svgz is not for the OS');

  assert.equal(thumbnailKey('abc'), 'os:abc');
  assert.equal(thumbnailKey(null), null);
  const orig = imageSide(git(heic), heic, { policy: p, path: 'a.heic', thumbnails: true });
  const pngBytes = png(1024, 768);
  s = thumbnailSide(orig, { png: pngBytes, width: 1024, height: 768 }, 'Windows');
  assert.deepEqual(
    [s.kind, s.source, s.key, s.mime, s.format, s.dims, s.size, s.bytes, s.thumbnail],
    ['image', 'os-thumbnail', 'os:abc', 'image/png', 'heic', { width: 4032, height: 3024 }, heic.length, pngBytes, { by: 'Windows', from: 'index', width: 1024, height: 768 }],
  );
});

// ---------------------------------------------------------------- commit diffs

test('workdirImageSide: the acceptance example - an unstaged .webp', async () => {
  const before = webpVp8x(300, 200);
  const after = webpVp8x(512, 512, { animated: true });
  const dir = repoWith({ 'a.webp': before });
  h.write(dir, 'a.webp', after);
  const s = await workdirSide(dir, 'a.webp', {}, 'new');
  assert.equal(s.kind, 'image');
  assert.equal(s.format, 'webp');
  assert.equal(s.mime, 'image/webp');
  assert.equal(s.source, 'worktree');
  assert.match(s.key, /^wt:\d+:\d+:\d+:\d+$/);
  assert.deepEqual(s.dims, { width: 512, height: 512 });
  assert.equal(s.animated, true);
  assert.ok(Buffer.from(s.bytes).equals(after));
  const old = await workdirSide(dir, 'a.webp', {}, 'old');
  assert.deepEqual([old.kind, old.source, old.key, old.size, old.animated], ['image', 'index', rev(dir, ':a.webp'), before.length, false]);
  assert.ok(Buffer.from(old.bytes).equals(before));
});

test('commitImageSide: modified, added, deleted, renamed, root commit', async () => {
  const v1 = png(4, 4);
  const v2 = png(8, 8);
  const dir = h.initRepo({ commits: false });
  h.write(dir, 'img/a.png', v1);
  h.git(dir, 'add', '-A');
  h.git(dir, 'commit', '-q', '-m', 'root');
  const root = rev(dir, 'HEAD');
  h.commitFile(dir, 'img/a.png', v2, 'modify');
  const modified = rev(dir, 'HEAD');
  h.commitFile(dir, 'b.jpg', jpeg(3, 2), 'add');
  const added = rev(dir, 'HEAD');
  h.git(dir, 'mv', 'img/a.png', 'img/renamed.png');
  h.git(dir, 'commit', '-q', '-m', 'rename');
  const renamed = rev(dir, 'HEAD');
  h.git(dir, 'rm', '-q', 'b.jpg');
  h.git(dir, 'commit', '-q', '-m', 'delete');
  const deleted = rev(dir, 'HEAD');

  let s = await commitSide(dir, root, 'img/a.png', null, 'old');
  assert.deepEqual([s.kind, s.source], ['absent', 'commit'], 'a root commit: the empty tree');
  s = await commitSide(dir, root, 'img/a.png', null, 'new');
  assert.ok(Buffer.from(s.bytes).equals(v1));

  const [o, n] = await Promise.all(['old', 'new'].map((side) => commitSide(dir, modified, 'img/a.png', null, side)));
  assert.deepEqual([o.kind, o.dims, o.key], ['image', { width: 4, height: 4 }, rev(dir, `${root}:img/a.png`)]);
  assert.deepEqual([n.kind, n.dims, n.key, n.size], ['image', { width: 8, height: 8 }, rev(dir, `${modified}:img/a.png`), v2.length]);

  assert.equal((await commitSide(dir, added, 'b.jpg', null, 'old')).kind, 'absent');
  assert.equal((await commitSide(dir, added, 'b.jpg', null, 'new')).format, 'jpeg');
  assert.equal((await commitSide(dir, deleted, 'b.jpg', null, 'new')).kind, 'absent');
  assert.equal((await commitSide(dir, deleted, 'b.jpg', null, 'old')).format, 'jpeg');

  s = await commitSide(dir, renamed, 'img/renamed.png', 'img/a.png', 'old');
  assert.deepEqual([s.kind, s.key], ['image', n.key], 'the old side is read at orig');
  assert.equal((await commitSide(dir, renamed, 'img/renamed.png', null, 'old')).kind, 'absent', 'without orig: added');
  assert.equal((await commitSide(dir, renamed, 'img/renamed.png', 'img/a.png', 'new')).key, n.key);
});

test('commitImageSide: a merge commit (first parent) and a stash (HEAD when stashed vs the stashed worktree)', async () => {
  const dir = repoWith({ 'a.png': png(1, 1) });
  h.git(dir, 'checkout', '-q', '-b', 'side');
  h.commitFile(dir, 'a.png', png(2, 2), 'side');
  h.git(dir, 'checkout', '-q', 'main');
  h.commitFile(dir, 'other.txt', 'x\n', 'main');
  h.git(dir, 'merge', '-q', '--no-edit', 'side');
  const merge = rev(dir, 'HEAD');
  assert.deepEqual((await commitSide(dir, merge, 'a.png', null, 'old')).dims, { width: 1, height: 1 }, 'first parent');
  assert.deepEqual((await commitSide(dir, merge, 'a.png', null, 'new')).dims, { width: 2, height: 2 });

  h.write(dir, 'a.png', png(3, 3));
  h.git(dir, 'stash', '-q');
  const stash = rev(dir, 'stash@{0}');
  assert.deepEqual((await commitSide(dir, stash, 'a.png', null, 'old')).dims, { width: 2, height: 2 });
  assert.deepEqual((await commitSide(dir, stash, 'a.png', null, 'new')).dims, { width: 3, height: 3 });
});

// ---------------------------------------------------------------- working-copy diffs

test('workdirImageSide: unstaged, staged, untracked, unstaged deletion, staged rename', async () => {
  const dir = repoWith({ 'a.png': png(1, 1), 'del.png': png(5, 5), 'src.png': png(6, 6) });
  h.write(dir, 'a.png', png(2, 2));
  h.git(dir, 'add', 'a.png');
  h.write(dir, 'a.png', png(3, 3));
  const dims = async (file, wo, side) => (await workdirSide(dir, file, wo, side)).dims;
  assert.deepEqual(await dims('a.png', {}, 'old'), { width: 2, height: 2 }, 'unstaged: the index');
  assert.deepEqual(await dims('a.png', {}, 'new'), { width: 3, height: 3 }, 'unstaged: the worktree');
  assert.deepEqual(await dims('a.png', { staged: true }, 'old'), { width: 1, height: 1 }, 'staged: HEAD');
  assert.deepEqual(await dims('a.png', { staged: true }, 'new'), { width: 2, height: 2 }, 'staged: the index');
  assert.equal((await workdirSide(dir, 'a.png', { staged: true }, 'old')).source, 'head');

  h.write(dir, 'new.gif', require('./image-fixtures').gif(4, 4));
  let s = await workdirSide(dir, 'new.gif', { untracked: true }, 'old');
  assert.equal(s.kind, 'absent');
  s = await workdirSide(dir, 'new.gif', { untracked: true }, 'new');
  assert.deepEqual([s.kind, s.format, s.source], ['image', 'gif', 'worktree']);

  fs.rmSync(path.join(dir, 'del.png'));
  assert.equal((await workdirSide(dir, 'del.png', {}, 'new')).kind, 'absent', 'an unstaged deletion');
  assert.equal((await workdirSide(dir, 'del.png', {}, 'old')).kind, 'image');

  h.git(dir, 'mv', 'src.png', 'dst.png');
  s = await workdirSide(dir, 'dst.png', { staged: true, orig: 'src.png' }, 'old');
  assert.deepEqual([s.kind, s.dims], ['image', { width: 6, height: 6 }], 'a staged rename: HEAD at orig');
  assert.equal((await workdirSide(dir, 'dst.png', { staged: true }, 'old')).kind, 'absent');
  assert.deepEqual((await workdirSide(dir, 'dst.png', { staged: true, orig: 'src.png' }, 'new')).dims, { width: 6, height: 6 });
  h.git(dir, 'rm', '-q', '--cached', 'del.png');
  assert.equal((await workdirSide(dir, 'del.png', { staged: true }, 'new')).kind, 'absent', 'a staged deletion');
});

test('workdirImageSide: staged in an unborn repo, an intent-to-add file', async () => {
  const dir = h.initRepo({ commits: false });
  h.write(dir, 'a.png', png(2, 2));
  h.git(dir, 'add', 'a.png');
  let s = await workdirSide(dir, 'a.png', { staged: true }, 'old');
  assert.deepEqual([s.kind, s.source], ['absent', 'head']);
  assert.equal((await workdirSide(dir, 'a.png', { staged: true }, 'new')).kind, 'image');
  h.write(dir, 'b.png', png(2, 2));
  h.git(dir, 'add', '-N', 'b.png');
  s = await workdirSide(dir, 'b.png', {}, 'old');
  assert.deepEqual([s.kind, s.size], ['not-image', 0], 'intent to add: the empty blob (the diff says "new file")');
  assert.equal((await workdirSide(dir, 'b.png', {}, 'new')).kind, 'image');
});

test('mislabeled and non-image content: content decides', async () => {
  const dir = repoWith({ 'mislabeled.png': jpeg(4, 3), 'notes.webp': 'just text\n', 'data.bin': Buffer.from([0, 1, 2, 3]) });
  const head = rev(dir, 'HEAD');
  let s = await commitSide(dir, head, 'mislabeled.png', null, 'new');
  assert.deepEqual([s.kind, s.format, s.mime, s.mismatch, s.extensionHint], ['image', 'jpeg', 'image/jpeg', true, 'png']);
  s = await commitSide(dir, head, 'notes.webp', null, 'new');
  assert.deepEqual([s.kind, s.extensionHint, s.bytes], ['not-image', 'webp', undefined]);
  assert.equal((await commitSide(dir, head, 'data.bin', null, 'new')).kind, 'not-image');
  s = await commitSide(dir, head, 'IMG.heic', null, 'new');
  assert.equal(s.kind, 'absent');
});

test('Tier 2 formats are unsupported (no bytes); an SVG is an image', async () => {
  const dir = repoWith({ 'p.heic': isobmff(['heic', 'mif1'], 40, 30), 'i.svg': svg('<?xml version="1.0"?>\n') });
  const head = rev(dir, 'HEAD');
  const s = await commitSide(dir, head, 'p.heic', null, 'new');
  assert.deepEqual([s.kind, s.format, s.dims, s.bytes], ['unsupported', 'heic', { width: 40, height: 30 }, undefined]);
  const v = await commitSide(dir, head, 'i.svg', null, 'new');
  assert.deepEqual([v.kind, v.mime, v.dims], ['image', 'image/svg+xml', { width: 10, height: 20 }]);
});

// ---------------------------------------------------------------- special entries

test('symlinks and submodules are special and never read', { skip: !POSIX }, async () => {
  const dir = repoWith({ 'target.png': png(1, 1) });
  fs.symlinkSync('target.png', path.join(dir, 'link.png'));
  const sub = h.commitFile(h.initRepo(), 'x', 'x\n');
  h.git(dir, 'update-index', '--add', '--cacheinfo', `160000,${sub},sub.png`);
  h.git(dir, 'add', 'link.png');
  h.git(dir, 'commit', '-q', '-m', 'special');
  const head = rev(dir, 'HEAD');
  for (const file of ['link.png', 'sub.png']) {
    const s = await commitSide(dir, head, file, null, 'new');
    assert.deepEqual([s.kind, s.bytes, s.size], ['special', undefined, null], file);
    assert.equal((await workdirSide(dir, file, { staged: true }, 'old')).kind, 'special', `${file}: HEAD`);
  }
  assert.equal((await workdirSide(dir, 'link.png', {}, 'old')).kind, 'special', 'the index');
  assert.equal((await workdirSide(dir, 'link.png', {}, 'new')).kind, 'special', 'the worktree link itself');
  assert.equal((await workdirSide(dir, 'sub.png', {}, 'old')).kind, 'special');
  // An untracked symlink: listed by git, never followed.
  fs.symlinkSync(path.join(dir, 'target.png'), path.join(dir, 'new-link.png'));
  assert.equal((await workdirSide(dir, 'new-link.png', { untracked: true }, 'new')).kind, 'special');
});

// ---------------------------------------------------------------- guards

test('arguments: relPath refusals, side, options', async () => {
  const dir = repoWith({ 'a.png': png(1, 1) });
  const head = rev(dir, 'HEAD');
  for (const bad of ['../x.png', '/abs.png', '.git/x', 'a//b.png', 'a/./b.png', '', 42]) {
    await assert.rejects(workdirSide(dir, bad, {}, 'new'), { kind: 'invalid-args' }, String(bad));
    await assert.rejects(commitSide(dir, head, bad, null, 'new'), { kind: 'invalid-args' }, String(bad));
  }
  await assert.rejects(commitSide(dir, head, 'a.png', '../x', 'old'), { kind: 'invalid-args' }, 'orig');
  await assert.rejects(commitSide(dir, 'HEAD', 'a.png', null, 'new'), { kind: 'invalid-args' }, 'a full object id');
  for (const side of ['both', 'OLD', 'BASE', null, undefined, 0]) {
    await assert.rejects(workdirSide(dir, 'a.png', {}, side), { kind: 'invalid-args' }, String(side));
    await assert.rejects(commitSide(dir, head, 'a.png', null, side), { kind: 'invalid-args' }, String(side));
  }
  for (const o of ['x', [1], { knownKey: 5 }, { knownKey: '' }, { knownKey: 'k'.repeat(201) }]) {
    await assert.rejects(workdirSide(dir, 'a.png', {}, 'new', o), { kind: 'invalid-args' }, JSON.stringify(o));
  }
  await assert.rejects(workdirSide(dir, 'a.png', { untracked: true, orig: 'b.png' }, 'new'), { kind: 'invalid-args' });
  assert.equal((await workdirSide(dir, 'a.png', {}, 'new', { knownKey: 'k'.repeat(200), force: 'yes' })).kind, 'image');
});

test('worktree guards: a path through a symlinked folder, a path git doesn\'t list', { skip: !POSIX }, async () => {
  const dir = repoWith({ 'img/a.png': png(1, 1) });
  const outside = h.tmpDir();
  fs.writeFileSync(path.join(outside, 'secret.png'), png(9, 9));
  fs.symlinkSync(outside, path.join(dir, 'lnk'));
  for (const wo of [{ untracked: true }, {}]) {
    await assert.rejects(workdirSide(dir, 'lnk/secret.png', wo, 'new'), (e) => ['symlink', 'outside', 'stale'].includes(e.kind), JSON.stringify(wo));
  }
  // A tracked folder swapped for a link after checkout: refused by the guard.
  fs.renameSync(path.join(dir, 'img'), path.join(dir, 'img-real'));
  fs.symlinkSync(outside, path.join(dir, 'img'));
  fs.writeFileSync(path.join(outside, 'a.png'), png(9, 9));
  await assert.rejects(workdirSide(dir, 'img/a.png', {}, 'new'), { kind: 'symlink' });
  // Not tracked, not listed as untracked (ignored): stale.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.png\n');
  fs.writeFileSync(path.join(dir, 'ignored.png'), png(1, 1));
  await assert.rejects(workdirSide(dir, 'ignored.png', { untracked: true }, 'new'), { kind: 'stale' });
  await assert.rejects(workdirSide(dir, 'nope.png', {}, 'new'), { kind: 'stale' });
});

test('worktree guard: a tracked name with a backslash (POSIX) previews that file, not a/b.png', { skip: !POSIX }, async () => {
  const dir = repoWith({ 'a\\b.png': png(3, 3), 'a/b.png': png(7, 7) });
  h.write(dir, 'a\\b.png', png(4, 4));
  const s = await workdirSide(dir, 'a\\b.png', {}, 'new');
  assert.deepEqual([s.kind, s.source, s.dims], ['image', 'worktree', { width: 4, height: 4 }]);
  assert.deepEqual((await workdirSide(dir, 'a\\b.png', {}, 'old')).dims, { width: 3, height: 3 }, 'the index agrees');
  assert.deepEqual((await workdirSide(dir, 'a/b.png', {}, 'new')).dims, { width: 7, height: 7 });
});

/** A repo where merging `other` into main conflicts on `file`: base, ours (main) and theirs (other) as given (null: deleted). */
function conflicted({ file = 'a.png', base = png(1, 1), ours = png(3, 3), theirs = png(2, 2) } = {}) {
  const dir = repoWith(base ? { [file]: base } : { 'x.txt': 'x' });
  h.git(dir, 'checkout', '-q', '-b', 'other');
  if (theirs) h.commitFile(dir, file, theirs, 'other');
  else { h.git(dir, 'rm', '-q', file); h.git(dir, 'commit', '-q', '-m', 'rm'); }
  h.git(dir, 'checkout', '-q', 'main');
  if (ours) h.commitFile(dir, file, ours, 'main');
  else { h.git(dir, 'rm', '-q', file); h.git(dir, 'commit', '-q', '-m', 'rm'); }
  assert.throws(() => h.git(dir, 'merge', '-q', 'other'));
  return dir;
}

test('an unmerged path: old = ours (stage 2), new = theirs (stage 3), base = stage 1', async () => {
  const dir = conflicted();
  const dims = async (side, wo = {}) => {
    const s = await workdirSide(dir, 'a.png', wo, side);
    return [s.kind, s.source, s.dims && s.dims.width];
  };
  assert.deepEqual(await dims('old'), ['image', 'index', 3], 'ours');
  assert.deepEqual(await dims('new'), ['image', 'index', 2], 'theirs');
  assert.deepEqual(await dims('base'), ['image', 'index', 1], 'base');
  assert.deepEqual(await dims('new', { staged: true }), ['image', 'index', 2], 'staged or not: the stages');
  const ours = await workdirSide(dir, 'a.png', {}, 'old');
  assert.equal(ours.key, h.git(dir, 'rev-parse', ':2:a.png').trim(), 'keyed by the stage\'s blob');
  assert.deepEqual(await workdirSide(dir, 'a.png', {}, 'old', { knownKey: ours.key }), { side: 'old', key: ours.key, unchanged: true });
  // Side 'base' everywhere else: absent; commitImageSide has none.
  const clean = repoWith({ 'b.png': png(1, 1) });
  h.write(clean, 'b.png', png(2, 2));
  assert.deepEqual([(await workdirSide(clean, 'b.png', {}, 'base')).kind, (await workdirSide(clean, 'b.png', { staged: true }, 'base')).kind], ['absent', 'absent']);
  assert.equal((await workdirSide(clean, 'c.png', { untracked: true }, 'base')).kind, 'absent');
  await assert.rejects(commitSide(clean, rev(clean, 'HEAD'), 'b.png', null, 'base'), { kind: 'invalid-args' });
});

test('an unmerged path: a missing stage is absent (modify/delete, add/add)', async () => {
  let dir = conflicted({ theirs: null });
  assert.deepEqual(await Promise.all(['base', 'old', 'new'].map(async (w) => (await workdirSide(dir, 'a.png', {}, w)).kind)), ['image', 'image', 'absent'], 'deleted by them');
  dir = conflicted({ base: null });
  assert.deepEqual(await Promise.all(['base', 'old', 'new'].map(async (w) => (await workdirSide(dir, 'a.png', {}, w)).kind)), ['absent', 'image', 'image'], 'both added');
});

// ---------------------------------------------------------------- caps

test('caps: soft (force loads it), hard (never read), pixels, SVG; a worktree side reads only its head', { skip: !POSIX }, async (t) => {
  smallCaps(t);
  const soft = Buffer.concat([png(9, 9), Buffer.alloc(350)]); // over the soft cap of 300, under the hard 600
  const hard = Buffer.concat([png(2, 2), Buffer.alloc(700)]);
  const wide = png(30, 20); // 600 pixels > 400, under the soft cap
  assert.ok(soft.length > 300 && soft.length < 600, String(soft.length));
  const dir = repoWith({ 'soft.png': soft, 'hard.png': hard, 'wide.png': wide, 'big.zip': Buffer.alloc(400, 1) });
  const head = rev(dir, 'HEAD');
  const spy = spyGit(t);

  let s = await commitSide(dir, head, 'soft.png', null, 'new');
  assert.deepEqual([s.kind, s.soft, s.limit, s.max, s.size, s.bytes], ['too-large', true, 'size', 300, soft.length, undefined]);
  assert.equal(spy.ran(), false, 'a blob over the soft cap is not read');
  s = await commitSide(dir, head, 'hard.png', null, 'new', { force: true });
  assert.deepEqual([s.kind, s.soft, s.max], ['too-large', false, 600]);
  assert.equal(spy.ran(), false, 'a blob over the hard cap is never read, even with force');
  assert.equal((await commitSide(dir, head, 'big.zip', null, 'new')).kind, 'not-image', 'over the cap, no image extension');
  assert.equal(spy.ran(), false);

  s = await commitSide(dir, head, 'soft.png', null, 'new', { force: true });
  assert.deepEqual([s.kind, s.size], ['image', soft.length]);
  assert.ok(Buffer.from(s.bytes).equals(soft));
  assert.equal(spy.ran(), true);

  s = await commitSide(dir, head, 'wide.png', null, 'new', { force: true });
  assert.deepEqual([s.kind, s.limit, s.soft, s.dims], ['too-large', 'pixels', false, { width: 30, height: 20 }]);

  // The worktree: over the cap, its first sniffBytes give format and dimensions.
  h.write(dir, 'hard.png', Buffer.concat([png(7, 5), Buffer.alloc(700)]));
  s = await workdirSide(dir, 'hard.png', {}, 'new', { force: true });
  assert.deepEqual([s.kind, s.soft, s.format, s.dims, s.bytes], ['too-large', false, 'png', { width: 7, height: 5 }, undefined]);
  h.write(dir, 'soft.png', Buffer.concat([jpeg(4, 4), Buffer.alloc(350)]));
  s = await workdirSide(dir, 'soft.png', {}, 'new');
  assert.deepEqual([s.kind, s.soft, s.format, s.mismatch], ['too-large', true, 'jpeg', true]);
  assert.equal((await workdirSide(dir, 'soft.png', {}, 'new', { force: true })).kind, 'image');
  h.write(dir, 'soft.png', Buffer.alloc(350, 7));
  assert.equal((await workdirSide(dir, 'soft.png', {}, 'new')).kind, 'not-image', 'a head that is no image');
});

test('caps: the SVG cap is hard', async (t) => {
  smallCaps(t);
  const dir = repoWith({ 'a.svg': svg('', `<svg width="1" height="1">${' '.repeat(220)}`) });
  const s = await commitSide(dir, rev(dir, 'HEAD'), 'a.svg', null, 'new', { force: true });
  assert.deepEqual([s.kind, s.limit, s.soft, s.max, s.format], ['too-large', 'svg', false, 200, 'svg']);
});

// ---------------------------------------------------------------- knownKey

test('knownKey: an unchanged side is not read again; a changed worktree file has a new key', { skip: !POSIX }, async (t) => {
  const dir = repoWith({ 'a.png': png(1, 1) });
  h.write(dir, 'a.png', png(2, 2));
  const head = rev(dir, 'HEAD');
  const first = await commitSide(dir, head, 'a.png', null, 'new');
  const wt = await workdirSide(dir, 'a.png', {}, 'new');
  const spy = spyGit(t);
  assert.deepEqual(await commitSide(dir, head, 'a.png', null, 'new', { knownKey: first.key }), { side: 'new', key: first.key, unchanged: true });
  assert.deepEqual(await workdirSide(dir, 'a.png', {}, 'old', { knownKey: first.key }), { side: 'old', key: first.key, unchanged: true }, 'the same blob in the index');
  assert.equal(spy.ran(), false, 'no cat-file blob');
  assert.deepEqual(await workdirSide(dir, 'a.png', {}, 'new', { knownKey: wt.key }), { side: 'new', key: wt.key, unchanged: true });
  // Another key: read as usual.
  assert.equal((await commitSide(dir, head, 'a.png', null, 'new', { knownKey: 'f'.repeat(40) })).kind, 'image');
  assert.equal(spy.ran(), true);
  // Saving the file changes its key.
  await new Promise((r) => setTimeout(r, 20));
  h.write(dir, 'a.png', png(3, 3));
  const next = await workdirSide(dir, 'a.png', {}, 'new', { knownKey: wt.key });
  assert.equal(next.kind, 'image');
  assert.notEqual(next.key, wt.key);
  assert.deepEqual(next.dims, { width: 3, height: 3 });
});

// ---------------------------------------------------------------- Git LFS

test('a committed Git LFS pointer is lfs-pointer with its oid and size (no git-lfs needed)', async () => {
  const oid = 'c0ffee'.padEnd(64, '0');
  const text = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 2516582\n`;
  const dir = repoWith({ 'hero.png': text, '.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n' });
  const s = await commitSide(dir, rev(dir, 'HEAD'), 'hero.png', null, 'new');
  assert.deepEqual([s.kind, s.lfs, s.bytes, s.size], ['lfs-pointer', { oid, size: 2516582 }, undefined, text.length]);
  // The worktree holds the pointer too here (no smudge ran): the same answer.
  assert.equal((await workdirSide(dir, 'hero.png', {}, 'new')).kind, 'lfs-pointer');
});

const sha256 = (b) => require('node:crypto').createHash('sha256').update(b).digest('hex');
const lfsPointer = (b) => `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256(b)}\nsize ${b.length}\n`;

/** Put `bytes` in the local LFS cache of `gitDir` (the common dir) as object `oid` (default: its sha256). */
function cacheLfs(gitDir, bytes, oid = sha256(bytes)) {
  const p = path.join(gitDir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return p;
}

/** A git that records every argument list it runs (one line each) in `log`. */
function argsGit(t) {
  const real = findOnPath(process.platform === 'win32' ? 'git.exe' : 'git');
  const dir = h.tmpDir();
  const log = path.join(dir, 'args.log');
  const bin = path.join(dir, 'git');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  exec.setGitBinary(bin);
  t.after(() => exec.setGitBinary(null));
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
}

test('Git LFS: an object in the local cache previews (source lfs-cache, key lfs:<sha256>); git lfs never runs', { skip: !POSIX }, async (t) => {
  const img = png(6, 4);
  const dir = repoWith({ 'hero.png': lfsPointer(img), '.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n' });
  const head = rev(dir, 'HEAD');
  const objPath = cacheLfs(path.join(dir, '.git'), img);
  const runs = argsGit(t);
  const s = await commitSide(dir, head, 'hero.png', null, 'new');
  assert.deepEqual([s.kind, s.source, s.key, s.format, s.dims, s.size, s.lfs], ['image', 'lfs-cache', `lfs:${sha256(img)}`, 'png', { width: 6, height: 4 }, img.length, { oid: sha256(img), size: img.length }]);
  assert.ok(Buffer.from(s.bytes).equals(img));
  assert.equal((await workdirSide(dir, 'hero.png', {}, 'new')).source, 'lfs-cache', 'a worktree pointer too');
  assert.equal((await workdirSide(dir, 'hero.png', { staged: true }, 'new')).source, 'lfs-cache', 'the index');
  assert.ok(runs().length > 0);
  assert.equal(runs().filter((a) => /(^| )lfs( |$)|filter-process|smudge/.test(a)).length, 0, 'no git lfs, no smudge');

  // knownKey of the object: the pointer is read, the object isn't (an unreadable copy is never opened).
  fs.chmodSync(objPath, 0o000);
  t.after(() => fs.chmodSync(objPath, 0o644));
  assert.deepEqual(await commitSide(dir, head, 'hero.png', null, 'new', { knownKey: s.key }), { side: 'new', key: s.key, unchanged: true });
});

test('Git LFS: a missing, corrupt, resized or linked object stays the pointer; the soft cap applies', { skip: !POSIX }, async (t) => {
  const img = Buffer.concat([png(6, 4), Buffer.alloc(200)]); // larger than its pointer (~130 bytes)
  const dir = repoWith({ 'hero.png': lfsPointer(img) });
  const head = rev(dir, 'HEAD');
  const kind = async (o) => (await commitSide(dir, head, 'hero.png', null, 'new', o)).kind;
  assert.equal(await kind(), 'lfs-pointer', 'not downloaded');
  const p = cacheLfs(path.join(dir, '.git'), Buffer.from(img).fill(7, 40, 41)); // same size, other bytes
  assert.equal(await kind(), 'lfs-pointer', 'the sha256 must match');
  fs.writeFileSync(p, Buffer.concat([img, Buffer.from('x')]));
  assert.equal(await kind(), 'lfs-pointer', 'the size must match');
  fs.rmSync(p);
  const elsewhere = path.join(h.tmpDir(), 'obj');
  fs.writeFileSync(elsewhere, img);
  fs.symlinkSync(elsewhere, p);
  assert.equal(await kind(), 'lfs-pointer', 'a link is not followed');
  fs.rmSync(p);
  cacheLfs(path.join(dir, '.git'), img);
  assert.equal(await kind(), 'image');
  smallCaps(t, { softMaxBytes: 150, maxBytes: 600 });
  const s = await commitSide(dir, head, 'hero.png', null, 'new');
  assert.deepEqual([s.kind, s.soft, s.source, s.lfs.size], ['too-large', true, 'lfs-cache', img.length], 'over the soft cap: not read');
  assert.equal(await kind({ force: true }), 'image');
});

test('Git LFS: a linked worktree and a bare repository read the common dir\'s cache', async () => {
  const img = png(3, 5);
  const { bare, wt } = h.bareWithWorktree();
  h.commitFile(wt, 'hero.png', lfsPointer(img), 'lfs');
  cacheLfs(bare, img);
  const head = rev(wt, 'HEAD');
  assert.deepEqual([(await commitSide(bare, head, 'hero.png', null, 'new')).source, (await commitSide(wt, head, 'hero.png', null, 'new')).source], ['lfs-cache', 'lfs-cache']);
});

// ---------------------------------------------------------------- the OS thumbnailer (I4)

/**
 * A runner whose image reads use the OS thumbnailer over a fake OS call (src/os-thumbnail.js on
 * darwin): `answer(file, size)` (default: a PNG of the size asked for). seen: the bytes of each file
 * the OS was given; left(): what is still in its temp folder.
 */
function thumbRunner({ answer } = {}) {
  const tmpDir = h.tmpDir();
  const seen = [];
  const thumbnailer = createOsThumbnailer({
    platform: 'darwin',
    tmpDir,
    thumbnail: async (file, size) => {
      seen.push(fs.readFileSync(file));
      return answer ? answer(file, size) : png(size.width, size.height);
    },
  });
  const r = ops.createRunner({ thumbnailer });
  return {
    r, seen, thumbnailer, left: () => fs.readdirSync(tmpDir),
    commit: (dir, sha, file, side, o) => r.run(dir, 'commitImageSide', [sha, file, null, side, o]),
    workdir: (dir, file, wo, side, o) => r.run(dir, 'workdirImageSide', [file, wo, side, o]),
  };
}

test('OS thumbnailer: HEIC, TIFF and PSD sides are its PNG (source os-thumbnail, key os:<key>), labelled with the original', async () => {
  const heic = isobmff(['heic', 'mif1'], 40, 30);
  const tif = tiff(96, 64);
  const ps = psd(64, 64);
  const dir = repoWith({ 'p.heic': heic, 's.tiff': tif, 'l.psd': ps, 'a.png': png(2, 2) });
  const head = rev(dir, 'HEAD');
  const tr = thumbRunner();
  const s = await tr.commit(dir, head, 'p.heic', 'new');
  assert.deepEqual(
    [s.kind, s.source, s.key, s.mime, s.format, s.dims, s.size, s.animated, s.thumbnail],
    ['image', 'os-thumbnail', `os:${rev(dir, `${head}:p.heic`)}`, 'image/png', 'heic', { width: 40, height: 30 }, heic.length, false,
      { by: 'macOS', from: 'commit', width: 40, height: 30 }],
  );
  assert.ok(Buffer.from(s.bytes).equals(png(40, 30)));
  assert.ok(tr.seen[0].equals(heic), 'the OS was given the blob\'s bytes');
  assert.deepEqual((await tr.commit(dir, head, 's.tiff', 'new')).thumbnail, { by: 'macOS', from: 'commit', width: 96, height: 64 });
  assert.equal((await tr.commit(dir, head, 'l.psd', 'new')).kind, 'image');
  const p = await tr.commit(dir, head, 'a.png', 'new');
  assert.deepEqual([p.source, p.thumbnail], ['commit', undefined], 'tier 1 is never handed over');
  assert.equal(tr.seen.length, 3);

  // The worktree and the index: a copy of the bytes read, never the file itself.
  h.write(dir, 'p.heic', isobmff(['heic', 'mif1'], 20, 10));
  const w = await tr.workdir(dir, 'p.heic', {}, 'new');
  assert.deepEqual([w.kind, w.thumbnail.from, w.dims], ['image', 'worktree', { width: 20, height: 10 }]);
  assert.match(w.key, /^os:wt:\d+:\d+:\d+:\d+$/);
  assert.equal((await tr.workdir(dir, 'p.heic', {}, 'old')).thumbnail.from, 'index');
  await tr.thumbnailer.idle();
  assert.deepEqual(tr.left(), [], 'no temp file left');
});

test('OS thumbnailer: a failure leaves the side unsupported, keyed as the original; knownKey of either is not read again', { skip: !POSIX }, async (t) => {
  const heic = isobmff(['heic', 'mif1'], 40, 30);
  const dir = repoWith({ 'p.heic': heic, 'q.heic': Buffer.concat([heic, Buffer.from([1])]) });
  const head = rev(dir, 'HEAD');
  const oid = rev(dir, `${head}:p.heic`);
  const failing = thumbRunner({ answer: () => png(1024, 1024) }); // QuickLook's file icon
  const s = await failing.commit(dir, head, 'p.heic', 'new');
  assert.deepEqual([s.kind, s.key, s.source, s.bytes, s.thumbnail], ['unsupported', oid, 'commit', undefined, undefined]);
  const ok = thumbRunner();
  const shown = await ok.commit(dir, head, 'q.heic', 'new');
  assert.equal(shown.kind, 'image');
  const spy = spyGit(t);
  assert.deepEqual(await failing.commit(dir, head, 'p.heic', 'new', { knownKey: oid }), { side: 'new', key: oid, unchanged: true });
  assert.deepEqual(await ok.commit(dir, head, 'q.heic', 'new', { knownKey: shown.key }), { side: 'new', key: shown.key, unchanged: true });
  assert.equal(spy.ran(), false, 'no cat-file blob');
  assert.equal(ok.seen.length, 1, 'the OS is not asked again');
  // Without a thumbnailer an os: key is just another key.
  assert.equal((await commitSide(dir, head, 'q.heic', null, 'new', { knownKey: shown.key })).kind, 'unsupported');
});

test('OS thumbnailer: the caps apply as to tier 1 (Load preview); without one a HEIC stays unsupported', { skip: !POSIX }, async (t) => {
  smallCaps(t);
  const big = Buffer.concat([isobmff(['heic', 'mif1'], 40, 30), Buffer.alloc(350)]); // over the soft cap of 300
  const huge = Buffer.concat([tiff(9, 8), Buffer.alloc(700)]); // over the hard cap of 600
  const dir = repoWith({ 'big.heic': big, 'huge.tif': huge });
  const head = rev(dir, 'HEAD');
  const tr = thumbRunner();
  const spy = spyGit(t);
  let s = await tr.commit(dir, head, 'big.heic', 'new');
  assert.deepEqual([s.kind, s.soft, s.extensionHint], ['too-large', true, 'heic']);
  assert.equal(spy.ran(), false, 'a git side over the soft cap is never read');
  s = await tr.commit(dir, head, 'big.heic', 'new', { force: true });
  assert.deepEqual([s.kind, s.source, s.size], ['image', 'os-thumbnail', big.length]);
  s = await tr.commit(dir, head, 'huge.tif', 'new', { force: true });
  assert.deepEqual([s.kind, s.soft], ['too-large', false]);

  h.write(dir, 'big.heic', Buffer.concat([isobmff(['heic', 'mif1'], 20, 10), Buffer.alloc(350)]));
  s = await tr.workdir(dir, 'big.heic', {}, 'new');
  assert.deepEqual([s.kind, s.soft, s.format], ['too-large', true, 'heic'], 'its head read: the format');
  assert.equal((await tr.workdir(dir, 'big.heic', {}, 'new', { force: true })).kind, 'image');
  s = await workdirSide(dir, 'big.heic', {}, 'new');
  assert.deepEqual([s.kind, s.format], ['unsupported', 'heic'], 'no thumbnailer: as before');
  assert.equal(tr.seen.length, 2);
});

test('OS thumbnailer: a Git LFS object from the local cache too (key os:lfs:<sha256>)', async () => {
  const heic = isobmff(['heic', 'mif1'], 40, 30);
  const dir = repoWith({ 'p.heic': lfsPointer(heic) });
  cacheLfs(path.join(dir, '.git'), heic);
  const head = rev(dir, 'HEAD');
  const tr = thumbRunner();
  const s = await tr.commit(dir, head, 'p.heic', 'new');
  assert.deepEqual([s.kind, s.key, s.lfs, s.thumbnail.from], ['image', `os:lfs:${sha256(heic)}`, { oid: sha256(heic), size: heic.length }, 'lfs-cache']);
  assert.deepEqual(await tr.commit(dir, head, 'p.heic', 'new', { knownKey: s.key }), { side: 'new', key: s.key, unchanged: true });
  assert.equal(tr.seen.length, 1);
});

test('OS thumbnailer: cancelled while the OS works: kind aborted; its temp copy goes when the OS call ends', async () => {
  const dir = repoWith({ 'p.heic': isobmff(['heic', 'mif1'], 40, 30) });
  const head = rev(dir, 'HEAD');
  let release;
  const gate = new Promise((r) => { release = r; });
  const tr = thumbRunner({ answer: () => gate.then(() => png(40, 30)) });
  const p = tr.r.run(dir, 'commitImageSide', [head, 'p.heic', null, 'new', {}], { opId: 'thumb-1' });
  while (!tr.seen.length) await new Promise((r) => setTimeout(r, 10));
  assert.equal(tr.r.cancel('thumb-1'), true);
  await assert.rejects(p, { kind: 'aborted' });
  release();
  await tr.thumbnailer.idle();
  assert.deepEqual(tr.left(), []);
});

test('OS thumbnailer: none on Linux (createOsThumbnailer is null): the runner reads as without one', async () => {
  const thumbnailer = createOsThumbnailer({ platform: 'linux', thumbnail: async () => assert.fail('never called') });
  assert.equal(thumbnailer, null);
  const dir = repoWith({ 'p.heic': isobmff(['heic', 'mif1'], 40, 30) });
  const s = await ops.createRunner({ thumbnailer }).run(dir, 'commitImageSide', [rev(dir, 'HEAD'), 'p.heic', null, 'new', {}]);
  assert.deepEqual([s.kind, s.format], ['unsupported', 'heic']);
});

// ---------------------------------------------------------------- cancellation, bare repos, IPC

test('cancel while cat-file runs: git is killed, kind aborted', { skip: !POSIX }, async (t) => {
  const dir = repoWith({ 'a.png': png(2, 2) });
  const head = rev(dir, 'HEAD');
  await exec.resolveRoot(dir);
  const spy = spyGit(t, { hang: true });
  const r = ops.createRunner();
  const p = r.run(dir, 'commitImageSide', [head, 'a.png', null, 'new', {}], { opId: 'img-1' });
  const t0 = Date.now();
  while (!fs.existsSync(spy.marker)) {
    assert.ok(Date.now() - t0 < 60000, 'cat-file never started');
    await new Promise((res) => setTimeout(res, 20));
  }
  const cancelledAt = Date.now();
  assert.equal(r.cancel('img-1'), true);
  await assert.rejects(p, { kind: 'aborted' });
  assert.ok(Date.now() - cancelledAt < 10000, 'killed, not waited for');
});

test('bare repositories: commitImageSide works, workdirImageSide is refused', async () => {
  const { bare, wt } = h.bareWithWorktree();
  const img = png(3, 3);
  h.commitFile(wt, 'logo.png', img, 'logo');
  const head = rev(wt, 'HEAD');
  const s = await commitSide(bare, head, 'logo.png', null, 'new');
  assert.deepEqual([s.kind, s.source], ['image', 'commit']);
  assert.ok(Buffer.from(s.bytes).equals(img));
  assert.equal((await commitSide(bare, head, 'logo.png', null, 'old')).kind, 'absent');
  await assert.rejects(workdirSide(bare, 'logo.png', {}, 'new'), { kind: 'bare-repo' });
  assert.ok(ops.BARE_OK.has('commitImageSide'));
  assert.ok(ops.WORKTREE_OPS.has('workdirImageSide'));
  assert.equal(ops.WRITE_OPS.has('commitImageSide') || ops.WRITE_OPS.has('workdirImageSide'), false, 'reads');
});

test('both ops are reachable through the op channel (opRequest)', () => {
  const opRequest = CHANNELS.op.args[0];
  for (const op of ['commitImageSide', 'workdirImageSide']) {
    assert.deepEqual(opRequest({ op, args: ['a.png', {}, 'new'], opId: 'x' }), { op, args: ['a.png', {}, 'new'], opId: 'x' });
  }
});
