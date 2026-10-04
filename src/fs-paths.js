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

/** Forget the slow paths (tests). */
function resetRealPathOf() {
  slowUntil.clear();
}

/** True when real path `inner` is `outer` or inside it. */
const isAtOrUnder = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);

module.exports = {
  REALPATH_TIMEOUT_MS, MAX_PARALLEL, SLOW_FOR_MS, realPathSync, realPathOf, resetRealPathOf, isAtOrUnder,
};
