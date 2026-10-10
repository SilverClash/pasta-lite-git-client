'use strict';
// Real paths: how the app compares folders. git may print /var/... for what the app opened as
// /private/var/... (macOS) or the other way round, and a symlinked spelling of a repo is the same
// repo. realPathSync is for paths the app holds itself (a tab's root, the recent list), which are
// local and were just used; realPathOf is for paths git lists (a linked worktree may sit on a
// stale network mount): async and bounded by a timeout, so the main process never blocks on one.
// Both use the native realpath, which gives the canonical case on a case-insensitive file system.
//
// realPathOf runs on libuv's thread pool (4 threads, shared with every other async fs call in
// main: the log, the recent list). A timeout stops the waiting, not the thread: a realpath on a
// dead NFS / SMB mount holds its thread until the kernel answers, maybe never. So at most
// MAX_PARALLEL run at once (the others wait their turn), a path has at most one realpath running
// (later callers share it), and a path whose realpath ran past its timeout is not asked again for
// SLOW_FOR_MS (answered as unknown at once). One hung mount costs at most one thread per path and
// at most MAX_PARALLEL in all, however often the worktrees are listed.
const fs = require('node:fs');
const path = require('node:path');

const REALPATH_TIMEOUT_MS = 2000;
const MAX_PARALLEL = 2;
const SLOW_FOR_MS = 30000;

/** `p` with every symlink resolved, or path.resolve(p) when it can't be (a missing folder). */
function realPathSync(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const lookups = new Map(); // abs -> {answer: Promise<{real, missing}>, started}, until it settles
const slowUntil = new Map(); // abs -> time before which it is not asked again
const waiting = []; // start functions of lookups waiting for a free slot
let running = 0;

function startNext() {
  while (running < MAX_PARALLEL && waiting.length) waiting.shift()();
}

/** The one lookup of `abs`: a realpath started when a slot is free, shared until it settles. */
function lookup(abs) {
  const hit = lookups.get(abs);
  if (hit) return hit;
  const entry = { started: false, answer: null };
  entry.answer = new Promise((resolve) => {
    waiting.push(() => {
      entry.started = true;
      running++;
      fs.promises.realpath(abs).then(
        (real) => ({ real, missing: false }),
        (err) => ({ real: abs, missing: err.code === 'ENOENT' || err.code === 'ENOTDIR' }),
      ).then(resolve).finally(() => {
        running--;
        lookups.delete(abs);
        startNext();
      });
    });
  });
  lookups.set(abs, entry);
  startNext();
  return entry;
}

/**
 * {real, missing} for `p`, without blocking: `real` is `p` with every symlink resolved, or
 * path.resolve(p) when it can't be; `missing` is true only when `p` doesn't exist (ENOENT, or a
 * file where a folder should be: ENOTDIR). An answer that takes longer than `timeout` ms (a hung
 * mount, or a wait for a free slot) or fails otherwise is {real: path.resolve(p), missing: false}:
 * unknown is not gone, and the path matches only its own spelling. A path whose realpath ran past
 * the timeout answers that at once for SLOW_FOR_MS.
 */
async function realPathOf(p, { timeout = REALPATH_TIMEOUT_MS } = {}) {
  const abs = path.resolve(p);
  const unknown = { real: abs, missing: false };
  if ((slowUntil.get(abs) || 0) > Date.now()) return unknown;
  slowUntil.delete(abs);
  const entry = lookup(abs);
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (entry.started) slowUntil.set(abs, Date.now() + SLOW_FOR_MS); // its own realpath, not the queue, was slow
      resolve(unknown);
    }, timeout);
  });
  try {
    return await Promise.race([entry.answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when `p` is a directory now (fs.promises: off the main thread); false for anything else or an error. */
const isDir = (p) => fs.promises.stat(p).then((st) => st.isDirectory(), () => false);

/** Forget the slow paths (tests). */
function resetRealPathOf() {
  slowUntil.clear();
}

// Windows paths: '/' is a separator too, and a folder's name matches in any case. Only ASCII
// letters are folded: NTFS's case table is not JS's (the Kelvin sign is not 'k' there), and a
// containment check must never call two different folders one. Length-preserving, so callers may
// slice the original string by the folded prefix's length.
const winSeps = (p) => p.replace(/\//g, '\\');
const winKey = (p) => winSeps(p).replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * True when real path `inner` is `outer` or inside it (on Windows: '/' or '\\', and in any case).
 * `fold: false` keeps the case on Windows too, for two canonical paths (realpathSync.native spells
 * each name as it is on disk): an NTFS folder can be case-sensitive (fsutil
 * setCaseSensitiveInfo), and there 'C:\\r\\X' is not 'C:\\r\\x', so a check that lets a path in
 * must not fold. A check that keeps one out (into a git dir) folds: wrongly refusing is safe.
 */
function isAtOrUnder(inner, outer, { platform = process.platform, fold = true } = {}) {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const key = (p) => {
    if (!win) return p;
    return fold ? winKey(p) : winSeps(p);
  };
  const a = key(inner);
  const b = key(outer);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * `p` with the folder `home` written as '~' ('/Users/ada/src/x' -> '~/src/x'), for display: the
 * tab tooltips and the recent list the pages show. `p` itself when it isn't at or under `home`
 * (or either is empty). On Windows the home matches as isAtOrUnder matches (any case, either
 * separator: git prints 'C:/users/ada' for 'C:\\Users\\Ada'); the rest keeps `p`'s spelling.
 */
function homeShort(p, home, { platform = process.platform } = {}) {
  if (!p || !home) return p;
  const h = home.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
  // Only a home with a name in it: '/' or 'C:\\' as home would turn every path into '~...'.
  if (!h || /^[a-z]:$/i.test(h) || !isAtOrUnder(p, h, { platform })) return p;
  return `~${p.slice(h.length)}`; // winKey keeps the length: the folded prefix is h.length long
}

/** True when paths `a` and `b` name the same folder by spelling (on Windows: in any case, '/' or '\\'). */
function samePath(a, b, { platform = process.platform } = {}) {
  return platform === 'win32' ? winKey(a) === winKey(b) : a === b;
}

/**
 * An absolute path git printed (`rev-parse --show-toplevel`, `worktree list`, `--absolute-git-dir`
 * ...) in the spelling the app uses for the folders it holds (path.resolve's). Git for Windows
 * prints 'C:/x/repo' for what the app opened as 'C:\\x\\repo': on Windows an absolute path gets
 * '\\' separators and no trailing one (its case is kept: compare with isAtOrUnder / samePath).
 * Anything else (POSIX, a relative path, '') is returned as it is.
 */
function nativePath(p, { platform = process.platform } = {}) {
  if (platform !== 'win32' || !p || !path.win32.isAbsolute(p)) return p;
  return path.win32.resolve(p);
}

module.exports = {
  realPathSync, realPathOf, resetRealPathOf, isAtOrUnder, homeShort, samePath, nativePath, isDir,
  _internal: { REALPATH_TIMEOUT_MS, MAX_PARALLEL, SLOW_FOR_MS }, // exported for unit tests only
};
