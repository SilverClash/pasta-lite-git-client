'use strict';
// One side of a file diff as an image preview (docs/plans/image-preview.md §2.2, §5): what
// imageSide() makes of a resolved BlobRevision (src/blob-revisions.js) and the bytes read for it,
// under the PreviewPolicy (src/image-format.js POLICY). Pure: it never runs git or touches the
// file system. ops.js (commitImageSide / workdirImageSide) resolves the side, asks readLimit how
// many bytes to read, reads them and calls imageSide.
//
// ImageSide: {side, kind, source, key, size, format, extensionHint, mime, mismatch, dims,
// animated} (sniff / dimensions of image-format.js; size in bytes, null when absent), plus by kind:
//   'image'        bytes (a Buffer; a Uint8Array once it crosses IPC): a tier 1 format, with the
//                  catalogue's mime. Nothing else carries bytes, and mime is null for every other kind.
//   'too-large'    soft (true: force loads it), limit ('size' | 'svg' | 'pixels'), max (that limit)
//   'lfs-pointer'  lfs: {oid, size}, the Git LFS object the stored pointer names (not loaded)
//   'unsupported'  a recognised tier 2 or 'probe' format (HEIC, TIFF, PSD, SVGZ, JPEG XL)
//   'not-image'    the content is no known image
//   'absent'       no such side (an added file's old side, a deleted file's new side)
//   'special'      a symlink, submodule, folder or other non-file: never read
//   'not-local'    a git blob that isn't in the local object store (a partial clone's: never fetched,
//                  never read); key null and size null, so a reload asks again (it may be fetched since)
// The caller returns {side, key, unchanged: true} instead when the renderer already holds `key`.
// A side read from the local Git LFS cache (source 'lfs-cache', ops.js) is judged like any other,
// keyed 'lfs:<sha256>', and the caller adds the pointer's `lfs: {oid, size}` to it.
// With an OS thumbnailer (I4, src/os-thumbnail.js: macOS) a HEIC, TIFF or PSD side
// (THUMBNAIL_FORMATS) is capped like a tier 1 image, and the caller turns its bytes into a PNG:
// thumbnailSide makes that an 'image' (source 'os-thumbnail', keyed 'os:<the original's key>', plus
// `thumbnail: {by, from, width, height}`). When the thumbnailer fails it stays 'unsupported'.
//
// A side is read in full only up to the soft cap (the hard cap with force). Over it a worktree
// side reads its first POLICY.sniffBytes (format and dimensions for the 'too-large' message); a
// git side isn't read at all, so its format is unknown: 'too-large' when the extension is an
// image's, else 'not-image'. The pixel cap doesn't apply to SVG: its size attributes don't
// decide what Chromium rasterizes (the SVG byte cap does).
const F = require('./image-format');

// The tier 2 formats an OS thumbnailer is asked to show (I4): .svgz and JPEG XL stay unsupported.
const THUMBNAIL_FORMATS = new Set(['heic', 'tiff', 'psd']);

/** Test-only hooks. policy: replaces POLICY (small caps). */
const testHooks = { policy: null };

/** The PreviewPolicy in force (POLICY unless a test replaced it). */
const policy = () => testHooks.policy || F.POLICY;

/**
 * RevisionKey of a resolved side: the blob's oid, 'wt:<statKey>' for a worktree file, 'lfs:<sha256>'
 * for a Git LFS object, null when absent or not in the local object store (missing).
 */
function revisionKey(rev) {
  if (rev.absent || rev.missing) return null;
  if (rev.source === 'worktree') return `wt:${rev.statKey}`;
  return rev.source === 'lfs-cache' ? `lfs:${rev.oid}` : rev.oid;
}

/** The RevisionKey of the OS thumbnail of the side whose key is `key`: 'os:<key>' (null for none). */
const thumbnailKey = (key) => (key ? `os:${key}` : null);

/**
 * The ImageSide of a side `s` ('unsupported', its whole bytes read) shown through the OS thumbnailer
 * (src/os-thumbnail.js): `thumb` {png, width, height} (the PNG's own size). Kind 'image', source
 * 'os-thumbnail', the PNG's bytes and mime; `format`, `size`, `dims` and `mismatch` stay the
 * original's, and `thumbnail` says what it is: {by (the thumbnailer's: 'macOS'), from (the original's
 * source), width, height}.
 */
function thumbnailSide(s, thumb, by) {
  return {
    ...s, kind: 'image', source: 'os-thumbnail', key: thumbnailKey(s.key), mime: 'image/png', animated: false,
    thumbnail: { by, from: s.source, width: thumb.width, height: thumb.height }, bytes: thumb.png,
  };
}

/** How many bytes of `rev` to read (0: none). See the header for the caps. */
function readLimit(rev, { policy: p = F.POLICY, force = false } = {}) {
  if (rev.absent || rev.special || rev.missing) return 0;
  if (rev.size <= (force ? p.maxBytes : p.softMaxBytes)) return rev.size;
  return rev.source === 'worktree' ? Math.min(p.sniffBytes, rev.size) : 0;
}

/** {soft, max} when `size` is over a byte cap (the soft one only without force), else null. */
function overSize(size, p, force) {
  if (size > p.maxBytes) return { soft: false, max: p.maxBytes };
  if (!force && size > p.softMaxBytes) return { soft: true, max: p.softMaxBytes };
  return null;
}

/**
 * The ImageSide of `rev` given the bytes read for it (readLimit's count: all of it, its head, or
 * none = null). `path`: the file's path, for the extension hint only. `force`: the soft cap is lifted.
 * `thumbnails`: an OS thumbnailer can show THUMBNAIL_FORMATS, so the byte caps apply to them as to
 * tier 1 ('too-large', Load preview), and under them they are 'unsupported' with all their bytes
 * read, for the caller to hand over (thumbnailSide).
 */
function imageSide(rev, bytes, { policy: p = F.POLICY, path, force = false, thumbnails = false } = {}) {
  const base = {
    side: rev.side, kind: null, source: rev.source, key: revisionKey(rev), size: rev.absent ? null : rev.size,
    format: null, extensionHint: F.formatOfPath(path), mime: null, mismatch: false, dims: null, animated: null,
  };
  if (rev.absent) return { ...base, kind: 'absent' };
  if (rev.special) return { ...base, kind: 'special' };
  if (rev.missing) return { ...base, kind: 'not-local' };
  if (!bytes && rev.size === 0) bytes = new Uint8Array(0); // an empty file: nothing to read
  if (!bytes) {
    const over = overSize(rev.size, p, force);
    if (!over) throw new TypeError('imageSide: no bytes for a side under the caps');
    return base.extensionHint ? { ...base, kind: 'too-large', limit: 'size', ...over } : { ...base, kind: 'not-image' };
  }
  const whole = bytes.length === rev.size;
  if (whole && rev.size <= p.lfsPointerMax) {
    const lfs = F.parseLfsPointer(bytes);
    if (lfs) return { ...base, kind: 'lfs-pointer', lfs };
  }
  const m = F.sniff(bytes, { path });
  const side = {
    ...base, format: m.format, mismatch: m.mismatch, animated: m.animated, dims: m.format ? F.dimensions(bytes, m.format) : null,
  };
  if (!m.format) return { ...side, kind: 'not-image' };
  const f = F.FORMATS[m.format];
  const viaOs = thumbnails && THUMBNAIL_FORMATS.has(f.id);
  if (f.tier !== 1 && !viaOs) return { ...side, kind: 'unsupported' };
  const over = overSize(rev.size, p, force);
  if (over) return { ...side, kind: 'too-large', limit: 'size', ...over };
  if (!whole) throw new TypeError('imageSide: part of a side under the caps');
  if (viaOs) return { ...side, kind: 'unsupported' }; // no pixel cap: the OS scales it down
  if (f.id === 'svg' && rev.size > p.svgMaxBytes) return { ...side, kind: 'too-large', limit: 'svg', soft: false, max: p.svgMaxBytes };
  if (f.id !== 'svg' && side.dims && side.dims.width * side.dims.height > p.maxPixels) {
    return { ...side, kind: 'too-large', limit: 'pixels', soft: false, max: p.maxPixels };
  }
  return { ...side, kind: 'image', mime: f.mime, bytes };
}

module.exports = { imageSide, thumbnailSide, thumbnailKey, readLimit, revisionKey, policy, THUMBNAIL_FORMATS, testHooks };
