'use strict';
// Small JSON stores in userData: recently opened repositories (recent.json), the repos the
// user agreed to open although their config runs commands (trusted.json), and the clone dialog's
// last parent folder with the clone cleanup's pending removals (clone.json). The open tabs
// (tabs.json) are src/tabs-store.js; all four use src/json-file.js.
const path = require('node:path');
const { readJson, writeJson, readJsonAsync, writeJsonAsync } = require('./json-file');
const { realPathSync, realPathOf, samePath, isDir } = require('./fs-paths');

const MAX_RECENT = 10;

/**
 * Recent repos, persisted as [{root, name, openedAt}], newest first. `name` is what add() was
 * given (ops.summary's name: 'project/.bare' for a bare repo's hidden git dir), else the
 * root's basename.
 */
function createRecentStore(filePath, { max = MAX_RECENT } = {}) {
  const valid = (data) => (Array.isArray(data) ? data : []) // missing, corrupt or not a list: start over
    .filter((e) => e && typeof e.root === 'string' && path.isAbsolute(e.root))
    .map((e) => ({ root: e.root, name: typeof e.name === 'string' && e.name ? e.name : path.basename(e.root), openedAt: Number(e.openedAt) || 0 }));
  const load = () => valid(readJson(filePath));

  /** Entries whose directory still exists, newest first (stats in parallel, off the main thread). */
  async function list() {
    const entries = load();
    const exists = await Promise.all(entries.map((e) => isDir(e.root)));
    return entries.filter((_, i) => exists[i]);
  }

  /** Move `root` (deduplicated by real path) to the front; keeps at most `max`. `name`: shown name. */
  function add(root, { name } = {}) {
    const real = realPathSync(root);
    const rest = load().filter((e) => realPathSync(e.root) !== real);
    const shown = typeof name === 'string' && name ? name : path.basename(real);
    writeJson(filePath, [{ root: real, name: shown, openedAt: Date.now() }, ...rest].slice(0, max));
  }

  let tail = Promise.resolve();
  /**
   * add() without blocking (a clone that finished after its tab closed, while main runs git):
   * the real paths, the read and the atomic write all off the main thread, one addAsync after
   * another. Resolves when written; rejects with the write's error.
   */
  function addAsync(root, { name } = {}) {
    const run = tail.then(async () => {
      const real = (await realPathOf(root)).real;
      const entries = valid(await readJsonAsync(filePath));
      const reals = await Promise.all(entries.map((e) => realPathOf(e.root).then((r) => r.real)));
      const rest = entries.filter((_, i) => reals[i] !== real);
      const shown = typeof name === 'string' && name ? name : path.basename(real);
      await writeJsonAsync(filePath, [{ root: real, name: shown, openedAt: Date.now() }, ...rest].slice(0, max));
    });
    tail = run.catch(() => {});
    return run;
  }

  function remove(root) {
    const real = realPathSync(root);
    writeJson(filePath, load().filter((e) => e.root !== root && realPathSync(e.root) !== real));
  }

  function clear() {
    writeJson(filePath, []);
  }

  return { list, add, addAsync, remove, clear };
}

/**
 * Repos opened despite risky config (git.riskyLocalConfig), persisted as [{root, keys}] by real
 * path. A root is trusted for the keys the user agreed to: a key added later asks again.
 */
function createTrustStore(filePath) {
  function load() {
    const data = readJson(filePath);
    if (!Array.isArray(data)) return [];
    return data.filter((e) => e && typeof e.root === 'string' && path.isAbsolute(e.root)
      && Array.isArray(e.keys) && e.keys.every((k) => typeof k === 'string'));
  }

  // A saved root is compared by its real path too, as the recent list does: one saved with
  // another spelling (a symlink, or another letter case on a case-insensitive file system, which
  // the native realpath canonicalises) is the same repo.
  const find = (entries, real) => entries.find((e) => e.root === real || realPathSync(e.root) === real);

  /** True when every one of `keys` was accepted for `root`. */
  function isTrusted(root, keys) {
    const entry = find(load(), realPathSync(root));
    return !!entry && keys.every((k) => entry.keys.includes(k));
  }

  /** Accept `keys` for `root` (on top of what was accepted before). */
  function trust(root, keys) {
    const real = realPathSync(root);
    const entries = load();
    const old = find(entries, real);
    const merged = [...new Set([...(old ? old.keys : []), ...keys])].sort(); // NOSONAR(S2871): config keys; code-unit order is intended
    writeJson(filePath, [{ root: real, keys: merged }, ...entries.filter((e) => e !== old)]);
  }

  return { isTrusted, trust };
}

/**
 * A Made ({abs, dev, ino, born?}: src/clone.js) as stored: those fields, the ids and the birth
 * time (nanoseconds, where the file system keeps one) decimal strings, and `state: 'failed'` once
 * its clone failed and its removal began (src/clone-cleanup.js). An entry without it is a folder
 * whose clone's outcome is unknown (still running, or a crash or a quit cut it short).
 */
const digits = (v) => typeof v === 'string' && /^\d+$/.test(v);
const isMade = (m) => !!m && typeof m.abs === 'string' && path.isAbsolute(m.abs) && digits(m.dev) && digits(m.ino)
  && (m.born === undefined || digits(m.born)) && (m.state === undefined || m.state === 'failed');
const pickMade = (m) => ({ abs: m.abs, dev: m.dev, ino: m.ino, ...(m.born ? { born: m.born } : {}), ...(m.state === 'failed' ? { state: 'failed' } : {}) });
/** The same folder (its state aside). */
const sameMade = (a, b) => a.abs === b.abs && a.dev === b.dev && a.ino === b.ino && (a.born || null) === (b.born || null);
const madeKey = (m) => [m.abs, m.dev, m.ino, m.born || ''].join('\0');

const FORGET_RETRY_MS = Object.freeze([250, 1000, 4000]);

/**
 * clone.json (docs/plans/clone-repository.md §6.5): {lastParent: <abs>, pendingCleanup: [Made]}.
 * Main reads and writes it while git runs, so only without blocking (readJsonAsync /
 * writeJsonAsync). Edits run one after another, each on a fresh read, and are best effort: a
 * failure is logged (`log.warn`, without the path), never thrown, so it never fails a clone.
 *   lastParent(): the saved parent folder while it is an absolute path to a directory, else null
 *   setLastParent(abs), addPendingCleanup(made): resolve when saved (or not). addPendingCleanup
 *   replaces every entry for the same path: a folder was just made there, so the one an older
 *   entry names is gone, and its (reusable) inode must never point at the new one.
 *   markFailed(made, {add}): the entry for that folder gets `state: 'failed'` (src/clone-cleanup.js
 *   writes it before removing anything); `add`: also when there is none. Resolves whether an entry
 *   is marked now.
 *   dropPendingCleanup(made): the folder is no longer pending. It is also remembered for this run,
 *   so every later write drops it too, and a write that fails is tried again (`retryDelays`): a
 *   successful clone whose entry outlived it must never look like a removal to finish.
 *   pendingCleanup(): the entries src/clone-cleanup.js hasn't settled (well-formed ones only)
 */
function createClonePrefs(filePath, { log = { warn() {} }, retryDelays = FORGET_RETRY_MS, wait = (ms) => new Promise((r) => { setTimeout(r, ms); }) } = {}) {
  let tail = Promise.resolve();
  const forgotten = new Set(); // madeKey of every entry dropped in this run
  const load = async () => {
    const data = await readJsonAsync(filePath);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  };
  const pending = (data) => (Array.isArray(data.pendingCleanup) ? data.pendingCleanup.filter(isMade).map(pickMade) : [])
    .filter((m) => !forgotten.has(madeKey(m)));
  /** Resolves true when written, false when the write failed (logged). */
  const update = (change) => {
    const run = tail.then(async () => {
      await writeJsonAsync(filePath, change(await load()));
      return true;
    }).catch((e) => {
      log.warn('could not save clone.json', { error: (e && e.code) || 'error' });
      return false;
    });
    tail = run;
    return run;
  };
  const withPending = (change) => (data) => ({ ...data, pendingCleanup: change(pending(data)) });

  async function lastParent() {
    await tail;
    const p = (await load()).lastParent;
    return typeof p === 'string' && path.isAbsolute(p) && await isDir(p) ? p : null;
  }

  async function pendingCleanup() {
    await tail;
    return pending(await load());
  }

  async function markFailed(made, { add = true } = {}) {
    let marked = false;
    await update(withPending((list) => {
      const out = list.map((m) => {
        if (!sameMade(m, made)) return m;
        marked = true;
        return { ...m, state: 'failed' };
      });
      if (!marked && add) {
        marked = true;
        return [...out.filter((m) => !samePath(m.abs, made.abs)), { ...pickMade(made), state: 'failed' }];
      }
      return out;
    }));
    return marked;
  }

  async function dropPendingCleanup(made) {
    forgotten.add(madeKey(made));
    const drop = withPending((list) => list.filter((m) => !sameMade(m, made)));
    if (await update(drop)) return;
    for (const ms of retryDelays) {
      await wait(ms);
      if (await update(drop)) return;
    }
  }

  return {
    lastParent,
    setLastParent: (abs) => update((data) => ({ ...data, lastParent: abs })).then(() => {}),
    pendingCleanup,
    addPendingCleanup: (made) => {
      forgotten.delete(madeKey(made));
      return update(withPending((list) => [...list.filter((m) => !samePath(m.abs, made.abs)), pickMade(made)])).then(() => {});
    },
    markFailed,
    dropPendingCleanup,
  };
}

module.exports = { createRecentStore, createTrustStore, createClonePrefs, sameMade };
