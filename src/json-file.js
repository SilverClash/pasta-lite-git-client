'use strict';
// Small JSON files in userData (recent.json, trusted.json, tabs.json, clone.json): read tolerantly,
// written atomically. readJson / writeJson block; readJsonAsync / writeJsonAsync are the same off
// the main thread (fs.promises, retries waited for with timers), for stores main uses while git
// runs (src/recent.js createClonePrefs). (src/gitfiles.js has its own readJson for files inside a
// git dir.)
const fs = require('node:fs');
const path = require('node:path');

/** Parsed JSON of `file`, or null when it is missing or corrupt. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Windows refuses to rename over a file another process holds open without FILE_SHARE_DELETE (an
// antivirus scan, the search indexer, a backup or sync agent) for as long as it holds it: EPERM,
// EBUSY or EACCES. Such a hold is short, so the rename is tried again a few times, ~200 ms in all.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_DELAYS_MS = [10, 20, 40, 60, 80];

/** Block the thread for `ms` without spinning (Atomics.wait on a value nobody changes). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * fs.renameSync(from, to), on Windows (`platform`) tried again after each of `delays` (ms) while it
 * fails with one of RENAME_RETRY_CODES; the last error is thrown. `rename` / `sleep` for tests.
 */
function renameRetrying(from, to, {
  platform = process.platform, rename = fs.renameSync, sleep = sleepSync, delays = RENAME_DELAYS_MS,
} = {}) {
  for (let i = 0; ; i++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      if (platform !== 'win32' || i >= delays.length || !RENAME_RETRY_CODES.has(e && e.code)) throw e;
      sleep(delays[i]);
    }
  }
}

/**
 * Write `data` as JSON: tmp + rename, so a crash mid-write never leaves a truncated file. A rename
 * that keeps failing (renameRetrying) removes the tmp file and throws. `o` (renameRetrying's
 * options) for tests.
 */
function writeJson(file, data, o = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameRetrying(tmp, file, o);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** readJson without blocking: the parsed JSON of `file`, or null when it is missing or corrupt. */
async function readJsonAsync(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * writeJson without blocking: tmp + fs.promises.rename, on Windows (`platform`) tried again after
 * each of `delays` (ms) while it fails with one of RENAME_RETRY_CODES. The tmp file is removed
 * when it fails. `rename` / `wait` for tests.
 */
async function writeJsonAsync(file, data, {
  platform = process.platform, rename = fs.promises.rename, wait = delay, delays = RENAME_DELAYS_MS,
} = {}) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    for (let i = 0; ; i++) {
      try {
        await rename(tmp, file);
        return;
      } catch (e) {
        if (platform !== 'win32' || i >= delays.length || !RENAME_RETRY_CODES.has(e && e.code)) throw e;
        await wait(delays[i]);
      }
    }
  } catch (e) {
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
}

module.exports = {
  readJson, writeJson, readJsonAsync, writeJsonAsync,
  _internal: { sleepSync, RENAME_DELAYS_MS }, // exported for unit tests only
};
