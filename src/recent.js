'use strict';
// Small JSON stores in userData: recently opened repositories (recent.json) and the repos the
// user agreed to open although their config runs commands (trusted.json). The open tabs
// (tabs.json) are src/tabs-store.js; all three use src/json-file.js.
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('./json-file');
const { realPathSync } = require('./fs-paths');

const MAX_RECENT = 10;

const isDir = (p) => fs.promises.stat(p).then((s) => s.isDirectory(), () => false);

/**
 * Recent repos, persisted as [{root, name, openedAt}], newest first. `name` is what add() was
 * given (ops.summary's name: 'project/.bare' for a bare repo's hidden git dir), else the
 * root's basename.
 */
function createRecentStore(filePath, { max = MAX_RECENT } = {}) {
  function load() {
    const data = readJson(filePath);
    if (!Array.isArray(data)) return []; // missing, corrupt or not a list: start over
    return data
      .filter((e) => e && typeof e.root === 'string' && path.isAbsolute(e.root))
      .map((e) => ({ root: e.root, name: typeof e.name === 'string' && e.name ? e.name : path.basename(e.root), openedAt: Number(e.openedAt) || 0 }));
  }

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

  function remove(root) {
    const real = realPathSync(root);
    writeJson(filePath, load().filter((e) => e.root !== root && realPathSync(e.root) !== real));
  }

  function clear() {
    writeJson(filePath, []);
  }

  return { list, add, remove, clear };
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

module.exports = { createRecentStore, createTrustStore };
