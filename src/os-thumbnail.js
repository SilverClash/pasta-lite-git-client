'use strict';
// The OS thumbnailer behind the image preview's HEIC, TIFF and PSD sides (docs/plans/image-preview.md
// §7, §11.4: I4): an adapter around the platform's file thumbnailer, which Electron exposes as
// nativeImage.createThumbnailFromPath (QuickLook on macOS, the Shell's thumbnail handlers on
// Windows). Free of Electron like the rest of src/: main.js (the composition root) passes the call
// in as `thumbnail(file, {width, height}) -> Promise<Buffer (a PNG) | null>`, and ops.createRunner
// hands the thumbnailer to the image preview reads. There is none on other platforms (Linux), and
// the sides stay 'unsupported'.
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
//   of the same aspect ratio (±1 px). QuickLook answers a file it can't read with the file type's
//   icon (a square document picture), which this refuses. Without header dimensions nothing is asked.
// - Cancelled (`signal`): rejects kind 'aborted' at once. The OS call can't be stopped; its folder
//   goes when it ends. A failure, an empty or refused answer, or none within TIMEOUT_MS is null.
// - At most CONCURRENT OS calls run at once (a cancelled one counts until it ends); the others wait,
//   and one cancelled while it waits never reaches the OS.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('./image-format');
const { THUMBNAIL_FORMATS } = require('./image-preview');
const { kindError } = require('./exec');

// The platforms with a thumbnailer, by the name the preview shows ("Preview by macOS").
const PLATFORMS = Object.freeze({ darwin: 'macOS', win32: 'Windows' });
const BOX = 1024;
const TIMEOUT_MS = 20000;
const CONCURRENT = 2;
const PREFIX = 'pasta-lite-thumb-';

const aborted = () => kindError('aborted', 'Operation was cancelled');

/** `d` ({width, height}) fitted into a `box` × `box` square, never enlarged, at least 1×1. */
function requestSize(d, box = BOX) {
  const s = Math.min(1, box / Math.max(d.width, d.height));
  return { width: Math.max(1, Math.round(d.width * s)), height: Math.max(1, Math.round(d.height * s)) };
}

/** The size of `png` when it can be the thumbnail of an image of dimensions `d` (see the header), else null. */
function thumbnailOf(png, d) {
  if (!png || !png.length || F.sniff(png).format !== 'png') return null;
  const t = F.dimensions(png, 'png');
  if (!t || t.width > d.width || t.height > d.height) return null;
  return Math.abs(t.width * d.height - t.height * d.width) <= d.width + d.height ? t : null;
}

/** `p`'s value; rejects kind 'aborted' when `signal` aborts first; null when `ms` pass first. */
function settleWithin(p, signal, ms) {
  return new Promise((resolve, reject) => {
    function finish(f) {
      clearTimeout(timer); // set before anything can finish
      if (signal) signal.removeEventListener('abort', onAbort);
      f();
    }
    function onAbort() {
      finish(() => reject(aborted()));
    }
    const timer = setTimeout(() => finish(() => resolve(null)), ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => finish(() => resolve(v)), (e) => finish(() => reject(e)));
  });
}

/**
 * The thumbnailer for `platform`, or null when it has none or no `thumbnail` call is given:
 * {by, render, idle}. `by`: 'macOS' | 'Windows'. idle(): resolves once every OS call has ended and
 * its folder is gone. Tests pass their own `tmpDir`, `timeoutMs` and `concurrent`.
 */
function createOsThumbnailer({
  thumbnail, platform = process.platform, tmpDir = os.tmpdir(), box = BOX, timeoutMs = TIMEOUT_MS, concurrent = CONCURRENT,
} = {}) {
  const by = PLATFORMS[platform];
  if (!by || typeof thumbnail !== 'function') return null;
  let running = 0;
  const waiting = []; // calls waiting for a slot: {go}
  const pending = new Set(); // the endings (slot freed, folder removed) of calls not ended yet

  /** A slot for one OS call; kind 'aborted' when `signal` aborts while it waits. */
  function acquire(signal) {
    if (running < concurrent) {
      running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const w = {};
      const onAbort = () => {
        waiting.splice(waiting.indexOf(w), 1);
        reject(aborted());
      };
      w.go = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        running++;
        resolve();
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      waiting.push(w);
    });
  }

  function release() {
    running--;
    const next = waiting.shift();
    if (next) next.go();
  }

  async function render(bytes, { format, dims, signal } = {}) {
    if (!THUMBNAIL_FORMATS.has(format) || !dims) return null;
    if (signal && signal.aborted) throw aborted();
    await acquire(signal);
    let dir = null;
    let call = null; // the OS call, once made
    try {
      dir = await fs.promises.mkdtemp(path.join(tmpDir, PREFIX));
      const file = path.join(dir, `image.${F.FORMATS[format].extensions[0]}`);
      await fs.promises.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      if (signal && signal.aborted) throw aborted();
      call = Promise.resolve().then(() => thumbnail(file, requestSize(dims, box)));
      const png = await settleWithin(call, signal, timeoutMs);
      const size = thumbnailOf(png, dims);
      return size ? { png, ...size } : null;
    } catch (err) {
      if (err && err.kind === 'aborted') throw err;
      return null;
    } finally {
      const ended = (call || Promise.resolve()).catch(() => {})
        .then(() => dir && fs.promises.rm(dir, { recursive: true, force: true }))
        .catch(() => {})
        .finally(release);
      pending.add(ended);
      ended.then(() => pending.delete(ended));
    }
  }

  const idle = async () => {
    while (pending.size) await Promise.all([...pending]);
  };

  return Object.freeze({ by, render, idle });
}

module.exports = { createOsThumbnailer, requestSize, thumbnailOf, PLATFORMS, PREFIX };
