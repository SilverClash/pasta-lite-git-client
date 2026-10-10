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
 * time (nanoseconds, where the file system keeps one) decimal strings.
 */
const digits = (v) => typeof v === 'string' && /^\d+$/.test(v);
const isMade = (m) => !!m && typeof m.abs === 'string' && path.isAbsolute(m.abs) && digits(m.dev) && digits(m.ino)
  && (m.born === undefined || digits(m.born));
const pickMade = (m) => ({ abs: m.abs, dev: m.dev, ino: m.ino, ...(m.born ? { born: m.born } : {}) });
const sameMade = (a, b) => a.abs === b.abs && a.dev === b.dev && a.ino === b.ino && (a.born || null) === (b.born || null);

/**
 * clone.json (docs/plans/clone-repository.md §6.5): {lastParent: <abs>, pendingCleanup: [Made]}.
 * Main reads and writes it while git runs, so only without blocking (readJsonAsync /
 * writeJsonAsync). Edits run one after another, each on a fresh read, and are best effort: a
 * failure is logged (`log.warn`, without the path), never thrown, so it never fails a clone.
 *   lastParent(): the saved parent folder while it is an absolute path to a directory, else null
 *   setLastParent(abs), addPendingCleanup(made), dropPendingCleanup(made): resolve when saved (or not).
 *   addPendingCleanup replaces every entry for the same path: a folder was just made there, so the
 *   one an older entry names is gone, and its (reusable) inode must never point at the new one.
 *   pendingCleanup(): the removals src/clone-cleanup.js hasn't finished (well-formed entries only)
 */
function createClonePrefs(filePath, { log = { warn() {} } } = {}) {
  let tail = Promise.resolve();
  const load = async () => {
    const data = await readJsonAsync(filePath);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  };
  const pending = (data) => (Array.isArray(data.pendingCleanup) ? data.pendingCleanup.filter(isMade).map(pickMade) : []);
  const update = (change) => {
    tail = tail
      .then(async () => writeJsonAsync(filePath, change(await load())))
      .catch((e) => log.warn('could not save clone.json', { error: (e && e.code) || 'error' }));
    return tail;
  };

  async function lastParent() {
    await tail;
    const p = (await load()).lastParent;
    return typeof p === 'string' && path.isAbsolute(p) && await isDir(p) ? p : null;
  }

  async function pendingCleanup() {
    await tail;
    return pending(await load());
  }

  return {
    lastParent,
    setLastParent: (abs) => update((data) => ({ ...data, lastParent: abs })),
    pendingCleanup,
    addPendingCleanup: (made) => update((data) => ({ ...data, pendingCleanup: [...pending(data).filter((m) => !samePath(m.abs, made.abs)), pickMade(made)] })),
    dropPendingCleanup: (made) => update((data) => ({ ...data, pendingCleanup: pending(data).filter((m) => !sameMade(m, made)) })),
  };
}

module.exports = { createRecentStore, createTrustStore, createClonePrefs };
