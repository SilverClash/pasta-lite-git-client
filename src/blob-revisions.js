'use strict';
// Which blob or file each side of a diff is, and its bytes: the git and worktree side of the
// image preview (docs/plans/image-preview.md §4). resolveSide turns one side of a DiffSpec into
// a BlobRevision, size included, so a caller can refuse an over-cap side before anything is read;
// readRevision reads it. Reads only: ls-tree, ls-files, cat-file, the worktree file and the local
// Git LFS cache. Git blobs are the stored bytes (no smudge filter, textconv or `git lfs` ever runs),
// worktree files are read through worktreeGuard and O_NOFOLLOW. Also the exact-path index / HEAD
// lookups hunks.js uses.
//
// DiffSpec: {kind: 'commit', sha, file, orig?} | {kind: 'workdir', file, staged, untracked, orig?}
// (`orig`: a rename's source, the old side's path). Sides, as the diff view shows them:
//   commit       old: first parent (the empty tree for a root commit), new: the commit
//   unstaged     old: the index (stage 0), new: the worktree file
//   staged       old: HEAD (absent when unborn), new: the index
//   untracked    old: absent, new: the worktree file (only a path git lists as untracked)
//   conflicted   (an unmerged path, staged or not) old: stage 2 (ours), new: stage 3 (theirs),
//                base: stage 1 (absent when a stage is missing: an add/add or modify/delete conflict)
// Side 'base' exists only for a conflicted path (absent everywhere else).
// BlobRevision: {side, source, oid, mode, size, statKey?, abs?, absent?, special?}. source: 'commit',
// 'head', 'index', 'worktree' or 'lfs-cache'; oid / mode for git entries (null for the worktree; the
// LFS object's sha256 for 'lfs-cache'); statKey ('dev:ino:size:mtimeNs') and abs for a file read from
// disk (the worktree, the LFS cache). `absent`: no such side; `special`: a symlink, submodule, folder
// or other non-file (never read); `missing`: a git blob that isn't in the local object store (a
// partial clone's, not fetched; never read, size null).
//
// Git LFS (lfsRevision): an object is read only from the local cache in the default layout,
// <git common dir>/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid> (a custom lfs.storage is not followed),
// and only when it is a regular file of the pointer's size whose sha256 is the pointer's oid. No
// `git lfs` process, smudge filter or network fetch ever runs.
//
// Partial clones (`--filter=blob:none`): the preview's reads of blobs (their size, their bytes) run
// with GIT_NO_LAZY_FETCH, so a blob that isn't in the local object store is never fetched from the
// promisor remote: the side is `missing` (ImageSide 'not-local'). The exact-path lookups hunks.js
// uses don't touch blobs at all (headEntry asks ls-tree without sizes), so they never fetch either.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { out, kindError, abortedError, LITERAL_ENV } = require('./exec');
const { headState, repoDirs } = require('./repo-dirs');
const { baseOf } = require('./git-reads');
const { isUntracked } = require('./git');
const { parseStageEntries } = require('./porcelain');
// O_NOFOLLOW is POSIX only; elsewhere (Windows) it is 0 and only the guard and the stat key protect.
const { worktreeGuard, O_NOFOLLOW } = require('./worktree-fs');

const LITERAL = { env: LITERAL_ENV };
// The preview's blob reads: literal pathspecs, and never a lazy fetch in a partial clone.
const NO_FETCH_ENV = { ...LITERAL_ENV, GIT_NO_LAZY_FETCH: '1' };
const SPECIAL_MODES = new Set(['120000', '160000']);
const READ_CHUNK = 1024 * 1024;
const CONFLICT_STAGES = Object.freeze({ base: 1, old: 2, new: 3 });
const LFS_OID = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------- git entries

/** The index entries of exactly `file` by stage: Map stage (0-3) -> {mode, sha}; empty when untracked. */
async function stageEntries(cwd, file) {
  const stages = new Map();
  for (const e of parseStageEntries(await out(cwd, ['ls-files', '-s', '-z', '--', file], LITERAL))) {
    if (e.path === file) stages.set(e.stage, { mode: e.mode, sha: e.sha });
  }
  return stages;
}

const unmerged = (stages) => [...stages.keys()].some((s) => s !== 0);

/** Stage-0 index entry {mode, sha} of `file`, or null. Throws kind 'conflict' for unmerged paths. */
async function indexEntry(cwd, file) {
  const stages = await stageEntries(cwd, file);
  if (unmerged(stages)) throw kindError('conflict', `${file} is unmerged`);
  return stages.get(0) || null;
}

/**
 * The entry {mode, type, oid, size} of exactly `file` in tree-ish `tree` (an object id), or null.
 * size: a blob's size, else null; a blob not in the local object store (a partial clone; never
 * fetched) has `missing: true` and size null. With `{size: false}` no blob is looked at (size null).
 */
async function treeEntry(cwd, tree, file, { size = true } = {}) {
  const text = await out(cwd, ['ls-tree', ...(size ? ['-l'] : []), '-z', tree, '--', file], size ? { env: NO_FETCH_ENV } : LITERAL);
  for (const rec of text.split('\0')) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)(?: +(\d+|-|BAD))?\t(.*)$/s.exec(rec);
    if (!m || m[5] !== file) continue;
    const e = { mode: m[1], type: m[2], oid: m[3], size: /^\d+$/.test(m[4] || '') ? Number(m[4]) : null };
    return m[4] === 'BAD' ? { ...e, missing: true } : e; // -l without the object: git prints BAD
  }
  return null;
}

/** HEAD's blob entry {mode, sha} for `file`, or null (no such path, not a blob, or unborn HEAD). Reads no blob. */
async function headEntry(cwd, file) {
  const { sha } = await headState(cwd);
  if (!sha) return null;
  const e = await treeEntry(cwd, sha, file, { size: false });
  return e && e.type === 'blob' ? { mode: e.mode, sha: e.oid } : null;
}

/** Size of blob `oid` in bytes; 'missing' when it isn't in the local object store (never fetched); null when not a blob. */
async function blobSize(cwd, oid) {
  const line = await out(cwd, ['cat-file', '--batch-check'], { input: `${oid}\n`, env: NO_FETCH_ENV });
  if (/^[0-9a-f]+ missing$/m.test(line)) return 'missing';
  const m = /^[0-9a-f]+ blob (\d+)$/m.exec(line);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- sides

const absent = (side, source) => ({ side, source, oid: null, mode: null, size: null, absent: true });

/** The BlobRevision of a git entry ({mode, type, oid, size, missing?} or null). */
function gitRevision(side, source, e) {
  if (!e) return absent(side, source);
  const special = e.type !== 'blob' || SPECIAL_MODES.has(e.mode);
  if (special) return { side, source, oid: e.oid, mode: e.mode, size: null, special };
  return { side, source, oid: e.oid, mode: e.mode, size: e.missing ? null : e.size, ...(e.missing ? { missing: true } : {}) };
}

/**
 * The BlobRevision of index entry `e` ({mode, sha} of any stage, or null): `missing` when its blob
 * isn't in the local object store (a partial clone), absent when the object isn't a blob.
 */
async function entryRevision(root, side, e) {
  if (!e) return absent(side, 'index');
  if (SPECIAL_MODES.has(e.mode)) return gitRevision(side, 'index', { mode: e.mode, type: 'commit', oid: e.sha });
  const size = await blobSize(root, e.sha);
  if (size === null) return absent(side, 'index');
  return gitRevision(side, 'index', { mode: e.mode, type: 'blob', oid: e.sha, ...(size === 'missing' ? { size: null, missing: true } : { size }) });
}

/**
 * The index side (stage 0) of `file`; absent when there is no entry; `missing` when its blob isn't
 * in the local object store. An intent-to-add entry is the empty blob: 'not-image', size 0.
 */
async function indexRevision(root, side, file) {
  return entryRevision(root, side, await indexEntry(root, file));
}

const statKey = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;

/**
 * The worktree side of `file`. A path in the index (stage 0) or one git lists as untracked, else
 * kind 'stale'; through a symlinked folder, outside the worktree or into the git dir: kinds
 * 'symlink' / 'outside' (worktreeGuard). Missing: absent; a symlink or anything but a regular file:
 * special. `entry`: its stage-0 entry when the caller already read it (null: none).
 */
async function worktreeRevision(root, side, file, entry) {
  const tracked = entry === undefined ? await indexEntry(root, file) : entry;
  if (!tracked && !(await isUntracked(root, file))) {
    throw kindError('stale', `${file} is not a changed file in this repository`);
  }
  const abs = (await worktreeGuard(root)).check(file, { allowFinalLink: true });
  let st;
  try {
    st = await fs.promises.lstat(abs, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return absent(side, 'worktree');
    throw e;
  }
  if (!st.isFile()) return { side, source: 'worktree', oid: null, mode: null, size: null, special: true };
  return { side, source: 'worktree', oid: null, mode: null, size: Number(st.size), statKey: statKey(st), abs };
}

/** The BlobRevision of side `side` ('old' | 'new' | 'base') of `spec` (a DiffSpec; see the header). */
async function resolveSide(repo, spec, side) {
  const { file } = spec;
  const oldPath = spec.orig || file;
  if (spec.kind === 'commit') {
    if (side === 'base') return absent(side, 'commit');
    const tree = side === 'old' ? await baseOf(repo, spec.sha) : spec.sha;
    return gitRevision(side, 'commit', await treeEntry(repo, tree, side === 'old' ? oldPath : file));
  }
  if (spec.untracked) return side === 'new' ? worktreeRevision(repo, side, file) : absent(side, 'index');
  const stages = await stageEntries(repo, file);
  if (unmerged(stages)) return entryRevision(repo, side, stages.get(CONFLICT_STAGES[side]) || null);
  if (side === 'base') return absent(side, 'index');
  const entry = stages.get(0) || null;
  if (spec.staged) {
    if (side === 'new') return entryRevision(repo, side, entry);
    const { sha } = await headState(repo);
    return sha ? gitRevision(side, 'head', await treeEntry(repo, sha, oldPath)) : absent(side, 'head');
  }
  if (side === 'new') return worktreeRevision(repo, side, file, entry);
  return oldPath === file ? entryRevision(repo, side, entry) : indexRevision(repo, side, oldPath);
}

/**
 * The BlobRevision (source 'lfs-cache', oid: the sha256) of the Git LFS object a pointer names
 * ({oid, size}: image-format.js parseLfsPointer) in the local cache, or null when it isn't there as
 * a regular file of that size (not downloaded, a custom lfs.storage, a link). Reads nothing.
 */
async function lfsRevision(repo, side, { oid, size } = {}) {
  if (typeof oid !== 'string' || !LFS_OID.test(oid) || !Number.isSafeInteger(size) || size < 0) return null;
  const { commonDir } = await repoDirs(repo);
  const abs = path.join(commonDir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
  let st;
  try {
    st = await fs.promises.lstat(abs, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
  if (!st.isFile() || Number(st.size) !== size) return null;
  return { side, source: 'lfs-cache', oid, mode: null, size, statKey: statKey(st), abs };
}

// ---------------------------------------------------------------- bytes

const changedError = () => kindError('stale', 'The file changed while it was read');

/**
 * The first `maxBytes` bytes of a file side (the worktree, the LFS cache; all of it when it is
 * shorter), opened without following a final symlink, in READ_CHUNK reads (each fed to `hash`, a
 * crypto Hash, when given). The file must be the one resolved (its stat key) when it is opened and
 * still be after the last read, else kind 'stale': it changed (saved in place too: its mtime moves),
 * or a parent folder was swapped meanwhile. Cancelled: kind 'aborted'.
 */
async function readFile(rev, maxBytes, signal, hash = null) {
  let fh;
  try {
    fh = await fs.promises.open(rev.abs, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK' || e.code === 'ENOENT') throw changedError();
    throw e;
  }
  try {
    const same = async () => {
      const st = await fh.stat({ bigint: true });
      return st.isFile() && statKey(st) === rev.statKey ? st : null;
    };
    const st = await same();
    if (!st) throw changedError();
    const buf = Buffer.alloc(Math.min(maxBytes, Number(st.size)));
    for (let at = 0; at < buf.length;) {
      if (signal && signal.aborted) throw abortedError();
      const { bytesRead } = await fh.read(buf, at, Math.min(READ_CHUNK, buf.length - at), at);
      if (!bytesRead) throw changedError();
      if (hash) hash.update(buf.subarray(at, at + bytesRead));
      at += bytesRead;
    }
    if (!(await same())) throw changedError(); // written while it was read: the bytes may be mixed
    return buf;
  } finally {
    await fh.close();
  }
}

/**
 * Bytes of a resolved side (a Buffer): at most `maxBytes` of a worktree file; a git blob or an LFS
 * object only whole (`maxBytes` must cover rev.size), a blob through `cat-file blob` capped just
 * above its size (never lazily fetched). An LFS object whose sha256 isn't its oid (a corrupt copy)
 * gives null; it is hashed as it is read. `signal` (default: the runner's, exec.withSignal) kills
 * git / stops the file read: kind 'aborted'.
 */
async function readRevision(repo, rev, { maxBytes, signal } = {}) {
  if (rev.absent || rev.special || rev.missing) throw new TypeError('readRevision: nothing to read');
  if (rev.source === 'worktree') return readFile(rev, maxBytes, signal);
  if (!(maxBytes >= rev.size)) throw new TypeError(`readRevision: ${rev.source === 'lfs-cache' ? 'an LFS object' : 'a git blob'} is read whole`);
  if (rev.source === 'lfs-cache') {
    const hash = crypto.createHash('sha256');
    const bytes = await readFile(rev, rev.size, signal, hash);
    return hash.digest('hex') === rev.oid ? bytes : null;
  }
  return out(repo, ['cat-file', 'blob', rev.oid], {
    encoding: 'buffer', maxBytes: rev.size + 4096, env: NO_FETCH_ENV, ...(signal ? { signal } : {}),
  });
}

module.exports = { resolveSide, readRevision, lfsRevision, indexEntry, headEntry, treeEntry };
