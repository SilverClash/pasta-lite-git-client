'use strict';
// Pure presenter of the diff view's image preview (plain script; exposes window.PLImage, and
// module.exports under node for the tests). No DOM. docs/plans/image-preview.md §6.
//
// It decides when a diff gets a preview (wantsPreview), what each pane shows for an ImageSide
// (src/image-preview.js header; the store keeps it without its bytes), the labels, sizes and the
// before / after delta, and the Fit / 100% scale. Format labels come from the shared catalogue,
// src/image-format.js (window.PLImageFormat), which index.html loads before this file.
//
// state.imagePreview (renderer/store.js): {spec, old: Slot, new: Slot}, Slot = {loading, side
// (ImageSide without bytes) | null, url | null, error | null}. `decoded` below is what the view
// measured once an <img> loaded ({width, height}: naturalWidth / naturalHeight, so EXIF rotation is
// applied), and `failed` whether its decode failed.
(function () {
  const F = () => (typeof window !== 'undefined' ? window.PLImageFormat : null);
  const SPECIAL_MODES = new Set(['120000', '160000']); // symlink, submodule (as diff-model.js)
  const KB = 1024;
  /** Kinds whose pane shows something about the picture (else the side has nothing to show). */
  const VISUAL = new Set(['image', 'too-large', 'lfs-pointer', 'unsupported']);
  const SOURCES = { index: 'Index', worktree: 'Working copy', head: 'HEAD' };

  /** The file views of a diff result (diff-model.js sectionsOf, which loads after the store). */
  function sectionsOf(data) {
    if (!data) return [];
    if (Array.isArray(data.sections)) return data.sections;
    return data.file ? [data.file] : [];
  }

  /**
   * Whether the loaded diff `data` of `spec` gets an image preview: exactly one section, a binary
   * one, no conflict, no symlink / submodule mode on either side. A binary non-image is asked for
   * too (the ops say 'not-image', and the view falls back to the binary message). Text diffs (SVG,
   * Git LFS pointers) keep their rows until the Preview / Text toggle (I3).
   */
  function wantsPreview(spec, data) {
    if (!spec || !data || data.conflict) return false;
    const sections = sectionsOf(data);
    if (sections.length !== 1) return false;
    const f = sections[0];
    if (SPECIAL_MODES.has(String(f.oldMode || '')) || SPECIAL_MODES.has(String(f.newMode || ''))) return false;
    return !!f.isBinary;
  }

  /**
   * Same preview target: the same file on the same side of the same commit (as PLDiff.sameSpec).
   * A spec the store re-made (untracked -> tracked, a staged rename's orig) keeps the loaded sides
   * and reloads them with their keys.
   */
  const sameTarget = (a, b) => !!a && !!b && a.kind === b.kind && a.file === b.file
    && !!a.staged === !!b.staged && (a.sha || null) === (b.sha || null);

  /** '512 B', '1.5 KB', '34.2 MB' (binary units: 1 KB = 1,024 B; one decimal, none when whole). */
  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < KB) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / KB;
    let i = 0;
    while (v >= KB && i < units.length - 1) {
      v /= KB;
      i++;
    }
    return `${v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
  }

  /** The catalogue label of a format id ('webp' -> 'WebP'), or ''. */
  function formatLabel(id) {
    const f = id && F() && F().FORMATS[id];
    return f ? f.label : '';
  }

  const num = (n) => Number(n).toLocaleString('en-US');

  /** '512×512' (thousands separated), or '' for none. */
  const dimsText = (d) => (d && d.width > 0 && d.height > 0 ? `${num(d.width)}×${num(d.height)}` : '');

  /** A side that has no picture because there is no such side: absent, or the empty index side of an intent-to-add file. */
  function isAbsent(side) {
    if (!side) return false;
    if (side.kind === 'absent') return true;
    return side.side === 'old' && side.source === 'index' && side.kind === 'not-image' && side.size === 0;
  }

  /** The dimensions to show: the decoded ones, else the header's. */
  const dimsOf = (side, decoded) => (decoded && decoded.width > 0 ? decoded : (side && side.dims) || null);

  const sign = (n) => (n < 0 ? '−' : '+');

  /**
   * The before / after comparison when both sides exist: {bytes, pct, dims, format} — bytes: the
   * size change; pct: in percent of the old size (null when that is 0); dims / format: {from, to}
   * when they changed, else null. null when a side is missing or its size unknown.
   */
  function delta(oldSide, newSide, { oldDecoded, newDecoded } = {}) {
    if (!oldSide || !newSide || isAbsent(oldSide) || isAbsent(newSide)) return null;
    if (!Number.isFinite(oldSide.size) || !Number.isFinite(newSide.size)) return null;
    const bytes = newSide.size - oldSide.size;
    const a = dimsOf(oldSide, oldDecoded);
    const b = dimsOf(newSide, newDecoded);
    const dimsChanged = !!(a && b) && (a.width !== b.width || a.height !== b.height);
    const formatChanged = !!(oldSide.format && newSide.format) && oldSide.format !== newSide.format;
    return {
      bytes,
      pct: oldSide.size > 0 ? (bytes / oldSide.size) * 100 : null,
      dims: dimsChanged ? { from: a, to: b } : null,
      format: formatChanged ? { from: oldSide.format, to: newSide.format } : null,
    };
  }

  /** The delta as text parts: '+12.4 KB (+8.1%)' | 'Same size', 'Dimensions 512×512 → 1,024×1,024', 'Format PNG → WebP'. */
  function deltaParts(d) {
    if (!d) return [];
    const parts = [];
    if (d.bytes === 0) parts.push({ kind: 'size', text: 'Same size', dir: 0 });
    else {
      const pct = d.pct === null ? '' : ` (${sign(d.bytes)}${Math.abs(d.pct).toFixed(1)}%)`;
      parts.push({ kind: 'size', text: `${sign(d.bytes)}${formatBytes(Math.abs(d.bytes))}${pct}`, dir: Math.sign(d.bytes) });
    }
    if (d.dims) parts.push({ kind: 'dims', text: `Dimensions ${dimsText(d.dims.from)} → ${dimsText(d.dims.to)}` });
    if (d.format) parts.push({ kind: 'format', text: `Format ${formatLabel(d.format.from)} → ${formatLabel(d.format.to)}` });
    return parts;
  }

  /** Fit: the scale that fits `natural` into `box` without ever enlarging it (1 = 100%). */
  function fitScale(natural, box) {
    if (!natural || !(natural.width > 0) || !(natural.height > 0) || !box) return 1;
    const sx = box.width > 0 ? box.width / natural.width : 1;
    const sy = box.height > 0 ? box.height / natural.height : 1;
    return Math.min(1, sx, sy);
  }

  /** The CSS size of an image at `zoom` ('fit' or a scale; 1 = one image pixel per CSS pixel). */
  function scaledSize(zoom, natural, box) {
    if (!natural || !(natural.width > 0) || !(natural.height > 0)) return null;
    const s = zoom === 'fit' ? fitScale(natural, box) : Number(zoom) || 1;
    return { width: Math.max(1, Math.round(natural.width * s)), height: Math.max(1, Math.round(natural.height * s)) };
  }

  /** The words of a too-large side's limit: '82 MB', '82 MB, 12,000×9,000'. */
  function tooLargeDetail(side) {
    return [formatBytes(side.size), dimsText(side.dims)].filter(Boolean).join(', ');
  }

  /**
   * What a pane shows for its slot: {kind: 'loading'} | {kind: 'image'} | {kind: 'message', text,
   * load?: true (a soft cap: the Load preview button)} | {kind: 'error', text}. `failed`: its image
   * didn't decode.
   */
  function paneState(slot, { failed = false } = {}) {
    if (!slot || (slot.loading && !slot.side && !slot.error)) return { kind: 'loading' };
    if (slot.error) return { kind: 'error', text: slot.error };
    const side = slot.side;
    if (!side) return { kind: 'loading' };
    switch (side.kind) {
      case 'image':
        if (failed) return { kind: 'message', text: 'Couldn\'t decode this image' };
        return slot.url ? { kind: 'image' } : { kind: 'loading' };
      case 'too-large':
        if (side.soft) return { kind: 'message', text: `Large image (${formatBytes(side.size)})`, load: true };
        return { kind: 'message', text: `Too large to preview (${tooLargeDetail(side)})` };
      case 'lfs-pointer':
        return { kind: 'message', text: `Stored in Git LFS (${formatBytes(side.lfs && side.lfs.size)}) — not loaded` };
      case 'unsupported':
        return { kind: 'message', text: `${formatLabel(side.format) || 'This format'} — preview not supported` };
      case 'special':
        return { kind: 'message', text: 'Not a regular file — no preview' };
      case 'absent':
        return { kind: 'message', text: side.side === 'old' ? 'Added' : 'Deleted' };
      default: // 'not-image'
        return { kind: 'message', text: side.size === 0 ? 'Empty file' : 'Not an image — no preview' };
    }
  }

  /** Whether a slot has something about a picture to show (an image, or why it isn't shown). */
  const isVisual = (slot, failed = false) => !!slot && (!!slot.error || (!!slot.side && VISUAL.has(slot.side.kind)
    && !(slot.side.kind === 'image' && failed)));

  /** A slot still waiting for its side. */
  const isPending = (slot) => !slot || (!slot.side && !slot.error);

  /**
   * How the preview body is laid out: {fallback: true, note} (nothing to show on either side: the
   * binary message, plus `note` when an image failed to decode) or {fallback: false, panes:
   * [{which: 'old' | 'new', title}]} — 'Before' / 'After', or one pane 'Added' / 'Deleted' when
   * the other side doesn't exist. `failed`: {old, new} decode failures.
   */
  function layout(preview, failed = {}) {
    const old = preview && preview.old;
    const neu = preview && preview.new;
    if (!isPending(old) && !isPending(neu) && !isVisual(old, failed.old) && !isVisual(neu, failed.new)) {
      const bad = [old, neu].find((s, i) => s.side && s.side.kind === 'image' && failed[i ? 'new' : 'old']);
      return { fallback: true, note: bad ? `Couldn't decode this ${formatLabel(bad.side.format) || 'image'}` : null };
    }
    if (old && old.side && isAbsent(old.side)) return { fallback: false, panes: [{ which: 'new', title: 'Added' }] };
    if (neu && neu.side && isAbsent(neu.side)) return { fallback: false, panes: [{ which: 'old', title: 'Deleted' }] };
    return { fallback: false, panes: [{ which: 'old', title: 'Before' }, { which: 'new', title: 'After' }] };
  }

  /**
   * The metadata line of a pane: ['WebP · animated', '512×512', '148.2 KB', 'Working copy'] (the
   * source only for working-copy diffs), and `note` when the content isn't what the name says
   * ('content is PNG, named .webp'). `path`: the side's file path.
   */
  function meta(side, { decoded = null, workdir = false, path = '' } = {}) {
    if (!side || isAbsent(side)) return { parts: [], note: null };
    const parts = [];
    const label = formatLabel(side.format);
    if (label) parts.push(side.animated ? `${label} · animated` : label);
    const dims = dimsText(dimsOf(side, decoded));
    if (dims) parts.push(dims);
    if (side.dims && side.dims.count > 1) parts.push(`${side.dims.count} sizes`);
    if (Number.isFinite(side.size)) parts.push(formatBytes(side.size));
    if (side.kind === 'lfs-pointer' && side.lfs) parts.push(`LFS ${side.lfs.oid.slice(0, 10)}`);
    if (workdir && SOURCES[side.source]) parts.push(SOURCES[side.source]);
    const ext = F() ? F().extensionOf(path) : null;
    const note = side.mismatch && label && ext ? `content is ${label}, named .${ext}` : null;
    return { parts, note };
  }

  /** The <img> alt text: 'Before: logo.png (WebP, 512×512)'. */
  function altText(title, path, side, decoded) {
    const name = String(path || '').slice(String(path || '').lastIndexOf('/') + 1);
    const what = [formatLabel(side && side.format), dimsText(dimsOf(side, decoded))].filter(Boolean).join(', ');
    return `${title}: ${name}${what ? ` (${what})` : ''}`;
  }

  /**
   * The header badge of a binary diff with a preview: 'image' once a side turned out to be an image
   * format (any tier) or a Git LFS pointer, or — while nothing is known yet — when the file name has
   * an image extension; else 'binary' (Q9: one badge, not both).
   */
  function badge(spec, data, preview) {
    if (!wantsPreview(spec, data)) return 'binary';
    const sides = preview && sameTarget(preview.spec, spec) ? [preview.old, preview.new].map((s) => s && s.side).filter(Boolean) : [];
    const known = sides.filter((s) => !isAbsent(s) && s.kind !== 'special');
    if (known.some((s) => s.format || s.kind === 'lfs-pointer')) return 'image';
    if (known.length && sides.length === 2) return 'binary';
    return F() && (F().formatOfPath(spec.file) || F().formatOfPath(spec.orig)) ? 'image' : 'binary';
  }

  const api = {
    wantsPreview, sameTarget, formatBytes, formatLabel, dimsText, isAbsent, delta, deltaParts, fitScale, scaledSize,
    paneState, isVisual, layout, meta, altText, badge,
  };
  if (typeof window !== 'undefined') window.PLImage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
