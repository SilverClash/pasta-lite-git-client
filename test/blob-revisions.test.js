'use strict';
// src/blob-revisions.js directly (docs/plans/image-preview.md §4): the safety of a file side's read
// (a file swapped, rewritten or saved in place while it is read is 'stale', a cancel is 'aborted', a
// Git LFS object is hashed chunk by chunk) and partial clones: a blob the clone doesn't have is
// `missing` and never fetched, and the lookups hunks.js shares read no blob at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const h = require('./helpers');
const { resolveSide, readRevision, lfsRevision, headEntry, treeEntry } = require('../src/blob-revisions');
const { png } = require('./image-fixtures');

const MiB = 1024 * 1024;
const unstaged = (file) => ({ kind: 'workdir', file, staged: false, untracked: false });

/** A repo with `file` committed, then changed in the worktree to `bytes`: its new side resolved. */
async function worktreeSide(bytes, file = 'a.png') {
  const dir = h.initRepo();
  h.commitFile(dir, file, png(1, 1));
  h.write(dir, file, bytes);
  return { dir, abs: path.join(dir, file), rev: await resolveSide(dir, unstaged(file), 'new') };
}

/** Runs `fn` with FileHandle.prototype.read wrapped by `wrap(read)`, restored after. */
async function withRead(wrap, fn) {
  const fh = await fs.promises.open(__filename);
  const proto = Object.getPrototypeOf(fh);
  await fh.close();
  const read = proto.read;
  proto.read = wrap(read);
  try {
    return await fn();
  } finally {
    proto.read = read;
  }
}

test('readRevision: the worktree file rewritten or swapped after resolveSide is stale, never other bytes', async () => {
  let { dir, abs, rev } = await worktreeSide(png(4, 4));
  assert.equal(rev.source, 'worktree');
  assert.ok((await readRevision(dir, rev, { maxBytes: rev.size })).equals(png(4, 4)), 'unchanged: its bytes');
  fs.writeFileSync(abs, png(5, 5)); // another size
  await assert.rejects(readRevision(dir, rev, { maxBytes: 1e6 }), { kind: 'stale' });

  ({ dir, abs, rev } = await worktreeSide(png(4, 4)));
  const other = `${abs}.new`;
  fs.writeFileSync(other, png(4, 4)); // the same bytes, another file: renamed over it (an editor's save)
  fs.renameSync(other, abs);
  await assert.rejects(readRevision(dir, rev, { maxBytes: 1e6 }), { kind: 'stale' });

  ({ dir, abs, rev } = await worktreeSide(png(4, 4)));
  fs.rmSync(abs);
  await assert.rejects(readRevision(dir, rev, { maxBytes: 1e6 }), { kind: 'stale' }, 'deleted');
});

test('readRevision: saved in place (same size) while it is read: stale, not mixed bytes under the old key', async () => {
  const before = Buffer.concat([png(4, 4), Buffer.alloc(3 * MiB, 1)]);
  const { dir, abs, rev } = await worktreeSide(before);
  let reads = 0;
  await withRead((read) => async function (...args) {
    const res = await read.apply(this, args);
    if (++reads === 1) { // after the first chunk: the editor writes the same number of bytes
      const fd = fs.openSync(abs, 'r+');
      fs.writeSync(fd, Buffer.alloc(MiB, 2), 0, MiB, 2 * MiB);
      fs.closeSync(fd);
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(abs, later, later); // a coarse clock could leave the mtime where it was
    }
    return res;
  }, async () => {
    await assert.rejects(readRevision(dir, rev, { maxBytes: rev.size }), { kind: 'stale' });
  });
  assert.ok(reads > 1, 'read in chunks');
  assert.equal(fs.statSync(abs).size, before.length, 'the same size');
});

test('readRevision: an already cancelled read of a file over one chunk is aborted', async () => {
  const { dir, rev } = await worktreeSide(Buffer.concat([png(4, 4), Buffer.alloc(2 * MiB)]));
  assert.ok(rev.size > MiB);
  const ctrl = new AbortController();
  ctrl.abort();
  let reads = 0;
  await withRead((read) => function (...args) {
    reads++;
    return read.apply(this, args);
  }, async () => {
    await assert.rejects(readRevision(dir, rev, { maxBytes: rev.size, signal: ctrl.signal }), { kind: 'aborted' });
  });
  assert.equal(reads, 0, 'nothing read');
});

test('readRevision: a Git LFS object over several chunks is hashed as it is read', async () => {
  const obj = Buffer.concat([png(2, 2), crypto.randomBytes(2 * MiB + 17)]);
  const oid = crypto.createHash('sha256').update(obj).digest('hex');
  const dir = h.initRepo();
  const p = path.join(dir, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, obj);
  let rev = await lfsRevision(dir, 'new', { oid, size: obj.length });
  assert.ok((await readRevision(dir, rev, { maxBytes: obj.length })).equals(obj));
  fs.writeFileSync(p, Buffer.from(obj).fill(0, MiB + 3, MiB + 4)); // the same size, one byte off
  rev = await lfsRevision(dir, 'new', { oid, size: obj.length });
  assert.equal(await readRevision(dir, rev, { maxBytes: obj.length }), null, 'its sha256 is not the oid');
});

// ---------------------------------------------------------------- partial clones

/** git with lazy fetching off, for assertions that must not fetch themselves. */
const local = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** Whether object `oid` is in `dir`'s local object store. */
function has(dir, oid) {
  try {
    local(dir, 'cat-file', '-e', oid);
    return true;
  } catch {
    return false;
  }
}

/**
 * A blobless clone (`--filter=blob:none`, over file://, offline) of a repo whose a.png changed twice:
 * {dir, src, old (the first a.png's oid: not in the clone), head (HEAD's a.png)}. `checkout: false`:
 * HEAD's blob isn't fetched either.
 */
function blobless({ checkout = true } = {}) {
  const src = h.initRepo();
  h.git(src, 'config', 'uploadpack.allowFilter', 'true');
  h.git(src, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  h.commitFile(src, 'a.png', png(1, 1));
  h.commitFile(src, 'a.png', png(2, 2));
  const dir = h.tmpDir();
  h.git(dir, 'clone', '-q', '--filter=blob:none', ...(checkout ? [] : ['--no-checkout']), pathToFileURL(src).href, '.');
  const old = h.git(src, 'rev-parse', 'HEAD~1:a.png').trim();
  const head = h.git(src, 'rev-parse', 'HEAD:a.png').trim();
  assert.equal(has(dir, old), false, 'the old blob is not in the clone');
  assert.equal(has(dir, head), checkout);
  return { dir, src, old, head };
}

test('partial clone: a blob the clone doesn\'t have is missing (size null) and never fetched', async () => {
  const { dir, old, head } = blobless();
  const sha = h.git(dir, 'rev-parse', 'HEAD').trim();
  const rev = await resolveSide(dir, { kind: 'commit', sha, file: 'a.png' }, 'old');
  assert.deepEqual([rev.source, rev.oid, rev.size, rev.missing, rev.absent], ['commit', old, null, true, undefined]);
  assert.equal(has(dir, old), false, 'not fetched');
  await assert.rejects(readRevision(dir, rev, { maxBytes: 1e6 }), TypeError, 'nothing to read');
  const now = await resolveSide(dir, { kind: 'commit', sha, file: 'a.png' }, 'new');
  assert.deepEqual([now.oid, now.size, now.missing], [head, png(2, 2).length, undefined], 'a blob it has: as usual');

  // The index: an entry whose blob the clone doesn't have.
  local(dir, 'update-index', '--add', '--cacheinfo', `100644,${old},b.png`);
  assert.equal(has(dir, old), false);
  const idx = await resolveSide(dir, { kind: 'workdir', file: 'b.png', staged: true, untracked: false }, 'new');
  assert.deepEqual([idx.source, idx.oid, idx.missing], ['index', old, true]);
  assert.equal(has(dir, old), false, 'not fetched');
});

test('partial clone: headEntry (hunks.js) and treeEntry without sizes read no blob', async () => {
  const { dir, head } = blobless({ checkout: false });
  assert.deepEqual(await headEntry(dir, 'a.png'), { mode: '100644', sha: head });
  assert.deepEqual(await treeEntry(dir, 'HEAD', 'a.png', { size: false }), { mode: '100644', type: 'blob', oid: head, size: null });
  assert.deepEqual(await treeEntry(dir, 'HEAD', 'a.png'), { mode: '100644', type: 'blob', oid: head, size: null, missing: true });
  assert.equal(has(dir, head), false, 'nothing fetched');
});
