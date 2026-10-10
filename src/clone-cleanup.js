'use strict';
// Removing what a failed or cancelled clone created (docs/plans/clone-repository.md §5.5), and
// only that: the folder src/clone.js made, while it is still that folder.
//
// The folder is written to clone.json's pendingCleanup (src/recent.js createClonePrefs) as soon as
// it exists (journal(), from cloneRepo's onMade), and dropped once the clone succeeds (forget()) or
// its removal is done. So a quit, a crash or a git that outlived its kill can't abandon it: the
// next launch finishes it (resume()). before-quit waits, bounded, for these writes (persisted()).
// A new clone's folder replaces any entry for the same path: the old folder is gone (mkdir just
// made one there), and an inode the file system reused must never make resume() delete the new one.
//
// Before anything is removed, the folder's identity is checked again: still a directory, not a
// link, with the dev and inode recorded when it was created (a file system without inode numbers,
// ino 0, never matches) and, where the file system keeps one, the same birth time. Anything else
// is 'kept' and nothing is removed: a folder the user has since recreated at that path is never
// touched. The removal itself is fs.promises.rm, off the main thread however big the partial
// checkout is, with retries for files Windows still holds open for a moment after a hard kill (an
// antivirus scan, a dying index-pack). It is no runner op, so quitting never waits for it.
const fs = require('node:fs');
const { logger } = require('./log');

const RM_OPTIONS = Object.freeze({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/**
 * The birth time `st` (a bigint lstat) shows for comparing, or null when it can't tell one folder
 * from another: none kept (0), or the ctime in its place (some Linux file systems report that,
 * and a folder's ctime moves with every entry git writes).
 */
const bornOf = (st) => (st.birthtimeNs > 0n && st.birthtimeNs !== st.ctimeNs ? String(st.birthtimeNs) : null);

/** 'same' when `made`'s folder is still the one we created, 'gone' when nothing is there, else 'other'. */
async function identity(made) {
  let st;
  try {
    st = await fs.promises.lstat(made.abs, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT') return 'gone';
    throw e;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return 'other';
  if (st.ino === 0n || made.ino === '0' || String(st.ino) !== made.ino || String(st.dev) !== made.dev) return 'other';
  const born = bornOf(st);
  if (made.born && born && born !== made.born) return 'other'; // an inode reused for a later folder
  return 'same';
}

/**
 * @param {{prefs: {addPendingCleanup(m): Promise<void>, dropPendingCleanup(m): Promise<void>,
 *   pendingCleanup(): Promise<object[]>}, log?: object, rm?: Function}} o
 *   prefs: clone.json (createClonePrefs); rm: fs.promises.rm (tests).
 * @returns {{journal(made): Promise<void>, forget(made): Promise<void>,
 *   remove(made): Promise<'removed'|'gone'|'kept'|'failed'>, running(): object[], writing(): boolean,
 *   persisted(): Promise<void>, resume(): Promise<void>}}
 *   journal: a clone made `made`: it is pending until forget() or its removal.
 *   forget: the clone succeeded; its folder is the user's.
 *   remove: journalled (again), then removed; never rejects. 'failed' keeps the entry pending (the
 *   next launch tries again); the other outcomes drop it. A second remove of a folder being
 *   removed joins the first.
 *   running: the Made of every removal in progress. writing / persisted: whether clone.json writes
 *   are in flight, and a promise that resolves once every write started so far has landed (or
 *   failed: they are logged). resume: at startup, finish clone.json's pending removals, one after
 *   another; never rejects.
 */
function createCleanup({ prefs, log = logger.child('clone'), rm = fs.promises.rm } = {}) {
  const inFlight = new Map(); // abs -> {made, promise}
  const writes = new Set(); // clone.json writes not landed yet

  /** Track a clone.json write for persisted(); prefs logs a failure and never rejects. */
  function track(p) {
    const w = Promise.resolve(p).catch(() => {});
    writes.add(w);
    w.then(() => writes.delete(w));
    return w;
  }

  async function removeNow(made) {
    await track(prefs.addPendingCleanup(made));
    let outcome;
    try {
      const id = await identity(made);
      if (id === 'gone') {
        outcome = 'gone';
      } else if (id === 'other') {
        outcome = 'kept';
        log.info('a cancelled clone\'s folder was replaced since: kept', {});
      } else {
        await rm(made.abs, RM_OPTIONS);
        outcome = 'removed';
      }
    } catch (e) {
      log.warn('could not remove a cancelled clone\'s folder; trying again at the next launch', { error: (e && e.code) || 'error' });
      return 'failed';
    }
    await track(prefs.dropPendingCleanup(made));
    return outcome;
  }

  function remove(made) {
    const had = inFlight.get(made.abs);
    if (had) return had.promise;
    const promise = removeNow(made).catch(() => 'failed');
    const entry = { made, promise };
    inFlight.set(made.abs, entry);
    promise.then(() => { if (inFlight.get(made.abs) === entry) inFlight.delete(made.abs); });
    return promise;
  }

  async function persisted() {
    while (writes.size) await Promise.all([...writes]);
  }

  async function resume() {
    const pending = await prefs.pendingCleanup().catch(() => []);
    for (const made of pending) await remove(made);
  }

  return {
    journal: (made) => track(prefs.addPendingCleanup(made)),
    forget: (made) => track(prefs.dropPendingCleanup(made)),
    remove,
    running: () => [...inFlight.values()].map((e) => e.made),
    writing: () => writes.size > 0,
    persisted,
    resume,
  };
}

module.exports = { createCleanup, _internal: { identity, bornOf, RM_OPTIONS } }; // _internal: for unit tests only
