'use strict';
// Filesystem safety for the few places we write the working tree directly instead of through git
// (hunks.discardSelection, undo's restore of a discard backup): a guard that refuses paths
// through symbolic links, outside the worktree or into the git dir, and reads / writes that
// never follow a final symlink. Split out of hunks.js, which re-exports it.
const fs = require('node:fs');
const path = require('node:path');
const { out, kindError } = require('./exec');
const { resolveRoot } = require('./repo-dirs');
const { isAtOrUnder } = require('./fs-paths');

// O_NOFOLLOW is POSIX only; elsewhere (Windows) it is 0 and only the lstat walk protects.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const realpath = (p) => fs.realpathSync.native(p); // native: canonical case on case-insensitive fs

// Real path of `abs`, which may not exist yet: realpath of the deepest existing ancestor plus the rest.
function realpathOfMaybeMissing(abs) {
  const rest = [];
  let p = abs;
  for (;;) {
    try {
      return path.join(realpath(p), ...rest);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(p);
      if (parent === p) throw e;
      rest.unshift(path.basename(p));
      p = parent;
    }
  }
}

/**
 * Guard for fs calls on root-relative paths. `check(rel)` returns the absolute path or throws:
 *   kind 'symlink'  some component of the path (any parent dir or the file itself) is a symbolic
 *                   link, dangling or not: fs calls would follow it, possibly out of the worktree;
 *   kind 'outside'  the path is absolute, has '..'/'.git' segments, or resolves outside the worktree
 *                   or into the repository's git dir / common git dir.
 * Every component is lstat'ed from the worktree root down; components that don't exist yet are
 * fine (they will be created as real directories). Call check() again right before each write.
 * check(rel, {allowFinalLink: true}) accepts a symlink as the last component (for deleting a
 * tracked link itself: unlink never follows it); its parents are still checked the same way.
 */
async function worktreeGuard(cwd) {
  const root = await resolveRoot(cwd);
  const realRoot = realpath(root);
  const dirs = (await out(root, ['rev-parse', '--git-dir', '--git-common-dir'])).split('\n').filter(Boolean);
  const gitDirs = [...new Set(dirs.map((d) => realpathOfMaybeMissing(path.resolve(root, d))))];

  function check(rel, { allowFinalLink = false } = {}) {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) throw kindError('outside', `not a repository-relative path: ${rel}`);
    const parts = rel.split(/[\\/]+/).filter((s) => s && s !== '.');
    if (!parts.length || parts.some((s) => s === '..' || s.toLowerCase() === '.git')) {
      throw kindError('outside', `path leaves the worktree: ${rel}`);
    }
    let p = realRoot;
    let finalLink = false;
    for (let i = 0; i < parts.length; i++) {
      p = path.join(p, parts[i]);
      const st = fs.lstatSync(p, { throwIfNoEntry: false });
      if (!st) break; // the rest doesn't exist yet
      if (!st.isSymbolicLink()) continue;
      if (!(allowFinalLink && i === parts.length - 1)) throw kindError('symlink', `${rel}: path goes through a symbolic link`);
      finalLink = true;
    }
    const abs = path.join(realRoot, ...parts);
    // A permitted final link is judged by where it sits, not where it points.
    const real = finalLink ? path.join(realpathOfMaybeMissing(path.dirname(abs)), path.basename(abs)) : realpathOfMaybeMissing(abs);
    if (!isAtOrUnder(real, realRoot)) throw kindError('outside', `${rel}: path resolves outside the worktree`);
    if (gitDirs.some((g) => isAtOrUnder(real, g))) throw kindError('outside', `${rel}: path is inside the git directory`);
    return abs;
  }
  return { root: realRoot, check };
}

// ELOOP (Linux/macOS) / EMLINK (FreeBSD): O_NOFOLLOW hit a symlink as the final component.
const nofollowError = (e, abs) => ((e.code === 'ELOOP' || e.code === 'EMLINK')
  ? kindError('symlink', `${abs} is a symbolic link`) : e);

/** Read a file without following a final symlink; null when it doesn't exist. */
function readNoFollow(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw nofollowError(e, abs);
  }
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write `buf` to `abs` without following a final symlink. An existing file is truncated and keeps
 * its mode; `create: true` requires the file not to exist (O_EXCL) and creates it with `mode`.
 * `exec: true|false` then sets or clears the executable bits (where the read bits are set), like
 * git checking out a 100755 / 100644 entry.
 */
function writeNoFollow(abs, buf, { create = false, mode = 0o644, exec } = {}) {
  const { O_WRONLY, O_TRUNC, O_CREAT, O_EXCL } = fs.constants;
  const flags = O_WRONLY | O_NOFOLLOW | (create ? O_CREAT | O_EXCL : O_TRUNC);
  let fd;
  try {
    fd = fs.openSync(abs, flags, mode);
  } catch (e) {
    throw nofollowError(e, abs);
  }
  try {
    fs.writeFileSync(fd, buf);
    if (exec !== undefined) {
      const cur = fs.fstatSync(fd).mode & 0o7777;
      const next = exec ? cur | ((cur & 0o444) >> 2) : cur & ~0o111;
      if (next !== cur) fs.fchmodSync(fd, next);
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { worktreeGuard, readNoFollow, writeNoFollow, realpathOfMaybeMissing };
