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
// The caller returns {side, key, unchanged: true} instead when the renderer already holds `key`.
//
// A side is read in full only up to the soft cap (the hard cap with force). Over it a worktree
// side reads its first POLICY.sniffBytes (format and dimensions for the 'too-large' message); a
// git side isn't read at all, so its format is unknown: 'too-large' when the extension is an
// image's, else 'not-image'. The pixel cap doesn't apply to SVG: its size attributes don't
// decide what Chromium rasterizes (the SVG byte cap does).
const F = require('./image-format');

/** Test-only hooks. policy: replaces POLICY (small caps). */
const testHooks = { policy: null };

/** The PreviewPolicy in force (POLICY unless a test replaced it). */
const policy = () => testHooks.policy || F.POLICY;

/** RevisionKey of a resolved side: the blob's oid, 'wt:<statKey>' for a worktree file, null when absent. */
function revisionKey(rev) {
  if (rev.absent) return null;
  return rev.source === 'worktree' ? `wt:${rev.statKey}` : rev.oid;
}

/** How many bytes of `rev` to read (0: none). See the header for the caps. */
function readLimit(rev, { policy: p = F.POLICY, force = false } = {}) {
  if (rev.absent || rev.special) return 0;
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
 */
function imageSide(rev, bytes, { policy: p = F.POLICY, path, force = false } = {}) {
  const base = {
    side: rev.side, kind: null, source: rev.source, key: revisionKey(rev), size: rev.absent ? null : rev.size,
    format: null, extensionHint: F.formatOfPath(path), mime: null, mismatch: false, dims: null, animated: null,
  };
  if (rev.absent) return { ...base, kind: 'absent' };
  if (rev.special) return { ...base, kind: 'special' };
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
  if (f.tier !== 1) return { ...side, kind: 'unsupported' };
  const over = overSize(rev.size, p, force);
  if (over) return { ...side, kind: 'too-large', limit: 'size', ...over };
  if (!whole) throw new TypeError('imageSide: part of a side under the caps');
  if (f.id === 'svg' && rev.size > p.svgMaxBytes) return { ...side, kind: 'too-large', limit: 'svg', soft: false, max: p.svgMaxBytes };
  if (f.id !== 'svg' && side.dims && side.dims.width * side.dims.height > p.maxPixels) {
    return { ...side, kind: 'too-large', limit: 'pixels', soft: false, max: p.maxPixels };
  }
  return { ...side, kind: 'image', mime: f.mime, bytes };
}

module.exports = { imageSide, readLimit, revisionKey, policy, testHooks };
