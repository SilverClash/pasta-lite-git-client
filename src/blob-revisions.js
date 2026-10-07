'use strict';
// Which blob or file each side of a diff is, and its bytes: the git and worktree side of the
// image preview (docs/plans/image-preview.md §4). resolveSide turns one side of a DiffSpec into
// a BlobRevision, size included, so a caller can refuse an over-cap side before anything is read;
// readRevision reads it. Reads only: ls-tree, ls-files, cat-file and the worktree file. Git blobs
// are the stored bytes (no smudge filter, textconv or `git lfs` ever runs), worktree files are read
// through worktreeGuard and O_NOFOLLOW. Also the exact-path index / HEAD lookups hunks.js uses.
//
// DiffSpec: {kind: 'commit', sha, file, orig?} | {kind: 'workdir', file, staged, untracked, orig?}
// (`orig`: a rename's source, the old side's path). Sides, as the diff view shows them:
//   commit       old: first parent (the empty tree for a root commit), new: the commit
//   unstaged     old: the index (stage 0), new: the worktree file
//   staged       old: HEAD (absent when unborn), new: the index
//   untracked    old: absent, new: the worktree file (only a path git lists as untracked)
// BlobRevision: {side, source, oid, mode, size, statKey?, abs?, absent?, special?}. source: 'commit',
// 'head', 'index' or 'worktree'; oid / mode for git entries (null for the worktree); statKey
// ('dev:ino:size:mtimeNs') and abs for a worktree file. `absent`: no such side; `special`: a
// symlink, submodule, folder or other non-file (never read).
const fs = require('node:fs');
const { out, kindError, LITERAL_ENV } = require('./exec');
const { headState } = require('./repo-dirs');
const { baseOf } = require('./git-reads');
const { isUntracked } = require('./git');
const { parseStageEntries } = require('./porcelain');
const { worktreeGuard } = require('./worktree-fs');

const LITERAL = { env: LITERAL_ENV };
const SPECIAL_MODES = new Set(['120000', '160000']);
// O_NOFOLLOW is POSIX only; elsewhere (Windows) it is 0 and only the guard and the stat key protect.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const READ_CHUNK = 1024 * 1024;

// ---------------------------------------------------------------- git entries

/** Stage-0 index entry {mode, sha} of `file`, or null. Throws kind 'conflict' for unmerged paths. */
async function indexEntry(cwd, file) {
  let entry = null;
  for (const e of parseStageEntries(await out(cwd, ['ls-files', '-s', '-z', '--', file], LITERAL))) {
    if (e.path !== file) continue;
    if (e.stage !== 0) throw kindError('conflict', `${file} is unmerged`);
    entry = { mode: e.mode, sha: e.sha };
  }
  return entry;
}

/** The entry {mode, type, oid, size} of exactly `file` in tree-ish `tree` (an object id), or null. size: null unless a blob. */
async function treeEntry(cwd, tree, file) {
  const text = await out(cwd, ['ls-tree', '-l', '-z', tree, '--', file], LITERAL);
  for (const rec of text.split('\0')) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s.exec(rec);
    if (m && m[5] === file) return { mode: m[1], type: m[2], oid: m[3], size: m[4] === '-' ? null : Number(m[4]) };
  }
  return null;
}

/** HEAD's blob entry {mode, sha} for `file`, or null (no such path, not a blob, or unborn HEAD). */
async function headEntry(cwd, file) {
  const { sha } = await headState(cwd);
  if (!sha) return null;
  const e = await treeEntry(cwd, sha, file);
  return e && e.type === 'blob' ? { mode: e.mode, sha: e.oid } : null;
}

/** Size of blob `oid` in bytes, or null when the object isn't in the repository. */
async function blobSize(cwd, oid) {
  const line = await out(cwd, ['cat-file', '--batch-check'], { input: `${oid}\n` });
  const m = /^[0-9a-f]+ blob (\d+)$/m.exec(line);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- sides

const absent = (side, source) => ({ side, source, oid: null, mode: null, size: null, absent: true });

/** The BlobRevision of a git entry ({mode, type, oid, size} or null). */
function gitRevision(side, source, e) {
  if (!e) return absent(side, source);
  const special = e.type !== 'blob' || SPECIAL_MODES.has(e.mode);
  return { side, source, oid: e.oid, mode: e.mode, size: special ? null : e.size, ...(special ? { special } : {}) };
}

/**
 * The index side (stage 0) of `file`; absent when there is no entry, or its blob is missing from
 * the object store. An intent-to-add entry is the empty blob: 'not-image', size 0.
 */
async function indexRevision(root, side, file) {
  const e = await indexEntry(root, file);
  if (!e) return absent(side, 'index');
  if (SPECIAL_MODES.has(e.mode)) return gitRevision(side, 'index', { mode: e.mode, type: 'commit', oid: e.sha });
  const size = await blobSize(root, e.sha);
  return size === null ? absent(side, 'index') : gitRevision(side, 'index', { mode: e.mode, type: 'blob', oid: e.sha, size });
}

const statKey = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;

/**
 * The worktree side of `file`. A path in the index (stage 0) or one git lists as untracked, else
 * kind 'stale'; through a symlinked folder, outside the worktree or into the git dir: kinds
 * 'symlink' / 'outside' (worktreeGuard). Missing: absent; a symlink or anything but a regular file: special.
 */
async function worktreeRevision(root, side, file) {
  if (!(await indexEntry(root, file)) && !(await isUntracked(root, file))) {
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

/** The BlobRevision of side `side` ('old' | 'new') of `spec` (a DiffSpec; see the header). */
async function resolveSide(repo, spec, side) {
  const { file } = spec;
  const oldPath = spec.orig || file;
  if (spec.kind === 'commit') {
    const tree = side === 'old' ? await baseOf(repo, spec.sha) : spec.sha;
    return gitRevision(side, 'commit', await treeEntry(repo, tree, side === 'old' ? oldPath : file));
  }
  if (spec.untracked) return side === 'old' ? absent(side, 'index') : worktreeRevision(repo, side, file);
  if (spec.staged) {
    if (side === 'new') return indexRevision(repo, side, file);
    const { sha } = await headState(repo);
    return sha ? gitRevision(side, 'head', await treeEntry(repo, sha, oldPath)) : absent(side, 'head');
  }
  return side === 'old' ? indexRevision(repo, side, oldPath) : worktreeRevision(repo, side, file);
}

// ---------------------------------------------------------------- bytes

/**
 * The first `maxBytes` bytes of a worktree side (all of it when it is shorter), opened without
 * following a final symlink. The file must still be the one resolved (its stat key), else kind
 * 'stale': it changed, or a parent folder was swapped meanwhile. Cancelled: kind 'aborted'.
 */
async function readWorktree(rev, maxBytes, signal) {
  let fh;
  try {
    fh = await fs.promises.open(rev.abs, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK' || e.code === 'ENOENT') throw kindError('stale', 'The file changed while it was read');
    throw e;
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || statKey(st) !== rev.statKey) throw kindError('stale', 'The file changed while it was read');
    const buf = Buffer.alloc(Math.min(maxBytes, Number(st.size)));
    for (let at = 0; at < buf.length;) {
      if (signal && signal.aborted) throw kindError('aborted', 'Operation was cancelled');
      const { bytesRead } = await fh.read(buf, at, Math.min(READ_CHUNK, buf.length - at), at);
      if (!bytesRead) throw kindError('stale', 'The file changed while it was read');
      at += bytesRead;
    }
    return buf;
  } finally {
    await fh.close();
  }
}

/**
 * Bytes of a resolved side (a Buffer): at most `maxBytes` of a worktree file; a git blob only
 * whole (`maxBytes` must cover rev.size), through `cat-file blob` capped just above its size.
 * `signal` (default: the runner's, exec.withSignal) kills git / stops the file read: kind 'aborted'.
 */
async function readRevision(repo, rev, { maxBytes, signal } = {}) {
  if (rev.absent || rev.special) throw new TypeError('readRevision: nothing to read');
  if (rev.source === 'worktree') return readWorktree(rev, maxBytes, signal);
  if (!(maxBytes >= rev.size)) throw new TypeError('readRevision: a git blob is read whole');
  return out(repo, ['cat-file', 'blob', rev.oid], { encoding: 'buffer', maxBytes: rev.size + 4096, ...(signal ? { signal } : {}) });
}

module.exports = { resolveSide, readRevision, indexEntry, headEntry, treeEntry };
