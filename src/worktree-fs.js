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
// The '.git' aliases and Windows' device names (shared with the clone dialog's name check).
const { isDotGitName, DEVICE_NAME } = require('./path-names');

// O_NOFOLLOW is POSIX only; elsewhere (Windows) it is 0 and only the lstat walk protects.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
// The separators of a repository-relative path: '/' (git's), and on Windows '\' too. On POSIX '\' is
// an ordinary file name character (git tracks 'a\b.png' as one name), so the guard checks the very
// file git means, not 'a/b.png'.
const separators = (platform) => (platform === 'win32' ? /[\\/]+/ : /\/+/);

// A component of an input path the guard refuses by its spelling: '..', a '.git' (isDotGitName),
// and on Windows any name Win32 doesn't open as the file spelled: trailing dots / spaces are
// stripped ('a.' opens 'a'), ':' names an NTFS alternate data stream ('a:s',
// '.git::$INDEX_ALLOCATION') and a device name (DEVICE_NAME) opens a device. Git for Windows
// doesn't check such names out either.
const refusedName = (name, platform) => name === '..' || isDotGitName(name, { platform })
  || (platform === 'win32' && (/[. ]$|:/.test(name) || DEVICE_NAME.test(name)));

/**
 * True when real path `real` (at or under real path `realRoot`) goes through a '.git' component
 * below the root: the canonical spelling of the path, so it catches the aliases the input check
 * can't know (an 8.3 name realpath expanded, say 'GI8F2A~1' for '.git'). realpath expands only the
 * part that exists; the rest is the input's own spelling, which the input check already refused
 * any alias in, and a missing name can't be an alias of an existing '.git'.
 */
function throughDotGit(real, realRoot, { platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.relative(realRoot, real).split(p.sep).some((name) => isDotGitName(name, { platform }));
}
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
async function worktreeGuard(cwd, { platform = process.platform } = {}) {
  const root = await resolveRoot(cwd);
  const realRoot = realpath(root);
  const dirs = (await out(root, ['rev-parse', '--git-dir', '--git-common-dir'])).split('\n').filter(Boolean);
  const gitDirs = [...new Set(dirs.map((d) => realpathOfMaybeMissing(path.resolve(root, d))))];

  function check(rel, { allowFinalLink = false } = {}) {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) throw kindError('outside', `not a repository-relative path: ${rel}`);
    const parts = rel.split(separators(platform)).filter((s) => s && s !== '.');
    if (!parts.length || parts.some((s) => refusedName(s, platform))) {
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
    // Exact case: both are canonical (realpath), and a path is let in only when it really is under
    // the root (in a case-sensitive NTFS folder 'C:\\Repo\\x' is not inside 'C:\\repo').
    if (!isAtOrUnder(real, realRoot, { fold: false })) throw kindError('outside', `${rel}: path resolves outside the worktree`);
    // A linked worktree's / submodule's '.git' is a pointer file outside any git dir.
    if (throughDotGit(real, realRoot, { platform })) throw kindError('outside', `${rel}: path is a .git`);
    // Folded (on Windows any case): a refusal may err on the safe side.
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
 * The open flags of writeNoFollow: write only, never through a final symlink (POSIX), and either
 * creating the file (O_CREAT | O_EXCL) or truncating an existing one. On Windows (`platform`)
 * without O_TRUNC: libuv opens O_TRUNC without O_CREAT as TRUNCATE_EXISTING, which CreateFile
 * refuses (EINVAL) for the write access libuv asks; plain O_WRONLY is OPEN_EXISTING, and
 * writeNoFollow truncates through the descriptor. OPEN_EXISTING also opens a hidden file, which
 * O_CREAT | O_TRUNC (CREATE_ALWAYS) would refuse with EPERM.
 */
function writeFlags({ create = false, platform = process.platform } = {}) {
  const { O_WRONLY, O_TRUNC, O_CREAT, O_EXCL } = fs.constants;
  if (create) return O_WRONLY | O_NOFOLLOW | O_CREAT | O_EXCL;
  return O_WRONLY | O_NOFOLLOW | (platform === 'win32' ? 0 : O_TRUNC);
}

/**
 * Write `buf` to `abs` without following a final symlink. An existing file is truncated and keeps
 * its mode; `create: true` requires the file not to exist (O_EXCL) and creates it with `mode`.
 * `exec: true|false` then sets or clears the executable bits (where the read bits are set), like
 * git checking out a 100755 / 100644 entry. `platform` for tests (see writeFlags).
 */
function writeNoFollow(abs, buf, { create = false, mode = 0o644, exec, platform = process.platform } = {}) {
  let fd;
  try {
    fd = fs.openSync(abs, writeFlags({ create, platform }), mode);
  } catch (e) {
    throw nofollowError(e, abs);
  }
  try {
    if (!create && platform === 'win32') fs.ftruncateSync(fd, 0);
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

module.exports = {
  worktreeGuard, readNoFollow, writeNoFollow, O_NOFOLLOW,
  _internal: { writeFlags, isDotGitName, throughDotGit, refusedName }, // exported for unit tests only
};
