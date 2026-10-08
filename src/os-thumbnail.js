'use strict';
// The OS thumbnailer behind the image preview's HEIC, TIFF and PSD sides (docs/plans/image-preview.md
// §7, §11.4: I4): an adapter around macOS's QuickLook thumbnailer, which Electron exposes as
// nativeImage.createThumbnailFromPath. Free of Electron like the rest of src/: main.js (the
// composition root) passes the call in as `thumbnail(file, {width, height}) -> Promise<Buffer (a PNG)
// | null>`, and ops.createRunner hands the thumbnailer to the image preview reads. There is none on
// other platforms, and the sides stay 'unsupported'. Not on Windows either: Electron's Windows
// implementation (shell/common/api/electron_api_native_image_win.cc, Electron 44) asks the Shell's
// thumbnail cache synchronously on the main thread, so a slow or hung thumbnail handler would freeze
// the app (no timeout can fire), and the thumbnail would be kept in the system's thumbnail cache.
//
// render(bytes, {format, dims, signal}) -> {png, width, height} | null:
// - The OS takes a path, so the bytes already read and checked for the side (a git blob, a worktree
//   file or a Git LFS object, whole and under the caps) are written to a new private folder (mkdtemp:
//   0700; the file 0600, created exclusively), named by the sniffed format's extension so the OS
//   picks its decoder by the content, not by the file's own name. The user's file itself is never
//   handed over. The folder is removed once the OS call has ended, whatever happened (a failure, a
//   cancel, the timeout).
// - Size: the header's dimensions fitted into BOX px, never enlarged. macOS may return up to twice
//   that (a Retina screen); the PNG's own size is what is reported.
// - The answer is taken only when it can be the image: a PNG no larger than the header's dimensions,
//   of the same aspect ratio (±1 px), in either orientation (the header's dimensions are the
//   displayed ones, image-format.js; a turn it doesn't know of may still come back turned). QuickLook
//   answers a file it can't read with the file type's icon (a square document picture), which this
//   refuses. Without header dimensions nothing is asked.
// - Cancelled (`signal`): rejects kind 'aborted' at once. The OS call can't be stopped; its folder
//   goes when it ends. A failure, an empty or refused answer, or none within TIMEOUT_MS (waiting for a
//   slot and the OS call together) is null.
// - At most CONCURRENT OS calls run at once (a cancelled one counts until it ends or its deadline
//   passes); the others wait, and one cancelled or out of time while it waits never reaches the OS. A
//   call still running at its deadline is abandoned: it no longer holds a slot, so a hung QuickLook
//   doesn't block every later thumbnail. While MAX_ABANDONED calls hang, nothing new is handed to the
//   OS (render is null at once) until one of them ends.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./image-format');
const { THUMBNAIL_FORMATS } = require('./image-preview');
const { abortedError } = require('./exec');

// The platforms with a thumbnailer, by the name the preview shows ("Preview by macOS").
const PLATFORMS = Object.freeze({ darwin: 'macOS' });
const BOX = 1024;
const TIMEOUT_MS = 20000;
const CONCURRENT = 2;
const MAX_ABANDONED = 4;
const PREFIX = 'pasta-lite-thumb-';
const STALE_MS = 60 * 60 * 1000; // sweep(): a temp folder this old is left over from an earlier run

/** `d` ({width, height}) fitted into a `box` × `box` square, never enlarged, at least 1×1. */
function requestSize(d, box = BOX) {
  const s = Math.min(1, box / Math.max(d.width, d.height));
  return { width: Math.max(1, Math.round(d.width * s)), height: Math.max(1, Math.round(d.height * s)) };
}

/** `t` (a size) is no larger than `d` and of its aspect ratio, ±1 px. */
const fits = (t, d) => t.width <= d.width && t.height <= d.height && Math.abs(t.width * d.height - t.height * d.width) <= d.width + d.height;

/** The size of `png` when it can be the thumbnail of an image of dimensions `d`, either way up (see the header), else null. */
function thumbnailOf(png, d) {
  if (!png || !png.length || F.sniff(png).format !== 'png') return null;
  const t = F.dimensions(png, 'png');
  return t && (fits(t, d) || fits(t, { width: d.height, height: d.width })) ? t : null;
}

/** `p`'s value; rejects kind 'aborted' when `signal` aborts first; null when `late` (the deadline) aborts first. */
function settle(p, signal, late) {
  return new Promise((resolve, reject) => {
    function finish(f) {
      if (signal) signal.removeEventListener('abort', onAbort);
      late.removeEventListener('abort', onLate);
      f();
    }
    function onAbort() {
      finish(() => reject(abortedError()));
    }
    function onLate() {
      finish(() => resolve(null));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    late.addEventListener('abort', onLate, { once: true });
    p.then((v) => finish(() => resolve(v)), (e) => finish(() => reject(e)));
  });
}

/**
 * The thumbnailer for `platform`, or null when it has none or no `thumbnail` call is given:
 * {by, render, idle, busy, sweep}. `by`: 'macOS'. idle(): resolves once every call has ended and its
 * folder is gone (never, while an OS call hangs: callers cap the wait). busy(): a call hasn't ended.
 * sweep({maxAgeMs}) -> the number of temp folders an earlier run left behind (it died while the OS
 * worked) that it removed: PREFIX folders directly in tmpDir, older than maxAgeMs (STALE_MS), owned by
 * this user, never through a link; never rejects. Tests pass their own `tmpDir`, `timeoutMs`,
 * `concurrent` and `maxAbandoned`.
 */
function createOsThumbnailer({
  thumbnail, platform = process.platform, tmpDir = os.tmpdir(), box = BOX, timeoutMs = TIMEOUT_MS, concurrent = CONCURRENT,
  maxAbandoned = MAX_ABANDONED,
} = {}) {
  const by = PLATFORMS[platform];
  if (!by || typeof thumbnail !== 'function') return null;
  let running = 0; // calls holding a slot
  let abandoned = 0; // OS calls past their deadline, not ended yet
  const waiting = []; // calls waiting for a slot: {go, drop}
  const pending = new Set(); // the endings (slot freed, folder removed) of calls not ended yet

  /**
   * A slot for `job`'s OS call (job.slot set): true; false when its deadline passes while it waits,
   * or when MAX_ABANDONED calls hang meanwhile; kind 'aborted' when `signal` aborts first. A call
   * that stops waiting leaves the queue.
   */
  function acquire(job, signal) {
    if (running < concurrent) {
      running++;
      job.slot = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve, reject) => {
      const w = {};
      const off = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        job.late.signal.removeEventListener('abort', onLate);
      };
      const leave = (settled) => () => {
        waiting.splice(waiting.indexOf(w), 1);
        off();
        settled();
      };
      const onAbort = leave(() => reject(abortedError()));
      const onLate = leave(() => resolve(false));
      w.go = () => {
        off();
        running++;
        job.slot = true;
        resolve(true);
      };
      w.drop = () => {
        off();
        resolve(false);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      job.late.signal.addEventListener('abort', onLate, { once: true });
      waiting.push(w);
    });
  }

  /** A slot is free: the next waiting call gets it, unless MAX_ABANDONED calls hang (then none does). */
  function freeSlot() {
    running--;
    if (abandoned >= maxAbandoned) {
      for (const w of waiting.splice(0)) w.drop();
      return;
    }
    const next = waiting.shift();
    if (next) next.go();
  }

  /** A call's bookkeeping, from its start: the deadline (TIMEOUT_MS for the wait and the OS call), its ending in `pending`. */
  function start() {
    const job = { late: new AbortController(), slot: false, abandoned: false, call: null, dir: null };
    job.timer = setTimeout(() => {
      job.late.abort();
      if (!job.slot) return;
      job.abandoned = true; // still running at its deadline: the OS hangs; the slot is free again
      abandoned++;
      freeSlot();
    }, timeoutMs);
    job.ended = new Promise((resolve) => { job.end = resolve; });
    pending.add(job.ended);
    job.ended.then(() => pending.delete(job.ended));
    return job;
  }

  /** Once the OS call has ended (at once when none was made): its folder removed, its slot freed, `job` ended. */
  function finish(job) {
    (job.call || Promise.resolve()).catch(() => {})
      .then(() => job.dir && fs.promises.rm(job.dir, { recursive: true, force: true }))
      .catch(() => {})
      .finally(() => {
        clearTimeout(job.timer);
        if (job.abandoned) abandoned--;
        else if (job.slot) freeSlot();
        job.end();
      });
  }

  async function render(bytes, { format, dims, signal } = {}) {
    if (!THUMBNAIL_FORMATS.has(format) || !dims) return null;
    if (signal && signal.aborted) throw abortedError();
    if (abandoned >= maxAbandoned) return null; // the OS hangs: nothing more is handed to it
    const job = start();
    try {
      if (!(await acquire(job, signal))) return null;
      job.dir = await fs.promises.mkdtemp(path.join(tmpDir, PREFIX));
      const file = path.join(job.dir, `image.${F.FORMATS[format].extensions[0]}`);
      await fs.promises.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      if (signal && signal.aborted) throw abortedError();
      if (job.late.signal.aborted) return null;
      job.call = Promise.resolve().then(() => thumbnail(file, requestSize(dims, box)));
      const png = await settle(job.call, signal, job.late.signal);
      const size = thumbnailOf(png, dims);
      return size ? { png, ...size } : null;
    } catch (err) {
      if (err && err.kind === 'aborted') throw err;
      return null;
    } finally {
      finish(job);
    }
  }

  const idle = async () => {
    while (pending.size) await Promise.all([...pending]);
  };

  const busy = () => pending.size > 0;

  async function sweep({ maxAgeMs = STALE_MS, now = Date.now() } = {}) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    let names;
    try {
      names = await fs.promises.readdir(tmpDir);
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      if (!name.startsWith(PREFIX)) continue;
      const dir = path.join(tmpDir, name);
      try {
        const st = await fs.promises.lstat(dir);
        if (!st.isDirectory() || (uid !== null && st.uid !== uid) || now - st.mtimeMs < maxAgeMs) continue;
        await fs.promises.rm(dir, { recursive: true, force: true });
        n++;
      } catch { /* gone meanwhile, or not ours to remove */ }
    }
    return n;
  }

  return Object.freeze({ by, render, idle, busy, sweep });
}

module.exports = { createOsThumbnailer, requestSize, thumbnailOf, PLATFORMS, PREFIX, STALE_MS };
