'use strict';
// Removing what a failed or cancelled clone created (docs/plans/clone-repository.md §5.5), and
// only that: the folder src/clone.js made, while it is still that folder, and only with evidence
// that its clone failed.
//
// The folder is written to clone.json's pendingCleanup (src/recent.js createClonePrefs) as soon as
// it exists (journal(), from cloneRepo's onMade), and dropped once the clone succeeds (forget(),
// which clone.json remembers and retries) or its removal is done. Before anything is removed the
// entry is marked `state: 'failed'`. So a quit, a crash or a git that outlived its kill can't
// abandon a failed clone: the next launch finishes it (resume()). before-quit waits, bounded, for
// these writes (persisted()). A new clone's folder replaces any entry for the same path.
//
// resume() removes a folder only with evidence that its clone failed:
//   - the entry is marked 'failed' (its removal had begun), or
//   - it isn't (the outcome is unknown: a crash or a quit while git ran) and the clone never
//     finished fetching: no .git, or no ref behind its HEAD. A folder whose fetch finished may be
//     a clone that succeeded (its forget lost in a crash) or one killed during its checkout: it is
//     left as it is, with a log line, for the user to judge.
// and never a folder the user has: one the recent list or a saved tab names, at or inside it
// (`keep`). It re-reads the list for every entry and skips one that changed meanwhile (a new clone
// at that path), and while resuming it only ever marks an entry that is still there, never adds.
//
// Before anything is removed, the folder's identity is checked again: still a directory, not a
// link, with the dev and inode recorded when it was created (a file system without inode numbers,
// ino 0, never matches) and, where one was recorded, the same birth time (bornOf). Anything else
// is 'kept'. The removal itself is fs.promises.rm, off the main thread however big
// the partial checkout is, with retries for files Windows still holds open for a moment after a
// hard kill. It is no runner op, so quitting never waits for it.
const fs = require('node:fs');
const path = require('node:path');
const { logger } = require('./log');
const { sameMade } = require('./recent');
const { realPathOf, isAtOrUnder } = require('./fs-paths');

const RM_OPTIONS = Object.freeze({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/**
 * The birth time `st` (a bigint lstat) shows, as src/clone.js records it in a Made: whenever it
 * isn't 0 (statx on Linux, APFS, NTFS all keep one). null when there is none.
 */
const bornOf = (st) => (st.birthtimeNs > 0n ? String(st.birthtimeNs) : null);

/**
 * 'same' when `made`'s folder is still the one we created, 'gone' when nothing is there, else
 * 'other'. A recorded birth time is always compared: a folder made at that path later, even on
 * a reused inode (ext4 reuses them at once), is another one. Where a file system reports the ctime
 * as the birth time, our own folder's moves as git writes into it, so it reads 'other' too: kept,
 * never removed (the safe side). `lstat` for tests.
 */
async function identity(made, { lstat = fs.promises.lstat } = {}) {
  let st;
  try {
    st = await lstat(made.abs, { bigint: true });
  } catch (e) {
    if (e.code === 'ENOENT') return 'gone';
    throw e;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return 'other';
  if (st.ino === 0n || made.ino === '0' || String(st.ino) !== made.ino || String(st.dev) !== made.dev) return 'other';
  if (made.born && bornOf(st) !== made.born) return 'other';
  return 'same';
}

/**
 * Whether the clone in `abs` finished fetching: its .git's HEAD names a ref that exists (a loose
 * ref or a packed one), or is a detached object id. git clone creates the branch ref only once
 * the fetch is complete. Read with fs only (no git runs in a folder of unknown content); anything
 * unreadable counts as fetched, so the folder is kept.
 */
async function fetched(abs) {
  const dir = path.join(abs, '.git');
  let head;
  try {
    if (!(await fs.promises.lstat(dir)).isDirectory()) return false;
    head = (await fs.promises.readFile(path.join(dir, 'HEAD'), 'utf8')).trim();
  } catch (e) {
    return !(e && e.code === 'ENOENT');
  }
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) return true;
  const m = /^ref: (refs\/\S+)$/.exec(head);
  if (!m || m[1].split('/').includes('..')) return true;
  try {
    await fs.promises.access(path.join(dir, ...m[1].split('/')));
    return true;
  } catch { /* not loose: packed? */ }
  try {
    const packed = await fs.promises.readFile(path.join(dir, 'packed-refs'), 'utf8');
    return packed.split(/\r?\n/).some((l) => l.endsWith(` ${m[1]}`)); // \r\n too (a file another tool wrote on Windows)
  } catch (e) {
    return !(e && e.code === 'ENOENT');
  }
}

/**
 * keep() for createCleanup from the folders the user has: `roots()` resolves their paths (the
 * recent list's, the saved tabs'); a folder at or above any of them is kept. Compared by real path
 * too (a root is a real path; a Made's abs may not be).
 */
function keepListed(roots) {
  return async (abs) => {
    const list = (await roots()).filter((r) => typeof r === 'string' && r);
    if (!list.length) return false;
    const real = (await realPathOf(abs)).real;
    return list.some((r) => isAtOrUnder(r, abs) || isAtOrUnder(r, real));
  };
}

/**
 * @param {{prefs: {addPendingCleanup(m): Promise<void>, markFailed(m, o): Promise<boolean>,
 *   dropPendingCleanup(m): Promise<void>, pendingCleanup(): Promise<object[]>}, log?: object,
 *   rm?: Function, keep?: (abs: string) => Promise<boolean>, lstat?: Function}} o
 *   prefs: clone.json (createClonePrefs); rm, lstat: fs.promises' (tests); keep: a folder the user
 *   has (keepListed), never removed.
 * @returns {{journal(made): Promise<void>, forget(made): Promise<void>,
 *   remove(made): Promise<'removed'|'gone'|'kept'|'failed'>, running(): object[], writing(): boolean,
 *   persisted(): Promise<void>, resume(): Promise<void>}}
 *   journal: a clone made `made`: it is pending, outcome unknown, until forget() or its removal.
 *   forget: the clone succeeded; its folder is the user's.
 *   remove: its clone failed: marked 'failed', then removed; never rejects. 'failed' keeps the
 *   entry pending (the next launch tries again); the other outcomes drop it. A second remove of a
 *   folder being removed joins the first.
 *   running: the Made of every removal in progress. writing / persisted: whether clone.json writes
 *   are in flight, and a promise that resolves once every write started so far has landed (or
 *   failed: they are logged). resume: at startup, settle clone.json's entries (see the header);
 *   never rejects.
 */
function createCleanup({ prefs, log = logger.child('clone'), rm = fs.promises.rm, keep = async () => false, lstat } = {}) {
  const inFlight = new Map(); // abs -> {made, promise}
  const writes = new Set(); // clone.json writes not landed yet

  /** Track a clone.json write for persisted(); prefs logs a failure and never rejects. */
  function track(p) {
    const w = Promise.resolve(p).catch(() => {});
    writes.add(w);
    w.then(() => writes.delete(w));
    return p;
  }
  const drop = (made) => track(prefs.dropPendingCleanup(made));

  /**
   * Remove `made`'s folder; `resuming`: an entry read back at startup (see the header).
   * `decided()`: called once its clone.json mark is written, or it was decided not to remove.
   */
  async function removeNow(made, { resuming = false } = {}, decided = () => {}) {
    try {
      if (await keep(made.abs)) {
        log.info('a clone folder the recent list or a tab names: kept', {});
        await drop(made);
        return 'kept';
      }
      const id = await identity(made, lstat ? { lstat } : {});
      if (id !== 'same') {
        if (id === 'other') log.info('a cancelled clone\'s folder was replaced since: kept', {});
        await drop(made);
        return id === 'gone' ? 'gone' : 'kept';
      }
      if (resuming && made.state !== 'failed' && await fetched(made.abs)) {
        log.info('a clone folder whose outcome is unknown finished fetching: left as it is', {});
        await drop(made);
        return 'kept';
      }
      // The evidence, written first: a removal cut short is finished by the next launch.
      const marked = await track(prefs.markFailed(made, { add: !resuming }));
      decided();
      if (!marked) return 'kept';
      await rm(made.abs, RM_OPTIONS);
    } catch (e) {
      log.warn('could not remove a cancelled clone\'s folder; trying again at the next launch', { error: (e && e.code) || 'error' });
      return 'failed';
    }
    await drop(made);
    return 'removed';
  }

  function remove(made, o) {
    const had = inFlight.get(made.abs);
    if (had) return had.promise;
    // persisted() waits from now until the mark is written (or the removal decided against): a
    // quit right after a clone failed still leaves its evidence in clone.json.
    let decided;
    track(new Promise((r) => { decided = r; }));
    const promise = removeNow(made, o, decided).catch(() => 'failed');
    promise.then(decided);
    const entry = { made, promise };
    inFlight.set(made.abs, entry);
    promise.then(() => { if (inFlight.get(made.abs) === entry) inFlight.delete(made.abs); });
    return promise;
  }

  async function persisted() {
    while (writes.size) await Promise.all([...writes]);
  }

  async function resume() {
    const first = await prefs.pendingCleanup().catch(() => []);
    for (const made of first) {
      // Read again: a clone started since may have replaced the entry for this path.
      const now = (await prefs.pendingCleanup().catch(() => [])).find((m) => m.abs === made.abs);
      if (!now || !sameMade(now, made) || (now.state || null) !== (made.state || null)) continue;
      await remove(now, { resuming: true });
    }
  }

  return {
    journal: (made) => track(prefs.addPendingCleanup(made)),
    forget: drop,
    remove: (made) => remove(made),
    running: () => [...inFlight.values()].map((e) => e.made),
    writing: () => writes.size > 0,
    persisted,
    resume,
  };
}

module.exports = { createCleanup, bornOf, keepListed, _internal: { identity, fetched, RM_OPTIONS } }; // _internal: for unit tests only
